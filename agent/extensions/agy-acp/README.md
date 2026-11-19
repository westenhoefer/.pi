# Antigravity native ACP for Pi

This local Pi extension adds `agy-acp/*` to `/model`. The Antigravity CLI owns its agent loop, native tools, and native permissions. Pi streams text and reasoning, shows native tool activity in the status bar, and can provide selected Pi tools over a loopback MCP bridge. It does not replace the built-in Codex provider or the Cursor SDK extension.

## Use

1. In an interactive Pi session in a **trusted workspace**, run `/reload` (or start a new Pi process). The extension is discovered by its `index.ts`; no npm package is required.
2. Run `/agy-acp refresh` to populate `/model` from the CLI. This starts an ACP process and opens a discovery session; it does not send a model prompt. Without refreshing, `agy-acp/gemini-3.8-flash` is listed as a bootstrap entry, not proof of model availability or working auth.
3. In `/model`, choose one of the `agy-acp` models. Run `/agy-acp status` to see the current session and active allowlist, or `/agy-acp reset` to close the ACP process and reconstruct from Pi history on the next prompt.

On Windows this launches `%USERPROFILE%\bin\agy.cmd acp --stdio` through `cmd.exe`; it does **not** fall back to `agy.exe`. Your wrapper owns authentication and must forward its arguments and stdio, run the child synchronously, and keep stdout reserved for ACP frames (for example, start with `@echo off`). The extension does not read the wrapper or use Pi's credential store. Set `PI_AGY_ACP_COMMAND` to an absolute executable or batch path to override it. Other platforms default to `agy` on `PATH`.

### Optional Pi tools

Nothing is bridged by default. To expose an exact comma-separated list of **active** Pi tools, launch a new Pi process from PowerShell, in the workspace you want Antigravity to use:

```powershell
$env:PI_AGY_ACP_TOOLS = 'job_status'
pi
```

The example only works if `job_status` is an active Pi tool. Use `/agy-acp status` to check the intersection. Allowlisted calls appear as `pi__*` MCP tools on the Antigravity side and execute as ordinary Pi tool calls, subject to Pi's tool hooks. Overlapping Pi built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) remain hidden.

## Boundaries

- **Antigravity's native tools don't run through Pi's hooks.** The CLI's normal user/project configuration, configured MCP tools, and permission policy still apply. If the CLI asks permission, Pi defaults to deny and only offers a one-time approval for reviewable action details. Pi cannot require approval for actions the CLI never asks about, and does not configure a sandbox.
- This first version is for interactive Pi only, not Pi subagents, print/RPC mode, or other callers expecting a model without tools. Switch to a model-only provider for Pi compaction and branch summaries. ACP sessions stay warm until reset or invalidated; they don't resume across restarts. A rebuilt session gets bounded text history and the latest attachments, not prior images or native tool state. Steering during a bridged tool rebuilds the ACP session so Antigravity gets the new instruction. If agy doesn't offer a literal Off effort, Pi's Off choice restores agy's default.
- Prompts use Pi's HTTP idle timeout (5 minutes by default, or disabled when `httpIdleTimeoutMs` is disabled) as an ACP activity watchdog—resetting on streamed updates and pausing during permission prompts or parked Pi tools—alongside a 2-hour overall turn ceiling. Turns stopped by the idle watchdog or turn ceiling are not retried automatically.
- On Windows, cancellation sends `session/cancel` and teardown targets the owned process tree while the wrapper is alive. If the wrapper exits first, the extension can't confirm its descendants stopped and blocks new runs until Pi is restarted. Check for leftover processes before restarting. No credentials or raw ACP diagnostics are written by the extension.

## Offline checks

From the Pi config repository root, set `PI_TEST_PACKAGE_DIR` to the installed `@earendil-works/pi-coding-agent` directory, then run `node --test agent/extensions/agy-acp/test/*.test.mjs`. The suite uses a fake ACP agent and an authenticated loopback server; the Windows launcher check runs a harmless batch fixture with spaces in its path. None of the tests invokes the real `agy.cmd` or uses model quota.
