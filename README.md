# Personal pi configuration

Remote: `git@github.com:westenhoefer/.pi.git`

This repository tracks selected files under `agent/`: model/UI settings, personal instructions, and any extensions, prompts, themes, or pi-only skills added later. Shared skills remain in the separate `~/.agents` repository.

The `.gitignore` is allowlist-based. Authentication, model stores, sessions, caches, package installs, trust decisions, and backups are not tracked. Review `git status --short --untracked-files=all` and the staged diff before every commit; allowed configuration files can still contain sensitive values if edited carelessly.

## Current setup

- Default model: `openai/gpt-6-astra`, medium thinking.
- `agent/AGENTS.md` currently contains behavioral safety instructions, not enforced permissions.
- A programmatic guardrail extension is pending the choice between per-command approval and a sandboxed execution environment. Do not assume these instructions restrict filesystem access.
- Pi does not natively load MCP configuration; MCP requires a trusted integration extension. No MCP bridge is installed by this setup.

Use `/reload` to reload skills, extensions, and context files. Restart pi to apply startup defaults reliably; resumed sessions may restore their own model/thinking selections.
