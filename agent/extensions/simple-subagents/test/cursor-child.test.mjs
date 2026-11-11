import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCursorChild } from "../cursor-child.ts";
import { buildLaunch, selectLaunch } from "../launch.ts";
import { RpcProcess } from "../rpc.ts";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for installed Cursor provider startup.";
async function directory(t) {
  const path = await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-cursor-"));
  t.after(async () => {
    assert.equal(await realpath(path), path); await readdir(path);
    await rm(path, { recursive: true });
  });
  return path;
}

test("Cursor child policy overrides native/cloud/ambient capabilities without changing its caller's environment", async t => {
  const path = await directory(t);
  const parent = { PI_CURSOR_RUNTIME: "cloud", PI_CURSOR_NATIVE_TOOLS: "1", PI_CURSOR_SETTING_SOURCES: "all", PI_CURSOR_PI_TOOL_BRIDGE: "0", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "0", PI_CURSOR_LOCAL_RESUME: "1", PI_CURSOR_LOCAL_FORCE: "1", TEMP: "outside", PATH: "preserved" };
  const env = { ...parent };
  const temporary = prepareCursorChild(path, env);
  assert.equal(temporary, join(path, "simple-subagents", "cursor-tmp"));
  assert.equal(env.PI_CURSOR_RUNTIME, "local"); assert.equal(env.PI_CURSOR_NATIVE_TOOLS, "0");
  assert.equal(env.PI_CURSOR_SETTING_SOURCES, "none"); assert.equal(env.PI_CURSOR_PI_TOOL_BRIDGE, "1");
  assert.equal(env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS, "1"); assert.equal(env.PI_CURSOR_LOCAL_RESUME, "0"); assert.equal(env.PI_CURSOR_LOCAL_FORCE, "0");
  for (const key of ["TMPDIR", "TEMP", "TMP"]) assert.equal(env[key], temporary);
  assert.equal(env.PATH, "preserved"); assert.equal(parent.PI_CURSOR_RUNTIME, "cloud"); assert.equal(parent.TEMP, "outside");
  await writeFile(join(temporary, "existing-user-file"), "preserve");
  prepareCursorChild(path, env);
  assert.equal(await readFile(join(temporary, "existing-user-file"), "utf8"), "preserve");
});

test("temporary-root preparation refuses links and files without touching their targets", async t => {
  for (const kind of ["link", "file"]) {
    const path = await directory(t);
    await mkdir(join(path, "simple-subagents"));
    const target = join(path, "elsewhere"); await mkdir(target); await writeFile(join(target, "keep"), "unchanged");
    const temporary = join(path, "simple-subagents", "cursor-tmp");
    if (kind === "link") await symlink(target, temporary, "junction");
    else await writeFile(temporary, "not a directory");
    assert.throws(() => prepareCursorChild(path, {}), /real directory/);
    assert.equal(await readFile(join(target, "keep"), "utf8"), "unchanged");
    if (kind === "link") await rm(temporary); // Remove only this owned link, never its target.
  }
});

test("per-member provider bootstrap follows exact selection and never mutates another launch", () => {
  const base = buildLaunch({ name: "scout", prompt: "Read only", tools: ["read"], extensions: [] }, {
    packageDir: "/pi", childRuntime: "/child.ts", executable: process.execPath, cwd: "/project", trusted: false,
    provider: "openai-codex", model: "base", thinking: "high", env: { PI_SIMPLE_SUBAGENT_PROVIDER: "spoofed" },
  });
  const cursor = selectLaunch(base, { provider: "cursor", model: "auto", thinking: "high" });
  assert.equal(cursor.env.PI_SIMPLE_SUBAGENT_PROVIDER, "cursor"); assert.equal(base.env.PI_SIMPLE_SUBAGENT_PROVIDER, "openai-codex");
  const other = selectLaunch(cursor, { provider: "other", model: "model", thinking: "off" });
  assert.equal(other.env.PI_SIMPLE_SUBAGENT_PROVIDER, "other"); assert.equal(cursor.env.PI_SIMPLE_SUBAGENT_PROVIDER, "cursor");
  assert.equal(other.env.PI_CURSOR_NATIVE_TOOLS, undefined, "policy is applied inside the Cursor child, not the parent launch");
});

test("installed Cursor provider starts in an isolated fileless RPC child with no model request", { skip }, async t => {
  const agentDir = await directory(t);
  const { getAgentDir } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const providerEntry = pathToFileURL(join(getAgentDir(), "npm/node_modules/pi-cursor-sdk/dist/index.js")).href;
  const shimDirectory = join(agentDir, "npm/node_modules/pi-cursor-sdk/dist"); await mkdir(shimDirectory, { recursive: true });
  // Use the real installed provider, but its host-visible configuration/cache/auth directory is this fixture.
  await writeFile(join(shimDirectory, "index.js"), `export { default } from ${JSON.stringify(providerEntry)};\n`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_CURSOR_SDK_DISABLE_MODEL_CACHE: "1" };
  delete env.CURSOR_API_KEY;
  const launch = buildLaunch({ name: "scout", prompt: "Read only. Do not modify files or spawn work.", tools: ["read", "grep", "find", "ls"], extensions: [] }, {
    packageDir: root, childRuntime: fileURLToPath(new URL("../child-runtime.ts", import.meta.url)), executable: process.execPath,
    cwd: process.cwd(), trusted: false, provider: "cursor", model: "auto", thinking: "off", env,
  });
  launch.args.push("--offline");
  const failures = [];
  const rpc = new RpcProcess(launch, () => {}, error => failures.push(error));
  try {
    const state = await rpc.request({ type: "get_state" });
    assert.equal(state.success, true); assert.equal(state.data.model.provider, "cursor"); assert.equal(state.data.model.id, "auto");
    const commands = await rpc.request({ type: "get_commands" });
    assert.ok(commands.data.commands.some(command => command.name === "cursor-abort"));
    assert.equal(commands.data.commands.some(command => ["loop", "panel", "subagents"].includes(command.name)), false);
    const messages = await rpc.request({ type: "get_messages" });
    assert.equal(messages.data.messages.some(message => message.role === "assistant"), false);
    assert.ok((await readdir(join(agentDir, "simple-subagents"))).includes("cursor-tmp"));
    assert.deepEqual(failures, []);
  } finally { await rpc.close(); }
});
