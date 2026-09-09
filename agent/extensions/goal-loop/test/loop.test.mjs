import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalLoop, LIMITS, continuationPrompt, parseLoopStart } from "../loop.ts";

function working() { const loop = new GoalLoop(); loop.start("Fix and verify the bug", 0); return loop; }
const checkpoint = (progress = "Fixed parser; focused tests passed") => ({ outcome: "continue", progress, next: "Check integration behavior" });

test("round starts immediately; continuation waits a full 60 seconds after settlement", () => {
  const loop = working();
  assert.equal(loop.state.round, 1);
  loop.checkpoint(checkpoint());
  assert.equal(loop.advance(100_000), false);
  loop.settled(100_000);
  assert.equal(loop.advance(159_999), false);
  assert.equal(loop.advance(160_000), true);
  assert.equal(loop.state.round, 2);
  assert.equal(loop.state.checkpoint, undefined);
  assert.match(continuationPrompt(loop.state), /Check integration behavior/);
  assert.equal(loop.advance(160_001), false);
});

test("command delay is bounded, explicit, and local to each loop", () => {
  assert.deepEqual(parseLoopStart("goal"), { goal: "goal", delayMs: 60_000 });
  assert.deepEqual(parseLoopStart("--delay 15 goal with spaces"), { goal: "goal with spaces", delayMs: 15_000 });
  assert.deepEqual(parseLoopStart("-- --delay is my goal text"), { goal: "--delay is my goal text", delayMs: 60_000 });
  for (const command of ["--delay 0 goal", "--delay 601 goal", "--delay -1 goal", "--delay 1.5 goal", "--delay 15", "--wat goal", " "]) assert.throws(() => parseLoopStart(command), undefined, command);
  const loop = new GoalLoop(); loop.start("goal", 0, 15_000); loop.checkpoint(checkpoint()); loop.settled(100);
  assert.equal(loop.advance(15_099), false); assert.equal(loop.advance(15_100), true);
  loop.stop("user"); loop.start("next goal", 20_000); assert.equal(loop.state.delayMs, 60_000);
});

test("steering discards stale intent but preserves budgets and requires a new checkpoint", () => {
  const loop = working(); loop.checkpoint(checkpoint()); loop.settled(10); loop.steer();
  assert.equal(loop.state.phase, "working"); assert.equal(loop.state.checkpoint, undefined);
  assert.equal(loop.state.nextStep, undefined); assert.equal(loop.state.round, 1);
  assert.equal(loop.state.deadline, LIMITS.durationMs); assert.equal(loop.advance(100_000), false);
  loop.checkpoint(checkpoint("Steered fix verified")); loop.settled(100_000);
  assert.equal(loop.advance(160_000), true);
});

test("exactly five rounds, never a sixth", () => {
  const loop = working();
  for (let round = 1; round <= 5; round++) {
    loop.checkpoint(checkpoint(`Verified chunk ${round}`));
    loop.settled(round * 1000 + (round - 1) * LIMITS.delayMs);
    assert.equal(loop.advance(round * 1000 + round * LIMITS.delayMs), round < 5);
  }
  assert.equal(loop.state.phase, "stopped");
  assert.equal(loop.state.round, 5);
});

test("deadline stops future rounds even while a round is working", () => {
  const loop = working();
  assert.equal(loop.expired(LIMITS.durationMs - 1), false);
  assert.equal(loop.expired(LIMITS.durationMs), true);
  assert.match(loop.state.reason, /budget/);
  assert.equal(loop.advance(LIMITS.durationMs + 60_000), false);
});

for (const outcome of ["done", "blocked", "waiting", "no_progress"]) {
  test(`${outcome} stops automatically and cannot be undone by a checkpoint`, () => {
    const loop = working();
    loop.checkpoint({ outcome, progress: "Evidence or blocker", next: "" });
    loop.settled(1);
    assert.equal(loop.state.phase, "stopped");
    assert.throws(() => loop.checkpoint(checkpoint()), /No working/);
    assert.equal(loop.advance(100_000), false);
  });
}

test("missing checkpoint, stale checkpoint, and repeated progress fail closed", () => {
  const missing = working(); missing.settled(0); assert.equal(missing.state.phase, "stopped");
  const stale = working(); stale.checkpoint(checkpoint()); stale.toolStarted(); stale.settled(0); assert.equal(stale.state.phase, "stopped");
  const sibling = working(); sibling.checkpoint(checkpoint()); sibling.toolEnded(false); sibling.settled(0); assert.equal(sibling.state.phase, "stopped");
  const repeated = working(); repeated.checkpoint(checkpoint()); repeated.settled(0); repeated.advance(60_000);
  repeated.checkpoint(checkpoint("  FIXED parser; focused tests passed  ")); repeated.settled(61_000);
  assert.match(repeated.state.reason, /Repeated/);
});

test("two consecutive tool failures stop; a success resets the counter", () => {
  const loop = working(); loop.toolEnded(true); loop.toolEnded(false); loop.toolEnded(true);
  assert.equal(loop.state.phase, "working");
  loop.toolEnded(true); assert.match(loop.state.reason, /failures/);
});

test("user start validates bounds, rejects overlap, and explicit restart gets a new budget", () => {
  const loop = new GoalLoop();
  assert.throws(() => loop.checkpoint(checkpoint()));
  for (const goal of [" ", "a".repeat(4001)]) assert.throws(() => loop.start(goal, 0));
  loop.start("goal", 0); assert.throws(() => loop.start("other", 1));
  assert.throws(() => loop.checkpoint({ ...checkpoint(), next: " " }));
  assert.throws(() => loop.checkpoint({ ...checkpoint(), outcome: "restart" }));
  loop.stop("user stop"); loop.start("new goal", 100);
  assert.equal(loop.state.round, 1); assert.equal(loop.state.deadline, 100 + LIMITS.durationMs);
});
