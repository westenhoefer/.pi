import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { RpcProcess } from "../rpc.ts";
import { buildLaunch, loadProfile } from "../launch.ts";

function child(t, mode) {
  const events = [];
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  const rpc = new RpcProcess({ command: process.execPath, args: [fileURLToPath(new URL("./rpc-child.mjs", import.meta.url)), mode], cwd: process.cwd(), env: process.env }, event => events.push(event), exit);
  t.after(() => mode.startsWith("tool-") ? assert.rejects(rpc.close(), /Tool processes may remain/) : rpc.close());
  return { rpc, events, exited };
}

test("real subprocess JSONL handles concurrent requests, Unicode and completion", async t => {
  const h = child(t, "normal");
  const [a, b] = await Promise.all([h.rpc.request({ type: "get_state", message: "one" }), h.rpc.request({ type: "get_state", message: "two" })]);
  assert.equal(a.data.echoed, "one"); assert.equal(b.data.echoed, "two");
  await h.rpc.request({ type: "prompt", message: "hi" });
  await h.rpc.close();
  assert.equal(h.events.find(event => event.type === "message_end").message.content[0].text, "Hello\u2028world\u2029😀");
  assert.equal(h.events.at(-1).type, "agent_settled");
  await assert.rejects(h.rpc.request({ type: "steer", message: "late" }), /closed|stopping/);
});

test("RPC response rejection reaches the caller", async t => {
  const h = child(t, "reject");
  await assert.rejects(h.rpc.request({ type: "steer", message: "no" }), /Rejected intentionally/);
});

test("unexpected process exit rejects outstanding requests and reports failure", async t => {
  const h = child(t, "crash");
  await assert.rejects(h.rpc.request({ type: "get_state" }), /exited/);
  assert.match((await h.exited).message, /code 7/);
});

test("malformed RPC fails visibly rather than pretending to make progress", async t => {
  const h = child(t, "invalid");
  const request = h.rpc.request({ type: "get_state" });
  await assert.rejects(request, /Invalid JSON/);
  assert.match((await h.exited).message, /Invalid JSON/);
});

test("crash during an active tool does not claim process-tree cleanup", async t => {
  const h = child(t, "tool-crash");
  await assert.rejects(h.rpc.request({ type: "get_state" }), /exited/);
  await assert.rejects(h.rpc.close(), /Tool processes may remain/);
});

test("forced shutdown during an active tool stays unconfirmed even after root exit", async t => {
  const h = child(t, "tool-hang");
  await h.rpc.request({ type: "get_state" });
  await assert.rejects(h.rpc.close(), /Tool processes may remain/);
});

test("installed Pi RPC startup, state response and EOF shutdown, without a model call", { skip: !process.env.PI_TEST_PACKAGE_DIR }, async t => {
  const rpc = new RpcProcess({ command: process.execPath,
    args: [join(process.env.PI_TEST_PACKAGE_DIR, "dist", "cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline", "--no-tools"],
    cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: "1" },
  }, () => {}, () => {});
  t.after(() => rpc.close());
  const state = await rpc.request({ type: "get_state" });
  assert.equal(state.success, true); assert.equal(state.data.isStreaming, false);
  await rpc.close();
  const { getAgentDir, parseFrontmatter } = await import(pathToFileURL(join(process.env.PI_TEST_PACKAGE_DIR, "dist", "index.js")).href);
  const profile = await loadProfile(getAgentDir(), "worker", parseFrontmatter);
  const launch = buildLaunch(profile, {
    packageDir: process.env.PI_TEST_PACKAGE_DIR, childRuntime: fileURLToPath(new URL("../child-runtime.ts", import.meta.url)),
    executable: process.execPath, cwd: process.cwd(), trusted: false,
    provider: state.data.model.provider, model: state.data.model.id, thinking: "off", env: { ...process.env, PI_OFFLINE: "1" },
  });
  const worker = new RpcProcess(launch, () => {}, () => {});
  t.after(() => worker.close());
  const childState = await worker.request({ type: "get_state" });
  assert.equal(childState.data.model.id, state.data.model.id);
  const commands = await worker.request({ type: "get_commands" });
  assert.equal(commands.data.commands.some(command => command.name === "loop" || command.name === "subagents" || command.name === "pi-subagents"), false);
  await worker.close();
});
