import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, matchesKey, truncateToWidth, type Component, type KeybindingsManager, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import type { SnapshotMessage } from "./snapshot.ts";

/** A bounded, read-only viewport. All native transcript components remain untouched. */
export class SnapshotViewer implements Component {
  private blocks: Component[];
  private lines: string[] = [];
  private starts: number[] = [];
  private width = -1;
  private top = 0;
  private pageSize = 1;
  private initial = true;
  private disposed = false;
  private copying = false;
  private notice = "";

  constructor(
    private messages: readonly SnapshotMessage[],
    private tui: TUI,
    private theme: Theme,
    markdownTheme: MarkdownTheme,
    private keys: KeybindingsManager,
    private done: () => void,
    private copy: (text: string) => Promise<void>,
  ) {
    this.blocks = messages.map(message => message.role === "assistant"
      ? new Markdown(message.text, 0, 0, markdownTheme)
      : new Text(message.text, 0, 0));
  }

  invalidate(): void {
    this.width = -1;
    for (const block of this.blocks) block.invalidate();
  }

  dispose(): void { this.disposed = true; }

  private messageIndex(): number {
    let index = 0;
    while (index + 1 < this.starts.length && this.starts[index + 1] <= this.top) index++;
    return index;
  }

  private maxTop(): number {
    return Math.max(this.starts.at(-1) ?? 0, this.lines.length - this.pageSize);
  }

  private async copyMessage(): Promise<void> {
    if (this.copying) return;
    this.copying = true;
    try {
      await this.copy(this.messages[this.messageIndex()].text);
      this.notice = "Message copied";
    } catch {
      this.notice = "Clipboard copy failed";
    } finally {
      this.copying = false;
      if (!this.disposed) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(); return; }
    if (matchesKey(data, "c")) { void this.copyMessage(); return; }
    this.notice = "";
    if (this.keys.matches(data, "tui.select.up")) this.top--;
    else if (this.keys.matches(data, "tui.select.down")) this.top++;
    else if (this.keys.matches(data, "tui.select.pageUp")) this.top -= this.pageSize;
    else if (this.keys.matches(data, "tui.select.pageDown")) this.top += this.pageSize;
    else if (matchesKey(data, "home")) this.top = 0;
    else if (matchesKey(data, "end")) this.top = this.maxTop();
    else if (matchesKey(data, "left")) this.top = this.starts[Math.max(0, this.messageIndex() - 1)];
    else if (matchesKey(data, "right")) this.top = this.starts[Math.min(this.starts.length - 1, this.messageIndex() + 1)];
    else return;
    this.top = Math.max(0, Math.min(this.top, this.maxTop()));
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    const innerWidth = Math.max(1, width - 2);
    this.pageSize = Math.max(1, height - 4);
    if (this.width !== innerWidth) {
      const index = this.messageIndex();
      const offset = this.top - (this.starts[index] ?? 0);
      this.lines = []; this.starts = [];
      this.blocks.forEach((block, i) => {
        this.starts.push(this.lines.length);
        const role = this.messages[i].role === "user" ? "You" : "Assistant";
        this.lines.push(this.theme.fg("accent", `${role} · ${i + 1}/${this.messages.length}`));
        for (const line of block.render(innerWidth)) this.lines.push(line);
        this.lines.push("");
      });
      this.width = innerWidth;
      const selected = this.initial ? this.starts.length - 1 : index;
      this.top = Math.min(this.starts[selected] + offset, (this.starts[selected + 1] ?? this.lines.length) - 1);
      this.initial = false;
    }
    this.top = Math.max(0, Math.min(this.top, this.maxTop()));
    const page = this.lines.slice(this.top, this.top + this.pageSize);
    while (page.length < this.pageSize) page.push("");
    const footer = this.notice || "↑↓ scroll · PgUp/PgDn · ←→ message · Home/End · c copy · Esc close";
    const row = (text: string) => this.theme.fg("border", "│") + truncateToWidth(text, innerWidth, "", true) + this.theme.fg("border", "│");
    const lines = [
      this.theme.fg("border", "─".repeat(width)),
      row(`Chat snapshot · message ${this.messageIndex() + 1}/${this.messages.length}`),
      ...page.map(row),
      row(this.theme.fg("dim", footer)),
      this.theme.fg("border", "─".repeat(width)),
    ];
    return lines.slice(0, height).map(line => truncateToWidth(line, width, "", true));
  }
}
