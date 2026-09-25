import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSimpleSubagents } from "../index.ts";

export default function fixture(pi: ExtensionAPI): void {
  const children: any[] = [];
  registerSimpleSubagents(pi, (launch, event, exit) => {
    const child = { launch, event, exit, closed: false, commands: [] as any[],
      async request(command: any) { child.commands.push(command); return { type: "response", success: true }; },
      async close() { child.closed = true; },
    };
    children.push(child);
    return child;
  });
  pi.events.on("test:children", (query: any) => { query.children = children; });
}
