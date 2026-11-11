import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rename, rm } from "node:fs/promises";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for real loader integration.";
const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(t, configuration, existingAgentDir) {
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  const bus = createEventBus();
  const agentDir = existingAgentDir ?? await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-integration-"));
  if (!existingAgentDir) {
    await mkdir(join(agentDir, "agents"));
    for (const role of ["scout", "reviewer", "worker"]) await writeFile(join(agentDir, "agents", `${role}.md`), `---\ntools: read, grep, find, ls\n---\nLeaf ${role}`);
  }
  if (configuration !== undefined) await writeFile(join(agentDir, "settings.json"), JSON.stringify(configuration));
  bus.on("test:configuration", query => { query.agentDir = agentDir; });
  const loaded = await loadExtensions([resolve("agent/extensions/simple-subagents/test/fixture.ts"), resolve("agent/extensions/goal-loop/index.ts")], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  const tools = new Map(), commands = new Map();
  for (const extension of loaded.extensions) {
    for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
    for (const [name, command] of extension.commands) commands.set(name, command);
  }
  const sent = [], widgets = new Map(), statuses = new Map(), notices = [], entries = [];
  let idle = true, sessionId = "integration", sendFailure = false;
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(), thinkingLevel: "high",
    model: { provider: "test-provider", id: "test-model" }, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "alpha", id: "model/a", name: "First choice" }, { provider: "beta", id: "model-b", name: "Second choice" }, { provider: "gamma", id: "model-c", name: "Outside scope" }] },
    isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf", getBranch: () => entries },
    ui: { confirm: async () => true, notify: text => notices.push(text), getEditorText: () => "", setWidget: (key, lines) => widgets.set(key, lines), setStatus: (key, text) => statuses.set(key, text) },
  };
  loaded.runtime.sendMessage = (message, options) => { if (sendFailure) throw new Error("dispatch failed"); sent.push({ message, options }); idle = false; };
  loaded.runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` });
  async function emit(name, event = {}) {
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  }
  const call = (name, args = {}, signal) => tools.get(name).execute("call", args, signal, undefined, ctx);
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
  await emit("session_start"); t.after(async () => {
    await emit("session_shutdown");
    if (existingAgentDir) return;
    assert.equal(await realpath(agentDir), agentDir);
    await readdir(agentDir); // Inspect only this test's owned fixture before cleanup.
    await rm(agentDir, { recursive: true });
  });
  return { ctx, bus, agentDir, sent, widgets, statuses, notices, children, call, checkpoint, complete, emit, settle, entries, commands, loaded, panel: args => commands.get("panel").handler(args, ctx), command: args => commands.get("loop").handler(args, ctx), setSession: value => { sessionId = value; }, failNotifications: () => { sendFailure = true; } };
}

const panelModels = [{ model: "alpha/model/a", thinking: "medium" }, { model: "beta/model-b", thinking: "low" }];
const flag = (child, name) => child.launch.args[child.launch.args.indexOf(name) + 1];

test("direct child model/thinking overrides are local, exact and authenticated", { skip }, async t => {
  const h = await harness(t);
  const child = await h.call("subagent_start", { agent: "scout", task: "Explore", model: "alpha/model/a", thinking: "medium" });
  await flush(); assert.equal(flag(h.children()[0], "--provider"), "alpha"); assert.equal(flag(h.children()[0], "--model"), "model/a");
  assert.equal(child.details.selection.thinking, "medium"); assert.equal(h.ctx.model.provider, "test-provider");
  await h.call("subagent_start", { agent: "scout", task: "Defaults" }); await flush();
  assert.equal(flag(h.children()[1], "--provider"), "test-provider"); assert.equal(flag(h.children()[1], "--thinking"), "high");
  await assert.rejects(h.call("subagent_start", { agent: "scout", task: "Reject alias", model: "model/a" }), /unavailable/);
  assert.equal(h.children().length, 2);
});

test("mixed-model panel shares the pool, sends identical briefs and wakes once for comparison", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } });
  await h.call("subagent_start", { agent: "scout", task: "Existing work" }); await flush();
  const run = await h.call("panel_start", { question: "Options and tradeoffs?", models: panelModels }); await flush();
  assert.equal(h.children().length, 1); assert.equal(run.details.effectiveParallelism, 1);
  const queued = await h.call("swarm_results", { id: run.details.swarmId });
  assert.deepEqual(queued.details.results.map(item => item.selection.provider), ["alpha", "beta"]);
  await h.complete(0); await flush();
  assert.equal(h.children().length, 2); assert.equal(flag(h.children()[1], "--model"), "model/a");
  assert.equal(flag(h.children()[1], "--tools"), "read,grep,find,ls");
  await assert.rejects(h.call("panel_compare", { id: run.details.swarmId, comparison: "Premature" }), /still has/);
  await finishMember(h, 1); assert.equal(h.sent.length, 1);
  assert.equal(flag(h.children()[2], "--provider"), "beta"); assert.equal(flag(h.children()[2], "--thinking"), "low");
  assert.equal(h.children()[1].commands.find(command => command.type === "prompt").message, h.children()[2].commands.find(command => command.type === "prompt").message);
  await finishMember(h, 2); assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].message.content, /Question: Options and tradeoffs\?/); assert.match(h.sent[1].message.content, /panel_compare/);
  assert.equal(h.sent[1].message.customType, "simple-swarm-result");
  const before = await h.call("swarm_results", { id: run.details.swarmId });
  await h.call("panel_compare", { id: run.details.swarmId, comparison: "## Disagreement\n\nAlpha favors A; Beta favors B. Measure latency to decide." });
  assert.equal(h.entries.at(-1).customType, "simple-panel-comparison");
  assert.match(h.entries.at(-1).data.text, /Measure latency/);
  const after = await h.call("swarm_results", { id: run.details.swarmId }); assert.deepEqual(after.details, before.details);
});

test("panel validates all models and combined brief before creating a manifest or launching", { skip }, async t => {
  const h = await harness(t);
  for (const models of [[panelModels[0]], [panelModels[0], panelModels[0]], [panelModels[0], { model: "unknown/model" }], [panelModels[0], { model: "beta/model-b", thinking: "infinite" }]]) {
    await assert.rejects(h.call("panel_start", { question: "Explore", models }));
  }
  await assert.rejects(h.call("panel_start", { question: "x".repeat(16000), models: panelModels }), /combined task/);
  assert.equal(h.children().length, 0); assert.equal(h.entries.length, 0);
  assert.equal((await readdir(h.agentDir)).includes("simple-subagents"), false);
  h.ctx.mode = "rpc";
  await assert.rejects(h.call("panel_start", { question: "Explore", models: panelModels }), /parent TUI/);
  await h.panel("view"); assert.match(h.notices.at(-1), /parent TUI/);
});

test("panel command filters scoped display names, preserves thinking and launches only after explicit Start", { skip }, async t => {
  const h = await harness(t);
  const sdk = await import(pathToFileURL(join(root, "dist/index.js")).href); sdk.initTheme("light", false);
  const tuiModule = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const themeModule = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  h.ctx.scopedModels = [{ model: { provider: "alpha", id: "model/a" }, thinkingLevel: "medium" }, { model: { provider: "beta", id: "model-b" }, thinkingLevel: "low" }];
  let picker, opened = 0;
  h.ctx.ui.editor = async () => "Which approach?";
  h.ctx.ui.custom = (factory, options) => {
    assert.notEqual(options?.overlay, true, "result overlays must not open automatically");
    assert.equal(options.blocked.kind, "question"); opened++;
    return new Promise(done => { picker = factory({ terminal: { rows: 16 }, requestRender() {} }, themeModule.theme,
      new tuiModule.KeybindingsManager(tuiModule.TUI_KEYBINDINGS), selected => { picker.dispose(); done(selected); }); picker.focused = true; });
  };
  const screen = () => picker.render(120).join("\n");
  let pending = h.panel(""); await flush(); assert.equal(h.children().length, 0);
  assert.doesNotMatch(screen(), /gamma|Outside scope/);
  picker.handleInput("First"); assert.match(screen(), /First choice/); assert.doesNotMatch(screen(), /Second choice/);
  picker.handleInput("\r"); assert.equal(h.children().length, 0);
  for (let i = 0; i < 5; i++) picker.handleInput("\x7f");
  picker.handleInput("Second"); assert.match(screen(), /Second choice/); picker.handleInput("\r");
  assert.equal(h.children().length, 0); picker.handleInput("\t"); picker.handleInput("\r");
  await pending; await flush(); assert.equal(h.children().length, 2); assert.equal(opened, 1);
  assert.equal(flag(h.children()[0], "--thinking"), "medium"); assert.equal(flag(h.children()[1], "--thinking"), "low");
  pending = h.panel("Cancelled question"); await flush(); picker.handleInput("\x1b"); await pending;
  assert.equal(h.children().length, 2); assert.equal(opened, 2);
  await h.panel("stop"); assert.equal(h.children().every(child => child.closed), true);
});

test("panel dispatch pins the provider bootstrap per member without persisting environment", { skip }, async t => {
  const h = await harness(t);
  h.ctx.modelRegistry.getAvailable = () => [{ provider: "cursor", id: "auto" }, { provider: "alpha", id: "model/a" }];
  const run = await h.call("panel_start", { question: "Explore", models: [{ model: "cursor/auto" }, panelModels[0]] }); await flush();
  assert.deepEqual(h.children().map(child => child.launch.env.PI_SIMPLE_SUBAGENT_PROVIDER), ["cursor", "alpha"]);
  assert.equal(h.children()[0].launch.env.PI_CURSOR_NATIVE_TOOLS, process.env.PI_CURSOR_NATIVE_TOOLS, "provider policy is initialized in the isolated child");
  const record = await readFile(join(h.agentDir, "simple-subagents/runs", `${run.details.swarmId}.json`), "utf8");
  assert.equal(record.includes("PI_SIMPLE_SUBAGENT_PROVIDER"), false); assert.equal(record.includes("CURSOR_API_KEY"), false);
});

test("panel viewer refresh and reopen are read-only, comparison follows the branch, truncation/failure stay visible", { skip }, async t => {
  const h = await harness(t);
  const sdk = await import(pathToFileURL(join(root, "dist/index.js")).href); sdk.initTheme("light", false);
  const tuiModule = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const themeModule = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  let viewer, config;
  h.ctx.ui.custom = (factory, options) => { config = options; return new Promise(done => { viewer = factory({ terminal: { rows: 18 }, requestRender() {} }, themeModule.theme, new tuiModule.KeybindingsManager(tuiModule.TUI_KEYBINDINGS), () => { viewer.dispose(); done(); }); }); };
  const run = await h.call("panel_start", { question: "Explore options", models: panelModels }); await flush();
  h.children()[0].event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(17000) }], stopReason: "stop" } });
  h.children()[0].event({ type: "agent_settled" }); await flush();
  let opening = h.panel("view"); await flush(); assert.equal(config.overlay, true); assert.equal(config.overlayOptions.width, "100%");
  viewer.handleInput("\x1b[C"); assert.match(viewer.render(160).join("\n"), /[Tt]runcat/);
  h.children()[1].event({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" } });
  h.children()[1].event({ type: "agent_settled" }); await flush();
  viewer.handleInput("r"); viewer.handleInput("\x1b[C"); assert.match(viewer.render(160).join("\n"), /provider unavailable/);
  viewer.handleInput("\x1b"); await opening;
  await h.call("panel_compare", { id: run.details.swarmId, comparison: "Alpha was truncated; Beta failed. No reliable consensus." });
  opening = h.panel(`view ${run.details.swarmId}`); await flush(); assert.match(viewer.render(160).join("\n"), /No reliable consensus/);
  viewer.handleInput("\x1b"); await opening;
  h.entries.pop(); // Navigating away from a saved comparison must not leak it back into this branch.
  opening = h.panel("view"); await flush(); assert.doesNotMatch(viewer.render(160).join("\n"), /No reliable consensus/);
  viewer.handleInput("\x1b"); await opening;
  assert.equal(h.children().length, 2); assert.equal(h.sent.length, 1);
});

test("panel resumes only queued models with pinned selections after reload; viewer works without restarting", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } });
  const run = await h.call("panel_start", { question: "Explore", models: panelModels }); await flush();
  await h.call("swarm_pause", { id: run.details.swarmId }); await finishMember(h, 0); await h.emit("session_shutdown");
  const fresh = await harness(t, undefined, h.agentDir); fresh.ctx.model = { provider: "new-parent", id: "other" };
  const data = await fresh.call("swarm_results", { id: run.details.swarmId }); assert.equal(data.details.results[1].selection.provider, "beta");
  assert.equal(fresh.children().length, 0);
  await fresh.call("swarm_resume", { id: run.details.swarmId }); await flush();
  assert.equal(flag(fresh.children()[0], "--provider"), "beta"); assert.equal(flag(fresh.children()[0], "--thinking"), "low");
  await finishMember(fresh, 0); await fresh.emit("session_shutdown");
});

test("panel viewing refuses active loops without opening UI, revoking queued work or approving a round", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } }); await h.command("--manual explore");
  let opened = 0; h.ctx.ui.custom = async () => { opened++; };
  const run = await h.call("panel_start", { question: "Explore", models: panelModels }); await flush();
  await h.checkpoint("waiting"); await h.settle();
  await h.panel("view");
  assert.equal(opened, 0); assert.match(h.notices.at(-1), /unavailable while a goal loop is active/);
  assert.match(h.statuses.get("goal-loop"), /waiting for 1/);
  assert.equal((await h.call("swarm_status", { id: run.details.swarmId })).details.armed, true);
  assert.equal(h.children()[0].closed, false);
  await finishMember(h, 0); assert.equal(h.children().length, 2, "view refusal must not revoke queued dispatch");
  await finishMember(h, 1);
  await h.emit("message_start", { message: { role: "custom", ...h.sent.at(-1).message } });
  await h.checkpoint("continue"); await h.settle();
  assert.match(h.statuses.get("goal-loop"), /approval required/);
  await h.panel("view"); assert.equal(opened, 0); assert.match(h.statuses.get("goal-loop"), /approval required/);
  await h.command("stop"); await h.panel("view"); assert.equal(opened, 1);
  assert.equal(h.children().length, 2);
});

test("panel shares whole-run loop ownership and abort during preparation authorizes nothing", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } }); await h.command("--manual explore");
  const run = await h.call("panel_start", { question: "Explore", models: panelModels }); await flush();
  await h.checkpoint("waiting"); await h.settle(); assert.match(h.statuses.get("goal-loop"), /waiting for 1/);
  await h.command("stop"); await finishMember(h, 0); assert.equal(h.children().length, 1);
  assert.equal((await h.call("swarm_status", { id: run.details.swarmId })).details.counts.queued, 1);
  const other = await harness(t); const controller = new AbortController();
  const starting = other.call("panel_start", { question: "Explore", models: panelModels }, controller.signal); controller.abort();
  await assert.rejects(starting, /abort/i); await flush(); assert.equal(other.children().length, 0); assert.equal(other.entries.length, 0);
  assert.equal((await readdir(other.agentDir)).includes("simple-subagents"), false);
});

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

test("parent opts scouts and reviewers into shell access per direct launch, with unchanged defaults", { skip }, async t => {
  const h = await harness(t);
  for (const [index, agent, additionalTools] of [[0, "scout", undefined], [1, "scout", ["bash"]], [2, "reviewer", ["bash", "read", "bash"]]]) {
    const child = await h.call("subagent_start", { agent, task: "Read-only PR review using git diff, git show and gh; do not modify or post anything.", additionalTools });
    await flush();
    const launch = h.children()[index].launch;
    const expected = ["read", "grep", "find", "ls", ...(additionalTools ? ["bash"] : [])];
    assert.deepEqual(child.details.tools, expected);
    assert.equal(launch.args[launch.args.indexOf("--tools") + 1], expected.join(","));
    assert.match(launch.env.PI_SIMPLE_SUBAGENT_PROMPT, new RegExp(agent));
    assert.ok(launch.args.includes("--no-approve")); assert.ok(launch.args.includes("--no-extensions"));
  }
  const defaults = await h.call("subagent_start", { agent: "scout", task: "Read source only" });
  assert.equal(defaults.details.tools.includes("bash"), false);
});

for (const tool of ["subagent_start", "swarm_start"]) test(`${tool} refuses invalid extra capabilities before any launch or manifest write`, { skip }, async t => {
  const h = await harness(t);
  for (const additionalTools of [["job_start"], ["gh"], ["bash,write"], ["--approve"]]) {
    await assert.rejects(h.call(tool, { agent: "scout", task: "Inspect", tasks: [{ id: "pr", task: "Inspect" }], additionalTools }), /additionalTools/);
  }
  await flush(); assert.equal(h.children().length, 0);
  assert.equal((await readdir(h.agentDir)).includes("simple-subagents"), false);
});

test("swarm pins selected tools across queued dispatch and fresh-runtime resume without changing the role file", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } });
  const run = await h.call("swarm_start", { agent: "reviewer", additionalTools: ["bash"], tasks: [{ id: "a", task: "Review first PR" }, { id: "b", task: "Review second PR" }] });
  await flush();
  const expected = ["read", "grep", "find", "ls", "bash"];
  assert.deepEqual(run.details.tools, expected);
  assert.equal(h.children()[0].launch.args[h.children()[0].launch.args.indexOf("--tools") + 1], expected.join(","));
  await h.call("swarm_pause", { id: run.details.swarmId });
  await finishMember(h, 0); await h.emit("session_shutdown");
  const record = JSON.parse(await readFile(join(h.agentDir, "simple-subagents", "runs", `${run.details.swarmId}.json`), "utf8"));
  assert.deepEqual(record.profile.tools, expected);
  assert.match(await readFile(join(h.agentDir, "agents", "reviewer.md"), "utf8"), /tools: read, grep, find, ls\n/);
  // Later role edits must not broaden or remove this recorded launch's capabilities.
  await writeFile(join(h.agentDir, "agents", "reviewer.md"), "---\ntools: read, write\n---\nChanged role");
  const fresh = await harness(t, undefined, h.agentDir);
  const resumed = await fresh.call("swarm_resume", { id: run.details.swarmId }); await flush();
  assert.deepEqual(resumed.details.tools, expected);
  assert.equal(fresh.children().length, 1);
  const launch = fresh.children()[0].launch;
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], expected.join(","));
  await finishMember(fresh, 0); await fresh.emit("session_shutdown");
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

const batch = count => ({ agent: "scout", tasks: Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, task: `Inspect scope ${i}` })) });
async function finishMember(h, index) {
  h.children()[index].event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Findings ${index}; checks not run` }], stopReason: "stop" } });
  h.children()[index].event({ type: "agent_settled" }); await flush();
}
const deliver = (h, message) => h.emit("message_start", { message: { role: "custom", ...message } });

test("real loader: one whole-run dependency spans queued, active and completed-but-unconsumed tasks", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 2 } });
  await h.command("--manual goal"); const run = await h.call("swarm_start", batch(7)); await flush();
  assert.equal(run.details.effectiveParallelism, 2);
  await h.checkpoint("waiting"); await h.settle(); assert.match(h.statuses.get("goal-loop"), /waiting for 1/);
  for (let i = 0; i < 7; i++) {
    await finishMember(h, i);
    if (i < 6) assert.equal(h.sent.length, 1, "member exits must not wake parent");
  }
  assert.equal(h.sent.length, 2); assert.equal(h.sent[1].message.customType, "simple-swarm-result");
  assert.equal(h.sent[1].message.details.round, 1); assert.equal(h.sent[1].message.details.final, true);
  await assert.rejects(h.checkpoint("continue"), /No working|Consume/);
  await deliver(h, h.sent[1].message); await h.checkpoint("continue"); await h.settle();
  assert.match(h.statuses.get("goal-loop"), /Loop 1\/5.*approval required/);
  await assert.rejects(h.call("swarm_start", batch(1)), /approved working/);
  await h.command("resume"); assert.match(h.statuses.get("goal-loop"), /Loop 2\/5/);
  await deliver(h, h.sent[1].message); assert.equal(h.statuses.get("goal-loop"), undefined, "duplicate old delivery is not authority");
});

test("pause attention is consumed once but never releases a queued run dependency or approves a manual round", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } }); await h.command("--manual goal");
  const run = await h.call("swarm_start", batch(3)); await flush();
  await h.call("swarm_pause", { id: run.details.swarmId }); await h.checkpoint("waiting"); await h.settle();
  await finishMember(h, 0); const notice = h.sent.at(-1).message;
  assert.equal(notice.details.final, false); await deliver(h, notice);
  await assert.rejects(h.checkpoint("continue"), /Consume/);
  await h.call("swarm_resume", { id: run.details.swarmId }); await flush();
  await h.checkpoint("waiting"); await h.settle(); await finishMember(h, 1); await finishMember(h, 2);
  const final = h.sent.at(-1).message; assert.equal(final.details.final, true); await deliver(h, final);
  await h.checkpoint("continue"); await h.settle(); assert.match(h.statuses.get("goal-loop"), /Loop 1\/5.*approval required/);
});

for (const cause of ["stop", "expiry", "settled-abort", "context-signal", "terminal-checkpoint", "two-failures", "missing-checkpoint"]) {
  test(`real loader: ${cause} revokes original queued-run authority but lets active children finish`, { skip }, async t => {
    const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } });
    if (cause === "expiry") t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
    const controller = new AbortController(); if (cause === "context-signal") h.ctx.signal = controller.signal;
    await h.command("goal"); const run = await h.call("swarm_start", batch(3)); await flush();
    if (cause !== "missing-checkpoint") { await h.checkpoint("waiting"); await h.settle(); }
    if (cause === "stop") await h.command("stop");
    if (cause === "expiry") t.mock.timers.tick(30 * 60_000);
    if (cause === "settled-abort") await h.emit("agent_settled", { aborted: true });
    if (cause === "context-signal") controller.abort();
    if (cause === "terminal-checkpoint") { await h.emit("input", { source: "interactive" }); await h.checkpoint("blocked"); }
    if (cause === "two-failures") {
      await h.emit("input", { source: "interactive" });
      await h.emit("tool_execution_end", { toolName: "read", isError: true });
      await h.emit("tool_execution_end", { toolName: "read", isError: true });
    }
    if (cause === "missing-checkpoint") await h.settle();
    assert.equal(h.children()[0].closed, false);
    await finishMember(h, 0); assert.equal(h.children().length, 1);
    const status = await h.call("swarm_status", { id: run.details.swarmId });
    assert.equal(status.details.counts.queued, 2); assert.equal(status.details.armed, false);
    if (cause !== "context-signal") await assert.rejects(h.call("swarm_resume", { id: run.details.swarmId }), /original loop|working loop|standalone/);
  });
}

test("parent abort during asynchronous preparation leaves no run manifest or launch", { skip }, async t => {
  const h = await harness(t); const controller = new AbortController(); h.ctx.signal = controller.signal;
  const starting = h.call("swarm_start", batch(3)); controller.abort();
  await assert.rejects(starting, /abort/i); await flush(); assert.equal(h.children().length, 0);
  assert.equal((await readdir(h.agentDir)).includes("simple-subagents"), false);
});

for (const tool of ["swarm_start", "subagent_start"]) {
  for (const cause of ["stop", "expiry", "replacement-loop"]) test(`real loader: ${tool} retains original authority during async preparation (${cause})`, { skip }, async t => {
    const h = await harness(t);
    if (cause === "expiry") t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
    await h.command("goal");
    const queries = [];
    h.bus.on("simple-subagents:start-query:v1", query => queries.push({ ...query }));
    // Profile/manifest reads yield to filesystem I/O; stop before those reads can finish.
    const starting = h.call(tool, tool === "swarm_start" ? batch(2) : { agent: "scout", task: "Inspect bounded scope" });
    const original = queries[0];
    if (cause === "expiry") t.mock.timers.tick(30 * 60_000);
    else await h.command("stop");
    if (cause === "replacement-loop") { await h.settle(); await h.command("new approved goal"); }
    await assert.rejects(starting, /Original delegation authority|approved working/);
    assert.ok(original?.loopId, "original loop authority must be captured before preparation yields");
    await flush(); assert.equal(h.children().length, 0);
    assert.equal((await readdir(h.agentDir)).includes("simple-subagents"), false);
    await h.command("stop");
    const standalone = await h.call(tool, tool === "swarm_start" ? batch(1) : { agent: "scout", task: "Genuinely new standalone request" });
    await flush(); assert.equal(h.children().length, 1);
    if (tool === "subagent_start") assert.equal(standalone.details.loopId, undefined);
  });
}

test("shutdown record-save failure cannot skip survivor marker, other runs, warnings or lifecycle clearing", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 2 } });
  const a = await h.call("swarm_start", { ...batch(2), maxParallel: 1 });
  const b = await h.call("swarm_start", { ...batch(2), maxParallel: 1 }); await flush();
  h.bus.emit("test:close-failure", "fixture writer close unconfirmed");
  const record = join(h.agentDir, "simple-subagents", "runs", `${a.details.swarmId}.json`);
  // Block just this run's atomic replacement, not the separate survivor marker.
  await rename(record, `${record}.before-failure`); await mkdir(record);
  await h.emit("session_shutdown");
  assert.equal(h.widgets.get("simple-subagents"), undefined);
  assert.ok(h.notices.some(message => /shutdown failed.*not durable/.test(message)));
  assert.ok(h.notices.some(message => /termination unconfirmed/.test(message)));
  assert.ok((await readdir(join(h.agentDir, "simple-subagents", "runs"))).includes("unconfirmed-teardown.json"));
  const fresh = await harness(t, undefined, h.agentDir);
  await assert.rejects(fresh.call("subagent_start", { agent: "scout", task: "Must not launch" }), /Unconfirmed child teardown/);
  await assert.rejects(fresh.call("swarm_start", batch(1)), /Unconfirmed child teardown/);
  assert.equal(fresh.children().length, 0);
  assert.equal((await fresh.call("swarm_status", { id: b.details.swarmId })).details.counts.stopping, 1);
  await h.emit("session_start");
  assert.match((await h.call("subagent_status")).content[0].text, /No children/);
  await assert.rejects(h.call("subagent_start", { agent: "scout", task: "Still blocked" }), /termination unconfirmed/);
});

test("failed survivor-marker storage is reported as non-durable while the surviving runtime stays blocked", { skip }, async t => {
  const h = await harness(t);
  await h.call("subagent_start", { agent: "scout", task: "Fake writer" }); await flush();
  h.bus.emit("test:close-failure", "fixture writer close unconfirmed");
  await mkdir(join(h.agentDir, "simple-subagents", "runs", "unconfirmed-teardown.json"), { recursive: true });
  await h.emit("session_shutdown");
  assert.ok(h.notices.some(message => /Could not persist.*not durable across a process restart/.test(message)));
  assert.equal(h.widgets.get("simple-subagents"), undefined);
  await h.emit("session_start");
  await assert.rejects(h.call("subagent_start", { agent: "scout", task: "Must not launch" }), /termination unconfirmed/);
  await assert.rejects(h.call("swarm_start", batch(1)), /termination unconfirmed/);
  assert.equal(h.children().length, 1);
});

test("owned-run dispatch queries default denied and require exact registered session/loop/round", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 1 } }); await h.command("--manual goal");
  const run = await h.call("swarm_start", batch(2)); await flush();
  const start = { sessionId: "integration", allowed: true }; h.bus.emit("simple-subagents:start-query:v1", start);
  const valid = { sessionId: "integration", loopId: start.loopId, round: start.round, id: run.details.swarmId, allowed: false };
  await h.checkpoint("waiting"); await h.settle();
  h.bus.emit("simple-subagents:run-query:v1", valid); assert.equal(valid.allowed, true);
  for (const patch of [{ sessionId: "foreign" }, { loopId: "old" }, { round: 2 }, { id: "unregistered" }]) {
    const query = { ...valid, ...patch, allowed: true }; h.bus.emit("simple-subagents:run-query:v1", query); assert.equal(query.allowed, false);
  }
  await h.command("stop"); const stopped = { ...valid, allowed: true }; h.bus.emit("simple-subagents:run-query:v1", stopped); assert.equal(stopped.allowed, false);
});

test("notification exceptions retain outcomes, never retry a wake and never make result reads launch", { skip }, async t => {
  const h = await harness(t); const run = await h.call("swarm_start", batch(1)); await flush(); h.failNotifications();
  await finishMember(h, 0); assert.equal(h.sent.length, 0); assert.match(h.notices.at(-1), /notification failed/);
  const page = await h.call("swarm_results", { id: run.details.swarmId });
  assert.equal(page.details.results[0].state, "succeeded");
  await h.call("swarm_status", { id: run.details.swarmId }); await flush(); assert.equal(h.children().length, 1); assert.equal(h.sent.length, 0);
});

test("user cap ignores Pi's merged/project override and malformed user configuration blocks direct and batch starts", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 2 } });
  const run = await h.call("swarm_start", { ...batch(8), maxParallel: 100 }); await flush();
  assert.equal(run.details.effectiveParallelism, 2); assert.equal(h.children().length, 2);
  const bad = await harness(t, { simpleSubagents: { maxConcurrency: "unlimited" } });
  await assert.rejects(bad.call("subagent_start", { agent: "scout", task: "Inspect" }), /maxConcurrency/);
  await assert.rejects(bad.call("swarm_start", batch(2)), /maxConcurrency/); assert.equal(bad.children().length, 0);
});

test("a separately authorized reviewer swarm reuses the pool with no automatic nested review or acceptance", { skip }, async t => {
  const h = await harness(t, { simpleSubagents: { maxConcurrency: 2 } });
  const work = await h.call("swarm_start", batch(2));
  const review = await h.call("swarm_start", { ...batch(1), agent: "reviewer" }); await flush();
  assert.equal(h.children().length, 2);
  assert.equal((await h.call("swarm_status", { id: review.details.swarmId })).details.counts.queued, 1);
  await finishMember(h, 0); assert.equal(h.children().length, 3);
  assert.match(h.children()[2].launch.env.PI_SIMPLE_SUBAGENT_PROMPT, /reviewer/);
  await finishMember(h, 1); await finishMember(h, 2);
  assert.equal(h.children().length, 3); assert.equal(h.sent.length, 2);
  for (const id of [work.details.swarmId, review.details.swarmId]) {
    const page = await h.call("swarm_results", { id });
    assert.equal(page.details.results[0].state, "succeeded"); assert.equal(page.details.results[0].accepted, undefined);
  }
});
