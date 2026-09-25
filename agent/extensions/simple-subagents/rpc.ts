import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface RpcRecord { type: string; [key: string]: any }
export interface Launch { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface ChildTransport {
  request(command: RpcRecord): Promise<RpcRecord>;
  close(): Promise<void>;
}
export type Connect = (launch: Launch, onEvent: (event: RpcRecord) => void, onExit: (error: Error) => void) => ChildTransport;

/** A bounded, session-owned JSONL connection. No shell, detached daemon, or private Pi imports. */
export class RpcProcess implements ChildTransport {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: RpcRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private stderr = "";
  private closed = false;
  private failureReported = false;
  private failure?: Error;
  private activeTools = new Set<string>();
  private cleanupUnconfirmed = false;
  private closing?: Promise<void>;
  private exit: Promise<void>;
  private resolveExit!: () => void;

  private onEvent: (event: RpcRecord) => void;
  private onExit: (error: Error) => void;

  constructor(launch: Launch, onEvent: (event: RpcRecord) => void, onExit: (error: Error) => void) {
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
      // A process group on POSIX allows stop to include tools spawned by the child.
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", chunk => this.read(chunk));
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.once("error", error => this.fail(error));
    const exited = (code: number | null, signal: string | null) => {
      if (this.closed) return;
      // A crashed root does not prove detached tool-process termination. Never release
      // a writer slot on that evidence alone, even if its stdio pipes later close.
      if ((!this.closing || code !== 0) && this.activeTools.size) this.cleanupUnconfirmed = true;
      this.closed = true;
      this.resolveExit();
      this.fail(new Error(`Child exited (code ${code}, signal ${signal ?? "none"}).${this.stderr ? ` ${this.stderr}` : ""}`));
    };
    this.child.once("exit", exited);
    this.child.once("close", exited); // Spawn errors may have no exit event.
  }

  request(command: RpcRecord): Promise<RpcRecord> {
    if (this.closed || this.closing) return Promise.reject(new Error("Child is closed or stopping."));
    if (this.failure) return Promise.reject(this.failure);
    const id = `request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${command.type} acknowledgement timed out.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n", error => {
        if (error) this.reject(id, error);
      });
    });
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutdown();
    return this.closing;
  }

  private reject(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.buffer = "";
    for (const id of this.pending.keys()) this.reject(id, error);
    if (!this.closing && !this.failureReported) {
      this.failureReported = true;
      this.onExit(error);
    }
  }

  private read(chunk: Buffer): void {
    if (this.failure) return; // Keep draining the pipe without retaining malformed/unbounded data.
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) return this.fail(new Error("Child RPC record exceeds 8 MiB."));
      if (!line.trim()) continue;
      let record: RpcRecord;
      try { record = JSON.parse(line); }
      catch { return this.fail(new Error("Invalid JSON from child RPC stdout.")); }
      if (!record || typeof record.type !== "string") return this.fail(new Error("Invalid child RPC record."));
      if (record.type === "response") {
        const item = this.pending.get(record.id);
        if (!item) continue;
        if (record.success !== true) this.reject(record.id, new Error(String(record.error ?? "RPC command rejected.")));
        else {
          clearTimeout(item.timer);
          this.pending.delete(record.id);
          item.resolve(record);
        }
      } else {
        if (record.type === "tool_execution_start") this.activeTools.add(String(record.toolCallId));
        if (record.type === "tool_execution_end") this.activeTools.delete(String(record.toolCallId));
        try { this.onEvent(record); }
        catch (error) { return this.fail(new Error(`Could not process child RPC event: ${error instanceof Error ? error.message : String(error)}`)); }
      }
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.fail(new Error("Unterminated child RPC record exceeds 8 MiB."));
  }

  private async wait(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async shutdown(): Promise<void> {
    for (const id of this.pending.keys()) this.reject(id, new Error("Child is stopping."));
    if (this.closed) return this.confirmCleanup();
    // RPC EOF requests orderly shutdown, including Pi's tracked tool-process cleanup.
    this.child.stdin.end();
    if (await this.wait(1500)) return this.confirmCleanup();
    // Built-in shell tools may have their own process groups. A forced root exit is
    // not a cleanup receipt for those tools, even when a tree kill was attempted.
    if (this.activeTools.size) this.cleanupUnconfirmed = true;
    const pid = this.child.pid;
    if (pid) {
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { /* The exit wait below reports unconfirmed termination. */ });
      } else {
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    if (!await this.wait(3500)) throw new Error(`Child ${pid ?? "unknown"} termination unconfirmed; check local processes.`);
    this.confirmCleanup();
  }

  private confirmCleanup(): void {
    if (!this.cleanupUnconfirmed) return;
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.stdin.destroy();
    throw new Error("RPC process exited while tools were active without confirmed graceful cleanup. Tool processes may remain; inspect local processes before further work.");
  }
}
