import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for installed Pi UI integration.";
const flush = () => new Promise(resolve => setImmediate(resolve));
const entry = (id, role, text) => ({ id, type: "message", message: { role, content: [{ type: "text", text }] } });
const branch = () => [entry("u", "user", "Old question"), entry("a", "assistant", "Old answer\n\n```js\nconst value = 42;\n```"), entry("z", "user", "Latest question 中文 😀")];

async function harness(entries = branch(), useFixture = true) {
  const sdk = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  sdk.initTheme("light", false);
  const themeModule = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  const bus = createEventBus();
  const loaded = await loadExtensions([resolve(`agent/extensions/chat-view/${useFixture ? "test/fixture.ts" : "index.ts"}`)], process.cwd(), bus);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const command = extension.commands.get("chat-view");
  const notices = [], copies = [];
  let viewer, options, renders = 0, opened = 0;
  bus.on("chat-view:test-copy", query => copies.push(query.text));
  const tui = { terminal: { rows: 12 }, requestRender: () => { renders++; } };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const ctx = { mode: "tui", sessionManager: { getBranch: () => entries }, ui: {
    notify: (text, kind) => notices.push({ text, kind }),
    custom(factory, config) {
      opened++; options = config;
      return new Promise(done => { viewer = factory(tui, themeModule.theme, keys, () => { viewer.dispose(); done(); }); });
    },
  } };
  return { extension, ctx, entries, bus, copies, notices, tui, keys, visibleWidth,
    open: args => command.handler(args ?? "", ctx),
    get viewer() { return viewer; }, get options() { return options; }, get opened() { return opened; }, get renders() { return renders; },
  };
}

function screen(h, width = 90) { return h.viewer.render(width).join("\n"); }

test("real extension registers only a command and opens a snapshot overlay without touching session data", { skip }, async () => {
  const h = await harness(branch(), false);
  assert.equal(h.extension.tools.size, 0); assert.equal(h.extension.handlers.size, 0);
  const before = structuredClone(h.entries);
  const pending = h.open();
  assert.equal(h.options.overlay, true);
  assert.equal(h.options.overlayOptions.width, "100%");
  assert.match(screen(h), /Latest question/);
  assert.deepEqual(h.entries, before);
  h.entries.push(entry("later", "assistant", "Not in this snapshot"));
  assert.doesNotMatch(screen(h), /Not in this snapshot/);
  h.viewer.handleInput("\x1b"); await pending;
});

test("message and line navigation revisit old answers, paging is bounded, and c copies the top message's source", { skip }, async () => {
  const h = await harness(); const pending = h.open();
  assert.match(screen(h), /Latest question/);
  h.viewer.handleInput("c"); await flush(); assert.equal(h.copies.at(-1), "Latest question 中文 😀");
  h.viewer.handleInput("\x1b[D");
  assert.match(screen(h), /Old answer/);
  h.viewer.handleInput("c"); await flush(); assert.equal(h.copies.at(-1), "Old answer\n\n```js\nconst value = 42;\n```");
  h.viewer.handleInput("\x1b[H"); assert.match(screen(h), /Old question/);
  for (let i = 0; i < 20; i++) h.viewer.handleInput("\x1b[5~");
  assert.match(screen(h), /Old question/);
  h.viewer.handleInput("\x1b[6~"); screen(h);
  h.viewer.handleInput("\x1b[F"); assert.match(screen(h), /Latest question/);
  h.viewer.handleInput("\x1b"); await pending;
});

test("long messages scroll, fit narrow Unicode viewports, and remain navigable after resizing and invalidation", { skip }, async () => {
  const h = await harness([entry("long", "assistant", Array.from({ length: 60 }, (_, i) => `Line-${i} 中文 😀 ${"x".repeat(90)}`).join("\n\n"))]);
  const pending = h.open();
  assert.match(screen(h), /Line-0/);
  h.viewer.handleInput("\x1b[6~"); assert.doesNotMatch(screen(h), /Line-0 中文/);
  h.viewer.handleInput("\x1b[F"); assert.match(screen(h), /Line-59/);
  for (const [width, height] of [[22, 10], [1, 1], [8, 3], [100, 30]]) {
    h.tui.terminal.rows = height; h.viewer.invalidate();
    const lines = h.viewer.render(width);
    assert.ok(lines.length <= height);
    for (const line of lines) assert.ok(h.visibleWidth(line) <= width, `${h.visibleWidth(line)} > ${width}`);
  }
  h.viewer.handleInput("\x1b[H"); assert.match(screen(h, 100), /Line-0/);
  h.viewer.handleInput("\x1b"); await pending;
});

test("large messages at narrow widths do not exceed JavaScript's function argument limit", { skip }, async () => {
  const h = await harness([entry("large", "user", "x".repeat(200_000))]);
  const pending = h.open();
  const lines = h.viewer.render(3);
  assert.equal(lines.length, h.tui.terminal.rows);
  for (const line of lines) assert.ok(h.visibleWidth(line) <= 3);
  h.viewer.handleInput("\x1b[F"); assert.doesNotThrow(() => h.viewer.render(3));
  h.viewer.handleInput("\x1b"); await pending;
});

test("invalidation and resizing retain the reading offset within a message", { skip }, async () => {
  const h = await harness([entry("long", "assistant", Array.from({ length: 80 }, (_, i) => `Line-${i}`).join("\n\n"))]);
  const pending = h.open(); screen(h);
  for (let i = 0; i < 4; i++) h.viewer.handleInput("\x1b[6~");
  const before = screen(h);
  assert.doesNotMatch(before, /Line-0\b/);
  h.viewer.invalidate(); assert.equal(screen(h), before);
  const resized = screen(h, 70);
  assert.equal(resized.match(/Line-\d+/)[0], before.match(/Line-\d+/)[0]);
  h.viewer.handleInput("\x1b"); await pending;
});

test("real session history remains readable before compaction without changing the session or model context", { skip }, async () => {
  const { SessionManager } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "Archived question", timestamp: 0 });
  const kept = manager.appendMessage({ role: "user", content: "Kept question", timestamp: 1 });
  manager.appendCompaction("Compacted summary should not replace archived text", kept, 1000);
  const before = structuredClone(manager.getEntries());
  const context = structuredClone(manager.buildContextEntries());
  const h = await harness(); h.ctx.sessionManager = manager;
  const pending = h.open(); screen(h); h.viewer.handleInput("\x1b[H");
  assert.match(screen(h), /Archived question/);
  assert.doesNotMatch(screen(h), /Compacted summary/);
  h.viewer.handleInput("\x1b"); await pending;
  assert.deepEqual(manager.getEntries(), before);
  assert.deepEqual(manager.buildContextEntries(), context);
});

test("unsupported modes, empty branches and arguments never open a viewer", { skip }, async () => {
  const h = await harness([]);
  await h.open(); assert.match(h.notices.at(-1).text, /No saved/);
  h.ctx.mode = "rpc"; await h.open(); assert.match(h.notices.at(-1).text, /interactive TUI/);
  h.ctx.mode = "tui"; await h.open("extra"); assert.match(h.notices.at(-1).text, /Usage/);
  assert.equal(h.opened, 0);
});

test("clipboard failure remains visible and a completed copy does not redraw a disposed overlay", { skip }, async () => {
  const h = await harness(); const pending = h.open(); screen(h);
  h.bus.on("chat-view:test-copy", query => { query.fail = true; });
  h.viewer.handleInput("c"); await flush(); assert.match(screen(h), /Clipboard copy failed/);
  let release;
  h.bus.on("chat-view:test-copy", query => { query.fail = false; query.wait = new Promise(resolve => { release = resolve; }); });
  h.viewer.handleInput("c");
  h.viewer.handleInput("\x1b"); await pending;
  const before = h.renders; release(); await flush(); assert.equal(h.renders, before);
});
