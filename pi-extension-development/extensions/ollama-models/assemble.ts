/**
 * Assembly: a live /api/show document -> a catalog entry.
 *
 * Every model datum comes from the show response — context window from
 * model_info, vision and thinking from capabilities. There is no fallback
 * layer: a model the daemon cannot describe is dropped, not reconstructed.
 * A show response without the "tools" capability is unusable — pi is a
 * tool-calling agent — and so is one without a positive context length.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getContextLength, type ShowResponse } from "./ollama-api.ts";

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

/**
 * Build one catalog entry from a live show document. Returns undefined when
 * the daemon reports the model cannot serve pi (no tools) or gave no usable
 * context length — the caller drops it.
 */
export function assembleModel(
  modelId: string,
  show: ShowResponse,
): ProviderModelConfig | undefined {
  const capabilities = show.capabilities;
  if (!capabilities?.includes("tools")) return undefined;
  const contextWindow = getContextLength(show.model_info);
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  // The daemon reports thinking, so pi's controls map to "max": these
  // models think by default ("off" is hidden) and "max" is the only level
  // verified to produce visible reasoning.
  const thinks = capabilities.includes("thinking");
  return {
    id: modelId,
    name: modelId,
    reasoning: thinks,
    ...(thinks ? { thinkingLevelMap: { off: null, max: "max" } } : {}),
    input: (capabilities.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    // cost is a required field; this extension does not track pricing.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // /api/show exposes no max-output; 32768 is a safe cap under every context window.
    maxTokens: 32768,
    compat: buildCompat(),
  };
}

/**
 * Build the catalog from live show documents. Ids without a usable entry
 * are skipped; the caller reports them as missing.
 */
export function assembleModels(
  modelIds: readonly string[],
  shows: ReadonlyMap<string, ShowResponse>,
): ProviderModelConfig[] {
  return modelIds.flatMap((id) => {
    const show = shows.get(id);
    if (show === undefined) return [];
    return assembleModel(id, show) ?? [];
  });
}
