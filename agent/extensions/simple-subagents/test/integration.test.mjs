import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for real loader integration.";
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(t) {
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  const bus = createEventBus();
  const loaded = await loadExtensions([resolve("agent/extensions/simple-subagents/test/fixture.ts"), resolve("agent/extensions/goal-loop/index.ts")], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map(), commands = new Map();
  for (const extension of loaded.extensions) {
    for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
    for (const [name, command] of extension.commands) commands.set(name, command);
  }
  const sent = [], widgets = new Map(), statuses = new Map(), notices = [];
  let idle = true, sessionId = "integration";
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(), thinkingLevel: "high",
    model: { provider: "test-provider", id: "test-model" }, isProjectTrusted: () => false,
    isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf" },
    ui: { confirm: async () => true, notify: text => notices.push(text), getEditorText: () => "", setWidget: (key, lines) => widgets.set(key, lines), setStatus: (key, text) => statuses.set(key, text) },
  };
  loaded.runtime.sendMessage = (message, options) => { sent.push({ message, options }); idle = false; };
  async function emit(name, event = {}) {
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  }
  const call = (name, args = {}) => tools.get(name).execute("call", args, undefined, undefined, ctx);
  const checkpoint = outcome => call("loop_checkpoint", { outcome, progress: "Concrete new verification evidence", next: outcome === "continue" ? "Review remaining requirement" : "" });
  const children = () => { const query = {}; bus.emit("test:children", query); return query.children; };
  async function complete(index) {
    const child = children()[index];
    child.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Result ${index}` }], stopReason: "stop" } });
    child.event({ type: "agent_settled" }); await flush();
    const latest = sent.at(-1);
    await emit("message_start", { message: { role: "custom", ...latest.message } });
  }
  async function settle() { idle = true; await emit("agent_settled"); }
  await emit("session_start"); t.after(() => emit("session_shutdown"));
  return { ctx, sent, widgets, statuses, notices, children, call, checkpoint, complete, emit, settle, command: args => commands.get("loop").handler(args, ctx), setSession: value => { sessionId = value; } };
}

test("both real-loaded extensions coordinate parallel completion wakes and manual approval", { skip }, async t => {
  const h = await harness(t); await h.command("--manual goal");
  const a = await h.call("subagent_start", { agent: "scout", task: "Inspect parser" });
  const b = await h.call("subagent_start", { agent: "reviewer", task: "Review tests" }); await flush();
  assert.equal(h.children().length, 2);
  assert.match(h.widgets.get("simple-subagents").join("\n"), /scout/);
  const launch = h.children()[0].launch;
  assert.ok(launch.args.includes("--no-extensions")); assert.ok(launch.args.includes("--no-approve"));
  assert.equal(launch.cwd, process.cwd()); assert.equal(launch.env.PI_SIMPLE_SUBAGENT, "1");
  await h.checkpoint("waiting"); await h.settle(); assert.match(h.statuses.get("goal-loop"), /waiting for 2/);
  await h.complete(1); assert.equal(h.sent.at(-1).options.deliverAs, "followUp");
  assert.equal(h.sent.at(-1).options.triggerTurn, true); assert.equal(h.sent.at(-1).message.details.id, b.details.id);
  await h.call("subagent_steer", { id: a.details.id, message: "Check boundary cases" });
  assert.equal(h.children()[0].commands.at(-1).type, "steer");
  await h.checkpoint("waiting"); await h.settle();
  await h.complete(0); await h.checkpoint("continue"); await h.settle();
  assert.match(h.statuses.get("goal-loop"), /Loop 1\/5.*approval required/);
  await assert.rejects(h.call("subagent_start", { agent: "scout", task: "Unapproved next round" }), /approved working/);
  assert.equal(h.children().length, 2);
  await h.command("resume"); assert.match(h.statuses.get("goal-loop"), /Loop 2\/5/);
});

test("teardown closes children and suppresses stale result delivery into a replacement session", { skip }, async t => {
  const h = await harness(t); await h.call("subagent_start", { agent: "scout", task: "Inspect" }); await flush();
  const child = h.children()[0]; await h.emit("session_shutdown"); h.setSession("replacement"); await h.emit("session_start");
  const before = h.sent.length;
  child.event({ type: "agent_settled" }); child.exit(new Error("late exit")); await flush();
  assert.equal(child.closed, true); assert.equal(h.sent.length, before);
  assert.match((await h.call("subagent_status")).content[0].text, /No children/);
});

test("explicit stop wakes once and unsupported parent modes cannot spawn", { skip }, async t => {
  const h = await harness(t); const child = await h.call("subagent_start", { agent: "scout", task: "Inspect" }); await flush();
  await h.call("subagent_stop", { id: child.details.id });
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.details.state, "cancelled");
  await h.call("subagent_stop", { id: child.details.id }); assert.equal(h.sent.length, 1);
  h.ctx.mode = "rpc"; await assert.rejects(h.call("subagent_start", { agent: "scout", task: "Inspect" }), /parent TUI/);
});

test("child role hook preserves discovered instruction text and exposes no recursive tools", { skip }, async () => {
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  const previous = { marker: process.env.PI_SIMPLE_SUBAGENT, prompt: process.env.PI_SIMPLE_SUBAGENT_PROMPT };
  try {
    process.env.PI_SIMPLE_SUBAGENT = "1"; process.env.PI_SIMPLE_SUBAGENT_PROMPT = "Read-only scout role";
    const loaded = await loadExtensions([resolve("agent/extensions/simple-subagents/child-runtime.ts"), resolve("agent/extensions/simple-subagents/index.ts")], process.cwd(), createEventBus());
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions[1].tools.size, 0);
    const hook = loaded.extensions[0].handlers.get("before_agent_start")[0];
    const result = await hook({ systemPrompt: "Base prompt\nGlobal AGENTS\nProject AGENTS\nDiscovered APPEND_SYSTEM" }, {});
    assert.equal(result.systemPrompt, "Base prompt\nGlobal AGENTS\nProject AGENTS\nDiscovered APPEND_SYSTEM\n\nRead-only scout role");
  } finally {
    if (previous.marker === undefined) delete process.env.PI_SIMPLE_SUBAGENT; else process.env.PI_SIMPLE_SUBAGENT = previous.marker;
    if (previous.prompt === undefined) delete process.env.PI_SIMPLE_SUBAGENT_PROMPT; else process.env.PI_SIMPLE_SUBAGENT_PROMPT = previous.prompt;
  }
});
