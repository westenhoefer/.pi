export const LIMITS = { rounds: 5, durationMs: 30 * 60_000, delayMs: 60_000 } as const;
export type Outcome = "continue" | "done" | "blocked" | "waiting" | "no_progress";
export interface Checkpoint { outcome: Outcome; progress: string; next: string }
export interface LoopState {
  goal: string;
  phase: "working" | "countdown" | "stopped";
  round: number;
  deadline: number;
  delayMs: number;
  due?: number;
  checkpoint?: Checkpoint;
  previousProgress?: string;
  nextStep?: string;
  failures: number;
  reason?: string;
}

export function parseLoopStart(args: string): { goal: string; delayMs: number } {
  let goal = args.trim();
  let delayMs: number = LIMITS.delayMs;
  if (goal.startsWith("--delay")) {
    const match = goal.match(/^--delay\s+([0-9]+)\s+([\s\S]+)$/);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 600) throw new Error("Usage: /loop [--delay <1–600 seconds>] <goal>");
    delayMs = Number(match[1]) * 1000;
    goal = match[2].trim();
  }
  if (goal.startsWith("-- ")) goal = goal.slice(3).trim();
  else if (goal.startsWith("--")) throw new Error("Unknown loop option. Use --delay <seconds>, or -- before the goal.");
  if (!goal || goal.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
  return { goal, delayMs };
}

/** Session-local policy. The adapter owns the clock, UI, timers, and agent calls. */
export class GoalLoop {
  state?: LoopState;

  start(goal: string, now: number, delayMs: number = LIMITS.delayMs): void {
    if (this.state && this.state.phase !== "stopped") throw new Error("A loop is already active; stop it first.");
    if (!goal.trim() || goal.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
    if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 600_000) throw new Error("Delay must be 1–600 seconds.");
    this.state = { goal: goal.trim(), phase: "working", round: 1, deadline: now + LIMITS.durationMs, delayMs, failures: 0 };
  }

  stop(reason: string): void {
    if (!this.state || this.state.phase === "stopped") return;
    this.state.phase = "stopped";
    this.state.reason = reason;
    this.state.due = undefined;
  }

  checkpoint(checkpoint: Checkpoint): void {
    const state = this.state;
    if (!state || state.phase !== "working") throw new Error("No working loop round. Only the user can start /loop.");
    if (!["continue", "done", "blocked", "waiting", "no_progress"].includes(checkpoint.outcome)) throw new Error("Invalid checkpoint outcome.");
    if (!checkpoint.progress.trim() || checkpoint.progress.length > 2000 || checkpoint.next.length > 2000) throw new Error("Checkpoint requires a concise progress summary (up to 2000 characters per field).");
    if (checkpoint.outcome === "continue" && !checkpoint.next.trim()) throw new Error("Continuation requires a concrete next step.");
    state.checkpoint = { ...checkpoint, progress: checkpoint.progress.trim(), next: checkpoint.next.trim() };
    if (checkpoint.outcome !== "continue") this.stop(`${checkpoint.outcome}: ${checkpoint.progress.trim()}`);
  }

  steer(): void {
    const state = this.state;
    if (!state || state.phase === "stopped") return;
    state.phase = "working";
    state.due = undefined;
    state.checkpoint = undefined;
    state.nextStep = undefined;
  }

  deferCountdown(now: number): void {
    if (this.state?.phase === "countdown") this.state.due = now + this.state.delayMs;
  }

  toolStarted(): void {
    if (this.state?.phase === "working") this.state.checkpoint = undefined;
  }

  toolEnded(isError: boolean): void {
    if (this.state?.phase !== "working") return;
    // A sibling tool may finish after the checkpoint in parallel execution.
    this.state.checkpoint = undefined;
    this.state.failures = isError ? this.state.failures + 1 : 0;
    if (this.state.failures >= 2) this.stop("Two consecutive tool failures; manual recovery required.");
  }

  settled(now: number): void {
    const state = this.state;
    if (!state || state.phase !== "working") return;
    if (this.expired(now)) return;
    const checkpoint = state.checkpoint;
    if (!checkpoint) return this.stop("No final checkpoint; not guessing whether more work is authorized.");
    const progress = checkpoint.progress.toLowerCase().replace(/\s+/g, " ");
    if (progress === state.previousProgress) return this.stop("Repeated progress summary; no new progress confirmed.");
    state.previousProgress = progress;
    state.nextStep = checkpoint.next;
    if (state.round >= LIMITS.rounds) return this.stop("Five-round limit reached.");
    state.phase = "countdown";
    state.due = now + state.delayMs;
  }

  expired(now: number): boolean {
    if (this.state && this.state.phase !== "stopped" && now >= this.state.deadline) this.stop("30-minute continuation budget exhausted (current work is not aborted).");
    return this.state?.phase === "stopped";
  }

  advance(now: number): boolean {
    const state = this.state;
    if (!state || this.expired(now) || state.phase !== "countdown" || now < state.due!) return false;
    state.phase = "working";
    state.round++;
    state.due = undefined;
    state.checkpoint = undefined;
    return true;
  }
}

export function continuationPrompt(state: LoopState): string {
  return [
    `User-enabled goal loop: round ${state.round}/${LIMITS.rounds}.`,
    `Goal: ${state.goal}`,
    ...(state.nextStep ? [`Previous checkpoint's next step (revalidate before acting): ${state.nextStep}`] : []),
    "Work on one bounded chunk of this goal using the existing conversation and verification evidence. Follow the user's latest steering; do not blindly repeat an outdated next step.",
    "This continuation grants no new permissions: preserve scope and approval rules; never bypass a blocked tool or switch execution protocols to continue.",
    "At the end of the chunk, call loop_checkpoint as your LAST tool call, then give a brief user-facing summary.",
    "Report outcome=continue only with concrete NEW progress, verification results (or honestly not run), and a specific authorized next step.",
    "Report done when the goal is met; blocked when approval/information is needed; waiting for background work; no_progress if stuck. Do not manufacture more work.",
    "Do not poll or sleep to sustain this loop. Background launches suspend automatic continuation; follow their native notification protocol.",
    `If you stop without a final checkpoint, the loop stops safely. The extension waits ${state.delayMs / 1000} seconds AFTER Pi fully settles before the next round.`,
    "Normal user messages steer this loop without resetting its budget. Only /loop stop or a terminal checkpoint stops it intentionally.",
  ].join("\n");
}
