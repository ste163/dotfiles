import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadRules } from "./config.ts";
import type { FilePathRulesDeps } from "./deps.ts";

const ruleDoc = (paths: string, body: string): string => `---\npaths: ${paths}\n---\n${body}`;

const createFakeDeps = (
  files: Record<string, string>,
  unreadable: string[] = [],
): FilePathRulesDeps => ({
  readFile: (path) => (unreadable.includes(path) ? null : (files[path] ?? null)),
  readdir: (path) => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = Object.keys(files)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes("/"));
    return names.length > 0 ? names : null;
  },
});

test("loadRules", async (t) => {
  await t.test("returns empty results when the rules directory is missing", () => {
    assert.deepEqual(loadRules(createFakeDeps({}), "/repo"), { rules: [], errors: [] });
  });

  await t.test("skips files without a paths field silently", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/readme.md": "# Just docs\n" });
    assert.deepEqual(loadRules(deps, "/repo"), { rules: [], errors: [] });
  });

  await t.test("ignores non-markdown files", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/notes.txt": ruleDoc("'x/**'", "body") });
    assert.deepEqual(loadRules(deps, "/repo"), { rules: [], errors: [] });
  });

  await t.test("reports an unreadable rule file", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/a.md": ruleDoc("'x/**'", "body") }, [
      "/repo/.pi/rules/a.md",
    ]);
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: [".pi/rules/a.md: unreadable"],
    });
  });

  await t.test("reports invalid front matter", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": "---\npaths: [unclosed\n---\nbody" });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: [".pi/rules/bad.md: invalid front matter"],
    });
  });

  await t.test("reports a missing paths value", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": "---\ntitle: only\n---\nbody" });
    assert.deepEqual(loadRules(deps, "/repo"), { rules: [], errors: [] });
  });

  await t.test("reports an empty string pattern", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": ruleDoc("''", "body") });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: ['.pi/rules/bad.md: "paths" must be a string or a non-empty list of strings'],
    });
  });

  await t.test("reports an empty list", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": ruleDoc("[]", "body") });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: ['.pi/rules/bad.md: "paths" must be a string or a non-empty list of strings'],
    });
  });

  await t.test("reports a list with non-string entries", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": ruleDoc("[1, 2]", "body") });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: ['.pi/rules/bad.md: "paths" must be a string or a non-empty list of strings'],
    });
  });

  await t.test("reports a list with an empty entry", () => {
    const deps = createFakeDeps({ "/repo/.pi/rules/bad.md": ruleDoc("['a/**', '']", "body") });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [],
      errors: ['.pi/rules/bad.md: "paths" must be a string or a non-empty list of strings'],
    });
  });

  await t.test("loads a rule with a single string pattern", () => {
    const deps = createFakeDeps({
      "/repo/.pi/rules/pages.md": ruleDoc("'src/pages/**'", "Load the app-domain skill."),
    });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [{ file: "pages.md", patterns: ["src/pages/**"], body: "Load the app-domain skill." }],
      errors: [],
    });
  });

  await t.test("loads a rule with a list of patterns", () => {
    const deps = createFakeDeps({
      "/repo/.pi/rules/agentic.md": ruleDoc(
        "['.agents/**/*.md', '.pi/**/*.md', 'AGENTS.md']",
        "Keep edits minimal.",
      ),
    });
    assert.deepEqual(loadRules(deps, "/repo"), {
      rules: [
        {
          file: "agentic.md",
          patterns: [".agents/**/*.md", ".pi/**/*.md", "AGENTS.md"],
          body: "Keep edits minimal.",
        },
      ],
      errors: [],
    });
  });

  await t.test("strips the front matter from the body", () => {
    const deps = createFakeDeps({
      "/repo/.pi/rules/pages.md": `---\npaths: 'src/pages/**'\n---\nLine one.\nLine two.`,
    });
    const result = loadRules(deps, "/repo");
    assert.equal(result.rules[0]?.body, "Line one.\nLine two.");
  });

  await t.test("sorts rule files by name", () => {
    const deps = createFakeDeps({
      "/repo/.pi/rules/z.md": ruleDoc("'z/**'", "Z."),
      "/repo/.pi/rules/a.md": ruleDoc("'a/**'", "A."),
    });
    const result = loadRules(deps, "/repo");
    assert.deepEqual(
      result.rules.map((rule) => rule.file),
      ["a.md", "z.md"],
    );
  });
});
