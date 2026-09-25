/**
 * Provider SDKs are loaded on first use: together they take ~200ms to
 * import, which every command would otherwise pay at startup (even
 * `usta --version`).
 */
import type AnthropicSdk from "@anthropic-ai/sdk";
import type OpenAISdk from "openai";

let anthropic: typeof AnthropicSdk | undefined;
let openai: typeof OpenAISdk | undefined;

export async function loadAnthropic(): Promise<typeof AnthropicSdk> {
  anthropic ??= (await import("@anthropic-ai/sdk")).default;
  return anthropic;
}

/** The Anthropic SDK if it has been loaded (errors can only come from a loaded SDK). */
export function loadedAnthropic(): typeof AnthropicSdk | undefined {
  return anthropic;
}

export async function loadOpenAI(): Promise<typeof OpenAISdk> {
  openai ??= (await import("openai")).default;
  return openai;
}

export function loadedOpenAI(): typeof OpenAISdk | undefined {
  return openai;
}
