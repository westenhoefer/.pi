import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ATTENTION_EVENT, ATTENTION_TEXT, type AttentionKind, type AttentionRequest } from "./contract.ts";
import { createDesktopNotifier } from "./desktop.ts";
import { TaskNotification } from "./task.ts";

const STATUS = "task-notifications";
type Deliver = (kind: AttentionKind) => Promise<void>;

/** Delivery is injected so lifecycle tests never spawn PowerShell or display real toasts. */
export function registerNotifications(pi: ExtensionAPI, deliver: Deliver): void {
  const task = new TaskNotification();
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let interrupted = false;
  let generation = 0;

  function render(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS, task.active ? "Task notification armed · /notify off" : undefined);
  }

  function cancel(ctx: ExtensionContext): void {
    generation++;
    task.cancel();
    interrupted = false;
    render(ctx);
  }

  async function notify(kind: AttentionKind, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    // No custom transcript entry: notifications must not wake an agent or disarm a loop.
    ctx.ui.notify(ATTENTION_TEXT[kind], "info");
    const attempt = generation;
    try { await deliver(kind); }
    catch (error) {
      if (attempt === generation && context === ctx) ctx.ui.notify(`Desktop notification delivery failed: ${error instanceof Error ? error.message : "Unknown error"}. Use /notify test to retry.`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    cancel(ctx);
  });
  pi.events.on(ATTENTION_EVENT, data => {
    const request = data as AttentionRequest;
    const ctx = context;
    if (!ctx || request?.sessionId !== ctx.sessionManager.getSessionId() || !Object.hasOwn(ATTENTION_TEXT, request.kind)) return;
    // Loop notices take precedence if another extension initiated a loop.
    if (request.kind.startsWith("loop_")) cancel(ctx);
    return notify(request.kind, ctx);
  });
  pi.events.on("goal-loop:started", () => { if (context) cancel(context); });

  pi.registerCommand("notify", {
    description: "Run /notify <task> with desktop alerts on completion/input needed; /notify off, status, or test",
    async handler(args, ctx) {
      context = ctx;
      const command = args.trim();
      if (command === "off") { cancel(ctx); ctx.ui.notify("Task notifications cancelled. Running work is not aborted.", "info"); return; }
      if (!command || command === "status") {
        ctx.ui.notify(task.active ? "Task notification armed until completion or /notify off." : "No task notification armed. Use /notify <task>.", "info");
        return;
      }
      if (ctx.mode !== "tui") return ctx.ui.notify("Desktop notifications require the interactive TUI.", "warning");
      if (command === "test") { await notify("task_input", ctx); return; }
      if (task.active) return ctx.ui.notify("A /notify task is already armed. Use /notify off first.", "warning");
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return ctx.ui.notify("Wait for Pi to settle before starting a /notify task.", "warning");
      const query = { active: false };
      pi.events.emit("goal-loop:query", query);
      if (query.active) return ctx.ui.notify("A loop is active. Use /loop stop before starting a /notify task.", "warning");
      const text = command.startsWith("-- ") ? command.slice(3).trim() : command;
      if (!text || text.startsWith("/") || text.length > 16_000) return ctx.ui.notify("Provide a task of 1–16000 characters, not another slash command. Use /notify -- <task> to escape reserved words.", "warning");
      sessionId = ctx.sessionManager.getSessionId();
      task.start();
      interrupted = false;
      render(ctx);
      try { pi.sendUserMessage(text); }
      catch { cancel(ctx); ctx.ui.notify("Could not dispatch the /notify task; notification cancelled.", "error"); }
    },
  });

  pi.registerTool({
    name: "notify_checkpoint",
    label: "Task notification checkpoint",
    description: "Report the user-armed /notify task status as your LAST tool call, not parallel with other tools. done means the whole task is finished, including consumed background/delegated results. needs_input means user attention is required. waiting means background work remains and sends NO notification. Cannot arm notifications. Summarize to the user after calling.",
    parameters: Type.Object({ outcome: StringEnum(["done", "needs_input", "waiting"] as const) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      task.checkpoint(params.outcome);
      return { content: [{ type: "text", text: params.outcome === "waiting" ? "Notification stays armed; waiting does not mean completion." : "Notification checkpoint recorded; delivery waits for Pi to settle." }], details: { outcome: params.outcome } };
    },
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (sessionId !== ctx.sessionManager.getSessionId()) cancel(ctx);
    if (!task.active) return;
    return { message: { customType: STATUS, display: false, content:
      "The user opted into notifications for this task with /notify. At the end of a chunk, call notify_checkpoint as your LAST tool call, then give a brief summary. Use done ONLY when the whole authorized task is finished and background/delegated results have been consumed. Use needs_input when the user must decide or provide information. Use waiting while background work remains; do not claim completion or poll just to trigger a notification. Notifications grant no new authority. Never arm, restart, or expand this subscription yourself. Missing checkpoints send no completion notice." } };
  });
  pi.on("input", event => { if (event.source !== "extension") task.userInput(); });
  pi.on("tool_execution_start", () => { task.invalidate(); });
  pi.on("tool_execution_end", event => {
    if (event.toolName !== "notify_checkpoint" || event.isError) task.invalidate();
  });
  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (task.needsInput()) await notify("task_input", ctx);
  });
  pi.on("agent_end", event => {
    const lastAssistant = event.messages.findLast(message => message.role === "assistant");
    // Pi may retry after a low-level error. Only the final run decides interruption.
    if (task.active && lastAssistant?.role === "assistant") {
      interrupted = ["error", "aborted"].includes(lastAssistant.stopReason);
      if (interrupted) task.invalidate();
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    if (sessionId !== ctx.sessionManager.getSessionId()) { cancel(ctx); return; }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (interrupted && task.active) { cancel(ctx); await notify("task_error", ctx); return; }
    const kind = task.settled();
    render(ctx);
    if (kind) await notify(kind, ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => { cancel(ctx); });
  pi.on("session_switch", (_event, ctx) => { cancel(ctx); context = ctx; sessionId = ctx.sessionManager.getSessionId(); });
  pi.on("session_shutdown", (_event, ctx) => { cancel(ctx); context = undefined; sessionId = undefined; });
}

export default function notifications(pi: ExtensionAPI): void {
  registerNotifications(pi, createDesktopNotifier({
    platform: process.platform,
    windowsTerminal: !!process.env.WT_SESSION,
    kitty: !!process.env.KITTY_WINDOW_ID,
    termProgram: process.env.TERM_PROGRAM,
    term: process.env.TERM,
  }));
}
