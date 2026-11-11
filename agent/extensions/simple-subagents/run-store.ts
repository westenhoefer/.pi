import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "./launch.ts";
import type { ManifestItem } from "./manifest.ts";
import type { ChildSnapshot, ChildState } from "./supervisor.ts";

export interface TaskOutcome {
  taskId: string; attempt: 0 | 1; state: "queued" | "interrupted" | ChildState;
  childId?: string; startedAt?: number; endedAt?: number; answer?: string; answerTruncated?: boolean; error?: string;
  usage?: ChildSnapshot["usage"]; selection?: ChildSnapshot["selection"]; evidence?: { reference: string; independentlyVerified: false };
}
export interface RunRecord {
  version: 1; id: string; createdAt: number; cwd: string; profile: Profile; instruction: string;
  items: ManifestItem[]; requestedParallelism: number; timeoutSeconds: number;
  owner: { pid: number; instance: string }; state: "running" | "paused" | "stopped" | "completed";
  outcomes: TaskOutcome[]; reason?: string; panel?: { question: string };
}

export function readConcurrency(agentDir: string): { limit: number; error?: string } {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8").replace(/^\uFEFF/, ""));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("expected a settings object");
    const group = settings.simpleSubagents;
    if (group !== undefined && (!group || typeof group !== "object" || Array.isArray(group))) throw new Error("expected a simpleSubagents object");
    const value = group?.maxConcurrency;
    if (value === undefined) return { limit: 5 };
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("expected a positive integer");
    return { limit: value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { limit: 5 };
    return { limit: 5, error: `Invalid user setting simpleSubagents.maxConcurrency: ${error instanceof SyntaxError ? "settings.json is malformed" : (error as Error).message}. Launches refused.` };
  }
}

/** Only facts and fixed inputs live here. Authorization and Launch.env never cross this boundary. */
export class RunStore {
  private directory: string;
  constructor(agentDir: string) { this.directory = join(agentDir, "simple-subagents", "runs"); }
  block(children: ChildSnapshot[]): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, "unconfirmed-teardown.json"), JSON.stringify(children.map(({ id, swarmId, state, error }) => ({ id, swarmId, state, error }))), { mode: 0o600 });
  }
  admissionError(): string | undefined {
    const path = join(this.directory, "unconfirmed-teardown.json");
    try { readFileSync(path, "utf8"); return `Unconfirmed child teardown recorded at ${path}. Inspect local processes and reconcile this record before launching more work.`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid swarm ID.");
    return join(this.directory, `${id}.json`);
  }
  claim(id: string, owner: RunRecord["owner"]): () => void {
    mkdirSync(this.directory, { recursive: true });
    const path = `${this.path(id)}.claim`;
    const token = JSON.stringify(owner);
    try { writeFileSync(path, token, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`This run belongs to another live or unconfirmed Pi process/runtime. Ownership claim: ${path}. Finish orderly teardown there, or inspect processes and explicitly reconcile a stale claim; it is never reclaimed automatically.`);
      throw error;
    }
    return () => {
      if (readFileSync(path, "utf8") !== token) throw new Error(`Run ownership changed unexpectedly at ${path}; release refused.`);
      unlinkSync(path);
    };
  }
  save(record: RunRecord): void {
    mkdirSync(this.directory, { recursive: true });
    const target = this.path(record.id);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, target);
  }
  load(id: string): RunRecord {
    const record = JSON.parse(readFileSync(this.path(id), "utf8")) as RunRecord;
    if (record.version !== 1 || record.id !== id) throw new Error("Unsupported swarm record.");
    return record;
  }
}
