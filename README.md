# Personal pi configuration

Remote: `git@github.com:westenhoefer/.pi.git`

This repository tracks selected personal settings, instructions, agent profiles, extensions, and Pi-specific skills under `agent/skills/`. Cross-tool skills remain in the separate `~/.agents` repository.

The `.gitignore` is allowlist-based. Authentication, model stores, sessions, caches, package installs, trust decisions, and backups are not tracked. Review `git status --short --untracked-files=all` and the staged diff before committing; allowed configuration files can still contain sensitive values.

## Tooling

| Component | Configuration | Status |
|---|---|---|
| `pi-web-access@0.28.0` | `agent/web-search.json` | Enabled; Exa search, raw results, direct HTTP fetching |
| `pi-cursor-sdk` (currently 0.5.29) | User-managed package in `agent/settings.json` | Parent provider; explicitly initialized for Cursor-selected children with Pi-only role tools |
| Session-owned subagents | `agent/extensions/simple-subagents/`, `agent/agents/` | Auto-discovered on `/reload`; parallel RPC children, mixed-model `/panel` exploration and tabbed result viewer, steering, goal-loop coordination |
| `pi-subagents@0.66.0` | `agent/extensions/subagent/config.json`, `agent/settings.json` | Retained but all package resources disabled; legacy configuration preserved |
| Custom background jobs | `agent/extensions/background-jobs/` | Auto-discovered on `/reload` |
| Chat snapshot viewer | `agent/extensions/chat-view/` | Auto-discovered on `/reload`; `/chat-view` opens saved user/assistant text without thinking or tools |
| Bounded goal loop | `agent/extensions/goal-loop/` | Auto-discovered on `/reload`; `/loop [--manual \| --delay <seconds>] [--rounds <1–20>] <goal>` |
| Desktop notifications | `agent/extensions/notifications/` | Disabled in `agent/settings.json`; source/tests retained, Switchboard replaces desktop alerts |
| MCP Browser | `agent/mcp.json` → `mcp-browser` | Shared browser, persisted Mermaid diagrams, and Switchboard; namespaced tools through `codemode` |

Package sources and pins are recorded in `agent/settings.json` and installed under `agent/npm/`; Cursor is currently an unpinned user-managed package. Existing lifecycle-script policy is unchanged. No package installation, upgrade or global npm change was performed by the panel work. Review updates deliberately. The local dependency lockfile is runtime state and is not tracked by this configuration-only repository.

### Web access

Exa is selected explicitly; without an Exa key the package uses its hosted MCP search endpoint, with no separate MCP adapter required. Search queries go to Exa. No provider fan-out, browser-cookie access, curator auto-open, GitHub cloning/authenticated PR specialization, hosted extraction fallback, video, PDF, or image processing is enabled. Direct HTTP fetching is not a full browser and can fail on JavaScript-only pages. `source_check` remains available for selective evidence checks.

Fetched page content is cached at `C:\Users\johan\.pi\agent\web-search-cache`; the package evicts entries after its one-hour TTL or when its 128-entry/128-MiB bounds require it. The user approved automatic cleanup of **package-owned cache files at that exact location**, including when Pi works in another repository.

### Subagents

Personal profiles:

- `scout`: read-only repository investigation.
- `reviewer`: read-only findings; no automatic fixes or shell execution.
- `worker`: implementation of explicitly authorized tasks, one writer per shared scope.

The custom supervisor uses these three personal profiles with fresh task context, inherited personal/project instructions and skills, explicit role tools/extensions, and the parent's model/thinking by default. `subagent_start` can select an exact authenticated `model` and optional `thinking` for one child without changing the parent or role defaults. Children run asynchronously in Pi RPC subprocesses. It does not discover additional project/shared agents or grant nested delegation.

Use `subagent_start`, `subagent_status`, `subagent_steer`, and `subagent_stop` for individual assignments; `/subagents` shows exact child IDs. Use `swarm_start` for a fixed batch of structured tasks or CSV rows, with `swarm_status`, paged `swarm_results`, and explicit `swarm_pause`, `swarm_resume`, and `swarm_stop`. The queue advances without a parent-model turn per item; a widget shows progress and swarms coalesce completion/needs-input wakes. Independent review is a separate reviewer-role swarm, never an automatic approval or repair engine.

Use **`/panel [question]`** to give the same self-contained exploratory brief to multiple models: type to filter by display name/provider/model ID, **Enter** toggles selections, then **Tab → Enter** activates Start. Panels are read-only scouts using the existing swarm queue; children never see each other's answers or the parent conversation. **`/panel view [id]`** opens a snapshot overlay with a Comparison tab and original model-answer tabs; ←/→ switches tabs, **c** copies Markdown, **r** refreshes, and **Esc** only closes. **`/panel stop [id]`** explicitly cancels a panel. Viewing is refused during an active goal loop to avoid the existing overlay-prompt policy silently stopping queued work; finish or explicitly stop the loop first. Progress stays in the widget; completion asks the parent to consume all result pages and save an attributed synthesis with `panel_compare`, displayed in chat and the viewer without changing original answers. `panel_start` exposes the same launcher to the agent. Answers retain the existing 16,000-character limit with visible truncation; no live streaming or per-model conversations are added. See [panel controls, model selection and persistence](agent/extensions/simple-subagents/README.md#model-panels).

All roles, direct children, and swarms share one concurrency ceiling per Pi instance: **5** by default, configurable through user-level `simpleSubagents.maxConcurrency` in `agent/settings.json`. Per-swarm `maxParallel` can request less, never raise it. Batches can exceed twenty tasks. Deadlines default to fifteen minutes from dispatch, up to one hour per task. Children share the cwd; use non-overlapping assignments and one writer per shared scope. The [Pi subagent reference](../.agents/skills/agent-tools/references/pi-subagents.md), selected through `agent-tools`, covers task scoping, evidence consumption, separate reviews, and recovery.

Reload/session replacement/shutdown stops children. Swarm manifests and outcomes survive under the agent directory, but armed execution does not: resuming never-started items requires explicit authorization, and failed/interrupted attempts are not silently replayed. Exclusive per-run ownership prevents duplicate recovery; stale claims or unconfirmed writers require explicit reconciliation as described in the extension README. Failed storage writes cannot guarantee durable evidence. There are no missions, workflow/DAG engines, automatic worktrees, commits, merges, or detached survival. The supervisor integrates directly with goal-loop's waiting and approval policy. See [contracts, limitations and tests](agent/extensions/simple-subagents/README.md). The old package remains installed but unloaded, with its configuration and profiles preserved for reversibility.

The user approved cleanup of package-owned run/cache files under `C:\Users\johan\AppData\Local\Temp\pi-subagents-user-johan`. This does not authorize worktree or source-file deletion.

The user also approved removal of package-created `C:\Users\johan\AppData\Local\Temp\pi-subagents-tracked-diff-*` scratch directories used to fingerprint large Git diffs, including when Pi works in another repository. These legacy cleanup exceptions do not authorize worktree or source-file deletion; this migration performs no package cleanup. Do not enable managed worktrees, external CLI agents, or other cleanup features without checking their separate side effects.

### Cursor children

Cursor-selected children explicitly initialize the installed provider through `agent/extensions/simple-subagents/cursor-child.ts`; `--no-extensions` still excludes unrelated ambient extensions. Cursor-native tools and ambient Cursor settings/MCP are disabled, and the Pi bridge exposes the child's existing role tools. Parent configuration remains unchanged. The real-provider offline startup check sends no model prompt; live inference is not covered.

The user approved normal cleanup of **child-owned files/directories under `C:\Users\johan\.pi\agent\simple-subagents\cursor-tmp`** for current/future Cursor children, and the provider's normal deletion of its own valid regular-file catalog cache **`C:\Users\johan\.pi\agent\cursor-sdk-model-list.json`** when credentials are absent, including when Pi works in another repository. These exceptions do not cover auth/settings, persistent agent stores, existing unrelated files, or system-temp contents. See [child policy and limits](agent/extensions/simple-subagents/README.md#cursor-provider-in-children).

### Chat snapshot viewer

Use `/chat-view` to revisit saved messages in the current branch, including older pre-compaction messages, without thinking or tool output. The read-only snapshot opens at the latest message: use arrows/PageUp/PageDown to scroll, ←/→ to jump between messages, **c** to copy the top message, and **Esc** to close. Reopen to refresh; the native view, execution and session history remain untouched. See [controls and limitations](agent/extensions/chat-view/README.md).

### Background shell jobs

Use `/bg <bash command>`, `/jobs`, `/job-logs <id>`, and `/job-stop <id>`. The agent gets `job_start`, `job_status`, `job_logs`, and `job_stop` tools. Jobs use Git Bash on Windows, are cancelled on session shutdown/reload, and retain bounded in-memory log tails without creating or cleaning log files. Agent-started jobs automatically resume the agent on completion (including failure); manual `/bg` jobs remain notification-only. See [the extension README](agent/extensions/background-jobs/README.md) for limits, lifecycle semantics, caveats, and test commands.

### Bounded goal loop

`/loop <goal>` starts a confirmed, session-local continuation loop: up to five rounds by default, a 30-minute continuation window, and a default 60-second delay after Pi settles. Use `/loop --rounds 10 <goal>` to set a total of 1–20 rounds (including the first), or `/loop --delay 15 <goal>` for a different per-loop delay (1–600 seconds). Normal input steers without resetting budgets; typing pauses the countdown. `/loop stop` cancels future rounds. Completion, blockers, missing checkpoints, aborts, unsupported background handoffs, and session lifecycle changes disarm it. Session-owned children and whole queued swarms instead suspend the loop within the same round until their results are consumed; manual approval and budgets remain unchanged. Stopping/expiring the loop revokes further swarm admission without killing active children. No timers survive reload. See [contracts, limitations, and tests](agent/extensions/goal-loop/README.md).

`/loop --manual <goal>` pauses between iterations until `/loop resume` approves one next round. The desktop-notification extension is disabled; agents use Switchboard for relevant updates and completion. Manual loops have no time deadline, even while awaiting approval; the selected round limit (default five) still applies. The 30-minute deadline applies only to automatic loops. Feedback alone does not resume a manual loop; terminal stops require a new loop.

### MCP Browser

Pi uses its built-in MCP support to read `agent/mcp.json`. The `mcp-browser` entry runs `C:\Users\johan\terra-tech\prototypes\mcp-browser\dist\mcp-browser.exe` with `--mcp`, the shared `%APPDATA%\MCPBrowser\Wails` data directory, and agent name `Pi`. MCP tools use the default `codemode` exposure: discover them with `searchTools()` or `describeNamespace("mcp__mcp_browser")`, then call `tools.mcp__mcp_browser__<tool>()` from a `codemode` script. This machine-local configuration is Git-ignored; `/mcp` inspects configured servers and connections.

Browser, diagram, and Switchboard operating guidance lives in `agent-tools` and its on-demand references; communication policy lives in `development-workflow` and is surfaced by `agent/AGENTS.md`. Agents proactively send significant progress/input-needed updates and always send a task-completion notice when Switchboard is available, so the user knows they can continue. Chat is the fallback when unavailable. This is agent-driven communication, not automatic loop approval or a background-job completion hook. The redundant desktop-notification extension is disabled; reload unloads its commands, tools and injected instructions.

### Skills

Skills are discovered from `agent/skills/` and `~/.agents/skills/`; their instructions guide work without enabling integrations. The three shared core entry points are:

- [`development-workflow`](../.agents/skills/development-workflow/SKILL.md): coordinate design, investigation, handoffs, review, and PR work.
- [`engineering-practices`](../.agents/skills/engineering-practices/SKILL.md): judge and produce code, tests, documentation, refactoring, and verification.
- [`agent-tools`](../.agents/skills/agent-tools/SKILL.md): use the relevant browser, diagram, Switchboard, subagent, and worktree tools.

Read only the references relevant to the task; they are not separate skill entry points. Specialist skills remain available. Session-owned subagents inherit instructions and skills but do not load MCP integrations; they return source evidence for the parent to publish.

## Safety and reload

- Use Pi's first-party providers or the explicitly configured Cursor SDK integration. Cursor-selected children retain Pi role-tool limits through the provider's supported MCP-only mode; other extension providers must still be configured explicitly.
- `agent/AGENTS.md` provides behavioral filesystem and approval rules, not an enforced sandbox. Parent sessions and subagents use Pi's normal instruction discovery; children keep context-file discovery enabled even with ambient extensions disabled.
- The deletion guard is disabled because its conservative parser caused excessive interruptions. Its code/tests are archived under `agent/disabled-extensions/deletion-guard/`, outside auto-discovery; the worker and `/bg` no longer load it. Reload existing parent sessions and launch fresh children to unload old instances. No command/path enforcement is provided by that guard while disabled.
- Existing package-owned cleanup approvals remain narrow exceptions, not general shell-deletion exemptions.
- MCP integrations use Pi's built-in MCP support and namespaced tools through `codemode`.
- Default model is `openai-codex/gpt-6.1-sol`, high thinking.

Use `/reload` to apply MCP configuration changes and load enabled extensions, agent resources, skills, and context files. Reload cancels custom background jobs and session-owned subagents and discards their in-memory histories; durable swarm inputs/results remain readable without restarting work. Restart pi to apply startup defaults reliably; resumed sessions may restore model/thinking selections.
