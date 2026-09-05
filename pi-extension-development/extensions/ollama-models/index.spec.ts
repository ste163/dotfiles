import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import ollamaModelsExtension, { createOllamaModelsExtension } from "./index.ts";
import type { OllamaModelsDeps, ShowResponse } from "./ollama-api.ts";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

interface Registration {
  id: string;
  config: ProviderConfig;
}

const fakePi = (registrations: Registration[]): ExtensionAPI => {
  const pi = {
    registerProvider(id: string, config: ProviderConfig): void {
      registrations.push({ id, config });
    },
  };
  return pi as unknown as ExtensionAPI;
};

const assertLockedConfig = (config: ProviderConfig): void => {
  assert.equal(config.name, "ollama");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.apiKey, "ollama");
  assert.equal(config.api, "openai-completions");
  assert.equal(config.models, SEED_MODELS);
  assert.equal(typeof config.refreshModels, "function");
};

test("createOllamaModelsExtension registers the locked provider config", () => {
  const registrations: Registration[] = [];
  createOllamaModelsExtension(fakePi(registrations));
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.ok(registration);
  assert.equal(registration.id, "ollama");
  assertLockedConfig(registration.config);
});

test("the default export registers the same provider", () => {
  const registrations: Registration[] = [];
  ollamaModelsExtension(fakePi(registrations));
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.ok(registration);
  assert.equal(registration.id, "ollama");
  assertLockedConfig(registration.config);
});

test("refreshModels is wired to the injected deps", async () => {
  const registrations: Registration[] = [];
  const calls: string[] = [];
  const deps: OllamaModelsDeps = {
    fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push(JSON.parse(String(init?.body)).model);
      const show: ShowResponse = {
        model_info: { "arch.context_length": 4096 },
        capabilities: ["completion", "thinking", "tools"],
      };
      return new Response(JSON.stringify(show), { status: 200 });
    },
    now: () => 1,
  };
  createOllamaModelsExtension(fakePi(registrations), deps);
  const config = registrations[0]?.config;
  assert.ok(config);
  assert.ok(config.refreshModels);
  const models = await config.refreshModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert.deepEqual(calls, [...SEED_MODEL_IDS]);
  assert.equal(models.length, SEED_MODEL_IDS.length);
  assert.ok(models.every((m) => m.contextWindow === 4096));
});
