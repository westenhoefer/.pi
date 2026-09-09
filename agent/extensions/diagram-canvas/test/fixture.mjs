import { resolve } from "node:path";
import { DiagramStore } from "../store.ts";
import { startCanvasServer } from "../server.ts";

export const diagram = (id = "request") => ({ id, title: "Request flow", kind: "current", mermaid: "flowchart LR\nA[API] --> B[Store]", explanation: "API passes validated data to storage.", references: [{ element: "A", path: "src/api.ts", symbol: "handle", line: 12, note: "Entry point read by the agent.", confidence: "observed" }] });
export async function canvas(t) {
  const store = new DiagramStore();
  const server = await startCanvasServer(store, { webRoot: resolve("agent/extensions/diagram-canvas/web"), mermaidRoot: resolve("agent/extensions/diagram-canvas/node_modules/mermaid/dist") });
  t.after(() => server.close());
  const url = new URL(server.url);
  const headers = { "X-Canvas-Token": url.hash.slice(1) };
  return { store, server, origin: url.origin, headers };
}
