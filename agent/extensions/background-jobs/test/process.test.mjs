import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JobRegistry, isActive } from "../registry.ts";

const piRoot = process.env.PI_TEST_PACKAGE_DIR;
const skip = !piRoot && "Set PI_TEST_PACKAGE_DIR to the installed pi-coding-agent package directory.";
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
const nodeCommand = (code) => `${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(code)}`;
const input = (command) => ({ command, cwd: process.cwd(), env: { ...process.env } });

async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function backend() {
  const pi = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
  return pi.createLocalBashOperations().exec;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

test("real Pi backend captures stdout/stderr, nonzero exit, and invalid cwd", { skip }, async (t) => {
  const registry = new JobRegistry({ execute: await backend() });
  t.after(() => registry.shutdown());
  const job = registry.start(input(nodeCommand("console.log('stdout');console.error('stderr');process.exitCode=7")));
  await until(() => !isActive(registry.status(job.id)));
  assert.equal(registry.status(job.id).state, "failed");
  assert.equal(registry.status(job.id).exitCode, 7);
  assert.match(registry.logs(job.id).text, /stdout/);
  assert.match(registry.logs(job.id).text, /stderr/);
  const invalid = registry.start({ ...input("echo should-not-run"), cwd: join(process.cwd(), "missing-job-cwd") });
  await until(() => !isActive(registry.status(invalid.id)));
  assert.equal(registry.status(invalid.id).state, "failed");
  assert.match(registry.status(invalid.id).error, /Working directory does not exist/);
});

test("real cancellation terminates a Node process and its child on this platform", { skip }, async (t) => {
  const registry = new JobRegistry({ execute: await backend() });
  t.after(() => registry.shutdown());
  const code = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('PIDS:'+process.pid+','+child.pid);setInterval(()=>{},1000)";
  const job = registry.start(input(nodeCommand(code)));
  await until(() => /PIDS:\d+,\d+/.test(registry.logs(job.id).text));
  const [, parent, child] = registry.logs(job.id).text.match(/PIDS:(\d+),(\d+)/);
  assert.ok(alive(Number(parent)) && alive(Number(child)));
  const stopped = await registry.stop(job.id);
  assert.equal(stopped.state, "cancelled");
  await until(() => !alive(Number(parent)) && !alive(Number(child)));
});

test("real timeout stops a long-running command", { skip }, async (t) => {
  const registry = new JobRegistry({ execute: await backend() });
  t.after(() => registry.shutdown());
  const job = registry.start({ ...input(nodeCommand("setInterval(()=>{},1000)")), timeoutSeconds: 0.2 });
  await until(() => !isActive(registry.status(job.id)));
  assert.equal(registry.status(job.id).state, "timed_out");
});

test("Pi loads the extension; headless launches fail; shutdown cancels owned work", { skip }, async (t) => {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([resolve("agent/extensions/background-jobs/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ["job_logs", "job_start", "job_status", "job_stop"]);
  const notifications = [];
  const messages = [];
  loaded.runtime.sendMessage = (message) => messages.push(message);
  const ctx = {
    cwd: process.cwd(), mode: "tui", hasUI: true,
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
    ui: { notify: (text) => notifications.push(text), setStatus: () => {} },
  };
  const emit = async (event) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler({ reason: "reload" }, ctx);
  };
  const call = (name, params, context = ctx, signal = new AbortController().signal) =>
    extension.tools.get(name).definition.execute("test-call", params, signal, undefined, context);
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  await assert.rejects(call("job_start", { command: "echo rejected" }, { ...ctx, mode: "print", hasUI: false }), /persistent/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(call("job_start", { command: "echo rejected" }, ctx, abort.signal), /abort/i);
  const quick = await call("job_start", { command: nodeCommand("console.log('completed')"), name: "quick" });
  await until(async () => (await call("job_status", { id: quick.details.id })).details.state === "succeeded");
  assert.equal(messages.length, 1, "a normal completion is delivered once");
  assert.ok(notifications.some((text) => text.includes("quick") && text.includes("succeeded")));
  messages.length = 0;
  const started = await call("job_start", { command: nodeCommand("console.log(process.env.PI_SESSION_ID);setInterval(()=>{},1000)") });
  const id = started.details.id;
  await until(async () => (await call("job_logs", { id })).content[0].text.includes("test-session"));
  await emit("session_shutdown");
  assert.equal(messages.length, 0, "shutdown suppresses late completion notifications");
  await assert.rejects(call("job_start", { command: "echo no" }), /shutting down/);
});
