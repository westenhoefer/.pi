import { copyToClipboard, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { snapshotMessages } from "./snapshot.ts";
import { SnapshotViewer } from "./viewer.ts";
import { claimBrowserEscape } from "./browser-escape.ts";

export function registerChatView(pi: ExtensionAPI, copy = copyToClipboard, claimEscape = claimBrowserEscape): void {
  pi.registerCommand("chat-view", {
    description: "Read a snapshot of this branch's user/assistant text without thinking or tools. Esc closes.",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") { ctx.ui.notify("Chat view requires the interactive TUI.", "warning"); return; }
      if (args.trim()) { ctx.ui.notify("Usage: /chat-view", "warning"); return; }
      const messages = snapshotMessages(ctx.sessionManager.getBranch());
      if (!messages.length) { ctx.ui.notify("No saved user or assistant text in this branch.", "info"); return; }
      const releaseEscape = claimEscape();
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => new SnapshotViewer(messages, tui, theme, getMarkdownTheme(), keys, done, copy), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
        });
      } finally { releaseEscape(); }
    },
  });
}

export default function chatView(pi: ExtensionAPI): void { registerChatView(pi); }
