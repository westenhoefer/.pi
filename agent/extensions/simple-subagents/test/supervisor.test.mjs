import assert from "node:assert/strict";
import { test } from "node:test";
import { Supervisor } from "../supervisor.ts";

const launch = { command: "unused", args: [], cwd: ".", env: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const connections = [], completed = [], started = [];
  const supervisor = new Supervisor({ sessionId: "parent", onStarted: child => started.push(child), onChange() {}, onComplete: child => completed.push(child),
    connect(_launch, event, exit) {
      const child = { event, exit, requests: [], closed: false,
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

test("parallel children return IDs immediately, complete individually once, and retain answers", async t => {
  const h = harness(); t.after(() => h.supervisor.shutdown());
  const first = h.start(), second = h.start("Review tests");
  assert.notEqual(first.id, second.id); assert.equal(h.connections.length, 0);
  assert.throws(() => h.start(), /Two children/);
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
