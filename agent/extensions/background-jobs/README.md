# Background jobs

A small, session-owned background Bash runner. Uses Pi's public API and its bundled `typebox`. It does not implement subagents, provider configuration, scheduling, automatic installation, or a security sandbox.

## Use

```text
/bg npm run test -- --watch
/jobs
/job-logs <exact-job-id>
/job-stop <exact-job-id>
```

Agent tools:

- `job_start({ command, name?, timeoutSeconds? })`
- `job_status({ id? })`
- `job_logs({ id, maxBytes?, maxLines? })`
- `job_stop({ id })`

Commands run in the canonical current session directory. There is no alternate-cwd parameter or arbitrary-PID stop operation. Commands use Pi's default Bash resolver, which selects Git Bash on this Windows setup—not PowerShell or cmd. Custom `shellPath`, `commandPrefix`, overridden bash tools, and hooks registered specifically for `bash` are not inherited. `/bg` is an explicit user command, not an agent tool call. Neither entry point adds command/path approval checks.

## Lifecycle and bounds

- Launch returns immediately; `running` is acceptance, not evidence that the shell started successfully. Check status and logs for failures.
- Four active jobs maximum. A job waiting for termination still consumes capacity.
- Default deadline: one hour. Tool callers may choose 1–86400 seconds.
- Keeps the last **256 KiB of merged stdout/stderr per job**, in memory. No full-output spill files. Older bytes are discarded.
- Log reads default to 16 KiB / 200 lines, with maxima of 50 KiB / 2000 lines (excluding the short status header). Terminal controls are stripped. Output is untrusted data.
- Retains at most 32 jobs; starting another evicts the oldest finished entry, never an active entry. Maximum retained raw output is 8 MiB.
- Completion generates a UI notification. Jobs launched with `job_start` also send an automatic agent follow-up on success, failure, timeout, or cancellation: it starts a model turn when idle, or queues behind the current agent run. This may incur model usage. The agent should inspect `job_logs` and continue only the still-authorized task, respecting newer user instructions—not blindly retry failed or cancelled work.
- Manually launched `/bg` jobs remain notification-only: their completion message waits for the next user turn and does not trigger a model call.
- After `job_start`, the agent can continue independent work, then return control with a waiting update at a dependency barrier. Completion resumes it without a manual prompt; polling or sleeping merely to wait is unnecessary. Shutdown suppresses completion messages and automatic wake-ups.
- Escape after launch does **not** stop a job. Use `job_stop` or `/job-stop`.
- Session shutdown, `/reload`, `/new`, `/resume`, and `/fork` request cancellation and wait up to five seconds. History and output are not restored afterward. `/tree` remains in the same session; it neither stops jobs nor undoes their effects.
- TUI and persistent RPC sessions can launch jobs. Print and JSON modes are rejected because they exit after the foreground task.

## Process limitations

The registry delegates execution and process-tree cancellation to Pi's public `createLocalBashOperations()` backend. On Windows that backend uses `taskkill /F /T`; on POSIX it kills the process group. Stop requests are idempotent. If the backend has not settled after five seconds, status remains `stopping`, and shutdown reports unconfirmed termination.

Keep commands in the foreground: no `&`, `nohup`, daemonization, or detached descendants. Pi's backend does not provide OS containment, and a successful shell exit is not proof that an intentionally detached descendant is gone. Force-killing Pi, machine failure, escaped descendants, or a failed OS kill can leave processes behind. This extension does not recover jobs, retry commands, or kill persisted PIDs after restart.

Commands run with the user's permissions/environment plus current Pi session metadata. They may write/delete files, use credentials, access the network, or incur service costs. Existing safety instructions still apply. There is no command/path enforcement in this runner. Bash-specific hooks are not inherited.

## Verification

From the `~/.pi` repository, Node 22.18+ (tested on Node 26.8.1):

```bash
# Dependency-free registry behavior; integration tests report explicit skips.
node --test agent/extensions/background-jobs/test/*.test.mjs

# Include real process and Pi-loader tests using the already-installed Pi package.
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/background-jobs/test/*.test.mjs
```

The integration tests start local Node processes, including a parent/grandchild cancellation canary. They make no model calls, install nothing, and create/delete no test files. Tests cover failure exits, missing working directories, bounded logs, timeout, capacity/eviction, unconfirmed cancellation, headless rejection, actual extension loading, agent-versus-manual completion delivery, exactly-once follow-ups for success/failure/timeout/cancellation, and shutdown suppression. Windows process-tree termination is tested locally; POSIX behavior relies on Pi's backend and has not been exercised on this machine.
