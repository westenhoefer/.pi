import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicit child initialization preserves Pi's discovered SYSTEM/APPEND_SYSTEM files. */
export default async function childRuntime(pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_SIMPLE_SUBAGENT !== "1") return;
  const prompt = process.env.PI_SIMPLE_SUBAGENT_PROMPT;
  if (!prompt) throw new Error("Missing session-owned subagent role instructions.");
  if (process.env.PI_SIMPLE_SUBAGENT_PROVIDER === "cursor") {
    const { registerCursorChild } = await import("./cursor-child.ts");
    await registerCursorChild(pi, getAgentDir());
  }
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${prompt}` }));
}
