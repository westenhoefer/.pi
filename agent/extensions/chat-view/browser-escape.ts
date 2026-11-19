let nextOwner = 0;

type BrowserTerminal = {
  env: Record<string, string | undefined>;
  stdout: { isTTY?: boolean; write(data: string): unknown };
  pid: number;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
};

// MCP Browser's private OSC 777 protocol only changes Escape priority in this
// pane. Other terminal hosts receive no messages from this extension.
export function claimBrowserEscape(host: BrowserTerminal = process): () => void {
  if (host.env.MCP_BROWSER_TERMINAL !== "1" || !host.stdout.isTTY) return () => {};
  const owner = `chat-view-${host.pid}-${++nextOwner}`;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    host.removeListener("exit", release);
    host.stdout.write(`\x1b]777;mcp-browser;escape;release=${owner}\x07`);
  };
  host.once("exit", release);
  host.stdout.write(`\x1b]777;mcp-browser;escape;claim=${owner}\x07`);
  return release;
}
