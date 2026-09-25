import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Launch } from "./rpc.ts";

export const ROLES = ["worker", "scout", "reviewer", "oracle", "researcher"] as const;
export interface Profile { name: string; prompt: string; tools: string[]; extensions: string[]; model?: string }
type Parser = (text: string) => { frontmatter: Record<string, unknown>; body: string };

export async function loadProfile(agentDir: string, name: string, parse: Parser): Promise<Profile> {
  if (!(ROLES as readonly string[]).includes(name)) throw new Error(`Unknown role. Choose ${ROLES.join(", ")}.`);
  const directory = join(agentDir, "agents");
  const { frontmatter: fields, body } = parse(await readFile(join(directory, `${name}.md`), "utf8"));
  for (const key of ["inheritProjectContext", "inheritGlobalContext", "inheritSkills"]) {
    if (fields[key] === false || fields[key] === "false") throw new Error(`${name}: disabling inherited instructions/skills is not supported.`);
  }
  if (fields.systemPromptMode && fields.systemPromptMode !== "append") throw new Error(`${name}: only append system prompts are supported.`);
  const list = (value: unknown): string[] => {
    if (value === undefined || value === null || value === "") return [];
    if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return value as string[];
    throw new Error(`${name}: expected a comma-separated list or string array.`);
  };
  const tools = list(fields.tools);
  if (!tools.length || tools.some(tool => /subagent|job_start|loop_checkpoint|bg_wait/.test(tool))) throw new Error(`${name}: explicit leaf-only tools are required.`);
  return {
    name, prompt: body, tools,
    extensions: list(fields.extensions).map(path => isAbsolute(path) ? path : resolve(directory, path)),
    model: typeof fields.model === "string" ? fields.model : undefined,
  };
}

export function buildLaunch(profile: Profile, options: {
  packageDir: string; childRuntime: string; executable: string; cwd: string; trusted: boolean;
  provider: string; model: string; thinking: string; env: NodeJS.ProcessEnv;
}): Launch {
  if (!/^node(?:\.exe)?$/i.test(basename(options.executable))) throw new Error("Subagents currently require the npm/Node Pi installation.");
  const args = [join(options.packageDir, "dist", "cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-prompt-templates", "--no-themes",
    options.trusted ? "--approve" : "--no-approve", "--tools", profile.tools.join(","), "--thinking", options.thinking];
  if (profile.model) args.push("--model", profile.model);
  else args.push("--provider", options.provider, "--model", options.model);
  for (const extension of profile.extensions) args.push("--extension", extension);
  // --append-system-prompt disables discovered APPEND_SYSTEM.md files. Inject only
  // the role via a child extension instead, preserving normal instruction discovery.
  args.push("--extension", options.childRuntime);
  const env: NodeJS.ProcessEnv = { ...options.env, PI_SIMPLE_SUBAGENT: "1", PI_SIMPLE_SUBAGENT_PROMPT: `Leaf subagent role: ${profile.name}\n${profile.prompt}` };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  return { command: options.executable, args, cwd: options.cwd, env };
}
