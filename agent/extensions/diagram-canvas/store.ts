export type DiagramKind = "current" | "proposed" | "mixed";
export interface SourceReference {
  element?: string;
  path: string;
  symbol?: string;
  line?: number;
  note: string;
  confidence: "observed" | "inferred";
}
export interface DiagramInput {
  id: string;
  title: string;
  kind: DiagramKind;
  mermaid: string;
  explanation: string;
  references: SourceReference[];
}
export interface RenderReport { revision: number; status: "ok" | "error"; message: string }
export interface Diagram extends DiagramInput {
  revision: number;
  render: { status: "pending" | "ok" | "error"; message: string };
}

function text(value: unknown, name: string, max: number, optional = false): asserts value is string {
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be ${optional ? "0" : "1"}–${max} characters without terminal control codes.`);
  }
}

export function validateDiagram(input: DiagramInput): void {
  if (!input || typeof input !== "object") throw new Error("Diagram object required.");
  text(input.id, "id", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.id)) throw new Error("id uses letters, digits, hyphens and underscores only.");
  text(input.title, "title", 160);
  text(input.explanation, "explanation", 6000);
  text(input.mermaid, "mermaid", 24_000);
  if (!["current", "proposed", "mixed"].includes(input.kind)) throw new Error("kind must be current, proposed, or mixed.");
  // Keep site security policy out of diagram-controlled frontmatter/directives.
  const code = input.mermaid.replace(/^\s*%%[^\n]*$/gm, "").trim();
  if (!/^(?:flowchart\s+(?:TB|TD|BT|RL|LR)\b|graph\s+(?:TB|TD|BT|RL|LR)\b|sequenceDiagram\b|stateDiagram-v2\b)/.test(code)) {
    throw new Error("Use flowchart/graph, sequenceDiagram, or stateDiagram-v2, without frontmatter.");
  }
  if (/%%\s*\{|^\s*---|\bclick\s|\blinkStyle\s|\b(?:https?|javascript|data):|<\/?(?:script|iframe|img|style)\b/i.test(input.mermaid)) {
    throw new Error("Diagram configuration directives, click actions, external URLs and embedded active content are disabled.");
  }
  if (/(?:^|[;\n])\s*(?:classDef|style)\s/i.test(input.mermaid)) throw new Error("Custom diagram CSS is disabled; use the canvas theme.");
  if (!Array.isArray(input.references) || input.references.length > 40) throw new Error("At most 40 source references are allowed.");
  for (const ref of input.references) {
    if (!ref || typeof ref !== "object") throw new Error("Invalid reference.");
    text(ref.path, "reference path", 500);
    if (/^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(ref.path) || ref.path.includes(":")) throw new Error("Reference paths must be repository-relative, without traversal or URI schemes.");
    if (ref.element !== undefined) { text(ref.element, "element", 80); if (!/^[\w-]+$/.test(ref.element)) throw new Error("Element IDs use letters, digits, underscores and hyphens."); }
    if (ref.symbol !== undefined) text(ref.symbol, "symbol", 200);
    if (ref.line !== undefined && (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > 10_000_000)) throw new Error("Reference line must be a positive integer.");
    text(ref.note, "reference note", 1000);
    if (!["observed", "inferred"].includes(ref.confidence)) throw new Error("Reference confidence must be observed or inferred.");
  }
}

/** Bounded, session-only diagram state; no repository reads, disk writes, or clocks. */
export class DiagramStore {
  private diagrams = new Map<string, Diagram>();
  version = 0;
  selected?: string;

  put(input: DiagramInput): Diagram {
    validateDiagram(input);
    if (!this.diagrams.has(input.id) && this.diagrams.size >= 16) throw new Error("Canvas holds at most 16 diagrams; remove an old one first.");
    const diagram: Diagram = { ...structuredClone(input), revision: ++this.version, render: { status: "pending", message: "Awaiting browser rendering; syntax is not yet verified." } };
    this.diagrams.set(input.id, diagram);
    this.selected = input.id;
    return structuredClone(diagram);
  }

  clear(): void {
    this.diagrams.clear();
    this.selected = undefined;
    this.version++;
  }

  remove(id: string): void {
    if (!this.diagrams.delete(id)) throw new Error("Unknown diagram ID.");
    this.version++;
    if (this.selected === id) this.selected = this.diagrams.keys().next().value;
  }

  report(id: string, report: RenderReport): boolean {
    const diagram = this.diagrams.get(id);
    if (!diagram || report.revision !== diagram.revision) return false;
    if (!["ok", "error"].includes(report.status)) throw new Error("Invalid render status.");
    text(report.message, "render message", 2000, true);
    if (diagram.render.status === report.status && diagram.render.message === report.message) return true;
    diagram.render = { status: report.status, message: report.message };
    this.version++;
    return true;
  }

  snapshot(): { version: number; selected?: string; diagrams: Diagram[] } {
    return { version: this.version, selected: this.selected, diagrams: structuredClone([...this.diagrams.values()]) };
  }

  status() {
    return [...this.diagrams.values()].map(({ id, title, kind, revision, render }) => ({ id, title, kind, revision, render: { ...render } }));
  }
}
