import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCommand } from "../commands.ts";
import { assessDeletion, isWithin, normalizeTarget, worktreeBoundary } from "../paths.ts";
import { fixture, quote } from "./fixture.mjs";

const assess = (command, cwd, dialect = "bash") => assessDeletion(inspectCommand(command, dialect), { cwd, platform: process.platform });

test("internal files, missing tails, and subdirectory work stay within the nearest worktree", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "src"));
  for (const [command, cwd] of [["rm -rf build", f.workspace], ["rm -f missing/path", f.workspace], ["rm ../build/file", join(f.workspace, "src")]]) {
    const result = await assess(command, cwd);
    assert.equal(result.boundary, f.workspace);
    assert.deepEqual(result.concerns, []);
  }
});

test("outside targets, prefix siblings, root deletion, metadata, and wildcard paths require review", async (t) => {
  const f = await fixture(t);
  for (const command of [
    `rm -rf ${quote(f.outside)}`, "rm ../outside/sentinel", `rm -rf ${quote(f.workspace + "-other")}`,
    "rm -rf .", "rm -rf build/..", "rm .git/config", "rm -rf build/*", "rm -rf \"$TARGET\"", "rm -rf ~/Downloads",
  ]) {
    const result = await assess(command, f.workspace);
    assert.ok(result.concerns.length, command);
  }
});

test(".git file marks linked worktree root; scope is not widened by command cd", async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, "linked-worktree");
  await mkdir(join(linked, "sub"), { recursive: true });
  await writeFile(join(linked, ".git"), "gitdir: ../metadata");
  assert.equal(await worktreeBoundary(join(linked, "sub")), linked);
  const result = await assess("cd .. && rm -rf outside", f.workspace);
  assert.equal(result.boundary, f.workspace);
  assert.ok(result.concerns.some((reason) => reason.includes("Compound")));
});

test("outside Git, selected directory is the boundary (read-only probe)", async () => {
  const selected = tmpdir();
  // The system temp directory is only read, never used for test fixtures or cleanup.
  const boundary = await worktreeBoundary(selected);
  assert.ok(boundary);
  assert.ok(isWithin(boundary, selected, process.platform));
});

test("direct and ancestor junction/symlink escapes cannot be allowed as internal paths", async (t) => {
  const f = await fixture(t);
  await symlink(f.outside, join(f.workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  for (const command of ["rm -rf link", "rm link/sentinel", "rm link/missing/child", "rm -rf link/../outside/sentinel"]) {
    const result = await assess(command, f.workspace);
    assert.ok(result.concerns.some((reason) => /outside|root|resolve/.test(reason)), command);
  }
});

test("recursive targets are scanned without following nested links", async (t) => {
  const f = await fixture(t);
  await symlink(f.outside, join(f.workspace, "build/link"), process.platform === "win32" ? "junction" : "dir");
  const result = await assess("rm -rf build", f.workspace);
  assert.ok(result.concerns.some((reason) => reason.includes("symlink/junction")));
  const ps = await assess("Remove-Item build -Recurse -Force", f.workspace, "powershell");
  assert.ok(ps.concerns.some((reason) => reason.includes("symlink/junction")));
});

test("recursive deletion of nested repository metadata requires review", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "build/nested/.git"), { recursive: true });
  const result = await assess("rm -rf build", f.workspace);
  assert.ok(result.concerns.some((reason) => reason.includes("Git metadata")));
});

test("direct nested Git metadata targets require review, including marker files", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "vendor/checkout/.git"), { recursive: true });
  await writeFile(join(f.workspace, "vendor/checkout/.git/config"), "test metadata");
  await mkdir(join(f.workspace, "vendor/submodule"));
  await writeFile(join(f.workspace, "vendor/submodule/.git"), "gitdir: ../../metadata");
  for (const command of ["rm vendor/checkout/.git/config", "rm -rf vendor/checkout/.git", "rm vendor/submodule/.git"]) {
    const result = await assess(command, f.workspace);
    assert.ok(result.concerns.some(reason => reason.includes("Git metadata")), command);
  }
});

test("Windows drive forms and comparisons are explicit; ambiguous/provider paths are rejected", () => {
  const context = { cwd: "C:\\Repo", platform: "win32" };
  const target = (value, dialect = "bash") => ({ value, dialect, recursive: true });
  assert.equal(normalizeTarget(target("/c/Repo/build"), context), "c:/Repo/build");
  assert.equal(normalizeTarget(target("C:/Repo/build"), context), "C:/Repo/build");
  assert.equal(normalizeTarget(target(".\\build", "powershell"), context), ".\\build");
  assert.equal(isWithin("C:\\Repo", "c:\\repo\\build", "win32"), true);
  assert.equal(isWithin("C:\\Repo", "C:\\Repository\\build", "win32"), false);
  assert.equal(isWithin("C:\\Repo", "D:\\Repo\\build", "win32"), false);
  assert.equal(isWithin("/repo", "/repo2", "linux"), false);
  for (const value of ["C:relative", "C:", "//server/share", "\\\\server\\share", "\\\\?\\C:\\Repo", "HKCU:\\Software", "C:/Repo/file:stream", "/tmp/cache", "build.", "build "]) {
    assert.throws(() => normalizeTarget(target(value), context), undefined, value);
  }
});

test("boundary/path resolution failure requires approval rather than falling back to allow", async (t) => {
  const f = await fixture(t);
  const result = await assess("rm -rf build", join(f.root, "missing"));
  assert.ok(result.concerns.some((reason) => reason.includes("Cannot establish")));
});
