import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "agy-acp";
export const API = "agy-acp-v1";
export type AgyModel = Model<typeof API>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function cleanLabel(value: unknown, limit = 180): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, limit) : "";
}

export interface Selector {
  id: string;
  current: string;
  choices: { id: string; name: string }[];
}

function choiceList(value: unknown): Selector["choices"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const entry = record(item);
    if (typeof entry?.value === "string") return [{ id: entry.value, name: cleanLabel(entry.name) || entry.value }];
    return Array.isArray(entry?.options) ? entry.options.flatMap(option => {
      const nested = record(option);
      return typeof nested?.value === "string" ? [{ id: nested.value, name: cleanLabel(nested.name) || nested.value }] : [];
    }) : [];
  });
}

export function readSelector(session: unknown, category: "model" | "thought_level"): Selector | undefined {
  const options = record(session)?.configOptions;
  if (!Array.isArray(options)) return;
  for (const raw of options) {
    const item = record(raw);
    if (item && (item.category === category || item.id === category) && typeof item.id === "string" && typeof item.currentValue === "string") {
      return { id: item.id, current: item.currentValue, choices: choiceList(item.options) };
    }
  }
}

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function defaultContextWindow(id: string): number {
  return /^gemini-/u.test(id) ? 1_048_576 : 200_000;
}

function toModel(id: string, name: string, image: boolean, contextWindow = defaultContextWindow(id)): AgyModel {
  return {
    id, name, provider: PROVIDER_ID, api: API, baseUrl: "acp://antigravity",
    input: image ? ["text", "image"] : ["text"],
    // Efforts are model-specific. The live session confirms which values it actually accepts.
    reasoning: /^gemini-/u.test(id),
    thinkingLevelMap: { minimal: null, max: null },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow, maxTokens: 65_536,
  };
}

export const fallbackModels = [toModel("gemini-3.8-flash", "Gemini 3.8 Flash (Antigravity)", true)];

export function discoverModels(session: unknown, image: boolean, windows: ReadonlyMap<string, number>): AgyModel[] {
  const model = readSelector(session, "model");
  if (!model) throw new Error("agy did not advertise an ACP model selector. Check your agy CLI version and launcher.");
  const unique = new Map<string, AgyModel>();
  for (const { id, name } of model.choices.length ? model.choices : [{ id: model.current, name: model.current }]) {
    if (modelIdPattern.test(id)) unique.set(id, toModel(id, `${name} (Antigravity)`, image, windows.get(id)));
  }
  if (!unique.size) throw new Error("agy did not advertise any usable ACP models.");
  return [...unique.values()];
}

export function effortFor(selector: Selector, reasoning: SimpleStreamOptions["reasoning"]): string | undefined {
  if (!reasoning || reasoning === "off") return;
  const ranking = ["low", "medium", "high", "xhigh", "max"];
  const requested = ranking.indexOf(reasoning === "minimal" ? "low" : reasoning);
  if (requested < 0) return;
  const available = new Set(selector.choices.map(choice => choice.id));
  // Don't silently request a higher tier than chosen.
  return ranking.slice(0, requested + 1).reverse().find(value => available.has(value));
}
