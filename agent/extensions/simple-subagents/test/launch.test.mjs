import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { buildLaunch, loadProfile, ROLES } from "../launch.ts";

const options = { packageDir: "/pi", childRuntime: "/runtime.ts", executable: process.execPath, cwd: "/project", trusted: false,
  provider: "parent-provider", model: "parent-model", thinking: "high", env: { PI_SESSION_ID: "parent", PI_SESSION_FILE: "parent-file", PATH: "test-path" } };
const profile = { name: "scout", prompt: "Read only.", tools: ["read", "grep"], extensions: [] };

test("child launch is isolated from ambient automation without disabling instruction/skill discovery", () => {
  const result = buildLaunch(profile, options);
  assert.equal(result.cwd, "/project"); assert.equal(result.command, process.execPath);
  for (const flag of ["--no-session", "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-approve"]) assert.ok(result.args.includes(flag));
  for (const flag of ["--append-system-prompt", "--system-prompt", "--no-context-files", "--no-skills", "--approve"]) assert.equal(result.args.includes(flag), false);
  assert.equal(result.env.PI_SESSION_ID, undefined); assert.equal(result.env.PI_SESSION_FILE, undefined);
  assert.equal(result.env.PATH, "test-path"); assert.equal(result.env.PI_SIMPLE_SUBAGENT, "1");
  assert.match(result.env.PI_SIMPLE_SUBAGENT_PROMPT, /Read only/);
  assert.equal(result.args[result.args.indexOf("--provider") + 1], "parent-provider");
  assert.equal(result.args[result.args.indexOf("--tools") + 1], "read,grep");
  assert.equal(result.args[result.args.indexOf("--extension") + 1], "/runtime.ts");
});

test("explicit role extensions/model and previously granted cwd trust are preserved", () => {
  const result = buildLaunch({ ...profile, model: "other/model", extensions: ["/provider.ts"] }, { ...options, trusted: true });
  assert.ok(result.args.includes("--approve")); assert.ok(result.args.includes("/provider.ts"));
  assert.equal(result.args.includes("--provider"), false); assert.ok(result.args.includes("other/model"));
});

test("profile loader refuses unknown roles and weakened instruction/tool contracts", async () => {
  const directory = resolve("agent");
  await assert.rejects(loadProfile(directory, "../worker", () => ({})), /Unknown role/);
  for (const frontmatter of [{ tools: "subagent_start" }, { tools: "read", inheritGlobalContext: false }, { tools: "read", systemPromptMode: "replace" }, { tools: [] }]) {
    await assert.rejects(loadProfile(directory, "worker", () => ({ frontmatter, body: "Role" })));
  }
  assert.equal(ROLES.length, 5);
});
