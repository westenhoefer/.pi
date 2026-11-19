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

Set `PI_TEST_PACKAGE_DIR` and `PI_OFFLINE=1` as shown in the root [`README`](../../../README.md#verification), then run `node --test agent/extensions/chat-view/test/*.test.mjs` from `C:\Users\johan\.pi`.

Tests cover filtering, pre-compaction history, snapshot isolation, actual extension loading and Markdown/Text rendering, navigation, Unicode/narrow viewports, large-message rendering, reading-position preservation across resize/invalidation, unsupported modes and clipboard handling. UI tests simulate the overlay host and clipboard; they do not open a real terminal, touch the real clipboard or call a model. Without `PI_TEST_PACKAGE_DIR`, installed-Pi integration cases explicitly skip.


## MCP Browser Escape priority

In browser-created terminal panes, the launcher sets MCP_BROWSER_TERMINAL=1.
While chat-view is open, it claims Escape through a private OSC 777 output message:

    ESC ] 777 ; mcp-browser ; escape ; claim=chat-view-<pid>-<counter> BEL

Closing the overlay releases the same owner with release= in place of claim=.
A try/finally and process-exit cleanup release it on errors and exit. The browser
tracks claims separately in each pane and preserves them in terminal checkpoints.
Escape closes chat-view first while keeping pane focus; after release, another
Escape restores the pane layout. Ctrl+Shift+F and Restore remain direct browser
controls. The launcher clears stale claims when Pi returns to the shell.

Other terminal hosts and non-TTY output receive no messages. This is a private
agreement with MCP Browser, not a standard Pi or terminal overlay API. Open a new
browser terminal pane to get the launcher flag, then start Pi or reload this extension.
