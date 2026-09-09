import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stripVTControlCharacters } from "node:util";
import { GoalLoop, continuationPrompt, parseLoopStart } from "./loop.ts";

const TYPE = "goal-loop";
const safe = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240);

export default function goalLoopExtension(pi: ExtensionAPI): void {
  const loop = new GoalLoop();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionId: string | undefined;
  let generation = 0;
  let starting = false;
  let countdownLeaf: string | null | undefined;

  function clearTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function render(ctx: ExtensionContext): void {
    const state = loop.state;
    if (!state || state.phase === "stopped") {
      clearTimer();
      ctx.ui.setStatus(TYPE, undefined);
      return;
    }
    const suffix = state.phase === "countdown"
      ? ctx.ui.getEditorText().trim() ? "typing; countdown paused" : `next in ${Math.max(0, Math.ceil((state.due! - Date.now()) / 1000))}s`
      : "working";
    ctx.ui.setStatus(TYPE, `Loop ${state.round}/5 · ${suffix} · /loop stop`);
  }

  function stop(reason: string, ctx: ExtensionContext): void {
    const active = loop.state && loop.state.phase !== "stopped";
    generation++;
    loop.stop(reason);
    render(ctx);
    if (active) ctx.ui.notify(`Loop stopped: ${safe(reason)}`, "info");
  }

  function sendRound(ctx: ExtensionContext): void {
    if (!loop.state || loop.state.phase !== "working") return;
    // Custom messages make automation explicit rather than impersonating user input.
    try {
      pi.sendMessage({ customType: TYPE, content: continuationPrompt(loop.state), display: true }, { triggerTurn: true });
    } catch (error) {
      stop(`Could not send continuation: ${error instanceof Error ? error.message : String(error)}`, ctx);
    }
  }

  function tick(ctx: ExtensionContext): void {
    if (sessionId !== ctx.sessionManager.getSessionId()) return stop("Session changed.", ctx);
    const state = loop.state;
    if (!state || state.phase === "stopped") return render(ctx);
    if (loop.expired(Date.now())) {
      ctx.ui.notify(`Loop stopped: ${loop.state!.reason}`, "info");
      return render(ctx);
    }
    if (state.phase === "countdown") {
      // Idle custom messages do not emit extension message_start in Pi. A branch
      // watermark catches those and other external transcript changes before dispatch.
      if (countdownLeaf !== ctx.sessionManager.getLeafId()) return stop("Conversation changed during countdown; restart explicitly.", ctx);
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        loop.steer();
        return render(ctx);
      }
      // Keep the loop armed while typing, but restart the quiet-period countdown.
      if (ctx.ui.getEditorText().trim()) loop.deferCountdown(Date.now());
      else if (loop.advance(Date.now())) sendRound(ctx);
    }
    render(ctx);
  }

  pi.registerCommand("loop", {
    description: "Run /loop [--delay <seconds>] <goal> (5 rounds, 30m, default 60s); /loop status or /loop stop",
    async handler(args, ctx) {
      const command = args.trim();
      if (command === "stop") {
        stop("Stopped by user. In-flight work is not aborted; use Escape if needed.", ctx);
        return;
      }
      if (!command || command === "status") {
        const state = loop.state;
        ctx.ui.notify(state ? `Loop ${state.phase}, round ${state.round}/5, delay ${state.delayMs / 1000}s\n${safe(state.goal)}\n${safe(state.reason ?? "User input steers; /loop stop cancels continuation.")}` : "No loop active. Use /loop [--delay <seconds>] <specific goal>.", "info");
        return;
      }
      if (ctx.mode !== "tui") return ctx.ui.notify("Goal loops require the interactive TUI; no headless/RPC auto-continuation.", "warning");
      if (starting || (loop.state && loop.state.phase !== "stopped")) return ctx.ui.notify("A loop is active or awaiting confirmation. Use /loop stop first.", "warning");
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return ctx.ui.notify("Wait for Pi to settle before starting a loop.", "warning");
      let options: ReturnType<typeof parseLoopStart>;
      try { options = parseLoopStart(command); }
      catch (error) { return ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
      const { goal, delayMs } = options;
      starting = true;
      const attempt = ++generation;
      let approved = false;
      try {
        approved = await ctx.ui.confirm("Start bounded goal loop?", `${stripVTControlCharacters(goal).replace(/[\x00-\x1f\x7f]/g, " ")}\n\nStarts now; up to 5 automatic work rounds, ${delayMs / 1000}s between rounds, 30m continuation budget. User input steers without resetting the budget. Model usage can incur costs. Existing permissions remain unchanged. /loop stop cancels future rounds; Escape aborts current work. Reload/session changes discard the loop.`);
      } catch {
        ctx.ui.notify("Loop confirmation failed; nothing started.", "warning");
      } finally { starting = false; }
      if (!approved || attempt !== generation || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      sessionId = ctx.sessionManager.getSessionId();
      loop.start(goal, Date.now(), delayMs);
      timer = setInterval(() => tick(ctx), 1000);
      timer.unref();
      render(ctx);
      sendRound(ctx);
    },
  });

  pi.registerTool({
    name: "loop_checkpoint",
    label: "Loop checkpoint",
    description: "Report the current user-enabled /loop round's outcome. Cannot start, restart, or expand a loop. Call LAST in a chunk, not parallel with other tools. Continue requires new progress and an authorized next step; done/blocked/waiting/no_progress stop automatic continuation. Each text field is limited to 2000 characters.",
    parameters: Type.Object({
      outcome: StringEnum(["continue", "done", "blocked", "waiting", "no_progress"] as const),
      progress: Type.String({ minLength: 1, maxLength: 2000, description: "New progress and verification evidence, or the blocker; never claim unrun checks passed." }),
      next: Type.String({ maxLength: 2000, description: "Concrete next authorized step for continue; otherwise may be empty." }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Checkpoint cancelled.");
      loop.checkpoint(params);
      render(ctx);
      return { content: [{ type: "text", text: `Loop checkpoint: ${params.outcome}. ${params.outcome === "continue" ? "Will evaluate continuation once Pi settles; summarize this chunk now." : "Automatic continuation stopped."}` }], details: { ...params } };
    },
  });

  pi.on("input", (event, ctx) => {
    if (starting) generation++;
    if (event.source === "extension") stop("External automation takes precedence.", ctx);
    else { loop.steer(); render(ctx); }
  });
  pi.on("before_agent_start", () => {
    if (loop.state && loop.state.phase !== "stopped") return {
      message: { customType: TYPE, content: continuationPrompt(loop.state), display: false },
    };
  });
  pi.on("user_bash", (_event, ctx) => { stop("User shell command takes precedence.", ctx); });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!starting) stop("User decision requested; restart explicitly when resolved.", ctx);
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role === "user") { if (starting) generation++; loop.steer(); render(ctx); }
    else if (message.role === "custom" && message.customType !== TYPE) stop("External message takes precedence.", ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    loop.toolStarted();
    if (event.toolName === "job_start" || event.toolName === "subagent") stop("Background/delegated work: use its native completion protocol, then restart explicitly if needed.", ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "loop_checkpoint" || event.isError) loop.toolEnded(event.isError);
    render(ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.messages.some(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason))) stop("Agent error or abort; no automatic retry by the loop.", ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const wasWorking = loop.state?.phase === "working";
    loop.settled(Date.now());
    if (wasWorking && loop.state?.phase === "countdown") countdownLeaf = ctx.sessionManager.getLeafId();
    if (wasWorking && loop.state?.phase === "stopped") ctx.ui.notify(`Loop stopped: ${safe(loop.state.reason ?? "Stopped")}`, "info");
    render(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => { stop("Compaction; restart explicitly after context recovery.", ctx); });
  pi.on("session_before_tree", (_event, ctx) => { stop("Session tree navigation.", ctx); });
  pi.on("session_shutdown", (_event, ctx) => { stop("Session shutdown/reload.", ctx); });
}
