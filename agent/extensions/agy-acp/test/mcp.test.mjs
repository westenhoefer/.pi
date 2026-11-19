import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startBridge } from "../mcp.ts";

const JSON_TYPE = "application/json";
const SSE = "text/event-stream";
const SCHEMA = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
const TOOL = { name: "echo", description: "Echo a value", parameters: SCHEMA };
const result = (id, data) => ({ jsonrpc: "2.0", id, result: data });
const message = (method, id, params) => ({ jsonrpc: "2.0", method, id, params });
const toolCall = (id = 1, name = "pi__echo", args) => message("tools/call", id, { name, arguments: args });

function send(server, { headers, body, path, method = "POST" }) {
  const url = new URL(server.url);
  if (path !== undefined) url.pathname = path;
  let req;
  const done = new Promise((resolve, reject) => {
    req = request(url, { method, headers, agent: false }, res => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
  return { req, done };
}

async function fixture(t, tools = [TOOL], onCall = async () => assert.fail("Unexpected tool dispatch")) {
  const bridge = await startBridge(tools, onCall);
  t.after(() => bridge.close());
  const { mcpServer } = bridge;
  const auth = Object.fromEntries(mcpServer.headers.map(({ name, value }) => [name, value]));
  const headers = { "Content-Type": JSON_TYPE, Accept: JSON_TYPE, ...auth };
  return {
    ...bridge,
    post(value, overrides = {}) {
      return send(mcpServer, { ...overrides, headers: { ...headers, ...overrides.headers }, body: JSON.stringify(value) });
    },
    send(overrides = {}) {
      return send(mcpServer, { ...overrides, headers: { ...headers, ...overrides.headers } });
    },
  };
}

function json(response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], JSON_TYPE);
  return JSON.parse(response.text);
}

function sse(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], SSE);
  const match = /^event: message\ndata: (.+)\n\n$/.exec(response.text);
  assert.ok(match, "expected one SSE message frame");
  return JSON.parse(match[1]);
}

test("ACP descriptor authenticates only the fixed loopback endpoint", { timeout: 5000 }, async t => {
  let dispatched = 0;
  const bridge = await fixture(t, [TOOL], async () => {
    dispatched++;
    return { content: [] };
  });
  const { type, name, url, headers } = bridge.mcpServer;
  assert.equal(type, "http");
  assert.equal(name, "pi_tools");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(headers.length, 1);
  assert.equal(headers[0].name, "Authorization");
  assert.ok(/^Bearer [a-zA-Z0-9_-]{43}$/.test(headers[0].value));
  const ping = message("ping", 1);
  const call = toolCall();
  const unauthenticated = await send(bridge.mcpServer, {
    headers: { "Content-Type": JSON_TYPE, Accept: JSON_TYPE }, body: JSON.stringify(call),
  }).done;
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers["www-authenticate"], "Bearer");
  const wrongToken = `${headers[0].value.slice(0, -1)}${headers[0].value.endsWith("A") ? "B" : "A"}`;
  assert.equal((await bridge.post(call, { headers: { Authorization: wrongToken } }).done).status, 401);
  assert.equal((await bridge.post(call, { headers: { Host: "localhost" } }).done).status, 403);
  assert.equal((await bridge.post(call, { headers: { Origin: "https://example.invalid" } }).done).status, 403);
  assert.equal((await bridge.post(call, { path: "/different" }).done).status, 404);
  assert.equal(dispatched, 0);
  assert.equal((await bridge.send({ method: "GET", headers: { Accept: SSE } }).done).status, 405);
  assert.deepEqual(json(await bridge.post(ping, { headers: { Origin: new URL(url).origin } }).done), result(1, {}));
});

test("initializes MCP and lists only valid, unique allowlisted names", { timeout: 5000 }, async t => {
  const bridge = await fixture(t, [TOOL, { ...TOOL, description: "Duplicate" }, { ...TOOL, name: "with spaces" },
    { ...TOOL, name: "trailing\n" }, { name: "show-status", parameters: undefined }]);
  const accept = { headers: { Accept: `${JSON_TYPE}, ${SSE}` } };
  const initialize = protocolVersion => message("initialize", 1, { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "future"]) {
    const initialization = json(await bridge.post(initialize(version), accept).done);
    assert.equal(initialization.id, 1);
    assert.equal(initialization.result.protocolVersion, version === "future" ? "2025-11-25" : version);
    assert.equal(initialization.result.serverInfo.name, "pi_tools");
    assert.deepEqual(initialization.result.capabilities, { tools: {} });
  }
  assert.equal((await bridge.post(message("notifications/initialized"), accept).done).status, 202);
  const catalog = json(await bridge.post(message("tools/list", "catalog"), { headers: { "MCP-Protocol-Version": "2025-06-18" } }).done);
  assert.deepEqual(catalog, result("catalog", { tools: [
    { name: "pi__echo", description: "Echo a value", inputSchema: SCHEMA },
    { name: "pi__show-status", inputSchema: { type: "object", properties: {} } },
  ] }));
  assert.equal((await bridge.post(message("tools/list", 2), { headers: { "MCP-Protocol-Version": "future" } }).done).status, 400);
  assert.equal(json(await bridge.post(message("unknown", 3)).done).error.code, -32601);
});

test("dispatches exact names as original Pi names and relays text, images and tool errors", { timeout: 5000 }, async t => {
  const observed = [];
  const answer = { content: [
    { type: "text", text: "line one\nline two" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ], isError: true };
  const bridge = await fixture(t, [TOOL], async (name, args, signal) => {
    observed.push({ name, args, aborted: signal.aborted });
    if (args.throw) throw new Error("details private to parent");
    return answer;
  });
  assert.equal(json(await bridge.post(toolCall(1, "echo")).done).error.code, -32602);
  assert.equal(json(await bridge.post(toolCall(2, "pi__missing")).done).error.code, -32602);
  assert.equal(json(await bridge.post(toolCall(3, "pi__echo", [])).done).error.code, -32602);
  assert.equal((await bridge.post(message("tools/call", undefined, { name: "pi__echo" })).done).status, 202);
  assert.deepEqual(observed, []);
  assert.deepEqual(sse(await bridge.post(toolCall(4, "pi__echo", { value: "hello" }), {
    headers: { Accept: `${JSON_TYPE}, ${SSE}` },
  }).done), result(4, answer));
  assert.deepEqual(json(await bridge.post(toolCall(5)).done), result(5, answer));
  assert.deepEqual(json(await bridge.post(toolCall(6, "pi__echo", { throw: true })).done), result(6, {
    content: [{ type: "text", text: "Tool execution failed" }], isError: true,
  }));
  assert.deepEqual(observed, [
    { name: "echo", args: { value: "hello" }, aborted: false },
    { name: "echo", args: {}, aborted: false },
    { name: "echo", args: { throw: true }, aborted: false },
  ]);
});

test("rejects unparseable and oversized request bodies without calling a tool", { timeout: 5000 }, async t => {
  const bridge = await fixture(t);
  const parse = json(await bridge.send({ body: "{" }).done, 400);
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);
  const body = JSON.stringify(toolCall(1, "pi__echo", { value: "x".repeat(1024 * 1024) }));
  assert.equal((await bridge.send({ headers: { "Content-Length": Buffer.byteLength(body) } }).done).status, 413);
  assert.equal((await bridge.send({ body, headers: { "Transfer-Encoding": "chunked" } }).done).status, 413);
});

for (const mode of ["disconnect", "cancel", "close"]) {
  test(`${mode} aborts a parked call without waiting for the callback to settle`, { timeout: 5000 }, async t => {
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const bridge = await fixture(t, [TOOL], (_name, _args, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(signal.aborted), { once: true });
      started.resolve();
      return new Promise(() => {});
    });
    const call = bridge.post(toolCall(), { headers: { Accept: `${JSON_TYPE}, ${SSE}` } });
    const outcome = call.done.catch(error => error);
    await started.promise;
    if (mode === "disconnect") call.req.destroy();
    if (mode === "cancel") assert.equal((await bridge.post(message("notifications/cancelled", undefined, { requestId: 1 })).done).status, 202);
    if (mode === "close") await Promise.all([bridge.close(), bridge.close()]);
    assert.equal(await aborted.promise, true);
    if (mode === "cancel") {
      assert.equal(sse(await outcome).result.isError, true);
    } else {
      assert.ok(await outcome instanceof Error);
    }
    if (mode === "close") {
      await assert.rejects(bridge.post(message("ping", 2)).done, { code: "ECONNREFUSED" });
    } else {
      assert.deepEqual(json(await bridge.post(message("ping", 2)).done), result(2, {}));
    }
  });
}
