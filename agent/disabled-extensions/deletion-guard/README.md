# Deletion guard (disabled archive)

**Not active.** Moved outside Pi extension auto-discovery after excessive false-positive interruptions. The worker no longer loads it and `/bg` no longer calls its approval function. Do not restore or explicitly load it without user approval. General behavioral filesystem safety rules remain active.

The design/coverage below describes the **former enabled setup**, not current enforcement. Tests explicitly load the archived guard in isolation; the obsolete `/bg`-denial integration test was removed because that integration no longer exists.

An accident-prevention extension for common deletion commands. **Not a sandbox or a complete shell/Python/PowerShell parser.** It does not execute input to discover paths, call an LLM to approve operations, or require Python/PowerShell to be installed.

## Policy

- Ordinary commands with no recognized deletion are unchanged.
- Recognized deletion of literal targets strictly inside the active worktree is allowed.
- Outside targets, the worktree/project root itself, and `.git` require explicit confirmation for that command only.
- Unresolved variables, globs, home shorthand, pipelines, compound commands, unknown deletion options, and unsupported path syntax require confirmation. For less prompting, use a standalone command with literal targets.
- Decline, dismissed/failed UI, or cancellation blocks execution. No UI means risky deletion is blocked, not silently approved. A worker must report the block to the interactive parent rather than find a bypass.
- There is no remembered approval, allow-all mode, or automatic exemption for every command mentioning a cache directory.

The boundary is the nearest ancestor with a `.git` directory/file marker. A `.git` file handles linked worktrees without following the metadata location to the main checkout. If no marker exists, the selected session directory is the boundary. A `cd` inside command text never redefines that boundary; deletion in compound commands requires confirmation. Unusual Git setups defined solely by `GIT_DIR`/`GIT_WORK_TREE` rather than a `.git` marker are not detected.

Existing path components are resolved before processing `..`, including symlinks/junctions and nonexistent trailing components. An inside path resolving outside requires approval. Recursive targets are scanned without following links: nested links, nested `.git`, errors, and exceeding 2000 entries require review. This is deliberately conservative even where a particular shell version would only unlink the link.

Windows checks include case-insensitive containment, drive-letter and Git Bash `/c/...` paths, and sibling-prefix rejection (`C:\repo-other` is not inside `C:\repo`). Drive-relative paths, UNC/device paths, alternate streams, PowerShell providers, trailing-dot/space aliases, and other Unix absolute paths used through Windows Bash require confirmation rather than guessed resolution or network-share probing.

## Entry points

- Agent tools: `bash`, `powershell`, `job_start` via Pi's `tool_call` hook.
- User `!` / `!!` commands via `user_bash`.
- `/bg` calls the same approval function directly, because slash commands bypass `tool_call`.
- The personal `worker` profile explicitly loads this extension, including for foreground children. Other agent profiles require explicit extension loading or ambient loading in a compatible runtime; merely installing a global guard does not prove every child/CLI is guarded.

`/deletion-guard` reports scope and coverage. Run `/reload` after changes. The status command reports this extension's registration, not a security attestation about other extensions or child processes.

## Recognized subset

| Family | Examples |
|---|---|
| Bash deletion | `rm -rf build`, `rm -- ../outside`, `rmdir empty`, `unlink file` |
| PowerShell deletion | `Remove-Item -LiteralPath '.\build' -Recurse -Force`; aliases `ri`, `rm`, `del`, `erase`, `rd`, `rmdir` |
| Python literal calls | `python -c "import os; os.remove('file')"`, `os.unlink`, `os.rmdir`, `shutil.rmtree` |
| Python pathlib | `Path('file').unlink()`, `Path('empty').rmdir()`, `pathlib.Path(...)`, simple `missing_ok=True/False` |
| Python launchers | `python`, `python3`, versioned `python3.12`, `py -3`, explicit executable paths; separate or attached `-c` payload |
| Nested shells | Literal `bash/sh/zsh -c` and `powershell/pwsh -Command` strings; up to four nesting levels |
| Other review triggers | Recognized deletion wrapped by `sudo`, `command`, `exec`, `env`, `xargs`, or `eval`; inline environment assignments; `find -delete/-exec/-execdir`; `git clean` except dry runs; `git reset --hard` |

PowerShell `-WhatIf`, Bash `rm --help/--version` as the sole argument, and `git clean -n/--dry-run` do not trigger deletion confirmation. Help-looking arguments mixed with deletion targets require review because POSIX option ordering can treat them as filenames. Encoded PowerShell commands and Python heredocs require review because their contents are outside the supported static subset. Python variable/alias calls with known deletion method names, extra arguments such as `dir_fd`, and `os.removedirs` require review instead of pretending to have resolved a literal target. Normal quoted strings/comments containing examples such as `print("shutil.rmtree('outside')")` are not treated as those literal calls.

## Deliberate limitations

- Does not inspect script files (`python cleanup.py`, shell scripts), npm tasks, arbitrary functions, custom aliases, command substitutions, generated code, Node filesystem APIs, other tools, remote shells, or extension-internal filesystem operations. Unsupported syntax can escape recognition; this is not comprehensive malicious-command prevention.
- Unrecognized wrapper programs (for example `uv run` or `poetry run`) and custom PowerShell parameter abbreviations are not a fully supported language surface. Use the documented direct forms when relying on the guard.
- Does not guard overwrite/truncation, move operations, package installation, commits/pushes, permission changes, or every destructive Git operation. Existing behavioral instructions continue to cover those activities.
- Preflight cannot freeze the filesystem. A symlink/junction can change after inspection, another tool can mutate targets concurrently, or a shell override can change execution semantics. No TOCTOU/OS containment guarantee is made. An approved command can do anything in its full text; the prompt is not per-syscall authorization.
- Configured package-internal cache housekeeping continues under its separately approved policy. Those direct filesystem operations do not pass through this hook; their approval is not generalized into an exemption for arbitrary shell deletion of the cache root.
- Two extensions can override commands/operations after preflight. Tools named something other than the covered names need their own integration. Keep the background-jobs and deletion-guard sibling directories together: `/bg` imports `approval.ts` directly.

## Verification

From the `~/.pi` repository:

```bash
# Parser, path-boundary, junction/symlink, and approval tests; integration tests skip explicitly.
node --test agent/disabled-extensions/deletion-guard/test/*.test.mjs

# Also test archived Pi hook registration and current background job behavior.
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/disabled-extensions/deletion-guard/test/*.test.mjs agent/extensions/background-jobs/test/*.test.mjs
```

Tests create isolated fake-worktree/sibling fixtures **inside** `agent/test-state/` in this repository, verify rejected targets retain sentinel files, and remove only their own fixture directories. No real outside-repository deletion is performed. PowerShell/Python examples are parsed as text, never executed. Real Pi hooks are exercised with a simulated confirmation UI; the interactive dialog still needs a manual check after `/reload`. Windows junction behavior is tested locally; POSIX-specific OS behavior has not been exercised on this machine. No dependencies are installed by these commands.
