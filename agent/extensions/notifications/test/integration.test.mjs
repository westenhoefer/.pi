import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = process.env.PI_TEST_PACKAGE_DIR;
const skip = !piRoot && "Set PI_TEST_PACKAGE_DIR for real Pi-loader integration tests.";

async function harness(t) {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
  const bus = createEventBus();
  const delivered = [], sent = [], notices = [], statuses = new Map();
  bus.on("notifications:test-delivered", kind => delivered.push(kind));
  const loaded = await loadExtensions([
    resolve("agent/extensions/goal-loop/index.ts"),
    resolve("agent/extensions/notifications/test/fixture.ts"),
  ], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  let idle = true, pending = false, session = "test";
  const ctx = {
    cwd: process.cwd(), mode: "tui", hasUI: true,
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => session, getLeafId: () => "leaf" },
    ui: { notify: text => notices.push(text), setStatus: (key, text) => statuses.set(key, text), confirm: async () => true, getEditorText: () => "" },
  };
  loaded.runtime.sendUserMessage = text => { sent.push(text); idle = false; };
  loaded.runtime.sendMessage = message => { sent.push(message); idle = false; };
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  async function emit(name, event = {}) {
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  }
  async function command(name, args) {
    const extension = loaded.extensions.find(extension => extension.commands.has(name));
    return extension.commands.get(name).handler(args, ctx);
  }
  async function checkpoint(outcome) {
    return loaded.extensions[1].tools.get("notify_checkpoint").definition.execute("cp", { outcome }, undefined, undefined, ctx);
  }
  async function settle() { idle = true; await emit("agent_settled"); }
  await emit("session_start");
  t.after(() => emit("session_shutdown"));
  return { ctx, bus, delivered, sent, notices, statuses, loaded, command, checkpoint, emit, settle,
    setPending: value => { pending = value; }, setSession: value => { session = value; } };
}

test("ordinary tasks stay silent; /notify sends original task and alerts only once after final checkpoint", { skip }, async t => {
  const h = await harness(t); await h.settle(); assert.deepEqual(h.delivered, []);
  await h.command("notify", "Fix the scoped bug"); assert.equal(h.sent[0], "Fix the scoped bug");
  await h.checkpoint("done"); assert.deepEqual(h.delivered, []);
  h.setPending(true); await h.settle(); assert.deepEqual(h.delivered, []);
  h.setPending(false); await h.settle(); await h.settle();
  assert.deepEqual(h.delivered, ["task_done"]);
  assert.equal(h.statuses.get("task-notifications"), undefined);
  await assert.rejects(h.checkpoint("done"), /No \/notify task/);
});

test("background/delegated wait is not completion; result processing can finish the same subscription", { skip }, async t => {
  const h = await harness(t); await h.command("notify", "Run the lengthy checks");
  for (const toolName of ["job_start", "subagent"]) {
    await h.emit("tool_execution_start", { toolName });
    await h.emit("tool_execution_end", { toolName, isError: false });
  }
  await h.checkpoint("waiting"); await h.settle(); await h.settle();
  assert.deepEqual(h.delivered, []);
  await h.emit("message_start", { message: { role: "custom", customType: "background-job-completed" } });
  await h.emit("tool_execution_start", { toolName: "job_logs" });
  await h.emit("tool_execution_end", { toolName: "job_logs", isError: false });
  await h.checkpoint("done"); await h.settle();
  assert.deepEqual(h.delivered, ["task_done"]);
});

test("input requests deduplicate prompts and checkpoint, then rearm on user reply", { skip }, async t => {
  const h = await harness(t); await h.command("notify", "task");
  await h.emit("ui_prompt_start"); await h.emit("ui_prompt_start");
  await h.checkpoint("needs_input"); await h.settle();
  assert.deepEqual(h.delivered, ["task_input"]);
  await h.emit("input", { source: "interactive" });
  await h.checkpoint("needs_input"); await h.settle();
  assert.deepEqual(h.delivered, ["task_input", "task_input"]);
  await h.command("notify", "off"); await h.emit("ui_prompt_start");
  assert.equal(h.delivered.length, 2);
});

test("stale checkpoints, later parallel completions, and failed checkpoints do not notify", { skip }, async t => {
  const h = await harness(t); await h.command("notify", "task");
  for (const event of [
    ["tool_execution_start", { toolName: "read" }],
    ["tool_execution_end", { toolName: "read", isError: false }],
    ["tool_execution_end", { toolName: "notify_checkpoint", isError: true }],
    ["input", { source: "interactive" }],
  ]) {
    await h.checkpoint("done"); await h.emit(...event); await h.settle();
  }
  assert.deepEqual(h.delivered, []);
  await h.emit("tool_execution_start", { toolName: "notify_checkpoint" });
  await h.checkpoint("done"); await h.emit("tool_execution_end", { toolName: "notify_checkpoint", isError: false });
  await h.settle(); assert.deepEqual(h.delivered, ["task_done"]);
});

test("automatic retry recovery reports final completion, not the intermediate error", { skip }, async t => {
  const h = await harness(t); await h.command("notify", "task");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  await h.checkpoint("done");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await h.settle(); assert.deepEqual(h.delivered, ["task_done"]);
});

for (const stopReason of ["error", "aborted"]) {
  test(`${stopReason} sends interruption rather than false completion`, { skip }, async t => {
    const h = await harness(t); await h.command("notify", "task"); await h.checkpoint("done");
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
    await h.settle(); await h.settle(); assert.deepEqual(h.delivered, ["task_error"]);
  });
}

for (const event of ["session_before_tree", "session_switch", "session_shutdown"]) {
  test(`${event} cancels subscription without a stale desktop alert`, { skip }, async t => {
    const h = await harness(t); await h.command("notify", "task"); await h.checkpoint("done");
    await h.emit(event); await h.settle(); assert.deepEqual(h.delivered, []);
  });
}

test("session identity guards and non-TUI modes never deliver", { skip }, async t => {
  const h = await harness(t);
  for (const mode of ["print", "json", "rpc"]) { h.ctx.mode = mode; await h.command("notify", "task"); await h.command("notify", "test"); }
  assert.equal(h.sent.length, 0); assert.deepEqual(h.delivered, []);
  h.ctx.mode = "tui"; await h.command("notify", "task"); await h.checkpoint("done");
  h.setSession("new"); await h.settle(); assert.deepEqual(h.delivered, []);
  h.bus.emit("pi:attention", { sessionId: "test", kind: "loop_approval" });
  assert.deepEqual(h.delivered, []);
});

test("manual loop integration sends one approval and one completion; active loops reject /notify", { skip }, async t => {
  const h = await harness(t); await h.command("loop", "--manual task");
  const loopCheckpoint = outcome => h.loaded.extensions[0].tools.get("loop_checkpoint").definition.execute("cp", {
    outcome, progress: "verified progress", next: outcome === "continue" ? "verify more" : "",
  }, undefined, undefined, h.ctx);
  await loopCheckpoint("continue"); await h.settle(); await h.settle();
  assert.deepEqual(h.delivered, ["loop_approval"]);
  await h.command("notify", "other task"); assert.equal(h.sent.length, 1);
  await h.command("loop", "resume"); await loopCheckpoint("done"); await h.settle();
  assert.deepEqual(h.delivered, ["loop_approval", "loop_done"]);
  assert.equal(h.sent.length, 2);
});

test("automatic loops remain silent on desktop", { skip }, async t => {
  const h = await harness(t); await h.command("loop", "task");
  await h.loaded.extensions[0].tools.get("loop_checkpoint").definition.execute("cp", {
    outcome: "done", progress: "verified", next: "",
  }, undefined, undefined, h.ctx);
  await h.settle(); assert.deepEqual(h.delivered, []);
});

test("loop start cancels any armed task notifier, avoiding competing checkpoint instructions", { skip }, async t => {
  const h = await harness(t); await h.command("notify", "task"); await h.checkpoint("waiting"); await h.settle();
  await h.command("loop", "--manual task");
  assert.equal(h.statuses.get("task-notifications"), undefined);
  await assert.rejects(h.checkpoint("done"), /No \/notify task/);
});

test("off, status, escaped reserved words, invalid commands, and test delivery failure", { skip }, async t => {
  const h = await harness(t);
  await h.command("notify", "status"); await h.command("notify", "/loop task");
  assert.equal(h.sent.length, 0);
  await h.command("notify", "-- status"); assert.equal(h.sent[0], "status");
  await h.command("notify", "another task"); assert.equal(h.sent.length, 1);
  await h.command("notify", "off"); await h.settle();
  h.bus.emit("notifications:test-fail"); await h.command("notify", "test");
  assert.deepEqual(h.delivered, []);
  assert.match(h.notices.at(-1), /delivery failed/);
});

test("production notifier registers against installed SDK without sending a real notification", { skip }, async () => {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("agent/extensions/notifications/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].commands.has("notify"));
});
