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

// A request that never resolves until its abort signal fires.
const hangingFetch =
  (): OllamaModelsDeps["fetch"] =>
  (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

test("fails soft on a non-ok status, a rejected fetch, malformed JSON, and timeout", async () => {
  const call = (fetch: OllamaModelsDeps["fetch"]) => fetchShow("m", BASE_URL, deps(fetch), 5);
  assert.deepEqual(await call(() => Promise.resolve(new Response("boom", { status: 500 }))), {
    ok: false,
  });
  assert.deepEqual(await call(() => Promise.reject(new Error("ECONNREFUSED"))), { ok: false });
  assert.deepEqual(await call(() => Promise.resolve(new Response("<html>", { status: 200 }))), {
    ok: false,
  });
  assert.deepEqual(await call(hangingFetch()), { ok: false });
});

test("returns parsed show data", async () => {
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
      return Promise.resolve(new Response(JSON.stringify(show), { status: 200 }));
    }),
    1000,
  );
  assert.deepEqual(result, { ok: true, data: show });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/show");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { model: "glm-5.3:cloud" });
});

test("getContextLength finds the context_length key or returns 0", () => {
  assert.equal(getContextLength({ "glm_dsa_moe.context_length": 1048576 }), 1048576);
  assert.equal(getContextLength({ other: 1 }), 0);
  assert.equal(getContextLength({ "x.context_length": "4096" }), 0);
});
