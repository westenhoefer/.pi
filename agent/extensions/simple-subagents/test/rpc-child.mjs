// Local protocol fixture: no models, network, credentials, or filesystem mutation.
import { StringDecoder } from "node:string_decoder";
const mode = process.argv[2];
const decoder = new StringDecoder("utf8");
let buffer = "";
const send = record => process.stdout.write(JSON.stringify(record) + "\n");
process.stdin.on("data", data => {
  buffer += decoder.write(data);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    if (mode === "tool-crash" || mode === "tool-hang") {
      send({ type: "tool_execution_start", toolCallId: "fixture-tool", toolName: "bash" });
      if (mode === "tool-crash") process.exit(7);
      setInterval(() => {}, 1000); // The test must exercise forced termination of this owned fixture.
    }
    if (mode === "crash") process.exit(7);
    if (mode === "invalid") { process.stdout.write("invalid json\n"); continue; }
    if (mode === "reject") { send({ type: "response", id: request.id, success: false, error: "Rejected intentionally" }); continue; }
    send({ type: "response", id: request.id, success: true, data: { echoed: request.message } });
    if (request.type === "prompt") {
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello\u2028world\u2029😀" }], stopReason: "stop" } });
      send({ type: "agent_settled" });
    }
  }
});
process.stdin.on("end", () => { if (mode !== "tool-hang") process.exit(0); });
