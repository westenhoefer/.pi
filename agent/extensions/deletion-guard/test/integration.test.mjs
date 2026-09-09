import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, quote } from "./fixture.mjs";

const piRoot = process.env.PI_TEST_PACKAGE_DIR;
const skip = !piRoot && "Set PI_TEST_PACKAGE_DIR to run the real Pi-loader integration tests.";

async function load(paths) {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions(paths.map(resolvePath => resolve(resolvePath)), process.cwd());
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.sendMessage = () => {};
  return loaded;
}
function context(cwd) {
  const prompts = [], notifications = [];
  return {
    cwd, hasUI: true, mode: "tui", prompts, notifications,
    sessionManager: { getSessionId: () => "deletion-test", getSessionFile: () => undefined },
    ui: { confirm: async (title, text) => { prompts.push(text); return false; }, notify: (text) => notifications.push(text), setStatus: () => {} },
  };
}

async function emit(extension, eventName, event, ctx) {
  let result;
  for (const handler of extension.handlers.get(eventName) ?? []) result = await handler(event, ctx) ?? result;
  return result;
}

test("real Pi hooks gate bash, PowerShell, job_start, and !/!! but do not intercept ordinary file tools", { skip }, async (t) => {
  const f = await fixture(t);
  const loaded = await load(["agent/extensions/deletion-guard/index.ts"]);
  const extension = loaded.extensions[0];
  const ctx = context(f.workspace);
  for (const [toolName, command] of [
    ["bash", "rm ../outside/sentinel"],
    ["job_start", "rm ../outside/sentinel"],
    ["powershell", "Remove-Item ../outside/sentinel -Force"],
    ["bash", 'python -c "import os; os.remove(\'../outside/sentinel\')"'],
  ]) {
    const decision = await emit(extension, "tool_call", { toolName, input: { command } }, ctx);
    assert.equal(decision.block, true, toolName);
    assert.match(decision.reason, /Not approved/);
  }
  for (const excludeFromContext of [true, false]) {
    const decision = await emit(extension, "user_bash", { command: "rm ../outside/sentinel", excludeFromContext, cwd: f.workspace }, ctx);
    assert.equal(decision.result.cancelled, true);
    assert.equal(decision.result.exitCode, 1);
  }
  assert.equal(ctx.prompts.length, 6);
  const safe = await emit(extension, "tool_call", { toolName: "bash", input: { command: "rm -rf build" } }, ctx);
  assert.equal(safe, undefined);
  assert.equal(await emit(extension, "tool_call", { toolName: "read", input: { path: "README.md" } }, ctx), undefined);
  const headless = await emit(extension, "tool_call", { toolName: "job_start", input: { command: "rm ../outside/sentinel" } }, { ...ctx, hasUI: false });
  assert.equal(headless.block, true);
  assert.equal(ctx.prompts.length, 6);
  assert.equal(await readFile(join(f.outside, "sentinel"), "utf8"), "preserve me");
});

test("/bg uses the shared guard even without the hook extension loaded, and denial launches no job", { skip }, async (t) => {
  const f = await fixture(t);
  const loaded = await load(["agent/extensions/background-jobs/index.ts"]);
  const jobs = loaded.extensions[0];
  const ctx = context(f.workspace);
  t.after(() => emit(jobs, "session_shutdown", { reason: "quit" }, ctx));
  await emit(jobs, "session_start", { reason: "startup" }, ctx);
  await jobs.commands.get("bg").handler(`rm -rf ${quote(f.outside)}`, ctx);
  const status = await jobs.tools.get("job_status").definition.execute("test", {}, undefined, undefined, ctx);
  assert.deepEqual(status.details, []);
  assert.equal(ctx.prompts.length, 1);
  assert.ok(ctx.notifications.some(text => text.includes("Not approved")));
  assert.equal(await readFile(join(f.outside, "sentinel"), "utf8"), "preserve me");
});
