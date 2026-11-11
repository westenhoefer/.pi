import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input, SelectList, fuzzyFilter, getSelectPageIndex, replaceControlCharacters, stripTerminalSequences,
  truncateToWidth, type Component, type Focusable, type KeybindingsManager, type TUI,
} from "@earendil-works/pi-tui";

export interface PanelModelChoice { provider: string; id: string; name: string }
const modelId = (model: PanelModelChoice) => `${model.provider}/${model.id}`;
const inline = (text: string) => replaceControlCharacters(stripTerminalSequences(text));

/** One local decision: filtering/toggling never launches work; only the separate Start button finishes. */
export class PanelModelPicker implements Component, Focusable {
  readonly capturesViewportInput = true;
  private input = new Input({ placeholder: "Type to filter model names or provider/id" });
  private selected = new Set<string>();
  private filtered: PanelModelChoice[];
  private list!: SelectList;
  private index = 0;
  private maxVisible = 10;
  private startFocused = false;
  private closed = false;
  private pasting = false;
  private _focused = false;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value && !this.closed;
    this.input.focused = this._focused && !this.startFocused;
  }

  constructor(
    private models: PanelModelChoice[],
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private done: (models: string[] | undefined) => void,
  ) {
    this.filtered = models;
    this.rebuildList();
  }

  private rebuildList(): void {
    this.list = new SelectList(this.filtered.map(model => ({
      value: modelId(model),
      label: `${this.selected.has(modelId(model)) ? "[x]" : "[ ]"} ${inline(modelId(model))} (${inline(model.name)})`,
    })), this.maxVisible, {
      selectedPrefix: text => this.theme.fg("accent", text),
      selectedText: text => this.theme.fg(this.startFocused ? "muted" : "accent", text),
      description: text => this.theme.fg("muted", text),
      scrollInfo: text => this.theme.fg("dim", text),
      noMatch: () => this.theme.fg("warning", "No matching models"),
    });
    this.list.setSelectedIndex(this.index);
  }

  private filter(): void {
    // Match /model's provider-first search text, including display names and slash/space-separated tokens.
    this.filtered = fuzzyFilter(this.models, this.input.getValue(), model =>
      `${model.provider} ${modelId(model)} ${model.provider} ${model.id} ${model.name}`);
    this.index = 0;
  }

  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
  dispose(): void { this.closed = true; this.focused = false; }

  handleInput(data: string): void {
    if (this.closed) return;
    // Input buffers bracketed paste; its content must never act as picker commands.
    const paste = this.pasting || data.includes("\x1b[200~");
    this.pasting = paste && !data.includes("\x1b[201~");
    if (!paste && this.keys.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done(undefined);
      return;
    }
    if (!paste && this.keys.matches(data, "tui.input.tab")) {
      this.startFocused = !this.startFocused;
      this.focused = this._focused;
    } else if (!paste && this.keys.matches(data, "tui.select.confirm")) {
      if (this.startFocused) {
        if (this.selected.size < 2) return;
        this.dispose();
        this.done([...this.selected]);
        return;
      }
      const id = this.list.getSelectedItem()?.value;
      if (id) {
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
      }
    } else {
      const page = paste ? undefined : getSelectPageIndex(this.keys, data, this.index, this.filtered.length, this.maxVisible);
      // SelectList owns layout/scrolling; its public index setter lets us use the injected bindings.
      if (!paste && this.keys.matches(data, "tui.select.up")) {
        this.index = this.index === 0 ? Math.max(0, this.filtered.length - 1) : this.index - 1;
      } else if (!paste && this.keys.matches(data, "tui.select.down")) {
        this.index = this.index + 1 >= this.filtered.length ? 0 : this.index + 1;
      } else if (page !== undefined) {
        this.index = page;
      } else {
        const previous = this.input.getValue();
        this.input.handleInput(data);
        // Input accepts arbitrary pasted bytes; never render terminal controls from the query.
        if (!this.pasting) this.input.setValue(inline(this.input.getValue()));
        if (this.input.getValue() !== previous) this.filter();
      }
      this.startFocused = false;
      this.focused = this._focused;
    }
    this.rebuildList();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    const binding = (id: "up" | "down" | "confirm" | "cancel") => this.keys.getKeys(`tui.select.${id}`).join("/") || "unbound";
    const tab = this.keys.getKeys("tui.input.tab").join("/") || "unbound";
    const start = `${this.startFocused ? "→ " : "  "}[ Start panel (${this.selected.size} models) ]${this.selected.size < 2 ? " · choose at least two" : ""}`;
    const startLine = this.theme.fg(this.selected.size < 2 ? "dim" : "accent", start);
    const inputLine = this.input.render(width)[0];
    if (height === 1) return [truncateToWidth(this.startFocused ? startLine : inputLine, width, "")];

    // Leave the search and explicit Start control visible on short terminals, shedding secondary chrome first.
    const listRows = Math.max(0, height - 2 - Number(height >= 4) - Number(height >= 5) - Number(height >= 6));
    const maxVisible = Math.max(1, Math.min(10, listRows - 1));
    if (maxVisible !== this.maxVisible) { this.maxVisible = maxVisible; this.rebuildList(); }
    const lines: string[] = [];
    if (height >= 5) lines.push(this.theme.fg("accent", "Panel models · thinking follows scoped/parent level"));
    lines.push(inputLine);
    if (listRows) lines.push(...this.list.render(Math.max(4, width)).slice(0, listRows));
    if (height >= 4) lines.push(this.theme.fg("muted", `${this.selected.size} selected · ${this.filtered.length}/${this.models.length} matching models`));
    lines.push(startLine);
    if (height >= 6) lines.push(this.theme.fg("dim", `${binding("up")}/${binding("down")} move · ${binding("confirm")} toggle / Start · ${tab} Start/filter · ${binding("cancel")} cancel`));
    return lines.map(line => truncateToWidth(line, width, ""));
  }
}
