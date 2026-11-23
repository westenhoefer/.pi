import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fullOid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Drop repository/index and injected-config overrides, not caller policy such as
// GIT_LFS_SKIP_SMUDGE or GIT_ALLOW_PROTOCOL. Compare keys case-insensitively on Windows.
export function worktreeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const redirect = /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|GRAFT_FILE|REPLACE_REF_BASE|PREFIX|SHALLOW_FILE|QUARANTINE_PATH|NAMESPACE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_(?:KEY|VALUE)_\d+)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !redirect.test(key)));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = worktreeEnvironment(process.env);
  const result = exec("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.askPass=", "-c", "submodule.recurse=false", ...args], {
    cwd, windowsHide: true, encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS: "", GCM_INTERACTIVE: "Never", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" },
  });
  result.child.stdin?.end();
  return (await result).stdout.trim();
}

export async function resolveWorktreeBase(cwd: string): Promise<string> {
  const [inside, base] = (await git(cwd, "rev-parse", "--is-inside-work-tree", "--verify", "HEAD^{commit}")).split(/\r?\n/);
  if (inside !== "true" || !fullOid.test(base)) throw new Error("Expected a Git worktree with a committed HEAD");
  return base;
}

// Validate existing ancestors before creating missing directories; recursive mkdir alone follows junctions.
async function ensureWorktreeDirectory(path: string): Promise<void> {
  let actual: string;
  try { actual = await realpath(path); }
  catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw error;
    await ensureWorktreeDirectory(parent);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    actual = await realpath(path);
  }
  if (relative(path, actual)) throw new Error(`Worktree destination must not traverse a linked directory: ${path}`);
}

// The caller must trust this repository (checkout can run configured filters) and own the destination parent.
export async function provisionWorktree(cwd: string, base: string, path: string): Promise<void> {
  if (!fullOid.test(base)) throw new Error("Expected a pinned commit object ID");
  if (!isAbsolute(path)) throw new Error("Expected an absolute worktree path");
  await ensureWorktreeDirectory(dirname(path));
  // Git accepts an existing empty directory; reserve the fresh name exclusively before letting Git touch it.
  await mkdir(path, { mode: 0o700 });
  await git(cwd, "worktree", "add", "--detach", "--", path, base);
}
