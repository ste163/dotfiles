import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import ollamaModelsExtension, { createOllamaModelsExtension, refreshCatalog } from "./index.ts";
import type { OllamaModelsDeps, ShowResponse } from "./ollama-api.ts";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

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
        throw new Error("swap rejected");
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
  Object.fromEntries(SEED_MODEL_IDS.map((id) => [id, okShow(contextLength)]));

// One macrotask flushes every promise continuation from the fire-and-forget
// handler path, so the wiring tests can await its side effects.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sessionStartHandler = (handlers: Map<string, SessionStartHandler>): SessionStartHandler => {
  const handler = handlers.get("session_start");
  assert.ok(handler, "session_start handler not registered");
  return handler;
};

// --- Registration ---

test("createOllamaModelsExtension registers the locked provider config", () => {
  const { pi, registrations, handlers } = createFakePi();
  createOllamaModelsExtension(pi);
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.ok(registration);
  assert.equal(registration.id, "ollama");
  const config = registration.config;
  assert.equal(config.name, "ollama");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.apiKey, "ollama");
  assert.equal(config.api, "openai-completions");
  assert.equal(config.models, SEED_MODELS);
  assert.equal(config.refreshModels, undefined); // the rework removed it
  assert.ok(handlers.has("session_start"));
});

test("the default export registers the same provider", () => {
  const { pi, registrations } = createFakePi();
  ollamaModelsExtension(pi);
  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.ok(registration);
  assert.equal(registration.id, "ollama");
});

// --- session_start wiring ---

test("a startup session_start fires the fetch without blocking", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const { deps, calls } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  const returned = sessionStartHandler(handlers)(
    { type: "session_start", reason: "startup" },
    ctx as unknown as ExtensionContext,
  );
  assert.equal(returned, undefined); // fire-and-forget: never blocks
  await settle();
  assert.deepEqual(calls, [...SEED_MODEL_IDS]);
  assert.equal(registrations.length, 2); // the swap re-registered
  const swapped = registrations[1]?.config.models;
  assert.ok(swapped);
  assert.ok(swapped.every((m) => m.contextWindow === 4096));
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /fetched the latest model data/);
  assert.equal(notification.type, "info");
});

test("a reload session_start also fetches", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "reload" },
    ctx as unknown as ExtensionContext,
  );
  await settle();
  assert.equal(registrations.length, 2);
});

test("in-process session starts (new/resume/fork) fetch nothing", async () => {
  const { pi, registrations, handlers } = createFakePi();
  const { deps, calls } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  sessionStartHandler(handlers)(
    { type: "session_start", reason: "new" },
    ctx as unknown as ExtensionContext,
  );
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(registrations.length, 1);
  assert.equal(notifications.length, 0);
});

// --- refreshCatalog behavior ---

test("all four fetches ok: swap in live values, info message", async () => {
  const { pi, registrations } = createFakePi();
  const { deps } = servingDeps(allOk(777777));
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 2);
  const swapped = registrations[1]?.config.models;
  assert.ok(swapped);
  assert.ok(swapped.every((m) => m.contextWindow === 777777));
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /fetched the latest model data/);
});

test("headless (hasUI false): swap happens, no messages", async () => {
  const { pi, registrations } = createFakePi();
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(false);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 2);
  assert.equal(notifications.length, 0);
});

test("one fetch fails: seed fills the gap, warning with the count", async () => {
  const { pi, registrations } = createFakePi();
  const responses = allOk(888888);
  delete responses["glm-5.3:cloud"]; // 404: the serving fetch has no canned response
  const { deps } = servingDeps(responses);
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 2);
  const swapped = registrations[1]?.config.models;
  assert.ok(swapped);
  const byId = new Map(swapped.map((m) => [m.id, m]));
  const seedGlm = SEED_MODELS.find((m) => m.id === "glm-5.3:cloud");
  assert.ok(seedGlm);
  assert.deepEqual(byId.get("glm-5.3:cloud"), seedGlm); // failed fetch -> seed kept
  assert.equal(byId.get("qwen3.5:cloud")?.contextWindow, 888888); // live value won
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /couldn't fetch 1 of 4/);
  assert.equal(notification.type, "warning");
});

test("all fetches fail: no swap, warning", async () => {
  const { pi, registrations } = createFakePi();
  const { deps } = servingDeps({}); // every id answers 404
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 1); // seed registration stands
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /couldn't fetch 4 of 4/);
  assert.equal(notification.type, "warning");
});

test("all responses lack tools: no swap, warning", async () => {
  const { pi, registrations } = createFakePi();
  const responses: Record<string, CannedResponse> = {};
  for (const id of SEED_MODEL_IDS) responses[id] = okShow(999, ["completion"]);
  const { deps } = servingDeps(responses);
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 1);
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /no usable models/);
  assert.equal(notification.type, "warning");
});

test("a swap rejection surfaces the catch-path warning", async () => {
  const { pi, registrations } = createFakePi({ failAfter: 1 });
  const { deps } = servingDeps(allOk(4096));
  const { ctx, notifications } = createContext(true);
  createOllamaModelsExtension(pi, deps);
  await refreshCatalog(pi, ctx, deps);
  assert.equal(registrations.length, 1); // the initial registration only
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification);
  assert.match(notification.message, /catalog refresh failed/);
  assert.equal(notification.type, "warning");
});
