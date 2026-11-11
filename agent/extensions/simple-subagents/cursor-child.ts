import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Child-only Cursor policy: use the existing Pi role tools, never an additional native agent toolset. */
export function prepareCursorChild(agentDir: string, env: NodeJS.ProcessEnv): string {
  let directory = realpathSync(agentDir);
  for (const part of ["simple-subagents", "cursor-tmp"]) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) {
      throw new Error(`Cursor child temporary directory must be a real directory, not a link: ${directory}`);
    }
  }
  Object.assign(env, {
    PI_CURSOR_RUNTIME: "local", PI_CURSOR_NATIVE_TOOLS: "0", PI_CURSOR_SETTING_SOURCES: "none",
    PI_CURSOR_PI_TOOL_BRIDGE: "1", PI_CURSOR_EXPOSE_BUILTIN_TOOLS: "1",
    PI_CURSOR_LOCAL_RESUME: "0", PI_CURSOR_LOCAL_FORCE: "0",
    TMPDIR: directory, TEMP: directory, TMP: directory,
  });
  return directory;
}

export async function registerCursorChild(pi: ExtensionAPI, agentDir: string): Promise<void> {
  if (process.env.PI_SIMPLE_SUBAGENT !== "1") throw new Error("Cursor child initialization requires a session-owned leaf process.");
  prepareCursorChild(agentDir, process.env);
  // Explicitly load only the selected provider from this agent directory's installed package.
  const entry = pathToFileURL(join(agentDir, "npm", "node_modules", "pi-cursor-sdk", "dist", "index.js")).href;
  const provider = await import(entry);
  await provider.default(pi);
}
