import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { inspectCommand, type Dialect } from "./commands.ts";
import { assessDeletion } from "./paths.ts";

export interface DeletionDecision { allowed: boolean; reason?: string }

function display(text: string, limit = 4000): string {
  const safe = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return safe.length > limit ? `${safe.slice(0, limit)}\n[Truncated; inspect the full command in the tool call.]` : safe;
}

/** Shared by tool preflight, !/!! commands, and the explicit /bg entry point. */
export async function authorizeDeletion(command: string, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "signal">, dialect: Dialect = "bash"): Promise<DeletionDecision> {
  if (ctx.signal?.aborted) return { allowed: false, reason: "Deletion check cancelled." };
  const inspection = inspectCommand(command, dialect);
  if (!inspection.destructive) return { allowed: true };
  const assessment = await assessDeletion(inspection, { cwd: ctx.cwd, platform: process.platform });
  if (ctx.signal?.aborted) return { allowed: false, reason: "Deletion check cancelled." };
  if (!assessment.concerns.length) return { allowed: true };
  const reason = `Deletion guard: ${display(assessment.concerns.join("\n"), 2000)}`;
  if (!ctx.hasUI) return { allowed: false, reason: `${reason}\nConfirmation requires an interactive parent session. Do not bypass the guard.` };
  const message = [
    `Worktree/project boundary: ${assessment.boundary ?? "unresolved"}`,
    `Starting directory: ${ctx.cwd}`,
    "",
    reason,
    "",
    "Targets checked relative to the starting directory (compound commands may change it):",
    display(assessment.targets.map((target) => `${target.input} → ${target.resolved ?? "unresolved"}`).join("\n") || "No literal targets available.", 2000),
    "",
    display(command),
    "",
    "Allow this command once? This does not grant permission to future commands.",
  ].join("\n");
  let confirmed: boolean;
  try { confirmed = await ctx.ui.confirm("Confirm deletion", message, { signal: ctx.signal }); }
  catch { return { allowed: false, reason: `${reason}\nConfirmation was unavailable or failed.` }; }
  return confirmed && !ctx.signal?.aborted
    ? { allowed: true }
    : { allowed: false, reason: `${reason}\nNot approved; command was not executed.` };
}
