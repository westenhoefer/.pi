import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Supervisor } from "../supervisor.ts";

const launch = { command: "unused", args: [], cwd: ".", env: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const connections = [], completed = [], started = [];
  const supervisor = new Supervisor({ sessionId: "parent", onStarted: child => started.push(child), onChange() {}, onComplete: child => completed.push(child), maxConcurrency: 2,
    ...options.supervisor,
    connect(launch, event, exit) {
      const child = { launch, event, exit, requests: [], closed: false,
        async request(request) { child.requests.push(request); return options.request ? options.request(request) : { type: "response", success: true }; },
        async close() { child.closed = true; if (options.close) await options.close(); },
      };
      connections.push(child); return child;
    },
  });
  function start(task = "Read code") { return supervisor.start({ agent: "scout", task, launch, loopId: "loop" }); }
  function finish(index, text = "Findings", reason = "stop") {
    connections[index].event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: reason } });
    connections[index].event({ type: "agent_settled" });
  }
  return { supervisor, connections, completed, started, start, finish };
}

// Supervisor tests use a controlled provisioner: no checkouts or processes are created.
const worktreeDirectory = join(import.meta.dirname, "worktrees");
const worktreeBase = "deadbeef".repeat(5);
const trusted = { ...launch, args: ["--mode", "rpc", "--approve"], env: { GIT_DIR: "elsewhere", Git_Work_Tree: "elsewhere", GIT_INDEX_FILE: "elsewhere", GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "file", KEEP: "value" } };
const isolated = { agent: "worker", task: "Inspect checkout", launch: trusted, worktreeBase };

test("worktree reservation captures the path before provisioning; only the isolated launch loses cwd trust and Git overrides", async t => {
  const calls = [], ready = Promise.withResolvers();
  const h = harness({ supervisor: { worktreeDirectory, provisionWorktree(...args) { calls.push(args); return ready.promise; } } });
  t.after(() => { ready.resolve(); return h.supervisor.shutdown(); });
  const first = h.supervisor.start(isolated), second = h.supervisor.start(isolated);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.deepEqual(h.started.map(child => child.worktreePath), [join(worktreeDirectory, first.id), join(worktreeDirectory, second.id)]);
  assert.deepEqual(calls, []);
  await tick();
  assert.deepEqual(calls, [first, second].map(child => [trusted.cwd, worktreeBase, child.worktreePath]));
  assert.equal(h.connections.length, 0);
  ready.resolve(); await tick();
  for (const [index, child] of [first, second].entries()) {
    const connected = h.connections[index];
    assert.equal(connected.launch.cwd, child.worktreePath);
    assert.deepEqual(connected.launch.args, ["--mode", "rpc", "--no-approve"]);
    assert.deepEqual(connected.launch.env, { GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "file", KEEP: "value" });
    assert.equal(connected.requests.at(-1).type, "prompt");
  }
  h.finish(0); await tick();
  assert.equal(h.completed[0].worktreePath, first.worktreePath);
  const ordinary = h.supervisor.start({ ...isolated, worktreeBase: undefined }); await tick();
  assert.equal(ordinary.worktreePath, undefined);
  assert.equal(h.connections[2].launch.cwd, ".");
  assert.ok(h.connections[2].launch.args.includes("--approve"));
  assert.equal(h.connections[2].launch.env.GIT_DIR, "elsewhere");
  assert.equal(calls.length, 2);
});

test("missing worktree directory and rejected reservations never provision; preparation failure never falls back", async () => {
  let attempts = 0;
  const provisionWorktree = async () => { attempts++; throw new Error("checkout refused"); };
  const unconfigured = harness({ supervisor: { provisionWorktree } });
  assert.throws(() => unconfigured.supervisor.start(isolated), /absolute worktree directory/);
  assert.deepEqual(unconfigured.started, []);
  const rejected = harness({ supervisor: { provisionWorktree, worktreeDirectory, onStarted() { throw new Error("not reserved"); } } });
  assert.throws(() => rejected.supervisor.start(isolated), /not reserved/);
  await tick(); assert.equal(attempts, 0); assert.deepEqual(rejected.supervisor.list(), []);
  const h = harness({ supervisor: { provisionWorktree, worktreeDirectory } });
  const child = h.supervisor.start(isolated); await tick();
  assert.equal(attempts, 1); assert.equal(h.connections.length, 0);
  assert.equal(h.completed[0].state, "failed"); assert.match(h.completed[0].error, /checkout refused/);
  assert.equal(h.completed[0].worktreePath, child.worktreePath);
});

for (const reason of ["stop", "timeout", "shutdown"]) {
  test(`${reason} during checkout holds ownership until Git quiesces and never connects`, async t => {
    const ready = Promise.withResolvers();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let preparing = false;
    const h = harness({ supervisor: { maxConcurrency: 1, worktreeDirectory, provisionWorktree() { preparing = true; return ready.promise; } } });
    t.after(() => { ready.resolve(); return h.supervisor.shutdown(); });
    const child = h.supervisor.start({ ...isolated, timeoutSeconds: 1 });
    await tick(); assert.ok(preparing);
    let settled = false, pending;
    if (reason === "timeout") t.mock.timers.tick(1000);
    else pending = (reason === "stop" ? h.supervisor.stop(child.id) : h.supervisor.shutdown()).then(() => { settled = true; });
    await tick(); assert.equal(settled, false);
    assert.equal(h.supervisor.status(child.id).state, "stopping");
    assert.equal(h.supervisor.capacity, 0); assert.equal(h.completed.length, 0);
    if (reason === "stop") ready.reject(new Error("late checkout failure")); else ready.resolve();
    await pending; await tick();
    assert.equal(h.supervisor.status(child.id).state, reason === "timeout" ? "timed_out" : "cancelled");
    assert.equal(h.supervisor.capacity, reason === "shutdown" ? 0 : 1);
    assert.equal(h.completed.length, reason === "shutdown" ? 0 : 1);
    assert.equal(h.connections.length, 0);
  });
}

test("hung checkout returns an unconfirmed stop without releasing admission or connecting later", async t => {
  const pending = Promise.withResolvers();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ supervisor: { worktreeDirectory, provisionWorktree: () => pending.promise } });
  const child = h.supervisor.start(isolated);
  await tick();
  const stopping = h.supervisor.stop(child.id);
  await tick(); t.mock.timers.tick(5000);
  const snapshot = await stopping;
  assert.equal(snapshot.state, "stopping");
  assert.match(snapshot.error, /Git checkout still pending/);
  assert.equal(h.supervisor.capacity, 0);
  assert.equal((await h.supervisor.shutdown())[0].id, child.id);
  pending.resolve(); await tick();
  assert.equal(h.connections.length, 0);
});

test("exact selection refuses fuzzy catalog drift, wrong providers and missing state before sending any task", async t => {
  for (const model of [{ provider: "chosen", id: "requested-model-new" }, { provider: "other", id: "requested-model" }, undefined]) {
    const h = harness({ request: () => ({ data: { model, thinkingLevel: "medium" } }) });
    t.after(() => h.supervisor.shutdown());
    h.supervisor.start({ agent: "scout", task: "Must not reach an unselected model", launch: { ...launch,
      selection: { provider: "chosen", model: "requested-model", thinking: "high" } } });
    await tick();
    assert.equal(h.completed[0].state, "failed");
    assert.match(h.completed[0].error, /Exact model selection failed.*No task was sent/);
    assert.deepEqual(h.connections[0].requests.map(request => request.type), ["get_state"]);
    assert.equal(h.connections[0].closed, true);
  }
});

test("reports attribute actual child model and effective thinking rather than only requested launch flags", async t => {
  const h = harness({ request: () => ({ data: { model: { provider: "selected", id: "model" }, thinkingLevel: "medium" } }) });
  t.after(() => h.supervisor.shutdown());
  const child = h.supervisor.start({ agent: "scout", task: "Explore", launch: { ...launch, selection: { provider: "selected", model: "model", thinking: "xhigh" } } });
  assert.equal(child.selection.thinking, "xhigh");
  await tick(); assert.equal(h.supervisor.status(child.id).selection.thinking, "medium");
  h.connections[0].event({ type: "message_end", message: { role: "assistant", provider: "actual", model: "physical", thinkingLevel: "low", content: [{ type: "text", text: "Answer" }], stopReason: "stop" } });
  h.connections[0].event({ type: "agent_settled" }); await tick();
  assert.deepEqual(h.completed[0].selection, { provider: "actual", model: "physical", thinking: "low" });
});

test("parallel children return IDs immediately, complete individually once, and retain answers", async t => {
  const h = harness(); t.after(() => h.supervisor.shutdown());
  const first = h.start(), second = h.start("Review tests");
  assert.notEqual(first.id, second.id); assert.equal(h.connections.length, 0);
  assert.throws(() => h.start(), /Concurrency ceiling/);
  await tick(); h.finish(1, "Second answer"); await tick();
  assert.equal(h.completed.length, 1); assert.equal(h.completed[0].id, second.id);
  assert.equal(h.supervisor.status(first.id).state, "running");
  h.finish(1); h.connections[1].exit(new Error("exit after settlement")); await tick();
  assert.equal(h.completed.length, 1);
  h.finish(0, "First answer"); await tick();
  assert.equal(h.completed.length, 2); assert.equal(h.supervisor.status(first.id).output, "First answer");
  assert.equal(h.completed[0].loopId, "loop"); assert.equal(h.connections.every(child => child.closed), true);
});

test("steering is queued to a running child; settled children cannot be restarted", async t => {
  const h = harness(); t.after(() => h.supervisor.shutdown()); const child = h.start();
  await assert.rejects(h.supervisor.steer(child.id, "change"), /not running/);
  await tick(); assert.match(await h.supervisor.steer(child.id, "Focus on tests"), /accepted/);
  assert.deepEqual(h.connections[0].requests.at(-1), { type: "steer", message: "Focus on tests" });
  h.finish(0); await tick(); await assert.rejects(h.supervisor.steer(child.id, "again"), /not running/);
});

test("rejected launch and steering are not reported as success", async t => {
  const h = harness({ request(command) { if (command.type === "steer") throw new Error("steer rejected"); return {}; } });
  t.after(() => h.supervisor.shutdown()); const child = h.start(); await tick();
  await assert.rejects(h.supervisor.steer(child.id, "change"), /steer rejected/);
  const bad = harness({ request() { throw new Error("startup failed"); } });
  bad.start(); await tick(); assert.equal(bad.completed[0].state, "failed"); assert.match(bad.completed[0].error, /startup failed/);
});

test("steering racing settlement explicitly reports unconfirmed delivery", async () => {
  let acknowledge;
  const h = harness({ request(command) { return command.type === "steer" ? new Promise(resolve => { acknowledge = resolve; }) : {}; } });
  const child = h.start(); await tick(); const steering = h.supervisor.steer(child.id, "late guidance");
  h.finish(0); acknowledge({}); await assert.rejects(steering, /not confirmed/); await tick();
  assert.equal(h.completed.length, 1);
});

test("crashes, provider errors, approvals and missing final messages produce honest terminal states", async () => {
  for (const scenario of ["crash", "provider", "approval", "empty"]) {
    const h = harness(); h.start(); await tick();
    if (scenario === "crash") h.connections[0].exit(new Error("process vanished"));
    if (scenario === "provider") h.finish(0, "", "error");
    if (scenario === "approval") h.connections[0].event({ type: "extension_ui_request", method: "confirm", title: "Delete files?" });
    if (scenario === "empty") h.connections[0].event({ type: "agent_settled" });
    await tick(); assert.equal(h.completed[0].state, scenario === "approval" ? "blocked" : "failed");
    assert.equal(h.connections[0].closed, true);
  }
});

test("tool progress and retries are not completion; a later successful final message wins", async () => {
  const h = harness(); const child = h.start(); await tick();
  h.connections[0].event({ type: "tool_execution_start", toolName: "read" });
  assert.match(h.supervisor.status(child.id).activity, /read/);
  h.connections[0].event({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
  h.connections[0].event({ type: "agent_end", willRetry: true });
  assert.equal(h.completed.length, 0); h.finish(0); await tick(); assert.equal(h.completed[0].state, "succeeded");
});

test("shutdown before spawn and during execution suppresses all late completion wakes", async () => {
  const h = harness(); h.start(); await h.supervisor.shutdown(); await tick(); assert.equal(h.connections.length, 0);
  assert.throws(() => h.start(), /shutting down/);
  const live = harness(); live.start(); live.start(); await tick();
  await live.supervisor.shutdown(); live.finish(0); live.finish(1); await tick();
  assert.equal(live.completed.length, 0); assert.equal(live.connections.every(child => child.closed), true);
});

test("stop is idempotent, deadline stops work, and output is bounded", async t => {
  const h = harness(); const child = h.start(); await tick();
  await h.supervisor.stop(child.id); await h.supervisor.stop(child.id);
  assert.equal(h.completed.length, 1); assert.equal(h.completed[0].state, "cancelled");
  const large = harness(); large.start(); await tick(); large.finish(0, "x".repeat(50_000)); await tick();
  assert.match(large.completed[0].output, /Truncated/); assert.ok(large.completed[0].output.length < 17_000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timed = harness(); timed.start(); await tick(); t.mock.timers.tick(900_000); await tick();
  assert.equal(timed.completed[0].state, "timed_out");
});

test("unconfirmed termination stays stopping and prevents additional work", async () => {
  const h = harness({ close() { throw new Error("still alive"); } });
  const child = h.start(); await tick(); const stopped = await h.supervisor.stop(child.id);
  assert.equal(stopped.state, "stopping"); assert.match(stopped.error, /Termination unconfirmed/);
  assert.throws(() => h.start(), /unconfirmed/); assert.equal((await h.supervisor.shutdown()).length, 1);
});
