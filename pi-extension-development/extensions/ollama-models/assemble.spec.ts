import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { assembleModel, assembleModels } from "./assemble.ts";
import type { ShowResponse } from "./ollama-api.ts";

const SEED_COMPAT = { supportsStore: false };

const seed = (id: string): ProviderModelConfig => ({
  id,
  name: id,
  reasoning: true,
  thinkingLevelMap: { off: null, max: "max" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32768,
  compat: SEED_COMPAT,
});

const show = (
  contextLength: number | undefined,
  capabilities: string[] | undefined,
): ShowResponse => ({
  model_info: contextLength === undefined ? {} : { "arch.context_length": contextLength },
  ...(capabilities !== undefined ? { capabilities } : {}),
});

test("assembleModel maps thinking to reasoning and vision to image input", () => {
  const result = assembleModel(
    seed("m"),
    show(262144, ["completion", "thinking", "tools", "vision"]),
  );
  assert.ok(result);
  assert.equal(result.reasoning, true);
  assert.deepEqual(result.input, ["text", "image"]);
  assert.equal(result.contextWindow, 262144);
  // Static seed fields pass through untouched.
  assert.equal(result.maxTokens, 32768);
  assert.deepEqual(result.thinkingLevelMap, { off: null, max: "max" });
  assert.deepEqual(result.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.compat, SEED_COMPAT);
});

test("assembleModel maps a no-thinking, no-vision model and keeps the seed context window", () => {
  const result = assembleModel(seed("m"), show(undefined, ["completion", "tools"]));
  assert.ok(result);
  assert.equal(result.reasoning, false);
  assert.deepEqual(result.input, ["text"]);
  assert.equal(result.contextWindow, 128000);
});

test("assembleModel drops models without the tools capability", () => {
  assert.equal(assembleModel(seed("m"), show(1, ["completion", "thinking"])), undefined);
  assert.equal(assembleModel(seed("m"), show(1, undefined)), undefined);
});

test("assembleModels keeps fallback entries, replaces live ones, drops tools-less ones", () => {
  const a = seed("a");
  const b = seed("b");
  const c = seed("c");
  const shows = new Map<string, ShowResponse>([
    ["b", show(999, ["completion", "thinking", "tools"])],
    ["c", show(999, ["completion"])],
  ]);
  const merged = assembleModels([a, b, c], shows);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], a); // no show data -> the same fallback entry kept
  const assembled = merged[1];
  assert.ok(assembled);
  assert.equal(assembled.id, "b");
  assert.equal(assembled.contextWindow, 999);
});

test("assembleModels returns [] when every fetched model lacks tools", () => {
  const a = seed("a");
  const shows = new Map([["a", show(999, ["completion"])]]);
  assert.deepEqual(assembleModels([a], shows), []);
});
