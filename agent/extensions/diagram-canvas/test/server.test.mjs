import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { DiagramStore } from "../store.ts";
import { startCanvasServer } from "../server.ts";
import { canvas, diagram } from "./fixture.mjs";

test("real loopback server: capability, origin/host checks, fixed assets, no filesystem serving", async t => {
  const { origin, headers, store } = await canvas(t); store.put(diagram());
  assert.equal((await fetch(`${origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${origin}/api/state`, { headers: { ...headers, Host: "example.com" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  const response = await fetch(`${origin}/api/state`, { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).diagrams[0].id, "request");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${origin}/api/state?since=${store.version}`, { headers })).status, 204);
  for (const route of ["/", "/app.js", "/app.css", "/render.js", "/vendor/mermaid.esm.min.mjs"]) assert.equal((await fetch(origin + route)).status, 200, route);
  for (const route of ["/agent/AGENTS.md", "/vendor/../../package.json", "/vendor/chunks/mermaid.esm.min/../../../package.json", "/vendor/mermaid.esm.min.mjs.map", "/api/unknown"]) assert.equal((await fetch(origin + route, { headers })).status, 404, route);
  assert.equal((await fetch(origin + "/", { method: "POST" })).status, 405);
});

test("browser feedback accepts current revision, rejects stale/oversized/malformed reports", async t => {
  const { origin, headers, store } = await canvas(t); const first = store.put(diagram());
  const post = (report, contentType = "application/json") => fetch(`${origin}/api/report`, { method: "POST", headers: { ...headers, "Content-Type": contentType }, body: typeof report === "string" ? report : JSON.stringify(report) });
  assert.equal((await post({ id: first.id, revision: first.revision, status: "error", message: "Parser failure" })).status, 200);
  assert.equal(store.status()[0].render.status, "error");
  store.put(diagram());
  assert.equal((await post({ id: first.id, revision: first.revision, status: "ok", message: "Old report" })).status, 409);
  assert.equal(store.status()[0].render.status, "pending");
  assert.equal((await post("{}", "text/plain")).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("x".repeat(13_000))).status, 400);
});

test("missing local Mermaid assets fail before starting a listener", async () => {
  await assert.rejects(startCanvasServer(new DiagramStore(), { webRoot: resolve("agent/extensions/diagram-canvas/web"), mermaidRoot: resolve("agent/extensions/diagram-canvas/web") }), /ENOENT/);
});

test("shutdown terminates active unfinished HTTP requests", { timeout: 5000 }, async t => {
  const { origin, server, headers } = await canvas(t);
  const url = new URL(origin), socket = connect(Number(url.port), "127.0.0.1");
  t.after(() => socket.destroy()); socket.on("error", () => {});
  const closed = new Promise(resolve => socket.once("close", resolve));
  await new Promise(resolve => socket.once("connect", resolve));
  socket.write(`POST /api/report HTTP/1.1\r\nHost: ${url.host}\r\nX-Canvas-Token: ${headers["X-Canvas-Token"]}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await server.close(); await closed;
});

test("closing server is idempotent and invalidates the old endpoint", async t => {
  const { origin, server } = await canvas(t); await server.close(); await server.close();
  await assert.rejects(fetch(origin));
});
