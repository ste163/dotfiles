import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defaultDeps } from "./deps.ts";

interface FakeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  writeFileSync(path: string, content: string): void;
}

const createFakeFs = (): FakeFs => ({
  existsSync: (path) => !path.includes("missing"),
  readFileSync: (path, encoding) => {
    if (path.includes("missing")) throw new Error("ENOENT");
    assert.equal(encoding, "utf8");
    return `content of ${path}`;
  },
  writeFileSync: (path) => {
    if (path.includes("missing")) throw new Error("ENOENT");
  },
});

test("defaultDeps.cwd returns the process working directory", () => {
  assert.equal(defaultDeps().cwd(), process.cwd());
});

test("default deps pass exists checks through to the fs", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.existsSync("/repo/a.md"), true);
  assert.equal(deps.existsSync("/repo/missing/a.md"), false);
});

test("default deps read files through the injected fs", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.readFileSync("/repo/a.md"), "content of /repo/a.md");
});

test("default deps return null when reads fail", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.readFileSync("/repo/missing/a.md"), null);
});

test("default deps return true after a write", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.writeFileSync("/repo/a.md", "x"), true);
});

test("default deps return false when writes fail", () => {
  const deps = defaultDeps(createFakeFs());

  assert.equal(deps.writeFileSync("/repo/missing/a.md", "x"), false);
});
