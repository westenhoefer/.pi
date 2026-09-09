import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";

export async function fixture(t) {
  const repository = await realpath(process.cwd());
  assert.ok((await lstat(join(repository, ".git"))).isDirectory(), "Run tests from the ~/.pi repository root");
  const state = join(repository, "agent/test-state");
  await mkdir(state, { recursive: true });
  const root = await mkdtemp(join(state, "deletion-guard-"));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, "build"));
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "preserve me");
  t.after(async () => {
    const actual = await realpath(root);
    const distance = relative(repository, actual);
    assert.ok(distance && distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
    await rm(actual, { recursive: true, force: true });
  });
  return { repository, root, workspace, outside };
}

export const quote = (text) => `'${text.replaceAll("\\", "/").replace(/'/g, `'\\''`)}'`;
