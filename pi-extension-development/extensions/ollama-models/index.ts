/**
 * ollama-models extension.
 *
 * Owns the "ollama" provider under its existing id, so settings.json and the
 * /model UX stay unchanged. config.json names the models the local daemon
 * serves; all model data (context window, capabilities) comes from the live
 * daemon, fetched here at load. pi resolves the session's default model
 * after extensions load, and the default is an ollama model, so the provider
 * must exist by then — the entry is async because the fetch is, and pi
 * awaits it. A daemon that yields no usable model fails the load loudly: a
 * missing default provider must be visible, not silent. No ollama.com, no
 * API key — the daemon attaches the cloud sign-in when it proxies.
 *
 * The session_start handler only reports the outcome; it never fetches.
 * Models live for the process lifetime, and /reload re-imports the module,
 * which re-fetches on its own. Loading has no UI context, so the report
 * waits for the first session_start — reasons "startup" and "reload" only,
 * because /new, /resume, /fork are in-process sessions that reuse the
 * registered catalog.
 */

import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { assembleModels } from "./assemble.ts";
import { CONFIG } from "./config.ts";
import { FETCH_TIMEOUT_MS, fetchShow, type OllamaModelsDeps } from "./ollama-api.ts";

// Host dependencies, injectable so tests pass fakes; a builtin reference
// rather than an arrow wrapper, so no extra function body exists that tests
// would have to call.
const defaultDeps: OllamaModelsDeps = {
  fetch: globalThis.fetch,
};

const buildProviderConfig = (models: ProviderModelConfig[]): ProviderConfig => ({
  name: "ollama",
  baseUrl: `${CONFIG.baseUrl}/v1`,
  // Literal dummy key: it satisfies pi's credential gates; the daemon does
  // the real auth when it proxies.
  apiKey: "ollama",
  api: "openai-completions",
  models,
});

/** What the load-time fetch produced: the registered entries and the config ids that did not make it. */
interface CatalogOutcome {
  models: ProviderModelConfig[];
  missing: readonly string[];
}

/** Live data only — ids the daemon cannot describe land in missing, never filled in. */
export const fetchCatalog = async (deps: OllamaModelsDeps): Promise<CatalogOutcome> => {
  const results = await Promise.all(
    CONFIG.models.map(async (id) => {
      const result = await fetchShow(id, CONFIG.baseUrl, deps, FETCH_TIMEOUT_MS);
      return [id, result] as const;
    }),
  );
  const shows = new Map(
    results.flatMap(([id, result]) => (result.ok ? [[id, result.data] as const] : [])),
  );
  const models = assembleModels(CONFIG.models, shows);
  const registered = models.map((model) => model.id);
  const missing = CONFIG.models.filter((id) => !registered.includes(id));
  return { models, missing };
};

/** Throws when no configured model is usable, so the failure surfaces as a failed extension load. */
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

// pi's loader requires the default export (its docs/extensions.md: "Entry
// point (exports default function)"); this is the project's one allowed
// default export.
export default createOllamaModelsExtension;
