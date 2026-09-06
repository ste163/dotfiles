/**
 * codebase-memory-mcp-enforcer — blocks bash code search in git repos and
 * redirects the agent to codebase-memory-mcp.
 *
 * The system-prompt rule tells the agent to use codebase-memory-mcp instead
 * of grep/bash for code search. This extension enforces that rule by
 * intercepting bash tool calls and judging each top-level segment of the
 * command on its own.
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
 * - Anything else matching a code-search pattern blocks. The block message
 *   rewrites the query as a real MCP call whenever the state is readable:
 *   pi registers the server in ~/.pi/agent/mcp.json, and the server stores
 *   one SQLite db per indexed project under ~/.cache/codebase-memory-mcp/,
 *   named by dashing the repo root. Registered and indexed → "Try instead:"
 *   with the extracted pattern and the real project name. Registered only →
 *   index first. Neither → the full ladder. A naming mismatch degrades to
 *   the index-first path, never to a wrong "ready" answer.
 *
 * Accepted leaks: `node -e`, `sh -c`, `awk`, `sed`, and command
 * substitution inside double quotes can hide file reads. This extension is
 * a speed bump against reflexive grep/rg/find, not a sandbox.
 *
 * The extension tracks no runtime state; everything is derived from the
 * filesystem at block time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Filesystem access the extension needs (the PlanModeDeps pattern). */
export interface CodebaseMemoryMcpEnforcerDeps {
  existsSync(path: string): boolean;
  /** Only called for paths existsSync accepted; keeps the real dep throw-free. */
  readFile(path: string): string;
  cwd(): string;
  homeDir(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: CodebaseMemoryMcpEnforcerDeps = {
  existsSync,
  readFile: (path) => readFileSync(path, "utf8"),
  cwd: () => process.cwd(),
  homeDir: () => homedir(),
};

/** Walk up from `dir` looking for a `.git` directory — `dir` plus up to 16 parents, 17 directories at most. */
const findGitRoot = (dir: string, deps: CodebaseMemoryMcpEnforcerDeps): string | null => {
  const walk = (current: string, levelsLeft: number): string | null => {
    if (deps.existsSync(join(current, ".git"))) return current;
    if (levelsLeft === 0) return null;
    const parent = join(current, "..");
    if (parent === current) return null;
    return walk(parent, levelsLeft - 1);
  };
  return walk(dir, 16);
};

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
const splitSegments = (command: string): readonly string[] => {
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
const searchFamilyTail = (tokens: readonly string[]): readonly string[] | null =>
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

const isCodeSearchSegment = (segment: string): boolean => {
  if (isAllowlistedSegment(segment)) return false;
  if (!CODE_SEARCH_PATTERNS.some((pattern) => pattern.test(maskForMatching(segment)))) return false;
  if (isDocsOnlySearch(segment)) return false;
  if (isStdinFilter(segment)) return false;
  return true;
};

// The server names projects by dashing the repo root, so the project name
// and its db file are derivable without touching the server. A naming
// mismatch just yields "not indexed" — the safe fallback.
const projectNameFor = (gitRoot: string): string => gitRoot.split("/").filter(Boolean).join("-");

const mcpConfigPath = (homeDir: string): string => join(homeDir, ".pi/agent/mcp.json");

const projectDbPath = (homeDir: string, gitRoot: string): string =>
  join(homeDir, ".cache/codebase-memory-mcp", projectNameFor(gitRoot) + ".db");

const parseJson = (raw: string): unknown | null => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** mcp.json registers the server; its presence is the cheapest connected signal. */
const isServerRegistered = (parsed: unknown): boolean => {
  if (typeof parsed !== "object" || parsed === null) return false;
  const servers = (parsed as Record<string, unknown>)["mcpServers"];
  if (typeof servers !== "object" || servers === null) return false;
  return "codebase-memory-mcp" in servers;
};

/** What the filesystem says about the MCP server for this repo. */
export interface McpState {
  registered: boolean;
  indexed: boolean;
}

const mcpState = (gitRoot: string, deps: CodebaseMemoryMcpEnforcerDeps): McpState => {
  const configPath = mcpConfigPath(deps.homeDir());
  const registered =
    deps.existsSync(configPath) && isServerRegistered(parseJson(deps.readFile(configPath)));
  return { registered, indexed: deps.existsSync(projectDbPath(deps.homeDir(), gitRoot)) };
};

/** Strip one layer of matching quotes; an unbalanced opener means the pattern had spaces, so fall back. */
const quotable = (token: string): string => {
  const opener = token[0];
  if (opener !== "'" && opener !== '"') return token;
  return token.length > 1 && token[token.length - 1] === opener ? token.slice(1, -1) : "...";
};

/** The best-effort search pattern from a blocked segment, for the rewrite line. */
const searchPattern = (segment: string): string => {
  const tokens = segment.trim().split(/\s+/);
  const tail = searchFamilyTail(tokens);
  if (tail) {
    const pattern = tail.find((token) => !token.startsWith("-"));
    return pattern === undefined ? "..." : quotable(pattern);
  }
  const nameFlagIndex = tokens.findIndex((token) => token === "-name" || token === "-iname");
  const name = nameFlagIndex === -1 ? undefined : tokens[nameFlagIndex + 1];
  return name === undefined ? "..." : quotable(name);
};

const searchCallLine = (project: string, pattern: string): string =>
  'mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "' +
  pattern +
  '", project: "' +
  project +
  '", mode: "files" } })';

const indexCallLine = (gitRoot: string): string =>
  'mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "' +
  gitRoot +
  '", mode: "fast" } })';

const blockHeader = (violations: readonly string[]): string =>
  "MCP FIRST — code search blocked: " + violations.map((segment) => "`" + segment + "`").join(", ");

const EXEMPTIONS =
  "Legal without the server: pipe filters over command output (e.g. `npm test | grep fail`) " +
  "and grep-family over named docs/config files.";

const UNREACHABLE = "Inform the user and stop this line of work.";

/** The block message: a ready-made rewrite when the state is readable, the ladder when it is not. */
const blockMessage = (gitRoot: string, violations: readonly string[], state: McpState): string => {
  const project = projectNameFor(gitRoot);
  const header = blockHeader(violations);
  if (state.registered && state.indexed) {
    const rewrites = violations.map((segment) => searchCallLine(project, searchPattern(segment)));
    return (
      header +
      "\n\nTry instead:\n" +
      rewrites.join("\n") +
      "\n\nIf those fail, the server is unreachable. " +
      UNREACHABLE +
      "\n\n" +
      EXEMPTIONS
    );
  }
  if (state.registered) {
    const rewrites = violations.map((segment) => searchCallLine(project, searchPattern(segment)));
    return (
      header +
      "\n\nIndex the repo, then search:\n" +
      indexCallLine(gitRoot) +
      "\n" +
      rewrites.join("\n") +
      "\n\nIf those fail, the server is unreachable. " +
      UNREACHABLE +
      "\n\n" +
      EXEMPTIONS
    );
  }
  const first = violations[0] as string;
  return (
    header +
    "\n\n" +
    '1. Not connected?    mcp({ connect: "codebase-memory-mcp" })\n' +
    '2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "' +
    gitRoot +
    '", mode: "fast" } })\n' +
    '3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })\n' +
    "4. Search:           " +
    searchCallLine("<name>", searchPattern(first)) +
    "\n" +
    "5. Still failing?    The server is unreachable. " +
    UNREACHABLE +
    "\n\n" +
    EXEMPTIONS
  );
};

/** The pre-turn reminder: report the state, then the decision rule. */
const reminderMessage = (gitRoot: string, state: McpState): string => {
  const project = projectNameFor(gitRoot);
  const rule =
    " Know the path → read. Filtering output or grepping named docs/config files → bash grep is legal.";
  if (state.registered && state.indexed) {
    return (
      'MCP READY — project "' +
      project +
      "\" is indexed. Don't know the path → " +
      searchCallLine(project, "...") +
      "." +
      rule
    );
  }
  if (state.registered) {
    return (
      "MCP COLD — the server is connected but this repo is not indexed; code grep will block. Index first: " +
      indexCallLine(gitRoot) +
      "." +
      rule
    );
  }
  return (
    "MCP FIRST — codebase-memory-mcp is not registered; code grep will block. Connect: " +
    'mcp({ connect: "codebase-memory-mcp" }).' +
    rule
  );
};

export const createCodebaseMemoryMcpEnforcerExtension = (
  pi: ExtensionAPI,
  deps: CodebaseMemoryMcpEnforcerDeps = defaultDeps,
): void => {
  // Hard-intercept bash code search, judging each top-level segment.
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const violations = splitSegments(event.input.command).filter(isCodeSearchSegment);
    if (violations.length === 0) return;

    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, allow

    return { block: true, reason: blockMessage(gitRoot, violations, mcpState(gitRoot, deps)) };
  });

  // Pre-turn reminder (fights context decay)
  pi.on("before_agent_start", (event) => {
    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, no reminder needed

    // Prepend, not append — keeps it at top of context
    return {
      systemPrompt: reminderMessage(gitRoot, mcpState(gitRoot, deps)) + "\n\n" + event.systemPrompt,
    };
  });
};

export default createCodebaseMemoryMcpEnforcerExtension;
