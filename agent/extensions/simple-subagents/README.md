# Session-owned subagents

A small parent-TUI supervisor around non-interactive Pi RPC subprocesses. Auto-discovered on `/reload`. The installed `pi-subagents` package is retained but its extensions, skills, prompts and themes are disabled in `agent/settings.json`; do not enable both supervisors together. No package installation or cleanup is needed.

## Surface

- `subagent_start({ agent, task, timeoutSeconds? })`: registers one child and returns its exact ID immediately. Launch acknowledgement is not task success. Invoke twice for two independent parallel tasks.
- `subagent_status({ id? })`: list the session's children, or read one child's retained answer/error.
- `subagent_steer({ id, message })`: queue guidance for a running child. Acceptance means queued, not executed or followed. Delivery occurs after the current assistant turn's tool calls, not in the middle of an executing tool. A settlement race reports unconfirmed delivery; it never revives the child.
- `subagent_stop({ id })`: stop a child. `stopping` means termination is still unconfirmed.
- `/subagents`: show exact IDs and states. `/subagents stop <exact-id>` also works while the parent is idle.

The compact widget shows all active children plus the last two finished children. Detailed status retains up to twenty launches for the lifetime of the session. Every child completion/failure/cancellation generates one native follow-up message with the bounded answer/error and remaining active IDs; the parent can handle it while other children continue. No polling or `bg_wait` is needed. If the parent is already working, delivery is queued as a follow-up rather than starting a concurrent parent run.

Limits are deliberately fixed: two active children, twenty total starts per parent session, 900-second default deadline, optional 1–3600 seconds per task, 16000-character task, 8000-character steering, 16000-character retained answer and 2000-character error. RPC records are capped at 8 MiB, stderr at 8192 characters. There is no full child transcript or recovery store. Custom completion messages and tool results are recorded by the normal parent session.

## Roles, context, and permissions

The initial roles are `worker`, `scout`, `reviewer`, `oracle`, and `researcher`, read from the personal `agent/agents/<role>.md` files. Supported profile fields are `tools`, `extensions`, optional `model`, and the role body. Tools must be explicit and leaf-only. Extension paths are explicit (relative paths resolve against `agent/agents`). Legacy `async: false` is intentionally ignored: all children are asynchronous and session-owned. Only append prompt mode and inherited global/project context and skills are supported. This is not a general pi-subagents-profile compatibility layer; project agent discovery and external runners are absent.

Children:

- Start fresh: the parent must include relevant conversation facts, objective, ownership/scope, approvals, and verification expectations in the task. There is no conversation fork.
- Use the current cwd and inherit the parent's selected model/thinking, unless the personal role has a model override. Provider extensions are **not** inherited; an extension-backed model requires its provider to be listed explicitly in that role. Missing providers/tools fail, without fallback.
- Use Pi's normal personal/project instruction and skill discovery. A small explicitly loaded child runtime appends the role at `before_agent_start`, preserving discovered `SYSTEM.md` and `APPEND_SYSTEM.md`. Already trusted parent project resources are approved only for that same cwd; otherwise trust-gated resources are ignored.
- Disable ambient extensions, prompt templates and themes. Explicit role extensions (the researcher's web provider) and the minimal child runtime are the only loaded extensions.
- Have no nested delegation or background-job tools. Instructions also forbid detached work. These are capability/behavioral limits, **not an OS sandbox**.
- Stop as `blocked` if an extension asks for human input/approval. Nothing is silently approved. Resolve the question and explicitly launch a new task.

Processes share the working directory and user privileges. Parallelism is not filesystem isolation: use non-overlapping assignments and one writer per shared scope. Do not infer installation, deletion, commit, publication or other authority from delegation. Read-only roles have no shell or mutation tools; third-party explicitly loaded extensions remain trusted executable code.

## Ownership and teardown

Children belong to one parent TUI session. Normal `/reload`, session replacement/fork, or shutdown closes them and discards their registry; there is no detached survival, resume or automatic restart. `/loop stop` and Escape in the parent do not cancel children: use `subagent_stop` or `/subagents stop` explicitly.

Shutdown first closes RPC stdin, asking Pi to dispose its runtime and tracked tool processes. After a grace period it attempts forced tree termination (`taskkill /T` on Windows, the owned process group on POSIX). A root crash or forced exit during an active tool cannot prove cleanup of detached tool groups. That case stays `stopping`, reports possible surviving tools, and blocks further starts in that supervisor; inspect local processes rather than assuming a writer has stopped. Unconfirmed teardown is shown as a warning. Hard parent crashes and arbitrary daemonized processes are not covered by the orderly-session guarantee.

`agent_settled`, not `agent_end`, is the completion boundary. Provider retries and compaction remain Pi-owned. The final assistant stop reason distinguishes success from provider failure/abort. Successful child execution is evidence, not proof of a correct implementation.

Pi's `sendMessage` is fire-and-forget: synchronous errors are surfaced, but asynchronous dispatch failure cannot be acknowledged through the extension API. Answers remain readable through `subagent_status`; the supervisor does not automatically retry a wake or claim the parent consumed it.

## Goal-loop contract

Goal-loop owns rounds/approval/deadlines; the supervisor owns execution and delivery. Their process-local contract is in `contract.ts`:

- `simple-subagents:start-query:v1`: synchronous admission query carrying session ID. An active goal-loop returns its loop ID, or refuses launches outside an approved working round.
- `simple-subagents:started:v1`: exact session/loop/child registration before execution.
- `simple-subagent-result` custom message: carries the same identities. Goal-loop consumes an owned child only when this message reaches `message_start`, not merely when its process exits or its message is queued.

The parent checkpoints `waiting` at a dependency barrier. With owned outstanding children this suspends the loop countdown, preserving the same round. Each result wakes the parent to consume evidence or steer remaining children. All registered results must arrive before `continue` or `done`; a fresh final checkpoint is still required. Manual `/loop resume` is required before the next round, and automatic deadlines keep running while waiting. Waiting without owned children retains the old terminal behavior. Legacy `subagent`, `job_start`, unrelated external messages, aborts and lifecycle changes retain conservative stop behavior. Late/foreign results never revive a stopped loop or approve a new round.

## Verification

From `C:/Users/johan/.pi`, using the installed Node (no dependency downloads):

```bash
node --test agent/extensions/simple-subagents/test/*.test.mjs agent/extensions/goal-loop/test/*.test.mjs

PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/simple-subagents/test/*.test.mjs agent/extensions/goal-loop/test/*.test.mjs agent/extensions/notifications/test/*.test.mjs
```

Without `PI_TEST_PACKAGE_DIR`, SDK tests explicitly skip. Tests include pure state policy, real local RPC fixture processes, both extensions loaded through the actual Pi loader with a fake child transport, and installed Pi RPC startup/state/EOF shutdown without a model call. Tests do not approve operations, call models, install packages, or send desktop notifications. They are not a live paid end-to-end model test or a cross-platform process-tree guarantee.

After `/reload`, manually try two read-only scouts, steer one while it is active, verify individual completion wakes and `/subagents`, then repeat inside `/loop --manual` and confirm the next round still waits for `/loop resume`.
