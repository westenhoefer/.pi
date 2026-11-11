import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SnapshotMessage { id: string; role: "user" | "assistant"; text: string }

/** Read the saved branch, not model context: compaction must not hide older messages. */
export function snapshotMessages(branch: readonly SessionEntry[]): SnapshotMessage[] {
  return branch.flatMap(entry => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
    return text.trim() ? [{ id: entry.id, role: message.role, text }] : [];
  });
}
