# Personal pi configuration

Remote: `git@github.com:westenhoefer/.pi.git`

This repository tracks selected personal settings, instructions, agent profiles, and extensions. Shared skills remain in the separate `~/.agents` repository.

The `.gitignore` is allowlist-based. Authentication, model stores, sessions, caches, package installs, trust decisions, and backups are not tracked. Review `git status --short --untracked-files=all` and the staged diff before committing; allowed configuration files can still contain sensitive values.

## Tooling

| Component | Configuration | Status |
|---|---|---|
| `pi-web-access@0.28.0` | `agent/web-search.json` | Enabled; Exa search, raw results, direct HTTP fetching |
| Session-owned subagents | `agent/extensions/simple-subagents/`, `agent/agents/` | Auto-discovered on `/reload`; parallel RPC children, steering, completion wakes, goal-loop coordination |
| `pi-subagents@0.66.0` | `agent/extensions/subagent/config.json`, `agent/settings.json` | Retained but all package resources disabled; legacy configuration preserved |
| Custom background jobs | `agent/extensions/background-jobs/` | Auto-discovered on `/reload` |
| Bounded goal loop | `agent/extensions/goal-loop/` | Auto-discovered on `/reload`; `/loop [--manual \| --delay <seconds>] [--rounds <1–20>] <goal>` |
| Opt-in notifications | `agent/extensions/notifications/` | Auto-discovered on `/reload`; `/notify enable\|disable`, task subscriptions, and manual-loop approval alerts |
| Local diagram canvas | `agent/extensions/diagram-canvas/` | Auto-discovered on `/reload`; pinned local Mermaid, browser canvas via `/canvas` |

Packages are pinned in `agent/settings.json`, installed under `agent/npm/`, with dependency lifecycle scripts disabled for this installation. No global npm packages were changed. Review updates deliberately rather than using unpinned latest versions. The local dependency lockfile is runtime state and is not tracked by this configuration-only repository.

### Web access

Exa is selected explicitly; without an Exa key the package uses its hosted MCP search endpoint, with no separate MCP adapter required. Search queries go to Exa. No provider fan-out, browser-cookie access, curator auto-open, GitHub cloning/authenticated PR specialization, hosted extraction fallback, video, PDF, or image processing is enabled. Direct HTTP fetching is not a full browser and can fail on JavaScript-only pages. `source_check` remains available for selective evidence checks.

Fetched page content is cached at `C:\Users\johan\.pi\agent\web-search-cache`; the package evicts entries after its one-hour TTL or when its 128-entry/128-MiB bounds require it. The user approved automatic cleanup of **package-owned cache files at that exact location**, including when Pi works in another repository.

### Subagents

Personal profiles:

- `scout`: read-only repository investigation.
- `reviewer`: read-only findings; no automatic fixes or shell execution.
- `oracle`: read-only second opinion on decisions/plans.
- `researcher`: public-source research; explicitly loads only the web-access extension.
- `worker`: implementation of explicitly authorized tasks, one writer per shared scope.

The custom supervisor uses these five personal profiles with fresh task context, inherited personal/project instructions and skills, explicit role tools/extensions, and the parent's model/thinking by default. Children run asynchronously in Pi RPC subprocesses. The legacy `async: false` profile fields are ignored by this supervisor. It does not discover additional project/shared agents or grant nested delegation.

Use `subagent_start`, `subagent_status`, `subagent_steer`, and `subagent_stop`; `/subagents` shows exact IDs and `/subagents stop <id>` cancels one. A compact widget shows activity, and each finished child automatically wakes the parent with its answer/status. Limits are two concurrent children, twenty starts per session, and fifteen-minute default deadlines (up to one hour per task). Children share the cwd; use non-overlapping assignments and one writer per shared scope.

Reload/session replacement/shutdown stops children and discards their in-memory history. There are no missions, workflow scripts, automatic worktrees, recovery, or detached survival. The supervisor integrates directly with goal-loop's waiting and approval policy. See [contracts, limitations and tests](agent/extensions/simple-subagents/README.md). The old package remains installed but unloaded, with its configuration and profiles preserved for reversibility.

The user approved cleanup of package-owned run/cache files under `C:\Users\johan\AppData\Local\Temp\pi-subagents-user-johan`. This does not authorize worktree or source-file deletion.

The user also approved removal of package-created `C:\Users\johan\AppData\Local\Temp\pi-subagents-tracked-diff-*` scratch directories used to fingerprint large Git diffs, including when Pi works in another repository. These legacy cleanup exceptions do not authorize worktree or source-file deletion; this migration performs no package cleanup. Do not enable managed worktrees, external CLI agents, or other cleanup features without checking their separate side effects.

### Background shell jobs

Use `/bg <bash command>`, `/jobs`, `/job-logs <id>`, and `/job-stop <id>`. The agent gets `job_start`, `job_status`, `job_logs`, and `job_stop` tools. Jobs use Git Bash on Windows, are cancelled on session shutdown/reload, and retain bounded in-memory log tails without creating or cleaning log files. Agent-started jobs automatically resume the agent on completion (including failure); manual `/bg` jobs remain notification-only. See [the extension README](agent/extensions/background-jobs/README.md) for limits, lifecycle semantics, caveats, and test commands.

### Bounded goal loop

`/loop <goal>` starts a confirmed, session-local continuation loop: up to five rounds by default, a 30-minute continuation window, and a default 60-second delay after Pi settles. Use `/loop --rounds 10 <goal>` to set a total of 1–20 rounds (including the first), or `/loop --delay 15 <goal>` for a different per-loop delay (1–600 seconds). Normal input steers without resetting budgets; typing pauses the countdown. `/loop stop` cancels future rounds. Completion, blockers, missing checkpoints, aborts, unsupported background handoffs, and session lifecycle changes disarm it. Session-owned subagents instead suspend the loop within the same round until their results are consumed; manual approval and budgets remain unchanged. No timers survive reload. See [contracts, limitations, and tests](agent/extensions/goal-loop/README.md).

`/loop --manual <goal>` pauses between iterations until `/loop resume` approves one next round, with desktop approval/completion alerts. Manual loops have no time deadline, even while awaiting approval; the selected round limit (default five) still applies. The 30-minute deadline applies only to automatic loops. Feedback alone does not resume a manual loop; terminal stops require a new loop.

### Desktop notifications

`/notify enable` permits agent-requested desktop alerts for the current session, including mid-loop, via `notify_send`. `/notify disable` revokes that permission and cancels any task subscription, without stopping work or changing manual-loop alerts. Permission resets on reload/session replacement. Inside a loop, the agent sends before its final `loop_checkpoint`; alerts do not approve another round.

`/notify <task>` opts one task into desktop completion/input-needed alerts. Waiting for background/delegated work does not count as completion; the agent explicitly reports the overall task outcome. `/notify off` cancels the subscription, `/notify status` inspects it, and `/notify test` checks desktop delivery. Ordinary tasks and automatic loops remain silent unless session permission is enabled and the agent explicitly requests an alert. Windows uses a native PowerShell toast without installing packages or changing machine settings. Only generic statuses leave Pi. See [behavior, supported terminals, caveats, and tests](agent/extensions/notifications/README.md).

### Diagram canvas

Ask Pi to explain code with a flowchart, sequence diagram, or state machine. It can create/update named Mermaid diagrams with explanations and repository-relative source notes, mark current/proposed/mixed designs and observed/inferred relationships, and open them in a local browser canvas. `/canvas` opens it; `/canvas status` reports whether it is listening; `/canvas close` stops the server. Zoom/pan, source inspection, render-error feedback, and sanitized SVG export are included. Mermaid is pinned locally; no hosted rendering or repository-file server is used. See [setup, controls, security boundaries, and tests](agent/extensions/diagram-canvas/README.md).

## Safety and reload

- `agent/AGENTS.md` provides behavioral filesystem and approval rules, not an enforced sandbox. Those general rules remain in place.
- The deletion guard is disabled because its conservative parser caused excessive interruptions. Its code/tests are archived under `agent/disabled-extensions/deletion-guard/`, outside auto-discovery; the worker and `/bg` no longer load it. Reload existing parent sessions and launch fresh children to unload old instances. No command/path enforcement is provided by that guard while disabled.
- Existing package-owned cleanup approvals remain narrow exceptions, not general shell-deletion exemptions.
- No MCP adapter is installed.
- Default model remains `openai/gpt-6-astra`, medium thinking.

Use `/reload` to load enabled extensions, agent resources, skills, and context files. Reload cancels custom background jobs and session-owned subagents and discards their in-memory history. Restart pi to apply startup defaults reliably; resumed sessions may restore model/thinking selections.
