import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { canvas, diagram } from "./fixture.mjs";

const browser = process.env.PI_TEST_BROWSER;
const skip = !browser && "Set PI_TEST_BROWSER to an already-installed Chromium/Edge executable; no browser downloads.";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error("Browser check timed out.");
}

async function browserSession(t) {
  const repo = await realpath(process.cwd()); await access(join(repo, ".git"));
  await mkdir(join(repo, "agent/test-state"), { recursive: true });
  const profile = await mkdtemp(join(repo, "agent/test-state/diagram-browser-"));
  await mkdir(join(profile, "temp"));
  const child = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only", "about:blank"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMP: join(profile, "temp"), TEMP: join(profile, "temp") } });
  let output = "", spawnError, exited = false, socket;
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-32_000); });
  child.stdout.resume(); child.on("error", error => { spawnError = error; }); child.on("close", () => { exited = true; });
  t.after(async () => {
    socket?.close();
    if (!exited) {
      if (process.platform === "win32" && child.pid) await new Promise(resolve => { const kill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); kill.on("error", resolve); kill.on("close", resolve); });
      else child.kill("SIGTERM");
    }
    await until(() => exited, 10_000);
    const target = await realpath(profile), within = relative(repo, target);
    assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
    await rm(target, { recursive: true, maxRetries: 5, retryDelay: 200 });
  });
  const endpoint = await until(() => {
    if (spawnError) throw spawnError;
    if (exited) throw new Error(`Browser exited before CDP startup: ${output}`);
    return output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let id = 0;
  const events = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
    else events.push(message);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const number = ++id;
      const timer = setTimeout(() => { pending.delete(number); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(number, { resolve, reject, timer }); socket.send(JSON.stringify({ id: number, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const downloads = join(profile, "downloads"); await mkdir(downloads);
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await page("Page.enable"); await page("Runtime.enable"); await page("Network.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const response = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  return { page, evaluate, events, repo, downloads };
}

test("real browser renders all three types, reports errors, updates notes, sanitizes SVG, and stays local", { skip, timeout: 90_000 }, async t => {
  const { store, server, origin } = await canvas(t);
  const { page, evaluate, events, repo, downloads } = await browserSession(t);
  store.put(diagram()); await page("Page.navigate", { url: server.url });
  await until(() => store.status()[0].render.status !== "pending");
  assert.equal(store.status()[0].render.status, "ok", JSON.stringify(store.status()));
  assert.equal(await evaluate("document.querySelectorAll('#drawing svg').length"), 1);
  assert.match(await evaluate("document.getElementById('references').textContent"), /src\/api.ts:12/);
  const screenshot = await page("Page.captureScreenshot", { format: "png" });
  await writeFile(join(repo, "agent/test-state/diagram-canvas-smoke.png"), Buffer.from(screenshot.data, "base64"));
  await evaluate(`(() => { const original = window.fetch; window.reportAttempts = 0; window.fetch = (...args) => { if (String(args[0]) === '/api/report' && ++window.reportAttempts === 1) return Promise.reject(new Error('simulated report outage')); return original(...args); }; })()`);
  for (const mermaid of ["sequenceDiagram\nparticipant A as API\nparticipant B as Store\nA->>B: Save record\nB-->>A: Saved", "stateDiagram-v2\n[*] --> Idle\nIdle --> Running: start\nRunning --> Idle: complete"]) {
    store.put({ ...diagram(), mermaid });
    await until(() => store.status()[0].render.status !== "pending");
    assert.equal(store.status()[0].render.status, "ok", JSON.stringify(store.status()));
  }
  assert.ok(await evaluate("window.reportAttempts >= 2"), "feedback retries without rerendering");
  await evaluate(`(async () => { const {default:mermaid} = await import('/vendor/mermaid.esm.min.mjs'); const original = mermaid.render; let held = true; mermaid.render = async (...args) => { if (held) { held = false; await new Promise(resolve => window.releaseCanvasRender = resolve); } return original(...args); }; })()`);
  store.put({ ...diagram(), title: "Old delayed", mermaid: "flowchart LR\nA[OLD] --> B" });
  await until(() => evaluate("typeof window.releaseCanvasRender === 'function'"));
  store.put({ ...diagram(), title: "Newest", mermaid: "flowchart LR\nA[Newest] --> B" });
  await until(() => evaluate("document.querySelector('.diagram-tab').textContent === 'Newest'"));
  await evaluate("window.releaseCanvasRender()");
  await until(() => store.status()[0].render.status === "ok");
  assert.equal(await evaluate("document.getElementById('title').textContent"), "Newest");
  assert.doesNotMatch(await evaluate("document.getElementById('drawing').textContent"), /OLD/);
  store.put({ ...diagram(), mermaid: "flowchart LR\nA[unterminated" });
  await until(() => store.status()[0].render.status === "error");
  assert.match(await evaluate("document.getElementById('render-status').textContent"), /Render error/);
  assert.equal(await evaluate("document.getElementById('export').disabled"), true);
  store.put({ ...diagram(), title: "<img src=x onerror=alert(1)>", explanation: "<script>alert(1)</script>" });
  await until(() => store.status()[0].render.status === "ok");
  assert.equal(await evaluate("document.querySelectorAll('#title img, #explanation script').length"), 0);
  const sanitized = await evaluate(`(async () => { const {sanitizeSvg} = await import('/render.js'); const node = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject/><image href="https://example.com/x"/><use href="https://example.com/x"/><text>safe</text></svg>'); return new XMLSerializer().serializeToString(node); })()`);
  assert.doesNotMatch(sanitized, /script|foreignObject|image|onload|https:/);
  assert.match(sanitized, /safe/);
  const cssAttack = '<svg id="canvas-999" xmlns="http://www.w3.org/2000/svg" xml:base="https://example.com/"><style>#canvas-999 {fill:u\\72l(//example.com/x);background-image:image-set("//example.com/y")}</style><rect style="fill:u\\72l(//example.com/z)"/><use href="#local"/></svg>';
  const hardened = await evaluate(`(async () => { const {sanitizeSvg} = await import('/render.js'); return new XMLSerializer().serializeToString(sanitizeSvg(${JSON.stringify(cssAttack)})); })()`);
  assert.doesNotMatch(hardened, /example\.com|xml:base|background-image/);
  await evaluate("document.getElementById('zoom-in').click(); document.querySelector('.reference').click()");
  assert.equal(await evaluate("document.querySelectorAll('#drawing .highlight').length > 0"), true, JSON.stringify({ ids: await evaluate("[...document.querySelectorAll('#drawing [id]')].map(n => n.getAttribute('id'))"), errors: events.filter(event => event.method === "Runtime.exceptionThrown") }));
  await evaluate("document.getElementById('export').click()");
  await until(async () => (await readdir(downloads)).includes("request.svg"));
  const exported = await readFile(join(downloads, "request.svg"), "utf8");
  assert.match(exported, /<svg/); assert.doesNotMatch(exported, /<script|<foreignObject|onload=/i);
  const requests = events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  assert.ok(requests.some(url => url.includes("/vendor/chunks/")), "Mermaid lazy modules loaded locally");
  assert.ok(requests.every(url => url.startsWith(origin) || url.startsWith(`blob:${origin}`) || url === "about:blank" || url.startsWith("data:")), JSON.stringify(requests));
});
