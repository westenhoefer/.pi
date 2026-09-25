# Opt-in desktop notifications

Auto-discovered on `/reload`. No dependency installation, registry edits, or machine configuration changes are required. Reload cancels existing subscriptions; it also cancels this repository's background jobs.

```text
/notify Fix the parser bug and verify the regression
/notify status
/notify off
/notify test
/notify -- status

/loop --manual Fix the parser bug and verify the regression
/loop resume
/loop stop
```

## Behavior

- `/notify <task>` sends the task as a normal user message and arms a session-local notification subscription. Start while Pi is idle. Ordinary tasks remain silent.
- The agent calls `notify_checkpoint` as its **last tool call**, then summarizes. `done` sends one completion notice after Pi settles and clears the subscription. `needs_input` sends an attention notice and keeps it armed for the user's reply. `waiting` keeps it armed **without** notifying.
- Merely becoming idle, launching a job/subagent, or receiving a background result is **not completion**. Background/delegated results must be consumed before the agent reports `done`. Completion is a **model attestation**, not independently verified process/task tracking. A missing or stale checkpoint sends no completion notice; the footer continues to show the subscription as armed.
- Blocking extension UI prompts also send an input-needed notice. Repeated prompts and a matching `needs_input` checkpoint are deduplicated until normal user input. A final error/abort sends an interruption notice and clears the subscription; intermediate errors that Pi successfully retries do not produce a false failure notice.
- `/notify off` cancels only the task notification subscription, not running work. `/notify status` reports it. `/notify test` sends a fixed test attention notice, without arming a task or invoking the model. Use `--` to escape reserved command words.
- Only one task subscription is active at a time. Replies/steering belong to the armed task until completion or `/notify off`; the extension cannot infer when an unrelated task has replaced it. Cancel explicitly when abandoning a task.
- Manual loops send an approval notice once per iteration, plus completion/stopped notices. `/loop resume` approves **one** next iteration. Approval takes place in Pi, never through a toast. Automatic loops remain silent on desktop.
- Do not nest slash commands in `/notify`. Starting `/notify` during an active loop is rejected. Starting a loop cancels any prior task subscription so the two checkpoint contracts never compete.
- Reload, shutdown, tree navigation, and session replacement cancel task subscriptions. Nothing is persisted or restored. Task subscriptions survive compaction in the same session and re-inject their checkpoint instructions on the next run.

## Delivery and privacy

Only fixed generic statuses are sent to the desktop: no goal, code, command, path, or model-generated text. Notifications are alerts, not additional permissions. They do not wake the agent, append custom conversation entries, click buttons, or execute task content.

Backends:

- **Windows:** native toast through `powershell.exe`, including terminals without `WT_SESSION`. Requests the `Microsoft.WindowsPowerShell` notification identity, which may not appear in Windows' app notification list until a toast has been successfully delivered. The script is encoded, non-interactive, bounded to five seconds, and does not change execution policy, register an application, or install anything.
- **Windows Terminal under WSL:** uses `powershell.exe` through Windows interop when `WT_SESSION` is present.
- **Kitty:** OSC 99.
- **Ghostty, iTerm2, WezTerm, rxvt-unicode:** OSC 777.
- Other terminals: an in-Pi warning rather than claiming desktop delivery.

TUI only; no desktop alerts are emitted from RPC, JSON, print, or headless workers. Each desktop attempt also displays an in-Pi status notice. Backend errors produce a bounded diagnostic warning (including PowerShell's stderr when available) without retry loops or starting more model work. Windows Focus Assist/Do Not Disturb and terminal/OS notification settings may suppress a successfully submitted notification; submission does not prove it was displayed. Use `/notify test` to verify your actual desktop setup.

## Ownership and integration

`task.ts` owns the one-task subscription and checkpoint policy. `desktop.ts` owns fixed-message backend requests and delivery. `index.ts` owns Pi commands, tools, lifecycle, and event handling. `contract.ts` defines the narrow `pi:attention` event: `{ sessionId, kind }`, with an allowlisted status kind and no task text.

The goal-loop adapter emits attention requests after settlement (or when a UI decision interrupts work). The notification extension owns desktop delivery. The synchronous `goal-loop:query` event fills an `active` boolean for command exclusion; `goal-loop:started` cancels an old task subscription. Neither event grants permission to start or resume a loop.

## Verification

From the `~/.pi` repository:

```bash
node --test agent/extensions/goal-loop/test/*.test.mjs agent/extensions/notifications/test/*.test.mjs

PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/goal-loop/test/*.test.mjs agent/extensions/notifications/test/*.test.mjs
```

Without `PI_TEST_PACKAGE_DIR`, SDK integration tests explicitly skip. Policy tests use the installed Node's TypeScript support. Integration tests load both extensions through the real Pi loader, with simulated lifecycle/UI/clock and injected notification delivery. They never send real desktop notifications, launch PowerShell, or call a model. Production registration and encoded backend requests are checked separately.

Manual smoke test after reload: run `/notify test`, a small read-only `/notify` task, then a small `/loop --manual` task. Verify approval stays paused until `/loop resume`, `/loop stop` prevents continuation, and real Windows toast delivery works. Automated tests are not an end-to-end desktop or live-model verification.
