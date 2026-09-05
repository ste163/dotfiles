import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Api, Model, ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OllamaModelsDeps, ShowResponse } from "./ollama-api.ts";
import { createRefreshModels } from "./refresh.ts";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

const NOW = 1700000000000;
const HOUR_MS = 60 * 60 * 1000;

// A fake clock: now() is fixed so cooldown math is deterministic.
const deps = (fetch: OllamaModelsDeps["fetch"]): OllamaModelsDeps => ({ fetch, now: () => NOW });

// A stored entry has the pi-ai Model shape: the store rehydrates full Models,
// so seed entries gain the provider identity fields. Cast for the same reason
// as in refresh.ts: ProviderModelConfig's indexed-access optionals widen with
// `| undefined`, which exactOptionalPropertyTypes rejects against Model.
const storedModel = (seed: ProviderModelConfig): Model<Api> =>
  ({
    ...seed,
    provider: "ollama",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
  }) as Model<Api>;

const show = (
  contextLength: number,
  capabilities = ["completion", "thinking", "tools"],
): ShowResponse => ({
  model_info: { "arch.context_length": contextLength },
  capabilities,
});

/** A canned /api/show response body keyed by model id. */
type CannedResponse = { status: number; body: string };

const okShow = (data: ShowResponse): CannedResponse => ({
  status: 200,
  body: JSON.stringify(data),
});

const failing = (): CannedResponse => ({ status: 500, body: "boom" });

/** A request that never resolves until its abort signal fires. */
const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

/** Serve canned responses keyed by model id (read from the request body). */
const servingFetch = (responses: Record<string, CannedResponse>) => {
  const calls: string[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const id = JSON.parse(String(init?.body)).model as string;
    calls.push(id);
    const res = responses[id];
    if (res === undefined) return new Response("model not found", { status: 404 });
    return new Response(res.body, { status: res.status });
  };
  return { fetch, calls };
};

/** Capture what the callback publishes. */
const publishCapture = (): {
  publish: RefreshModelsContext["publish"];
  state: { calls: number; publications: ModelsPublication[] };
} => {
  const state = { calls: 0, publications: [] as ModelsPublication[] };
  return {
    state,
    publish: async (publication) => {
      state.calls++;
      state.publications.push(publication);
      return true;
    },
  };
};

const createContext = (options: {
  allowNetwork: boolean;
  stored?: Readonly<{ models: readonly Model<Api>[]; checkedAt?: number }>;
  force?: boolean;
  publish?: RefreshModelsContext["publish"];
}): RefreshModelsContext => {
  const controller = new AbortController();
  return {
    allowNetwork: options.allowNetwork,
    signal: controller.signal,
    ...(options.stored !== undefined
      ? {
          stored: {
            models: options.stored.models,
            ...(options.stored.checkedAt !== undefined
              ? { checkedAt: options.stored.checkedAt }
              : {}),
          },
        }
      : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    publish: options.publish ?? (async () => true),
  };
};

test("restore phase returns the stored catalog when present", async () => {
  const stored = SEED_MODELS.map(storedModel);
  const { fetch, calls } = servingFetch({});
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: false, stored: { models: stored } }),
  );
  assert.deepEqual(result, stored);
  assert.notEqual(result, stored); // a copy, never the stored reference
  assert.equal(calls.length, 0);
});

test("restore phase falls back to the seed catalog when nothing is stored", async () => {
  const { fetch, calls } = servingFetch({});
  const result = await createRefreshModels(deps(fetch))(createContext({ allowNetwork: false }));
  assert.deepEqual(result, SEED_MODELS);
  assert.equal(calls.length, 0);
});

test("restore phase ignores an empty stored catalog", async () => {
  const { fetch } = servingFetch({});
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: false, stored: { models: [] } }),
  );
  assert.deepEqual(result, SEED_MODELS);
});

test("an already-aborted signal returns the fallback without fetching", async () => {
  const { fetch, calls } = servingFetch({});
  const capture = publishCapture();
  const controller = new AbortController();
  controller.abort();
  const context: RefreshModelsContext = {
    allowNetwork: true,
    signal: controller.signal,
    publish: capture.publish,
  };
  const result = await createRefreshModels(deps(fetch))(context);
  assert.deepEqual(result, SEED_MODELS);
  assert.equal(calls.length, 0);
  assert.equal(capture.state.calls, 0);
});

test("cooldown: a fresh stored catalog skips the network fetch", async () => {
  const stored = SEED_MODELS.map(storedModel);
  const { fetch, calls } = servingFetch({});
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: true, stored: { models: stored, checkedAt: NOW - 3 * HOUR_MS } }),
  );
  assert.deepEqual(result, stored);
  assert.equal(calls.length, 0);
});

test("cooldown: an expired window fetches again", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(4096));
  const { fetch, calls } = servingFetch(responses);
  const result = await createRefreshModels(deps(fetch))(
    createContext({
      allowNetwork: true,
      stored: { models: SEED_MODELS.map(storedModel), checkedAt: NOW - 5 * HOUR_MS },
    }),
  );
  assert.equal(calls.length, SEED_MODEL_IDS.length);
  assert.equal(result.length, SEED_MODEL_IDS.length);
  assert.ok(result.every((m) => m.contextWindow === 4096));
});

test("force bypasses the cooldown", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(4096));
  const { fetch, calls } = servingFetch(responses);
  const result = await createRefreshModels(deps(fetch))(
    createContext({
      allowNetwork: true,
      stored: { models: SEED_MODELS.map(storedModel), checkedAt: NOW - 1000 },
      force: true,
    }),
  );
  assert.equal(calls.length, SEED_MODEL_IDS.length);
  assert.equal(result.length, SEED_MODEL_IDS.length);
});

test("a failed /api/show keeps the seed entry; the list still has all four", async () => {
  // glm-5.3:cloud has no canned response, so the serving fetch answers 404.
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) {
    if (id !== "glm-5.3:cloud") responses[id] = okShow(show(999999));
  }
  const { fetch, calls } = servingFetch(responses);
  const capture = publishCapture();
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: true, publish: capture.publish }),
  );
  assert.equal(calls.length, SEED_MODEL_IDS.length);
  assert.equal(result.length, SEED_MODEL_IDS.length);
  const byId = new Map(result.map((m) => [m.id, m]));
  const seedGlm = SEED_MODELS.find((m) => m.id === "glm-5.3:cloud");
  assert.ok(seedGlm);
  // failed fetch -> seed values kept (in the persisted Model shape)
  assert.deepEqual(byId.get("glm-5.3:cloud"), storedModel(seedGlm));
  for (const id of ["deepseek-v4-pro:cloud", "gemma4:31b-cloud", "qwen3.5:cloud"]) {
    assert.equal(byId.get(id)?.contextWindow, 999999); // live value won
  }
  assert.equal(capture.state.calls, 1);
  assert.equal(capture.state.publications[0]?.persist?.checkedAt, NOW);
  assert.equal(capture.state.publications[0]?.persist?.models, result); // same array returned
});

test("a failed /api/show keeps the stored entry when one exists", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(777777));
  responses["glm-5.3:cloud"] = failing();
  const { fetch } = servingFetch(responses);
  const stored = SEED_MODELS.map((m) => ({ ...storedModel(m), contextWindow: 555555 }));
  // No checkedAt on the stored catalog, so the network phase runs.
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: true, stored: { models: stored } }),
  );
  const byId = new Map(result.map((m) => [m.id, m]));
  assert.equal(byId.get("glm-5.3:cloud")?.contextWindow, 555555); // stored value kept
  assert.equal(byId.get("qwen3.5:cloud")?.contextWindow, 777777); // live value won
});

test("a fully down daemon returns the fallback and advances checkedAt", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = failing();
  const { fetch, calls } = servingFetch(responses);
  const capture = publishCapture();
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: true, publish: capture.publish }),
  );
  // The fallback catalog in its persisted Model shape.
  assert.deepEqual(result, SEED_MODELS.map(storedModel));
  assert.equal(calls.length, SEED_MODEL_IDS.length);
  assert.equal(capture.state.calls, 1);
  assert.equal(capture.state.publications[0]?.persist?.checkedAt, NOW); // cooldown applies
});

test("a mid-flight abort returns the fallback and does not publish", async () => {
  const controller = new AbortController();
  const capture = publishCapture();
  const promise = createRefreshModels(deps(hangingFetch))({
    allowNetwork: true,
    signal: controller.signal,
    publish: capture.publish,
  });
  controller.abort();
  assert.deepEqual(await promise, SEED_MODELS);
  assert.equal(capture.state.calls, 0);
});

test("an all-tools-less merge keeps the fallback and does not publish", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(1, ["completion"]));
  const { fetch } = servingFetch(responses);
  const capture = publishCapture();
  const result = await createRefreshModels(deps(fetch))(
    createContext({ allowNetwork: true, publish: capture.publish }),
  );
  assert.deepEqual(result, SEED_MODELS);
  assert.equal(capture.state.calls, 0);
});

test("publish returning false warns and still returns the list", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(4096));
  const { fetch } = servingFetch(responses);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  let result: ProviderModelConfig[] | undefined;
  try {
    result = await createRefreshModels(deps(fetch))(
      createContext({ allowNetwork: true, publish: async () => false }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(result);
  assert.equal(result.length, SEED_MODEL_IDS.length);
  assert.equal(warnings.length, 1);
  const firstWarning = warnings[0];
  assert.ok(firstWarning);
  assert.match(firstWarning, /\[ollama-models\]/);
});

test("publish throwing warns and still returns the list", async () => {
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(show(4096));
  const { fetch } = servingFetch(responses);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  let result: ProviderModelConfig[] | undefined;
  try {
    result = await createRefreshModels(deps(fetch))(
      createContext({
        allowNetwork: true,
        publish: async () => {
          throw new Error("disk full");
        },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(result);
  assert.equal(result.length, SEED_MODEL_IDS.length);
  assert.equal(warnings.length, 1);
  const firstWarning = warnings[0];
  assert.ok(firstWarning);
  assert.match(firstWarning, /\[ollama-models\]/);
});
