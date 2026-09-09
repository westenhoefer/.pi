import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DiagramStore, type RenderReport } from "./store.ts";

export interface CanvasServer { url: string; close(): Promise<void> }
interface Assets { webRoot: string; mermaidRoot: string }
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const WEB_FILES = new Map([["/", "index.html"], ["/app.js", "app.js"], ["/app.css", "app.css"], ["/render.js", "render.js"]]);

async function asset(root: string, relative: string): Promise<Buffer> {
  const file = await realpath(path.join(root, relative));
  const within = path.relative(root, file);
  if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) throw new Error("Asset resolves outside its root.");
  if ((await stat(file)).size > 12 * 1024 * 1024) throw new Error("Asset exceeds size limit.");
  return readFile(file);
}

function respond(res: ServerResponse, code: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin" });
  res.end(body);
}

async function readReport(req: IncomingMessage): Promise<{ id: string } & RenderReport> {
  if (req.headers["content-type"] !== "application/json") throw new Error("Expected application/json.");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 12_000) throw new Error("Render report exceeds size limit.");
    chunks.push(chunk);
  }
  const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!report || typeof report.id !== "string" || !Number.isInteger(report.revision)) throw new Error("Invalid report identity.");
  return report;
}

/** Fixed-asset, loopback-only server. Never serves repository files or runs commands. */
export async function startCanvasServer(store: DiagramStore, assets: Assets): Promise<CanvasServer> {
  const webRoot = await realpath(assets.webRoot);
  const mermaidRoot = await realpath(assets.mermaidRoot);
  await asset(webRoot, "index.html");
  await asset(mermaidRoot, "mermaid.esm.min.mjs");
  const token = randomBytes(32).toString("hex");
  let origin = "";

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) return respond(res, 403, "Host/origin rejected.");
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname.startsWith("/api/")) {
      const provided = req.headers["x-canvas-token"];
      if (typeof provided !== "string" || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return respond(res, 401, "Canvas token required.");
      if (url.pathname === "/api/state" && req.method === "GET") {
        if (url.searchParams.get("since") === String(store.version)) return respond(res, 204, "");
        return respond(res, 200, JSON.stringify(store.snapshot()), "application/json; charset=utf-8");
      }
      if (url.pathname === "/api/report" && req.method === "POST") {
        let report;
        try { report = await readReport(req); }
        catch { return respond(res, 400, "Invalid or oversized render report."); }
        try { return respond(res, store.report(report.id, report) ? 200 : 409, "Report received."); }
        catch { return respond(res, 400, "Invalid render report."); }
      }
      return respond(res, 404, "Unknown API route.");
    }
    if (req.method !== "GET") return respond(res, 405, "GET required.");
    const webFile = WEB_FILES.get(url.pathname);
    if (webFile) {
      const type = webFile.endsWith(".html") ? "text/html" : webFile.endsWith(".css") ? "text/css" : "text/javascript";
      return respond(res, 200, await asset(webRoot, webFile), `${type}; charset=utf-8`);
    }
    const vendor = url.pathname.match(/^\/vendor\/(mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_-]+\.mjs)$/);
    if (vendor) return respond(res, 200, await asset(mermaidRoot, vendor[1]), "text/javascript; charset=utf-8");
    respond(res, 404, "Not found.");
  }

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
    void route(req, res).catch(() => { if (!res.headersSent) respond(res, 500, "Canvas request failed."); else res.destroy(); });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Missing loopback address."); }
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}/#${token}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
