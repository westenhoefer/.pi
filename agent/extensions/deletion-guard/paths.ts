import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandInspection, DeleteTarget } from "./commands.ts";

export interface PathContext { cwd: string; platform: NodeJS.Platform }
export interface AssessedTarget { input: string; resolved?: string }
export interface DeletionAssessment {
  boundary?: string;
  targets: AssessedTarget[];
  concerns: string[];
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** The nearest .git marker also handles linked worktrees, where .git is a file. */
export async function worktreeBoundary(cwd: string): Promise<string> {
  const selected = await realpath(cwd);
  let candidate = selected;
  for (;;) {
    try {
      const marker = await lstat(path.join(candidate, ".git"));
      if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) return candidate;
    } catch (error) { if (!missing(error)) throw error; }
    const parent = path.dirname(candidate);
    if (candidate === parent) return selected;
    candidate = parent;
  }
}

export function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

export function normalizeTarget(target: DeleteTarget, context: PathContext): string {
  let value = target.value;
  if (!value || target.uncertain || /[\x00-\x1f\x7f*?\[\]{}$`]/.test(value)) {
    throw new Error("Target is empty, expanded, a wildcard, or not a simple literal.");
  }
  // A literal '~' in Python/quoted shell text is not a home expansion; prompting is
  // safer than silently assigning the wrong meaning in either direction.
  if (value.startsWith("~")) throw new Error("Home-relative syntax needs confirmation; use an absolute literal for precise checks.");
  if (context.platform === "win32") {
    if (target.dialect === "bash" && /^\/[a-z](?:\/|$)/i.test(value)) value = `${value[1]}:/${value.slice(3)}`;
    else if (target.dialect === "bash" && value.startsWith("/")) throw new Error("Unix-style absolute path under Windows Bash needs confirmation (except /c/... drive paths).");
    if (/^[a-z]:[^\\/]/i.test(value) || /^[a-z]:$/i.test(value)) throw new Error("Drive-relative Windows path needs confirmation.");
    if (/^(?:\\\\|\/\/)/.test(value)) throw new Error("UNC/device paths need confirmation; the guard does not probe network shares.");
    if (value.replace(/^[a-z]:/i, "").includes(":")) throw new Error("PowerShell provider paths and Windows alternate streams need confirmation.");
    if (value.split(/[\\/]/).some((part) => part !== "." && part !== ".." && /[. ]$/.test(part))) throw new Error("Windows trailing-dot/space path aliases need confirmation.");
  } else if (target.dialect === "powershell" && value.includes("\\")) {
    throw new Error("PowerShell backslash paths on this platform need confirmation.");
  }
  return value;
}

/** Resolve each existing component before '..', including junctions and missing tails. */
async function canonicalTarget(value: string, cwd: string): Promise<string> {
  let current: string;
  let parts: string[];
  if (path.isAbsolute(value)) {
    const root = path.parse(value).root;
    current = root;
    parts = value.slice(root.length).split(path.sep === "\\" ? /[\\/]/ : /\//);
  } else {
    current = await realpath(cwd);
    parts = value.split(path.sep === "\\" ? /[\\/]/ : /\//);
  }
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const candidate = path.join(current, part);
    try {
      // lstat distinguishes a broken link from a plain nonexistent target.
      await lstat(candidate);
    } catch (error) {
      if (missing(error)) { current = candidate; continue; }
      throw error;
    }
    current = await realpath(candidate);
  }
  return current;
}

async function recursiveConcern(target: string): Promise<string | undefined> {
  let initial;
  try { initial = await lstat(target); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!initial.isDirectory()) return;
  const directories = [target];
  let inspected = 0;
  while (directories.length) {
    const directory = directories.pop()!;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++inspected > 2000) return "Recursive target exceeds the 2000-entry link-inspection limit.";
      if (entry.isSymbolicLink()) return "Recursive target contains a symlink/junction; traversal semantics need review.";
      if (entry.name.toLowerCase() === ".git") return "Recursive target contains Git metadata.";
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
    }
  }
}

export async function assessDeletion(inspection: CommandInspection, context: PathContext): Promise<DeletionAssessment> {
  const assessment: DeletionAssessment = { targets: [], concerns: [...inspection.concerns] };
  if (!inspection.destructive) return assessment;
  try { assessment.boundary = await worktreeBoundary(context.cwd); }
  catch (error) {
    assessment.concerns.push(`Cannot establish the worktree boundary: ${error instanceof Error ? error.message : String(error)}`);
    return assessment;
  }
  const boundary = assessment.boundary;
  const containsMetadata = (candidate: string) => path.relative(boundary, candidate).split(path.sep).some(part => part.toLowerCase() === ".git");
  if (inspection.targets.length > 32) assessment.concerns.push("More than 32 deletion targets require manual review.");
  for (const target of inspection.targets.slice(0, 32)) {
    const item: AssessedTarget = { input: target.value };
    assessment.targets.push(item);
    try {
      const value = normalizeTarget(target, context);
      const lexical = path.resolve(context.cwd, value);
      item.resolved = lexical;
      if (!isWithin(boundary, lexical, context.platform)) {
        assessment.concerns.push(`Target is outside the worktree: ${lexical}`);
        continue;
      }
      const canonical = await canonicalTarget(value, context.cwd);
      item.resolved = canonical;
      if (!isWithin(boundary, canonical, context.platform)) {
        assessment.concerns.push(`Target resolves outside the worktree through a link/junction: ${canonical}`);
      } else if (lexical === boundary || canonical === boundary) {
        assessment.concerns.push("Deletion targets the worktree/project root itself.");
      } else if (containsMetadata(lexical) || containsMetadata(canonical)) {
        assessment.concerns.push("Deletion targets Git metadata.");
      } else if (target.recursive) {
        const concern = await recursiveConcern(canonical);
        if (concern) assessment.concerns.push(`${target.value}: ${concern}`);
      }
    } catch (error) {
      assessment.concerns.push(`${target.value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assessment.concerns = [...new Set(assessment.concerns)];
  return assessment;
}
