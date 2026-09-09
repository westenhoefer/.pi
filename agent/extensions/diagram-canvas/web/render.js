import mermaid from "/vendor/mermaid.esm.min.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const CSS_PROPERTIES = new Set(["fill", "stroke", "color", "background-color", "font", "font-family", "font-size", "font-weight", "font-style", "font-variant", "opacity", "fill-opacity", "stroke-opacity", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "text-anchor", "text-decoration", "dominant-baseline", "alignment-baseline", "white-space", "display", "visibility", "overflow", "paint-order", "marker-start", "marker-mid", "marker-end", "filter", "rx", "ry"]);

function safeValue(value) {
  const withoutFragments = value.replace(/url\(\s*["']?#[\w-]+["']?\s*\)/gi, "");
  return !/[\\\\@]/.test(value) && !/url\s*\(|expression\s*\(/i.test(withoutFragments);
}
function cleanDeclarations(style) {
  const kept = [];
  for (const property of style) {
    const value = style.getPropertyValue(property);
    if (CSS_PROPERTIES.has(property) && safeValue(value)) kept.push(`${property}:${value}${style.getPropertyPriority(property) ? " !important" : ""}`);
  }
  return kept.join(";");
}
function cleanStylesheet(source, rootId) {
  if (!/^[\w-]+$/.test(rootId)) return "";
  const sheet = new CSSStyleSheet(); sheet.replaceSync(source);
  return [...sheet.cssRules].filter(rule => rule instanceof CSSStyleRule && rule.selectorText.split(",").every(selector => selector.trim().startsWith(`#${rootId}`)))
    .map(rule => `${rule.selectorText}{${cleanDeclarations(rule.style)}}`).join("\n");
}

const ELEMENTS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "marker", "style", "title", "desc", "clipPath", "mask", "linearGradient", "radialGradient", "stop", "pattern", "use", "symbol"]);

/** Defense in depth after Mermaid strict-mode sanitization; exports get the same SVG. */
export function sanitizeSvg(source) {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS || parsed.querySelector("parsererror")) throw new Error("Renderer returned invalid SVG.");
  for (const node of [root, ...root.querySelectorAll("*")]) {
    if (node.namespaceURI !== SVG_NS || !ELEMENTS.has(node.localName)) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on") || name === "src" || name === "base" || (name === "href" && !/^#[\w-]+$/.test(attribute.value)) || (name !== "xmlns" && name !== "style" && !safeValue(attribute.value))) node.removeAttributeNode(attribute);
      else if (name === "style") {
        const scratch = document.createElement("span").style; scratch.cssText = attribute.value;
        node.setAttribute("style", cleanDeclarations(scratch));
      }
    }
    if (node.localName === "style") node.textContent = cleanStylesheet(node.textContent, root.id);
  }
  return document.importNode(root, true);
}

export async function renderDiagram(source, id, staging) {
  mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", htmlLabels: false,
    theme: "default", fontFamily: "system-ui, sans-serif",
    maxTextSize: 24_000, maxEdges: 300, suppressErrorRendering: true,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false }, state: { useMaxWidth: false },
    secure: ["securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "suppressErrorRendering"],
  });
  try {
    const result = await mermaid.render(id, source, staging);
    return sanitizeSvg(result.svg);
  } finally { staging.replaceChildren(); }
}
