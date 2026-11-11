import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { ADDITIONAL_TOOLS, buildLaunch, loadProfile, ROLES } from "../launch.ts";

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

test("parent-selected built-in tools augment only this profile without changing role instructions or defaults", async () => {
  const parse = () => ({ frontmatter: { tools: "read, grep, find, ls" }, body: "Read only. Never modify files." });
  for (const role of ROLES) {
    const defaults = await loadProfile(resolve("agent"), role, parse);
    const selected = await loadProfile(resolve("agent"), role, parse, ["bash", "read", "bash"]);
    assert.deepEqual(selected.tools, ["read", "grep", "find", "ls", "bash"]);
    assert.equal(selected.prompt, defaults.prompt);
    assert.deepEqual((await loadProfile(resolve("agent"), role, parse)).tools, defaults.tools);
    const launch = buildLaunch(selected, options);
    assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "read,grep,find,ls,bash");
  }
  const selected = await loadProfile(resolve("agent"), "scout", parse, [...ADDITIONAL_TOOLS]);
  assert.equal(new Set(selected.tools).size, ADDITIONAL_TOOLS.length);
});

test("additional tools reject launchers, unknown names and CLI argument injection even without schema validation", async () => {
  const parse = () => ({ frontmatter: { tools: "read" }, body: "Leaf" });
  for (const additionalTools of [["subagent_start"], ["swarm_start"], ["job_start"], ["loop_checkpoint"], ["gh"], ["bash,write"], ["--approve"], ["mcp__github"], [null], "bash", null]) {
    await assert.rejects(loadProfile(resolve("agent"), "scout", parse, additionalTools), /additionalTools/);
  }
});

test("profile loader refuses unknown roles and weakened instruction/tool contracts", async () => {
  const directory = resolve("agent");
  for (const name of ["../worker", "oracle", "researcher"]) {
    await assert.rejects(loadProfile(directory, name, () => ({})), /Unknown role/);
  }
  for (const frontmatter of [{ tools: "subagent_start" }, { tools: "read, swarm_start" }, { tools: "read, swarm_resume" }, { tools: "read", inheritGlobalContext: false }, { tools: "read", systemPromptMode: "replace" }, { tools: [] }]) {
    await assert.rejects(loadProfile(directory, "worker", () => ({ frontmatter, body: "Role" })));
  }
  assert.deepEqual(ROLES, ["worker", "scout", "reviewer"]);
});
