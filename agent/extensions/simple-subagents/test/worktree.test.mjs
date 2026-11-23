import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { provisionWorktree, resolveWorktreeBase } from "../worktree.ts";

const exec = promisify(execFile);
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
async function git(cwd, ...args) {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, env: { ...fixtureEnv, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(import.meta.dirname), ".worktree-test-"));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true }); // only this private clone and its linked worktrees
  });
  return root;
}

test("two detached worktrees use the pinned base, not source HEAD, staged or untracked files", async t => {
  const root = await fixture(t);
  const repo = join(root, "source");
  await git(root, "clone", "--local", "--no-hardlinks", "--template=", await git(root, "rev-parse", "--show-toplevel"), repo);
  const tracked = "README.md";
  const clean = await readFile(join(repo, tracked));
  await writeFile(join(repo, tracked), "staged only");
  await git(repo, "add", "--", tracked);
  await writeFile(join(repo, tracked), "working copy only");
  await writeFile(join(repo, "source-only"), "untracked");

  const hooks = join(root, "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "post-checkout"), "#!/bin/sh\nprintf invoked > hook-ran\nexit 1\n", { mode: 0o755 });
  await git(repo, "config", "--local", "core.hooksPath", hooks);

  // A parent Git process (e.g. a hook) must not redirect either operation away from the requested cwd.
  const previous = process.env.GIT_DIR;
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  process.env.GIT_DIR = join(root, "not-a-git-dir");
  const subdir = join(repo, "agent");
  const base = await resolveWorktreeBase(subdir);
  assert.equal(base, await git(repo, "rev-parse", "HEAD"));
  // Change only this clone's HEAD to an unborn ref. Provisioning must not rediscover HEAD at dispatch.
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/unborn-fixture");
  const branches = await git(repo, "for-each-ref", "refs/heads");
  const parent = join(root, "agent dir", "simple-subagents", "worktrees");
  const first = join(parent, randomUUID()), second = join(parent, randomUUID());
  for (const path of [first, second]) {
    await provisionWorktree(subdir, base, path);
    assert.equal(await realpath(await git(path, "rev-parse", "--show-toplevel")), await realpath(path));
    assert.equal(await resolveWorktreeBase(path), base);
    await assert.rejects(git(path, "symbolic-ref", "-q", "HEAD"), { code: 1 });
    assert.deepEqual(await readFile(join(path, tracked)), clean);
    await assert.rejects(readFile(join(path, "source-only")), { code: "ENOENT" });
    await assert.rejects(readFile(join(path, "hook-ran")), { code: "ENOENT" });
    if (path === first) await writeFile(join(first, tracked), "private edit");
  }
  assert.equal(await git(repo, "for-each-ref", "refs/heads"), branches);
  assert.equal(await readFile(join(repo, tracked), "utf8"), "working copy only");
});

test("a linked parent cannot redirect worktree provisioning, even if the next component is missing", async t => {
  const root = await fixture(t);
  const target = join(root, "target"), link = join(root, "link");
  await mkdir(target);
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  const base = await resolveWorktreeBase(import.meta.dirname);
  await assert.rejects(provisionWorktree(import.meta.dirname, base, join(link, "missing", randomUUID())), /linked directory/);
  assert.deepEqual(await readdir(target), []);
});

test("base resolution rejects bare and unborn repositories", async t => {
  const root = await fixture(t);
  const bare = join(root, "bare");
  await git(root, "clone", "--bare", "--local", "--no-hardlinks", "--template=", await git(root, "rev-parse", "--show-toplevel"), bare);
  await assert.rejects(resolveWorktreeBase(bare), /worktree/);
  const unborn = join(root, "unborn");
  await git(root, "init", "--template=", unborn);
  await assert.rejects(resolveWorktreeBase(unborn));
});

test("existing empty destinations are not adopted; missing pinned commits do not fall back to HEAD", async t => {
  const root = await fixture(t);
  const repo = join(root, "source");
  await git(root, "clone", "--local", "--no-checkout", "--no-hardlinks", "--template=", await git(root, "rev-parse", "--show-toplevel"), repo);
  const base = await resolveWorktreeBase(repo);
  const before = await git(repo, "worktree", "list", "--porcelain");
  const collision = join(root, randomUUID());
  await mkdir(collision);
  await assert.rejects(provisionWorktree(repo, base, collision), { code: "EEXIST" });
  assert.deepEqual(await readdir(collision), []);
  await assert.rejects(provisionWorktree(repo, "0".repeat(base.length), join(root, randomUUID())));
  assert.equal(await git(repo, "worktree", "list", "--porcelain"), before);
});
