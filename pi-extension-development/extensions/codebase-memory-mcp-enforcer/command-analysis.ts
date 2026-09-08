/**
 * Shell command analysis: split a bash command into top-level segments and
 * judge each one for code search.
 *
 * Segments are the pieces between pipes (`|`), chains (`&&`, `||`), and
 * semicolons — quotes respected. Per segment:
 * - One simple allowlisted command (`ls`, `pwd`, `echo`, `readlink`,
 *   `stat`) passes, so those commands can mention rg/grep in their args.
 * - A grep-family segment with no file targets and no recursive flag is
 *   reading stdin — a pipe filter over command output, not code search —
 *   and passes. rg never gets this pass: with no targets it recurses.
 * - A grep-family segment over named docs/config files passes, including
 *   `git grep -- <docs paths>`. Redirection tokens (`2>/dev/null`, `>out.txt`)
 *   are stripped before this check, so they never break the exemption.
 *   A bare number directly after a flag is that flag's value (`-A 8`,
 *   `--max-count 5`) and is skipped, so it never masquerades as the
 *   pattern or a target.
 * - A grep-family segment whose targets all sit under `node_modules`
 *   passes — third-party code, not the repo's.
 * - `cat` with a glob passes when the glob is over a dotfile dir (`.husky`,
 *   `.github`, `.pi`, ...) or ends in a docs extension.
 * - Quoted text and `--grep`-style flags are masked before the patterns
 *   run, so `git commit -m "fix the grep hack"` and `git log --grep` never
 *   trip.
 * - Anything else matching a code-search pattern blocks.
 *
 * `outsideProjectTargets` and `fileTargets` are separate, best-effort
 * helpers for the block message: the first names absolute-path targets
 * outside the git root so the message can say MCP can only search indexed
 * repositories; the second resolves grep-family file targets to absolute
 * paths for the stale-index note. Neither changes the verdict.
 *
 * Accepted leaks: `node -e`, `sh -c`, `awk`, `sed`, and command
 * substitution inside double quotes can hide file reads, and a numeric
 * pattern after a boolean flag (`grep -n 42 src/`) is mistaken for a flag
 * value. This extension is a speed bump against reflexive grep/rg/find,
 * not a sandbox.
 */

import { join } from "node:path";

const fileExtension = (token: string): string => {
  const dot = token.lastIndexOf(".");
  return dot === -1 ? "" : token.slice(dot);
};

/** A length-preserving mask: quoted spans become spaces, so separators and patterns never match inside quotes. */
const maskQuoted = (command: string): string =>
  command.replace(/'[^']*'|"[^"]*"/g, (quoted) => " ".repeat(quoted.length));

/** Mask quoted spans and `--grep`-style flags; the pattern list runs on this. */
const maskForMatching = (segment: string): string =>
  maskQuoted(segment).replace(/--\S*grep\S*/g, (flag) => " ".repeat(flag.length));

/** Collapse each quoted span into one token that keeps the target's file extension. */
const collapseQuoted = (segment: string): string =>
  segment.replace(/'[^']*'|"[^"]*"/g, (quoted) => "QUOTED" + fileExtension(quoted.slice(1, -1)));

// Redirection tokens: `2>/dev/null` (inline file), `2>&1` (fd), `> out.txt`
// (bare operator with a separate target). Inline forms are self-contained;
// bare operators consume the next token as their target.
const REDIRECT_TOKEN = /^(&|\d*)[<>]{1,2}\S*$/;
const BARE_REDIRECT_OP = /^(&|\d*)[<>]{1,2}$/;

const stripRedirections = (tokens: readonly string[]): readonly string[] => {
  const walk = (rest: readonly string[], skipNext: boolean): readonly string[] => {
    const token = rest[0];
    if (token === undefined) return [];
    if (skipNext) return walk(rest.slice(1), false);
    if (REDIRECT_TOKEN.test(token)) return walk(rest.slice(1), BARE_REDIRECT_OP.test(token));
    return [token, ...walk(rest.slice(1), false)];
  };
  return walk(tokens, false);
};

const collapsedTokens = (segment: string): readonly string[] =>
  stripRedirections(collapseQuoted(segment).trim().split(/\s+/));

const isBareNumber = (token: string): boolean => /^\d+$/.test(token);

/**
 * Positional args with flags removed. A bare number directly after a flag
 * is that flag's value (`-A 8`, `--max-count 5`), so it is removed too and
 * never masquerades as the pattern or a target.
 */
export const positionalArgs = (tokens: readonly string[]): readonly string[] => {
  const walk = (rest: readonly string[], previousWasFlag: boolean): readonly string[] => {
    const token = rest[0];
    if (token === undefined) return [];
    const isFlag = token.startsWith("-");
    const isFlagValue = previousWasFlag && isBareNumber(token);
    const tail = walk(rest.slice(1), isFlag);
    return isFlag || isFlagValue ? tail : [token, ...tail];
  };
  return walk(tokens, false);
};

const leadingWord = (text: string): string => text.trim().split(/\s+/)[0] as string;

// Patterns that indicate code search (not general shell use), run on the
// masked segment. Not exhaustive by design — see the accepted leaks in the
// header comment.
const CODE_SEARCH_PATTERNS: RegExp[] = [
  // grep / rg used for searching file contents
  /\bgrep\b/,
  /\brg\b/,
  // find used for locating files by name/type
  /\bfind\b.*-name\b/,
  /\bfind\b.*-type\b/,
  // cat with a glob (reading unknown files)
  /\bcat\s+.*\*/,
  // ack/ag (alternative grep tools)
  /\back\b/,
  /\bag\b/,
];

// Operators that disqualify a segment from the exemptions: substitution and
// process substitution hide commands the pattern list never sees, a bare
// `&` backgrounds a second command, and a newline chains one implicitly.
const DISQUALIFIERS: readonly string[] = ["$(", "`", "<(", ">(", "&", "\n"];

// Leading commands that always pass, before any block pattern runs.
const ALLOWED_COMMANDS: readonly string[] = ["ls", "pwd", "echo", "readlink", "stat"];

/** Split on top-level pipes, chains, and semicolons; operators inside quotes never split. */
export const splitSegments = (command: string): readonly string[] => {
  const mask = maskQuoted(command);
  const cuts = [...mask.matchAll(/\|\||&&|\||;/g)].map((match) => {
    const start = match.index as number;
    const separator = match[0] as string;
    return [start, start + separator.length] as const;
  });
  return segmentsBetween(command, cuts, 0);
};

/** The text between the separators, trimmed; recursion replaces index arithmetic. */
const segmentsBetween = (
  command: string,
  cuts: readonly (readonly [number, number])[],
  offset: number,
): readonly string[] => {
  const cut = cuts[0];
  if (!cut) {
    const last = command.slice(offset).trim();
    return last.length === 0 ? [] : [last];
  }
  const head = command.slice(offset, cut[0]).trim();
  const tail = segmentsBetween(command, cuts.slice(1), cut[1]);
  return head.length === 0 ? tail : [head, ...tail];
};

// Docs/config file extensions: grep-family over named files with these
// extensions is not code search. This list is the only knob in the exemption
// and feeds the exemptions note in messages.ts, so the note stays in sync.
export const DOCS_EXTENSIONS: readonly string[] = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".conf",
  ".ini",
];

// Leading words that make a segment a search-family member; `git grep` gets
// the docs exemption like the rest of the family.
const SEARCH_FAMILY_LEADERS: readonly (readonly string[])[] = [
  ["grep"],
  ["rg"],
  ["ack"],
  ["ag"],
  ["git", "grep"],
];

/** The tokens after the family leader, or null when the segment is not family. */
export const searchFamilyTail = (tokens: readonly string[]): readonly string[] | null =>
  SEARCH_FAMILY_LEADERS.reduce<readonly string[] | null>(
    (tail, leader) =>
      tail ??
      (leader.every((word, index) => tokens[index] === word) ? tokens.slice(leader.length) : null),
    null,
  );

const isDocsOnlySearch = (segment: string): boolean => {
  const tokens = collapsedTokens(segment);
  if (DISQUALIFIERS.some((disqualifier) => tokens.join(" ").includes(disqualifier))) return false;
  const tail = searchFamilyTail(tokens);
  if (!tail) return false;
  const args = positionalArgs(tail);
  if (args.length < 2) return false; // a pattern alone, or no named targets
  return args.slice(1).every((target) => DOCS_EXTENSIONS.includes(fileExtension(target)));
};

/** True when every target path contains a node_modules segment. */
const isNodeModulesSearch = (segment: string): boolean => {
  const tokens = collapsedTokens(segment);
  if (DISQUALIFIERS.some((disqualifier) => tokens.join(" ").includes(disqualifier))) return false;
  const tail = searchFamilyTail(tokens);
  if (!tail) return false;
  const args = positionalArgs(tail);
  if (args.length < 2) return false; // a pattern alone, or no named targets
  return args.slice(1).every((target) => target.split("/").includes("node_modules"));
};

// grep-family tools read stdin when given no file targets; rg is excluded
// because with no targets it recurses through the tree instead.
const STDIN_FILTER_FAMILY: readonly string[] = ["grep", "ack", "ag"];

const isRecursiveFlag = (token: string): boolean =>
  token === "--recursive" || (/^-[a-zA-Z]/.test(token) && /[rR]/.test(token.slice(1)));

const isStdinFilter = (segment: string): boolean => {
  const tokens = collapsedTokens(segment);
  if (DISQUALIFIERS.some((disqualifier) => tokens.join(" ").includes(disqualifier))) return false;
  if (!STDIN_FILTER_FAMILY.includes(leadingWord(segment))) return false;
  const args = positionalArgs(tokens.slice(1));
  const targets = args.slice(1);
  return targets.length === 0 && !tokens.some(isRecursiveFlag);
};

const isAllowlistedSegment = (segment: string): boolean =>
  !DISQUALIFIERS.some((disqualifier) => maskQuoted(segment).includes(disqualifier)) &&
  ALLOWED_COMMANDS.includes(leadingWord(segment));

/** True when any path segment is a dotfile dir (`.husky`, `.github`, `.pi`, ...), not `..`. */
const isDotDirPath = (dirPart: string): boolean => {
  const normalized = dirPart.replace(/^\.\//, "");
  return normalized
    .split("/")
    .filter(Boolean)
    .some((segment) => segment.startsWith(".") && !segment.startsWith(".."));
};

/** True when a cat segment's globs all point at dotfile dirs or docs-extension files. */
const isCatDotfileGlob = (segment: string): boolean => {
  const tokens = collapsedTokens(segment);
  if (DISQUALIFIERS.some((disqualifier) => tokens.join(" ").includes(disqualifier))) return false;
  if (tokens[0] !== "cat") return false;
  const globs = tokens.slice(1).filter((token) => !token.startsWith("-") && /[*?[]/.test(token));
  if (globs.length === 0) return false;
  return globs.every((glob) => {
    const slash = glob.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : glob.slice(0, slash + 1);
    const base = slash === -1 ? glob : glob.slice(slash + 1);
    return isDotDirPath(dirPart) || DOCS_EXTENSIONS.includes(fileExtension(base));
  });
};

/** True when the segment is code search and should be blocked. */
export const isCodeSearchSegment = (segment: string): boolean => {
  if (isAllowlistedSegment(segment)) return false;
  if (isCatDotfileGlob(segment)) return false;
  if (!CODE_SEARCH_PATTERNS.some((pattern) => pattern.test(maskForMatching(segment)))) return false;
  if (isDocsOnlySearch(segment)) return false;
  if (isNodeModulesSearch(segment)) return false;
  if (isStdinFilter(segment)) return false;
  return true;
};

/**
 * Absolute-path targets in the segment that sit outside the git root.
 * Best-effort guidance for the block message, not a verdict: quoted paths
 * with spaces and substitution-hidden paths are missed. `~` expands via
 * homeDir. For grep-family segments the first non-flag arg is the pattern
 * and is skipped.
 */
export const outsideProjectTargets = (
  segment: string,
  gitRoot: string,
  homeDir: string,
): readonly string[] => {
  if (
    DISQUALIFIERS.some((disqualifier) => collapsedTokens(segment).join(" ").includes(disqualifier))
  ) {
    return [];
  }
  const tokens = stripRedirections(
    segment
      .trim()
      .split(/\s+/)
      .map((token) => (token.startsWith("~/") ? homeDir + token.slice(1) : token)),
  );
  const tail = searchFamilyTail(positionalArgs(tokens));
  const targets = tail ? tail.slice(1) : positionalArgs(tokens);
  return targets.filter(
    (token) => token.startsWith("/") && token !== gitRoot && !token.startsWith(gitRoot + "/"),
  );
};

/**
 * Absolute paths of the file targets in a grep-family segment, resolved
 * against the cwd with trailing slashes stripped, so `src/` stats as
 * `src`. Best-effort guidance for the stale-index note, not a verdict:
 * quoted paths with spaces and substitution-hidden paths are missed.
 * `~` expands via homeDir.
 */
export const fileTargets = (segment: string, cwd: string, homeDir: string): readonly string[] => {
  if (
    DISQUALIFIERS.some((disqualifier) => collapsedTokens(segment).join(" ").includes(disqualifier))
  ) {
    return [];
  }
  const tokens = stripRedirections(
    segment
      .trim()
      .split(/\s+/)
      .map((token) => (token.startsWith("~/") ? homeDir + token.slice(1) : token)),
  );
  const tail = searchFamilyTail(positionalArgs(tokens));
  if (!tail) return [];
  return tail
    .slice(1)
    .map((target) => (target.startsWith("/") ? target : join(cwd, target)).replace(/\/+$/, ""));
};
