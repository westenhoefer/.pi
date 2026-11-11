import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_TEST_PACKAGE_DIR;
const skip = !root && "Set PI_TEST_PACKAGE_DIR for installed Pi UI integration.";
const flush = () => new Promise(resolve => setImmediate(resolve));
const key = { left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", cancel: "\x1b" };
const prose = prefix => Array.from({ length: 80 }, (_, index) => `${prefix}-${index} 中文 😀`).join("\n\n");
const snapshot = () => ({
  id: "panel-1", question: "Which approach?", state: "completed", comparisonModel: "provider/judge",
  comparison: "## Comparison\n\n**Prefer A.**\n\n```js\nconst winner = 'A';\n```",
  members: [
    { id: "a", model: "provider/alpha", thinking: "high", state: "succeeded", answer: "## Alpha answer\n\nA is **best**." },
    { id: "b", model: "provider/beta", thinking: "off", state: "succeeded", answer: "Beta answer\n\n| Choice | Score |\n|---|---|\n| B | 2 |" },
  ],
});
let modules;
async function installed() {
  if (!modules) modules = (async () => {
    const tuiPath = join(root, "node_modules/@earendil-works/pi-tui/dist/index.js");
    const tui = await import(pathToFileURL(tuiPath).href);
    const theme = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
    const { createJiti } = await import(pathToFileURL(join(root, "node_modules/jiti/lib/jiti.mjs")).href);
    // Like Pi's extension loader, transpile TS and alias the host TUI; never write a shared jiti cache.
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@earendil-works/pi-tui": tuiPath } });
    const { PanelViewer } = await jiti.import(resolve("agent/extensions/simple-subagents/panel-viewer.ts"));
    return { ...tui, theme, PanelViewer };
  })();
  return modules;
}

async function harness(source = snapshot(), options = {}) {
  const { PanelViewer, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences, theme } = await installed();
  theme.initTheme("light", false);
  let renders = 0, closed = 0, reads = 0;
  const copies = [];
  const tui = { terminal: { rows: options.rows ?? 20 }, requestRender: () => { renders++; } };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, options.bindings);
  const viewer = new PanelViewer(source, tui, theme.theme, theme.getMarkdownTheme(), keys,
    () => { closed++; },
    text => { copies.push(text); return options.copy ? options.copy(text) : Promise.resolve(); },
    () => { reads++; return options.refresh ? options.refresh() : source; });
  return { viewer, tui, keys, copies, visibleWidth, theme,
    render: (width = 100) => viewer.render(width),
    screen: (width = 100) => viewer.render(width).map(stripTerminalSequences).join("\n"),
    press: name => viewer.handleInput(key[name] ?? name),
    get renders() { return renders; }, get closed() { return closed; }, get reads() { return reads; },
  };
}
const body = (h, width = 100) => h.screen(width).split("\n").slice(2, -1).join("\n");
const firstMarker = (h, prefix, width = 100) => body(h, width).match(new RegExp(`${prefix}-\\d+`))?.[0];

function fits(h, width, height) {
  h.tui.terminal.rows = height;
  const lines = h.render(width);
  assert.equal(lines.length, Math.max(1, height));
  for (const line of lines) assert.ok(h.visibleWidth(line) <= width, `${h.visibleWidth(line)} columns exceeds ${width}`);
}

test("Comparison is the default real Markdown tab; model tabs wrap without editing or hidden reads", { skip }, async () => {
  const source = snapshot(), before = structuredClone(source);
  const h = await harness(source);
  assert.match(h.screen(), /\[Comparison\]/);
  assert.match(body(h), /Prefer A\./);
  assert.doesNotMatch(body(h), /\*\*Prefer/);
  assert.match(body(h), /const winner = 'A';/);
  h.press("right");
  assert.match(h.screen(), /\[provider\/alpha\]/);
  assert.match(body(h), /Alpha answer/);
  assert.doesNotMatch(body(h), /winner/);
  h.press("right"); assert.match(h.screen(), /\[provider\/beta\]/);
  assert.match(body(h), /Choice.*Score/);
  h.press("right"); assert.match(h.screen(), /\[Comparison\]/);
  h.press("left"); assert.match(h.screen(), /\[provider\/beta\]/);
  h.press("Enter"); h.press("some ordinary text");
  assert.equal(h.closed, 0);
  assert.equal(h.reads, 0);
  assert.deepEqual(h.copies, []);
  assert.deepEqual(source, before);
});

test("line/page keys and Home/End are bounded, with independent tab positions across switches", { skip }, async () => {
  const source = snapshot();
  source.comparison = prose("Compare");
  source.members[0].answer = prose("Alpha");
  const h = await harness(source, { rows: 12 });
  h.screen();
  for (let i = 0; i < 3; i++) { h.press("pageDown"); h.screen(); }
  const comparison = body(h);
  assert.match(comparison, /Compare-/);
  assert.doesNotMatch(comparison, /Compare-0\b/);
  h.press("right"); h.screen();
  h.press("pageDown"); h.screen(); h.press("down");
  const answer = body(h);
  h.press("left"); assert.equal(body(h), comparison);
  h.press("right"); assert.equal(body(h), answer);
  h.press("up"); const up = body(h); assert.notEqual(up, answer);
  h.press("down"); assert.equal(body(h), answer);
  h.press("end"); assert.match(body(h), /Alpha-79\b/);
  const bottom = body(h);
  for (let i = 0; i < 10; i++) h.press("pageDown");
  assert.equal(body(h), bottom);
  h.press("home"); assert.match(body(h), /Question:/);
  const top = body(h);
  for (let i = 0; i < 10; i++) h.press("pageUp");
  assert.equal(body(h), top);
});

test("invalidation, width and height changes retain each tab's section reading offset", { skip }, async () => {
  const source = snapshot(); source.comparison = prose("Compare"); source.members[0].answer = prose("Alpha");
  const h = await harness(source, { rows: 12 });
  h.screen();
  for (let i = 0; i < 4; i++) { h.press("pageDown"); h.screen(); }
  const before = body(h), marker = firstMarker(h, "Compare");
  h.viewer.invalidate(); assert.equal(body(h), before);
  assert.equal(firstMarker(h, "Compare", 45), marker);
  h.tui.terminal.rows = 15;
  assert.equal(firstMarker(h, "Compare", 65), marker);
  h.press("right"); h.screen(65); h.press("pageDown"); h.screen(65);
  const alpha = firstMarker(h, "Alpha", 65);
  h.viewer.invalidate(); h.press("left");
  assert.equal(firstMarker(h, "Compare", 65), marker);
  h.press("right"); assert.equal(firstMarker(h, "Alpha", 65), alpha);
});

test("only r refreshes the captured snapshot; refresh preserves member identity and reading position", { skip }, async () => {
  const source = snapshot(); source.members[0].answer = prose("Alpha");
  const h = await harness(source, { rows: 12 });
  h.screen(); h.press("right"); h.screen();
  for (let i = 0; i < 3; i++) { h.press("pageDown"); h.screen(); }
  const alpha = firstMarker(h, "Alpha"), frozen = h.screen();
  source.state = "interrupted";
  source.reason = "Added reason grows metadata";
  source.recoveryWarning = "Recorded work is not supervised here";
  source.members.reverse();
  source.members.find(member => member.id === "a").answer += "\n\nREFRESH-ONLY";
  source.comparison = "Replacement comparison";
  h.viewer.invalidate(); assert.equal(h.screen(), frozen);
  h.screen(90); h.screen(100); h.press("up"); h.press("down");
  assert.equal(h.reads, 0);
  h.press("r"); assert.equal(h.reads, 1);
  assert.match(h.screen(), /\[provider\/alpha\]/);
  assert.match(h.screen(), /interrupted/);
  assert.equal(firstMarker(h, "Alpha"), alpha);
  h.press("end"); assert.match(body(h), /REFRESH-ONLY/);
  h.press("right"); // Alpha is now last, so this returns to Comparison.
  h.screen(); h.press("end"); assert.match(h.screen(), /Replacement comparison/);
  h.press("home");
  assert.match(h.screen(), /Added reason/);
  assert.match(h.screen(), /not supervised here/);
  assert.deepEqual(h.copies, []);
  assert.equal(h.reads, 1);
});

test("refresh keeps comparison scroll, removes absent members safely, and reports read failure without details", { skip }, async () => {
  let source = snapshot(), fail = false;
  source.comparison = prose("Compare");
  const h = await harness(source, { rows: 12, refresh: () => {
    if (fail) throw new Error("private path\x1b[2J secret");
    return source;
  } });
  h.screen();
  for (let i = 0; i < 3; i++) { h.press("pageDown"); h.screen(); }
  const marker = firstMarker(h, "Compare");
  source = { ...source, reason: "New metadata", comparison: source.comparison + "\n\nNew ending" };
  h.press("r"); assert.equal(firstMarker(h, "Compare"), marker);
  const retained = body(h);
  fail = true; h.press("r");
  assert.equal(body(h), retained);
  assert.match(h.screen(), /Snapshot refresh failed/);
  assert.doesNotMatch(h.screen(), /private path|secret/);
  fail = false; h.press("right"); h.screen();
  source = { ...source, members: [] }; h.press("r");
  assert.match(h.screen(), /\[Comparison\]/);
  h.press("right"); assert.match(h.screen(), /\[Comparison\]/);
  assert.equal(h.reads, 3);
});

test("run/member states, errors, recovery and retained-data truncation are explicit without inventing comparison", { skip }, async () => {
  const states = ["queued", "running", "failed", "cancelled", "interrupted"];
  for (const state of states) {
    const source = { id: `state-${state}`, question: "Pending question", state, reason: "Run reason", recoveryWarning: "Recovery warning detail",
      comparisonTruncated: true,
      members: [{ id: "m", model: "model-x", thinking: "low", state, answerTruncated: true, error: "Recorded error" }] };
    const h = await harness(source, { rows: 35 });
    const screen = h.screen();
    assert.match(screen, new RegExp(`Run: ${state}`));
    assert.match(screen, new RegExp(`model-x \\(low\\): ${state}`));
    assert.match(screen, /Reason: Run reason/);
    assert.match(screen, /Recovery warning: Recovery warning detail/);
    assert.match(screen, /Error: Recorded error/);
    assert.match(screen, /Comparison truncated/);
    assert.match(screen, /answer truncated/);
    assert.match(screen, /Comparison pending \/ not available/);
    h.press("c"); await flush(); assert.match(h.screen(), /No comparison to copy/);
    h.press("right");
    assert.match(h.screen(), new RegExp(`state: ${state}`));
    assert.match(h.screen(), /Answer truncated/);
    assert.match(h.screen(), /No answer available/);
    h.press("c"); await flush(); assert.match(h.screen(), /No answer to copy/);
    assert.deepEqual(h.copies, []);
    h.press("cancel"); assert.equal(h.closed, 1);
    assert.equal(h.reads, 0);
    assert.equal(source.state, state);
  }
});

test("c copies only the selected raw retained Markdown, never question, metadata or other answers", { skip }, async () => {
  const source = snapshot(); source.comparison = "  ## Exact comparison\n\n**raw**\n";
  source.comparisonTruncated = true;
  source.members[0].answer = "\tExact answer\n```ts\nconst n = 1;\n```\n";
  source.members[0].answerTruncated = true;
  const h = await harness(source);
  h.screen(); assert.deepEqual(h.copies, []);
  h.press("c"); await flush();
  assert.deepEqual(h.copies, [source.comparison]);
  assert.match(h.screen(), /Raw Markdown copied/);
  h.press("right"); h.screen(); h.press("end"); h.screen(); h.press("c"); await flush();
  assert.deepEqual(h.copies, [source.comparison, source.members[0].answer]);
  assert.equal(h.reads, 0);
});

test("configured selection keys navigate and cancel only closes the viewer once", { skip }, async () => {
  const source = snapshot(); source.members[0].answer = prose("Alpha");
  const h = await harness(source, { rows: 12, bindings: {
    "tui.select.up": "k", "tui.select.down": "j", "tui.select.pageUp": "u", "tui.select.pageDown": "d", "tui.select.cancel": "q",
  } });
  h.press("right"); const top = body(h);
  h.press("down"); assert.equal(body(h), top);
  h.press("j"); const down = body(h); assert.notEqual(down, top);
  h.press("k"); assert.equal(body(h), top);
  h.press("d"); assert.notEqual(body(h), top);
  h.press("u"); assert.equal(body(h), top);
  h.press("cancel"); assert.equal(h.closed, 0);
  const before = structuredClone(source);
  h.press("q"); h.press("q"); h.press("r"); h.press("c");
  assert.equal(h.closed, 1);
  assert.equal(h.reads, 0);
  assert.deepEqual(h.copies, []);
  assert.deepEqual(source, before);
});

test("clipboard errors are safe and neither successful nor failed late copies redraw a disposed viewer", { skip }, async () => {
  const failed = await harness(snapshot(), { copy: async () => { throw new Error("secret\x1b[2J"); } });
  failed.screen(); failed.press("c"); await flush();
  assert.match(failed.screen(), /Clipboard copy failed/);
  assert.doesNotMatch(failed.screen(), /secret/);
  for (const reject of [false, true]) {
    let finish;
    const h = await harness(snapshot(), { copy: () => new Promise((resolve, fail) => { finish = () => reject ? fail(new Error("late")) : resolve(); }) });
    h.screen(); h.press("c"); h.press("c");
    assert.equal(h.copies.length, 1);
    if (reject) h.viewer.dispose(); else h.press("cancel");
    const renders = h.renders;
    finish(); await flush();
    assert.equal(h.renders, renders);
    h.press("r"); assert.equal(h.reads, 0);
  }
});

test("Unicode, long labels, Markdown, and terminal controls fit full-width narrow/tiny layouts after resize", { skip }, async () => {
  const source = snapshot();
  source.id = "面板 👨‍👩‍👧‍👦";
  source.question = "Unicode 中文 e\u0301 🇸🇪 👨‍👩‍👧‍👦\x1b[2J\x07";
  source.members[0].model = "provider/超長名稱😀".repeat(5);
  source.members[0].error = "Error\x1b[2J\x07text";
  source.members[0].answer = "## Unicode 中文 😀\n\n" + "👨‍👩‍👧‍👦 e\u0301 🇸🇪 中文 ".repeat(25) + "\n\n```js\nconst x = 42;\n```";
  const h = await harness(source);
  for (let tab = 0; tab < 3; tab++) {
    for (const [width, height] of [[100, 20], [22, 10], [1, 1], [2, 2], [8, 3], [3, 9], [65, 14]]) {
      h.viewer.invalidate(); fits(h, width, height);
      h.press("end"); fits(h, width, height);
      h.press("home");
    }
    h.press("right");
  }
  h.tui.terminal.rows = 25; h.press("right");
  const output = h.render(100).join("\n");
  assert.ok(!output.includes("\x1b[2J") && !output.includes("\x07"));
  assert.match(h.screen(), /Error.*text/);
  h.press("cancel"); assert.equal(h.closed, 1);
});

test("theme invalidation rebuilds styled Markdown and chrome without changing content or position", { skip }, async () => {
  const source = snapshot(); source.members = [];
  source.comparison = "## Compare heading\n\n" + prose("Compare") + "\n\n## Ending heading";
  const h = await harness(source, { rows: 12 });
  const initialText = body(h), initialMarkdownAnsi = h.render().slice(2, -1).join("\n");
  assert.match(initialText, /Compare heading/);
  h.press("pageDown"); h.screen(); h.press("pageDown");
  const text = body(h), oldAnsi = h.render().join("\n");
  h.theme.initTheme("dark", false); h.viewer.invalidate();
  assert.equal(body(h), text);
  assert.notEqual(h.render().join("\n"), oldAnsi);
  h.press("home"); assert.equal(body(h), initialText);
  assert.notEqual(h.render().slice(2, -1).join("\n"), initialMarkdownAnsi);
  h.press("end");
  assert.match(body(h), /Ending heading/);
  fits(h, 33, 10);
  assert.equal(h.reads, 0);
});

test("large narrow Markdown is rendered without spreading all rows into a function call", { skip }, async () => {
  const source = snapshot(); source.comparison = "x".repeat(150_000);
  const h = await harness(source, { rows: 10 });
  fits(h, 1, 10);
  h.press("end"); assert.doesNotThrow(() => h.render(1));
  h.viewer.dispose();
});
