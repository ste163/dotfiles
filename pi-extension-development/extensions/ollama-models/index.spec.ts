import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import ollamaModelsExtension, { createOllamaModelsExtension, fetchCatalog } from "./index.ts";
import { CONFIG } from "./config.ts";
import type { OllamaModelsDeps, ShowResponse } from "./ollama-api.ts";

// --- Minimal fakes for the pi API surface this extension uses ---

interface Registration {
  id: string;
  config: ProviderConfig;
}

type SessionStartHandler = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => void | Promise<void>;

const createFakePi = (options?: { failAfter?: number }) => {
  const registrations: Registration[] = [];
  const handlers = new Map<string, SessionStartHandler>();
  const pi = {
    registerProvider(id: string, config: ProviderConfig): void {
      if (registrations.length >= (options?.failAfter ?? Number.POSITIVE_INFINITY)) {
        throw new Error("register rejected");
      }
      registrations.push({ id, config });
    },
    on(_event: "session_start", handler: SessionStartHandler): void {
      handlers.set("session_start", handler);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, registrations, handlers };
};

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

const createContext = (hasUI: boolean) => {
  const notifications: Notification[] = [];
  const ctx = {
    hasUI,
    ui: {
      // Required type param: the extension always passes one, and this keeps
      // the push free of the exactOptionalPropertyTypes conditional dance.
      notify(message: string, type: "info" | "warning" | "error"): void {
        notifications.push({ message, type });
      },
    },
  };
  return { ctx, notifications };
};

/** Canned /api/show responses keyed by model id (read from the request body). */
type CannedResponse = { status: number; body: string };

const okShow = (
  contextLength: number,
  capabilities = ["completion", "thinking", "tools"],
): CannedResponse => ({
  status: 200,
  body: JSON.stringify({
    model_info: { "arch.context_length": contextLength },
    capabilities,
  } satisfies ShowResponse),
});

const servingDeps = (responses: Record<string, CannedResponse>) => {
  const calls: string[] = [];
  const deps: OllamaModelsDeps = {
    fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
      const id = JSON.parse(String(init?.body)).model as string;
      calls.push(id);
      const res = responses[id];
      if (res === undefined) return new Response("model not found", { status: 404 });
      return new Response(res.body, { status: res.status });
    },
  };
  return { deps, calls };
};

const allOk = (contextLength: number): Record<string, CannedResponse> =>
  Object.fromEntries(CONFIG.models.map((id) => [id, okShow(contextLength)]));

const sessionStartHandler = (handlers: Map<string, SessionStartHandler>): SessionStartHandler => {
  const handler = handlers.get("session_start");
  assert.ok(handler, "session_start handler not registered");
  return handler;
};

// --- Registration ---

test("a live catalog registers the provider with the config-derived endpoint", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  await createOllamaModelsExtension(pi, deps);
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.ok(registration);
  assert.equal(registration.id, "ollama");
  const config = registration.config;
  assert.equal(config.name, "ollama");
  assert.equal(config.baseUrl, `${CONFIG.baseUrl}/v1`);
  assert.equal(config.apiKey, "ollama");
  assert.equal(config.api, "openai-completions");
  // The fetch is owned by the extension at load; pi's refreshModels callback is unused.
  assert.equal(config.refreshModels, undefined);
  const models = config.models;
  assert.ok(models);
  assert.equal(models.length, CONFIG.models.length);
  assert.ok(models.every((m) => m.contextWindow === 4096));
  assert.ok(handlers.has("session_start"));
});

test("the default export is the same registerer", async () => {
  const { pi, registrations } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  await ollamaModelsExtension(pi, deps);
  assert.equal(registrations.length, 1);
});

// --- fetchCatalog ---

test("fetchCatalog fetches every configured id and reports none missing", async () => {
  const { deps, calls } = servingDeps(allOk(777777));
  const outcome = await fetchCatalog(deps);
  assert.deepEqual(calls, [...CONFIG.models]);
  assert.equal(outcome.models.length, CONFIG.models.length);
  assert.ok(outcome.models.every((m) => m.contextWindow === 777777));
  assert.deepEqual(outcome.missing, []);
});

test("fetchCatalog reports unusable ids by name", async () => {
  const responses = allOk(888888);
  const dropped = CONFIG.models[0];
  assert.ok(dropped); // 404: the serving fetch has no canned response
  delete responses[dropped];
  const { deps } = servingDeps(responses);
  const outcome = await fetchCatalog(deps);
  assert.equal(outcome.models.length, CONFIG.models.length - 1);
  assert.deepEqual(outcome.missing, [dropped]);
});

// --- session_start reporting ---

test("a startup session_start reports the fetched catalog", async () => {
  const { pi, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  await createOllamaModelsExtension(pi, deps);
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "startup" },
    ctx as unknown as ExtensionContext,
  );
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /fetched the latest model data/);
  assert.equal(notification.type, "info");
});

test("a reload session_start reports too", async () => {
  const { pi, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  await createOllamaModelsExtension(pi, deps);
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "reload" },
    ctx as unknown as ExtensionContext,
  );
  assert.equal(notifications.length, 1);
});

test("in-process session starts (new/resume/fork) stay silent", async () => {
  const { pi, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  await createOllamaModelsExtension(pi, deps);
  const handler = sessionStartHandler(handlers);
  for (const reason of ["new", "resume", "fork"] as const) {
    handler({ type: "session_start", reason }, ctx as unknown as ExtensionContext);
  }
  assert.equal(notifications.length, 0);
});

test("headless (hasUI false): no messages", async () => {
  const { pi, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(false);
  await createOllamaModelsExtension(pi, deps);
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "startup" },
    ctx as unknown as ExtensionContext,
  );
  assert.equal(notifications.length, 0);
});

// --- failure modes ---

test("a partial catalog registers the survivors and warns naming the missing id", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const responses = allOk(888888);
  const dropped = CONFIG.models[0];
  assert.ok(dropped);
  delete responses[dropped];
  const { deps } = servingDeps(responses);
  const { ctx, notifications } = createContext(true);
  await createOllamaModelsExtension(pi, deps);
  assert.equal(registrations.length, 1);
  const models = registrations[0]?.config.models;
  assert.ok(models);
  assert.equal(models.length, CONFIG.models.length - 1);
  assert.ok(models.every((m) => m.contextWindow === 888888));
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "startup" },
    ctx as unknown as ExtensionContext,
  );
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.equal(
    notification.message,
    `ollama-models: couldn't register 1 of ${CONFIG.models.length} models from the daemon: ${dropped}`,
  );
  assert.equal(notification.type, "warning");
});

test("a dead daemon fails the load loudly and registers nothing", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const { deps } = servingDeps({}); // every id answers 404
  await assert.rejects(createOllamaModelsExtension(pi, deps), /no usable models/);
  assert.equal(registrations.length, 0);
  assert.equal(handlers.size, 0); // no report handler survives a failed load
});

test("tools-less responses fail the load the same way", async () => {
  const { pi, registrations } = createFakePi();
  const responses: Record<string, CannedResponse> = {};
  for (const id of CONFIG.models) responses[id] = okShow(999, ["completion"]);
  const { deps } = servingDeps(responses);
  await assert.rejects(createOllamaModelsExtension(pi, deps), /no usable models/);
  assert.equal(registrations.length, 0);
});

test("a registration rejection propagates as a load failure", async () => {
  const { pi } = createFakePi({ failAfter: 0 });
  const { deps } = servingDeps(allOk(4096));
  await assert.rejects(createOllamaModelsExtension(pi, deps), /register rejected/);
});
