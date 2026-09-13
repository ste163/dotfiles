import { join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { FilePathRulesDeps } from "./deps.ts";

/** One loaded rule: the doc body plus the glob patterns that trigger it. */
export interface Rule {
  /** File name inside the rules directory, for reminder headers. */
  file: string;
  patterns: readonly string[];
  /** Doc body with the front matter stripped. */
  body: string;
}

export interface LoadRulesResult {
  rules: readonly Rule[];
  errors: readonly string[];
}

/** Directory inside the project config dir that holds rule docs. */
export const RULES_DIR_NAME = "rules";

interface RuleLoad {
  rule: Rule | null;
  error: string | null;
}

const rulePath = (fileName: string): string => `${CONFIG_DIR_NAME}/${RULES_DIR_NAME}/${fileName}`;

/**
 * Patterns from a `paths:` value. An empty list means the field exists
 * but is invalid, so loaders can report loudly instead of skipping.
 */
const patternsOf = (paths: unknown): string[] => {
  if (typeof paths === "string") return paths.trim() === "" ? [] : [paths.trim()];
  if (Array.isArray(paths) && paths.every((entry) => typeof entry === "string")) {
    const trimmed = paths.map((entry) => entry.trim());
    return trimmed.some((entry) => entry === "") ? [] : trimmed;
  }
  return [];
};

const parseRaw = (raw: string): { frontmatter: Record<string, unknown>; body: string } | null => {
  try {
    const parsed = parseFrontmatter(raw);
    return { frontmatter: parsed.frontmatter, body: parsed.body };
  } catch {
    return null;
  }
};

const loadRule = (fileName: string, raw: string): RuleLoad => {
  const parsed = parseRaw(raw);
  if (parsed === null) return { rule: null, error: `${rulePath(fileName)}: invalid front matter` };

  // A file without a paths field is a plain doc, not a rule: skip silently.
  if (!("paths" in parsed.frontmatter)) return { rule: null, error: null };

  const patterns = patternsOf(parsed.frontmatter["paths"]);
  if (patterns.length === 0)
    return {
      rule: null,
      error: `${rulePath(fileName)}: "paths" must be a string or a non-empty list of strings`,
    };

  return { rule: { file: fileName, patterns, body: parsed.body }, error: null };
};

/**
 * Loads every rule from `<cwd>/.pi/rules/*.md`. Files sort by name so
 * multi-rule matches fire in a deterministic order. Invalid files become
 * errors for the caller to notify.
 */
export const loadRules = (deps: FilePathRulesDeps, cwd: string): LoadRulesResult => {
  const dir = join(cwd, CONFIG_DIR_NAME, RULES_DIR_NAME);
  const names = deps.readdir(dir);
  if (names === null) return { rules: [], errors: [] };

  const loaded = names
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .map((name) => {
      const raw = deps.readFile(join(dir, name));
      return raw === null
        ? { rule: null, error: `${rulePath(name)}: unreadable` }
        : loadRule(name, raw);
    });

  return {
    rules: loaded.flatMap((entry) => (entry.rule ? [entry.rule] : [])),
    errors: loaded.flatMap((entry) => (entry.error ? [entry.error] : [])),
  };
};
