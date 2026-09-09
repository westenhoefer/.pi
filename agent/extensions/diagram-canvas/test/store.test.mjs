import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagramStore, validateDiagram } from "../store.ts";

import { diagram } from "./fixture.mjs";

test("named updates, source annotations, immutable snapshots, and revision-scoped feedback", () => {
  const store = new DiagramStore();
  const input = diagram(); const first = store.put(input); input.references[0].note = "changed";
  assert.equal(first.render.status, "pending");
  assert.equal(store.snapshot().diagrams[0].references[0].note, "Entry point read by the agent.");
  assert.equal(store.report(first.id, { revision: first.revision, status: "ok", message: "Rendered" }), true);
  const updated = store.put({ ...diagram(), mermaid: "sequenceDiagram\nA->>B: Request" });
  assert.ok(updated.revision > first.revision); assert.equal(store.status().length, 1);
  assert.equal(store.report(first.id, { revision: first.revision, status: "error", message: "Stale" }), false);
  assert.equal(store.status()[0].render.status, "pending");
  store.report(updated.id, { revision: updated.revision, status: "error", message: "Parse error at line 2" });
  assert.match(store.status()[0].render.message, /line 2/);
  const snapshot = store.snapshot(); snapshot.diagrams[0].title = "mutated";
  assert.equal(store.status()[0].title, "Request flow");
});

test("all supported diagram types are accepted without pretending to parse syntax", () => {
  for (const mermaid of ["flowchart TD\nA-->B", "graph LR\nA-->B", "sequenceDiagram\nA->>B: Hi", "stateDiagram-v2\n[*] --> Active", "%% comment\nflowchart LR\nnot valid yet"]) validateDiagram({ ...diagram(), mermaid });
});

test("site config, active content, unknown types, and unsafe references are rejected", () => {
  for (const mermaid of ["---\nconfig: x\n---\nflowchart LR", "%%{init: {}}%%\nflowchart LR", "flowchart LR\nclick A call fn()", "flowchart LR\nA[https://example.com]", "flowchart LR\nA[<script>x</script>]", "pie\nA: 1"]) assert.throws(() => validateDiagram({ ...diagram(), mermaid }), undefined, mermaid);
  for (const path of ["../secret", "C:/secret", "/absolute", "src/../../secret", "\\\\server\\share", "file:thing"]) assert.throws(() => validateDiagram({ ...diagram(), references: [{ ...diagram().references[0], path }] }), undefined, path);
  assert.throws(() => validateDiagram({ ...diagram(), references: [{ ...diagram().references[0], confidence: "verified" }] }));
  assert.throws(() => validateDiagram({ ...diagram(), kind: "fact" }));
});

test("store is bounded and remove only changes in-memory diagram state", () => {
  const store = new DiagramStore();
  for (let i = 0; i < 16; i++) store.put(diagram(`d${i}`));
  assert.throws(() => store.put(diagram("overflow")), /16/);
  store.put(diagram("d0")); store.remove("d0"); store.put(diagram("replacement"));
  assert.equal(store.status().length, 16); assert.throws(() => store.remove("missing"));
  assert.throws(() => validateDiagram({ ...diagram(), mermaid: "flowchart LR\n" + "x".repeat(24_000) }));
  assert.throws(() => validateDiagram({ ...diagram(), references: Array(41).fill(diagram().references[0]) }));
});
