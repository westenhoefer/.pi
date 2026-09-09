# Personal pi configuration

Remote: `git@github.com:westenhoefer/.pi.git`

This repository tracks selected personal settings, instructions, agent profiles, and extensions. Shared skills remain in the separate `~/.agents` repository.

The `.gitignore` is allowlist-based. Authentication, model stores, sessions, caches, package installs, trust decisions, and backups are not tracked. Review `git status --short --untracked-files=all` and the staged diff before committing; allowed configuration files can still contain sensitive values.

## Tooling

| Component | Configuration | Status |
|---|---|---|
| `pi-web-access@0.28.0` | `agent/web-search.json` | Enabled; Exa search, raw results, direct HTTP fetching |
| `pi-subagents@0.66.0` | `agent/extensions/subagent/config.json`, `agent/agents/`, `agent/settings.json` | Enabled; personal profiles and package skill, with bundled workflow prompts disabled |
| Custom background jobs | `agent/extensions/background-jobs/` | Auto-discovered on `/reload` |
| Deletion guard | `agent/extensions/deletion-guard/` | Auto-discovered on `/reload`; one-time confirmation for risky recognized deletion |

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
- `worker`: implementation of explicitly authorized tasks, one writer per shared scope; explicitly loads the deletion guard.

These five profiles inherit both project and global instructions and the skills catalog. They use Pi's normal base prompt plus their role instructions, fresh task context, and foreground execution by default. The researcher can load its explicitly listed provider in the foreground; it does not depend on ambient extension discovery. Profiles do not grant nested delegation or unrelated extension tools. Bundled agents and workflow prompts are disabled so their broader defaults do not replace these profiles. The package also discovers the pre-existing `architecture-style-reviewer`, `spec-conformance-reviewer`, and `ui-ux-developer` definitions in `~/.agents/agents/`; those files were left unchanged and were not included in the five-profile inheritance verification.

Configuration limits fan-out to two concurrent children, four cumulative spawns per run, twenty per session, and fifteen-minute default deadlines. Some package limits can be overridden per call; these are operating defaults, not a sandbox. Scheduled runs, automatic missions, and age-based session-artifact cleanup are disabled. Artifacts use the project `.pi/subagents/` directory. Exclude that directory from commits and package publishing in projects where this tooling is used.

The user approved cleanup of package-owned run/cache files under `C:\Users\johan\AppData\Local\Temp\pi-subagents-user-johan`. This does not authorize worktree or source-file deletion.

The user also approved removal of package-created `C:\Users\johan\AppData\Local\Temp\pi-subagents-tracked-diff-*` scratch directories used to fingerprint large Git diffs, including when Pi works in another repository. The extension and package skill are enabled; bundled workflow prompts remain disabled via `prompts: []`. These cleanup exceptions do not authorize worktree or source-file deletion. Do not enable managed worktrees, external CLI agents, or other cleanup features without checking their separate side effects.

### Background shell jobs

Use `/bg <bash command>`, `/jobs`, `/job-logs <id>`, and `/job-stop <id>`. The agent gets `job_start`, `job_status`, `job_logs`, and `job_stop` tools. Jobs use Git Bash on Windows, are cancelled on session shutdown/reload, and retain bounded in-memory log tails without creating or cleaning log files. See [the extension README](agent/extensions/background-jobs/README.md) for limits, lifecycle semantics, caveats, and test commands.

### Deletion guard

The guard checks common Bash deletion, PowerShell `Remove-Item`/aliases, and inline Python deletion calls. Literal internal targets are allowed; outside/root/`.git` targets and unresolved syntax require one-time confirmation. Symlinks and Windows junctions are checked conservatively. It covers `bash`, `powershell`, `job_start`, `!`/`!!`, and `/bg`; risky commands are blocked when no confirmation UI is available. The worker profile explicitly loads it. `/deletion-guard` shows the current boundary. See [coverage, limitations, and tests](agent/extensions/deletion-guard/README.md).

## Safety and reload

- `agent/AGENTS.md` remains behavioral guidance and was not weakened or replaced. The guard adds enforcement only for its documented command subset.
- Command screening is not an OS sandbox and cannot prove arbitrary scripts safe. Script files, other deletion APIs/tools, remote execution, and package-internal filesystem operations are not comprehensively intercepted. Existing package-owned cleanup approvals remain narrow exceptions, not general shell-deletion exemptions.
- No MCP adapter is installed.
- Default model remains `openai/gpt-6-astra`, medium thinking.

Use `/reload` to load enabled extensions, agent resources, skills, and context files. Reload cancels custom background jobs and discards their in-memory history. Restart pi to apply startup defaults reliably; resumed sessions may restore model/thinking selections.
