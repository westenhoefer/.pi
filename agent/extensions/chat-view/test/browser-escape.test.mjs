import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { claimBrowserEscape } from "../browser-escape.ts";

function terminal(enabled = true, tty = true) {
  const writes = [];
  return Object.assign(new EventEmitter(), { env: enabled ? { MCP_BROWSER_TERMINAL: "1" } : {}, pid: 42, stdout: { isTTY: tty, write: value => writes.push(value) }, writes });
}
test("only a browser terminal receives Escape ownership messages", () => {
  for (const host of [terminal(false), terminal(true, false)]) {
    claimBrowserEscape(host)();
    assert.deepEqual(host.writes, []);
    assert.equal(host.listenerCount("exit"), 0);
  }
});
test("closing an overlay releases exactly its claim and removes its exit listener", () => {
  const host = terminal();
  const release = claimBrowserEscape(host);
  assert.equal(host.writes.length, 1);
  const owner = host.writes[0].match(/^\x1b\]777;mcp-browser;escape;claim=(chat-view-42-\d+)\x07$/)?.[1];
  assert.ok(owner);
  release(); release(); host.emit("exit");
  assert.deepEqual(host.writes, [`\x1b]777;mcp-browser;escape;claim=${owner}\x07`, `\x1b]777;mcp-browser;escape;release=${owner}\x07`]);
  assert.equal(host.listenerCount("exit"), 0);
});
test("process exit also releases a pending overlay, and concurrent claims have distinct owners", () => {
  const host = terminal();
  const first = claimBrowserEscape(host), second = claimBrowserEscape(host);
  assert.notEqual(host.writes[0], host.writes[1]);
  host.emit("exit"); first(); second();
  assert.equal(host.writes.length, 4);
  assert.equal(host.listenerCount("exit"), 0);
});
