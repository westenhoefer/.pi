import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalLoop, LIMITS } from "../loop.ts";

const waiting = { outcome: "waiting", progress: "Delegated independent checks", next: "" };
const more = { outcome: "continue", progress: "Consumed both results; checks passed", next: "Verify remaining requirement" };
function start(manual = false) { const loop = new GoalLoop(); loop.start("Goal", 0, 1000, manual, 2); return loop; }

test("waiting for two children preserves the round, then needs fresh evidence before countdown", () => {
  const loop = start(); loop.childStarted("a"); loop.childStarted("b");
  assert.throws(() => loop.checkpoint(more), /Consume/);
  assert.throws(() => loop.checkpoint({ ...more, outcome: "done" }), /Consume/);
  loop.checkpoint(waiting); loop.settled(100); assert.equal(loop.state.phase, "waiting_children");
  assert.equal(loop.advance(5000), false); assert.equal(loop.state.round, 1);
  assert.equal(loop.childResult("a"), true); assert.equal(loop.state.phase, "working");
  assert.equal(loop.childResult("a"), false); assert.equal(loop.pendingChildren, 1);
  loop.checkpoint(waiting); loop.settled(5001); assert.equal(loop.state.phase, "waiting_children");
  loop.childResult("b"); loop.checkpoint(more); loop.settled(6000);
  assert.equal(loop.advance(6999), false); assert.equal(loop.advance(7000), true); assert.equal(loop.state.round, 2);
});

test("manual result handling belongs to the same round and never grants approval", () => {
  const loop = start(true); loop.childStarted("a"); loop.checkpoint(waiting); loop.settled(10);
  loop.childResult("a"); assert.equal(loop.state.round, 1);
  loop.checkpoint(more); loop.settled(20); assert.equal(loop.state.phase, "awaiting_approval");
  assert.equal(loop.childResult("a"), false); assert.equal(loop.advance(100000), false);
  assert.throws(() => loop.childStarted("b"), /working loop/);
  assert.equal(loop.resume(100001), true); assert.equal(loop.state.round, 2);
});

test("late results cannot revive stop or expired automatic budgets", () => {
  for (const reason of ["stop", "deadline"]) {
    const loop = start(); loop.childStarted("a"); loop.checkpoint(waiting); loop.settled(1);
    if (reason === "stop") loop.stop("user"); else loop.expired(LIMITS.durationMs);
    assert.equal(loop.childResult("a"), false); assert.equal(loop.state.phase, "stopped");
    loop.start("Another goal", LIMITS.durationMs + 1); assert.equal(loop.childResult("a"), false);
  }
});

test("missing checkpoint still fails closed after delegation", () => {
  const loop = start(); loop.childStarted("a"); loop.settled(1);
  assert.equal(loop.state.phase, "stopped"); assert.equal(loop.childResult("a"), false);
});
