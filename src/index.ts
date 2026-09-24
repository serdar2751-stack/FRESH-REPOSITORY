/**
 * Programmatic API. Typical use:
 *
 *   import { Runtime } from "usta";
 *   const rt = await Runtime.create({ cwd: process.cwd(), yolo: true });
 *   const session = await rt.newSession();
 *   rt.bus.on((e) => { if (e.type === "message.delta") process.stdout.write(e.text); });
 *   const result = await rt.engine.prompt(session, { text: "Fix the failing test" }, { signal: new AbortController().signal });
 */
export { type AgentInfo, BUILTIN_AGENTS, loadAgents } from "./agent/agents.ts";
export { COMPACTION_PROMPT, Engine, type PromptInput, type TurnOptions, type TurnResult } from "./agent/engine.ts";
export { BASE_PROMPT } from "./agent/prompt.ts";
export type { Config, PermissionConfig, ProviderConfig } from "./config/config.ts";
export { Bus } from "./core/bus.ts";
export type { AgentEvent, TurnEndReason } from "./core/events.ts";
export * from "./core/types.ts";
export { main } from "./main.ts";
export { McpClient, McpManager } from "./mcp/client.ts";
export { PermissionDeniedError, PermissionManager, type Mode, type PermissionReply, type PermissionRequest } from "./permission/permission.ts";
export { AnthropicProvider } from "./provider/anthropic.ts";
export { OpenAICompatibleProvider } from "./provider/openai.ts";
export { PRESETS, ProviderRegistry, parseModelRef } from "./provider/registry.ts";
export { type ChatRequest, type ChatResponse, type ModelInfo, type Provider, ProviderError, type StreamEvent, type ToolSpec } from "./provider/types.ts";
export { Runtime, type RuntimeOptions } from "./runtime.ts";
export { startServer, type ServerHandle, type ServerOptions } from "./server/server.ts";
export { exportMarkdown } from "./session/export.ts";
export { Session, SessionStore } from "./session/session.ts";
export { type Tool, type ToolContext, ToolError, type ToolResult } from "./tool/types.ts";
export { VERSION } from "./version.ts";

import type { TurnResult } from "./agent/engine.ts";
import { Runtime, type RuntimeOptions } from "./runtime.ts";

/** Run a single prompt without a UI and return the outcome. */
export async function ask(
  prompt: string,
  opts: RuntimeOptions & { sessionId?: string; signal?: AbortSignal; onText?: (delta: string) => void } = {},
): Promise<TurnResult & { sessionId: string }> {
  const rt = await Runtime.create({ ...opts, interactive: false });
  try {
    const session = opts.sessionId ? await rt.loadSession(opts.sessionId) : await rt.newSession();
    const off = opts.onText
      ? rt.bus.on((e) => {
          if (e.type === "message.delta" && e.kind === "text" && e.sessionId === session.id) opts.onText!(e.text);
        })
      : undefined;
    const result = await rt.engine.prompt(session, { text: prompt }, { signal: opts.signal ?? new AbortController().signal });
    off?.();
    return { ...result, sessionId: session.id };
  } finally {
    await rt.close();
  }
}
