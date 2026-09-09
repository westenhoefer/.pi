import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagram } from "./fixture.mjs";

const piRoot = process.env.PI_TEST_PACKAGE_DIR;
const skip = !piRoot && "Set PI_TEST_PACKAGE_DIR for installed Pi-loader integration.";

test("Pi loads canvas without a listener; tools publish, report, remove, and shut down", { skip }, async t => {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("agent/extensions/diagram-canvas/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]; const notices = [];
  // pi.exec is a host implementation, not a runtime sink; no actual browser-open tool is called here.
  const ctx = { mode: "tui", hasUI: true, cwd: process.cwd(), sessionManager: { getSessionId: () => "canvas-test" }, ui: { setStatus: () => {}, notify: text => notices.push(text) } };
  const tool = (name, input = {}, context = ctx) => extension.tools.get(name).definition.execute("test", input, undefined, undefined, context);
  async function shutdown() { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx); }
  t.after(shutdown);
  assert.equal((await tool("diagram_status")).details.listening, false);
  await assert.rejects(tool("diagram_put", diagram(), { ...ctx, mode: "json", hasUI: false }), /interactive TUI/);
  assert.equal((await tool("diagram_status")).details.listening, false);
  await tool("diagram_put", diagram());
  const status = (await tool("diagram_status")).details;
  assert.equal(status.listening, true); assert.equal(status.diagrams[0].render.status, "pending");
  await tool("diagram_put", { ...diagram(), title: "Updated title" });
  assert.equal((await tool("diagram_status")).details.diagrams.length, 1);
  await tool("diagram_remove", { id: "request" });
  assert.equal((await tool("diagram_status")).details.diagrams.length, 0);
  await extension.commands.get("canvas").handler("status", ctx);
  assert.match(notices.at(-1), /Listening/);
  await shutdown(); assert.equal((await tool("diagram_status")).details.listening, false);
  await assert.rejects(tool("diagram_put", diagram()), /session has ended/);
});

test("shutdown during listener startup cannot resurrect a canvas", { skip }, async t => {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("agent/extensions/diagram-canvas/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const ctx = { mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "startup-race" }, ui: { setStatus: () => {} } };
  const pending = extension.tools.get("diagram_put").definition.execute("test", diagram(), undefined, undefined, ctx);
  const rejected = assert.rejects(pending, /closed during startup|closed before/);
  const shutdown = async () => { for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx); };
  t.after(shutdown); await shutdown(); await rejected;
  const status = await extension.tools.get("diagram_status").definition.execute("status", {}, undefined, undefined, ctx);
  assert.equal(status.details.listening, false); assert.deepEqual(status.details.diagrams, []);
});
