import { strict as assert } from "node:assert";
import { test } from "node:test";
import { globToRegExp, matchesAny, relativePath } from "./match.ts";

test("relativePath", async (t) => {
  await t.test("strips a leading ./", () => {
    assert.equal(relativePath("./src/a.ts", "/repo"), "src/a.ts");
  });

  await t.test("strips the cwd prefix from an absolute path", () => {
    assert.equal(relativePath("/repo/src/a.ts", "/repo"), "src/a.ts");
  });

  await t.test("keeps paths outside the cwd as-is", () => {
    assert.equal(relativePath("/other/a.ts", "/repo"), "/other/a.ts");
  });

  await t.test("keeps plain relative paths unchanged", () => {
    assert.equal(relativePath("src/a.ts", "/repo"), "src/a.ts");
  });

  await t.test("handles a cwd with a trailing slash", () => {
    assert.equal(relativePath("/repo/src/a.ts", "/repo/"), "src/a.ts");
  });
});

test("matchesAny", async (t) => {
  await t.test("fails when no pattern matches", () => {
    assert.equal(matchesAny("src/lib/a.ts", ["src/pages/**"]), false);
  });

  await t.test("matches a directory prefix pattern", () => {
    assert.equal(matchesAny("android/build.gradle", ["android/**"]), true);
    assert.equal(matchesAny("android/app/x.kt", ["android/**"]), true);
  });

  await t.test("matches a file at any depth", () => {
    assert.equal(matchesAny("a.spec.tsx", ["**/*.spec.tsx"]), true);
    assert.equal(matchesAny("src/pages/a.spec.tsx", ["**/*.spec.tsx"]), true);
    assert.equal(matchesAny("src/a.tsx", ["**/*.spec.tsx"]), false);
  });

  await t.test("matches a brace alternation", () => {
    assert.equal(matchesAny("src/a.ts", ["src/**/*.{ts,tsx}"]), true);
    assert.equal(matchesAny("src/x/a.tsx", ["src/**/*.{ts,tsx}"]), true);
    assert.equal(matchesAny("src/a.css", ["src/**/*.{ts,tsx}"]), false);
  });

  await t.test("matches zero directories under a middle globstar", () => {
    assert.equal(matchesAny("src/a.ts", ["src/**/*.ts"]), true);
    assert.equal(matchesAny("src/x/y/a.ts", ["src/**/*.ts"]), true);
  });

  await t.test("matches dot directories spelled literally", () => {
    assert.equal(matchesAny(".pi/rules/a.md", [".pi/**/*.md"]), true);
    assert.equal(matchesAny(".agents/skills/x.md", [".agents/**/*.md"]), true);
    assert.equal(matchesAny("pi/rules/a.md", [".pi/**/*.md"]), false);
  });

  await t.test("matches an exact file name pattern", () => {
    assert.equal(matchesAny("AGENTS.md", ["AGENTS.md"]), true);
    assert.equal(matchesAny("sub/AGENTS.md", ["AGENTS.md"]), false);
  });

  await t.test("a star never crosses a slash", () => {
    assert.equal(matchesAny("src/x/y.md", ["src/*.md"]), false);
    assert.equal(matchesAny("src/y.md", ["src/*.md"]), true);
  });

  await t.test("a question mark matches exactly one char", () => {
    assert.equal(matchesAny("a1.ts", ["a?.ts"]), true);
    assert.equal(matchesAny("a12.ts", ["a?.ts"]), false);
  });

  await t.test("matches multiple patterns", () => {
    assert.equal(matchesAny("AGENTS.md", [".agents/**/*.md", ".pi/**/*.md", "AGENTS.md"]), true);
    assert.equal(matchesAny("README.md", [".agents/**/*.md", ".pi/**/*.md", "AGENTS.md"]), false);
  });
});

test("globToRegExp", async (t) => {
  await t.test("escapes regex specials in literal segments", () => {
    assert.equal(globToRegExp("a+b").test("a+b"), true);
    assert.equal(globToRegExp("a+b").test("aab"), false);
    assert.equal(globToRegExp("a(b").test("a(b"), true);
    assert.equal(globToRegExp("a.b").test("a.b"), true);
    assert.equal(globToRegExp("a.b").test("axb"), false);
  });

  await t.test("keeps unbalanced braces literal", () => {
    assert.equal(globToRegExp("a{b").test("a{b"), true);
    assert.equal(globToRegExp("a{b").test("ab"), false);
  });

  await t.test("anchors the whole pattern", () => {
    assert.equal(globToRegExp("a").test("xax"), false);
  });
});
