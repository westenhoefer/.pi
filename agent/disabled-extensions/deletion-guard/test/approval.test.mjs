import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authorizeDeletion } from "../approval.ts";
import { fixture } from "./fixture.mjs";

function context(cwd, answers = []) {
  const prompts = [];
  return {
    cwd, hasUI: true, prompts,
    ui: { confirm: async (title, message) => { prompts.push({ title, message }); return answers.shift() ?? false; } },
  };
}

test("safe internal deletion proceeds without UI; refused external deletion leaves a sentinel intact", async (t) => {
  const f = await fixture(t);
  const ctx = context(f.workspace);
  const internal = join(f.workspace, "build/file");
  await writeFile(internal, "test-owned");
  if ((await authorizeDeletion("rm build/file", ctx)).allowed) await unlink(internal);
  await assert.rejects(access(internal), { code: "ENOENT" });
  const outside = join(f.outside, "sentinel");
  if ((await authorizeDeletion("rm ../outside/sentinel", ctx)).allowed) await unlink(outside);
  assert.equal(await readFile(outside, "utf8"), "preserve me");
  assert.equal(ctx.prompts.length, 1);
  assert.match(ctx.prompts[0].message, /outside/);
  assert.match(ctx.prompts[0].message, /Allow this command once/);
});

test("approval is one-use, not a directory or session-wide exemption", async (t) => {
  const f = await fixture(t);
  const ctx = context(f.workspace, [true, false]);
  assert.equal((await authorizeDeletion("rm ../outside/sentinel", ctx)).allowed, true);
  assert.equal((await authorizeDeletion("rm ../outside/sentinel", ctx)).allowed, false);
  assert.equal(ctx.prompts.length, 2);
});

test("headless risky deletion is blocked; ordinary and internal commands still work", async (t) => {
  const f = await fixture(t);
  const ctx = { ...context(f.workspace), hasUI: false };
  for (const command of ["rm ../outside/sentinel", "rm -rf $TARGET", "rm -rf .", "git reset --hard"]) {
    const decision = await authorizeDeletion(command, ctx);
    assert.equal(decision.allowed, false, command);
    assert.match(decision.reason, /interactive parent/);
  }
  assert.equal((await authorizeDeletion("npm test", ctx)).allowed, true);
  assert.equal((await authorizeDeletion("rm -rf build", ctx)).allowed, true);
  assert.equal(ctx.prompts.length, 0);
});

test("PowerShell and Python outside literals use the same confirmation path", async (t) => {
  const f = await fixture(t);
  const ctx = context(f.workspace);
  const ps = await authorizeDeletion("Remove-Item '..\\outside\\sentinel' -Force", ctx, "powershell");
  const py = await authorizeDeletion('python -c "import os; os.remove(\'../outside/sentinel\')"', ctx);
  assert.equal(ps.allowed, false);
  assert.equal(py.allowed, false);
  assert.equal(ctx.prompts.length, 2);
});

test("UI failure and cancellation fail closed", async (t) => {
  const f = await fixture(t);
  const ctx = context(f.workspace);
  ctx.ui.confirm = async () => { throw new Error("disconnected UI"); };
  assert.equal((await authorizeDeletion("rm ../outside/sentinel", ctx)).allowed, false);
  const abort = new AbortController();
  ctx.signal = abort.signal;
  ctx.ui.confirm = async () => { abort.abort(); return true; };
  assert.equal((await authorizeDeletion("rm ../outside/sentinel", ctx)).allowed, false);
  assert.equal((await authorizeDeletion("rm build", ctx)).allowed, false);
});
