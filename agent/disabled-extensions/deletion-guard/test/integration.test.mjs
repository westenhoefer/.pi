import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "./fixture.mjs";

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
  const loaded = await load(["agent/disabled-extensions/deletion-guard/index.ts"]);
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
