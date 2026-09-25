export type TaskOutcome = "done" | "needs_input" | "waiting";

/** Completion is an explicit model attestation, never inferred from an idle agent. */
export class TaskNotification {
  active = false;
  private pending?: TaskOutcome;
  private inputNotified = false;

  start(): void { this.active = true; this.pending = undefined; this.inputNotified = false; }
  cancel(): void { this.active = false; this.pending = undefined; this.inputNotified = false; }
  invalidate(): void { this.pending = undefined; }
  userInput(): void { this.invalidate(); this.inputNotified = false; }

  checkpoint(outcome: TaskOutcome): void {
    if (!this.active) throw new Error("No /notify task is armed. Only the user can arm task notifications.");
    if (!["done", "needs_input", "waiting"].includes(outcome)) throw new Error("Invalid notification outcome.");
    this.pending = outcome;
  }

  needsInput(): boolean {
    if (!this.active || this.inputNotified) return false;
    this.inputNotified = true;
    return true;
  }

  settled(): "task_done" | "task_input" | undefined {
    if (!this.active) return;
    const outcome = this.pending;
    this.pending = undefined;
    if (outcome === "done") { this.cancel(); return "task_done"; }
    if (outcome === "needs_input" && this.needsInput()) return "task_input";
  }
}
