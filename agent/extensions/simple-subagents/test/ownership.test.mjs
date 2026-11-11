import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../run-store.ts";

function runtime(directory, id, operation = "resume") {
  const child = fork(fileURLToPath(new URL("./ownership-child.mjs", import.meta.url)), [directory, id, operation], { stdio: ["pipe", "ignore", "pipe", "ipc"] });
  const messages = [];
  let diagnostics = "", ended = false, wake;
  child.stderr.on("data", data => { diagnostics += data; });
  child.stdin.on("error", error => { diagnostics += String(error); });
  child.on("message", message => { messages.push(message); wake?.(); });
  const exit = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { ended = true; wake?.(); resolveExit({ code, signal }); });
  });
  return { child, exit,
    async next() {
      const timeout = setTimeout(() => wake?.(), 10_000);
      try {
        if (!messages.length && !ended) await new Promise(resolveMessage => { wake = resolveMessage; });
        assert.ok(messages.length, `Fixture exited or timed out without protocol response: ${diagnostics}`);
        return messages.shift();
      } finally { clearTimeout(timeout); wake = undefined; }
    },
  };
}
function seed(store, directory) {
  const id = randomUUID();
  store.save({ version: 1, id, createdAt: Date.now(), cwd: directory,
    profile: { name: "scout", prompt: "Leaf", tools: ["read"], extensions: [] }, instruction: "",
    items: [{ id: "one", task: "Inspect first scope" }, { id: "two", task: "Inspect second scope" }], requestedParallelism: 1, timeoutSeconds: 900,
    owner: { pid: 0, instance: "closed" }, state: "paused", outcomes: [{ taskId: "one", attempt: 0, state: "queued" }, { taskId: "two", attempt: 0, state: "queued" }],
  });
  return id;
}

test("real processes exclusively own stale-snapshot recovery, including paused writes and recovered stop; independent runs retain independent capacity", async () => {
  const directory = await mkdtemp(resolve("agent/extensions/simple-subagents/test/.tmp-ownership-"));
  const children = [];
  const start = (id, operation) => { const child = runtime(directory, id, operation); children.push(child); return child; };
  const store = new RunStore(directory), id = seed(store, directory);
  try {
    const a = start(id);
    assert.equal((await a.next()).phase, "loaded");
    const b = start(id);
    const contender = await b.next();
    // An unfixed implementation reaches loaded with the same owner=0 snapshot.
    // Release both in order so the test observes the duplicate rather than hanging.
    a.child.stdin.write("G");
    const winner = await a.next();
    assert.equal(winner.phase, "result"); assert.equal(winner.launches, 1);
    const before = await readFile(store.path(id), "utf8");
    if (contender.phase === "loaded") { b.child.stdin.write("G"); await b.next(); }
    assert.equal(contender.phase, "refused", "the second process must refuse, never save its stale snapshot or launch the same task");
    assert.match(contender.error, /Ownership claim/); assert.equal(contender.launches, 0);
    assert.equal((await b.exit).code, 0);
    assert.equal(await readFile(store.path(id), "utf8"), before);

    const stopper = start(id, "stop");
    const stop = await stopper.next();
    if (stop.phase === "loaded") stopper.child.stdin.write("GS");
    assert.equal(stop.phase, "refused"); assert.match(stop.error, /Ownership claim/);
    assert.equal((await stopper.exit).code, 0);
    assert.equal(await readFile(store.path(id), "utf8"), before);

    const independentId = seed(store, directory), independent = start(independentId);
    assert.equal((await independent.next()).phase, "loaded"); independent.child.stdin.write("G");
    assert.equal((await independent.next()).launches, 1, "per-run ownership is not a cross-process capacity semaphore");
    independent.child.stdin.end("S"); assert.equal((await independent.exit).code, 0);

    a.child.stdin.end("S"); assert.equal((await a.exit).code, 0);
    assert.equal(store.load(id).outcomes[0].state, "interrupted");
    const recovered = start(id);
    assert.equal((await recovered.next()).phase, "loaded"); recovered.child.stdin.write("G");
    assert.equal((await recovered.next()).launches, 1);
    const outcomes = store.load(id).outcomes;
    assert.deepEqual(outcomes.map(item => item.attempt), [1, 1]);
    assert.equal(outcomes[0].state, "interrupted", "only the never-started item may resume after orderly release");
    recovered.child.stdin.end("S"); assert.equal((await recovered.exit).code, 0);
  } finally {
    // EOF releases both synchronous barriers even on an assertion failure. Await
    // every subprocess before inspecting/removing this exact test-owned directory.
    for (const { child } of children) if (child.exitCode === null && !child.stdin.writableEnded) child.stdin.end("SS");
    await Promise.allSettled(children.map(child => child.exit));
    assert.equal(await realpath(directory), directory); await readdir(directory);
    await rm(directory, { recursive: true });
  }
});
