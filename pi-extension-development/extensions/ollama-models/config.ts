/**
 * Config for the ollama-models extension.
 *
 * config.json is pure intent: which models the daemon serves, and where the
 * daemon lives. All model data (context window, vision, thinking) comes
 * from the live daemon. The file is author-owned, so validation throws at
 * load — a typo must stop the extension loudly, never silently drop a
 * model.
 */

import rawConfig from "./config.json" with { type: "json" };

interface OllamaConfig {
  readonly baseUrl: string;
  readonly models: readonly string[];
}

/**
 * Strict validation: throws a message naming the offending field, and
 * rejects unknown fields so a typo cannot silently disable a model.
 */
export const validateConfig = (raw: unknown): OllamaConfig => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("ollama-models: config.json: expected a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const unknownField = Object.keys(record).find((key) => key !== "baseUrl" && key !== "models");
  if (unknownField) {
    throw new Error(
      `ollama-models: config.json: unknown field "${unknownField}" (allowed: baseUrl, models)`,
    );
  }
  const baseUrl = record["baseUrl"];
  if (typeof baseUrl !== "string") {
    throw new Error("ollama-models: config.json: baseUrl must be a string");
  }
  const url = URL.parse(baseUrl);
  if (!url) {
    throw new Error(`ollama-models: config.json: baseUrl "${baseUrl}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `ollama-models: config.json: baseUrl "${baseUrl}" must be an http or https URL`,
    );
  }
  // URL normalizes a bare root to pathname "/", so any other value is a path
  // the code never asked for ("/v1" here would become "/v1/v1").
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
  const ids = models.map((model, index) => {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error(`ollama-models: config.json: models[${index}] must be a non-empty string`);
    }
    return model;
  });
  const duplicate = ids.find((model, index) => ids.slice(0, index).includes(model));
  if (duplicate) {
    throw new Error(`ollama-models: config.json: duplicate model id "${duplicate}"`);
  }
  return { baseUrl, models: ids };
};

/** Validated at import: a bad file throws during extension load and pi reports the message. */
export const CONFIG = validateConfig(rawConfig);
