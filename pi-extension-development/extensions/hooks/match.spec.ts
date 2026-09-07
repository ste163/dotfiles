import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchesAny, relativePath, shellQuote } from "./match.ts";

test("shellQuote wraps a plain value in single quotes", () => {
  assert.equal(shellQuote("bun run build"), "'bun run build'");
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("echo 'hi'"), `'echo '\\''hi'\\'''`);
});

test("matchesAny matches a /** pattern by directory prefix", () => {
  assert.equal(matchesAny("src/pages/home/App.tsx", ["src/**"]), true);
});

test("matchesAny rejects a path outside the /** prefix", () => {
  assert.equal(matchesAny("scripts/verify-docs.ts", ["src/**"]), false);
});

test("matchesAny matches an exact pattern", () => {
  assert.equal(matchesAny("AGENTS.md", ["AGENTS.md"]), true);
});

test("matchesAny rejects a non-matching exact pattern", () => {
  assert.equal(matchesAny("README.md", ["AGENTS.md"]), false);
});

test("matchesAny returns false for an empty pattern list", () => {
  assert.equal(matchesAny("src/x.ts", []), false);
});

test("relativePath strips the cwd prefix from an absolute path", () => {
  assert.equal(relativePath("/virtual/repo/AGENTS.md", "/virtual/repo"), "AGENTS.md");
});

test("relativePath handles a cwd with a trailing slash", () => {
  assert.equal(relativePath("/virtual/repo/AGENTS.md", "/virtual/repo/"), "AGENTS.md");
});

test("relativePath leaves paths outside the cwd unchanged", () => {
  assert.equal(relativePath("/elsewhere/AGENTS.md", "/virtual/repo"), "/elsewhere/AGENTS.md");
});

test("relativePath strips a leading ./", () => {
  assert.equal(relativePath("./src/x.ts", "/virtual/repo"), "src/x.ts");
});

test("relativePath leaves a plain relative path unchanged", () => {
  assert.equal(relativePath("src/x.ts", "/virtual/repo"), "src/x.ts");
});
