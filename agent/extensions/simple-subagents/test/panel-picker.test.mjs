import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for installed Pi picker integration.";
const key = { enter: "\r", tab: "\t", cancel: "\x1b", up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", backspace: "\x7f", clear: "\x15", home: "\x1b[H", end: "\x1b[F", left: "\x1b[D", delete: "\x1b[3~" };
const models = () => [
  { provider: "anthropic", id: "claude-opus", name: "Opus Bright" },
  { provider: "openai", id: "gpt-5", name: "Flagship Reasoner" },
  { provider: "openrouter", id: "openai/gpt-5", name: "Proxy Reasoner" },
  { provider: "local", id: "qwen3", name: "中文 e\u0301 😀" },
];
let api, bus, loaded, PanelModelPicker, fixture, originalKeys;

before(async () => {
  if (!root) return;
  api = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const theme = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  theme.initTheme("light", false);
  api = { ...api, theme: theme.theme };
  originalKeys = api.getKeybindings();
  const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
  const { createEventBus } = await import(pathToFileURL(join(root, "dist/core/event-bus.js")).href);
  bus = createEventBus();
  fixture = await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-panel-picker-"));
  await writeFile(join(fixture, "fixture.ts"), `
import { PanelModelPicker } from "../../panel-picker.ts";
import { registerPanel } from "../../panel.ts";
export default function (pi) {
  pi.events.on("test:picker", query => { query.Picker = PanelModelPicker; });
  registerPanel(pi, {
    async start(ctx, question, selections) {
      pi.events.emit("test:panel-start", { question, selections });
      return { swarmId: "mock-panel", taskCount: selections.length, effectiveParallelism: 2 };
    },
    read() { throw new Error("Unexpected panel read"); },
    stop() { throw new Error("Unexpected panel stop"); },
  });
}
`);
  // Exercise Pi's actual TS loader/host aliases, without a shared external jiti cache.
  const previous = process.env.JITI_FS_CACHE;
  process.env.JITI_FS_CACHE = "0";
  try { loaded = await loadExtensions([join(fixture, "fixture.ts")], process.cwd(), bus); }
  finally {
    if (previous === undefined) delete process.env.JITI_FS_CACHE;
    else process.env.JITI_FS_CACHE = previous;
  }
  assert.deepEqual(loaded.errors, []);
  const query = {};
  bus.emit("test:picker", query);
  PanelModelPicker = query.Picker;
  assert.equal(typeof PanelModelPicker, "function");
});

after(async () => {
  if (originalKeys) api.setKeybindings(originalKeys);
  if (!fixture) return;
  assert.equal(await realpath(fixture), fixture);
  assert.deepEqual(await readdir(fixture), ["fixture.ts"]);
  await rm(fixture, { recursive: true });
});

function harness(source = models(), options = {}) {
  const keys = new api.KeybindingsManager(api.TUI_KEYBINDINGS, options.bindings);
  // Input uses the host's global bindings; real custom UI receives that same manager.
  api.setKeybindings(keys);
  const results = [];
  let renders = 0;
  const tui = { terminal: { rows: options.rows ?? 20 }, requestRender() { renders++; } };
  const picker = new PanelModelPicker(source, tui, api.theme, keys, value => results.push(value));
  picker.focused = true;
  const render = (width = 180) => picker.render(width);
  const screen = (width = 180) => render(width).map(api.stripTerminalSequences).join("\n");
  return { picker, keys, tui, results, render, screen,
    press: name => picker.handleInput(key[name] ?? name),
    get renders() { return renders; },
  };
}
const rows = h => h.screen().split("\n").filter(line => /^(?:→ |  )\[[ x]\] /.test(line));
const active = h => rows(h).find(line => line.startsWith("→ "));
const ids = h => rows(h).map(line => line.match(/\[[ x]\] (.*?) \(/)[1]);
const query = h => h.screen().split("\n").find(line => line.startsWith("> ")).slice(2).trimEnd();
const chooseTwo = h => { h.press("enter"); h.press("down"); h.press("enter"); };
const paste = (h, text) => h.press(`\x1b[200~${text}\x1b[201~`);
// Input intentionally emits these internal APC sentinels for the host to resolve.
const rawOutput = h => [api.CURSOR_MARKER, ...api.renderFakeCursor("\0").split("\0")]
  .reduce((text, marker) => text.replaceAll(marker, ""), h.render().join("\n"));

function fits(h, width, height) {
  h.tui.terminal.rows = height;
  const lines = h.render(width);
  assert.ok(lines.length > 0 && lines.length <= height, `${lines.length} lines exceeds ${height}`);
  for (const line of lines) assert.ok(api.visibleWidth(line) <= width, `${api.visibleWidth(line)} columns exceeds ${width}`);
}

test("real Input filters while typing by display name, id and provider; Space is query text, not a toggle", { skip }, () => {
  const h = harness();
  assert.deepEqual(ids(h), ["anthropic/claude-opus", "openai/gpt-5", "openrouter/openai/gpt-5", "local/qwen3"]);
  for (const char of "FLAGSHIP") h.press(char);
  assert.deepEqual(ids(h), ["openai/gpt-5"]);
  assert.equal(query(h), "FLAGSHIP");
  h.press("clear"); h.press("qwn3");
  assert.deepEqual(ids(h), ["local/qwen3"]);
  h.press("clear"); h.press("anthropic");
  assert.deepEqual(ids(h), ["anthropic/claude-opus"]);
  h.press(" "); h.press("Bright");
  assert.equal(query(h), "anthropic Bright");
  assert.deepEqual(ids(h), ["anthropic/claude-opus"]);
  assert.match(h.screen(), /0 selected/);
  assert.deepEqual(h.results, []);
  assert.ok(h.renders >= 8);
});

test("pasted space/slash tokens intersect and native provider-first ranking beats proxy-provider IDs", { skip }, () => {
  const h = harness();
  for (const text of ["openai gpt-5", "openai/gpt-5", "Reasoner openai", "  openai / gpt-5  "]) {
    h.press("clear"); paste(h, text);
    assert.deepEqual(ids(h), ["openai/gpt-5", "openrouter/openai/gpt-5"]);
    assert.match(active(h), /openai\/gpt-5 \(/);
  }
  h.press("clear"); paste(h, "anthropic Reasoner");
  assert.deepEqual(ids(h), []);
  assert.match(h.screen(), /No matching models/);
  h.press("clear"); paste(h, " /  ");
  assert.equal(ids(h).length, 4);
  assert.deepEqual(h.results, []);
});

test("Unicode and grapheme backspace, cursor movement and forward deletion keep the real Input filter in sync", { skip }, () => {
  const h = harness();
  for (const char of ["中", "文", "😀"]) h.press(char);
  assert.equal(query(h), "中文😀");
  assert.deepEqual(ids(h), ["local/qwen3"]);
  h.press("backspace"); assert.equal(query(h), "中文");
  h.press("e\u0301"); assert.deepEqual(ids(h), ["local/qwen3"]);
  h.press("backspace"); assert.equal(query(h), "中文");
  h.press("backspace"); assert.equal(query(h), "中");
  h.press("clear"); paste(h, "gpt-X5");
  assert.deepEqual(ids(h), []);
  h.press("left"); h.press("backspace");
  assert.equal(query(h), "gpt-5");
  assert.equal(ids(h).length, 2);
  h.press("home"); h.press("delete");
  assert.equal(query(h), "pt-5");
  h.press("end"); h.press("backspace");
  assert.equal(query(h), "pt-");
  assert.deepEqual(h.results, []);
});

test("selections survive filtering and no matches; toggling off changes only the highlighted exact model", { skip }, () => {
  const h = harness();
  h.press("enter");
  h.press("Reasoner"); h.press("enter");
  assert.match(h.screen(), /2 selected/);
  h.press("clear"); h.press("zzzzzzzz");
  for (const input of ["up", "down", "pageDown", "pageUp", "enter"]) h.press(input);
  assert.deepEqual(ids(h), []);
  assert.match(h.screen(), /2 selected · 0\/4 matching/);
  assert.deepEqual(h.results, []);
  h.press("clear");
  assert.match(rows(h)[0], /\[x\] anthropic\/claude-opus/);
  assert.match(rows(h)[1], /\[x\] openai\/gpt-5/);
  h.press("enter"); // Deselect only Anthropic.
  h.press("down"); h.press("down"); h.press("enter");
  h.press("zzzzzzzz"); h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, [["openai/gpt-5", "openrouter/openai/gpt-5"]]);
});

test("zero/one selections cannot Start; even three selections require the separate Start action", { skip }, () => {
  const h = harness();
  h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, []);
  assert.match(h.screen(), /choose at least two/);
  h.press("tab"); h.press("enter");
  h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, []);
  h.press("tab"); h.press("down"); h.press("enter"); h.press("down"); h.press("enter");
  assert.match(h.screen(), /3 selected/);
  assert.deepEqual(h.results, []);
  h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, [["anthropic/claude-opus", "openai/gpt-5", "openrouter/openai/gpt-5"]]);
  const renders = h.renders;
  for (const input of ["enter", "cancel", "tab", "down", "text"]) h.press(input);
  assert.equal(h.results.length, 1);
  assert.equal(h.renders, renders);
});

test("Esc and Ctrl+C cancel from search or Start once, including after valid selection", { skip }, () => {
  for (const start of [false, true]) for (const cancel of ["cancel", "\x03"]) {
    const h = harness(); chooseTwo(h);
    if (start) h.press("tab");
    h.press(cancel);
    assert.deepEqual(h.results, [undefined]);
    const renders = h.renders;
    h.press("enter"); h.press(cancel); h.press("tab");
    assert.equal(h.results.length, 1);
    assert.equal(h.renders, renders);
  }
});

test("bracketed paste chunks never execute Enter, Tab, navigation or cancellation, even from Start", { skip }, () => {
  const h = harness(); chooseTwo(h); h.press("tab");
  for (const chunk of ["\x1b[200~", "Flagship", "\r", "\n", "\t", "\x1b[A", "\x1b", "\x1b[201~"]) {
    h.press(chunk);
    assert.deepEqual(h.results, []);
    assert.match(h.screen(), /2 selected/);
  }
  assert.match(query(h), /^Flagship/);
  assert.ok(!rawOutput(h).includes("\x1b[A"));
  h.press("clear"); h.press("Flagship");
  assert.deepEqual(ids(h), ["openai/gpt-5"]);
  assert.ok(h.render().some(line => line.includes(api.CURSOR_MARKER)));
  h.press("cancel"); assert.deepEqual(h.results, [undefined]);
});

test("single and chunked paste preserve ordinary Unicode query text and strip unsafe terminal controls", { skip }, () => {
  const h = harness();
  paste(h, "中文 😀"); assert.deepEqual(ids(h), ["local/qwen3"]);
  h.press("clear");
  for (const chunk of ["\x1b[200~openai ", "gpt-", "5\x1b[201~"]) h.press(chunk);
  assert.equal(query(h), "openai gpt-5");
  assert.equal(ids(h).length, 2);
  h.press("clear");
  paste(h, "Flagship\x1b[2J\x07\x9b\x1b]52;c;not-clipboard\x07\x1b_unsafe\x1b\\");
  const raw = rawOutput(h);
  for (const unsafe of ["\x1b[2J", "\x07", "\x9b", "\x1b]52", "not-clipboard", "\x1b_unsafe"]) assert.ok(!raw.includes(unsafe), JSON.stringify(unsafe));
  assert.deepEqual(ids(h), ["openai/gpt-5"]);
  assert.deepEqual(h.results, []);
});

test("injected navigation, paging, toggle, Start and cancel bindings override defaults and appear in hints", { skip }, () => {
  const source = Array.from({ length: 25 }, (_, n) => ({ provider: "p", id: `m${String(n).padStart(2, "0")}`, name: `Model ${n}` }));
  const h = harness(source, { bindings: {
    "tui.select.up": "k", "tui.select.down": "j", "tui.select.pageUp": "u", "tui.select.pageDown": "d",
    "tui.select.confirm": "ctrl+t", "tui.select.cancel": "q", "tui.input.tab": "ctrl+n",
    "tui.editor.deleteCharBackward": "ctrl+h",
  } });
  api.setKeybindings(new api.KeybindingsManager(api.TUI_KEYBINDINGS)); // List actions must use the injected manager.
  h.screen(); h.press("down"); assert.match(active(h), /p\/m00/);
  h.press("k"); assert.match(active(h), /p\/m24/);
  h.press("j"); assert.match(active(h), /p\/m00/);
  h.press("d"); assert.match(active(h), /p\/m10/);
  h.press("u"); assert.match(active(h), /p\/m00/);
  assert.match(h.screen(), /k\/j move · ctrl\+t toggle \/ Start · ctrl\+n Start\/filter · q cancel/);
  h.press("\x14"); h.press("j"); h.press("\x14");
  h.press("enter"); h.press("tab"); h.press("cancel");
  assert.deepEqual(h.results, []);
  h.press("\x0e"); h.press("\x14");
  assert.deepEqual(h.results, [["p/m00", "p/m01"]]);
  const cancelled = harness(models(), { bindings: { "tui.select.cancel": "q", "tui.editor.deleteCharBackward": "ctrl+h" } });
  cancelled.press("FlagshipX"); cancelled.press("\x08");
  assert.equal(query(cancelled), "Flagship");
  assert.deepEqual(ids(cancelled), ["openai/gpt-5"]);
  cancelled.press("q"); assert.deepEqual(cancelled.results, [undefined]);
});

test("Kitty printable/Enter and CSI navigation sequences use the real installed key parser", { skip }, () => {
  const h = harness();
  for (const char of "Flagship") h.press(`\x1b[${char.codePointAt(0)}u`);
  assert.deepEqual(ids(h), ["openai/gpt-5"]);
  h.press("\x1b[13u"); assert.match(h.screen(), /1 selected/);
  h.press("clear"); h.press("\x1b[1;1A"); // CSI Up wraps to the last model.
  assert.match(active(h), /local\/qwen3/);
  h.press("\x1b[13u"); h.press("\x1b[9u"); h.press("\x1b[13u");
  assert.deepEqual(h.results, [["openai/gpt-5", "local/qwen3"]]);
});

test("Focusable propagates Input IME cursor position only while searching, and disposal cannot refocus it", { skip }, () => {
  const h = harness();
  assert.equal(h.picker.capturesViewportInput, true);
  assert.equal(h.render().join("").split(api.CURSOR_MARKER).length - 1, 1);
  h.picker.focused = false; assert.ok(!h.render().join("").includes(api.CURSOR_MARKER));
  h.picker.focused = true; h.press("tab");
  assert.ok(!h.render().join("").includes(api.CURSOR_MARKER));
  h.press("Flagship");
  assert.ok(h.render().join("").includes(api.CURSOR_MARKER));
  h.picker.dispose(); h.picker.focused = true;
  assert.ok(!h.render().join("").includes(api.CURSOR_MARKER));
  const renders = h.renders;
  h.press("enter"); h.press("cancel");
  assert.deepEqual(h.results, []);
  assert.equal(h.renders, renders);
});

test("resize/narrow/tiny dimensions fit, preserve selections and search, and page by the visible list size", { skip }, () => {
  const source = Array.from({ length: 25 }, (_, n) => ({ provider: "提供者", id: `m${String(n).padStart(2, "0")}`, name: "中文 e\u0301 🇸🇪 👨‍👩‍👧‍👦 ".repeat(8) }));
  const h = harness(source);
  h.screen(); h.press("pageDown"); assert.match(active(h), /m10/);
  h.press("enter");
  h.tui.terminal.rows = 6; h.render(); h.press("pageDown");
  assert.match(active(h), /m11/);
  h.press("enter"); h.press("中文");
  for (const [width, height] of [[180, 20], [25, 8], [1, 1], [2, 2], [3, 3], [8, 4], [14, 5], [3, 6], [65, 14]]) {
    h.picker.invalidate(); fits(h, width, height);
    h.press("tab"); fits(h, width, height);
    h.press("tab"); fits(h, width, height);
  }
  h.tui.terminal.rows = 20;
  assert.equal(query(h), "中文");
  assert.match(h.screen(), /2 selected/);
  h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, [["提供者/m10", "提供者/m11"]]);
});

test("model metadata controls never reach rendering, while exact original IDs are returned unchanged", { skip }, () => {
  const source = [
    { provider: "p\x1b[2J\x07", id: "first\n\t\x9b", name: "Name\x1b]8;;https://invalid\x07link\x1b]8;;\x07\r\x1b_untrusted\x1b\\" },
    { provider: "other", id: "second", name: "中文 😀" },
  ];
  const before = structuredClone(source), h = harness(source);
  const raw = rawOutput(h);
  for (const unsafe of ["\x1b[2J", "\x07", "\x9b", "\x1b]8", "https://invalid", "\r", "\t", "\x1b_untrusted"]) assert.ok(!raw.includes(unsafe), JSON.stringify(unsafe));
  assert.equal(rows(h).length, 2);
  chooseTwo(h); h.press("tab"); h.press("enter");
  assert.deepEqual(h.results, [["p\x1b[2J\x07/first\n\t\x9b", "other/second"]]);
  assert.deepEqual(source, before);
});

function commandHarness(t, options = {}) {
  const source = options.available ?? models(), starts = [], notices = [], entries = [];
  let picker, customOptions;
  const unsubscribe = bus.on("test:panel-start", value => starts.push(value));
  t.after(unsubscribe);
  const keys = new api.KeybindingsManager(api.TUI_KEYBINDINGS);
  api.setKeybindings(keys);
  loaded.runtime.appendEntry = (customType, data) => entries.push({ customType, data });
  const ctx = {
    mode: "tui", thinkingLevel: "high", scopedModels: options.scope,
    modelRegistry: { getAvailable: () => source, streamSimple() { assert.fail("No live model calls"); }, complete() { assert.fail("No live model calls"); } },
    ui: {
      notify: message => notices.push(message),
      editor: async () => options.question,
      custom(factory, config) {
        customOptions = config;
        return new Promise(done => {
          picker = factory({ terminal: { rows: 20 }, requestRender() {} }, api.theme, keys, done);
          picker.focused = true;
        });
      },
    },
  };
  return { ctx, starts, notices, entries,
    open: (args = "A self-contained question") => loaded.extensions[0].commands.get("panel").handler(args, ctx),
    get picker() { return picker; }, get customOptions() { return customOptions; },
  };
}

test("real-loader command adapter waits for explicit Start and retains authenticated scope and thinking policy", { skip }, async t => {
  const h = commandHarness(t, { scope: [
    { model: models()[0], thinkingLevel: "medium" }, { model: models()[1] },
    { model: { provider: "unavailable", id: "no-auth", name: "Not authenticated" }, thinkingLevel: "low" },
  ] });
  const opening = h.open();
  assert.equal(h.customOptions.blocked.kind, "question");
  assert.doesNotMatch(h.picker.render(200).join("\n"), /openrouter|local\/qwen3|no-auth/);
  for (const input of ["\r", "\x1b[B", "\r"]) h.picker.handleInput(input);
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.entries, []);
  h.picker.handleInput("\t"); h.picker.handleInput("\r"); await opening;
  assert.deepEqual(h.starts, [{ question: "A self-contained question", selections: [
    { provider: "anthropic", model: "claude-opus", thinking: "medium" },
    { provider: "openai", model: "gpt-5", thinking: "high" },
  ] }]);
  assert.deepEqual(h.entries, [{ customType: "simple-panel", data: { id: "mock-panel" } }]);
});

test("an empty scope includes all available models and absent parent thinking remains off", { skip }, async t => {
  const h = commandHarness(t, { scope: [] });
  h.ctx.thinkingLevel = undefined;
  const opening = h.open();
  assert.match(h.picker.render(200).join("\n"), /openrouter\/openai\/gpt-5/);
  for (const input of ["Proxy", "\r", "\x15", "中文", "\r", "\t", "\r"]) h.picker.handleInput(input);
  await opening;
  assert.deepEqual(h.starts[0].selections, [
    { provider: "openrouter", model: "openai/gpt-5", thinking: "off" },
    { provider: "local", model: "qwen3", thinking: "off" },
  ]);
});

test("Start revalidates availability and never falls back if authentication/catalog availability changed", { skip }, async t => {
  const available = models().slice(0, 2), h = commandHarness(t, { available });
  const opening = h.open();
  for (const input of ["\r", "\x1b[B", "\r"]) h.picker.handleInput(input);
  available.pop();
  h.picker.handleInput("\t"); h.picker.handleInput("\r"); await opening;
  assert.deepEqual(h.starts, []); assert.deepEqual(h.entries, []);
  assert.match(h.notices[0], /Model unavailable: openai\/gpt-5/);
});

test("command editor/picker cancellation and too-small authenticated scope start nothing", { skip }, async t => {
  for (const focusStart of [false, true]) {
    const h = commandHarness(t), opening = h.open();
    for (const input of ["\r", "\x1b[B", "\r", ...(focusStart ? ["\t"] : []), "\x1b"]) h.picker.handleInput(input);
    await opening; assert.deepEqual(h.starts, []); assert.deepEqual(h.entries, []);
  }
  const editor = commandHarness(t, { question: undefined });
  await editor.open(""); assert.equal(editor.picker, undefined); assert.deepEqual(editor.starts, []);
  const small = commandHarness(t, { scope: [{ model: models()[0] }] });
  await small.open(); assert.equal(small.picker, undefined); assert.deepEqual(small.starts, []);
  assert.match(small.notices[0], /At least two authenticated models/);
});
