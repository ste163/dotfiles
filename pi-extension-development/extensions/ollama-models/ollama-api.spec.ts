import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_DAEMON_BASE_URL,
  fetchShow,
  getContextLength,
  type OllamaModelsDeps,
  type ShowResponse,
} from "./ollama-api.ts";

// now is a builtin reference on purpose: fetchShow never calls it, and a
// local arrow body would show up as an uncovered function in the gate.
const deps = (fetch: OllamaModelsDeps["fetch"]): OllamaModelsDeps => ({ fetch, now: Date.now });

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status });

// A request that never resolves until its abort signal fires.
const hangingFetch = (): OllamaModelsDeps["fetch"] => {
  return (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
};

test("fetchShow returns parsed show data", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const show: ShowResponse = {
    model_info: { "arch.context_length": 4096 },
    capabilities: ["completion", "tools"],
  };
  const result = await fetchShow(
    "glm-5.3:cloud",
    DEFAULT_DAEMON_BASE_URL,
    deps((_url, init) => {
      calls.push({ url: _url, init });
      return Promise.resolve(jsonResponse(show));
    }),
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(result, { ok: true, data: show });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/show");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { model: "glm-5.3:cloud" });
});

test("fetchShow fails soft on a non-ok status", async () => {
  const result = await fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    deps(() => Promise.resolve(new Response("boom", { status: 500 }))),
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow fails soft when fetch rejects (daemon down)", async () => {
  const result = await fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    deps(() => Promise.reject(new Error("ECONNREFUSED"))),
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow fails soft on a malformed JSON body", async () => {
  const result = await fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    deps(() => Promise.resolve(new Response("<html>", { status: 200 }))),
    new AbortController().signal,
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow aborts a hanging request on timeout", async () => {
  const result = await fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    deps(hangingFetch()),
    new AbortController().signal,
    5,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow fails soft on an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    // The daemon-side request is refused because its signal is already
    // aborted before it starts; the fake models that with a rejection.
    deps(() => Promise.reject(new Error("aborted"))),
    controller.signal,
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow aborts mid-flight from the caller's signal", async () => {
  const controller = new AbortController();
  const promise = fetchShow(
    "m",
    DEFAULT_DAEMON_BASE_URL,
    deps(hangingFetch()),
    controller.signal,
    1000,
  );
  controller.abort();
  assert.deepEqual(await promise, { ok: false });
});

test("getContextLength", async (t) => {
  await t.test("finds the <arch>.context_length key", () => {
    assert.equal(getContextLength({ "glm_dsa_moe.context_length": 1048576 }), 1048576);
  });
  await t.test("returns undefined with no matching key", () => {
    assert.equal(getContextLength({ other: 1 }), undefined);
  });
  await t.test("ignores a matching key with a non-number value", () => {
    assert.equal(getContextLength({ "x.context_length": "4096" }), undefined);
  });
});
