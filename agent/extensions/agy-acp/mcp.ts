import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type BridgeTool = { name: string; description?: string; parameters: unknown };
export type BridgeResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

type Bridge = {
  mcpServer: { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };
  close(): Promise<void>;
};
type RequestId = string | number;

const HOST = "127.0.0.1";
const PATH = "/mcp";
const NAME = "pi_tools";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY_BYTES = 1024 * 1024;
const CALL_TIMEOUT_MS = 5 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function toolError(text: string): BridgeResult {
  return { content: [{ type: "text", text }], isError: true };
}

function endHttp(response: ServerResponse, status: number) {
  response.writeHead(status, { Connection: "close" }).end();
}

function accepts(header: string, type: string): boolean {
  return header.split(",").some(entry => {
    const [media, ...params] = entry.toLowerCase().split(";").map(part => part.trim());
    return media === type && !params.some(param => /^q\s*=\s*0(?:\.0*)?$/.test(param));
  });
}

function startSse(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders();
}

function reply(response: ServerResponse, id: RequestId | null, data: object, sse = false, status = 200) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, ...data });
  if (sse) {
    if (!response.headersSent) startSse(response);
    response.end(`event: message\ndata: ${body}\n\n`);
  } else {
    response.writeHead(status, { "Content-Type": "application/json" }).end(body);
  }
}

export async function startBridge(
  tools: readonly BridgeTool[],
  onCall: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<BridgeResult>,
): Promise<Bridge> {
  const catalog = new Map<string, { original: string; entry: { name: string; description?: string; inputSchema: unknown } }>();
  for (const tool of tools) {
    const name = `pi__${tool.name}`;
    if (!tool.name || name.length > 128 || /[^a-zA-Z0-9_.-]/.test(tool.name) || catalog.has(name)) continue;
    const schema = record(tool.parameters);
    catalog.set(name, {
      original: tool.name,
      entry: { name, description: tool.description, inputSchema: schema?.type === "object" ? schema : { type: "object", properties: {} } },
    });
  }
  const list = [...catalog.values()].map(tool => tool.entry);
  const authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  const expectedAuthorization = Buffer.from(authorization);
  const calls = new Map<RequestId, AbortController>();
  let authority = "";
  let origin = "";
  let closing: Promise<void> | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const { headers } = request;
    response.setHeader("Cache-Control", "no-store");
    if (headers.host !== authority || (headers.origin !== undefined && headers.origin !== origin)) return endHttp(response, 403);
    if (request.url !== PATH) return endHttp(response, 404);
    const credential = Buffer.from(headers.authorization ?? "");
    if (credential.length !== expectedAuthorization.length || !timingSafeEqual(credential, expectedAuthorization)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return endHttp(response, 401);
    }
    // The per-ACP-session URL and token need no separate MCP session ID or GET stream.
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return endHttp(response, 405);
    }
    const version = headers["mcp-protocol-version"];
    if (version !== undefined && (typeof version !== "string" || !PROTOCOLS.includes(version))) return endHttp(response, 400);
    if (headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return endHttp(response, 415);
    const accept = headers.accept;
    const sse = accept !== undefined && accepts(accept, "text/event-stream");
    const json = !accept || accepts(accept, "application/json") || accepts(accept, "application/*") || accepts(accept, "*/*");
    if (!sse && !json) return endHttp(response, 406);
    if (Number(headers["content-length"]) > MAX_BODY_BYTES) return endHttp(response, 413);

    const chunks: Buffer[] = [];
    let bytes = 0;
    // Keep the socket intact long enough to send 413 when a chunked upload exceeds the limit.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return endHttp(response, 413);
      chunks.push(chunk);
    }
    let message: Record<string, unknown> | undefined;
    try {
      message = record(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
    } catch {
      return reply(response, null, { error: { code: -32700, message: "Parse error" } }, false, 400);
    }
    const id = message?.id;
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string" || (id !== undefined && !isId(id))) {
      return reply(response, null, { error: { code: -32600, message: "Invalid Request" } }, false, 400);
    }
    const params = record(message.params);
    if (id === undefined) {
      // Includes notifications/initialized; notifications never dispatch tools or receive RPC responses.
      if (message.method === "notifications/cancelled" && isId(params?.requestId)) calls.get(params.requestId)?.abort();
      response.writeHead(202).end();
      return;
    }
    const useSse = sse && (!json || message.method === "tools/call");
    const result = (data: object) => reply(response, id, { result: data }, useSse);
    const error = (code: number, text: string) => reply(response, id, { error: { code, message: text } }, useSse);
    switch (message.method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        if (typeof requested !== "string") return error(-32602, "Missing protocol version");
        return result({ protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: NAME, version: "1.0.0" } });
      }
      case "ping": return result({});
      case "tools/list": return result({ tools: list });
      case "tools/call": {
        const tool = typeof params?.name === "string" ? catalog.get(params.name) : undefined;
        if (!tool) return error(-32602, "Unknown tool");
        const args = params?.arguments === undefined ? {} : record(params.arguments);
        if (!args) return error(-32602, "Tool arguments must be an object");
        if (calls.has(id)) return error(-32600, "Request ID is already in use");
        if (closing || response.destroyed) return;
        const call = new AbortController();
        calls.set(id, call);
        const disconnect = () => call.abort();
        response.once("close", disconnect);
        let cancel!: () => void;
        const cancelled = new Promise<BridgeResult>(resolve => {
          cancel = () => resolve(toolError("Tool call cancelled"));
          call.signal.addEventListener("abort", cancel, { once: true });
        });
        const timer = setTimeout(() => call.abort(), CALL_TIMEOUT_MS);
        timer.unref();
        try {
          if (useSse) startSse(response);
          // Stop retaining the HTTP request after cancellation even if the callback ignores its signal.
          let value: BridgeResult;
          try {
            value = await Promise.race([onCall(tool.original, args, call.signal), cancelled]);
          } catch {
            value = toolError("Tool execution failed");
          }
          if (!response.destroyed) result(value);
        } finally {
          clearTimeout(timer);
          response.off("close", disconnect);
          call.signal.removeEventListener("abort", cancel);
          calls.delete(id);
        }
        return;
      }
      default: return error(-32601, "Method not found");
    }
  }

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 1_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else endHttp(response, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP bridge did not bind a TCP port");
  authority = `${HOST}:${address.port}`;
  origin = `http://${authority}`;
  return {
    mcpServer: { type: "http", name: NAME, url: `${origin}${PATH}`, headers: [{ name: "Authorization", value: authorization }] },
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        for (const call of calls.values()) call.abort();
        server.closeAllConnections();
      }
      return closing;
    },
  };
}
