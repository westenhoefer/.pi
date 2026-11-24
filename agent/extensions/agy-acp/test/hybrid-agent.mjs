import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const reply = (request, result) => send({ id: request.id, result });
const sid = "fixture-session";
const update = data => send({ method: "session/update", params: { sessionId: sid, update: data } });
const text = value => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const waiting = new Map();
let bridge;
let model = "gemini-fixture";
let level = "low";
let promptCount = 0;
const config = () => ({ configOptions: [
  { id: "model", currentValue: model, options: [{ value: "gemini-fixture", name: "Gemini Fixture" }, { value: "gemini-other", name: "Gemini Other" }] },
  { id: "thought_level", currentValue: level, options: [{ value: "low" }, { value: "high" }] },
] });
async function callBridge(message) {
  const response = await fetch(bridge.url, { method: "POST", headers: { ...Object.fromEntries(bridge.headers.map(x => [x.name, x.value])), "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...message }) });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error("Bridge request did not succeed");
  return body.result;
}
async function handle(request) {
  const { method, params } = request;
  switch (method) {
    case "initialize": {
      if (Object.keys(params.clientCapabilities).length) throw new Error("Pi offered extra client capabilities");
      const mode = process.argv.find(arg => arg.startsWith("--mcp-caps="))?.slice("--mcp-caps=".length);
      const mcpCapabilities = mode === "omit" ? undefined : mode === "false" ? { http: false } : { http: true };
      const agentCapabilities = { promptCapabilities: { image: true }, ...(mcpCapabilities ? { mcpCapabilities } : {}) };
      reply(request, { protocolVersion: 1, agentCapabilities });
      return;
    }
    case "session/new":
      bridge = params.mcpServers[0];
      reply(request, { sessionId: sid, ...config() });
      return;
    case "session/set_config_option":
      if (params.configId === "model") model = params.value;
      if (params.configId === "thought_level") level = params.value;
      reply(request, config());
      return;
    case "session/prompt": {
      promptCount++;
      const last = params.prompt.at(-1).text;
      if (last === "Cancel") { waiting.set("cancel", request); text("waiting"); return; }
      if (last === "Stall") { waiting.set("cancel", request); text("partial "); return; }
      if (last === "Chatter") {
        waiting.set("cancel", request);
        const timer = setInterval(() => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "." } }), 20);
        timer.unref();
        waiting.set("chatterTimer", timer);
        text("chattering ");
        return;
      }
      if (last === "Active stream") {
        for (let step = 1; step <= 4; step++) {
          await new Promise(resolve => setTimeout(resolve, 30));
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `step ${step} ` } });
        }
        text("streamed");
        reply(request, { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 2, cachedReadTokens: 0 } });
        return;
      }
      if (["Permission", "Permission without input", "Permission with long input"].includes(last)) {
        waiting.set("permission", request);
        const rawInput = last === "Permission" ? { operation: "inspect" } : last === "Permission with long input" ? "x".repeat(1_201) : undefined;
        send({ id: "permission", method: "session/request_permission", params: { sessionId: sid, toolCall: { title: "Run fixture tool", rawInput }, options: [
          { optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }, { optionId: "always", kind: "allow_always" },
        ] } });
        return;
      }
      if (last === "Window update") {
        update({ sessionUpdate: "usage_update", used: 1200, size: 524_288 });
        text("window updated");
        reply(request, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0 } });
        return;
      }
      if (last === "Silent bg") {
        update({ sessionUpdate: "tool_call", toolCallId: "bg-silent", title: "Silent bg job", status: "in_progress" });
        text("started silent bg");
        reply(request, { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 2, cachedReadTokens: 0 } });
        setTimeout(() => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "bg-silent", status: "completed" });
        }, 15);
        return;
      }
      if (last === "Bg wakeup" || last === "Bg wakeup race") {
        update({ sessionUpdate: "tool_call", toolCallId: "bg-1", title: "Run tests", status: "in_progress" });
        text("tests running");
        reply(request, { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 2, cachedReadTokens: 0 } });
        setTimeout(() => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" });
          text("34/34 passed");
          update({ sessionUpdate: "usage_update", used: 9000, size: 1_048_576 });
        }, 20);
        return;
      }
      if (last === "Bg wakeup tool") {
        update({ sessionUpdate: "tool_call", toolCallId: "bg-2", title: "Run tests", status: "in_progress" });
        text("tests running");
        reply(request, { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 2, cachedReadTokens: 0 } });
        setTimeout(async () => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "bg-2", status: "completed" });
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking result" } });
          // Emit usage_update immediately before a follow-up native tool call (matches real agy 1.5.12)
          update({ sessionUpdate: "usage_update", used: 9100, size: 1_048_576 });
          await new Promise(resolve => setTimeout(resolve, 10));
          update({ sessionUpdate: "tool_call", toolCallId: "bg-2-followup", title: "Inspect log", status: "in_progress" });
          await new Promise(resolve => setTimeout(resolve, 10));
          update({ sessionUpdate: "tool_call_update", toolCallId: "bg-2-followup", status: "completed" });
          const result = await callBridge({ method: "tools/call", id: "wakeup-call", params: { name: "pi__fixture_tool", arguments: { example: 9 } } });
          text(`Wakeup after Pi tool: ${result.content[0].text}`);
          update({ sessionUpdate: "usage_update", used: 9400, size: 1_048_576 });
        }, 20);
        return;
      }
      if (last === "Both" || last === "Parked") {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Plan" } });
        update({ sessionUpdate: "tool_call", toolCallId: "native", title: "Read file with native harness", status: "in_progress" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "native", status: "completed" });
        const listed = await callBridge({ method: "tools/list", id: "list" });
        if (listed.tools.map(tool => tool.name).join() !== "pi__fixture_tool") throw new Error("Bridge catalog differs from expected allowlist");
        text(last === "Parked" ? `fixture pid ${process.pid}` : "Before Pi tool");
        const result = await callBridge({ method: "tools/call", id: "call", params: { name: "pi__fixture_tool", arguments: { example: 7 } } });
        text(`After Pi tool: ${result.content[0].text}`);
      } else {
        text(`${model} ${level} ${promptCount} ${params.prompt.length} ${last}`);
      }
      reply(request, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 } });
      return;
    }
    case "session/cancel": {
      clearInterval(waiting.get("chatterTimer"));
      const cancelled = waiting.get("cancel");
      if (cancelled) reply(cancelled, { stopReason: "cancelled" });
      return;
    }
    default:
      if (request.id === "permission") {
        const prompt = waiting.get("permission");
        text(request.result.outcome.optionId ?? request.result.outcome.outcome);
        reply(prompt, { stopReason: "end_turn" });
      }
  }
}
input.on("line", line => {
  const request = JSON.parse(line);
  void handle(request).catch(() => send({ id: request.id, error: { code: -32603, message: "Fixture failed." } }));
});
input.on("close", () => process.exit(0));
