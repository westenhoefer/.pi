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
  const attention = [];
  bus.on("pi:attention", data => attention.push(data));
  const loaded = await loadExtensions([resolve("agent/extensions/goal-loop/index.ts")], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const sent = [], notices = [], statuses = new Map();
  let idle = true, pending = false, editor = "", session = "test", leaf = "initial";
  const ctx = {
    cwd: process.cwd(), mode: "tui", hasUI: true,
    isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => session, getLeafId: () => leaf },
    ui: {
      confirm: async () => true,
      notify: (text) => notices.push(text),
      setStatus: (key, text) => statuses.set(key, text),
      getEditorText: () => editor,
    },
  };
  loaded.runtime.sendMessage = (message, options) => { sent.push({ message, options }); idle = false; };
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  async function emit(name, event = {}) {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  }
  t.after(() => emit("session_shutdown"));
  const command = (args) => extension.commands.get("loop").handler(args, ctx);
  const checkpoint = (outcome = "continue", progress = "New result; test passed") => extension.tools.get("loop_checkpoint").definition.execute("cp", { outcome, progress, next: outcome === "continue" ? "Verify remaining requirement" : "" }, undefined, undefined, ctx);
  async function settle() { idle = true; await emit("agent_settled"); }
  return { ctx, sent, notices, statuses, attention, emit, command, checkpoint, settle, tick: ms => t.mock.timers.tick(ms), setIdle: value => { idle = value; }, setPending: value => { pending = value; }, setEditor: value => { editor = value; }, setSession: value => { session = value; }, setLeaf: value => { leaf = value; } };
}

test("manual loop: notify once after settlement, feedback stays paused, resume approves one round", { skip }, async t => {
  const h = await harness(t); await h.command("--manual goal");
  await h.checkpoint();
  assert.equal(h.attention.length, 0);
  await h.settle(); await h.settle();
  assert.deepEqual(h.attention.map(x => x.kind), ["loop_approval"]);
  assert.match(h.statuses.get("goal-loop"), /approval required/);
  h.tick(120_000); assert.equal(h.sent.length, 1);
  await h.emit("input", { source: "interactive", text: "Focus on tests next" });
  await h.settle();
  assert.match(h.statuses.get("goal-loop"), /approval required/);
  h.setPending(true); await h.command("resume"); assert.equal(h.sent.length, 1);
  h.setPending(false); await h.command("resume"); assert.equal(h.sent.length, 2);
  await h.command("resume"); assert.equal(h.sent.length, 2);
  await h.checkpoint("done");
  assert.equal(h.attention.length, 1);
  await h.settle(); await h.settle();
  assert.deepEqual(h.attention.map(x => x.kind), ["loop_approval", "loop_done"]);
  await h.command("resume"); assert.equal(h.sent.length, 2);
});

test("abort or subsequent tool work invalidates an unannounced manual completion", { skip }, async t => {
  const h = await harness(t);
  for (const [name, event] of [
    ["agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }],
    ["tool_execution_start", { toolName: "read" }],
    ["tool_execution_end", { toolName: "read", isError: false }],
  ]) {
    await h.command("--manual goal"); await h.checkpoint("done");
    await h.emit(name, event); await h.settle();
    assert.equal(h.attention.at(-1).kind, "loop_stopped");
  }
});

test("manual stop and lifecycle cleanup suppress stale approval/completion notices", { skip }, async t => {
  const h = await harness(t); await h.command("--manual goal"); await h.checkpoint();
  await h.command("stop"); await h.settle(); await h.command("resume");
  assert.equal(h.sent.length, 1); assert.equal(h.attention.length, 0);
  await h.command("--manual other goal"); await h.checkpoint();
  await h.emit("session_shutdown"); await h.settle();
  assert.equal(h.attention.length, 0);
});

test("manual approval survives long waits without losing its session and round limits", { skip }, async t => {
  const h = await harness(t);
  let confirmation;
  h.ctx.ui.confirm = async (_title, body) => { confirmation = body; return true; };
  await h.command("--manual --rounds 2 goal");
  assert.match(confirmation, /no time deadline/);
  await h.checkpoint(); await h.settle();
  h.tick(60 * 60_000);
  await h.command("status"); assert.match(h.notices.at(-1), /manual approval, no deadline/);
  assert.match(h.statuses.get("goal-loop"), /approval required/);
  assert.equal(h.attention.at(-1).kind, "loop_approval");
  await h.command("resume"); assert.equal(h.sent.length, 2);
  await h.checkpoint(); await h.settle(); await h.command("resume");
  assert.equal(h.sent.length, 2);
  assert.match(h.notices.at(-1), /No manual loop awaiting approval/);
});

test("manual resume still rejects a replaced session after a long wait", { skip }, async t => {
  const h = await harness(t); await h.command("--manual goal"); await h.checkpoint(); await h.settle();
  h.tick(60 * 60_000); h.setSession("different"); await h.command("resume");
  assert.equal(h.sent.length, 1);
});

test("automatic loop still expires at 30 minutes", { skip }, async t => {
  const h = await harness(t); await h.command("--delay 600 goal"); await h.checkpoint(); await h.settle();
  h.setEditor("draft steering pauses countdown");
  h.tick(30 * 60_000); await h.command("status");
  assert.equal(h.sent.length, 1);
  assert.match(h.notices.at(-1), /30-minute continuation budget exhausted/);
});

test("selected round limit appears in confirmation, footer, status, prompt, and enforces automatic stop", { skip }, async t => {
  const h = await harness(t);
  let confirmation;
  h.ctx.ui.confirm = async (_title, body) => { confirmation = body; return true; };
  await h.command("--rounds 2 --delay 1 goal");
  assert.match(confirmation, /up to 2 work rounds/);
  assert.match(h.statuses.get("goal-loop"), /Loop 1\/2/);
  await h.command("status"); assert.match(h.notices.at(-1), /round 1\/2/);
  assert.match(h.sent[0].message.content, /round 1\/2/);
  await h.checkpoint(); await h.settle(); h.tick(1000);
  assert.match(h.sent[1].message.content, /round 2\/2/);
  await h.checkpoint("continue", "Second round verified"); await h.settle(); h.tick(60_000);
  assert.equal(h.sent.length, 2);
  assert.match(h.notices.at(-1), /2-round limit/);
});

test("single-round manual option ends without asking for approval", { skip }, async t => {
  const h = await harness(t); await h.command("--manual --rounds 1 goal");
  await h.checkpoint(); await h.settle(); await h.command("resume");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.attention.map(x => x.kind), ["loop_stopped"]);
});

test("real loader: explicit start, visible countdown, next round, completion", { skip }, async t => {
  const h = await harness(t);
  await h.command("Implement the scoped fix");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "goal-loop");
  assert.equal(h.sent[0].options.triggerTurn, true);
  await h.checkpoint(); await h.settle();
  h.tick(59_000); assert.equal(h.sent.length, 1);
  assert.match(h.statuses.get("goal-loop"), /next in 1s/);
  h.tick(1000); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].message.content, /round 2\/5/);
  await h.checkpoint("done"); await h.settle(); h.tick(120_000);
  assert.equal(h.sent.length, 2); assert.equal(h.statuses.get("goal-loop"), undefined);
});

for (const event of ["user_bash", "ui_prompt_start", "session_before_compact", "session_before_tree", "session_shutdown"]) {
  test(`${event} cancels countdown permanently`, { skip }, async t => {
    const h = await harness(t); await h.command("goal"); await h.checkpoint(); await h.settle();
    await h.emit(event); h.tick(120_000); await h.settle(); h.tick(120_000);
    assert.equal(h.sent.length, 1); assert.equal(h.statuses.get("goal-loop"), undefined);
  });
}

for (const cause of ["editor", "pending", "busy", "session"]) {
  test(`${cause} takes precedence at timer boundary`, { skip }, async t => {
    const h = await harness(t); await h.command("goal"); await h.checkpoint(); await h.settle();
    if (cause === "editor") h.setEditor("Wait, change this");
    if (cause === "pending") h.setPending(true);
    if (cause === "busy") h.setIdle(false);
    if (cause === "session") h.setSession("other");
    h.tick(60_000); assert.equal(h.sent.length, 1);
  });
}

for (const toolName of ["job_start", "subagent"]) {
  test(`${toolName} suspends automation without polling or cancelling child work`, { skip }, async t => {
    const h = await harness(t); await h.command("goal");
    await h.emit("tool_execution_start", { toolName });
    await assert.rejects(h.checkpoint(), /No working/);
    await h.settle(); h.tick(120_000); assert.equal(h.sent.length, 1);
  });
}

test("abort, external notifications, and missing final checkpoints never auto-retry", { skip }, async t => {
  const h = await harness(t);
  await h.command("goal"); await h.checkpoint();
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  await h.settle(); h.tick(60_000); assert.equal(h.sent.length, 1);
  await h.command("new goal"); await h.checkpoint(); await h.settle();
  await h.emit("message_start", { message: { role: "custom", customType: "background-result" } });
  h.tick(60_000); assert.equal(h.sent.length, 2);
  await h.command("last goal"); await h.settle(); h.tick(60_000); assert.equal(h.sent.length, 3);
});

test("declined/failed confirmation, headless modes, busy start, and stop while confirming launch nothing", { skip }, async t => {
  const h = await harness(t);
  h.ctx.ui.confirm = async () => false; await h.command("goal");
  h.ctx.ui.confirm = async () => { throw new Error("UI disconnected"); }; await h.command("goal");
  h.ctx.ui.confirm = async () => true;
  for (const mode of ["print", "json", "rpc"]) { h.ctx.mode = mode; await h.command("goal"); }
  h.ctx.mode = "tui"; h.setIdle(false); await h.command("goal"); h.setIdle(true);
  h.ctx.ui.confirm = async () => { await h.command("stop"); return true; }; await h.command("goal");
  h.tick(120_000); assert.equal(h.sent.length, 0);
});

test("user steering keeps the loop and requires a fresh checkpoint before another countdown", { skip }, async t => {
  const h = await harness(t); await h.command("--delay 15 original goal"); await h.checkpoint(); await h.settle();
  h.tick(10_000);
  await h.emit("input", { source: "interactive", text: "Focus on the other case first" });
  h.setIdle(false); await h.emit("message_start", { message: { role: "user" } });
  h.tick(60_000); assert.equal(h.sent.length, 1);
  await h.checkpoint("continue", "Other case fixed and tested"); await h.settle();
  h.tick(14_000); assert.equal(h.sent.length, 1);
  h.tick(1000); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].message.content, /original goal/);
  assert.match(h.sent[1].message.content, /15 seconds/);
  await h.command("status"); assert.match(h.notices.at(-1), /delay 15s/);
});

test("typing pauses rather than cancels, then grants a fresh quiet period", { skip }, async t => {
  const h = await harness(t); await h.command("--delay 5 goal"); await h.checkpoint(); await h.settle();
  h.setEditor("draft steering"); h.tick(5000);
  assert.equal(h.sent.length, 1); assert.match(h.statuses.get("goal-loop"), /paused/);
  h.setEditor(""); h.tick(4000); assert.equal(h.sent.length, 1);
  h.tick(1000); assert.equal(h.sent.length, 2);
});

test("idle custom-message append without extension lifecycle events cancels countdown", { skip }, async t => {
  const h = await harness(t); await h.command("goal"); await h.checkpoint(); await h.settle();
  // AgentSession._appendCustomMessage changes the leaf but does not emit through extensionRunner.
  h.setLeaf("external-custom-message"); h.tick(60_000);
  assert.equal(h.sent.length, 1); assert.match(h.notices.at(-1), /Conversation changed/);
});

test("failed second checkpoint cannot reuse prior continuation", { skip }, async t => {
  const h = await harness(t); await h.command("goal"); await h.checkpoint();
  await h.emit("tool_execution_start", { toolName: "loop_checkpoint" });
  await h.emit("tool_execution_end", { toolName: "loop_checkpoint", isError: true });
  await h.settle(); h.tick(60_000);
  assert.equal(h.sent.length, 1); assert.match(h.notices.at(-1), /No final checkpoint/);
});

test("new steering during start confirmation invalidates that unstarted request", { skip }, async t => {
  const h = await harness(t);
  h.ctx.ui.confirm = async () => { await h.emit("input", { source: "interactive", text: "Actually wait" }); return true; };
  await h.command("goal"); h.tick(60_000); assert.equal(h.sent.length, 0);
});

test("invalid delays and round counts never reach approval or dispatch", { skip }, async t => {
  const h = await harness(t); h.ctx.ui.confirm = async () => { assert.fail("invalid options reached approval"); };
  for (const args of ["--delay 0 goal", "--delay 601 goal", "--delay nope goal", "--delay 15", "--rounds 0 goal", "--rounds 21 goal", "--rounds 2.5 goal", "--rounds 2 --rounds 3 goal"]) await h.command(args);
  assert.equal(h.sent.length, 0);
});

test("/loop stop cancels continuation, no model-callable restart", { skip }, async t => {
  const h = await harness(t); await h.command("goal"); await h.checkpoint(); await h.settle();
  await h.command("stop"); h.tick(60_000); assert.equal(h.sent.length, 1);
  await assert.rejects(h.checkpoint(), /Only the user/);
});
