import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Launch } from "./rpc.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface ModelSelection { provider: string; model: string; thinking: string }

/** Explicit launches use exact catalog IDs, never fuzzy matching or provider fallback. */
export function resolveSelection(registry: ExtensionContext["modelRegistry"], reference: string, thinking: string): ModelSelection {
  if (!THINKING_LEVELS.includes(thinking as typeof THINKING_LEVELS[number])) throw new Error("Invalid thinking level.");
  const model = registry.getAvailable().find(model => `${model.provider}/${model.id}` === reference);
  if (!model) throw new Error(`Model unavailable: ${reference}. Use an exact authenticated provider/model ID from /model.`);
  return { provider: model.provider, model: model.id, thinking };
}

/** Replace only model flags on an already scoped launch; retain cwd, trust, tools and environment. */
export function selectLaunch(launch: Launch, selection: ModelSelection): Launch {
  const args: string[] = [];
  for (let i = 0; i < launch.args.length; i++) {
    if (["--provider", "--model", "--thinking"].includes(launch.args[i])) i++;
    else args.push(launch.args[i]);
  }
  args.push("--provider", selection.provider, "--model", selection.model, "--thinking", selection.thinking);
  return { ...launch, args, env: { ...launch.env, PI_SIMPLE_SUBAGENT_PROVIDER: selection.provider }, selection: { ...selection } };
}

export const ROLES = ["worker", "scout", "reviewer"] as const;
export const ADDITIONAL_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"] as const;
export interface Profile { name: string; prompt: string; tools: string[]; extensions: string[]; model?: string }
type Parser = (text: string) => { frontmatter: Record<string, unknown>; body: string };

export async function loadProfile(agentDir: string, name: string, parse: Parser, additionalTools: string[] = []): Promise<Profile> {
  if (!(ROLES as readonly string[]).includes(name)) throw new Error(`Unknown role. Choose ${ROLES.join(", ")}.`);
  if (!Array.isArray(additionalTools) || additionalTools.some(tool => !(ADDITIONAL_TOOLS as readonly string[]).includes(tool))) throw new Error(`additionalTools must contain only built-in leaf tools: ${ADDITIONAL_TOOLS.join(", ")}.`);
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
  if (!tools.length || tools.some(tool => /subagent|swarm_|job_start|loop_checkpoint|bg_wait/.test(tool))) throw new Error(`${name}: explicit leaf-only tools are required.`);
  return {
    name, prompt: body, tools: [...new Set([...tools, ...additionalTools])],
    extensions: list(fields.extensions).map(path => isAbsolute(path) ? path : resolve(directory, path)),
    model: typeof fields.model === "string" ? fields.model : undefined,
  };
}

export function buildLaunch(profile: Profile, options: {
  packageDir: string; childRuntime: string; executable: string; cwd: string; trusted: boolean;
  provider: string; model: string; thinking: string; env: NodeJS.ProcessEnv; selection?: ModelSelection;
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
  const env: NodeJS.ProcessEnv = { ...options.env, PI_SIMPLE_SUBAGENT: "1", PI_SIMPLE_SUBAGENT_PROMPT: `Leaf subagent role: ${profile.name}\n${profile.prompt}`,
    PI_SIMPLE_SUBAGENT_PROVIDER: profile.model?.includes("/") ? profile.model.slice(0, profile.model.indexOf("/")) : options.provider };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  const launch: Launch = { command: options.executable, args, cwd: options.cwd, env,
    selection: profile.model ? undefined : { provider: options.provider, model: options.model, thinking: options.thinking } };
  return options.selection ? selectLaunch(launch, options.selection) : launch;
}
