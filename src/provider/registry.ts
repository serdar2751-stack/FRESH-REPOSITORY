import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, ProviderConfig } from "../config/config.ts";
import { resolveSecret } from "../config/config.ts";
import { authStore } from "../config/store.ts";
import { AnthropicProvider, type AnthropicOptions } from "./anthropic.ts";
import { catalogLookup, catalogLookupAny, guessModel } from "./catalog.ts";
import { OpenAICompatibleProvider, type OpenAIOptions } from "./openai.ts";
import type { ApiFormat, ModelInfo, Provider } from "./types.ts";

export interface Preset {
  name: string;
  format: ApiFormat;
  env: string[];
  baseURL?: string;
  /** Catalog family used for model metadata. */
  catalog?: string;
  defaultModel?: string;
  /** Local servers need no key. */
  keyless?: boolean;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export const PRESETS: Record<string, Preset> = {
  anthropic: { name: "Anthropic", format: "anthropic", env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], catalog: "anthropic", defaultModel: "claude-opus-5" },
  openai: {
    name: "OpenAI",
    format: "openai",
    env: ["OPENAI_API_KEY"],
    catalog: "openai",
    defaultModel: "gpt-5",
    options: { maxTokensField: "max_completion_tokens", promptCacheKey: true },
  },
  openrouter: {
    name: "OpenRouter",
    format: "openai",
    env: ["OPENROUTER_API_KEY"],
    baseURL: "https://openrouter.ai/api/v1",
    headers: { "HTTP-Referer": "https://github.com/serdar2751-stack/FRESH-REPOSITORY", "X-Title": "usta" },
  },
  gemini: {
    name: "Google Gemini",
    format: "openai",
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    catalog: "gemini",
    defaultModel: "gemini-2.5-pro",
  },
  deepseek: { name: "DeepSeek", format: "openai", env: ["DEEPSEEK_API_KEY"], baseURL: "https://api.deepseek.com/v1", catalog: "deepseek", defaultModel: "deepseek-chat" },
  groq: { name: "Groq", format: "openai", env: ["GROQ_API_KEY"], baseURL: "https://api.groq.com/openai/v1" },
  mistral: {
    name: "Mistral",
    format: "openai",
    env: ["MISTRAL_API_KEY"],
    baseURL: "https://api.mistral.ai/v1",
    options: { toolCallIdFormat: "alnum9", includeUsage: false },
  },
  xai: { name: "xAI", format: "openai", env: ["XAI_API_KEY"], baseURL: "https://api.x.ai/v1" },
  together: { name: "Together AI", format: "openai", env: ["TOGETHER_API_KEY"], baseURL: "https://api.together.xyz/v1" },
  fireworks: { name: "Fireworks", format: "openai", env: ["FIREWORKS_API_KEY"], baseURL: "https://api.fireworks.ai/inference/v1" },
  cerebras: { name: "Cerebras", format: "openai", env: ["CEREBRAS_API_KEY"], baseURL: "https://api.cerebras.ai/v1" },
  ollama: { name: "Ollama (local)", format: "openai", env: ["OLLAMA_API_KEY"], baseURL: "http://localhost:11434/v1", keyless: true },
  lmstudio: { name: "LM Studio (local)", format: "openai", env: [], baseURL: "http://localhost:1234/v1", keyless: true },
};

/** Infer the provider from a bare model id. */
export function inferProvider(model: string): string | undefined {
  if (/^claude-/.test(model)) return "anthropic";
  if (/^(gpt-|o\d|chatgpt-|codex-)/.test(model)) return "openai";
  if (/^gemini-/.test(model)) return "gemini";
  if (/^deepseek-/.test(model)) return "deepseek";
  if (/^grok-/.test(model)) return "xai";
  if (/^(mistral|codestral|devstral|magistral)-/.test(model)) return "mistral";
  return undefined;
}

export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const provider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    if (model) return { provider, model };
  }
  const provider = inferProvider(ref);
  if (!provider) throw new Error(`Cannot tell which provider serves "${ref}". Use "provider/model", e.g. "openrouter/${ref}".`);
  return { provider, model: ref };
}

function anthropicProfileExists(): boolean {
  const dir = process.env.ANTHROPIC_CONFIG_DIR ?? path.join(os.homedir(), ".config", "anthropic");
  return existsSync(dir);
}

export class ProviderRegistry {
  private readonly instances = new Map<string, Provider>();
  private readonly modelCache = new Map<string, Promise<ModelInfo>>();
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  providerIds(): string[] {
    const ids = new Set([...Object.keys(PRESETS), ...Object.keys(this.config.providers ?? {})]);
    return [...ids].filter((id) => !this.config.providers?.[id]?.disabled);
  }

  providerConfig(id: string): ProviderConfig {
    return this.config.providers?.[id] ?? {};
  }

  format(id: string): ApiFormat {
    const f = this.providerConfig(id).format ?? PRESETS[id]?.format;
    if (!f) throw new Error(`Unknown provider "${id}". Add it under "providers" in your config with a "format" and "baseURL".`);
    return f;
  }

  name(id: string): string {
    return this.providerConfig(id).name ?? PRESETS[id]?.name ?? id;
  }

  apiKey(id: string): string | undefined {
    const cfg = this.providerConfig(id);
    const fromConfig = resolveSecret(cfg.apiKey);
    if (fromConfig) return fromConfig;
    for (const env of PRESETS[id]?.env ?? []) {
      if (id === "anthropic" && env === "ANTHROPIC_AUTH_TOKEN") continue;
      const v = process.env[env];
      if (v) return v;
    }
    return authStore.get(id);
  }

  hasCredentials(id: string): boolean {
    if (this.config.providers?.[id]?.disabled) return false;
    if (this.apiKey(id)) return true;
    // Local servers count once the user mentions them in config.
    if (PRESETS[id]?.keyless) return Boolean(this.config.providers?.[id]);
    const cfg = this.providerConfig(id);
    if (!PRESETS[id] && cfg.baseURL) return true; // custom endpoint, maybe keyless
    if (id === "anthropic") return Boolean(process.env.ANTHROPIC_AUTH_TOKEN) || anthropicProfileExists();
    return false;
  }

  get(id: string): Provider {
    let p = this.instances.get(id);
    if (p) return p;
    const preset = PRESETS[id];
    const cfg = this.providerConfig(id);
    if (!preset && !cfg.format) {
      throw new Error(`Unknown provider "${id}". Known: ${Object.keys(PRESETS).join(", ")}; or define it under "providers".`);
    }
    const format = this.format(id);
    const options = { ...(preset?.options ?? {}), ...(cfg.options ?? {}) };
    const headers = { ...(preset?.headers ?? {}), ...(cfg.headers ?? {}) };
    const baseURL = cfg.baseURL ?? preset?.baseURL;
    const key = this.apiKey(id);
    if (format === "anthropic") {
      p = new AnthropicProvider({
        ...(options as Partial<AnthropicOptions>),
        id,
        apiKey: key,
        authToken: id === "anthropic" && !key ? process.env.ANTHROPIC_AUTH_TOKEN : undefined,
        baseURL,
        headers,
      });
    } else {
      p = new OpenAICompatibleProvider({
        ...(options as Partial<OpenAIOptions>),
        id,
        apiKey: key ?? (preset?.keyless || cfg.baseURL ? "not-needed" : undefined),
        baseURL,
        headers,
      });
    }
    this.instances.set(id, p);
    return p;
  }

  /** Drop a cached provider instance (after credentials change). */
  reset(id: string): void {
    this.instances.delete(id);
    for (const key of [...this.modelCache.keys()]) if (key.startsWith(id + "/")) this.modelCache.delete(key);
  }

  /** Register a provider instance directly (tests, embedding). */
  register(provider: Provider): void {
    this.instances.set(provider.id, provider);
  }

  /** The configured model, or the best default for the first provider with credentials. */
  defaultModelRef(): string | undefined {
    if (this.config.model) return this.config.model;
    for (const id of ["anthropic", "openai", "gemini", "openrouter", "deepseek"]) {
      const preset = PRESETS[id];
      if (preset?.defaultModel && this.apiKey(id)) return `${id}/${preset.defaultModel}`;
    }
    if (this.hasCredentials("anthropic")) return "anthropic/claude-opus-5";
    return undefined;
  }

  /**
   * Resolve model metadata: built-in catalog, then a live lookup (Anthropic
   * Models API / OpenRouter-style /models), then config overrides.
   */
  resolveModel(ref: string, opts: { live?: boolean } = {}): Promise<ModelInfo> {
    const key = ref;
    let cached = this.modelCache.get(key);
    if (!cached) {
      cached = this.doResolve(ref, opts.live ?? true);
      this.modelCache.set(key, cached);
      cached.catch(() => this.modelCache.delete(key));
    }
    return cached;
  }

  private async doResolve(ref: string, live: boolean): Promise<ModelInfo> {
    const { provider, model } = parseModelRef(ref);
    const format = this.format(provider);
    const family = PRESETS[provider]?.catalog ?? (format === "anthropic" ? "anthropic" : undefined);
    const entry = (family ? catalogLookup(family, model) : undefined) ?? (provider === "openrouter" ? catalogLookupAny(model) : undefined);
    let info: ModelInfo = entry
      ? { ...entry, id: model, provider, source: "catalog" }
      : { ...guessModel(format, model), provider, source: "default" };
    if (live && (!entry || provider === "openrouter")) {
      try {
        const p = this.get(provider);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const found = await p.describeModel?.(model, ctrl.signal).finally(() => clearTimeout(timer));
        if (found) info = { ...info, ...stripUndefined(found), id: model, provider, source: "live" };
      } catch {
        // offline or unsupported: keep catalog/default data
      }
    }
    const override = this.providerConfig(provider).models?.[model];
    if (override) info = { ...info, ...stripUndefined(override), id: model, provider, source: info.source === "default" ? "config" : info.source };
    return info;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
