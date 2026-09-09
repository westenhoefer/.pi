const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
const headers = { "X-Canvas-Token": token };
let version = -1, diagrams = [], selected, serverSelection, shownKey;
let rendering = false, stopped = false, renderer, reporting = false;
const pendingReports = new Map();
let scale = 1, x = 0, y = 0, svgWidth = 800, svgHeight = 500;
let pointer;

function current() { return diagrams.find(diagram => diagram.id === selected); }
function transform() { $("drawing").style.transform = `translate(${x}px,${y}px) scale(${scale})`; }
function fit() {
  const box = $("viewport").getBoundingClientRect();
  scale = Math.min((box.width - 40) / svgWidth, (box.height - 40) / svgHeight, 2);
  scale = Math.max(.05, scale); x = (box.width - svgWidth * scale) / 2; y = (box.height - svgHeight * scale) / 2;
  transform();
}
function zoom(factor, cx = $("viewport").clientWidth / 2, cy = $("viewport").clientHeight / 2) {
  const next = Math.min(8, Math.max(.05, scale * factor));
  x = cx - (cx - x) * next / scale; y = cy - (cy - y) * next / scale; scale = next; transform();
}
function key(diagram) { return diagram ? `${diagram.id}:${diagram.revision}` : "empty"; }
function highlight(element, button) {
  for (const node of $("drawing").querySelectorAll(".highlight")) node.classList.remove("highlight");
  for (const node of $("references").children) node.classList.toggle("selected", node === button);
  if (!element) return;
  for (const node of $("drawing").querySelectorAll("[id], [data-id]")) {
    if (node.dataset.id === element || node.id === element || node.id.startsWith(`flowchart-${element}-`) || node.id.includes(`-flowchart-${element}-`) || node.id.startsWith(`state-${element}-`) || node.id.includes(`-state-${element}-`)) node.classList.add("highlight");
  }
}
function showNotes(diagram) {
  $("title").textContent = diagram?.title ?? "An empty canvas";
  $("kind").textContent = diagram?.kind ?? "No diagram";
  $("kind").className = `badge ${diagram?.kind ?? ""}`;
  $("revision").textContent = diagram ? `Revision ${diagram.revision}` : "";
  $("explanation").textContent = diagram?.explanation ?? "Ask Pi to explain a code path, state machine, or interaction.";
  $("source").textContent = diagram?.mermaid ?? "";
  $("references").replaceChildren();
  for (const ref of diagram?.references ?? []) {
    const button = document.createElement("button"); button.className = "reference";
    const label = document.createElement("strong"); label.textContent = ref.element ?? ref.symbol ?? "Source reference";
    const source = document.createElement("code"); source.textContent = `${ref.path}${ref.line ? `:${ref.line}` : ""}${ref.symbol ? ` · ${ref.symbol}` : ""}`;
    const note = document.createElement("span"); note.textContent = ref.note;
    const confidence = document.createElement("small"); confidence.textContent = `${ref.confidence} · agent-reported`;
    button.append(label, source, note, confidence);
    button.addEventListener("click", () => highlight(ref.element, button));
    $("references").append(button);
  }
}
function showTabs() {
  $("diagrams").replaceChildren();
  for (const diagram of diagrams) {
    const button = document.createElement("button"); button.className = "diagram-tab";
    button.textContent = diagram.title; button.setAttribute("aria-current", String(diagram.id === selected));
    button.addEventListener("click", () => { selected = diagram.id; showTabs(); void renderSelected(); });
    $("diagrams").append(button);
  }
}
async function flushReports() {
  if (reporting) return;
  reporting = true;
  try {
    for (const [id, report] of pendingReports) {
      const response = await fetch("/api/report", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(5000) });
      if (!response.ok && response.status !== 409) throw new Error("Render feedback pending; retrying locally.");
      if (pendingReports.get(id) === report) pendingReports.delete(id);
    }
  } finally { reporting = false; }
}
async function renderSelected() {
  if (rendering) return;
  rendering = true;
  try {
    while (shownKey !== key(current())) {
      const diagram = current(), wanted = key(diagram);
      showNotes(diagram);
      $("drawing").replaceChildren(); $("export").disabled = true;
      $("empty").hidden = !!diagram;
      if (!diagram) { shownKey = wanted; $("render-status").textContent = ""; break; }
      $("render-status").className = ""; $("render-status").textContent = "Rendering locally…";
      let svg, error;
      try {
        renderer ??= await import("./render.js");
        svg = await renderer.renderDiagram(diagram.mermaid, `canvas-${diagram.revision}`, $("staging"));
      } catch (failure) { error = String(failure.message ?? failure).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, 2000); }
      // Never mount stale SVG or overwrite the notes for a newer selection/revision.
      if (wanted !== key(current())) continue;
      shownKey = wanted;
      if (error) {
        $("render-status").className = "error"; $("render-status").textContent = `Render error: ${error}`;
      } else {
        $("drawing").append(svg);
        const bounds = svg.viewBox.baseVal;
        svgWidth = bounds.width || 800; svgHeight = bounds.height || 500;
        svg.setAttribute("width", String(svgWidth)); svg.setAttribute("height", String(svgHeight));
        fit(); $("export").disabled = false;
        $("render-status").textContent = "Rendered locally. Source references and interpretation are agent-reported.";
      }
      pendingReports.set(diagram.id, { id: diagram.id, revision: diagram.revision, status: error ? "error" : "ok", message: error ?? "Rendered in browser." });
      try { await flushReports(); }
      catch (failure) { $("connection").textContent = failure.message; }
    }
  } finally { rendering = false; }
}

async function refresh() {
  if (stopped) return;
  try {
    const response = await fetch(`/api/state?since=${version}`, { headers, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) {
      stopped = true; throw new Error("Access denied. Open the full canvas URL from Pi, including its fragment.");
    }
    if (response.status !== 204) {
      if (!response.ok) throw new Error("Canvas server unavailable.");
      const state = await response.json();
      version = state.version; diagrams = state.diagrams;
      if (!current() || state.selected !== serverSelection) selected = state.selected;
      serverSelection = state.selected;
      showTabs(); void renderSelected();
    }
    for (const [id, report] of pendingReports) if (!diagrams.some(diagram => diagram.id === id && diagram.revision === report.revision)) pendingReports.delete(id);
    await flushReports();
    $("connection").textContent = "Local session · connected";
  } catch (error) { $("connection").textContent = error.message === "Failed to fetch" ? "Disconnected · session ended or server stopped" : error.message; }
  if (!stopped) setTimeout(refresh, 1000);
}

$("fit").addEventListener("click", fit);
$("zoom-in").addEventListener("click", () => zoom(1.25));
$("zoom-out").addEventListener("click", () => zoom(.8));
$("viewport").addEventListener("wheel", event => {
  event.preventDefault(); const box = $("viewport").getBoundingClientRect();
  zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - box.left, event.clientY - box.top);
}, { passive: false });
$("viewport").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  pointer = { x: event.clientX, y: event.clientY, startX: x, startY: y };
  $("viewport").setPointerCapture(event.pointerId); $("viewport").classList.add("dragging");
});
$("viewport").addEventListener("pointermove", event => {
  if (pointer) { x = pointer.startX + event.clientX - pointer.x; y = pointer.startY + event.clientY - pointer.y; transform(); }
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) $("viewport").addEventListener(event, () => { pointer = undefined; $("viewport").classList.remove("dragging"); });
$("viewport").addEventListener("keydown", event => {
  if (event.key === "+" || event.key === "=") zoom(1.25);
  else if (event.key === "-") zoom(.8);
  else if (event.key === "0") fit();
  else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    x += event.key === "ArrowLeft" ? 30 : event.key === "ArrowRight" ? -30 : 0;
    y += event.key === "ArrowUp" ? 30 : event.key === "ArrowDown" ? -30 : 0; transform();
  } else return;
  event.preventDefault();
});
$("export").addEventListener("click", () => {
  const svg = $("drawing").querySelector("svg"); if (!svg) return;
  const clone = svg.cloneNode(true);
  for (const node of clone.querySelectorAll(".highlight")) node.classList.remove("highlight");
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  const link = document.createElement("a"); link.href = url; link.download = `${selected ?? "diagram"}.svg`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
addEventListener("pagehide", () => { stopped = true; });
if (!/^[a-f0-9]{64}$/.test(token)) $("connection").textContent = "Open the full canvas URL from Pi to connect.";
else void refresh();
