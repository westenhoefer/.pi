import { getCurrentTools, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AcpClient, type Launch } from "./acp.ts";
import { type AgyModel, cleanLabel, discoverModels, effortFor, readSelector, record } from "./agy-models.ts";
import { type ConversationMessage, makePrompt, projectGuidance, stamp, toolResultsSince } from "./context.ts";
import { startBridge, type BridgeTool } from "./mcp.ts";
import { NativeTurn, PiOutput, toolError, type TurnTimeouts } from "./turn.ts";

const controlTimeoutMs = 45_000;
const cancelled = { outcome: { outcome: "cancelled" } };
const nativeToolNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const init = {
  protocolVersion: 1, clientCapabilities: {},
  clientInfo: { name: "pi-agy-acp", title: "Pi Antigravity ACP", version: "0.1.0" },
};

type Bridge = Awaited<ReturnType<typeof startBridge>>;
type Discovery = { controller: AbortController; client?: AcpClient };
interface Binding {
  client: AcpClient;
  bridge?: Bridge;
  id?: string;
  image: boolean;
  toolsKey: string;
  guidance: string;
  model?: string;
  prefix?: { count: number; hash: string };
  turn?: NativeTurn;
  turnCleanup?: () => void;
  dialog?: AbortController;
  config?: unknown;
  defaultThinking?: string;
  nativeTitle?: string;
}

function rpcSettings(signal: AbortSignal) { return { signal, timeoutMs: controlTimeoutMs }; }

function checkProtocol(response: unknown) {
  if (record(response)?.protocolVersion !== 1) throw new Error("agy did not negotiate ACP v1.");
  return record(record(response)?.agentCapabilities);
}

function userError(cause: unknown, promptStarted = false): string {
  const code = record(cause)?.code;
  if (code === -32000) return "Antigravity requires authentication. Check that your agy launcher supplies credentials in ACP mode.";
  // Pi retries certain text patterns, including timeouts and HTTP-like status codes.
  // An ACP prompt can already have performed native side effects, so don't reissue it automatically.
  if (promptStarted && code === "ACP_IDLE") return "Antigravity produced no activity within the idle window. Check the workspace before resending the prompt.";
  if (promptStarted && code === "ACP_DEADLINE") return "Antigravity exceeded the turn deadline. Check the workspace before resending the prompt.";
  if (promptStarted && typeof code === "number") return `Antigravity could not finish the turn (ACP_${code.toString().replace("-", "N")}). Check the workspace before resending the prompt.`;
  return cause instanceof Error ? cause.message : "Antigravity ACP failed.";
}

export function selectedTools(context: TranscriptContext, allow: ReadonlySet<string>, active: readonly string[]): BridgeTool[] {
  const activeNames = new Set(active);
  return getCurrentTools(context.messages).filter(tool => allow.has(tool.name) && activeNames.has(tool.name) && !nativeToolNames.has(tool.name));
}

export class AgyRuntime {
  #binding?: Binding;
  #closing?: Promise<void>;
  #stream?: AbortController;
  #discovery?: Discovery;
  #blocked = false;
  #windows = new Map<string, number>();
  readonly #timeouts: TurnTimeouts;

  constructor(readonly launch: () => Launch, timeouts: TurnTimeouts = {}) {
    this.#timeouts = timeouts;
  }

  get running() { return !!this.#binding?.client.alive; }

  async discover(cwd: string, signal: AbortSignal): Promise<AgyModel[]> {
    if (this.#blocked) throw new Error("Previous Antigravity process teardown was not confirmed; restart Pi before using this provider again.");
    if (this.#stream || this.#discovery) throw new Error("Antigravity is busy.");
    const state: Discovery = { controller: new AbortController() };
    this.#discovery = state;
    const active = AbortSignal.any([signal, state.controller.signal]);
    try {
      active.throwIfAborted();
      const client = state.client = new AcpClient(this.launch(), { cwd, onUpdate: () => {}, onPermission: async () => cancelled });
      const caps = checkProtocol(await client.request("initialize", init, rpcSettings(active)));
      const session = await client.request("session/new", { cwd, mcpServers: [] }, rpcSettings(active));
      return discoverModels(session, record(caps?.promptCapabilities)?.image === true, this.#windows);
    } catch (error) {
      throw new Error(userError(error));
    } finally {
      try { await state.client?.close(); }
      catch (error) { this.#blocked = true; throw error; }
      finally { this.#discovery = undefined; }
    }
  }

  async run(model: AgyModel, transcript: TranscriptContext, opts: SimpleStreamOptions, ctx: ExtensionContext,
    tools: readonly BridgeTool[], out: PiOutput) {
    if (this.#stream || this.#discovery) { out.fail("error", "Antigravity is busy with another request."); return; }
    const controller = this.#stream = new AbortController();
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    let binding = this.#binding;
    const wake = () => binding?.turn?.notify();
    signal.addEventListener("abort", wake, { once: true });
    try {
      signal.throwIfAborted();
      await this.#closing;
      signal.throwIfAborted();
      if (this.#blocked) throw new Error("Previous Antigravity process teardown was not confirmed; restart Pi before using this provider again.");
      const messages = transcript.messages.filter((m): m is ConversationMessage => m.role !== "system");
      const toolsKey = JSON.stringify(tools);
      const guidance = projectGuidance(transcript.messages);
      const currentTools = new Set(tools.map(tool => tool.name));
      const prefix = binding?.prefix;
      const matches = !!prefix && messages.length >= prefix.count && stamp(messages.slice(0, prefix.count)) === prefix.hash;
      const parked = !!binding?.turn && binding.turn.dispatched.size > 0 && matches && binding.model === model.id;
      if (binding?.turn && !parked) throw new Error("Cannot resume the pending Antigravity tool call on a different Pi conversation.");
      // ACP v1 cannot steer an in-flight prompt. Restart with the tool results as history and
      // the new instruction as user input, rather than continuing the old plan or dropping the steer.
      const steered = parked && messages.slice(prefix!.count).some(message => message.role === "user");
      const resume = parked && !steered;

      if (binding && (steered || (!resume && (!binding.client.alive || !matches || binding.toolsKey !== toolsKey || binding.guidance !== guidance || binding.model !== model.id)))) {
        await this.closeBinding(binding);
        binding = undefined;
      }
      if (!binding) {
        signal.throwIfAborted();
        binding = await this.open(ctx, tools, toolsKey, guidance, signal);
      }
      signal.throwIfAborted();
      let turn: NativeTurn;
      if (resume && binding.turn && prefix) {
        turn = binding.turn;
        if (!turn.result) turn.deliver(toolResultsSince(messages, prefix.count), currentTools);
      } else {
        await this.select(binding, model, opts, signal);
        const prompt = makePrompt(messages, binding.prefix?.count ?? 0, guidance, !!binding.bridge);
        if (!binding.image && prompt.some(block => block.type === "image")) throw new Error("This Antigravity runtime does not support image prompts.");
        const replacement = await opts.onPayload?.({ prompt }, model);
        const payload = replacement === undefined ? prompt : record(replacement)?.prompt;
        if (!Array.isArray(payload) || !payload.length) throw new Error("The Antigravity payload hook must return a nonempty prompt array.");
        signal.throwIfAborted();
        turn = binding.turn = new NativeTurn({
          idleTimeoutMs: opts.timeoutMs ?? this.#timeouts.idleTimeoutMs,
          turnTimeoutMs: this.#timeouts.turnTimeoutMs,
        });
        const owner = binding;
        const onAbort = () => { void this.closeBinding(owner).catch(() => {}); };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        binding.turnCleanup = () => opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) onAbort();
        void binding.client.request("session/prompt", { sessionId: binding.id, prompt: payload }, {
          signal: turn.abort.signal,
        }).then(response => turn.complete(response), error => turn.reject(error));
      }

      out.start();
      for (;;) {
        signal.throwIfAborted();
        for (let update = turn.updates.shift(); update; update = turn.updates.shift()) {
          await opts.onProviderStreamEvent?.(update, model);
          signal.throwIfAborted();
          this.renderUpdate(update, model.id, ctx, out);
        }
        if (turn.result) {
          if ("error" in turn.result) throw turn.result.error;
          const response = turn.result.response;
          const reason = record(response)?.stopReason;
          if (reason === "cancelled") {
            await this.closeBinding(binding);
            out.fail("aborted", "Antigravity cancelled the turn.");
            return;
          }
          if (reason !== "end_turn" && reason !== "max_tokens" && reason !== "max_turn_requests" && reason !== "refusal") {
            throw new Error("Antigravity returned an unknown ACP stop reason.");
          }
          const length = reason === "max_tokens" || reason === "max_turn_requests";
          const hadParkedTools = turn.dispatched.size > 0 || turn.incoming.length > 0;
          out.message.rawStopReason = reason;
          out.message.responseModel = readSelector(binding.config, "model")?.current;
          out.usage(response, readSelector(binding.config, "thought_level")?.current);
          this.finishTurn(binding, turn);
          if (hadParkedTools || length || reason === "refusal") await this.closeBinding(binding);
          else binding.prefix = { count: messages.length + 1, hash: stamp([...messages, out.message]) };
          out.done(length ? "length" : "stop");
          return;
        }
        turn.abort.signal.throwIfAborted();
        const calls = turn.takeCalls().filter(tool => {
          if (currentTools.has(tool.name)) return true;
          turn.dropDispatched(tool.id, toolError("The Pi tool is no longer exposed."));
          return false;
        });
        if (calls.length) {
          // The output's tool-call blocks are included in the hash; stopReason/usage are not.
          out.tools(calls, () => { binding!.prefix = { count: messages.length + 1, hash: stamp([...messages, out.message]) }; });
          return;
        }
        await turn.wait();
      }
    } catch (error) {
      const aborted = signal.aborted;
      const message = aborted ? "Antigravity turn cancelled." : userError(error, binding?.turn !== undefined);
      // A failed initial open can own the runtime binding before it returns to this caller.
      try { await this.closeBinding(this.#binding); }
      catch (teardown) { out.fail("error", `${message} ${userError(teardown)}`); return; }
      out.fail(aborted ? "aborted" : "error", message);
    } finally {
      signal.removeEventListener("abort", wake);
      this.#stream = undefined;
      ctx.ui.setStatus("agy-acp", undefined);
    }
  }

  /** Keep warm sessions across successful Pi turns; cancel an abandoned MCP handoff. */
  async settle() {
    if (this.#binding?.turn) await this.closeBinding(this.#binding);
  }

  async reset() {
    this.#stream?.abort();
    this.#discovery?.controller.abort();
    await Promise.all([this.closeBinding(this.#binding), this.#discovery?.client?.close()]);
  }

  private async open(ctx: ExtensionContext, tools: readonly BridgeTool[], toolsKey: string, guidance: string, signal: AbortSignal) {
    const binding: Binding = {
      client: new AcpClient(this.launch(), {
        cwd: ctx.cwd,
        onUpdate: (params) => this.update(binding, params),
        onPermission: (params) => this.permission(binding, ctx, params),
      }),
      image: false, guidance, toolsKey,
    };
    this.#binding = binding;
    const caps = checkProtocol(await binding.client.request("initialize", init, rpcSettings(signal)));
    binding.image = record(caps?.promptCapabilities)?.image === true;
    if (tools.length) {
      if (record(caps?.mcpCapabilities)?.http !== true) throw new Error("agy did not advertise HTTP MCP; cannot expose the requested Pi tools.");
      const bridge = await startBridge(tools, (name, args, caller) => binding.turn?.call(name, args, caller) ?? Promise.resolve(toolError("No active Antigravity turn.")));
      if (signal.aborted || this.#binding !== binding) {
        await bridge.close();
        throw new Error("Antigravity session was closed during setup.");
      }
      binding.bridge = bridge;
    }
    const session = await binding.client.request("session/new", { cwd: ctx.cwd, mcpServers: binding.bridge ? [binding.bridge.mcpServer] : [] }, rpcSettings(signal));
    const id = record(session)?.sessionId;
    if (typeof id !== "string" || !id) throw new Error("agy returned no ACP session ID.");
    binding.id = id;
    binding.config = session;
    return binding;
  }

  private async select(binding: Binding, model: AgyModel, opts: SimpleStreamOptions, signal: AbortSignal) {
    const apply = async (category: "model" | "thought_level", id: string, value: string) => {
      binding.config = await binding.client.request("session/set_config_option", { sessionId: binding.id, configId: id, value }, rpcSettings(signal));
      if (readSelector(binding.config, category)?.current !== value) throw new Error(`agy did not confirm the requested ${category}.`);
    };
    const models = readSelector(binding.config, "model");
    if (!models) throw new Error("agy did not advertise a model selector. Run /agy-acp refresh and check your launcher.");
    if (models.current !== model.id) {
      if (!models.choices.some(choice => choice.id === model.id)) throw new Error("This model is not available in agy. Run /agy-acp refresh and choose an advertised model.");
      await apply("model", models.id, model.id);
    }
    const levels = readSelector(binding.config, "thought_level");
    if (binding.model !== model.id) binding.defaultThinking = levels?.current;
    const effort = levels && (opts.reasoning && opts.reasoning !== "off"
      ? effortFor(levels, opts.reasoning)
      : levels.choices.find(choice => choice.id === "off")?.id ?? binding.defaultThinking);
    if (levels && effort && levels.current !== effort) await apply("thought_level", levels.id, effort);
    if (readSelector(binding.config, "model")?.current !== model.id) throw new Error("agy changed the selected model unexpectedly.");
    binding.model = model.id;
  }

  private update(binding: Binding, params: unknown) {
    const envelope = record(params);
    const update = record(envelope?.update);
    if (this.#binding !== binding || !binding.id || envelope?.sessionId !== binding.id || !update) return;
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) binding.config = update;
    binding.turn?.update(update);
  }

  private renderUpdate(update: Record<string, unknown>, model: string, ctx: ExtensionContext, out: PiOutput) {
    const content = record(update.content);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (content?.type === "text" && typeof content.text === "string") {
          out.append(update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", content.text);
        }
        break;
      case "tool_call":
      case "tool_call_update": {
        const binding = this.#binding;
        if (!binding) break;
        const title = cleanLabel(update.title);
        if (title) binding.nativeTitle = title;
        const done = update.status === "completed" || update.status === "failed";
        ctx.ui.setStatus("agy-acp", done ? undefined : `agy · ${binding.nativeTitle ?? "working"}`);
        break;
      }
      case "usage_update":
        if (typeof update.size === "number" && Number.isSafeInteger(update.size) && update.size > 0) this.#windows.set(model, update.size);
        break;
    }
  }

  private async permission(binding: Binding, ctx: ExtensionContext, params: unknown) {
    const input = record(params);
    const turn = binding.turn;
    if (this.#binding !== binding || !binding.id || input?.sessionId !== binding.id || !turn || turn.result || turn.abort.signal.aborted || binding.dialog || !ctx.hasUI) return cancelled;
    turn.beginPermission();
    try {
      const options = Array.isArray(input.options) ? input.options.map(record) : [];
      const reject = options.find(option => option?.kind === "reject_once" && typeof option.optionId === "string");
      const allow = options.find(option => option?.kind === "allow_once" && typeof option.optionId === "string");
      const selected = (option: typeof allow) => option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelled;
      if (!allow) return selected(reject);
      const call = record(input.toolCall);
      const title = cleanLabel(call?.title) || "Antigravity requests tool permission";
      const raw = call?.rawInput;
      const detail = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
      if (!detail?.trim() || detail === "{}" || detail === "[]" || detail.length > 1200) {
        ctx.ui.notify(`Denied Antigravity tool “${title}”: no complete action details to review.`, "warning");
        return selected(reject);
      }
      const dialog = binding.dialog = new AbortController();
      try {
        const choice = await ctx.ui.select(`Antigravity tool: ${title}\n${cleanLabel(detail, 1200)}`, ["Deny", "Allow once"], {
          signal: AbortSignal.any([turn.abort.signal, dialog.signal]), timeout: 60_000,
        });
        if (this.#binding !== binding || binding.turn !== turn || turn.result || turn.abort.signal.aborted || dialog.signal.aborted) return cancelled;
        return selected(choice === "Allow once" ? allow : reject);
      } catch {
        return selected(reject);
      } finally {
        if (binding.dialog === dialog) binding.dialog = undefined;
      }
    } finally {
      turn.endPermission();
    }
  }

  private cancelTurn(binding: Binding, turn: NativeTurn, message: string) {
    if (binding.id && !turn.result && binding.client.alive) {
      try { binding.client.notify("session/cancel", { sessionId: binding.id }); } catch { /* the process may already have exited */ }
    }
    turn.stop(new Error(message));
  }

  private finishTurn(binding: Binding, turn: NativeTurn) {
    binding.turnCleanup?.();
    binding.turnCleanup = undefined;
    binding.dialog?.abort();
    turn.stop(new Error("Antigravity turn finished."));
    binding.turn = undefined;
  }

  private async closeBinding(binding: Binding | undefined) {
    if (!binding || this.#binding !== binding) return this.#closing;
    this.#binding = undefined;
    if (binding.turn) {
      this.cancelTurn(binding, binding.turn, "Antigravity session closed.");
      this.finishTurn(binding, binding.turn);
    }
    const closing = this.#closing = Promise.allSettled([binding.client.close(), binding.bridge?.close()]).then(results => {
      if (results.some(result => result.status === "rejected")) {
        this.#blocked = true;
        throw new Error("Antigravity process or bridge teardown was not confirmed; restart Pi before using this provider again.");
      }
    });
    try { await closing; }
    finally { if (this.#closing === closing) this.#closing = undefined; }
  }
}
