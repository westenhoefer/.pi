import assert from "node:assert/strict";
import { test } from "node:test";
import { JobRegistry, isActive } from "../registry.ts";

const input = { command: "example", cwd: process.cwd(), env: {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function controlled() {
  const calls = [];
  const execute = (command, cwd, options) => new Promise((resolve, reject) => {
    calls.push({ command, cwd, options, resolve, reject });
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { execute, calls };
}

test("launch returns before completion, streams output, and preserves command/cwd/env", async () => {
  const backend = controlled();
  const changes = [];
  const registry = new JobRegistry({ execute: backend.execute, onChange: (job) => changes.push(job.state) });
  const env = { EXAMPLE: "original" };
  const launched = registry.start({ ...input, env });
  env.EXAMPLE = "changed";
  assert.equal(launched.state, "running");
  assert.equal(backend.calls[0].options.env.EXAMPLE, "original");
  assert.equal(backend.calls[0].cwd, input.cwd);
  assert.equal(backend.calls[0].command, input.command);
  backend.calls[0].options.onData(Buffer.from("hello\n"));
  assert.equal(registry.logs(launched.id).text, "hello\n");
  backend.calls[0].resolve({ exitCode: 0 });
  await tick();
  assert.equal(registry.status(launched.id).state, "succeeded");
  assert.ok(registry.status(launched.id).endedAt);
  assert.deepEqual(changes, ["running", "succeeded"]);
  assert.equal(launched.state, "running", "snapshots are immutable views");
  await registry.shutdown();
});

test("nonzero exits and launch errors are failures, not successful completions", async () => {
  const registry = new JobRegistry({ execute: async (command) => {
    if (command === "throw") throw new Error("spawn failed");
    return { exitCode: 7 };
  } });
  const exit = registry.start(input);
  const error = registry.start({ ...input, command: "throw" });
  await tick();
  assert.equal(registry.status(exit.id).state, "failed");
  assert.equal(registry.status(exit.id).exitCode, 7);
  assert.equal(registry.status(error.id).error, "spawn failed");
  await registry.shutdown();
});

test("stop is idempotent and targets only the requested job", async () => {
  const backend = controlled();
  const registry = new JobRegistry({ execute: backend.execute });
  const a = registry.start(input);
  const b = registry.start(input);
  assert.equal((await registry.stop(a.id)).state, "cancelled");
  assert.equal((await registry.stop(a.id)).stopReason, "user");
  assert.equal(registry.status(b.id).state, "running");
  assert.equal(backend.calls[1].options.signal.aborted, false);
  assert.deepEqual(await registry.shutdown(), []);
  assert.equal(registry.status(b.id).stopReason, "shutdown");
  assert.throws(() => registry.start(input), /shutting down/);
});

test("timeout differs from explicit cancellation", async () => {
  const backend = controlled();
  const registry = new JobRegistry({ execute: backend.execute });
  const job = registry.start({ ...input, timeoutSeconds: 0.02 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(registry.status(job.id).state, "timed_out");
  assert.equal(registry.status(job.id).stopReason, "timeout");
  await registry.shutdown();
});

test("unconfirmed cancellation stays stopping and continues consuming capacity", async () => {
  let finish;
  const registry = new JobRegistry({ execute: () => new Promise((resolve) => { finish = resolve; }), maxRunning: 1, stopWaitMs: 10 });
  const job = registry.start(input);
  assert.equal((await registry.stop(job.id)).state, "stopping");
  assert.throws(() => registry.start(input), /At most 1/);
  assert.equal((await registry.shutdown())[0].id, job.id);
  finish({ exitCode: null });
  await tick();
  assert.equal(registry.status(job.id).state, "cancelled");
});

test("bounded tails, byte/line limits, binary input, and terminal controls", async () => {
  const backend = controlled();
  const registry = new JobRegistry({ execute: backend.execute, tailBytes: 32 });
  const job = registry.start(input);
  const emit = backend.calls[0].options.onData;
  emit(Buffer.from("discard this ".repeat(100)));
  emit(Buffer.from("\n\x1b[31mred\x1b[0m\nlast"));
  const logs = registry.logs(job.id, 32, 2);
  assert.equal(logs.text, "red\nlast");
  assert.equal(logs.truncated, true);
  assert.ok(registry.status(job.id).outputBytes > 32);
  emit(Buffer.from([255, 255, 255, 255, 255, 255]));
  assert.ok(Buffer.byteLength(registry.logs(job.id, 6).text) <= 6);
  emit(Buffer.from("🦊🦊🦊"));
  assert.equal(registry.logs(job.id, 5).text, "🦊");
  await registry.shutdown();
});

test("limits reject before execution; oldest finished history is evicted, never active jobs", async () => {
  const backend = controlled();
  const registry = new JobRegistry({ execute: backend.execute, maxRunning: 2, maxJobs: 2 });
  assert.throws(() => registry.start({ ...input, command: " " }), /nonempty/);
  assert.throws(() => registry.start({ ...input, command: "x".repeat(8193) }), /8192/);
  for (const timeoutSeconds of [0, -1, NaN, Infinity, 86401]) {
    assert.throws(() => registry.start({ ...input, timeoutSeconds }), /Timeout/);
  }
  assert.equal(backend.calls.length, 0);
  const a = registry.start(input);
  const b = registry.start(input);
  assert.throws(() => registry.start(input), /At most 2/);
  backend.calls[1].resolve({ exitCode: 0 });
  await tick();
  const c = registry.start(input);
  assert.throws(() => registry.status(b.id), /Unknown job/);
  assert.deepEqual(registry.list().map((job) => job.id), [a.id, c.id]);
  await registry.shutdown();
  assert.equal(registry.list().some(isActive), false);
});

test("unknown IDs and invalid log bounds fail explicitly", async () => {
  const registry = new JobRegistry({ execute: async () => ({ exitCode: 0 }) });
  assert.throws(() => registry.status("other-session"), /Unknown job/);
  await assert.rejects(registry.stop("other-session"), /Unknown job/);
  const job = registry.start(input);
  assert.throws(() => registry.logs(job.id, 51201), /byte limit/);
  assert.throws(() => registry.logs(job.id, 100, 2001), /line limit/);
  await registry.shutdown();
});
