/**
 * Assembly: a live /api/show document -> a catalog entry.
 *
 * Every entry field comes from the show response — context window from
 * model_info, vision and thinking from capabilities. There is no fallback
 * layer: a model the daemon cannot describe is dropped, not reconstructed.
 * A show response without the "tools" capability is unusable (pi is a
 * tool-calling agent), and so is one without a positive context length.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getContextLength, type ShowResponse } from "./ollama-api.ts";

/**
 * Explicit compatibility block so behavior does not depend on pi's
 * auto-detection from the provider name or baseUrl.
 */
const buildCompatibility = (): ProviderModelConfig["compat"] => ({
  supportsDeveloperRole: false, // Ollama serves the "system" role, not "developer".
  supportsReasoningEffort: true, // reasoning_effort is honored through the local daemon.
  supportsStore: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  supportsStrictMode: false, // Ollama has no tool_choice, so strict mode is unavailable.
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
  zaiToolStream: false,
});

/**
 * Build the catalog entry for one model from its live show document.
 * Returns an empty array when the daemon reports the model cannot serve pi
 * (no tools, no positive context length).
 */
export const assembleModel = (modelId: string, show: ShowResponse): ProviderModelConfig[] => {
  const capabilities = show.capabilities;
  if (!capabilities?.includes("tools")) return [];
  const contextWindow = getContextLength(show.model_info);
  if (contextWindow <= 0) return [];
  // The daemon reports thinking: these models think by default ("off" is
  // hidden) and "max" is the daemon's top level.
  const thinks = capabilities.includes("thinking");
  return [
    {
      id: modelId,
      name: modelId,
      reasoning: thinks,
      ...(thinks ? { thinkingLevelMap: { off: null, max: "max" } } : {}),
      input: (capabilities.includes("vision") ? ["text", "image"] : ["text"]) as (
        | "text"
        | "image"
      )[],
      // cost is a required field; this extension does not track pricing.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      // /api/show exposes no max-output; 32768 is a safe cap under every context window.
      maxTokens: 32768,
      compat: buildCompatibility(),
    },
  ];
};

/** Ids without a usable entry are skipped; the caller reports them as missing. */
export const assembleModels = (
  modelIds: readonly string[],
  shows: ReadonlyMap<string, ShowResponse>,
): ProviderModelConfig[] =>
  modelIds.flatMap((id) => {
    const show = shows.get(id);
    return show ? assembleModel(id, show) : [];
  });
