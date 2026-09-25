import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Effort } from "../core/types.ts";
import type { Pricing } from "../provider/types.ts";
import { parseJsonc } from "../util/jsonc.ts";
import { paths } from "./paths.ts";

export type PermissionAction = "allow" | "ask" | "deny";
/** Tool (or group) name -> action, or a map of patterns -> action. */
export type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>;

export interface ModelOverride {
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: Pricing;
  vision?: boolean;
  thinking?: "adaptive" | "budget" | "effort" | "none";
  effortLevels?: Effort[];
  defaultEffort?: Effort;
  editTool?: "edit" | "patch";
  fallbacks?: boolean;
}

export interface ProviderConfig {
  /** API format for custom providers; presets set it automatically. */
  format?: "anthropic" | "openai";
  name?: string;
  baseURL?: string;
  /** Literal key, "env:VAR" or "{env:VAR}". */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Adapter options (fallbacks, caching, webSearch, maxTokensField, ...). */
  options?: Record<string, unknown>;
  models?: Record<string, ModelOverride>;
  disabled?: boolean;
}

export interface AgentConfig {
  description?: string;
  prompt?: string;
  model?: string;
  effort?: Effort;
  mode?: "primary" | "subagent" | "all";
  /** Tool allow-list (array) or per-tool switches. */
  tools?: string[] | Record<string, boolean>;
  permission?: PermissionConfig;
  maxSteps?: number;
  disabled?: boolean;
}

export interface McpServerConfig {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  timeoutMs?: number;
}

export interface LspServerConfig {
  /** Command and arguments, e.g. ["pyright-langserver", "--stdio"]. */
  command?: string[];
  /** File extensions the server handles, e.g. [".py"]. */
  extensions?: string[];
  languageId?: string;
  env?: Record<string, string>;
  /** `initializationOptions` sent with initialize. */
  initialization?: unknown;
  /** Answers to workspace/configuration requests. */
  settings?: Record<string, unknown>;
  disabled?: boolean;
}

/** true: every built-in server; false: none; or per-server switches and custom servers. */
export type LspConfig = boolean | Record<string, boolean | LspServerConfig>;

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookConfig {
  /** Regex matched against the tool name (tool events only). */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface Config {
  model?: string;
  /** Optional cheap model for session titles. */
  smallModel?: string;
  effort?: Effort;
  /** Opt-in thinking for older models that use a token budget. */
  thinking?: boolean;
  maxOutputTokens?: number;
  maxSteps?: number;
  providers?: Record<string, ProviderConfig>;
  permission?: PermissionConfig;
  agents?: Record<string, AgentConfig>;
  defaultAgent?: string;
  mcp?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
  /** Extra instruction files (paths or globs) added to the system prompt. */
  instructions?: string[];
  compaction?: {
    auto?: boolean;
    threshold?: number;
    maxContextTokens?: number;
    model?: string;
    /** Clear old tool outputs once the context grows (default true). */
    prune?: boolean;
  };
  snapshots?: boolean;
  /** Globally enable/disable tools by name. */
  tools?: Record<string, boolean>;
  /** Desktop notification (terminal OSC 9) when a long turn finishes (default true). */
  notify?: boolean;
  /** Language servers that report errors after edits. */
  lsp?: LspConfig;
  /** Web search backend for the websearch tool (default: first API key found, else DuckDuckGo). */
  search?: { provider?: "tavily" | "brave" | "exa" | "duckduckgo"; apiKey?: string };
}

/** Keys an untrusted project config may not set: they run code or redirect credentials. */
export const PRIVILEGED_KEYS = ["providers", "permission", "hooks", "mcp", "lsp"] as const;

export interface ConfigSource {
  path: string;
  scope: "global" | "project";
  config: Config;
}

export interface LoadedConfig {
  config: Config;
  sources: ConfigSource[];
  /** Privileged settings found in project config but not applied (untrusted project). */
  withheld: Array<{ path: string; keys: string[] }>;
}

function readConfigFile(file: string): Config | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  try {
    const value = parseJsonc(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("top level must be an object");
    return value as Config;
  } catch (err) {
    throw new Error(`Invalid config ${file}: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeConfig(base: Config, over: Config): Config {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (key === "instructions" && Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...new Set([...prev, ...value])];
    } else if (key === "hooks" && isPlainObject(prev) && isPlainObject(value)) {
      const merged: Record<string, unknown[]> = { ...(prev as Record<string, unknown[]>) };
      for (const [ev, list] of Object.entries(value)) {
        merged[ev] = [...(merged[ev] ?? []), ...((list as unknown[]) ?? [])];
      }
      out[key] = merged;
    } else if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else out[key] = value;
  }
  return out as Config;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    // Permission pattern maps keep insertion order: later (more specific) rules win.
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

export function globalConfigFiles(): string[] {
  return ["config.json", "config.jsonc"].map((f) => path.join(paths.config, f));
}

/** Project config files from the project root down to cwd (later wins). */
export function projectConfigFiles(root: string, cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  const stop = path.resolve(root);
  for (;;) {
    dirs.unshift(dir);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const files: string[] = [];
  for (const d of dirs) {
    for (const f of ["usta.json", "usta.jsonc", path.join(".usta", "config.json"), path.join(".usta", "config.jsonc")]) {
      files.push(path.join(d, f));
    }
  }
  return files;
}

export function loadConfig(opts: { root: string; cwd: string; trusted: boolean; extra?: Config }): LoadedConfig {
  const sources: ConfigSource[] = [];
  const withheld: LoadedConfig["withheld"] = [];
  let config: Config = {};
  for (const file of globalConfigFiles()) {
    const c = readConfigFile(file);
    if (c) {
      sources.push({ path: file, scope: "global", config: c });
      config = mergeConfig(config, c);
    }
  }
  for (const file of projectConfigFiles(opts.root, opts.cwd)) {
    let c = readConfigFile(file);
    if (!c) continue;
    if (!opts.trusted) {
      const keys = PRIVILEGED_KEYS.filter((k) => c![k] !== undefined);
      if (keys.length) {
        withheld.push({ path: file, keys: [...keys] });
        c = { ...c };
        for (const k of keys) delete c[k];
      }
    }
    sources.push({ path: file, scope: "project", config: c });
    config = mergeConfig(config, c);
  }
  if (process.env.USTA_MODEL) config.model = process.env.USTA_MODEL;
  if (opts.extra) config = mergeConfig(config, opts.extra);
  return { config, sources, withheld };
}

/** Whether any project config file declares privileged settings. */
export function projectNeedsTrust(root: string, cwd: string): string[] {
  const found: string[] = [];
  for (const file of projectConfigFiles(root, cwd)) {
    try {
      const c = readConfigFile(file);
      if (c && PRIVILEGED_KEYS.some((k) => c[k] !== undefined)) found.push(file);
    } catch {
      // reported when the config is loaded
    }
  }
  return found;
}

/** Resolve "env:VAR" / "{env:VAR}" references. */
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(?:env:|\{env:)([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
  if (m) return process.env[m[1]!] || undefined;
  return value;
}
