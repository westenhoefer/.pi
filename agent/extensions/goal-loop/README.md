# Bounded goal loop

Opt-in continuation of the current interactive Pi session. This is a small extension, not a skill, scheduler, subprocess, or autonomous subagent. No additional packages or configuration files are required.

```text
/loop Fix the parser bug and verify the regression
/loop --delay 15 Fix the parser bug and verify the regression
/loop status
/loop stop
```

Starting requires a confirmation dialog because it can initiate multiple paid model rounds. Start while Pi is idle. The first round starts immediately. Subsequent rounds wait **60 seconds by default after `agent_settled`**, not after individual tool calls or an intermediate `agent_end`. `--delay <seconds>` sets a per-loop integer delay from **1 to 600 seconds**; it does not change the default for later loops. Options go before the goal; use `--` to introduce a goal beginning with `--`.

## Steering and stopping

- **Normal user input steers the loop**, without resetting its original goal, five-round count, or 30-minute deadline. The model is reminded to follow the latest steering. The old checkpoint/next step is invalidated; a new final checkpoint is required before another automatic round.
- Typing in the editor pauses the countdown. Once the draft is cleared, a new quiet-period countdown runs. Submitted steering is handled by Pi normally, including mid-stream steering/follow-up behavior.
- `/loop stop` disarms future rounds immediately. It does **not** abort the model or kill commands already running. Use Pi's normal Escape abort for active work. An aborted/erroring agent also disarms the loop.
- The footer shows the current round and countdown. `/loop status` includes the selected delay and last stop reason.
- Reload, quit, session replacement, tree navigation, and compaction discard/disarm the loop. There is no automatic recovery or persisted armed timer. Starting again is explicit and requires confirmation.

## Checkpoint contract

Each work chunk must finish with `loop_checkpoint` as its **last tool call**, followed by a short user-facing summary. The tool accepts:

- `outcome`: `continue`, `done`, `blocked`, `waiting`, or `no_progress`.
- `progress`: concrete new progress plus verification evidence, or an honest blocker (up to 2000 characters).
- `next`: specific next authorized action for `continue`; may be empty otherwise (up to 2000 characters).

Only `continue` can arm another countdown. All other outcomes stop automatic continuation. Missing/stale checkpoints, identical normalized progress summaries, or two consecutive failed non-checkpoint tools also stop it. Every subsequent tool attempt (including a failed second checkpoint) invalidates it; so do non-checkpoint tool completions, to avoid relying on a checkpoint submitted alongside parallel work. The tool cannot start/restart a loop, increase limits, or authorize operations.

Progress/completion are **model attestations, not independent proof**. Exact repeated-summary detection catches a simple stall, not semantic repetition. A model can misjudge completion or describe the same work differently. Human steering and review still matter.

## Limits and interaction with other extensions

- At most **5 automatically initiated rounds total**, including the initial round, within a **30-minute continuation window**. Explicit user messages are not automatic rounds and do not refresh these budgets.
- The deadline prevents future automatic continuation, but does not abort an in-flight round. It is **not** a hard runtime, token, or monetary cap: one round may contain many tool calls, provider retries, and substantial usage. The timer is checked once per second and depends on Node's event loop being responsive.
- Blocking extension UI prompts disarm the loop even if subsequently approved; restart explicitly after resolving the decision. The loop's own start-confirmation is exempt.
- `job_start` or any `subagent` tool call disarms automatic continuation conservatively (including subagent management queries). The model can finish independent work normally; children/jobs retain their native notification and cancellation behavior. The loop neither polls nor kills them. Restart explicitly after their results are consumed.
- External extension input/custom messages also disarm the loop, avoiding competing automation. A session-branch watermark catches idle custom messages that Pi does not forward to extension message hooks; any unexpected branch change during countdown conservatively stops it, even if an extension only appended bookkeeping. Arbitrary extension slash commands bypass Pi's input hook; not all are detectable. Busy/pending work prevents a countdown firing and requires a fresh checkpoint. Custom extensions that alter runtime behavior need their own compatibility assessment.
- Only the interactive **TUI** can start a loop. RPC, print, JSON, and the configured headless workers cannot start one. No loop is enabled by default.
- Pi's `sendMessage` API has no asynchronous delivery receipt. Immediate exceptions stop the loop, but an internal asynchronous dispatch failure may leave it showing working until the deadline. The loop does not automatically retry dispatch. Use `/loop stop` if no work begins.
- Generated rounds are visibly labeled custom messages, not fabricated user messages. They carry the original goal, latest checkpoint's next step, and unchanged-permissions reminders.
- Existing deletion guards, approval requirements, and subagent protocol rules remain in force. This is scheduling convenience, not a sandbox or expanded authority.

## Design and verification

`loop.ts` owns bounded state transitions and command-option validation. `index.ts` owns Pi lifecycle hooks, the confirmation UI, timer, tool registration, and message dispatch. State lives only in the extension instance; the normal Pi conversation records messages/tool results but never restores the loop's armed state.

The installed pi-subagents goal missions provide needs-attention notices tied to durable delegated work. They are not this delayed parent-loop contract; their mission/schedule settings are unchanged.

From the `~/.pi` repository:

```bash
# Policy tests; loader integration tests explicitly skip without PI_TEST_PACKAGE_DIR.
node --test agent/extensions/goal-loop/test/*.test.mjs

# Real Pi loader plus simulated lifecycle, UI, message sink, and clock. No model calls.
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/goal-loop/test/*.test.mjs
```

Tests cover delay boundaries, budgets, checkpoints, failures, steering, typing, explicit cancellation, lifecycle cleanup, background handoff, and unsafe start rejection. Timers are advanced with Node's mock clock: no minute-long sleeps, filesystem fixtures, or live model usage. Loader integration verifies registration against the installed SDK, not a complete real agent session. After `/reload`, manually check the countdown, steering, and stop behavior with a small read-only goal. Do not use a destructive task for a smoke test.
