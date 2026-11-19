# Personal pi configuration

Remote: `git@github.com:westenhoefer/.pi.git`

Allowlist-tracked Pi settings, instructions, leaf agent profiles, and custom extensions. Authentication, model stores, sessions, caches, package installs (`agent/npm/`), and machine-local `agent/mcp.json` are ignored. Inspect `git status --short --untracked-files=all` and staged diffs before committing.

## Components

| Surface | Canonical owner | Notes |
|---|---|---|
| Behavioral rules | [`agent/AGENTS.md`](agent/AGENTS.md) | Scope, package, Git, mechanical-repair, two-failed-fixes, Switchboard, and locality rules |
| Runtime & packages | [`agent/settings.json`](agent/settings.json) | Default provider/model/thinking, UI formatting, and installed Pi packages |
| Web search & fetch | [`agent/web-search.json`](agent/web-search.json) | `pi-web-access` config; automatic eviction of package-owned cache files under `C:\Users\johan\.pi\agent\web-search-cache` is approved across repositories |
| MCP Browser | `agent/mcp.json` (untracked), [`agent-tools`](../.agents/skills/agent-tools/SKILL.md) | Local `mcp-browser` server (tabs, Mermaid diagrams, Switchboard) called via `codemode` |
| Leaf agent roles | [`agent/agents/scout.md`](agent/agents/scout.md), [`reviewer.md`](agent/agents/reviewer.md), [`worker.md`](agent/agents/worker.md) | Role defaults for session-owned RPC children |
| Subagents, swarms & panels | [`agent/extensions/simple-subagents/README.md`](agent/extensions/simple-subagents/README.md) | Admission pool, RPC children, Cursor child bootstrap, fixed swarms, and `/panel` |
| Bounded goal loop | [`agent/extensions/goal-loop/README.md`](agent/extensions/goal-loop/README.md) | `/loop` automatic and `--manual` continuation state machine |
| Background shell jobs | [`agent/extensions/background-jobs/README.md`](agent/extensions/background-jobs/README.md) | `/bg`, `/jobs`, and `job_*` session-owned Git Bash runner |
| Chat snapshot viewer | [`agent/extensions/chat-view/README.md`](agent/extensions/chat-view/README.md) | `/chat-view` read-only branch overlay without thinking or tool output |
| Shared skills | [`../.agents/README.md`](../.agents/README.md) | Cross-harness `development-workflow`, `engineering-practices`, `agent-tools`, and specialist skills |

Use `/reload` to apply MCP, extension, role, skill, and instruction updates (cancels active background jobs and session-owned subagents). Restart `pi` to apply startup model/thinking defaults to fresh sessions.

## Verification

Run offline extension suites from `C:\Users\johan\.pi` using the globally installed `@earendil-works/pi-coding-agent` package (no network calls or downloads):

```powershell
Set-Location C:\Users\johan\.pi
$env:PI_TEST_PACKAGE_DIR = Join-Path (npm root -g) '@earendil-works/pi-coding-agent'
$env:PI_OFFLINE = '1'
node --test agent/extensions/simple-subagents/test/*.test.mjs agent/extensions/goal-loop/test/*.test.mjs agent/extensions/background-jobs/test/*.test.mjs agent/extensions/chat-view/test/*.test.mjs
```

```bash
cd /c/Users/johan/.pi
PI_TEST_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" PI_OFFLINE=1 \
  node --test agent/extensions/simple-subagents/test/*.test.mjs agent/extensions/goal-loop/test/*.test.mjs agent/extensions/background-jobs/test/*.test.mjs agent/extensions/chat-view/test/*.test.mjs
```

When running from inside a leaf RPC child, also set `PI_SIMPLE_SUBAGENT=0` for the test process so parent-loader cases are not skipped by the inherited child marker.
