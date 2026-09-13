import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultDeps } from "./deps.ts";

interface FakeFs {
  readFileSync(path: string, encoding: string): string;
  readdirSync(path: string): string[];
}

const createFakeFs = (): FakeFs => ({
  readFileSync: (path, encoding) => {
    if (path.includes("missing")) throw new Error("ENOENT");
    assert.equal(encoding, "utf8");
    return `content of ${path}`;
  },
  readdirSync: (path) => {
    if (path.includes("missing")) throw new Error("ENOENT");
    return ["a.md", "b.md"];
  },
});

test("default deps read files and directory listings through the injected fs", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.readFile("/repo/.pi/rules/a.md"), "content of /repo/.pi/rules/a.md");
  assert.deepEqual(deps.readdir("/repo/.pi/rules"), ["a.md", "b.md"]);
});

test("default deps return null when the injected fs throws", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.readFile("/repo/missing/a.md"), null);
  assert.equal(deps.readdir("/repo/missing"), null);
});
