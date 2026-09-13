import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultDeps } from "./deps.ts";

test("defaultDeps.cwd returns the process working directory", () => {
  assert.equal(defaultDeps.cwd(), process.cwd());
});
