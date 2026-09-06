/**
 * ollama-models extension.
 *
 * Owns the "ollama" provider under its existing id, so settings.json and the
 * /model UX stay unchanged. config.json names the cloud-routed models the
 * local daemon serves; every model datum (context window, capabilities)
 * comes from the live daemon, fetched here at load. pi resolves the
 * session's default model only after extensions load, and the default IS an
 * ollama model — so the provider must exist by then, and the entry is
 * async because the fetch is (pi awaits it). A daemon that yields no usable
 * model fails the load loudly: a daily-driver provider that silently
 * vanishes is worse than a visible failure. No ollama.com, no API key, no
 * new credentials — the daemon attaches the cloud sign-in when it proxies.
 *
 * The session_start handler only reports the outcome; it never fetches.
 * The load-time fetch already ran, models live for the process lifetime,
 * and /reload re-imports the module, which re-fetches on its own. Loading
 * has no UI context, so the report waits for the first session_start
 * (reasons "startup" and "reload" only — /new, /resume, /fork are in-process
 * sessions that reuse the registered catalog, and a repeat message would
 * be noise).
 */

import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { assembleModels } from "./assemble.ts";
import { CONFIG } from "./config.ts";
import {
  FETCH_TIMEOUT_MS,
  fetchShow,
  type OllamaModelsDeps,
  type ShowResponse,
} from "./ollama-api.ts";

// Host dependencies, injectable so tests pass fakes. A builtin reference,
// not an arrow wrapper, so no extra function body exists that tests would
// have to call.
const defaultDeps: OllamaModelsDeps = {
  fetch: globalThis.fetch,
};

/** The provider config registered from live data; the endpoint derives from config. */
const buildProviderConfig = (models: ProviderModelConfig[]): ProviderConfig => ({
  // The display name matches the provider id.
  name: "ollama",
  baseUrl: `${CONFIG.baseUrl}/v1`,
  // Literal dummy key: it satisfies pi's credential gates; the
  // daemon does the real auth when it proxies.
  apiKey: "ollama",
  api: "openai-completions",
  models,
});

/** The load-time fetch result: what registered and which ids went missing. */
export interface CatalogOutcome {
  models: ProviderModelConfig[];
  missing: readonly string[];
}

/**
 * Fetch every configured model's live data and assemble the catalog. The
 * daemon is the only data source: an id the daemon cannot describe comes
 * back missing, never invented.
 */
export const fetchCatalog = async (deps: OllamaModelsDeps): Promise<CatalogOutcome> => {
  const results = await Promise.all(
    CONFIG.models.map(async (id) => {
      const result = await fetchShow(id, CONFIG.baseUrl, deps, FETCH_TIMEOUT_MS);
      return [id, result.ok ? result.data : undefined] as const;
    }),
  );
  const shows = new Map<string, ShowResponse>();
  for (const [id, data] of results) {
    if (data !== undefined) shows.set(id, data);
  }
  const models = assembleModels(CONFIG.models, shows);
  const registered = new Set(models.map((m) => m.id));
  const missing = CONFIG.models.filter((id) => !registered.has(id));
  return { models, missing };
};

/**
 * Register the ollama provider from live daemon data. Testable entry; the
 * default export is this same function. Throws when no configured model is
 * usable — pi surfaces the message as a failed extension load.
 */
export const createOllamaModelsExtension = async (
  pi: ExtensionAPI,
  deps: OllamaModelsDeps = defaultDeps,
): Promise<void> => {
  const outcome = await fetchCatalog(deps);
  if (outcome.models.length === 0) {
    throw new Error(
      "ollama-models: no usable models from the daemon — ollama provider not registered",
    );
  }
  pi.registerProvider("ollama", buildProviderConfig(outcome.models));
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    if (!ctx.hasUI) return;
    if (outcome.missing.length > 0) {
      ctx.ui.notify(
        `ollama-models: couldn't register ${outcome.missing.length} of ${CONFIG.models.length} models from the daemon: ${outcome.missing.join(", ")}`,
        "warning",
      );
    } else {
      ctx.ui.notify("ollama-models: fetched the latest model data from the daemon", "info");
    }
  });
};

export default createOllamaModelsExtension;
