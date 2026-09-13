/**
 * Project-relative path normalization and hand-rolled glob matching.
 *
 * Supported vocabulary: `**` as a whole segment matches zero or more
 * directories; `*` matches any run of non-slash chars, dots included;
 * `?` matches one non-slash char; `{a,b}` alternates. Every other char
 * matches literally. Windows-style separators are not converted.
 */

const REGEX_SPECIAL_CHARS = ".+^$()|[]\\{}";

const escapeRegexChar = (char: string): string =>
  REGEX_SPECIAL_CHARS.includes(char) ? `\\${char}` : char;

/** Normalize a tool path to a project-relative form for pattern matching. */
export const relativePath = (path: string, cwd: string): string => {
  const withoutDot = path.replace(/^\.\//, "");
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return withoutDot.startsWith(prefix) ? withoutDot.slice(prefix.length) : withoutDot;
};

/**
 * Index of the closing brace for the group opened at `open`, counting
 * nesting. Returns -1 when the group never closes, so unbalanced braces
 * fall back to literal matching.
 */
const findMatchingBrace = (segment: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < segment.length; index++) {
    const char = segment.charAt(index);
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/** One path segment to a regex piece, without the globstar case. */
const segmentToRegex = (segment: string): string => {
  const open = segment.indexOf("{");
  if (open === -1) return plainSegmentToRegex(segment);

  const close = findMatchingBrace(segment, open);
  if (close === -1) return plainSegmentToRegex(segment);

  const head = segment.slice(0, open);
  const tail = segment.slice(close + 1);
  const options = segment
    .slice(open + 1, close)
    .split(",")
    .map(segmentToRegex);
  return `${plainSegmentToRegex(head)}(?:${options.join("|")})${segmentToRegex(tail)}`;
};

/** Stars and question marks in a brace-free segment; everything else literal. */
const plainSegmentToRegex = (segment: string): string =>
  [...segment]
    .map((char) => {
      if (char === "*") return "[^/]*";
      if (char === "?") return "[^/]";
      return escapeRegexChar(char);
    })
    .join("");

/**
 * One glob pattern to an anchored regex. Slash boundaries keep stars
 * inside their segment; a globstar absorbs the slashes around it so it
 * can match zero directories without leaving a dangling separator.
 */
export const globToRegExp = (pattern: string): RegExp => {
  const segments = pattern.split("/");
  const pieces: string[] = [];
  let previousGlobstar = false;

  segments.forEach((segment, index) => {
    if (segment === "**" && index === 0) {
      pieces.push("(?:.*/)?");
      previousGlobstar = true;
      return;
    }
    if (segment === "**" && index === segments.length - 1) {
      pieces.push("(?:/.*)?");
      previousGlobstar = true;
      return;
    }
    if (segment === "**") {
      // Slash-prefixed, so zero directories still leave exactly one
      // separator: the one the next segment contributes. A slash-suffixed
      // form would demand a directory after the globstar and a dangling
      // slash for files directly under the prefix.
      pieces.push("(?:/[^/]+)*");
      previousGlobstar = false;
      return;
    }
    if (index > 0 && !previousGlobstar) pieces.push("/");
    pieces.push(segmentToRegex(segment));
    previousGlobstar = false;
  });

  return new RegExp(`^${pieces.join("")}$`);
};

/** True when the path matches any pattern. */
export const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(path));
