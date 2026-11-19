import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../acp.ts";
import { agyLaunch } from "../launch.ts";

const windows = process.platform === "win32";
const fixture = name => fileURLToPath(new URL(`./fixtures with spaces/${name}`, import.meta.url));
const native = { command: process.execPath, args: [fixture("acp-fixture.mjs")] };
const guard = { timeout: 10_000 };

function client(t, { launch = native, onUpdate = () => {}, onPermission = async () => { throw new Error("No approval"); } } = {}) {
  const connection = new AcpClient(launch, { cwd: fileURLToPath(new URL(".", import.meta.url)), onUpdate, onPermission });
  t.after(() => connection.close());
  return connection;
}

test("launch uses a fixed argument list and a platform-specific default", () => {
  assert.throws(() => agyLaunch({ PI_AGY_ACP_COMMAND: "agy" }), /absolute/);
  assert.throws(() => agyLaunch({ PI_AGY_ACP_COMMAND: "" }), /absolute/);
  assert.deepEqual(agyLaunch({ PI_AGY_ACP_COMMAND: process.execPath }), {
    command: process.execPath, args: ["acp", "--stdio"],
  });
  if (windows) {
    assert.throws(() => agyLaunch({}), /USERPROFILE/);
    assert.throws(() => agyLaunch({ PI_AGY_ACP_COMMAND: "\\agy.cmd" }), /absolute/);
    const launch = agyLaunch({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Space User" });
    assert.deepEqual(launch, {
      command: "C:\\Windows\\System32\\cmd.exe", windowsVerbatimArguments: true,
      args: ["/d", "/s", "/v:off", "/c", '""C:\\Space User\\bin\\agy.cmd" acp --stdio"'],
    });
    for (const char of ['%', '!', '&', '^', '(', ')', '"', '|', '<', '>']) {
      assert.throws(() => agyLaunch({ PI_AGY_ACP_COMMAND: `C:\\secret${char}fixture.bAt` }), error => {
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    }
  } else {
    assert.deepEqual(agyLaunch({}), { command: "agy", args: ["acp", "--stdio"] });
  }
});

test("Windows launches a path with spaces through cmd, carries stdio, and kills the live wrapper tree", { ...guard, skip: !windows }, async t => {
  const launch = agyLaunch({ PI_AGY_ACP_COMMAND: fixture("agy-fixture.cmd").replaceAll("\\", "/") });
  const connection = client(t, { launch });
  const workerPid = await connection.request("stay-alive", {}, { timeoutMs: 2000 });
  assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
  assert.equal(process.kill(workerPid, 0), true); // Read-only liveness check of the fixture's own PID.
  const pending = assert.rejects(connection.request("hold", {}), /closed/);
  const closed = connection.close();
  assert.equal(connection.close(), closed);
  await pending;
  await closed;
  assert.equal(connection.alive, false);
  assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
});

test("an already-exited Windows wrapper does not count as confirmed tree teardown", { ...guard, skip: !windows }, async () => {
  const launch = agyLaunch({ PI_AGY_ACP_COMMAND: fixture("agy-fixture.cmd") });
  const connection = new AcpClient(launch, { cwd: fileURLToPath(new URL(".", import.meta.url)), onUpdate() {}, async onPermission() {} });
  try {
    assert.equal(await connection.request("final-frame", {}, { timeoutMs: 2000 }), "last reply");
    await assert.rejects(connection.request("hold", {}, { timeoutMs: 2000 }), /subprocess/);
    await assert.rejects(connection.close(), /tree termination could not be confirmed/);
  } finally {
    await connection.close().catch(() => {});
  }
});

test("decodes split UTF-8 and CRLF frames, dispatching updates in wire order", guard, async t => {
  const updates = [];
  const connection = client(t, { onUpdate: params => updates.push(params) });
  assert.equal(connection.alive, true);
  assert.deepEqual(await connection.request("frames", { text: "µ\n雪" }), { text: "µ\n雪" });
  assert.deepEqual(updates, [{ text: "雪🪁" }, { text: "next" }]);
});

test("returns the complete permission result and fails closed on callbacks and unsupported requests", guard, async t => {
  let release;
  const updateSeen = new Promise(resolve => { release = resolve; });
  const connection = client(t, {
    onUpdate: release,
    async onPermission(params) {
      if (!params.allow) throw new Error("fixture-secret");
      assert.deepEqual(await updateSeen, { text: "between" });
      return { outcome: { outcome: "selected", optionId: "fixture-option" } };
    },
  });
  const replies = await connection.request("permissions", {});
  assert.deepEqual(replies.grant, { outcome: { outcome: "selected", optionId: "fixture-option" } });
  assert.equal(replies["-41"].code, -32603);
  assert.equal(replies.unsupported.code, -32601);
  assert.doesNotMatch(JSON.stringify(replies), /fixture-secret/);
});

test("abort/timeout reject only their own requests, and session/cancel is written in order", guard, async t => {
  const connection = client(t);
  const stopped = new AbortController();
  stopped.abort("fixture-secret");
  await assert.rejects(connection.request("not-sent", {}, { signal: stopped.signal }), { name: "AbortError" });
  const aborter = new AbortController();
  const pending = assert.rejects(connection.request("hold", {}, { signal: aborter.signal }), { name: "AbortError" });
  aborter.abort();
  await pending;
  await assert.rejects(connection.request("hold", {}, { timeoutMs: 20 }), /timed out/);
  assert.equal(connection.alive, true);
  connection.notify("session/cancel", { sessionId: "test" });
  assert.deepEqual(await connection.request("seen", {}), ["hold", "hold", "session/cancel", "seen"]);
  await connection.close();
  connection.notify("session/cancel", { sessionId: "test" }); // Disconnected cancel is best effort.
  await assert.rejects(connection.request("seen", {}), /closed/);
});

test("late replies are ignored and oversize outgoing frames never reach the peer", guard, async t => {
  const connection = client(t);
  await assert.rejects(connection.request("late", {}, { timeoutMs: 20 }), /timed out/);
  await assert.rejects(connection.request("not-sent", "雪".repeat(3 * 1024 * 1024)), /exceeds 8 MiB/);
  assert.equal(await connection.request("flush", {}), "current response");
  assert.deepEqual(await connection.request("seen", {}), ["late", "flush", "seen"]);
});

test("a remote request error doesn't close the transport or expose remote text", guard, async t => {
  const connection = client(t);
  await assert.rejects(connection.request("request-error", {}), error => {
    assert.match(error.message, /-32001/);
    assert.doesNotMatch(error.message, /fixture-secret/);
    return true;
  });
  assert.equal(await connection.request("echo", "still connected"), "still connected");
});

test("accepts the last complete response even if the child exits immediately", guard, async t => {
  assert.equal(await client(t).request("final-frame", {}), "last reply");
});

for (const [method, diagnostic] of [
  ["malformed", /invalid.*JSON/i],
  ["invalid-utf8", /UTF-8/],
  ["invalid-envelope", /Invalid ACP JSON-RPC message/],
  ["overlong", /exceeds 8 MiB/],
  ["truncated", /truncated/],
  ["crash", /closed stdout|exited/],
]) {
  test(`${method} rejects all pending requests and closes with a safe diagnostic`, guard, async t => {
    const connection = client(t);
    const verify = error => {
      assert.match(error.message, diagnostic);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    };
    await Promise.all([
      assert.rejects(connection.request("hold", {}), verify),
      assert.rejects(connection.request(method, {}), verify),
    ]);
    assert.equal(connection.alive, false);
    await connection.close();
  });
}

test("spawn failure rejects pending requests without leaking the command or arguments", guard, async t => {
  const launch = { command: fixture("not-a-command-fixture-secret.exe"), args: ["fixture-secret"] };
  const connection = client(t, { launch });
  await assert.rejects(connection.request("hold", {}), error => {
    assert.match(error.message, /subprocess/);
    assert.doesNotMatch(error.message, /fixture-secret/);
    return true;
  });
  assert.equal(connection.alive, false);
  await connection.close();
});
