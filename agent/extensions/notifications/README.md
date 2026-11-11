# Desktop notifications (disabled)

Disabled by the exact extension exclusion in `agent/settings.json`. Source and tests are retained for reversibility; no packages were removed.

Reload existing Pi sessions to unload the command, notification tools and injected agent instructions. Reload also stops session-owned background jobs and subagents. The goal-loop adapter's attention events have no desktop delivery while this extension is disabled.

Switchboard replaces this channel. Communication policy lives in the shared `development-workflow` skill; availability, delivery and reply handling live in the `agent-tools` Switchboard reference. Agents send significant progress/input-needed updates and a completion notice whenever Switchboard is available, with chat as the fallback. Notices never approve additional work or resume a manual loop.

The retained tests can still be run offline without sending desktop notifications:

```bash
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_OFFLINE=1 node --test agent/extensions/notifications/test/*.test.mjs
```
