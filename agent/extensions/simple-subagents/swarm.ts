import { randomUUID } from "node:crypto";
import type { RunClaim, StartQuery, SwarmDelivery } from "./contract.ts";
import type { Profile } from "./launch.ts";
import { taskPrompt, type ManifestItem, type SwarmInput } from "./manifest.ts";
import { RunStore, type RunRecord } from "./run-store.ts";
import type { Launch } from "./rpc.ts";
import { active, clean, Supervisor, type ChildSnapshot } from "./supervisor.ts";

interface ArmedRun { record: RunRecord; authority: StartQuery; launch: Launch; detach?: () => void; notified?: string }
export interface SwarmOptions {
  sessionId: string; store: RunStore; supervisor: Supervisor; ceiling: number; configurationError?: string;
  claim: (claim: RunClaim) => void; authorize: (claim: RunClaim) => void;
  notify: (delivery: SwarmDelivery, summary: ReturnType<SwarmExecutor["status"]>) => void;
  onChange: () => void;
  onError: (message: string) => void;
}

/** Fixed-batch scheduling over the existing supervisor's single admission pool. */
export class SwarmExecutor {
  private runs = new Map<string, ArmedRun>();
  private instance = randomUUID();
  private releases = new Map<string, () => void>();
  private scheduled = false;
  private closed = false;
  private options: SwarmOptions;
  constructor(options: SwarmOptions) { this.options = options; }

  start(input: SwarmInput, items: ManifestItem[], profile: Profile, launch: Launch, authority: StartQuery, signal?: AbortSignal) {
    if (this.closed) throw new Error("Swarm session is shutting down.");
    const record: RunRecord = {
      version: 1, id: randomUUID(), createdAt: Date.now(), cwd: launch.cwd, profile: structuredClone(profile),
      instruction: input.instruction ?? "", items: structuredClone(items), requestedParallelism: input.maxParallel ?? this.options.ceiling,
      timeoutSeconds: input.timeoutSeconds ?? 900, owner: { pid: 0, instance: "unarmed" }, state: "paused",
      outcomes: items.map(item => ({ taskId: item.id, attempt: 0, state: "queued" })),
    };
    this.releases.set(record.id, this.options.store.claim(record.id, { pid: process.pid, instance: this.instance }));
    try {
      this.options.store.save(record);
      this.arm(record, launch, authority, signal);
    } finally { if (!this.runs.has(record.id)) this.release(record.id); }
    return { swarmId: record.id, taskCount: items.length, requestedParallelism: record.requestedParallelism, effectiveParallelism: this.limit(record), tools: [...record.profile.tools] };
  }

  record(id: string): RunRecord { return structuredClone(this.runs.get(id)?.record ?? this.options.store.load(id)); }

  status(id: string) {
    const record = this.record(id);
    const counts: Record<string, number> = {};
    for (const outcome of record.outcomes) counts[outcome.state] = (counts[outcome.state] ?? 0) + 1;
    return {
      swarmId: id, state: record.state, armed: this.runs.get(id)?.record.state === "running",
      taskCount: record.items.length, counts, requestedParallelism: record.requestedParallelism, effectiveParallelism: this.limit(record),
      cwd: record.cwd, tools: [...record.profile.tools], reason: record.reason,
      recoveryWarning: !this.runs.has(id) && record.outcomes.some(item => ["starting", "running", "stopping"].includes(item.state))
        ? "Recorded active attempts are not supervised here; liveness and cleanup are unconfirmed. No work was restarted." : undefined,
      attention: record.outcomes.filter(item => !["queued", "starting", "running", "succeeded"].includes(item.state)).slice(0, 5).map(item => ({ taskId: item.taskId, state: item.state, error: item.error })),
      attentionTruncated: record.outcomes.filter(item => !["queued", "starting", "running", "succeeded"].includes(item.state)).length > 5,
    };
  }

  results(id: string, offset = 0, limit = 5) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Results require offset >= 0 and limit 1–20.");
    const record = this.record(id);
    // A byte-sized page also bounds long child reports independently of the item limit.
    const results = [];
    let bytes = 0;
    for (let i = offset; i < Math.min(record.items.length, offset + limit); i++) {
      const item = record.items[i];
      const result = { swarmId: id, ...record.outcomes[i], sourceRow: item.row, answerTruncated: record.outcomes[i].answerTruncated ?? false };
      if (Buffer.byteLength(JSON.stringify(result)) > 38_000 && result.answer) {
        result.answer = clean(result.answer, 4000); result.answerTruncated = true;
      }
      const size = Buffer.byteLength(JSON.stringify(result));
      if (results.length && bytes + size > 40_000) break;
      results.push(result); bytes += size;
    }
    const nextOffset = offset + results.length;
    return { swarmId: id, total: record.items.length, offset, results, nextOffset: nextOffset < record.items.length ? nextOffset : undefined };
  }

  pause(id: string, reason = "Paused explicitly by the parent."): void {
    if (this.closed) throw new Error("Swarm session is shutting down.");
    const run = this.owned(id);
    if (run.record.state !== "running") return;
    run.record.state = "paused"; run.record.reason = reason; run.detach?.();
    this.options.store.save(run.record); this.options.onChange(); this.schedule();
  }

  resume(id: string, launch: Launch, authority: StartQuery, signal?: AbortSignal): void {
    if (this.closed) throw new Error("Swarm session is shutting down.");
    const previous = this.runs.get(id);
    if (previous?.record.state === "running") throw new Error("Swarm is already running.");
    if (!previous) this.releases.set(id, this.options.store.claim(id, { pid: process.pid, instance: this.instance }));
    try {
      // Recovery reads mutable outcomes only after the exclusive claim, never a caller's snapshot.
      const record = previous?.record ?? this.options.store.load(id);
      if (previous?.authority.loopId && !authority.loopId) throw new Error("This run's original loop is no longer authorized. Start an approved loop before explicitly resuming here; it cannot become standalone work.");
      if (record.outcomes.some(item => item.state === "stopping" && item.error) || (!previous && record.outcomes.some(item => ["starting", "running", "stopping"].includes(item.state)))) throw new Error("Active or unconfirmed attempts remain; inspect the owning session/process before resuming.");
      if (!record.outcomes.some(item => item.state === "queued" && item.attempt === 0)) throw new Error("No never-started queued items to resume. Submit repairs as new tasks.");
      if (!previous && this.ownerAlive(record.owner.pid)) throw new Error("This run belongs to another live Pi process/runtime. Resume there, or finish its orderly teardown first.");
      this.arm(record, launch, authority, signal);
    } finally { if (!this.runs.has(id)) this.release(id); }
  }

  async stop(id: string): Promise<void> {
    if (this.closed) throw new Error("Swarm session is shutting down.");
    if (!this.runs.has(id)) {
      const release = this.options.store.claim(id, { pid: process.pid, instance: this.instance });
      try {
        const record = this.options.store.load(id);
        if (this.ownerAlive(record.owner.pid)) throw new Error("This run belongs to another live Pi process/runtime; stop it there.");
        if (record.outcomes.some(item => ["starting", "running", "stopping"].includes(item.state))) throw new Error("Recorded attempt cleanup is unconfirmed; inspect local processes before reconciliation.");
        for (const item of record.outcomes) if (item.state === "queued") { item.state = "cancelled"; item.endedAt = Date.now(); }
        record.state = "stopped"; record.reason = "Stopped explicitly by the parent.";
        this.options.store.save(record);
      } finally { release(); }
      return;
    }
    const run = this.owned(id);
    run.record.state = "stopped"; run.record.reason = "Stopped explicitly by the parent."; run.detach?.();
    for (const outcome of run.record.outcomes) if (outcome.state === "queued") { outcome.state = "cancelled"; outcome.endedAt = Date.now(); }
    const errors: unknown[] = [];
    try { this.options.store.save(run.record); }
    catch (error) { errors.push(new Error(`Initial stop state was not persisted: ${String(error)}`)); }
    const stopped = await Promise.allSettled(run.record.outcomes.filter(item => item.childId && ["starting", "running", "stopping"].includes(item.state)).map(item => this.options.supervisor.stop(item.childId!)));
    const cleanup: string[] = [];
    for (const result of stopped) {
      if (result.status === "rejected") errors.push(result.reason);
      else if (active(result.value)) cleanup.push(`${result.value.id}: ${result.value.error ?? "Termination unconfirmed."}`);
    }
    this.schedule(); this.options.onChange();
    if (errors.length) throw new AggregateError(errors, `Stop requested for all active children; ${[...errors.map(String), ...cleanup].join("; ")}`);
  }

  revoke(predicate: (authority: StartQuery) => boolean, reason: string): void {
    if (this.closed) return;
    const revoked = [...this.runs.values()].filter(run => run.record.state === "running" && predicate(run.authority));
    // Revoke every queue before the first fallible save or diagnostic callback.
    for (const run of revoked) { run.record.state = "paused"; run.record.reason = reason; run.detach?.(); }
    const errors: string[] = [];
    for (const run of revoked) {
      try { this.options.store.save(run.record); }
      catch (error) {
        run.record.reason += ` Revocation was not persisted: ${String(error)}`;
        errors.push(`Swarm ${run.record.id}: ${run.record.reason}`);
      }
    }
    this.schedule(); this.options.onChange();
    for (const error of errors) this.options.onError(error);
  }

  childStarted(child: ChildSnapshot): void {
    if (!child.swarmId) return;
    const run = this.runs.get(child.swarmId)!;
    const index = run.record.outcomes.findIndex(item => item.taskId === child.taskId);
    const previous = run.record.outcomes[index];
    run.record.outcomes[index] = { ...previous, attempt: 1, state: child.state, childId: child.id, startedAt: child.startedAt };
    // This callback runs inside the supervisor reservation, before its spawn microtask.
    try { this.options.store.save(run.record); }
    catch (error) { run.record.outcomes[index] = previous; throw error; }
  }

  childrenChanged(children: ChildSnapshot[]): void {
    for (const child of children) {
      if (!child.swarmId) continue;
      const run = this.runs.get(child.swarmId);
      const outcome = run?.record.outcomes.find(item => item.childId === child.id);
      if (!run || !outcome || (outcome.state === child.state && outcome.error === child.error)) continue;
      Object.assign(outcome, { state: child.state, endedAt: child.endedAt, error: child.error, answer: child.output, answerTruncated: child.outputTruncated, usage: child.usage,
        evidence: { reference: `${this.options.store.path(run.record.id)}#/outcomes/${run.record.outcomes.indexOf(outcome)}`, independentlyVerified: false } });
      try { this.options.store.save(run.record); }
      catch (error) { run.record.state = "paused"; run.record.reason = `Outcome persistence failed: ${String(error)}`; run.detach?.(); }
    }
    this.schedule();
  }

  childComplete(child: ChildSnapshot): void {
    if (child.swarmId && !active(child)) this.options.supervisor.forget(child.id);
    this.schedule();
  }

  summaries() { return [...this.runs.keys()].slice(-4).map(id => this.status(id)); }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const run of this.runs.values()) { run.detach?.(); if (run.record.state === "running") run.record.state = "paused"; }
    const errors: unknown[] = [];
    try { await this.options.supervisor.shutdown(); }
    catch (error) { errors.push(error); }
    for (const run of this.runs.values()) {
      for (const outcome of run.record.outcomes) if (outcome.attempt && outcome.state === "cancelled" && outcome.error === "Parent session ended.") outcome.state = "interrupted";
      const unconfirmed = run.record.outcomes.some(item => ["starting", "running", "stopping"].includes(item.state));
      if (!unconfirmed) run.record.owner = { pid: 0, instance: "closed" };
      try {
        this.options.store.save(run.record);
        // Failed saves or unconfirmed writers retain their claim for explicit reconciliation.
        if (!unconfirmed) this.release(run.record.id);
      } catch (error) { errors.push(new Error(`Swarm ${run.record.id} shutdown persistence/ownership release failed: ${String(error)}`)); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  }

  private release(id: string): void {
    this.releases.get(id)!();
    this.releases.delete(id);
  }

  private ownerAlive(pid: number): boolean {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new Error("Cannot confirm the recorded owner is gone; resume refused."); }
  }

  private owned(id: string): ArmedRun {
    const run = this.runs.get(id);
    if (!run) throw new Error("This runtime does not own the run. Read results or explicitly resume its never-started items.");
    return run;
  }

  private limit(record: RunRecord): number { return Math.min(record.requestedParallelism, this.options.ceiling); }

  private arm(record: RunRecord, launch: Launch, authority: StartQuery, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.options.configurationError) throw new Error(this.options.configurationError);
    if (launch.cwd !== record.cwd) throw new Error("Resume must use the recorded cwd.");
    if (authority.loopId) {
      const claim: RunClaim = { sessionId: this.options.sessionId, id: record.id, loopId: authority.loopId, round: authority.round!, allowed: false };
      this.options.claim(claim);
      if (!claim.allowed) throw new Error(claim.reason ?? "Owning loop refused whole-run registration.");
    }
    record.owner = { pid: process.pid, instance: this.instance }; record.state = "running"; record.reason = undefined;
    const run: ArmedRun = { record, launch, authority: { ...authority } };
    this.runs.set(record.id, run);
    if (signal) {
      const abort = () => this.revoke(candidate => candidate === run.authority, "Parent aborted; queued admission revoked. Active children may finish.");
      signal.addEventListener("abort", abort, { once: true }); run.detach = () => signal.removeEventListener("abort", abort);
    }
    try { this.options.store.save(record); }
    catch (error) {
      record.state = "paused"; record.reason = `Could not persist admission: ${String(error)}`; run.detach?.();
      this.options.onChange();
      throw new Error(`Swarm ${record.id} admission was not persisted; no queued work authorized: ${String(error)}`);
    }
    this.options.onChange(); this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed) return;
      try { this.pump(); }
      catch (error) {
        // Persistence/registration failures must never leave another armed dispatch behind.
        for (const run of this.runs.values()) if (run.record.state === "running") { run.record.state = "paused"; run.record.reason = `Scheduling failed: ${String(error)}`; run.detach?.(); }
        this.options.onChange(); this.schedule();
      }
    });
  }

  private pump(): void {
    for (const run of this.runs.values()) {
      const record = run.record;
      while (record.state === "running" && this.options.supervisor.capacity && record.outcomes.filter(item => ["starting", "running", "stopping"].includes(item.state)).length < this.limit(record)) {
        const index = record.outcomes.findIndex(item => item.state === "queued" && item.attempt === 0);
        if (index < 0) break;
        if (run.authority.loopId) {
          const query: RunClaim = { sessionId: this.options.sessionId, id: record.id, loopId: run.authority.loopId, round: run.authority.round!, allowed: false };
          this.options.authorize(query);
          if (!query.allowed) { this.pause(record.id, query.reason ?? "Original loop authority revoked."); break; }
        }
        this.options.supervisor.start({ agent: record.profile.name, task: taskPrompt(record.items[index], record.instruction), launch: run.launch,
          timeoutSeconds: record.timeoutSeconds, swarmId: record.id, taskId: record.items[index].id, loopId: run.authority.loopId });
      }
      const pending = record.outcomes.some(item => ["queued", "starting", "running", "stopping"].includes(item.state));
      const activeCount = record.outcomes.filter(item => ["starting", "running"].includes(item.state) || (item.state === "stopping" && !item.error)).length;
      if (!pending && record.state !== "completed") { record.state = "completed"; run.detach?.(); this.options.store.save(record); }
      if (!activeCount && (record.state !== "running" || record.outcomes.some(item => item.state === "stopping" && item.error))) {
        const key = `${record.state}:${record.reason ?? ""}:${record.outcomes.filter(item => item.state === "queued").length}`;
        if (run.notified !== key) {
          run.notified = key;
          this.options.notify({ sessionId: this.options.sessionId, id: record.id, loopId: run.authority.loopId, round: run.authority.round, deliveryId: randomUUID(), final: !pending }, this.status(record.id));
        }
      }
    }
    this.options.onChange();
  }
}
