import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Explicit child-only role injection preserves Pi's discovered SYSTEM/APPEND_SYSTEM files. */
export default function childRuntime(pi: ExtensionAPI): void {
  if (process.env.PI_SIMPLE_SUBAGENT !== "1") return;
  const prompt = process.env.PI_SIMPLE_SUBAGENT_PROMPT;
  if (!prompt) throw new Error("Missing session-owned subagent role instructions.");
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${prompt}` }));
}
