import type { Effort } from "../core/types.ts";
import type { ModelInfo, Pricing } from "./types.ts";

type Entry = Omit<ModelInfo, "provider" | "source">;

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: Effort[] = ["low", "medium", "high", "max"];
const OPENAI_EFFORT: Effort[] = ["low", "medium", "high"];

function price(input: number, output: number, cacheRead = input * 0.1, cacheWrite = input * 1.25): Pricing {
  return { input, output, cacheRead, cacheWrite };
}

function claude(id: string, name: string, opts: Partial<Entry>): Entry {
  return {
    id,
    name,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    thinking: "adaptive",
    effortLevels: ALL,
    editTool: "edit",
    ...opts,
  };
}

/**
 * Anthropic models. Capabilities per the current Claude API docs; unknown
 * ids are resolved live through the Models API when possible.
 */
const ANTHROPIC: Entry[] = [
  claude("claude-fable-5-1", "Claude Fable 5.1", {
    pricing: price(10, 50, 0.25, 12.5),
    thinkingAlwaysOn: true,
    defaultEffort: "high",
    fallbacks: true,
  }),
  claude("claude-mythos-5-1", "Claude Mythos 5.1", {
    pricing: price(10, 50, 0.25, 12.5),
    thinkingAlwaysOn: true,
    defaultEffort: "high",
    fallbacks: true,
  }),
  claude("claude-fable-5", "Claude Fable 5", {
    pricing: price(10, 50, 1, 12.5),
    thinkingAlwaysOn: true,
    defaultEffort: "high",
    fallbacks: true,
  }),
  claude("claude-mythos-5", "Claude Mythos 5", {
    pricing: price(10, 50, 1, 12.5),
    thinkingAlwaysOn: true,
    defaultEffort: "high",
  }),
  claude("claude-opus-5-5", "Claude Opus 5.5", {
    pricing: price(4, 20, 0.2, 5),
    thinkingAlwaysOn: true,
    defaultEffort: "medium",
    fallbacks: true,
  }),
  claude("claude-opus-5", "Claude Opus 5", { pricing: price(5, 25), defaultEffort: "high", fallbacks: true }),
  claude("claude-opus-4-8", "Claude Opus 4.8", { pricing: price(5, 25), defaultEffort: "xhigh" }),
  claude("claude-opus-4-7", "Claude Opus 4.7", { pricing: price(5, 25), defaultEffort: "xhigh" }),
  claude("claude-opus-4-6", "Claude Opus 4.6", { pricing: price(5, 25), effortLevels: NO_XHIGH, defaultEffort: "high", summarizedThinkingByDefault: true }),
  claude("claude-sonnet-5", "Claude Sonnet 5", { pricing: price(2, 10), defaultEffort: "xhigh" }),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", { pricing: price(3, 15), effortLevels: NO_XHIGH, defaultEffort: "high", summarizedThinkingByDefault: true }),
  claude("claude-haiku-4-5", "Claude Haiku 4.5", {
    pricing: price(1, 5),
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    effortLevels: [],
  }),
  claude("claude-opus-4-5", "Claude Opus 4.5", {
    pricing: price(5, 25),
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    effortLevels: ["low", "medium", "high"],
  }),
  claude("claude-sonnet-4-5", "Claude Sonnet 4.5", {
    pricing: price(3, 15),
    contextWindow: 200_000,
    maxOutput: 64_000,
    thinking: "budget",
    effortLevels: [],
  }),
  claude("claude-opus-4-1", "Claude Opus 4.1", {
    pricing: price(15, 75),
    contextWindow: 200_000,
    maxOutput: 32_000,
    thinking: "budget",
    effortLevels: [],
  }),
];

function oa(id: string, opts: Partial<Entry> & { contextWindow: number; maxOutput: number }): Entry {
  return {
    id,
    vision: true,
    thinking: "none",
    effortLevels: [],
    editTool: "edit",
    ...opts,
  };
}

const OPENAI: Entry[] = [
  oa("gpt-5", { name: "GPT-5", contextWindow: 400_000, maxOutput: 128_000, pricing: price(1.25, 10, 0.125, 1.25), thinking: "effort", effortLevels: OPENAI_EFFORT, defaultEffort: "medium", editTool: "patch" }),
  oa("gpt-5-mini", { name: "GPT-5 mini", contextWindow: 400_000, maxOutput: 128_000, pricing: price(0.25, 2, 0.025, 0.25), thinking: "effort", effortLevels: OPENAI_EFFORT, defaultEffort: "medium", editTool: "patch" }),
  oa("gpt-5-nano", { name: "GPT-5 nano", contextWindow: 400_000, maxOutput: 128_000, pricing: price(0.05, 0.4, 0.005, 0.05), thinking: "effort", effortLevels: OPENAI_EFFORT, defaultEffort: "medium", editTool: "patch" }),
  oa("gpt-4.1", { name: "GPT-4.1", contextWindow: 1_047_576, maxOutput: 32_768, pricing: price(2, 8, 0.5, 2) }),
  oa("gpt-4.1-mini", { name: "GPT-4.1 mini", contextWindow: 1_047_576, maxOutput: 32_768, pricing: price(0.4, 1.6, 0.1, 0.4) }),
  oa("o3", { name: "o3", contextWindow: 200_000, maxOutput: 100_000, pricing: price(2, 8, 0.5, 2), thinking: "effort", effortLevels: OPENAI_EFFORT, defaultEffort: "medium", editTool: "patch" }),
  oa("o4-mini", { name: "o4-mini", contextWindow: 200_000, maxOutput: 100_000, pricing: price(1.1, 4.4, 0.275, 1.1), thinking: "effort", effortLevels: OPENAI_EFFORT, defaultEffort: "medium", editTool: "patch" }),
  oa("gpt-4o", { name: "GPT-4o", contextWindow: 128_000, maxOutput: 16_384, pricing: price(2.5, 10, 1.25, 2.5) }),
];

const GEMINI: Entry[] = [
  oa("gemini-2.5-pro", { name: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxOutput: 65_536, thinking: "effort", effortLevels: OPENAI_EFFORT }),
  oa("gemini-2.5-flash", { name: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxOutput: 65_536, thinking: "effort", effortLevels: OPENAI_EFFORT }),
];

const DEEPSEEK: Entry[] = [
  oa("deepseek-chat", { name: "DeepSeek Chat", contextWindow: 128_000, maxOutput: 8_192, vision: false }),
  oa("deepseek-reasoner", { name: "DeepSeek Reasoner", contextWindow: 128_000, maxOutput: 64_000, vision: false }),
];

const CATALOG: Record<string, Entry[]> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  gemini: GEMINI,
  deepseek: DEEPSEEK,
};

/** Look up a model in the built-in catalog of `family` (usually the preset id). */
export function catalogLookup(family: string, id: string): Entry | undefined {
  const list = CATALOG[family];
  if (!list) return undefined;
  const exact = list.find((e) => e.id === id);
  if (exact) return exact;
  // Dated snapshots and vendor prefixes: "claude-haiku-4-5-20251001", "anthropic.claude-opus-5".
  const bare = id.replace(/^[a-z]+\./, "").replace(/-\d{8}$/, "").replace(/@\d{8}$/, "");
  return list.find((e) => e.id === bare);
}

/** Search every catalog family (used for OpenRouter-style "vendor/model" ids). */
export function catalogLookupAny(id: string): Entry | undefined {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  for (const family of Object.keys(CATALOG)) {
    const e = catalogLookup(family, bare) ?? catalogLookup(family, bare.replace(/\./g, "-"));
    if (e) return e;
  }
  return undefined;
}

export function catalogModels(family: string): Entry[] {
  return CATALOG[family] ?? [];
}

/** Heuristic defaults for a model the catalog does not know. */
export function guessModel(format: "anthropic" | "openai", id: string): Entry {
  if (format === "anthropic") {
    // New Claude models default to the modern surface (adaptive thinking + effort).
    return claude(id, id, { effortLevels: ALL, defaultEffort: "high" });
  }
  const reasoning = /(^|\/)(o\d|gpt-5)/.test(id);
  return oa(id, {
    contextWindow: 128_000,
    maxOutput: 16_384,
    thinking: reasoning ? "effort" : "none",
    effortLevels: reasoning ? OPENAI_EFFORT : [],
    editTool: /(^|\/)gpt-5|(^|\/)o\d/.test(id) ? "patch" : "edit",
  });
}

export function computeCost(pricing: Pricing | undefined, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | undefined {
  if (!pricing) return undefined;
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * (pricing.cacheRead ?? pricing.input) +
      usage.cacheWrite * (pricing.cacheWrite ?? pricing.input)) /
    1_000_000
  );
}
