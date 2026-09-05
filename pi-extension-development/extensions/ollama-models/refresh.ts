/**
 * refreshModels callback for the "ollama" provider.
 *
 * Contract (pi-ai Models.refresh): pi calls it twice per refresh — a restore
 * phase (allowNetwork:false) before credential resolution, then a network
 * phase (allowNetwork:true) only when a credential resolves. The composer
 * swaps the RETURNED list into the catalog, so never return [].
 *
 * Divergence from upstream (plan Decision #7): per-model fallback, never
 * throw. A failed /api/show keeps that model's stored/seed entry; a fully
 * down daemon still returns the fallback catalog and advances checkedAt, so
 * the cooldown applies and daemon-down stays a normal state, not an error.
 */

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { assembleModels } from "./assemble.ts";
import {
  DEFAULT_DAEMON_BASE_URL,
  FETCH_TIMEOUT_MS,
  fetchShow,
  type OllamaModelsDeps,
  type ShowResponse,
} from "./ollama-api.ts";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

/** Freshness window for the stored catalog; mirrors upstream and pi's remote-catalog-provider. */
const REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/** Build the provider refreshModels callback over injected deps. */
export function createRefreshModels(
  deps: OllamaModelsDeps,
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  return async (context) => {
    // Baseline: the persisted snapshot when non-empty, else the seed catalog.
    // The length guard stops a stored empty catalog from propagating [].
    const fallback = context.stored?.models.length ? [...context.stored.models] : SEED_MODELS;

    // Restore phase, or an already-aborted refresh: no network.
    if (!context.allowNetwork || context.signal.aborted) return fallback;

    // Cooldown: skip the fetch when the stored catalog is fresh and the
    // refresh is not forced (`pi update --models` sets force).
    if (
      !context.force &&
      context.stored?.checkedAt !== undefined &&
      deps.now() - context.stored.checkedAt < REFRESH_COOLDOWN_MS
    ) {
      return fallback;
    }

    // Network phase. The four fetches are independent, so they run
    // concurrently; each failure resolves to { ok: false }, never a throw.
    const results = await Promise.all(
      SEED_MODEL_IDS.map(async (id) => {
        const result = await fetchShow(
          id,
          DEFAULT_DAEMON_BASE_URL,
          deps,
          context.signal,
          FETCH_TIMEOUT_MS,
        );
        return { id, data: result.ok ? result.data : undefined } as const;
      }),
    );
    // A mid-flight abort must not publish or swap a partial catalog.
    if (context.signal.aborted) return fallback;

    const shows = new Map<string, ShowResponse>();
    for (const { id, data } of results) {
      if (data !== undefined) shows.set(id, data);
    }
    const models = assembleModels(fallback, shows);
    // Never []: a pathological all-dropped merge keeps the fallback catalog.
    if (models.length === 0) return fallback;

    // The models store is typed to pi-ai's internal Model shape, so add the
    // provider identity fields (same trick as upstream pi-ollama-cloud). The
    // composer overrides these on the in-memory swap regardless. Object.assign
    // (not a spread) keeps the map call free of copy-per-item spreads; the cast
    // bridges the one structural gap: ProviderModelConfig declares optionals
    // via indexed access (`Model<Api>["thinkingLevelMap"]`), which widens with
    // `| undefined`, and exactOptionalPropertyTypes rejects that widening
    // against Model even though every catalog entry carries the field.
    const persisted = models.map(
      (model) =>
        Object.assign({}, model, {
          provider: "ollama",
          api: "openai-completions",
          baseUrl: `${DEFAULT_DAEMON_BASE_URL}/v1`,
        }) as Model<Api>,
    );

    // Best-effort persistence: the in-memory swap happens from the return
    // value, so a failed store write must not block the fresh catalog.
    try {
      const published = await context.publish({
        persist: { models: persisted, checkedAt: deps.now() },
      });
      if (!published) {
        console.warn("[ollama-models] catalog persist rejected (refresh superseded).");
      }
    } catch {
      console.warn("[ollama-models] catalog persist failed.");
    }
    return persisted;
  };
}
