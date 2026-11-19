import { randomUUID } from "node:crypto";
import type { AssistantMessage, AssistantMessageEventStream, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type AgyModel, record } from "./agy-models.ts";
import type { BridgeResult } from "./mcp.ts";

interface PendingCall {
  tool: ToolCall;
  signal: AbortSignal;
  complete(result: BridgeResult): void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface TurnTimeouts {
  idleTimeoutMs?: number;
  turnTimeoutMs?: number;
}

function resolveTimeout(value: number | undefined, fallback: number, message: string): number | undefined {
  const ms = value ?? fallback;
  if (ms === 0 || ms === MAX_TIMER_MS) return undefined;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMER_MS) throw new Error(message);
  return ms;
}

export function toolError(text: string): BridgeResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** One ACP prompt may span several Pi streams: it is parked while Pi executes a bridged tool. */
export class NativeTurn {
  readonly abort = new AbortController();
  readonly updates: Record<string, unknown>[] = [];
  readonly incoming: PendingCall[] = [];
  readonly dispatched = new Map<string, PendingCall>();
  result?: { response: unknown } | { error: unknown };
  #wake?: () => void;
  readonly #idleTimeoutMs?: number;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #turnTimer?: ReturnType<typeof setTimeout>;
  #permissions = 0;

  constructor(options: TurnTimeouts = {}) {
    this.#idleTimeoutMs = resolveTimeout(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, "Invalid Antigravity idle timeout.");
    const turnTimeoutMs = resolveTimeout(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS, "Invalid Antigravity turn deadline.");
    if (turnTimeoutMs !== undefined) {
      this.#turnTimer = setTimeout(() => {
        this.#fail(Object.assign(new Error("ACP turn exceeded deadline."), { code: "ACP_DEADLINE" }));
      }, turnTimeoutMs);
      this.#turnTimer.unref?.();
    }
    this.#refreshIdle();
  }

  notify() { this.#wake?.(); }

  wait() {
    return new Promise<void>(resolve => { this.#wake = () => { this.#wake = undefined; resolve(); }; });
  }

  complete(response: unknown) {
    if (this.result || this.abort.signal.aborted) return;
    this.#clearTimers();
    this.result = { response };
    this.notify();
  }

  reject(error: unknown) {
    if (this.result) return;
    this.#clearTimers();
    this.result = { error };
    this.notify();
  }

  beginPermission() {
    if (this.result || this.abort.signal.aborted) return;
    this.#permissions++;
    this.#refreshIdle();
  }

  endPermission() {
    if (this.#permissions > 0) this.#permissions--;
    this.#refreshIdle();
  }

  update(update: Record<string, unknown>) {
    if (this.result || this.abort.signal.aborted) return;
    if (this.updates.length >= 4096) {
      this.#fail(new Error("Antigravity produced too many buffered updates."));
      return;
    }
    this.updates.push(update);
    this.#refreshIdle();
    this.notify();
  }

  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeResult> {
    if (this.result || this.abort.signal.aborted || signal.aborted) return Promise.resolve(toolError("No active Pi turn owns this tool call."));
    if (this.incoming.length + this.dispatched.size >= 16) return Promise.resolve(toolError("Too many pending Pi tools."));
    const tool: ToolCall = { type: "toolCall", name, arguments: args, id: `agy_pi_${randomUUID()}` };
    return new Promise(resolve => {
      let entry!: PendingCall;
      const onAbort = () => {
        const index = this.incoming.indexOf(entry);
        if (index >= 0) this.incoming.splice(index, 1);
        this.#refreshIdle();
        complete(toolError("Antigravity stopped waiting for this Pi tool."));
      };
      const complete = (result: BridgeResult) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      entry = { tool, signal, complete };
      signal.addEventListener("abort", onAbort, { once: true });
      this.incoming.push(entry);
      this.#refreshIdle();
      this.notify();
    });
  }

  takeCalls() {
    const calls = this.incoming.splice(0).filter(call => !call.signal.aborted);
    for (const call of calls) this.dispatched.set(call.tool.id, call);
    this.#refreshIdle();
    return calls.map(call => call.tool);
  }

  dropDispatched(id: string, result: BridgeResult) {
    this.dispatched.get(id)?.complete(result);
    this.dispatched.delete(id);
    this.#refreshIdle();
  }

  deliver(results: readonly ToolResultMessage[], currentTools: ReadonlySet<string>) {
    const matches = new Map(results.map(result => [result.toolCallId, result]));
    for (const { tool } of this.dispatched.values()) {
      if (matches.get(tool.id)?.toolName !== tool.name) throw new Error("The pending Antigravity turn no longer matches Pi's tool results; it was cancelled.");
    }
    for (const [id, call] of this.dispatched) {
      const result = matches.get(id)!;
      call.complete(currentTools.has(call.tool.name)
        ? { content: result.content.length ? result.content : [{ type: "text", text: "(No output)" }], isError: result.isError }
        : toolError("The Pi tool is no longer exposed."));
    }
    this.dispatched.clear();
    this.#refreshIdle();
  }

  stop(reason: Error) {
    this.#clearTimers();
    this.abort.abort(reason);
    for (const call of this.incoming.splice(0)) call.complete(toolError("Pi closed the Antigravity turn."));
    for (const call of this.dispatched.values()) call.complete(toolError("Pi closed the Antigravity turn."));
    this.dispatched.clear();
    this.notify();
  }

  #waitingOnHost(): boolean {
    return this.#permissions > 0 || this.incoming.length > 0 || this.dispatched.size > 0;
  }

  #clearTimers() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    clearTimeout(this.#turnTimer);
    this.#turnTimer = undefined;
  }

  #refreshIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.result || this.abort.signal.aborted || this.#idleTimeoutMs === undefined || this.#waitingOnHost()) return;
    this.#idleTimer = setTimeout(() => {
      this.#fail(Object.assign(new Error("ACP turn idle."), { code: "ACP_IDLE" }));
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  #fail(error: Error) {
    if (this.result || this.abort.signal.aborted) return;
    this.result = { error };
    this.stop(error);
  }
}

export class PiOutput {
  readonly message: AssistantMessage;
  #open?: number;

  constructor(readonly stream: AssistantMessageEventStream, model: AgyModel) {
    this.message = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(), stopReason: "pending",
    };
  }

  start() { this.stream.push({ type: "start", partial: this.message }); }

  append(kind: "text" | "thinking", delta: string) {
    if (!delta) return;
    const partial = this.message;
    if (this.#open === undefined || partial.content[this.#open]?.type !== kind) {
      this.endBlock();
      this.#open = partial.content.length;
      partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: this.#open, partial });
    }
    const block = partial.content[this.#open];
    if (block.type === "text") block.text += delta;
    if (block.type === "thinking") block.thinking += delta;
    this.stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: this.#open, delta, partial });
  }

  tools(tools: ToolCall[], beforeDone: () => void) {
    this.endBlock();
    const partial = this.message;
    for (const tool of tools) {
      const contentIndex = partial.content.length;
      partial.content.push(tool);
      this.stream.push({ type: "toolcall_start", contentIndex, partial });
      this.stream.push({ type: "toolcall_end", contentIndex, toolCall: tool, partial });
    }
    beforeDone();
    this.done("toolUse");
  }

  usage(response: unknown, thinking: string | undefined) {
    const { message } = this;
    const usage = record(record(response)?.usage);
    const n = (field: string) => {
      const value = usage?.[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    };
    message.usage.input = n("inputTokens");
    message.usage.output = n("outputTokens");
    message.usage.cacheRead = n("cachedReadTokens");
    message.usage.cacheWrite = n("cachedWriteTokens");
    message.usage.totalTokens = n("totalTokens") || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
    if (thinking) message.providerThinkingLevel = thinking;
  }

  done(reason: "stop" | "length" | "toolUse") {
    this.endBlock();
    this.message.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.message });
    this.stream.end();
  }

  fail(reason: "error" | "aborted", errorMessage: string) {
    this.endBlock();
    this.message.stopReason = reason;
    this.message.errorMessage = errorMessage;
    this.stream.push({ type: "error", reason, error: this.message });
    this.stream.end();
  }

  private endBlock() {
    if (this.#open === undefined) return;
    const contentIndex = this.#open;
    this.#open = undefined;
    const partial = this.message;
    const block = partial.content[contentIndex];
    if (block.type === "text") this.stream.push({ type: "text_end", content: block.text, contentIndex, partial });
    if (block.type === "thinking") this.stream.push({ type: "thinking_end", content: block.thinking, contentIndex, partial });
  }
}
