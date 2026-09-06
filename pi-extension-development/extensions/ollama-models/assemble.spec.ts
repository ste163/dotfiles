import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { assembleModel, assembleModels } from "./assemble.ts";
import type { ShowResponse } from "./ollama-api.ts";

/** The explicit compat block every assembled entry carries. */
const COMPAT: NonNullable<ProviderModelConfig["compat"]> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsStore: false,
  maxTokensField: "max_tokens",
  supportsUsageInStreaming: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  supportsStrictMode: false,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
  zaiToolStream: false,
};

const show = (
  contextLength: number | undefined,
  capabilities: string[] | undefined,
): ShowResponse => ({
  model_info: contextLength === undefined ? {} : { "arch.context_length": contextLength },
  ...(capabilities !== undefined ? { capabilities } : {}),
});

test("assembleModel builds a full entry from live data", () => {
  const entry = assembleModel(
    "m:cloud",
    show(262144, ["completion", "thinking", "tools", "vision"]),
  );
  assert.ok(entry);
  assert.equal(entry.id, "m:cloud");
  assert.equal(entry.name, "m:cloud");
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.thinkingLevelMap, { off: null, max: "max" });
  assert.deepEqual(entry.input, ["text", "image"]);
  assert.equal(entry.contextWindow, 262144);
  assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(entry.maxTokens, 32768);
  assert.deepEqual(entry.compat, COMPAT);
});

test("assembleModel omits the thinking map for a no-thinking, no-vision model", () => {
  const entry = assembleModel("m", show(8192, ["completion", "tools"]));
  assert.ok(entry);
  assert.equal(entry.reasoning, false);
  assert.deepEqual(entry.input, ["text"]);
  assert.ok(!("thinkingLevelMap" in entry));
});

test("assembleModel drops models the daemon cannot serve pi with", () => {
  // No tools capability — twice, including no capabilities at all.
  assert.equal(assembleModel("m", show(1024, ["completion", "thinking"])), undefined);
  assert.equal(assembleModel("m", show(1024, undefined)), undefined);
  // No usable context length.
  assert.equal(assembleModel("m", show(undefined, ["completion", "tools"])), undefined);
  assert.equal(assembleModel("m", show(0, ["completion", "tools"])), undefined);
  assert.equal(assembleModel("m", show(-1, ["completion", "tools"])), undefined);
});

test("assembleModels keeps only usable ids", () => {
  const shows = new Map<string, ShowResponse>([
    ["a", show(999, ["completion", "thinking", "tools"])],
    ["c", show(999, ["completion"])], // tools-less: dropped
  ]);
  const assembled = assembleModels(["a", "b", "c"], shows); // b never fetched: dropped
  assert.equal(assembled.length, 1);
  const entry = assembled[0];
  assert.ok(entry);
  assert.equal(entry.id, "a");
  assert.equal(entry.contextWindow, 999);
});

test("assembleModels returns [] when nothing is usable", () => {
  const shows = new Map([["a", show(999, ["completion"])]]);
  assert.deepEqual(assembleModels(["a"], shows), []);
});
