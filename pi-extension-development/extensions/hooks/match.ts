/** Quote a value for safe use as a single shell argument. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Normalize a tool path to a project-relative form for pattern matching. */
export const relativePath = (path: string, cwd: string): string => {
  const withoutDot = path.replace(/^\.\//, "");
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return withoutDot.startsWith(prefix) ? withoutDot.slice(prefix.length) : withoutDot;
};

/**
 * True when the path matches any pattern.
 * A pattern ending in `/**` matches by directory prefix; anything else matches exactly.
 */
export const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
    return path === pattern;
  });
