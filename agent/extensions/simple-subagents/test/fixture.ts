import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSimpleSubagents } from "../index.ts";

export default function fixture(pi: ExtensionAPI): void {
  const children: any[] = [];
  let closeError: string | undefined;
  pi.events.on("test:close-failure", (message: string) => { closeError = message; });
  // Simulate merged project settings attempting to raise the user-authoritative cap.
  pi.getSettings = () => ({ simpleSubagents: { maxConcurrency: 99 } }) as any;
  const configuration: { agentDir?: string } = {};
  pi.events.emit("test:configuration", configuration);
  registerSimpleSubagents(pi, (launch, event, exit) => {
    const child = { launch, event, exit, closed: false, commands: [] as any[],
      async request(command: any) { child.commands.push(command); return { type: "response", success: true }; },
      async close() { if (closeError) throw new Error(closeError); child.closed = true; },
    };
    children.push(child);
    return child;
  }, configuration);
  pi.events.on("test:children", (query: any) => { query.children = children; });
}
