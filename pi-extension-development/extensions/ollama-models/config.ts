/**
 * config.json is pure intent: which models the daemon should serve, and
 * where the daemon lives. Every model's data (context window, vision,
 * thinking) comes from the live daemon — nothing is cached or mirrored
 * here. The file is author-owned, so validation is strict and throws at
 * load: a typo must stop the extension loudly, never silently drop data.
 */

import rawConfig from "./config.json" with { type: "json" };

/** The validated config shape; the ids are a wish list, not a data source. */
export interface OllamaConfig {
  readonly baseUrl: string;
  readonly models: readonly string[];
}

export function validateConfig(raw: unknown): OllamaConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("ollama-models: config.json: expected a JSON object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "baseUrl" && key !== "models") {
      throw new Error(
        `ollama-models: config.json: unknown field "${key}" (allowed: baseUrl, models)`,
      );
    }
  }
  const baseUrl = record["baseUrl"];
  if (typeof baseUrl !== "string") {
    throw new Error("ollama-models: config.json: baseUrl must be a string");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`ollama-models: config.json: baseUrl "${baseUrl}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `ollama-models: config.json: baseUrl "${baseUrl}" must be an http or https URL`,
    );
  }
  // new URL() normalizes a bare root to pathname "/", so any other value is
  // a path the code never asked for ("/v1" here would become "/v1/v1").
  if (url.pathname !== "/") {
    throw new Error(
      `ollama-models: config.json: baseUrl "${baseUrl}" must be the daemon root without a path — the code derives /v1 and /api/show`,
    );
  }
  const models = record["models"];
  if (!Array.isArray(models)) {
    throw new Error("ollama-models: config.json: models must be an array of model ids");
  }
  if (models.length === 0) {
    throw new Error("ollama-models: config.json: models must not be empty");
  }
  const ids: string[] = [];
  for (const [i, id] of models.entries()) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`ollama-models: config.json: models[${i}] must be a non-empty string`);
    }
    if (ids.includes(id)) {
      throw new Error(`ollama-models: config.json: duplicate model id "${id}"`);
    }
    ids.push(id);
  }
  return { baseUrl, models: ids };
}

/**
 * The resolved config. Runs at import, so a bad file throws during
 * extension load and pi reports the message.
 */
export const CONFIG = validateConfig(rawConfig);
