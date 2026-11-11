import { readSync } from "node:fs";
import { RunStore } from "../run-store.ts";
import { Supervisor } from "../supervisor.ts";
import { SwarmExecutor } from "../swarm.ts";

const [directory, id, operation] = process.argv.slice(2);
const store = new RunStore(directory);
const load = store.load.bind(store);
let firstRead = true;
store.load = runId => {
  const record = load(runId);
  if (firstRead) {
    firstRead = false;
    process.send({ phase: "loaded" });
    // Hold the old snapshot as the exploratory probe did. A competing runtime
    // must now refuse ownership instead of reaching this stale-read barrier.
    readSync(0, Buffer.alloc(1), 0, 1, null);
  }
  return record;
};
let executor, launches = 0;
const supervisor = new Supervisor({ sessionId: String(process.pid), maxConcurrency: 1,
  onStarted: child => executor.childStarted(child), onChange: children => executor.childrenChanged(children), onComplete: child => executor.childComplete(child),
  connect() { launches++; return { async request() { return {}; }, async close() {} }; },
});
executor = new SwarmExecutor({ sessionId: String(process.pid), supervisor, store, ceiling: 1,
  claim() {}, authorize() {}, notify() {}, onChange() {}, onError() {},
});
try {
  if (operation === "stop") await executor.stop(id);
  else executor.resume(id, { command: "fake", args: [], cwd: directory, env: {} }, { allowed: true, sessionId: String(process.pid) });
  await new Promise(setImmediate);
  if (operation !== "stop") executor.pause(id);
  process.send({ phase: "result", launches });
  readSync(0, Buffer.alloc(1), 0, 1, null);
} catch (error) {
  process.send({ phase: "refused", error: String(error), launches });
} finally {
  await executor.shutdown();
  process.disconnect();
}
