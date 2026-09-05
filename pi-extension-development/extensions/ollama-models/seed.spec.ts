import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SEED_MODEL_IDS, SEED_MODELS } from "./seed.ts";

/** The locked compat block (plan Decision #10), adopted verbatim from upstream. */
const COMPAT = {
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

test("seed catalog covers exactly the four cloud ids", () => {
  assert.deepEqual(
    [...SEED_MODEL_IDS],
    ["glm-5.3:cloud", "deepseek-v4-pro:cloud", "gemma4:31b-cloud", "qwen3.5:cloud"],
  );
  assert.deepEqual(
    SEED_MODELS.map((m) => m.id),
    [...SEED_MODEL_IDS],
  );
});

test("seed catalog carries the verified context windows and inputs", () => {
  const byId = new Map(SEED_MODELS.map((m) => [m.id, m]));

  const glm = byId.get("glm-5.3:cloud");
  assert.ok(glm);
  assert.equal(glm.contextWindow, 1048576);
  assert.deepEqual(glm.input, ["text"]);

  const deepseek = byId.get("deepseek-v4-pro:cloud");
  assert.ok(deepseek);
  assert.equal(deepseek.contextWindow, 1048576);
  assert.deepEqual(deepseek.input, ["text"]);

  const gemma = byId.get("gemma4:31b-cloud");
  assert.ok(gemma);
  assert.equal(gemma.contextWindow, 262144);
  assert.deepEqual(gemma.input, ["text", "image"]);

  const qwen = byId.get("qwen3.5:cloud");
  assert.ok(qwen);
  assert.equal(qwen.contextWindow, 262144);
  assert.deepEqual(qwen.input, ["text", "image"]);
});

test("seed catalog carries the locked per-model values", () => {
  for (const model of SEED_MODELS) {
    assert.equal(model.name, model.id);
    assert.equal(model.reasoning, true);
    assert.equal(model.maxTokens, 32768);
    assert.deepEqual(model.thinkingLevelMap, { off: null, max: "max" });
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(model.compat, COMPAT);
  }
});
