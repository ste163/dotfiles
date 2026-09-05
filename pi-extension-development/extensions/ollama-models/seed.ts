/**
 * Seed catalog for the ollama-models extension.
 *
 * The local daemon cannot enumerate its models (GET /api/tags and /v1/models
 * return nothing), so the catalog is fixed to the ids below. The seed serves
 * until the first fetch lands and whenever the daemon is unreachable.
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
 * Explicit OpenAI-compat block so behavior does not depend on pi's
 * auto-detection from the provider name or baseUrl. Every flag states the
 * daemon's actual wire behavior.
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
  // "off" is hidden: these models think by default. "max" is the only level
  // verified to produce visible reasoning.
  thinkingLevelMap: { off: null, max: "max" },
  // vision=true only where the daemon reports the vision capability.
  input: (vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
  // cost is a required field; this extension does not track pricing.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Verified context windows from the live daemon.
  contextWindow,
  // /api/show exposes no max-output; 32768 is a safe cap under every context window.
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
