import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChatView } from "../index.ts";

export default function fixture(pi: ExtensionAPI): void {
  registerChatView(pi, async text => {
    const query: { text: string; fail?: boolean; wait?: Promise<void> } = { text };
    pi.events.emit("chat-view:test-copy", query);
    await query.wait;
    if (query.fail) throw new Error("Test clipboard failure");
  });
}
