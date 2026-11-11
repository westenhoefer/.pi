import { copyToClipboard, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { snapshotMessages } from "./snapshot.ts";
import { SnapshotViewer } from "./viewer.ts";

export function registerChatView(pi: ExtensionAPI, copy = copyToClipboard): void {
  pi.registerCommand("chat-view", {
    description: "Read a snapshot of this branch's user/assistant text without thinking or tools. Esc closes.",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") { ctx.ui.notify("Chat view requires the interactive TUI.", "warning"); return; }
      if (args.trim()) { ctx.ui.notify("Usage: /chat-view", "warning"); return; }
      const messages = snapshotMessages(ctx.sessionManager.getBranch());
      if (!messages.length) { ctx.ui.notify("No saved user or assistant text in this branch.", "info"); return; }
      await ctx.ui.custom<void>((tui, theme, keys, done) => new SnapshotViewer(messages, tui, theme, getMarkdownTheme(), keys, done, copy), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
      });
    },
  });
}

export default function chatView(pi: ExtensionAPI): void { registerChatView(pi); }
