import { createHash } from "node:crypto";
import { getCurrentSystemMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";

export type ConversationMessage = Exclude<Message, { role: "system" }>;
type Text = { type: "text"; text: string };
type Image = { type: "image"; data: string; mimeType: string };
export type PromptBlock = Text | Image;
const REPLAY_CHARS = 64_000;
const GUIDANCE_CHARS = 64_000;

export function stamp(messages: readonly ConversationMessage[]) {
  // Omit provider instrumentation and details that Pi can add after the stream ends.
  return createHash("sha256").update(JSON.stringify(messages.map(message => [message.role,
    message.role === "toolResult" ? [message.toolName, message.toolCallId, message.isError] : undefined,
    message.content,
  ]))).digest("hex");
}

export function projectGuidance(messages: readonly Message[]): string {
  // Preserve explicit Pi instructions without replacing agy's native persona or tool guidance.
  const system = getCurrentSystemMessage(messages);
  if (!system) return "";
  const content = typeof system.content === "string" ? system.content : system.content.map(block => block.text).join("\n");
  const { preamble, project_context: project, addendum } = system.sections ?? {};
  const customPreamble = preamble?.startsWith("You are a coding assistant running inside pi,") ? undefined : preamble;
  return [content, customPreamble, project, addendum].filter(part => part?.trim()).join("\n\n");
}

function contextText(message: ConversationMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap(block => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return ["[prior image omitted]"];
    if (block.type === "toolCall") return [`[Pi tool ${block.name}]`];
    return [];
  }).join("\n");
}

export function toolResultsSince(messages: readonly ConversationMessage[], prefixLength: number): ToolResultMessage[] {
  return messages.slice(prefixLength).filter((m): m is ToolResultMessage => m.role === "toolResult");
}

export function makePrompt(messages: readonly ConversationMessage[], start: number, guidance: string, bridged: boolean): PromptBlock[] {
  const base = messages.slice(start);
  const last = base.at(-1);
  if (last?.role !== "user") throw new Error("Antigravity needs a user message to start a new ACP prompt.");
  const prompt: PromptBlock[] = [];
  if (start === 0) {
    if (guidance.length > GUIDANCE_CHARS) throw new Error("Pi workspace guidance is too large to send to Antigravity without truncation.");
    if (guidance) prompt.push({ type: "text", text: `Workspace and user instructions from Pi (use your native tools to follow them):\n${guidance}` });
    if (bridged) prompt.push({ type: "text", text: "Use your native tools for ordinary coding work. Selected Pi extension tools are also available over MCP under pi_tools; use those only for their advertised purpose." });
  }
  const history: string[] = [];
  let remaining = REPLAY_CHARS;
  for (let i = base.length - 2; i >= 0 && remaining > 0; i--) {
    const message = base[i]!;
    const role = message.role === "toolResult" ? `Pi tool result (${message.toolName})` : message.role;
    const text = contextText(message);
    const entry = `${role}: ${text.length > remaining ? `[… earlier text omitted …]${text.slice(-remaining)}` : text}`;
    history.unshift(entry);
    remaining -= entry.length;
  }
  if (history.length) {
    const omitted = history.length < base.length - 1 ? " (older entries omitted)" : "";
    prompt.push({ type: "text", text: `Prior Pi conversation for context only${omitted}:\n${JSON.stringify(history)}` });
  }
  const latest = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
  for (const block of latest) {
    if (block.type === "image") prompt.push({ type: "image", data: block.data, mimeType: block.mimeType });
    if (block.type === "text" && block.text) {
      // Inputs from Pi are conversation text, not a request to run an agy slash command.
      prompt.push({ type: "text", text: /^\s*\//u.test(block.text) ? `User message (literal text):\n${block.text}` : block.text });
    }
  }
  if (!latest.length || !prompt.length) throw new Error("Antigravity needs a nonempty prompt.");
  return prompt;
}
