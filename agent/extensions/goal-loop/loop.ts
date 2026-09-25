export const LIMITS = { rounds: 5, maxRounds: 20, durationMs: 30 * 60_000, delayMs: 60_000 } as const;
export type Outcome = "continue" | "done" | "blocked" | "waiting" | "no_progress";
export interface Checkpoint { outcome: Outcome; progress: string; next: string }
export interface LoopState {
  goal: string;
  phase: "working" | "waiting_children" | "countdown" | "awaiting_approval" | "stopped";
  manual: boolean;
  round: number;
  maxRounds: number;
  deadline?: number;
  delayMs: number;
  due?: number;
  checkpoint?: Checkpoint;
  previousProgress?: string;
  nextStep?: string;
  failures: number;
  reason?: string;
}

export function parseLoopStart(args: string): { goal: string; delayMs: number; manual: boolean; rounds: number } {
  let goal = args.trim();
  let delayMs: number = LIMITS.delayMs;
  let manual = false;
  let rounds: number = LIMITS.rounds;
  let hasDelay = false;
  let hasRounds = false;
  while (goal.startsWith("--")) {
    if (goal.startsWith("-- ")) { goal = goal.slice(3).trim(); break; }
    if (/^--manual(?:\s|$)/.test(goal) && !manual) {
      manual = true;
      goal = goal.slice(8).trim();
    } else if (goal.startsWith("--delay") && !hasDelay) {
      const match = goal.match(/^--delay\s+([0-9]+)\s+([\s\S]+)$/);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 600) throw new Error("Usage: /loop [--delay <1–600 seconds> | --manual] <goal>");
      delayMs = Number(match[1]) * 1000;
      hasDelay = true;
      goal = match[2].trim();
    } else if (goal.startsWith("--rounds") && !hasRounds) {
      const match = goal.match(/^--rounds\s+([0-9]+)\s+([\s\S]+)$/);
      const requested = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(requested) || requested < 1 || requested > LIMITS.maxRounds) throw new Error(`Usage: /loop --rounds <1–${LIMITS.maxRounds}> <goal>`);
      rounds = requested;
      hasRounds = true;
      goal = match![2].trim();
    } else throw new Error("Unknown or duplicate loop option. Use --manual, --delay <seconds>, --rounds <count>, or -- before the goal.");
  }
  if (manual && hasDelay) throw new Error("--manual and --delay cannot be combined.");
  if (!goal || goal.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
  return { goal, delayMs, manual, rounds };
}

/** Session-local policy. The adapter owns the clock, UI, timers, and agent calls. */
export class GoalLoop {
  state?: LoopState;
  private children = new Set<string>();

  get pendingChildren(): number { return this.children.size; }

  childStarted(id: string): void {
    if (this.state?.phase !== "working") throw new Error("Delegation requires a working loop round.");
    this.children.add(id);
    this.state.checkpoint = undefined;
  }

  childResult(id: string): boolean {
    if (!this.state || this.state.phase === "stopped" || !this.children.delete(id)) return false;
    this.steer();
    return true;
  }

  start(goal: string, now: number, delayMs: number = LIMITS.delayMs, manual = false, maxRounds: number = LIMITS.rounds): void {
    if (this.state && this.state.phase !== "stopped") throw new Error("A loop is already active; stop it first.");
    if (!goal.trim() || goal.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
    if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 600_000) throw new Error("Delay must be 1–600 seconds.");
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > LIMITS.maxRounds) throw new Error(`Rounds must be 1–${LIMITS.maxRounds}.`);
    this.children.clear();
    this.state = { goal: goal.trim(), phase: "working", manual, round: 1, maxRounds,
      deadline: manual ? undefined : now + LIMITS.durationMs, delayMs, failures: 0 };
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
    if (this.children.size && ["continue", "done"].includes(checkpoint.outcome)) throw new Error("Consume all delegated results before continuing/completing this round; use waiting at a dependency barrier.");
    state.checkpoint = { ...checkpoint, progress: checkpoint.progress.trim(), next: checkpoint.next.trim() };
    if (checkpoint.outcome !== "continue" && !(checkpoint.outcome === "waiting" && this.children.size)) this.stop(`${checkpoint.outcome}: ${checkpoint.progress.trim()}`);
  }

  steer(): void {
    const state = this.state;
    if (!state || state.phase === "stopped") return;
    // Feedback is not approval. A paused manual loop stays paused.
    if (state.phase !== "awaiting_approval") state.phase = "working";
    state.due = undefined;
    state.checkpoint = undefined;
    state.nextStep = undefined;
  }

  deferCountdown(now: number): void {
    if (this.state?.phase === "countdown") this.state.due = now + this.state.delayMs;
  }

  toolStarted(): void {
    if (this.state) this.state.checkpoint = undefined;
  }

  toolEnded(isError: boolean): void {
    // A sibling tool may finish after even a terminal checkpoint in parallel execution.
    if (this.state) this.state.checkpoint = undefined;
    if (this.state?.phase !== "working") return;
    this.state.failures = isError ? this.state.failures + 1 : 0;
    if (this.state.failures >= 2) this.stop("Two consecutive tool failures; manual recovery required.");
  }

  settled(now: number): void {
    const state = this.state;
    if (!state || state.phase !== "working") return;
    if (this.expired(now)) return;
    const checkpoint = state.checkpoint;
    if (!checkpoint) return this.stop("No final checkpoint; not guessing whether more work is authorized.");
    if (checkpoint.outcome === "waiting" && this.children.size) {
      state.phase = "waiting_children";
      state.due = undefined;
      return;
    }
    const progress = checkpoint.progress.toLowerCase().replace(/\s+/g, " ");
    if (progress === state.previousProgress) return this.stop("Repeated progress summary; no new progress confirmed.");
    state.previousProgress = progress;
    state.nextStep = checkpoint.next;
    if (state.round >= state.maxRounds) return this.stop(`${state.maxRounds}-round limit reached.`);
    state.phase = state.manual ? "awaiting_approval" : "countdown";
    state.due = state.manual ? undefined : now + state.delayMs;
  }

  expired(now: number): boolean {
    if (this.state && !this.state.manual && this.state.phase !== "stopped" && now >= this.state.deadline!) this.stop("30-minute continuation budget exhausted (current work is not aborted).");
    return this.state?.phase === "stopped";
  }

  resume(now: number): boolean {
    const state = this.state;
    if (!state || this.expired(now) || state.phase !== "awaiting_approval" || state.round >= state.maxRounds) return false;
    state.phase = "working";
    state.round++;
    state.checkpoint = undefined;
    return true;
  }

  advance(now: number): boolean {
    const state = this.state;
    if (!state || this.expired(now) || state.phase !== "countdown" || state.round >= state.maxRounds || now < state.due!) return false;
    state.phase = "working";
    state.round++;
    state.due = undefined;
    state.checkpoint = undefined;
    return true;
  }
}

export function continuationPrompt(state: LoopState): string {
  return [
    `User-enabled goal loop: round ${state.round}/${state.maxRounds}.`,
    `Goal: ${state.goal}`,
    ...(state.nextStep ? [`Previous checkpoint's next step (revalidate before acting): ${state.nextStep}`] : []),
    "Work on one bounded chunk of this goal using the existing conversation and verification evidence. Follow the user's latest steering; do not blindly repeat an outdated next step.",
    "This continuation grants no new permissions: preserve scope and approval rules; never bypass a blocked tool or switch execution protocols to continue.",
    "At the end of the chunk, call loop_checkpoint as your LAST tool call, then give a brief user-facing summary.",
    "Report outcome=continue only with concrete NEW progress, verification results (or honestly not run), and a specific authorized next step.",
    "Report done when the goal is met; blocked when approval/information is needed; waiting for background work; no_progress if stuck. Do not manufacture more work.",
    "Session-owned subagent_start children belong to THIS round. At a dependency barrier use waiting: the loop suspends until native child results arrive. Consume every result before continue/done. Completion wakes do not approve a new round or refresh budgets.",
    "Do not poll or sleep to sustain this loop. Other background launchers stop automatic continuation; follow their native notification protocol.",
    "If you stop without a final checkpoint, the loop stops safely.",
    state.manual
      ? "Manual approval mode: after this chunk, stop. Only the user's /loop resume approves another round; never request, simulate, or invoke approval yourself."
      : `The extension waits ${state.delayMs / 1000} seconds AFTER Pi fully settles before the next round.`,
    "Normal user messages steer this loop without resetting its budget. /loop stop or a terminal checkpoint stops it intentionally.",
  ].join("\n");
}
