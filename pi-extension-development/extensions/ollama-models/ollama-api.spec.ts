import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fetchShow,
  getContextLength,
  type OllamaModelsDeps,
  type ShowResponse,
} from "./ollama-api.ts";

const BASE_URL = "http://127.0.0.1:11434";

const deps = (fetch: OllamaModelsDeps["fetch"]): OllamaModelsDeps => ({ fetch });

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
    BASE_URL,
    deps((_url, init) => {
      calls.push({ url: _url, init });
      return Promise.resolve(jsonResponse(show));
    }),
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
    BASE_URL,
    deps(() => Promise.resolve(new Response("boom", { status: 500 }))),
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow fails soft when fetch rejects (daemon down)", async () => {
  const result = await fetchShow(
    "m",
    BASE_URL,
    deps(() => Promise.reject(new Error("ECONNREFUSED"))),
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow fails soft on a malformed JSON body", async () => {
  const result = await fetchShow(
    "m",
    BASE_URL,
    deps(() => Promise.resolve(new Response("<html>", { status: 200 }))),
    1000,
  );
  assert.deepEqual(result, { ok: false });
});

test("fetchShow aborts a hanging request on timeout", async () => {
  const result = await fetchShow("m", BASE_URL, deps(hangingFetch()), 5);
  assert.deepEqual(result, { ok: false });
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
