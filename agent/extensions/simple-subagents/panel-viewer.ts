import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown, Text, matchesKey, replaceControlCharacters, sliceByColumn, stripTerminalSequences,
  truncateToWidth, visibleWidth, type Component, type KeybindingsManager, type MarkdownTheme, type TUI,
} from "@earendil-works/pi-tui";

export interface PanelMemberView {
  id: string;
  model: string;
  thinking: string;
  state: string;
  answer?: string;
  answerTruncated?: boolean;
  error?: string;
}

export interface PanelSnapshot {
  id: string;
  question: string;
  state: string;
  reason?: string;
  recoveryWarning?: string;
  comparison?: string;
  comparisonTruncated?: boolean;
  comparisonModel?: string;
  members: PanelMemberView[];
}

interface Tab {
  id: string;
  label: string;
  raw?: string;
  blocks: { id: string; component: Component }[];
  starts: { id: string; line: number }[];
  lines: string[];
  width: number;
  top: number;
}

// Display terminal controls as neither styling nor commands; copying still uses the untouched source.
function display(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
const inline = (text: string) => replaceControlCharacters(display(text));

/** A read-only snapshot. Only the explicit refresh key invokes the injected reader. */
export class PanelViewer implements Component {
  private snapshot: PanelSnapshot;
  private tabs: Tab[] = [];
  private selected = 0;
  private pageSize = 1;
  private disposed = false;
  private copying = false;
  private notice = "";

  constructor(
    snapshot: PanelSnapshot,
    private tui: TUI,
    private theme: Theme,
    private markdownTheme: MarkdownTheme,
    private keys: KeybindingsManager,
    private done: () => void,
    private copy: (text: string) => Promise<void>,
    private refresh: () => PanelSnapshot,
  ) {
    this.snapshot = this.capture(snapshot);
    this.rebuildTabs();
  }

  private capture(snapshot: PanelSnapshot): PanelSnapshot {
    return { ...snapshot, members: snapshot.members.map(member => ({ ...member })) };
  }

  private rebuildTabs(): void {
    const selectedId = this.tabs[this.selected]?.id ?? "comparison";
    const previous = new Map(this.tabs.map(tab => [tab.id, tab]));
    const snapshot = this.snapshot;
    const make = (id: string, label: string, raw: string | undefined, details: string): Tab => {
      const old = previous.get(id);
      const info = [`Run: ${snapshot.state}`];
      if (snapshot.reason) info.push(`Reason: ${snapshot.reason}`);
      if (snapshot.recoveryWarning) info.push(`Recovery warning: ${snapshot.recoveryWarning}`);
      const missing = id === "comparison"
        ? "Comparison pending / not available in this snapshot. r refreshes saved results only."
        : "No answer available in this snapshot.";
      return {
        id, label, raw, top: old?.top ?? 0, width: -1,
        starts: old?.starts ?? [], lines: old?.lines ?? [],
        blocks: [
          { id: "question", component: new Text(display(`Question: ${snapshot.question}`), 0, 0) },
          { id: "run", component: new Text(display(info.join("\n")), 0, 0) },
          { id: "details", component: new Text(display(details), 0, 0) },
          { id: "result", component: raw ? new Markdown(display(raw), 0, 0, this.markdownTheme) : new Text(missing, 0, 0) },
        ],
      };
    };
    const comparisonDetails = [`Comparison model: ${snapshot.comparisonModel ?? "not recorded"}`];
    if (snapshot.comparisonTruncated) comparisonDetails.push("Comparison truncated: only the retained Markdown is available.");
    for (const member of snapshot.members) {
      comparisonDetails.push(`${member.model} (${member.thinking}): ${member.state}${member.answerTruncated ? " [answer truncated]" : ""}`);
      if (member.error) comparisonDetails.push(`Error: ${member.error}`);
    }
    this.tabs = [make("comparison", "Comparison", snapshot.comparison, comparisonDetails.join("\n"))];
    for (const member of snapshot.members) {
      const details = [`Model: ${member.model} · thinking: ${member.thinking} · state: ${member.state}`];
      if (member.error) details.push(`Error: ${member.error}`);
      if (member.answerTruncated) details.push("Answer truncated: only the retained Markdown is available.");
      this.tabs.push(make(`member:${member.id}`, member.model, member.answer, details.join("\n")));
    }
    this.selected = Math.max(0, this.tabs.findIndex(tab => tab.id === selectedId));
  }

  invalidate(): void {
    for (const tab of this.tabs) {
      tab.width = -1;
      for (const block of tab.blocks) block.component.invalidate();
    }
  }

  dispose(): void { this.disposed = true; }

  private maxTop(tab: Tab): number {
    return Math.max(0, tab.lines.length - this.pageSize);
  }

  private layout(tab: Tab, width: number): void {
    if (tab.width !== width) {
      // Anchor to the same logical section and its reading offset, not preceding metadata's height.
      let index = 0;
      while (index + 1 < tab.starts.length && tab.starts[index + 1].line <= tab.top) index++;
      const anchor = tab.starts[index];
      const offset = tab.top - (anchor?.line ?? 0);
      tab.lines = []; tab.starts = [];
      for (const block of tab.blocks) {
        tab.starts.push({ id: block.id, line: tab.lines.length });
        for (const line of block.component.render(width)) tab.lines.push(line);
        tab.lines.push("");
      }
      if (anchor) {
        const next = tab.starts.findIndex(start => start.id === anchor.id);
        tab.top = Math.min(tab.starts[next].line + offset, (tab.starts[next + 1]?.line ?? tab.lines.length) - 1);
      }
      tab.width = width;
    }
    tab.top = Math.max(0, Math.min(tab.top, this.maxTop(tab)));
  }

  private async copyCurrent(): Promise<void> {
    if (this.copying) return;
    const tab = this.tabs[this.selected];
    if (!tab.raw) {
      this.notice = tab.id === "comparison" ? "No comparison to copy" : "No answer to copy";
      this.tui.requestRender();
      return;
    }
    this.copying = true;
    this.notice = "Copying…";
    this.tui.requestRender();
    try {
      await this.copy(tab.raw);
      if (!this.disposed) this.notice = "Raw Markdown copied";
    } catch {
      if (!this.disposed) this.notice = "Clipboard copy failed";
    } finally {
      this.copying = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done();
      return;
    }
    if (matchesKey(data, "c")) { void this.copyCurrent(); return; }
    if (matchesKey(data, "r")) {
      try {
        const snapshot = this.capture(this.refresh());
        this.snapshot = snapshot;
        this.rebuildTabs();
        this.notice = "Snapshot refreshed (read-only)";
      } catch {
        this.notice = "Snapshot refresh failed; showing previous snapshot";
      }
      this.tui.requestRender();
      return;
    }
    const tab = this.tabs[this.selected];
    if (this.keys.matches(data, "tui.select.up")) tab.top--;
    else if (this.keys.matches(data, "tui.select.down")) tab.top++;
    else if (this.keys.matches(data, "tui.select.pageUp")) tab.top -= this.pageSize;
    else if (this.keys.matches(data, "tui.select.pageDown")) tab.top += this.pageSize;
    else if (matchesKey(data, "home")) tab.top = 0;
    else if (matchesKey(data, "end")) tab.top = this.maxTop(tab);
    else if (matchesKey(data, "left")) this.selected = (this.selected - 1 + this.tabs.length) % this.tabs.length;
    else if (matchesKey(data, "right")) this.selected = (this.selected + 1) % this.tabs.length;
    else return;
    tab.top = Math.max(0, Math.min(tab.top, this.maxTop(tab)));
    this.notice = "";
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    const headerSize = height >= 4 ? 2 : 1;
    const footerSize = height >= 3 ? 1 : 0;
    this.pageSize = Math.max(1, height - headerSize - footerSize);
    const tab = this.tabs[this.selected];
    this.layout(tab, width);
    const labels = this.tabs.map((item, index) => index === this.selected
      ? this.theme.fg("accent", this.theme.bold(`[${inline(item.label)}]`)) : inline(item.label));
    const start = labels.slice(0, this.selected).reduce((sum, label) => sum + visibleWidth(label) + 3, 0);
    const end = start + visibleWidth(labels[this.selected]);
    const tabs = sliceByColumn(labels.join(" · "), end <= width ? 0 : Math.min(start, end - width), width, true);
    const lines: string[] = [];
    if (headerSize === 2) lines.push(this.theme.fg("accent", `Panel ${inline(this.snapshot.id)} · ${inline(this.snapshot.state)} · snapshot (read-only)`));
    lines.push(tabs);
    const page = tab.lines.slice(tab.top, tab.top + this.pageSize);
    while (page.length < this.pageSize) page.push("");
    for (const line of page) lines.push(line);
    if (footerSize) {
      const binding = (id: "up" | "down" | "pageUp" | "pageDown" | "cancel") => this.keys.getKeys(`tui.select.${id}`).join("/") || "unbound";
      const help = `${binding("up")}/${binding("down")} scroll · ${binding("pageUp")}/${binding("pageDown")} · ←→ tabs · Home/End · c copy · r refresh · ${binding("cancel")} close`;
      lines.push(this.theme.fg("dim", this.notice || help));
    }
    return lines.slice(0, height).map(line => truncateToWidth(line, width, "", true));
  }
}
