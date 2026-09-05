/**
 * ollama-models extension.
 *
 * Owns the "ollama" provider (plan Decision #1: same id, so settings.json and
 * the /model UX stay unchanged). Registers a seed catalog of the four
 * cloud-routed models served by the local daemon, plus a refreshModels
 * callback that enriches each entry live from POST /api/show. No ollama.com,
 * no API key, no new credentials — the daemon attaches the cloud sign-in
 * when it proxies (plan Decisions #2/#3).
 */

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DAEMON_BASE_URL, type OllamaModelsDeps } from "./ollama-api.ts";
import { createRefreshModels } from "./refresh.ts";
import { SEED_MODELS } from "./seed.ts";

// Host dependencies, injected per the PlanModeDeps rule (plan Decision #13):
// builtin references, not arrow wrappers, so no extra function bodies exist
// that tests would have to call.
const defaultDeps: OllamaModelsDeps = {
  fetch: globalThis.fetch,
  now: Date.now,
};

/** Register the ollama provider with the locked config. Testable entry. */
export const createOllamaModelsExtension = (
  pi: ExtensionAPI,
  deps: OllamaModelsDeps = defaultDeps,
): void => {
  pi.registerProvider("ollama", {
    // Display name stays "ollama", same as the models.json block it replaces.
    name: "ollama",
    baseUrl: `${DEFAULT_DAEMON_BASE_URL}/v1`,
    // Literal dummy key (Decision #2): it satisfies pi's credential gates;
    // the daemon does the real auth when it proxies.
    apiKey: "ollama",
    api: "openai-completions",
    models: SEED_MODELS,
    refreshModels: createRefreshModels(deps),
  } satisfies ProviderConfig);
};

const ollamaModelsExtension = (pi: ExtensionAPI): void => {
  createOllamaModelsExtension(pi);
};

export default ollamaModelsExtension;
