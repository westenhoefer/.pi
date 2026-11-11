import { copyToClipboard, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveSelection, THINKING_LEVELS, type ModelSelection } from "./launch.ts";
import type { RunRecord } from "./run-store.ts";
import { LOOP_STATUS_QUERY, type LoopStatusQuery } from "./contract.ts";
import { clean } from "./supervisor.ts";
import { PanelViewer, type PanelSnapshot } from "./panel-viewer.ts";
import { PanelModelPicker } from "./panel-picker.ts";

const PANEL_REF = "simple-panel";
const COMPARISON = "simple-panel-comparison";
const pending = (state: string) => ["queued", "starting", "running", "stopping"].includes(state);
const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });
export interface PanelAccess {
  start(ctx: ExtensionContext, question: string, selections: ModelSelection[], signal?: AbortSignal): Promise<{ swarmId: string; taskCount: number; effectiveParallelism: number }>;
  read(ctx: ExtensionContext, id: string): { record: RunRecord; recoveryWarning?: string };
  stop(ctx: ExtensionContext, id: string): Promise<void>;
}

/** Command and presentation policy; execution remains with the shared swarm supervisor. */
export function registerPanel(pi: ExtensionAPI, access: PanelAccess): void {
  function latest(ctx: ExtensionContext): string {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === PANEL_REF) return (entry.data as { id: string }).id;
    }
    throw new Error("No panel on this session branch. Start one with /panel.");
  }

  function read(ctx: ExtensionContext, id: string) {
    const result = access.read(ctx, id);
    if (!result.record.panel) throw new Error("This run is not a panel.");
    return result;
  }

  function snapshot(ctx: ExtensionContext, id: string): PanelSnapshot {
    const { record, recoveryWarning } = read(ctx, id);
    const entries = ctx.sessionManager.getBranch();
    const comparison = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === COMPARISON && (entry.data as { id: string }).id === id);
    const data = comparison?.type === "custom" ? comparison.data as { text: string; model: string } : undefined;
    return {
      id, question: record.panel!.question, state: record.state, reason: record.reason, recoveryWarning,
      comparison: data?.text, comparisonModel: data?.model,
      members: record.items.map((item, index) => {
        const outcome = record.outcomes[index];
        const selection = outcome.selection ?? item.selection!;
        return { id: item.id, model: `${selection.provider}/${selection.model}`, thinking: selection.thinking,
          state: outcome.state, answer: outcome.answer, answerTruncated: outcome.answerTruncated, error: outcome.error };
      }),
    };
  }

  async function start(ctx: ExtensionContext, question: string, models: { model: string; thinking?: string }[], signal?: AbortSignal) {
    if (ctx.mode !== "tui") throw new Error("Panels require the parent TUI.");
    if (typeof question !== "string" || !question.trim() || question.length > 16000) throw new Error("Panel question must contain 1–16000 characters.");
    if (!Array.isArray(models) || models.length < 2) throw new Error("Choose at least two distinct models.");
    const selections = models.map(model => resolveSelection(ctx.modelRegistry, model.model, model.thinking ?? ctx.thinkingLevel ?? "off"));
    if (new Set(selections.map(model => `${model.provider}/${model.model}`)).size !== selections.length) throw new Error("Choose distinct provider/model IDs.");
    const result = await access.start(ctx, question, selections, signal);
    pi.appendEntry(PANEL_REF, { id: result.swarmId });
    ctx.ui.notify(`Panel ${result.swarmId}: ${result.taskCount} models, parallelism ${result.effectiveParallelism}. /panel view opens results; /panel stop cancels this panel.`, "info");
    return result;
  }

  pi.registerTool({
    name: "panel_start", label: "Start model panel",
    description: "Launch the same self-contained question independently on at least two distinct, exact authenticated provider/model IDs. Read-only scouts; no shell or writes. Reuses the swarm queue, shared concurrency, deadlines and completion wake. Children do not inherit this conversation. Returns the swarm ID for swarm_status/results/stop. Reports retain 16000 characters with explicit truncation. Parent TUI only.",
    promptGuidelines: [
      "Use panel_start only when the user requests multi-model exploration. Include all necessary context in its question; do not share other panelists' answers.",
      "After panel_start, yield for its coalesced completion. Consume every swarm_results page, then use panel_compare to save an attributed synthesis of agreements, disagreements, assumptions and deciding evidence. Preserve failures and truncation; never present majority agreement as proof.",
    ],
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 16000 }), models: Type.Array(Type.Object({
      model: Type.String({ minLength: 1, description: "Exact provider/model ID, not a fuzzy alias." }), thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    }), { minItems: 2 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
      const result = await start(ctx, params.question, params.models, signal);
      return textResult(`Panel ${result.swarmId} registered. Yield for completion, then read every swarm_results page and save the comparison with panel_compare. /panel view ${result.swarmId}`, result);
    },
  });

  pi.registerTool({
    name: "panel_compare", label: "Save panel comparison",
    description: "Save the parent's attributed Markdown comparison for a terminal panel, without modifying panelists' original reports or calling a model. Read all swarm_results pages first. Describe agreements, disagreements, assumptions and deciding evidence; disclose failed/missing/truncated answers. Shows the saved synthesis in chat and the Comparison tab. Cannot launch, retry or resume work. Comparison limit: 16000 characters.",
    parameters: Type.Object({ id: Type.String(), comparison: Type.String({ minLength: 1, maxLength: 16000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
      const { record } = read(ctx, params.id);
      if (record.outcomes.some(outcome => pending(outcome.state))) throw new Error("Panel still has queued, active or unconfirmed attempts. Do not claim a complete comparison.");
      if (typeof params.comparison !== "string" || !params.comparison.trim() || params.comparison.length > 16000) throw new Error("Comparison must contain 1–16000 characters.");
      pi.appendEntry(COMPARISON, { id: params.id, text: clean(params.comparison, Infinity),
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Parent" });
      return textResult(`Comparison saved and displayed in chat. Original reports are unchanged. /panel view ${params.id}`);
    },
  });
  pi.registerEntryRenderer(COMPARISON, (entry, options) => {
    const data = entry.data as { id: string; text: string };
    return new Markdown(`## Panel comparison\n\n${data.text}\n\nOpen original answers: \`/panel view ${data.id}\``, options.outputPad, 0, getMarkdownTheme());
  });

  pi.registerCommand("panel", {
    description: "Independent multi-model exploration: /panel [question]; /panel view [id]; /panel stop [id]",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") { ctx.ui.notify("Panels require the parent TUI.", "warning"); return; }
      try {
        const action = /^(view|stop)(?:\s+(\S+))?\s*$/.exec(args.trim());
        if (!action && /^(view|stop)(?:\s|$)/.test(args.trim())) throw new Error("Usage: /panel view [id] or /panel stop [id].");
        if (action) {
          const id = action[2] ?? latest(ctx);
          if (action[1] === "stop") { read(ctx, id); await access.stop(ctx, id); ctx.ui.notify(`Stop requested for panel ${id}.`, "info"); return; }
          const loop: LoopStatusQuery = { sessionId: ctx.sessionManager.getSessionId(), active: false };
          pi.events.emit(LOOP_STATUS_QUERY, loop);
          if (loop.active) throw new Error("Panel viewing is unavailable while a goal loop is active. Finish the loop or use /loop stop first; no panel work was changed.");
          const initial = snapshot(ctx, id);
          await ctx.ui.custom<void>((tui, theme, keys, done) => new PanelViewer(initial, tui, theme, getMarkdownTheme(), keys, done, copyToClipboard, () => snapshot(ctx, id)), {
            overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
          });
          return;
        }
        const question = args.trim() || await ctx.ui.editor("Panel question (include the context each model needs)", "");
        if (!question?.trim()) return;
        const available = ctx.modelRegistry.getAvailable();
        const scope = new Map((ctx.scopedModels ?? []).map(item => [`${item.model.provider}/${item.model.id}`, item.thinkingLevel]));
        const choices = available.filter(model => !scope.size || scope.has(`${model.provider}/${model.id}`))
          .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
        if (choices.length < 2) throw new Error("At least two authenticated models must be available in the current model scope. Configure them with /login and /scoped-models.");
        const selected = await ctx.ui.custom<string[] | undefined>((tui, theme, keys, done) =>
          new PanelModelPicker(choices, tui, theme, keys, done), {
          blocked: { kind: "question", message: "Choose at least two panel models, then Start" },
        });
        if (!selected) return;
        await start(ctx, question, selected.map(model => ({ model, thinking: scope.get(model) })));
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
