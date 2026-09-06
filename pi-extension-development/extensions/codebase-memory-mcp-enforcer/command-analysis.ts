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
 *   `git grep -- <docs paths>`.
 * - Quoted text and `--grep`-style flags are masked before the patterns
 *   run, so `git commit -m "fix the grep hack"` and `git log --grep` never
 *   trip.
 * - Anything else matching a code-search pattern blocks.
 *
 * Accepted leaks: `node -e`, `sh -c`, `awk`, `sed`, and command
 * substitution inside double quotes can hide file reads. This extension is
 * a speed bump against reflexive grep/rg/find, not a sandbox.
 */

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
// extensions is not code search. This list is the only knob in the exemption.
const DOCS_EXTENSIONS: readonly string[] = [
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
  const collapsed = collapseQuoted(segment);
  if (DISQUALIFIERS.some((disqualifier) => collapsed.includes(disqualifier))) return false;
  const tokens = collapsed.trim().split(/\s+/);
  const tail = searchFamilyTail(tokens);
  if (!tail) return false;
  const args = tail.filter((token) => !token.startsWith("-"));
  if (args.length < 2) return false; // a pattern alone, or no named targets
  return args.slice(1).every((target) => DOCS_EXTENSIONS.includes(fileExtension(target)));
};

// grep-family tools read stdin when given no file targets; rg is excluded
// because with no targets it recurses through the tree instead.
const STDIN_FILTER_FAMILY: readonly string[] = ["grep", "ack", "ag"];

const isRecursiveFlag = (token: string): boolean =>
  token === "--recursive" || (/^-[a-zA-Z]/.test(token) && /[rR]/.test(token.slice(1)));

const isStdinFilter = (segment: string): boolean => {
  const collapsed = collapseQuoted(segment);
  if (DISQUALIFIERS.some((disqualifier) => collapsed.includes(disqualifier))) return false;
  const tokens = collapsed.trim().split(/\s+/);
  if (!STDIN_FILTER_FAMILY.includes(leadingWord(segment))) return false;
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  const targets = args.slice(1);
  return targets.length === 0 && !tokens.some(isRecursiveFlag);
};

const isAllowlistedSegment = (segment: string): boolean =>
  !DISQUALIFIERS.some((disqualifier) => maskQuoted(segment).includes(disqualifier)) &&
  ALLOWED_COMMANDS.includes(leadingWord(segment));

/** True when the segment is code search and should be blocked. */
export const isCodeSearchSegment = (segment: string): boolean => {
  if (isAllowlistedSegment(segment)) return false;
  if (!CODE_SEARCH_PATTERNS.some((pattern) => pattern.test(maskForMatching(segment)))) return false;
  if (isDocsOnlySearch(segment)) return false;
  if (isStdinFilter(segment)) return false;
  return true;
};
