import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotMessages } from "../snapshot.ts";

const entry = (id, role, content) => ({ id, type: "message", message: { role, content } });

test("snapshot contains only user text and assistant prose, preserving order and source whitespace", () => {
  const branch = [
    { type: "custom", data: "private runtime state" },
    entry("u", "user", "  user text\n"),
    entry("a", "assistant", [{ type: "thinking", thinking: "hidden reasoning" }, { type: "text", text: "Visible reply" }, { type: "toolCall", name: "codemode", arguments: { script: "hidden code" } }]),
    entry("t", "toolResult", [{ type: "text", text: "hidden tool output" }]),
    entry("c", "custom", "hidden child report"),
    entry("i", "user", [{ type: "image", data: "hidden image" }, { type: "text", text: "Image question" }]),
    entry("empty", "assistant", [{ type: "thinking", thinking: "reasoning only" }]),
    entry("blank", "assistant", [{ type: "text", text: " \n" }]),
    entry("image-only", "user", [{ type: "image", data: "image" }]),
  ];
  assert.deepEqual(snapshotMessages(branch), [
    { id: "u", role: "user", text: "  user text\n" },
    { id: "a", role: "assistant", text: "Visible reply" },
    { id: "i", role: "user", text: "Image question" },
  ]);
});

test("snapshot retains saved pre-compaction messages and does not change or follow its source", () => {
  const branch = [entry("old", "assistant", [{ type: "text", text: "Old answer" }]), { type: "compaction", summary: "Do not substitute this summary" }, entry("new", "user", "New question")];
  const before = structuredClone(branch);
  const snapshot = snapshotMessages(branch);
  assert.deepEqual(branch, before);
  branch[0].message.content[0].text = "Later edit";
  branch.push(entry("later", "assistant", [{ type: "text", text: "Later answer" }]));
  assert.deepEqual(snapshot.map(message => message.text), ["Old answer", "New question"]);
});
