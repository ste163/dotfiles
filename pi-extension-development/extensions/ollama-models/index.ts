/**
 * ollama-models extension.
 *
 * Owns the "ollama" provider under its existing id, so settings.json and the
 * /model UX stay unchanged. Registers a seed catalog of the cloud-routed
 * models served by the local daemon, then fetches live metadata (context
 * window, capabilities) from POST /api/show once per pi process start and
 * swaps it in. No ollama.com, no API key, no new credentials — the daemon
 * attaches the cloud sign-in when it proxies.
 *
 * A session_start handler owns the fetch instead of pi's refreshModels
 * callback: that callback cannot tell a startup refresh from a /model-open
 * refresh and has no access to the UI, while the handler fires exactly where
 * we want (reasons "startup" and "reload" — models live for the process
 * lifetime, so /new, /resume, /fork reuse the already-fetched catalog) and
 * can tell the user what happened.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { assembleModels } from "./assemble.ts";
import {
  DEFAULT_DAEMON_BASE_URL,
  FETCH_TIMEOUT_MS,
  fetchShow,
  type OllamaModelsDeps,
  type ShowResponse,
} from "./ollama-api.ts";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

// Host dependencies, injectable so tests pass fakes. A builtin reference,
// not an arrow wrapper, so no extra function body exists that tests would
// have to call.
const defaultDeps: OllamaModelsDeps = {
  fetch: globalThis.fetch,
};

/** The locked provider config; the refresh swap re-registers the same shape. */
const buildProviderConfig = (models: ProviderModelConfig[]): ProviderConfig => ({
  // The display name matches the provider id.
  name: "ollama",
  baseUrl: `${DEFAULT_DAEMON_BASE_URL}/v1`,
  // Literal dummy key: it satisfies pi's credential gates; the
  // daemon does the real auth when it proxies.
  apiKey: "ollama",
  api: "openai-completions",
  models,
});

/** The ctx slice refreshCatalog needs; keeps the spec fakes minimal. */
type NotifyContext = Pick<ExtensionContext, "hasUI"> & {
  ui: Pick<ExtensionContext["ui"], "notify">;
};

/** Register the provider and subscribe the startup refresh. Testable entry. */
export const createOllamaModelsExtension = (
  pi: ExtensionAPI,
  deps: OllamaModelsDeps = defaultDeps,
): void => {
  pi.registerProvider("ollama", buildProviderConfig(SEED_MODELS));
  pi.on("session_start", (event, ctx) => {
    // Only process starts (and /reload) fetch; sessions created inside the
    // same process reuse the already-fetched catalog.
    if (event.reason !== "startup" && event.reason !== "reload") return;
    // Fire-and-forget: pi awaits session_start handlers sequentially, so
    // return immediately — the fetch must never block session start.
    void refreshCatalog(pi, ctx, deps);
  });
};

/**
 * Fetch live metadata for all four models and swap the catalog in. Never
 * throws: it runs as async-void from the handler, so a rejection would be
 * unhandled.
 */
export const refreshCatalog = async (
  pi: ExtensionAPI,
  ctx: NotifyContext,
  deps: OllamaModelsDeps,
): Promise<void> => {
  try {
    const results = await Promise.all(
      SEED_MODEL_IDS.map(async (id) => {
        const result = await fetchShow(id, DEFAULT_DAEMON_BASE_URL, deps, FETCH_TIMEOUT_MS);
        return [id, result.ok ? result.data : undefined] as const;
      }),
    );
    const shows = new Map<string, ShowResponse>();
    let failed = 0;
    for (const [id, data] of results) {
      if (data === undefined) failed++;
      else shows.set(id, data);
    }
    const models = assembleModels(SEED_MODELS, shows);
    // Apply the swap only when something new came back: a total failure
    // keeps the registered seed catalog, and the re-register would be a
    // no-op anyway.
    if (failed < SEED_MODEL_IDS.length && models.length > 0) {
      // pi validates the incoming config before merging it with the previous
      // registration, so the full locked config is passed — not just the models.
      pi.registerProvider("ollama", buildProviderConfig(models));
    }
    if (!ctx.hasUI) return;
    if (failed > 0) {
      ctx.ui.notify(
        `ollama-models: couldn't fetch ${failed} of ${SEED_MODEL_IDS.length} models from the daemon — using built-in values`,
        "warning",
      );
    } else if (models.length === 0) {
      ctx.ui.notify(
        "ollama-models: daemon returned no usable models — using built-in catalog",
        "warning",
      );
    } else {
      ctx.ui.notify("ollama-models: fetched the latest model data from the daemon", "info");
    }
  } catch {
    // Defense in depth: fetchShow and assemble never throw; a re-register
    // validation throw lands here and still surfaces a visual.
    if (ctx.hasUI) {
      ctx.ui.notify("ollama-models: catalog refresh failed", "warning");
    }
  }
};

const ollamaModelsExtension = (pi: ExtensionAPI): void => {
  createOllamaModelsExtension(pi);
};

export default ollamaModelsExtension;
