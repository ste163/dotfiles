import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CONFIG, validateConfig } from "./config.ts";

test("rejects a non-object root", () => {
  for (const bad of [42, null, ["x"], "x"]) {
    assert.throws(() => validateConfig(bad), /config\.json: expected a JSON object/);
  }
});

test("rejects unknown fields", () => {
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: ["a"], modles: ["x"] }),
    /unknown field "modles" \(allowed: baseUrl, models\)/,
  );
});

test("rejects a bad baseUrl", () => {
  assert.throws(() => validateConfig({ models: ["a"] }), /baseUrl must be a string/);
  assert.throws(() => validateConfig({ baseUrl: 42, models: ["a"] }), /baseUrl must be a string/);
  assert.throws(() => validateConfig({ baseUrl: "not a url", models: ["a"] }), /not a valid URL/);
  assert.throws(
    () => validateConfig({ baseUrl: "ftp://x/", models: ["a"] }),
    /must be an http or https URL/,
  );
  assert.throws(
    () => validateConfig({ baseUrl: "http://127.0.0.1:11434/v1", models: ["a"] }),
    /must be the daemon root without a path/,
  );
});

test("rejects a bad models list", () => {
  assert.throws(() => validateConfig({ baseUrl: "http://x/" }), /models must be an array/);
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: "a" }),
    /models must be an array/,
  );
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: [] }),
    /models must not be empty/,
  );
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: ["a", 42] }),
    /models\[1\] must be a non-empty string/,
  );
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: ["a", ""] }),
    /models\[1\] must be a non-empty string/,
  );
  assert.throws(
    () => validateConfig({ baseUrl: "http://x/", models: ["a", "a"] }),
    /duplicate model id "a"/,
  );
});

test("returns the shape it was given", () => {
  assert.deepEqual(
    validateConfig({ baseUrl: "http://127.0.0.1:11434", models: ["a:cloud", "b:cloud"] }),
    {
      baseUrl: "http://127.0.0.1:11434",
      models: ["a:cloud", "b:cloud"],
    },
  );
});

test("the shipped config.json validates", () => {
  assert.equal(CONFIG.baseUrl, "http://127.0.0.1:11434");
  // Invariants only, not the exact list: adding or removing a model is a
  // config.json-only change and must never break this suite.
  assert.ok(CONFIG.models.length > 0);
  assert.equal(
    CONFIG.models.filter((id, index, all) => all.indexOf(id) === index).length,
    CONFIG.models.length,
  );
});
