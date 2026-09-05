/**
 * Seed catalog for the ollama-models extension.
 *
 * Seed-driven by design: the local daemon cannot enumerate
 * cloud models (GET /api/tags and /v1/models return nothing), so the catalog
 * is fixed to the `:cloud` ids below. The seed doubles as the
 * offline/first-launch fallback for refreshModels.
 *
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** The cloud-routed model ids the local daemon serves. */
export const SEED_MODEL_IDS = [
  "glm-5.3:cloud",
  "deepseek-v4-pro:cloud",
  "gemma4:31b-cloud",
  "qwen3.5:cloud",
] as const;

/**
 * Compat block adopted verbatim from upstream pi-ollama-cloud buildCompat()
 * (plan Decision #10). Every flag is explicit so the wire contract stays
 * visible.
 */
const buildCompat = (): ProviderModelConfig["compat"] => ({
  // Ollama serves the "system" role, not "developer".
  supportsDeveloperRole: false,
  // reasoning_effort is honored through the local daemon ("max" verified live).
  supportsReasoningEffort: true,
  // The "store" field is not supported.
  supportsStore: false,
  // Ollama lists "max_tokens", not "max_completion_tokens".
  maxTokensField: "max_tokens",
  // stream_options.include_usage is supported.
  supportsUsageInStreaming: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  // reasoning_effort format ("max" produces visible reasoning through the daemon).
  thinkingFormat: "openai",
  // Ollama has no tool_choice, so strict mode is unavailable.
  supportsStrictMode: false,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
  zaiToolStream: false,
});

const buildSeed = (id: string, contextWindow: number, vision: boolean): ProviderModelConfig => ({
  id,
  name: id,
  reasoning: true,
  // Decision #6: "off" hidden = reasoning always on; "max" verified live.
  thinkingLevelMap: { off: null, max: "max" },
  // Decision #5: vision from the daemon's capability report (gemma4 + qwen3.5).
  input: (vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
  // Decision #9: zero-cost placeholder (the field is required).
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Verified context windows from the live daemon.
  contextWindow,
  // Decision #4: flat conservative value; /api/show exposes no max-output.
  maxTokens: 32768,
  compat: buildCompat(),
});

/** The full fallback catalog, in seed order. */
export const SEED_MODELS: ProviderModelConfig[] = [
  buildSeed("glm-5.3:cloud", 1048576, false),
  buildSeed("deepseek-v4-pro:cloud", 1048576, false),
  buildSeed("gemma4:31b-cloud", 262144, true),
  buildSeed("qwen3.5:cloud", 262144, true),
];
