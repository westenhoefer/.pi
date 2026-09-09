import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authorizeDeletion } from "./approval.ts";
import { worktreeBoundary } from "./paths.ts";

export default function deletionGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!["bash", "powershell", "job_start"].includes(event.toolName)) return;
    if (typeof event.input.command !== "string") return { block: true, reason: "Deletion guard: missing command text." };
    const decision = await authorizeDeletion(event.input.command, ctx, event.toolName === "powershell" ? "powershell" : "bash");
    if (!decision.allowed) return { block: true, reason: decision.reason };
  });

  pi.on("user_bash", async (event, ctx) => {
    const decision = await authorizeDeletion(event.command, ctx);
    if (!decision.allowed) {
      return { result: { output: decision.reason ?? "Deletion blocked.", exitCode: 1, cancelled: true, truncated: false } };
    }
  });

  pi.registerCommand("deletion-guard", {
    description: "Show deletion guard scope and coverage (no disable/allow-all mode)",
    async handler(_args, ctx) {
      try {
        const root = await worktreeBoundary(ctx.cwd);
        ctx.ui.notify(`Deletion guard active\nBoundary: ${root}\nCoverage: bash, powershell, job_start, !/!!, /bg.\nLiteral internal targets allowed; risky/uncertain targets require one-time confirmation. Not a sandbox.`, "info");
      } catch (error) {
        ctx.ui.notify(`Deletion guard could not resolve its boundary: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
