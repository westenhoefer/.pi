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
  assert.deepEqual(parseLoopStart("goal"), { goal: "goal", delayMs: 60_000, manual: false, rounds: 5 });
  assert.deepEqual(parseLoopStart("--delay 15 goal with spaces"), { goal: "goal with spaces", delayMs: 15_000, manual: false, rounds: 5 });
  assert.deepEqual(parseLoopStart("-- --delay is my goal text"), { goal: "--delay is my goal text", delayMs: 60_000, manual: false, rounds: 5 });
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

test("manual approval never advances on timers or feedback, and preserves the round limit", () => {
  const loop = new GoalLoop(); loop.start("goal", 0, LIMITS.delayMs, true);
  assert.deepEqual(parseLoopStart("--manual goal"), { goal: "goal", delayMs: LIMITS.delayMs, manual: true, rounds: 5 });
  for (const args of ["--manual", "--manual --manual goal", "--manual --delay 15 goal", "--delay 15 --manual goal"]) assert.throws(() => parseLoopStart(args));
  assert.equal(loop.resume(0), false);
  loop.checkpoint(checkpoint()); loop.settled(1);
  assert.equal(loop.state.phase, "awaiting_approval");
  assert.equal(loop.advance(60_000), false);
  loop.steer(); loop.settled(60_001);
  assert.equal(loop.state.phase, "awaiting_approval");
  assert.equal(loop.state.nextStep, undefined);
  assert.throws(() => loop.checkpoint(checkpoint()));
  assert.equal(loop.resume(70_000), true);
  assert.equal(loop.resume(70_001), false);
  assert.equal(loop.state.round, 2);
  assert.equal(loop.state.deadline, undefined);
  for (let round = 2; round <= 5; round++) {
    loop.checkpoint(checkpoint(`Round ${round} tested`)); loop.settled(80_000 + round);
    assert.equal(loop.resume(90_000 + round), round < 5);
  }
  assert.equal(loop.state.round, 5);
});

test("per-loop round limit parses in either option order and remains bounded", () => {
  assert.deepEqual(parseLoopStart("--rounds 1 --manual goal"), { goal: "goal", delayMs: LIMITS.delayMs, manual: true, rounds: 1 });
  assert.deepEqual(parseLoopStart("--manual --rounds 20 goal"), { goal: "goal", delayMs: LIMITS.delayMs, manual: true, rounds: 20 });
  assert.deepEqual(parseLoopStart("--delay 15 --rounds 3 goal"), { goal: "goal", delayMs: 15_000, manual: false, rounds: 3 });
  assert.deepEqual(parseLoopStart("--rounds 3 --delay 15 goal"), { goal: "goal", delayMs: 15_000, manual: false, rounds: 3 });
  assert.deepEqual(parseLoopStart("--rounds 2 -- --rounds is the goal"), { goal: "--rounds is the goal", delayMs: LIMITS.delayMs, manual: false, rounds: 2 });
  for (const args of ["--rounds", "--rounds 3", "--rounds 0 goal", "--rounds 21 goal", "--rounds -1 goal", "--rounds 2.5 goal", "--rounds nope goal", "--rounds 99999999999999999999 goal", "--rounds 2 --rounds 3 goal"]) {
    assert.throws(() => parseLoopStart(args), undefined, args);
  }
  for (const rounds of [0, 1.5, 21, Infinity]) assert.throws(() => new GoalLoop().start("goal", 0, LIMITS.delayMs, true, rounds));
});

test("one-round manual loop stops without approval; a new start restores the default", () => {
  const loop = new GoalLoop(); loop.start("goal", 0, LIMITS.delayMs, true, 1);
  assert.match(continuationPrompt(loop.state), /round 1\/1/);
  loop.checkpoint(checkpoint()); loop.settled(1);
  assert.equal(loop.state.phase, "stopped");
  assert.match(loop.state.reason, /1-round limit/);
  assert.equal(loop.resume(2), false);
  loop.start("other", 3);
  assert.equal(loop.state.maxRounds, LIMITS.rounds);
});

test("configured upper bound supports 20 manual rounds without a 21st", () => {
  const loop = new GoalLoop(); loop.start("goal", 0, LIMITS.delayMs, true, LIMITS.maxRounds);
  for (let round = 1; round <= LIMITS.maxRounds; round++) {
    assert.equal(loop.state.round, round);
    loop.checkpoint(checkpoint(`Verified chunk ${round}`)); loop.settled(round);
    assert.equal(loop.resume(round + 1), round < LIMITS.maxRounds);
  }
  assert.match(loop.state.reason, /20-round limit/);
});

test("manual loops have no deadline, even while working or awaiting approval", () => {
  const loop = new GoalLoop(); loop.start("goal", 0, LIMITS.delayMs, true);
  assert.equal(loop.state.deadline, undefined);
  assert.equal(loop.expired(LIMITS.durationMs + 1), false);
  loop.checkpoint(checkpoint()); loop.settled(24 * 60 * 60_000);
  assert.equal(loop.state.phase, "awaiting_approval");
  assert.equal(loop.expired(30 * 24 * 60 * 60_000), false);
  assert.equal(loop.resume(30 * 24 * 60 * 60_000), true);
  assert.equal(loop.state.round, 2);
  loop.checkpoint(checkpoint("More work verified")); loop.settled(31 * 24 * 60 * 60_000);
  assert.equal(loop.state.phase, "awaiting_approval");
  loop.stop("user");
  assert.equal(loop.resume(32 * 24 * 60 * 60_000), false);
});

test("automatic deadline stops future rounds even while a round is working", () => {
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
