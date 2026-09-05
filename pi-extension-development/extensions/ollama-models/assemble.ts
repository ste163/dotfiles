/**
 * Assembly: a seed entry plus a live /api/show document -> a catalog entry.
 *
 * Live data (capabilities, model_info) wins; static seed fields (name, thinking
 * map, cost, maxTokens, compat) pass through (plan Decisions #4/#6/#9/#10).
 * A model whose show response lacks the "tools" capability is dropped — pi is
 * a tool-calling agent, and a tools-less entry is not selectable.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getContextLength, type ShowResponse } from "./ollama-api.ts";

/**
 * Enrich one seed entry from its show document. Returns undefined when the
 * model has no "tools" capability, so the caller drops it.
 */
export function assembleModel(
  seed: ProviderModelConfig,
  show: ShowResponse,
): ProviderModelConfig | undefined {
  const capabilities = show.capabilities;
  if (!capabilities?.includes("tools")) return undefined;
  return {
    ...seed,
    reasoning: capabilities.includes("thinking"),
    input: (capabilities.includes("vision") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow: getContextLength(show.model_info) ?? seed.contextWindow,
  };
}

/**
 * Merge live show documents over a fallback catalog. Entries without show
 * data (failed fetch, daemon down) keep their fallback values (Decision #7);
 * entries whose show lacks "tools" are dropped.
 */
export function assembleModels(
  catalog: readonly ProviderModelConfig[],
  shows: ReadonlyMap<string, ShowResponse>,
): ProviderModelConfig[] {
  return catalog.flatMap((entry) => {
    const show = shows.get(entry.id);
    if (show === undefined) return [entry];
    return assembleModel(entry, show) ?? [];
  });
}
