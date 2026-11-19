import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export type Launch = { command: string; args: string[]; windowsVerbatimArguments?: boolean };

type ClientOptions = {
  cwd: string;
  onUpdate: (params: unknown) => void;
  onPermission: (params: unknown) => Promise<unknown>;
};
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
type Pending = (error: Error | undefined, result?: unknown) => void;
type Id = string | number | null;

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_BYTES = 2 * MAX_FRAME_BYTES;
const DRAIN_MS = 200;
const EXIT_MS = 3000;
const WINDOWS = process.platform === "win32";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is Id {
  return value === null || typeof value === "string" || Number.isSafeInteger(value);
}

async function waitFor(event: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([event, new Promise<boolean>(resolve => { timer = setTimeout(resolve, ms, false); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** One ACP v1 stdio connection. Request cancellation is local; session cancellation belongs to the caller. */
export class AcpClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly options: ClientOptions;
  private readonly wrappedWindowsProcess: boolean;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private fragment: Buffer = Buffer.alloc(0);
  private fragmentLength = 0;
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private exited = false;
  private signalExit!: (exited: boolean) => void;
  private readonly exit = new Promise<boolean>(resolve => { this.signalExit = resolve; });
  private exitDrain?: ReturnType<typeof setTimeout>;
  private groupStopped?: boolean;

  constructor(launch: Launch, options: ClientOptions) {
    this.options = options;
    this.wrappedWindowsProcess = WINDOWS && launch.windowsVerbatimArguments === true;
    try {
      this.child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: !WINDOWS, // Own a process group on POSIX, not a separate Windows console.
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      throw new Error("Could not start the ACP subprocess.");
    }
    this.child.on("error", () => {
      if (this.child.pid === undefined) this.markExited(); // Spawn failures have no 'exit' event.
      this.stop(new Error("ACP subprocess error (could not start or control it)."));
    });
    this.child.once("exit", () => {
      this.markExited();
      if (!WINDOWS) this.stopGroup(); // Signal the group promptly even if the leader exited first.
      // 'exit' can precede the last stdout data. Don't wait indefinitely for inherited pipes.
      if (!this.failure) this.exitDrain = setTimeout(() => this.stop(new Error("ACP subprocess exited.")), DRAIN_MS);
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdout.once("end", () => this.stop(new Error(this.fragmentLength
      ? "ACP subprocess sent a truncated NDJSON frame."
      : "ACP subprocess closed stdout."), true));
    this.child.stdout.on("error", () => this.stop(new Error("ACP subprocess stdout failed.")));
    this.child.stdin.on("error", () => {
      if (!this.exited) this.stop(new Error("ACP subprocess stdin failed."), true);
    });
  }

  get alive(): boolean {
    return !this.failure && !this.exited;
  }

  request(method: string, params: unknown, options?: RequestOptions): Promise<unknown> {
    if (!this.alive) return Promise.reject(this.failure ?? new Error("ACP subprocess exited."));
    const { signal, timeoutMs } = options ?? {};
    const abortError = () => new DOMException("ACP request aborted.", "AbortError");
    if (signal?.aborted) return Promise.reject(abortError());
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) {
      return Promise.reject(new Error("Invalid ACP request timeout."));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => settle(abortError());
      const timer = timeoutMs === undefined ? undefined
        : setTimeout(() => settle(Object.assign(new Error("ACP request timed out."), { code: "ACP_DEADLINE" })), timeoutMs);
      const settle: Pending = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result);
      };
      this.pending.set(id, settle);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        settle(error as Error);
      }
    });
  }

  /** Best effort after disconnect. While live, writes in call order with request(). */
  notify(method: string, params: unknown): void {
    if (this.alive) this.write({ jsonrpc: "2.0", method, params });
  }

  close(): Promise<void> {
    return this.stop(new Error("ACP connection closed."), true);
  }

  private write(message: Record<string, unknown>): void {
    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      throw new Error("Could not encode ACP message as JSON.");
    }
    this.writeFrame(json);
  }

  private writeFrame(json: string): void {
    const size = Buffer.byteLength(json) + 1;
    if (size > MAX_FRAME_BYTES + 1) throw new Error("Outgoing ACP NDJSON frame exceeds 8 MiB.");
    if (!this.alive) throw this.failure ?? new Error("ACP subprocess exited.");
    if (this.child.stdin.writableLength + size > MAX_QUEUED_BYTES) {
      const error = new Error("ACP subprocess stdin is not keeping up.");
      this.stop(error);
      throw error;
    }
    try {
      // Node's Writable queues writes in order, including while waiting for spawn or drain.
      this.child.stdin.write(Buffer.from(json + "\n"), error => {
        if (error && !this.exited) this.stop(new Error("ACP subprocess stdin failed."), true);
      });
    } catch {
      const error = new Error("ACP subprocess stdin failed.");
      this.stop(error);
      throw error;
    }
  }

  private read(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.failure) {
      const newline = chunk.indexOf(0x0a, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
      const size = this.fragmentLength + part.length;
      if (size > MAX_FRAME_BYTES) {
        this.stop(new Error("Incoming ACP NDJSON frame exceeds 8 MiB."));
        return;
      }
      let frame = part;
      if (newline < 0 || this.fragmentLength) {
        if (size > this.fragment.length) {
          const grown = Buffer.allocUnsafe(Math.min(MAX_FRAME_BYTES, Math.max(size, 4096, this.fragment.length * 2)));
          this.fragment.copy(grown, 0, 0, this.fragmentLength);
          this.fragment = grown;
        }
        part.copy(this.fragment, this.fragmentLength);
        this.fragmentLength = size;
        if (newline < 0) return;
        frame = this.fragment.subarray(0, size);
        this.fragmentLength = 0;
      }
      offset = newline + 1;
      let message: unknown;
      try {
        const line = this.decoder.decode(frame);
        if (!line.trim()) continue;
        message = JSON.parse(line);
      } catch {
        this.stop(new Error("Invalid UTF-8 or JSON in ACP subprocess stdout."));
        return;
      }
      this.receive(message);
    }
  }

  private receive(message: unknown): void {
    if (record(message) && message.jsonrpc === "2.0") {
      const { method, id, params, error, result } = message;
      const hasId = Object.hasOwn(message, "id");
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (typeof method === "string" && method && !hasResult && !hasError && (!hasId || isId(id))) {
        if (hasId && isId(id)) {
          if (method === "session/request_permission") void this.permission(id, params);
          else this.replyError(id, -32601, "Method not found");
        } else if (method === "session/update") {
          try { this.options.onUpdate(params); }
          catch { this.stop(new Error("ACP session update callback failed.")); }
        }
        return;
      }
      if (!Object.hasOwn(message, "method") && hasId && isId(id) && hasResult !== hasError) {
        if (hasResult) {
          if (typeof id === "number") this.pending.get(id)?.(undefined, result);
          return;
        }
        if (record(error) && Number.isSafeInteger(error.code) && typeof error.message === "string") {
          // Neither remote error text/data nor spawn diagnostics are safe to echo.
          if (typeof id === "number") {
            this.pending.get(id)?.(Object.assign(new Error(`ACP request failed (JSON-RPC code ${error.code}).`), { code: error.code }));
          }
          return;
        }
      }
    }
    this.stop(new Error("Invalid ACP JSON-RPC message."));
  }

  private async permission(id: Id, params: unknown): Promise<void> {
    try {
      const result = await this.options.onPermission(params);
      if (!this.alive) return;
      // Stringify the result separately so an unserializable return cannot silently omit it.
      const json = JSON.stringify(result);
      if (json === undefined) throw new Error();
      this.writeFrame(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${json}}`);
    } catch {
      this.replyError(id, -32603, "Permission request could not be handled");
    }
  }

  private replyError(id: Id, code: number, message: string): void {
    if (!this.alive) return;
    try { this.write({ jsonrpc: "2.0", id, error: { code, message } }); }
    catch { this.stop(new Error("Could not reply to ACP subprocess request.")); }
  }

  private markExited(): void {
    this.exited = true;
    this.signalExit(true);
  }

  private stop(error: Error, drain = false): Promise<void> {
    if (this.closing) return this.closing;
    this.failure = error;
    clearTimeout(this.exitDrain);
    this.fragment = Buffer.alloc(0);
    this.fragmentLength = 0;
    for (const settle of this.pending.values()) settle(error);
    this.closing = Promise.resolve().then(() => this.shutdown(drain));
    // Internal failures initiate shutdown without a close() caller. Explicit close still reports failure.
    void this.closing.catch(() => {});
    return this.closing;
  }

  private stopGroup(): boolean {
    if (this.groupStopped !== undefined) return this.groupStopped;
    const pid = this.child.pid;
    if (!pid) return true;
    try {
      process.kill(-pid, "SIGKILL");
      return this.groupStopped = true;
    } catch (error) {
      return this.groupStopped = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private async stopWindowsTree(): Promise<boolean> {
    const pid = this.child.pid;
    // Never rediscover a PID or target an exited root. Without a Job Object we can't
    // recover descendants if the root has already gone away by itself.
    if (pid === undefined) return true; // No process was created.
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return !this.wrappedWindowsProcess;
    try {
      if (!this.child.kill(0)) return !this.wrappedWindowsProcess;
      const taskkill = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/T", "/F", "/PID", String(pid)], { shell: false, windowsHide: true, stdio: "ignore" });
      const success = await waitFor(new Promise<boolean>(resolve => {
        taskkill.once("error", () => resolve(false));
        taskkill.once("exit", code => resolve(code === 0));
      }), EXIT_MS);
      if (!success && taskkill.exitCode === null && taskkill.signalCode === null) {
        taskkill.kill();
        taskkill.unref();
      }
      return success;
    } catch {
      return false;
    }
  }

  private async shutdown(drain: boolean): Promise<void> {
    try {
      // Give a just-written session/cancel a chance to arrive. Don't close stdin first:
      // on Windows that could lose the live process-tree root before we run taskkill.
      if (drain && !this.exited) await waitFor(this.exit, DRAIN_MS);
      const treeStopped = WINDOWS ? await this.stopWindowsTree() : this.stopGroup();
      if (!treeStopped && !this.exited) {
        try { this.child.kill("SIGKILL"); } catch { /* The exit wait reports failure. */ }
      }
      if (!this.exited && !await waitFor(this.exit, EXIT_MS)) throw new Error("ACP subprocess exit could not be confirmed.");
      if (!treeStopped) throw new Error("ACP subprocess tree termination could not be confirmed.");
    } finally {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      if (!this.exited) this.child.unref();
    }
  }
}
