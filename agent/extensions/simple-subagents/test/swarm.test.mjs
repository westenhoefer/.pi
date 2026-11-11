import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadManifest, parseCsv } from "../manifest.ts";
import { RunStore, readConcurrency } from "../run-store.ts";
import { Supervisor } from "../supervisor.ts";
import { SwarmExecutor } from "../swarm.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const profile = { name: "scout", prompt: "Leaf role", tools: ["read"], extensions: [] };
const tasks = count => Array.from({ length: count }, (_, i) => ({ id: `task-${i}`, task: `Inspect item ${i}` }));
async function directory(t) {
  const path = await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-swarm-"));
  t.after(async () => {
    assert.equal(await realpath(path), path); await readdir(path);
    await rm(path, { recursive: true });
  });
  return path;
}
function harness(path, options = {}) {
  const children = [], notifications = [], claims = [], errors = [];
  let swarm, maximum = 0;
  const supervisor = new Supervisor({
    sessionId: "parent", maxConcurrency: options.ceiling ?? 5, configurationError: options.error,
    onStarted(child) { swarm?.childStarted(child); },
    onChange(list) { maximum = Math.max(maximum, list.filter(child => ["starting", "running", "stopping"].includes(child.state)).length); swarm?.childrenChanged(list); },
    onComplete(child) { swarm?.childComplete(child); },
    connect(launch, event, exit) {
      const child = { launch, event, exit, closed: false, requests: [],
        async request(command) { child.requests.push(command); return options.request ? options.request(command) : {}; },
        async close() { child.closeRequested = true; if (options.close) await options.close(); child.closed = true; },
      };
      children.push(child); return child;
    },
  });
  const store = new RunStore(path);
  swarm = new SwarmExecutor({ sessionId: "parent", supervisor, store, ceiling: options.ceiling ?? 5, configurationError: options.error,
    claim(claim) { claims.push(claim); if (options.claim) options.claim(claim); else claim.allowed = true; },
    authorize(query) { if (options.authorize) options.authorize(query); else query.allowed = true; },
    notify(delivery, summary) { notifications.push({ delivery, summary }); }, onChange() {}, onError(message) { errors.push(message); },
  });
  const launch = { command: "unused", args: [], cwd: path, env: { NOT_PERSISTED: "private-environment-value" } };
  async function start(count, input = {}, authority = { sessionId: "parent", allowed: true }, signal) {
    const params = { agent: "scout", tasks: tasks(count), ...input };
    return swarm.start(params, await loadManifest(params, path), profile, launch, authority, signal);
  }
  function finish(index, reason = "stop", answer = `Report ${index}: artifacts and checks not independently verified`) {
    children[index].event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: reason,
      usage: { input: 10, output: 5, totalTokens: 15 } } });
    children[index].event({ type: "agent_settled" });
  }
  return { swarm, store, supervisor, children, notifications, claims, errors, launch, start, finish, maximum: () => maximum };
}

// Cleanup is ordered explicitly: no test callback writes run records after fixture removal.
async function withHarness(t, options, run) {
  const path = await directory(t);
  const h = harness(path, options);
  try { await run(h, path); } finally { await h.swarm.shutdown(); }
}

test("default ceiling drains >20 tasks with one coalesced result and durable honest evidence", async t => {
  await withHarness(t, {}, async (h, path) => {
    const run = await h.start(27, { maxParallel: 99 });
    assert.equal(run.effectiveParallelism, 5); assert.equal(run.requestedParallelism, 99);
    await flush(); assert.equal(h.children.length, 5);
    assert.equal(h.swarm.status(run.swarmId).counts.queued, 22);
    let finished = 0;
    while (finished < 27) { h.finish(finished++); await flush(); }
    assert.equal(h.maximum(), 5); assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].delivery.final, true);
    const status = h.swarm.status(run.swarmId);
    assert.equal(status.counts.succeeded, 27); assert.equal(status.armed, false);
    const page = h.swarm.results(run.swarmId, 0, 2);
    assert.equal(page.results.length, 2); assert.equal(page.nextOffset, 2);
    assert.equal(page.results[0].attempt, 1); assert.equal(page.results[0].usage.totalTokens, 15);
    assert.equal(page.results[0].usage.cost, undefined); assert.equal(page.results[0].accepted, undefined);
    assert.equal(page.results[0].evidence.independentlyVerified, false);
    assert.ok(page.results[0].evidence.reference.startsWith(path));
    const persisted = await readFile(h.store.path(run.swarmId), "utf8");
    assert.equal(persisted.includes("private-environment-value"), false);
    assert.equal(persisted.includes("allowed"), false);
    const recovered = harness(path);
    assert.equal(recovered.swarm.results(run.swarmId).total, 27); assert.equal(recovered.children.length, 0);
    await recovered.swarm.shutdown();
  });
});

test("concurrent swarms, direct children and reviewers reserve one lower shared pool before startup awaits", async t => {
  let release;
  await withHarness(t, { ceiling: 2, request: command => command.type === "get_state" ? new Promise(resolve => { release = resolve; }) : {} }, async h => {
    const direct = h.supervisor.start({ agent: "reviewer", task: "Review stable changes", launch: h.launch });
    const [a, b] = await Promise.all([h.start(3), h.start(3, { agent: "reviewer" })]);
    await flush(); assert.equal(h.children.length, 2); assert.equal(h.maximum(), 2);
    assert.equal(h.swarm.status(a.swarmId).counts.starting + (h.swarm.status(b.swarmId).counts.starting ?? 0), 1);
    assert.throws(() => h.supervisor.start({ agent: "reviewer", task: "Another review", launch: h.launch }), /ceiling/);
    await h.supervisor.stop(direct.id); await flush();
    assert.equal(h.children.length, 3); assert.equal(h.maximum(), 2);
    release({});
  });
});

test("per-run parallelism and failures do not truncate unrelated items", async t => {
  await withHarness(t, {}, async h => {
    const run = await h.start(4, { maxParallel: 1 }); await flush();
    assert.equal(h.children.length, 1); h.finish(0, "error"); await flush();
    assert.equal(h.children.length, 2); h.finish(1); await flush(); h.finish(2); await flush(); h.finish(3); await flush();
    assert.equal(h.maximum(), 1); assert.deepEqual(h.swarm.status(run.swarmId).counts, { failed: 1, succeeded: 3 });
    assert.equal(h.notifications.length, 1);
  });
});

test("task deadlines begin on dispatch, not while waiting in queue", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = await h.start(2, { timeoutSeconds: 1 }); await flush();
    t.mock.timers.tick(1000); await flush();
    assert.equal(h.swarm.results(run.swarmId).results[0].state, "timed_out");
    assert.equal(h.swarm.results(run.swarmId).results[1].state, "running");
    t.mock.timers.tick(999); await flush(); assert.equal(h.children[1].closed, false);
    t.mock.timers.tick(1); await flush(); assert.equal(h.children[1].closed, true);
  });
});

test("pause drains active attempts without completing the queued dependency; explicit resume starts only untouched items", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    const run = await h.start(3); await flush(); h.swarm.pause(run.swarmId); h.finish(0); await flush();
    assert.equal(h.children.length, 1); assert.equal(h.notifications[0].delivery.final, false);
    assert.equal(h.swarm.status(run.swarmId).counts.queued, 2);
    h.swarm.resume(run.swarmId, h.launch, { sessionId: "parent", allowed: true }); await flush();
    h.finish(1); await flush(); h.finish(2); await flush();
    assert.equal(h.children.length, 3); assert.equal(h.notifications.length, 2); assert.equal(h.notifications[1].delivery.final, true);
    assert.throws(() => h.swarm.resume(run.swarmId, h.launch, { allowed: true }), /No never-started/);
  });
});

test("stop cancels queued rows, closes children once, and late duplicate child exits cannot launch", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    const run = await h.start(4); await flush(); await h.swarm.stop(run.swarmId); await flush();
    assert.equal(h.children[0].closed, true); assert.equal(h.swarm.status(run.swarmId).counts.cancelled, 4);
    h.finish(0); h.children[0].exit(new Error("late")); await flush();
    assert.equal(h.children.length, 1); assert.equal(h.notifications.length, 1);
    assert.throws(() => h.swarm.resume(run.swarmId, h.launch, { allowed: true }), /No never-started/);
  });
});

test("delayed and unconfirmed cleanup retain capacity and block every launch path", async t => {
  let release;
  await withHarness(t, { ceiling: 1, close: () => new Promise(resolve => { release = resolve; }) }, async h => {
    const run = await h.start(2); await flush(); h.finish(0); await flush();
    assert.equal(h.swarm.status(run.swarmId).counts.stopping, 1); assert.equal(h.children.length, 1);
    assert.throws(() => h.supervisor.start({ agent: "reviewer", task: "Review", launch: h.launch }), /ceiling/);
    release(); await flush(); assert.equal(h.children.length, 2);
    h.finish(1); await flush(); release(); await flush();
  });
  await withHarness(t, { close: () => { throw new Error("writer still alive"); } }, async h => {
    const run = await h.start(7); await flush(); await h.swarm.stop(run.swarmId); await flush();
    assert.equal(h.swarm.status(run.swarmId).counts.stopping, 5);
    assert.throws(() => h.supervisor.start({ agent: "reviewer", task: "Review", launch: h.launch }), /unconfirmed/);
    assert.throws(() => h.swarm.resume(run.swarmId, h.launch, { allowed: true }), /unconfirmed/);
    assert.equal(h.notifications[0].delivery.final, false);
  });
});

test("orderly reload interrupts attempted rows; read-only recovery and explicit resume preserve original CSV snapshot/cwd", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const csvPath = join(path, "input.csv"); await writeFile(csvPath, 'id,note\nbusiness,"first, line\nsecond line"\nbusiness,other\n');
    const input = { agent: "scout", csvPath, instruction: "Inspect your complete record." };
    const items = await loadManifest(input, path);
    const run = h.swarm.start(input, items, profile, h.launch, { sessionId: "parent", allowed: true }); await flush();
    await h.swarm.shutdown(); assert.equal(h.children[0].closed, true);
    await writeFile(csvPath, "id,note\nmodified,not authorized\n");
    const fresh = harness(path);
    assert.equal(fresh.swarm.status(run.swarmId).armed, false); assert.equal(fresh.children.length, 0);
    assert.equal(fresh.swarm.results(run.swarmId).results[0].state, "interrupted");
    assert.throws(() => fresh.swarm.resume(run.swarmId, { ...h.launch, cwd: "elsewhere" }, { allowed: true }), /recorded cwd/);
    fresh.swarm.resume(run.swarmId, h.launch, { sessionId: "new-session", allowed: true }); await flush();
    assert.equal(fresh.children.length, 1);
    const prompt = fresh.children[0].requests.find(command => command.type === "prompt").message;
    assert.match(prompt, /"id":"business","note":"other"/); assert.equal(prompt.includes("modified"), false);
    fresh.finish(0); await flush(); await fresh.swarm.shutdown();
  });
});

test("another live process/runtime's persisted queue is never declared dead or taken over", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(2); await flush(); h.swarm.pause(run.swarmId); h.finish(0); await flush();
    const fresh = harness(path);
    assert.equal(fresh.swarm.status(run.swarmId).counts.queued, 1);
    assert.throws(() => fresh.swarm.resume(run.swarmId, h.launch, { allowed: true }), /another live/);
    assert.equal(fresh.children.length, 0); await fresh.swarm.shutdown();
  });
});

test("whole-run claim is required before dispatch, original authority is re-queried, and stopped-loop runs never become standalone", async t => {
  let allowed = true;
  await withHarness(t, { ceiling: 1, authorize: query => { query.allowed = allowed; } }, async h => {
    const run = await h.start(3, {}, { sessionId: "parent", allowed: true, loopId: "loop", round: 1 }); await flush();
    assert.equal(h.claims.length, 1); allowed = false; h.finish(0); await flush();
    assert.equal(h.children.length, 1); assert.equal(h.swarm.status(run.swarmId).counts.queued, 2);
    assert.throws(() => h.swarm.resume(run.swarmId, h.launch, { sessionId: "parent", allowed: true }), /cannot become standalone/);
  });
  await withHarness(t, { claim() {} }, async h => {
    await assert.rejects(h.start(2, {}, { allowed: true, loopId: "loop", round: 1 }), /registration/);
    await flush(); assert.equal(h.children.length, 0);
  });
});

test("parent signal abortion stops queued admission without killing active attempts", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    const controller = new AbortController();
    const run = await h.start(3, {}, { allowed: true, sessionId: "parent" }, controller.signal); await flush();
    controller.abort(); assert.equal(h.children[0].closed, false); h.finish(0); await flush();
    assert.equal(h.children.length, 1); assert.equal(h.swarm.status(run.swarmId).counts.queued, 2);
  });
});

test("CSV preserves BOM, quotes, multiline UTF-8, business id strings and empty-record skipping", () => {
  const rows = parseCsv('\uFEFFid,note,number\r\nsame,"héllo, ""world""\nnext",001\r\n,,\r\nsame,last,002\r\n');
  assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows[0].record, { id: "same", note: 'héllo, "world"\nnext', number: "001" });
  for (const text of ['a,a\n1,2', ',b\n1,2', 'a\n"unterminated', 'a\n"x"z', 'a,b\n1', 'a\nx"y']) assert.throws(() => parseCsv(text));
});

test("entire invalid manifests are rejected before any dispatch", async t => {
  await withHarness(t, {}, async (h, path) => {
    for (const params of [
      { tasks: [] }, { tasks: [{ id: "a", task: "good" }, { id: "a", task: "bad" }] }, { tasks: [{ id: "a", task: "" }] },
      { tasks: tasks(2), maxParallel: 0 }, { tasks: tasks(2), timeoutSeconds: 3601 }, { tasks: tasks(2), instruction: "x".repeat(16000) },
      { tasks: tasks(2), csvPath: "unused" }, { csvPath: "unused" },
    ]) await assert.rejects(loadManifest({ agent: "scout", ...params }, path));
    assert.equal(h.children.length, 0);
  });
});

test("only the injected user-agent settings control the ceiling; missing defaults and malformed values refuse launches", async t => {
  const path = await directory(t); assert.equal(readConcurrency(path).limit, 5);
  await writeFile(join(path, "settings.json"), JSON.stringify({ simpleSubagents: { maxConcurrency: 2 } }));
  assert.equal(readConcurrency(path).limit, 2);
  await writeFile(join(path, "settings.json"), '\uFEFF{"simpleSubagents":{"maxConcurrency":2}}');
  assert.equal(readConcurrency(path).limit, 2);
  await writeFile(join(path, "project-settings.json"), JSON.stringify({ simpleSubagents: { maxConcurrency: 99 } }));
  assert.equal(readConcurrency(path).limit, 2);
  for (const value of [0, -1, 1.5, "5", null]) {
    await writeFile(join(path, "settings.json"), JSON.stringify({ simpleSubagents: { maxConcurrency: value } }));
    const config = readConcurrency(path); assert.match(config.error, /Launches refused/);
    const h = harness(path, { error: config.error });
    await assert.rejects(h.start(1), /Launches refused/);
    assert.throws(() => h.supervisor.start({ agent: "scout", task: "Inspect", launch: h.launch }), /Launches refused/);
    assert.equal(h.children.length, 0); await h.swarm.shutdown();
  }
  await writeFile(join(path, "settings.json"), "{"); assert.match(readConcurrency(path).error, /malformed/);
});

test("large Unicode evidence pages remain byte-bounded with explicit truncation and full retained references", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    const run = await h.start(4); await flush();
    for (let i = 0; i < 4; i++) { h.finish(i, "stop", "界".repeat(16000)); await flush(); }
    const page = h.swarm.results(run.swarmId, 0, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 41_000);
    assert.ok(page.nextOffset > 0); assert.ok(page.nextOffset < 4); assert.equal(page.results[0].answerTruncated, true);
    assert.equal(h.store.load(run.swarmId).outcomes[0].answer.length, 16000);
    assert.throws(() => h.swarm.results(run.swarmId, -1), /offset/);
    assert.throws(() => h.swarm.results(run.swarmId, 0, 21), /limit/);
  });
});

test("pause may be resumed while its owned active attempt finishes without duplicating it", async t => {
  await withHarness(t, { ceiling: 2 }, async h => {
    const run = await h.start(4, { maxParallel: 1 }); await flush(); h.swarm.pause(run.swarmId);
    h.swarm.resume(run.swarmId, h.launch, { sessionId: "parent", allowed: true }); await flush();
    assert.equal(h.children.length, 1); h.finish(0); await flush(); assert.equal(h.children.length, 2);
  });
});

test("recovered queued work can be stopped without resuming or launching", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(3); await flush(); await h.swarm.shutdown();
    const fresh = harness(path); await fresh.swarm.stop(run.swarmId);
    assert.equal(fresh.swarm.status(run.swarmId).counts.cancelled, 2); assert.equal(fresh.children.length, 0);
    assert.equal(fresh.swarm.results(run.swarmId).results[0].state, "interrupted"); await fresh.swarm.shutdown();
  });
});

test("failed persistence before dispatch never spawns or silently arms later queued work", async t => {
  await withHarness(t, {}, async h => {
    const save = h.store.save.bind(h.store); let writes = 0;
    h.store.save = record => { if (++writes === 3) throw new Error("disk unavailable"); save(record); };
    const run = await h.start(2); await flush();
    assert.equal(h.children.length, 0); assert.equal(h.swarm.status(run.swarmId).armed, false);
    assert.equal(h.swarm.status(run.swarmId).counts.queued, 2);
    assert.equal(h.notifications[0].delivery.final, false);
    h.supervisor.start({ agent: "scout", task: "Independent direct inspection", launch: h.launch }); await flush();
    assert.equal(h.children.length, 1); assert.equal(h.swarm.status(run.swarmId).counts.queued, 2);
  });
});

test("structured input pins only declared fields and each child receives exactly its own immutable task", async t => {
  await withHarness(t, { ceiling: 1 }, async h => {
    const rows = [{ id: "\ud800", task: "First exclusive scope", record: { task: "injected hidden row" } }, { id: "second", task: "Second exclusive scope" }];
    const run = await h.start(2, { tasks: rows, instruction: "Shared authorized facts" }); rows[1].task = "edited later"; await flush();
    const first = h.children[0].requests.find(command => command.type === "prompt").message;
    assert.match(first, /Shared authorized facts/); assert.match(first, /First exclusive scope/);
    assert.equal(first.includes("Second exclusive scope"), false); assert.equal(first.includes("injected hidden row"), false);
    h.finish(0); await flush();
    const second = h.children[1].requests.find(command => command.type === "prompt").message;
    assert.match(second, /Second exclusive scope/); assert.equal(second.includes("edited later"), false);
    h.finish(1); await flush(); assert.equal(h.swarm.results(run.swarmId).results[0].taskId, "\ud800");
    assert.match(h.swarm.results(run.swarmId).results[0].evidence.reference, /#\/outcomes\/0$/);
  });
});

test("revocation disarms all standalone queues before a first-run persistence failure", async t => {
  await withHarness(t, { ceiling: 2 }, async h => {
    const a = await h.start(3, { maxParallel: 1 }); const b = await h.start(3, { maxParallel: 1 }); await flush();
    assert.equal(h.children.length, 2);
    const save = h.store.save.bind(h.store);
    h.store.save = record => { if (record.id === a.swarmId && record.state === "paused") throw new Error("first pause save failed"); save(record); };
    try {
      h.swarm.revoke(() => true, "Parent aborted.");
      assert.equal(h.errors.length, 1); assert.match(h.errors[0], /not persisted/);
      assert.equal(h.swarm.status(a.swarmId).armed, false); assert.equal(h.swarm.status(b.swarmId).armed, false);
      h.finish(0); h.finish(1); await flush();
      assert.equal(h.children.length, 2);
      for (const id of [a.swarmId, b.swarmId]) assert.equal(h.swarm.status(id).counts.queued, 2);
      assert.equal(h.store.load(b.swarmId).state, "paused");
    } finally { h.store.save = save; }
  });
});

test("explicit stop requests every active termination even when cancellation persistence fails", async t => {
  await withHarness(t, { ceiling: 2 }, async h => {
    const run = await h.start(4); await flush();
    const save = h.store.save.bind(h.store); let fail = true;
    h.store.save = record => { if (fail) { fail = false; throw new Error("stop save failed"); } save(record); };
    try {
      await assert.rejects(h.swarm.stop(run.swarmId), /Stop requested for all active children.*not persisted/);
      await flush(); assert.equal(h.children.length, 2);
      assert.ok(h.children.every(child => child.closeRequested && child.closed));
      assert.equal(h.swarm.status(run.swarmId).counts.cancelled, 4);
    } finally { h.store.save = save; }
  });
});

test("shutdown saves all runs and releases only confirmed, durably closed ownership", async t => {
  await withHarness(t, { ceiling: 2 }, async (h, path) => {
    const a = await h.start(2, { maxParallel: 1 }); const b = await h.start(2, { maxParallel: 1 }); await flush();
    const save = h.store.save.bind(h.store);
    h.store.save = record => { if (record.id === a.swarmId) throw new Error("first shutdown save failed"); save(record); };
    await assert.rejects(h.swarm.shutdown(), /shutdown persistence.*first shutdown save failed/);
    h.store.save = save;
    assert.ok(h.children.every(child => child.closed));
    assert.equal(h.store.load(b.swarmId).owner.pid, 0);
    assert.equal(h.store.load(b.swarmId).outcomes[0].state, "interrupted");
    const fresh = harness(path);
    try {
      assert.throws(() => fresh.swarm.resume(a.swarmId, h.launch, { allowed: true }), /unconfirmed.*Ownership claim/);
      fresh.swarm.resume(b.swarmId, h.launch, { allowed: true }); await flush();
      assert.equal(fresh.children.length, 1); assert.equal(fresh.swarm.results(b.swarmId).results[1].attempt, 1);
    } finally { await fresh.swarm.shutdown(); }
  });
});

test("upstream ASCII retention truncation and Unicode page clipping survive reload without false marker inference", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(4); await flush();
    for (const [i, answer] of ["a".repeat(50000), "界".repeat(16000), "界".repeat(50000), "[Truncated; no full transcript retained.]"].entries()) {
      h.finish(i, "stop", answer); await flush();
    }
    const saved = h.store.load(run.swarmId).outcomes;
    assert.deepEqual(saved.map(item => item.answerTruncated), [true, false, true, false]);
    assert.equal(saved[0].answer.length, 16042);
    assert.match(saved[0].answer, /Truncated; no full transcript retained/);
    await h.swarm.shutdown();
    const fresh = harness(path);
    try {
      assert.deepEqual(fresh.swarm.results(run.swarmId, 0, 1).results.map(item => item.answerTruncated), [true]);
      for (const i of [1, 2]) {
        const page = fresh.swarm.results(run.swarmId, i, 1);
        assert.equal(page.results[0].answerTruncated, true);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 41000);
        assert.ok(page.results[0].answer.length < saved[i].answer.length);
      }
      assert.equal(fresh.swarm.results(run.swarmId, 3, 1).results[0].answerTruncated, false);
      assert.equal(fresh.children.length, 0);
    } finally { await fresh.swarm.shutdown(); }
  });
});

test("recovery rereads outcomes inside ownership and refuses stale claims even with owner pid zero", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(3); await flush(); await h.swarm.shutdown();
    const fresh = harness(path); const original = fresh.store.claim.bind(fresh.store);
    const release = original(run.swarmId, { pid: 0, instance: "unconfirmed-fixture" });
    try {
      assert.throws(() => fresh.swarm.resume(run.swarmId, h.launch, { allowed: true }), /never reclaimed automatically/);
      await assert.rejects(fresh.swarm.stop(run.swarmId), /Ownership claim/);
      assert.equal(fresh.children.length, 0);
    } finally { release(); }
    fresh.store.claim = (id, owner) => {
      const unlock = original(id, owner);
      const record = fresh.store.load(id);
      record.outcomes[1] = { taskId: record.items[1].id, attempt: 1, state: "failed", error: "Previous attempt, not replayable" };
      fresh.store.save(record); return unlock;
    };
    try {
      fresh.swarm.resume(run.swarmId, h.launch, { allowed: true }); await flush();
      assert.equal(fresh.children.length, 1);
      assert.match(fresh.children[0].requests.find(command => command.type === "prompt").message, /Inspect item 2/);
      assert.equal(fresh.swarm.results(run.swarmId).results[1].state, "failed");
    } finally { await fresh.swarm.shutdown(); }
  });
});

test("recovered stop holds exclusive ownership through its save and releases after mutation", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(2); await flush(); await h.swarm.shutdown();
    const stopper = harness(path), competitor = harness(path);
    const save = stopper.store.save.bind(stopper.store);
    stopper.store.save = record => {
      assert.throws(() => competitor.swarm.resume(run.swarmId, h.launch, { allowed: true }), /Ownership claim/);
      assert.equal(competitor.children.length, 0); save(record);
    };
    try {
      await stopper.swarm.stop(run.swarmId);
      assert.equal(stopper.swarm.status(run.swarmId).counts.cancelled, 1);
      assert.equal((await readdir(join(path, "simple-subagents", "runs"))).some(name => name.endsWith(".claim")), false);
      assert.throws(() => competitor.swarm.resume(run.swarmId, h.launch, { allowed: true }), /No never-started/);
    } finally { await stopper.swarm.shutdown(); await competitor.swarm.shutdown(); }
  });
});

test("released runtimes cannot mutate run records after orderly shutdown", async t => {
  await withHarness(t, { ceiling: 1 }, async (h, path) => {
    const run = await h.start(2); await flush(); await h.swarm.shutdown();
    const before = await readFile(h.store.path(run.swarmId), "utf8");
    assert.throws(() => h.swarm.pause(run.swarmId), /shutting down/);
    await assert.rejects(h.swarm.stop(run.swarmId), /shutting down/);
    assert.throws(() => h.swarm.resume(run.swarmId, h.launch, { allowed: true }), /shutting down/);
    await assert.rejects(h.start(1), /shutting down/);
    h.swarm.revoke(() => true, "late abort");
    assert.equal(await readFile(h.store.path(run.swarmId), "utf8"), before);
    assert.equal((await readdir(join(path, "simple-subagents", "runs"))).length, 1);
  });
});

test("unconfirmed teardown marker survives runtime reload and refuses new admission", async t => {
  const path = await directory(t); const store = new RunStore(path);
  assert.equal(store.admissionError(), undefined);
  store.block([{ id: "owned-child", state: "stopping", error: "cleanup unconfirmed" }]);
  assert.match(new RunStore(path).admissionError(), /unconfirmed-teardown/);
  assert.equal((await readdir(join(path, "simple-subagents", "runs"))).length, 1);
});
