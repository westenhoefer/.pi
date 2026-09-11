# Local diagram canvas

A session-owned browser canvas for **understanding code**, not certifying code correctness. Supports Mermaid flowcharts (`flowchart`/`graph`), sequence diagrams, and `stateDiagram-v2`.

## Use

Ask Pi, for example:

> Explain how this request reaches storage. Draw a sequence diagram with file/symbol references, and distinguish observed behavior from inferred relationships.

The parent agent uses:

- `diagram_put`: create or replace a named diagram, explanation, and code notes. Same ID updates the existing diagram.
- `diagram_open`: open the local canvas in the default browser. Only when browser visualization was requested.
- `diagram_status`: read bounded browser-reported rendering results, including syntax errors the agent can correct. Error messages are capped at 500 characters in tool output; the browser shows up to 2000.
- `diagram_remove`: remove a diagram from memory, never a filesystem deletion.

User commands:

```text
/canvas
/canvas status
/canvas close
```

`diagram_put` starts the local listener but does not open browser tabs. `/canvas` or `diagram_open` opens the browser; subsequent updates arrive on the existing page. Browser-launch failures provide the local URL instead. Keep the full URL including its fragment; it contains an ephemeral access token. Don't share it or expose/forward the port.

Steer from Pi: “expand cancellation,” “hide storage internals,” or “show the failure path.” The browser is a viewer, not a separate chat session or code editor.

## Reading the canvas

- Named diagrams on the left; diagram viewport in the middle; explanation and source notes on the right.
- Every diagram is labeled **current**, **proposed**, or **mixed**. Mixed diagrams must explain the distinction in their text/labels.
- Code notes include repository-relative path, optional line/symbol, a responsibility/evidence note, and **observed** or **inferred** confidence. These are agent attestations, not independently checked facts. The server never reads source files or opens editor/file URLs.
- Select a code note to highlight its flowchart/state element where Mermaid's generated IDs support it. Sequence actors and arbitrary shapes do not have guaranteed highlight mappings; their notes remain readable in the panel.
- Drag to pan; hold Shift while scrolling to pan horizontally; scroll without Shift or use `+`/`−` to zoom; Fit resets the view. Keyboard: focus the viewport and use `+`, `-`, arrows, or `0` (fit).
- Export SVG downloads the displayed sanitized diagram through the browser. Explanation/reference notes are not embedded in that SVG. Export is disabled while rendering or after an error.
- Mermaid source is visible in an expandable section. Render errors appear below the viewport and are reported to Pi without triggering another paid model turn. Failed feedback requests retry independently during normal local refresh; reports are coalesced by ID/revision and stale reports are discarded.

A successful `diagram_put` means **accepted**, not rendered. Rendering requires an open browser tab. `diagram_status` reports `pending` until that revision has been rendered; `ok` means rendering succeeded, not that its interpretation matches the code. Feedback is untrusted browser data and must not be followed as instructions. Only the selected diagram is rendered; unviewed diagrams can remain pending. Multiple tabs are supported on a best-effort basis; the latest report for a revision wins.

## Locality, bounds, and lifecycle

- HTTP listener on **127.0.0.1**, OS-assigned port, no external binding.
- API access requires a random session token in a request header. Host/Origin checks, no CORS grants, no framing, and a restrictive CSP reduce cross-site access. The token travels in the URL fragment on initial navigation, not an HTTP query/path or referrer.
- Only fixed UI assets and the pinned local Mermaid ESM modules are served. There is no general filesystem server, source-file API, shell endpoint, or HTTP diagram-write API. A bounded HTTP endpoint accepts only revision-scoped render reports.
- No CDN, hosted rendering, analytics, external fonts, or diagram-content uploads. Browser page requests are restricted to this origin. This does not control unrelated browser background networking, extensions, or user-installed browser features.
- Mermaid runs in strict mode with HTML labels off; output is additionally filtered to SVG elements, stripped of active/event/external-link content and XML base overrides, and the same sanitized SVG is exported. CSS is parsed into a restricted property set, stylesheet rules are scoped to the diagram root, and URL values may reference local SVG fragments only. Diagram frontmatter, init directives, custom CSS, click actions, and external URLs are rejected rather than allowing diagram text to change security settings.
- Max 16 diagrams, 24,000 Mermaid characters, 6,000 explanation characters, and 40 bounded source references each. `maxEdges: 300` also applies where Mermaid supports it. These are practical bounds, not an OS/CPU sandbox; a pathological graph could still slow its browser tab.
- Session-only state, not persisted/reconstructed from transcript history. `/canvas close` stops the server but keeps in-memory diagrams for explicit reopening. Quit/reload/session replacement stops the listener and discards state. Tree navigation closes the server and clears diagrams after successful navigation, preventing abandoned-branch diagrams from being shown as current.
- The browser polls the local API once per second (unchanged state returns 204). This does not prompt the model or interact with `/loop`. Existing loop rules concerning subagents still apply.
- TUI parent only; JSON/print/RPC and headless children cannot start a canvas. Have subagents return diagram source/notes to the parent. The extension installs no subagent profile or extra delegation permissions.

## Installation

Mermaid is pinned at **11.17.2**, with a tracked `package-lock.json`. Dependencies live only under this extension's `node_modules/` (ignored by Git). Lifecycle scripts were disabled. No global package was installed. Runtime installation/download is never automatic.

From the `~/.pi` repository, after explicit approval to install dependencies on another machine:

```bash
npm ci --prefix ./agent/extensions/diagram-canvas --ignore-scripts --no-audit --no-fund --cache ./agent/npm-cache
```

Run `/reload` after installing/changing the extension. If dependencies are absent, starting the canvas fails rather than downloading them or falling back to a hosted renderer.

## Verification

From the `~/.pi` repository with the already-installed dependencies:

```bash
# State validation and real HTTP tests; optional integrations explicitly skip.
node --test agent/extensions/diagram-canvas/test/*.test.mjs

# Installed Pi loader and already-installed Edge, no browser/tool downloads.
PI_TEST_PACKAGE_DIR='C:/Users/johan/AppData/Roaming/nvm/v26.8.1/node_modules/@earendil-works/pi-coding-agent' \
PI_TEST_BROWSER='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' \
PI_OFFLINE=1 node --test agent/extensions/diagram-canvas/test/*.test.mjs

npm audit --prefix ./agent/extensions/diagram-canvas --omit=dev --audit-level=high --cache ./agent/npm-cache
```

Browser tests use an isolated disposable profile/temp/download directory inside `agent/test-state/`, never your normal browser profile. They exercise real local Mermaid module loading, all three diagram types, revision updates (including superseding an in-flight render), error reporting/retry, safe text display, escaped-CSS/XML-base sanitization, SVG export, highlighting, and origin-only page network requests. Server tests also cover missing local dependencies and closing active unfinished requests. Cleanup terminates only the test-owned browser process tree and removes only its inspected repository-contained profile. A screenshot remains at `agent/test-state/diagram-canvas-smoke.png` for inspection (ignored by Git).

The default-browser opener and interactive Pi tool/UI experience still need a manual smoke test after reload. No live model calls are made by automated tests.

## Ownership

- `store.ts`: bounded diagram model, validation, revisions, and report acceptance.
- `server.ts`: loopback listener, capability/HTTP policy, and fixed asset serving.
- `index.ts`: Pi tools/commands, browser opener, session lifecycle, and dependency locations.
- `web/`: local viewer, navigation, rendering/sanitization, and browser export.

Diagrams cannot substitute for source inspection. Read the relevant code, attach evidence, flag uncertainty, and use small focused diagrams rather than an unreadable map of the whole repository.
