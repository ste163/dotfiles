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
  const scan = (index: number, depth: number): number => {
    if (index >= segment.length) return -1;
    const char = segment.charAt(index);
    if (char === "{") return scan(index + 1, depth + 1);
    if (char === "}") return depth === 1 ? index : scan(index + 1, depth - 1);
    return scan(index + 1, depth);
  };
  return scan(open, 0);
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
  // A lone globstar covers the whole path, a bare file name included.
  if (pattern === "**" || pattern === "**/") return /^.*$/;

  const segments = pattern.split("/");
  // Only the segment right after a leading globstar skips its own slash,
  // because the globstar's optional directory part already ends in one.
  const pieces = segments.flatMap((segment, index) => {
    if (segment === "**" && index === 0) return ["(?:.*/)?"];
    if (segment === "**" && index === segments.length - 1) return ["(?:/.*)?"];
    if (segment === "**") return ["(?:/[^/]+)*"];
    const slash = index > 0 && !(segments[0] === "**" && index === 1) ? "/" : "";
    return [slash, segmentToRegex(segment)];
  });

  return new RegExp(`^${pieces.join("")}$`);
};

/** True when the path matches any pattern. */
export const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => globToRegExp(pattern).test(path));
