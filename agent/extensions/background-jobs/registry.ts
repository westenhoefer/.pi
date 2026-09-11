import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export type JobState = "running" | "stopping" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type StopReason = "user" | "timeout" | "shutdown";

export interface JobSnapshot {
  id: string;
  name: string;
  command: string;
  cwd: string;
  origin: "agent" | "user";
  state: JobState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  error?: string;
  stopReason?: StopReason;
  outputBytes: number;
}

export interface JobInput {
  origin?: "agent" | "user";
  command: string;
  name?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
}

/** Compatible with Pi's public BashOperations.exec; the registry owns no shell policy. */
export type Execute = (
  command: string,
  cwd: string,
  options: { onData: (data: Buffer) => void; signal: AbortSignal; env: NodeJS.ProcessEnv },
) => Promise<{ exitCode: number | null }>;

interface Job {
  snapshot: JobSnapshot;
  output: Buffer;
  controller: AbortController;
  settled: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  execute: Execute;
  onChange?: (job: JobSnapshot) => void;
  maxRunning?: number;
  maxJobs?: number;
  tailBytes?: number;
  stopWaitMs?: number;
}

export function isActive(job: JobSnapshot): boolean {
  return job.state === "running" || job.state === "stopping";
}

function cleanOutput(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly execute: Execute;
  private readonly onChange: (job: JobSnapshot) => void;
  private readonly maxRunning: number;
  private readonly maxJobs: number;
  private readonly tailBytes: number;
  private readonly stopWaitMs: number;
  private closed = false;

  constructor(options: RegistryOptions) {
    this.execute = options.execute;
    this.onChange = options.onChange ?? (() => {});
    this.maxRunning = options.maxRunning ?? 4;
    this.maxJobs = options.maxJobs ?? 32;
    this.tailBytes = options.tailBytes ?? 256 * 1024;
    this.stopWaitMs = options.stopWaitMs ?? 5000;
    for (const [name, value] of Object.entries({
      maxRunning: this.maxRunning, maxJobs: this.maxJobs, tailBytes: this.tailBytes, stopWaitMs: this.stopWaitMs,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
    }
  }

  start(input: JobInput): JobSnapshot {
    if (this.closed) throw new Error("Background jobs are shutting down; start a new session first.");
    if (!input.command.trim() || Buffer.byteLength(input.command) > 8192) {
      throw new Error("Command must be nonempty and at most 8192 bytes.");
    }
    const name = input.name?.trim() || "job";
    if (name.length > 80) throw new Error("Job name must be at most 80 characters.");
    const timeout = input.timeoutSeconds ?? 3600;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) {
      throw new Error("Timeout must be greater than zero and at most 86400 seconds.");
    }
    if (this.list().filter(isActive).length >= this.maxRunning) {
      throw new Error(`At most ${this.maxRunning} jobs may run at once. Stop or wait for a job first.`);
    }
    this.evictFinishedJob();
    const job: Job = {
      snapshot: {
        id: randomUUID().slice(0, 12), name, command: input.command, cwd: input.cwd,
        origin: input.origin ?? "user",
        state: "running", startedAt: new Date().toISOString(), outputBytes: 0,
      },
      output: Buffer.alloc(0),
      controller: new AbortController(),
      settled: Promise.resolve(),
    };
    this.jobs.set(job.snapshot.id, job);
    job.timer = setTimeout(() => this.requestStop(job, "timeout"), timeout * 1000);
    this.publish(job);
    job.settled = this.run(job, { ...input, env: { ...input.env } });
    return { ...job.snapshot };
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => ({ ...job.snapshot }));
  }

  status(id: string): JobSnapshot {
    return { ...this.get(id).snapshot };
  }

  logs(id: string, maxBytes = 16 * 1024, maxLines = 200): { job: JobSnapshot; text: string; truncated: boolean } {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024) {
      throw new Error("Log byte limit must be 1–51200.");
    }
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 2000) {
      throw new Error("Log line limit must be 1–2000.");
    }
    const job = this.get(id);
    let bytes = job.output.subarray(Math.max(0, job.output.length - maxBytes));
    // A tail can begin inside a UTF-8 sequence. Drop only that partial character.
    while (bytes.length && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
    // Invalid binary bytes decode to replacement characters, which can expand in UTF-8.
    const cleaned = Buffer.from(cleanOutput(bytes.toString("utf8")));
    let bounded = cleaned.subarray(Math.max(0, cleaned.length - maxBytes));
    while (bounded.length && (bounded[0] & 0xc0) === 0x80) bounded = bounded.subarray(1);
    const lines = bounded.toString("utf8").split("\n");
    return {
      job: { ...job.snapshot },
      text: lines.slice(-maxLines).join("\n"),
      truncated: job.snapshot.outputBytes > bytes.length || cleaned.length > bounded.length || lines.length > maxLines,
    };
  }

  async stop(id: string): Promise<JobSnapshot> {
    const job = this.get(id);
    this.requestStop(job, "user");
    await this.waitForSettlement([job]);
    return { ...job.snapshot };
  }

  async shutdown(): Promise<JobSnapshot[]> {
    this.closed = true;
    const active = [...this.jobs.values()].filter((job) => isActive(job.snapshot));
    for (const job of active) this.requestStop(job, "shutdown");
    await this.waitForSettlement(active);
    return active.filter((job) => isActive(job.snapshot)).map((job) => ({ ...job.snapshot }));
  }

  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job '${id}'. Use job_status or /jobs for exact IDs; history is session-local.`);
    return job;
  }

  private evictFinishedJob(): void {
    if (this.jobs.size < this.maxJobs) return;
    const oldest = [...this.jobs.values()].find((job) => !isActive(job.snapshot));
    if (!oldest) throw new Error("Job history is full of active jobs.");
    this.jobs.delete(oldest.snapshot.id);
  }

  private appendOutput(job: Job, data: Buffer): void {
    job.snapshot.outputBytes += data.length;
    if (data.length >= this.tailBytes) {
      job.output = Buffer.from(data.subarray(data.length - this.tailBytes));
    } else {
      const keep = Math.min(job.output.length, this.tailBytes - data.length);
      job.output = Buffer.concat([job.output.subarray(job.output.length - keep), data]);
    }
  }

  private requestStop(job: Job, reason: StopReason): void {
    if (job.snapshot.state !== "running") return;
    job.snapshot.state = "stopping";
    job.snapshot.stopReason = reason;
    if (job.timer) clearTimeout(job.timer);
    job.controller.abort();
    this.publish(job);
  }

  private async run(job: Job, input: JobInput): Promise<void> {
    try {
      const result = await this.execute(input.command, input.cwd, {
        signal: job.controller.signal,
        env: input.env,
        onData: (data) => this.appendOutput(job, data),
      });
      job.snapshot.exitCode = result.exitCode;
      job.snapshot.state = result.exitCode === 0 ? "succeeded" : "failed";
    } catch (error) {
      job.snapshot.state = "failed";
      job.snapshot.error = cleanOutput(error instanceof Error ? error.message : String(error)).slice(0, 2000);
    } finally {
      if (job.timer) clearTimeout(job.timer);
      if (job.snapshot.stopReason) {
        job.snapshot.state = job.snapshot.stopReason === "timeout" ? "timed_out" : "cancelled";
      }
      job.snapshot.endedAt = new Date().toISOString();
      this.publish(job);
    }
  }

  private async waitForSettlement(jobs: Job[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(jobs.map((job) => job.settled)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.stopWaitMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private publish(job: Job): void {
    // UI failures must not turn a successful process into a failed job or leak a rejection.
    try { this.onChange({ ...job.snapshot }); }
    catch (error) { console.error("Background job notification failed:", error); }
  }
}
