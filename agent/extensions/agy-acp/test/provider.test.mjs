import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR to the installed pi-coding-agent package.";
let modules;
async function load() {
  return modules ??= (async () => {
    const ai = join(root, "node_modules/@earendil-works/pi-ai/dist/index.js");
    const { createJiti } = await import(pathToFileURL(join(root, "node_modules/jiti/lib/jiti.mjs")).href);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@earendil-works/pi-ai": ai } });
    return {
      ...await import(pathToFileURL(ai).href),
      ...await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/utils/retry.js")).href),
      ...await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-agent-core/dist/index.js")).href),
      ...await jiti.import(fileURLToPath(new URL("../runtime.ts", import.meta.url))),
      ...await jiti.import(fileURLToPath(new URL("../turn.ts", import.meta.url))),
      ...await jiti.import(fileURLToPath(new URL("../agy-models.ts", import.meta.url))),
      register: await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)), { default: true }),
    };
  })();
}
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const tool = name => ({ name, description: `Tool ${name}`, parameters: { type: "object", properties: { example: { type: "number" } } } });
const textOf = msg => msg.content.filter(block => block.type === "text").map(block => block.text).join("");
const testCwd = fileURLToPath(new URL("..", import.meta.url));
async function setup(t, select = async () => "Deny", timeouts, fixtureArgs = []) {
  const m = await load();
  const statuses = [];
  const windows = [];
  const wakeups = [];
  const ctx = { cwd: testCwd, hasUI: true, ui: { select, notify() {}, setStatus: (_key, value) => statuses.push(value) } };
  const runtime = new m.AgyRuntime(
    () => ({ command: process.execPath, args: [fileURLToPath(new URL("./hybrid-agent.mjs", import.meta.url)), ...fixtureArgs] }),
    {
      ...timeouts,
      onContextWindow: (modelId, size) => windows.push({ modelId, size }),
      onWakeup: (id) => wakeups.push(id),
    },
  );
  t.after(() => runtime.reset());
  const opts = { signal: AbortSignal.timeout(5_000) };
  const models = await runtime.discover(ctx.cwd, opts.signal);
  assert.deepEqual(models.map(model => model.id), ["gemini-fixture", "gemini-other"]);
  function start(messages, extraOpts = {}, tools = [], model = models[0]) {
    const stream = m.createAssistantMessageEventStream();
    const transcript = m.normalizeContext({ messages, tools });
    const allowed = m.selectedTools(transcript, new Set(["fixture_tool", "read", "inactive_tool"]), ["fixture_tool", "read", "other_tool"]);
    const step = runtime.run(model, transcript, { ...opts, ...extraOpts }, ctx, allowed, new m.PiOutput(stream, model));
    return { stream, finish: async () => { await step; return stream.result(); } };
  }
  return { runtime, start, statuses, models, windows, wakeups, m };
}

test("one ACP turn combines native activity with a real Pi tool call and preserves the warm session", { skip }, async t => {
  const { start, runtime, statuses } = await setup(t);
  const tools = ["fixture_tool", "read", "inactive_tool", "other_tool"].map(tool);
  const request = user("Both");
  const first = start([request], {}, tools);
  const types = [];
  for await (const event of first.stream) types.push(event.type);
  const handoff = await first.finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  assert.deepEqual(types, ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_end", "done"]);
  assert.ok(statuses.includes("agy · Read file with native harness"));
  const [call] = handoff.content.filter(block => block.type === "toolCall");
  assert.equal(call.name, "fixture_tool");
  assert.deepEqual(call.arguments, { example: 7 });
  const result = { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: false, content: [{ type: "text", text: "Pi ran it" }], timestamp: Date.now() };
  const completed = await start([request, handoff, result], {}, tools).finish();
  assert.equal(completed.stopReason, "stop", completed.errorMessage);
  assert.equal(textOf(completed), "After Pi tool: Pi ran it");
  assert.equal(completed.usage.totalTokens, 17);
  await runtime.settle();
  assert.equal(runtime.running, true);
  const next = await start([request, handoff, result, completed, user("Next")], { reasoning: "high" }, tools).finish();
  assert.equal(next.stopReason, "stop", next.errorMessage);
  assert.equal(textOf(next), "gemini-fixture high 2 1 Next");
  const off = await start([request, handoff, result, completed, user("Next"), next, user("Default")], {}, tools).finish();
  assert.equal(textOf(off), "gemini-fixture low 3 1 Default");
});

test("steering during a bridged tool starts a new ACP prompt instead of losing the user's input", { skip }, async t => {
  const { start } = await setup(t);
  const tools = [tool("fixture_tool")];
  const request = user("Both");
  const handoff = await start([request], {}, tools).finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  const call = handoff.content.find(block => block.type === "toolCall");
  const result = { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: false, content: [{ type: "text", text: "Pi ran it" }], timestamp: Date.now() };
  const next = await start([request, handoff, result, user("Take a different approach")], {}, tools).finish();
  assert.equal(next.stopReason, "stop", next.errorMessage);
  assert.match(textOf(next), /^gemini-fixture low 1 \d+ Take a different approach$/);
});

test("abort closes an agy process parked on a Pi tool without waiting for Pi to return the result", { skip }, async t => {
  const { start } = await setup(t);
  const controller = new AbortController();
  const handoff = await start([user("Parked")], { signal: controller.signal }, [tool("fixture_tool")]).finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  const pid = Number(textOf(handoff).match(/fixture pid (\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(process.kill(pid, 0), true);
  controller.abort();
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await delay(25);
  }
  assert.fail("Fixture ACP process survived while waiting for an abandoned Pi tool.");
});

test("Pi's installed tool loop can block a bridged call before execution", { skip }, async t => {
  const m = await load();
  const runtime = new m.AgyRuntime(() => ({ command: process.execPath, args: [fileURLToPath(new URL("./hybrid-agent.mjs", import.meta.url))] }));
  t.after(() => runtime.reset());
  const ctx = { cwd: testCwd, hasUI: true, ui: { setStatus() {} } };
  const [model] = await runtime.discover(ctx.cwd, AbortSignal.timeout(5_000));
  const exposed = { ...tool("fixture_tool"), label: "Fixture Tool", execute: async () => assert.fail("Pi should block this before execute") };
  let inspected;
  const agent = new m.Agent({
    initialState: { model, tools: [exposed] },
    beforeToolCall: async ({ toolCall }) => {
      inspected = toolCall;
      return { block: true, reason: "Denied by the Pi hook" };
    },
    streamFn(model, transcript, options) {
      const stream = m.createAssistantMessageEventStream();
      const tools = m.selectedTools(transcript, new Set(["fixture_tool"]), ["fixture_tool"]);
      void runtime.run(model, transcript, { ...options, timeoutMs: 5_000 }, ctx, tools, new m.PiOutput(stream, model));
      return stream;
    },
  });
  await agent.prompt("Both");
  const reply = agent.state.messages.at(-1);
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.equal(inspected?.name, "fixture_tool");
  assert.match(textOf(reply), /After Pi tool: .*Denied by the Pi hook/);
});

test("Pi approves ACP permissions once, and rejects when the user declines", { skip }, async t => {
  let answer = "Allow once";
  let dialogs = 0;
  const { start } = await setup(t, async (title, choices) => {
    assert.match(title, /Antigravity tool.*:[\s\S]*inspect/);
    assert.deepEqual(choices, ["Deny", "Allow once"]);
    dialogs++;
    return answer;
  });
  const request = user("Permission");
  const allowed = await start([request]).finish();
  assert.equal(textOf(allowed), "allow");
  answer = "Deny";
  const rejected = await start([request, allowed, user("Permission")]).finish();
  assert.equal(textOf(rejected), "deny");
  answer = "Allow once";
  for (const prompt of ["Permission without input", "Permission with long input"]) {
    const undisclosed = await start([user(prompt)]).finish();
    assert.equal(textOf(undisclosed), "deny");
  }
  assert.equal(dialogs, 2);
});

test("aborting a streaming ACP prompt discards the binding", { skip }, async t => {
  const { start, runtime } = await setup(t);
  const controller = new AbortController();
  const turn = start([user("Cancel")], { signal: controller.signal });
  for await (const event of turn.stream) if (event.type === "text_delta") controller.abort();
  const result = await turn.finish();
  assert.equal(result.stopReason, "aborted", result.errorMessage);
  assert.equal(runtime.running, false);
  const next = await start([user("New")]).finish();
  assert.equal(textOf(next), "gemini-fixture low 1 1 New");
});

test("provider displays a model without spawning, and refuses headless or foreign-session native runs", { skip }, async () => {
  const m = await load();
  const handlers = new Map();
  let provider;
  m.register({ registerProvider: p => { provider = p; }, on: (event, cb) => handlers.set(event, cb), registerCommand() {} });
  const [model] = provider.getModels();
  assert.equal(model.id, "gemini-3.8-flash");
  const opts = { sessionId: "mine" };
  const transcript = m.normalizeContext({ messages: [user("fixture only")] });
  const ctx = { sessionManager: { getSessionId: () => "mine" }, isProjectTrusted: () => true };
  for (const [mode, sessionId] of [["rpc", "mine"], ["tui", "foreign"]]) {
    handlers.get("session_start")({}, { ...ctx, mode });
    assert.match((await provider.streamSimple(model, transcript, { ...opts, sessionId }).result()).errorMessage, /current interactive Pi session/);
  }
});

test("default turn timers survive >30m active streaming, pause on host waits, and cap idle or 2h turns", { skip }, async t => {
  const m = await load();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const minute = 60_000;
  // Pass Pi's default 5m httpIdleTimeoutMs explicitly; keep NativeTurn's production turnTimeoutMs default.
  const turn = new m.NativeTurn({ idleTimeoutMs: 5 * minute });
  t.after(() => turn.stop(new Error("cleanup")));
  for (let elapsed = 0; elapsed < 40; elapsed += 4) {
    t.mock.timers.tick(4 * minute);
    turn.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    assert.equal(turn.result, undefined, `active streaming must survive past ${elapsed + 4} minutes`);
  }
  turn.beginPermission();
  t.mock.timers.tick(10 * minute);
  assert.equal(turn.result, undefined, "user permission review must pause the idle watchdog");
  turn.endPermission();

  const callSignal = new AbortController().signal;
  void turn.call("fixture_tool", {}, callSignal);
  const [dispatched] = turn.takeCalls();
  t.mock.timers.tick(10 * minute);
  assert.equal(turn.result, undefined, "parked Pi tool execution must pause the idle watchdog");
  turn.deliver([{ role: "toolResult", toolName: dispatched.name, toolCallId: dispatched.id, isError: false, content: [{ type: "text", text: "ok" }], timestamp: 0 }], new Set(["fixture_tool"]));

  t.mock.timers.tick(5 * minute - 1);
  assert.equal(turn.result, undefined);
  t.mock.timers.tick(1);
  assert.equal(turn.result?.error?.code, "ACP_IDLE");

  const longTurn = new m.NativeTurn({ idleTimeoutMs: 5 * minute });
  t.after(() => longTurn.stop(new Error("cleanup")));
  for (let elapsed = 0; elapsed < 116; elapsed += 4) {
    t.mock.timers.tick(4 * minute);
    longTurn.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "still going" } });
    assert.equal(longTurn.result, undefined);
  }
  t.mock.timers.tick(4 * minute);
  assert.equal(longTurn.result?.error?.code, "ACP_DEADLINE");
});

test("idle watchdog resets on ACP updates, pauses on host waits, and fails non-retryably on silence", { skip }, async t => {
  const m = await load();
  const { start, runtime } = await setup(t, async () => {
    await delay(95);
    return "Allow once";
  });
  const active = await start([user("Active stream")], { timeoutMs: 65 }).finish();
  assert.equal(active.stopReason, "stop", active.errorMessage);
  assert.equal(textOf(active), "streamed");

  const approved = await start([user("Permission")], { timeoutMs: 60 }).finish();
  assert.equal(approved.stopReason, "stop", approved.errorMessage);
  assert.equal(textOf(approved), "allow");

  const tools = [tool("fixture_tool")];
  const req = user("Both");
  const handoff = await start([req], { timeoutMs: 60 }, tools).finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  await delay(95);
  const [call] = handoff.content.filter(block => block.type === "toolCall");
  const result = { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: false, content: [{ type: "text", text: "late tool ok" }], timestamp: Date.now() };
  const resumed = await start([req, handoff, result], { timeoutMs: 60 }, tools).finish();
  assert.equal(resumed.stopReason, "stop", resumed.errorMessage);
  assert.equal(textOf(resumed), "After Pi tool: late tool ok");

  const stalled = await start([user("Stall")], { timeoutMs: 60 }).finish();
  assert.equal(stalled.stopReason, "error");
  assert.equal(textOf(stalled), "partial ");
  assert.equal(stalled.errorMessage, "Antigravity produced no activity within the idle window. Check the workspace before resending the prompt.");
  assert.equal(m.isRetryableAssistantError(stalled), false);
  assert.equal(runtime.running, false);
});

test("overall turn ceiling stops endlessly chattering turns without triggering Pi auto-retry", { skip }, async t => {
  const m = await load();
  const { start, runtime } = await setup(t, undefined, { turnTimeoutMs: 90 });
  const capped = await start([user("Chatter")], { timeoutMs: 500 }).finish();
  assert.equal(capped.stopReason, "error");
  assert.equal(textOf(capped), "chattering ");
  assert.equal(capped.errorMessage, "Antigravity exceeded the turn deadline. Check the workspace before resending the prompt.");
  assert.equal(m.isRetryableAssistantError(capped), false);
  assert.equal(runtime.running, false);
});

test("bridged Pi tools work when agentCapabilities omits mcpCapabilities, and fail on explicit http: false", { skip }, async t => {
  const tools = [tool("fixture_tool")];
  const { start: startOmitted } = await setup(t, undefined, undefined, ["--mcp-caps=omit"]);
  const request = user("Both");
  const handoff = await startOmitted([request], {}, tools).finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  const [call] = handoff.content.filter(block => block.type === "toolCall");
  const result = { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: false, content: [{ type: "text", text: "ok" }], timestamp: Date.now() };
  const completed = await startOmitted([request, handoff, result], {}, tools).finish();
  assert.equal(completed.stopReason, "stop", completed.errorMessage);
  assert.equal(textOf(completed), "After Pi tool: ok");

  const { start: startDisabled } = await setup(t, undefined, undefined, ["--mcp-caps=false"]);
  const rejected = await startDisabled([user("Both")], {}, tools).finish();
  assert.equal(rejected.stopReason, "error");
  assert.match(rejected.errorMessage, /does not support HTTP MCP/);
});

test("bridged tool allowlist defaults to codemode and honors explicit PI_AGY_ACP_TOOLS overrides", { skip }, async () => {
  const m = await load();
  assert.deepEqual([...m.parseBridgedTools(undefined)], ["codemode"]);
  assert.deepEqual([...m.parseBridgedTools("")], []);
  assert.deepEqual([...m.parseBridgedTools("  ,  ")], []);
  assert.deepEqual([...m.parseBridgedTools("codemode, job_status")], ["codemode", "job_status"]);
});

test("models default to non-zero context windows and sync live usage_update.size without refresh", { skip }, async t => {
  const { start, models, windows, m } = await setup(t);
  assert.equal(m.fallbackModels[0].contextWindow, 1_048_576);
  assert.equal(models[0].contextWindow, 1_048_576);
  assert.equal(m.defaultContextWindow("other-model"), 200_000);

  const reply = await start([user("Window update")]).finish();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.equal(models[0].contextWindow, 524_288);
  assert.ok(windows.some(entry => entry.modelId === "gemini-fixture" && entry.size === 524_288));
});

test("post-end_turn background wakeup is adopted into a Pi turn and preserves the warm ACP session", { skip }, async t => {
  const { start, runtime, wakeups, m } = await setup(t, undefined, { wakeupSettleMs: 60 });
  const req1 = user("Bg wakeup");
  const turn1 = await start([req1]).finish();
  assert.equal(turn1.stopReason, "stop", turn1.errorMessage);
  assert.equal(textOf(turn1), "tests running");

  const deadline = Date.now() + 2_000;
  while (!wakeups.length && Date.now() < deadline) await delay(10);
  assert.equal(wakeups.length, 1);

  // agent_settled must not tear down an unclaimed wakeup queued for Pi
  await runtime.settle();
  assert.equal(runtime.running, true);

  const wakeupMsg = user(m.wakeupMessageText(wakeups[0]));
  const adopted = await start([req1, turn1, wakeupMsg]).finish();
  assert.equal(adopted.stopReason, "stop", adopted.errorMessage);
  assert.equal(textOf(adopted), "34/34 passed");

  // Warm session stayed intact: next prompt is promptCount === 2 (not 3)
  const next = await start([req1, turn1, wakeupMsg, adopted, user("Followup")]).finish();
  assert.equal(next.stopReason, "stop", next.errorMessage);
  assert.equal(textOf(next), "gemini-fixture low 2 1 Followup");
});

test("multi-step background wakeup survives mid-turn usage_update, native tools, and bridged Pi tools", { skip }, async t => {
  const { start, wakeups, m } = await setup(t, undefined, { wakeupSettleMs: 60 });
  const tools = [tool("fixture_tool")];
  const req1 = user("Bg wakeup tool");
  const turn1 = await start([req1], {}, tools).finish();
  assert.equal(turn1.stopReason, "stop", turn1.errorMessage);

  const deadline = Date.now() + 2_000;
  while (!wakeups.length && Date.now() < deadline) await delay(10);
  assert.equal(wakeups.length, 1);

  const wakeupMsg = user(m.wakeupMessageText(wakeups[0]));
  const handoff = await start([req1, turn1, wakeupMsg], {}, tools).finish();
  assert.equal(handoff.stopReason, "toolUse", handoff.errorMessage);
  const [call] = handoff.content.filter(block => block.type === "toolCall");
  assert.equal(call.name, "fixture_tool");
  assert.deepEqual(call.arguments, { example: 9 });

  const result = { role: "toolResult", toolName: call.name, toolCallId: call.id, isError: false, content: [{ type: "text", text: "ok" }], timestamp: Date.now() };
  const completed = await start([req1, turn1, wakeupMsg, handoff, result], {}, tools).finish();
  assert.equal(completed.stopReason, "stop", completed.errorMessage);
  assert.equal(textOf(completed), "Wakeup after Pi tool: ok");
});

test("silent background tool completion does not open a spurious wakeup turn", { skip }, async t => {
  const { start, wakeups } = await setup(t, undefined, { wakeupSettleMs: 40 });
  const turn1 = await start([user("Silent bg")]).finish();
  assert.equal(turn1.stopReason, "stop", turn1.errorMessage);
  await delay(80);
  assert.equal(wakeups.length, 0);
});

test("user prompt beating an unclaimed wakeup runs cleanly and stale wakeup sentinel is dropped", { skip }, async t => {
  const { start, wakeups, m } = await setup(t, undefined, { wakeupSettleMs: 60 });
  const req1 = user("Bg wakeup race");
  const turn1 = await start([req1]).finish();
  assert.equal(turn1.stopReason, "stop", turn1.errorMessage);

  const deadline = Date.now() + 2_000;
  while (!wakeups.length && Date.now() < deadline) await delay(10);
  assert.equal(wakeups.length, 1);

  // User prompt arrives before Pi dispatches the queued wakeup sentinel
  const userPrompt = user("Actually do something else");
  const userReply = await start([req1, turn1, userPrompt]).finish();
  assert.equal(userReply.stopReason, "stop", userReply.errorMessage);
  assert.match(textOf(userReply), /Actually do something else$/);

  // Queued wakeup sentinel arrives afterwards -> completes silently without sending to agy
  const staleWakeup = user(m.wakeupMessageText(wakeups[0]));
  const dropped = await start([req1, turn1, userPrompt, userReply, staleWakeup]).finish();
  assert.equal(dropped.stopReason, "stop", dropped.errorMessage);
  assert.equal(textOf(dropped), "");

  // Next user prompt still reuses the warm session
  const after = await start([req1, turn1, userPrompt, userReply, staleWakeup, dropped, user("Still warm")]).finish();
  assert.equal(after.stopReason, "stop", after.errorMessage);
  assert.equal(textOf(after), "gemini-fixture low 2 1 Still warm");
});
