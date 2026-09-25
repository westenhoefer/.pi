import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ChildIdentity } from "./contract.ts";
import type { ChildTransport, Connect, Launch, RpcRecord } from "./rpc.ts";

export type ChildState = "starting" | "running" | "stopping" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
export interface ChildSnapshot extends ChildIdentity {
  agent: string; task: string; state: ChildState; activity: string; output: string;
  error?: string; startedAt: number; endedAt?: number;
}
export interface StartInput { agent: string; task: string; launch: Launch; loopId?: string; timeoutSeconds?: number }
interface Child {
  snapshot: ChildSnapshot; transport?: ChildTransport; timer?: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>; lastStopReason?: string; lastError?: string;
}
export interface SupervisorOptions {
  sessionId: string; connect: Connect;
  onStarted: (child: ChildSnapshot) => void;
  onChange: (children: ChildSnapshot[]) => void;
  onComplete: (child: ChildSnapshot) => void;
}
export function clean(text: string, limit = 16_000): string {
  const value = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return value.length > limit ? value.slice(0, limit) + "\n[Truncated; no full transcript retained.]" : value;
}
export function active(child: ChildSnapshot): boolean { return ["starting", "running", "stopping"].includes(child.state); }

/** Owns admission, child state and completion. It does not schedule parent turns or own loop policy. */
export class Supervisor {
  private children = new Map<string, Child>();
  private closed = false;
  private options: SupervisorOptions;
  constructor(options: SupervisorOptions) { this.options = options; }

  list(): ChildSnapshot[] { return [...this.children.values()].map(child => ({ ...child.snapshot })); }
  status(id: string): ChildSnapshot { return { ...this.get(id).snapshot }; }

  start(input: StartInput): ChildSnapshot {
    if (this.closed) throw new Error("Subagent session is shutting down.");
    if (this.list().some(child => child.state === "stopping" && child.error)) throw new Error("Resolve unconfirmed child termination before launching more work.");
    if (this.list().filter(active).length >= 2) throw new Error("Two children are already active. Wait for completion or stop one.");
    if (this.children.size >= 20) throw new Error("Twenty-child session limit reached. Start a new parent session for more work.");
    if (!input.task.trim() || input.task.length > 16_000) throw new Error("Task must contain 1–16000 characters.");
    const timeout = input.timeoutSeconds ?? 900;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error("Timeout must be 1–3600 seconds.");
    const child: Child = { snapshot: {
      id: randomUUID(), sessionId: this.options.sessionId, loopId: input.loopId,
      agent: input.agent, task: input.task, state: "starting", activity: "starting", output: "", startedAt: Date.now(),
    } };
    this.children.set(child.snapshot.id, child);
    try { this.options.onStarted({ ...child.snapshot }); }
    catch (error) { this.children.delete(child.snapshot.id); throw error; }
    this.publish();
    child.timer = setTimeout(() => { void this.finish(child, "timed_out", "Child deadline exhausted."); }, timeout * 1000);
    // Run after returning the ID, so completion cannot precede launch registration.
    queueMicrotask(() => { void this.run(child, input.launch); });
    return { ...child.snapshot };
  }

  async steer(id: string, message: string): Promise<string> {
    const child = this.get(id);
    if (!message.trim() || message.length > 8000) throw new Error("Steering message must contain 1–8000 characters.");
    if (child.snapshot.state !== "running" || child.finishing || !child.transport) throw new Error("Child is not running; steering cannot restart a settled child.");
    await child.transport.request({ type: "steer", message });
    if (child.finishing || child.snapshot.state !== "running") throw new Error("Child settled while steering was in flight; delivery is not confirmed. No child was restarted.");
    return "Steering accepted into the child's queue. It is delivered at a tool-turn boundary, not an immediate tool interruption.";
  }

  async stop(id: string): Promise<ChildSnapshot> {
    const child = this.get(id);
    if (active(child.snapshot)) await this.finish(child, "cancelled", "Stopped explicitly by the parent.");
    return { ...child.snapshot };
  }

  async shutdown(): Promise<ChildSnapshot[]> {
    this.closed = true;
    await Promise.all([...this.children.values()].filter(child => active(child.snapshot)).map(child => this.finish(child, "cancelled", "Parent session ended.")));
    return this.list().filter(active);
  }

  private get(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error("Unknown child ID. Use subagent_status for this session's exact IDs.");
    return child;
  }

  private async run(child: Child, launch: Launch): Promise<void> {
    if (this.closed || child.finishing) return;
    try {
      child.transport = this.options.connect(launch, event => this.event(child, event), error => { void this.finish(child, "failed", error.message); });
      await child.transport.request({ type: "get_state" });
      if (child.finishing) return;
      child.snapshot.state = "running";
      child.snapshot.activity = "working";
      this.publish();
      await child.transport.request({ type: "prompt", message: `Delegated task (fresh context):\n${child.snapshot.task}\n\nDo only this authorized task. You are a leaf agent: do not spawn agents or detach work. Do not grant yourself approvals. Return concrete results, checks actually run, and blockers.` });
    } catch (error) { await this.finish(child, "failed", error instanceof Error ? error.message : String(error)); }
  }

  private event(child: Child, event: RpcRecord): void {
    if (child.finishing || this.closed) return;
    if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method)) {
      void this.finish(child, "blocked", `Child requested human input (${event.method}): ${clean(String(event.title ?? "Approval required"), 500)}. Resolve explicitly and launch a new task.`);
    } else if (event.type === "extension_error") {
      void this.finish(child, "failed", `Child extension failed: ${String(event.error ?? "unknown error")}`);
    } else if (event.type === "tool_execution_start") {
      child.snapshot.activity = `tool: ${String(event.toolName).slice(0, 80)}`;
      this.publish();
    } else if (event.type === "tool_execution_end" || event.type === "auto_retry_end" || event.type === "compaction_end") {
      child.snapshot.activity = "working";
      this.publish();
    } else if (event.type === "auto_retry_start" || event.type === "compaction_start") {
      child.snapshot.activity = event.type === "auto_retry_start" ? "retrying provider" : "compacting";
      this.publish();
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      child.snapshot.output = clean((event.message.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n"));
      child.lastStopReason = event.message.stopReason;
      child.lastError = event.message.errorMessage;
    } else if (event.type === "agent_settled") {
      const success = child.lastStopReason === "end" || child.lastStopReason === "stop";
      void this.finish(child, success ? "succeeded" : "failed", success ? undefined : child.lastError ?? `Child settled without a successful final answer (${child.lastStopReason ?? "no assistant response"}).`);
    }
  }

  private finish(child: Child, state: ChildState, error?: string): Promise<void> {
    if (child.finishing) return child.finishing;
    // Set the guard before transport.close(), whose exit callbacks may run synchronously.
    child.finishing = Promise.resolve().then(async () => {
      try {
        await child.transport?.close();
        child.snapshot.state = state;
        child.snapshot.endedAt = Date.now();
        child.snapshot.activity = state;
      } catch (closeError) {
        child.snapshot.state = "stopping";
        error = `${error ?? ""} Termination unconfirmed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
      }
      child.snapshot.error = error ? clean(error, 2000) : undefined;
      this.publish();
      if (!this.closed) {
        try { this.options.onComplete({ ...child.snapshot }); }
        catch (error) { console.error("Subagent result delivery failed:", error); }
      }
    });
    child.snapshot.state = "stopping";
    child.snapshot.activity = "stopping";
    if (child.timer) clearTimeout(child.timer);
    this.publish();
    return child.finishing;
  }

  private publish(): void {
    try { this.options.onChange(this.list()); }
    catch (error) { console.error("Subagent status rendering failed:", error); }
  }
}
