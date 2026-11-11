# Chat snapshot viewer

Auto-discovered on `/reload`. Run `/chat-view` to open a read-only, full-terminal overlay of the saved current branch. Esc closes it and returns to the normal interface.

The viewer starts at the latest message. It includes user text and assistant prose, including saved messages from before compaction. Thinking, tool calls/results (including codemode), images, custom extension reports and bookkeeping are omitted. Image-only and thinking-only messages disappear entirely. It reads saved branch history, not the compacted model context; context edits do not rewrite this historical snapshot. Other branches and unfinished streaming output are not included.

## Controls

- **↑ / ↓**: scroll by line.
- **PageUp / PageDown**: scroll by page.
- **← / →**: jump to the previous/next message.
- **Home / End**: go to the beginning/end.
- **c**: copy the source text of the message at the top of the viewport (Markdown preserved).
- **Esc / Ctrl+C**: close; the configured `tui.select.cancel` bindings apply.

Configured selection up/down/page bindings also apply. The overlay does not refresh while open; close and reopen for a new snapshot. Clipboard access occurs only when you press **c**. Copy failures appear in the overlay footer.

This uses public command, session-reader, component and overlay APIs. It does not intercept native renderers, change settings/history/model context, send a prompt, or execute tools. No installed Pi files are patched. Overlay support itself is marked experimental by Pi. There is no default keyboard shortcut, persistent viewer state, live subscription or model-facing tool.

## Offline verification

From `C:/Users/johan/.pi`, using installed Node and Pi (no downloads):

```bash
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/chat-view/test/*.test.mjs
```

Tests cover filtering, pre-compaction history, snapshot isolation, actual extension loading and Markdown/Text rendering, navigation, Unicode/narrow viewports, large-message rendering, reading-position preservation across resize/invalidation, unsupported modes and clipboard handling. UI tests simulate the overlay host and clipboard; they do not open a real terminal, touch the real clipboard or call a model. Without `PI_TEST_PACKAGE_DIR`, installed-Pi integration cases explicitly skip.
