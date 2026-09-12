/**
 * The text the extension shows: the block message for a violating bash
 * call and the pre-turn reminder.
 *
 * The block message rewrites the query as a real MCP call whenever the
 * state is readable. Registered and indexed → "Try instead:" with the
 * extracted pattern and the real project name. Registered only → index
 * first. Neither → the full ladder. A naming mismatch degrades to the
 * index-first path, never to a wrong "ready" answer. When a blocked
 * segment names absolute targets outside the git root, the message adds a
 * note that MCP can only search indexed repositories. When a targeted
 * file is newer than the index db, the message adds a stale-index note
 * with a ready-made reindex call.
 */

import {
  DOCS_EXTENSIONS,
  outsideProjectTargets,
  positionalArgs,
  searchFamilyTail,
} from "./command-analysis.ts";
import { projectNameFor, type McpState } from "./mcp-state.ts";

/** Strip one layer of matching quotes; an unbalanced opener means the pattern had spaces, so fall back. */
const quotable = (token: string): string => {
  const opener = token[0];
  if (opener !== "'" && opener !== '"') return token;
  return token.length > 1 && token.at(-1) === opener ? token.slice(1, -1) : "...";
};

/** The best-effort search pattern from a blocked segment, for the rewrite line. */
const searchPattern = (segment: string): string => {
  const tokens = segment.trim().split(/\s+/);
  const tail = searchFamilyTail(tokens);
  if (tail) {
    const pattern = positionalArgs(tail)[0];
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
  "Legal without the server: pipe filters over command output (e.g. `npm test | grep fail`), " +
  "grep-family over named docs/config files (" +
  DOCS_EXTENSIONS.map((extension) => "`" + extension + "`").join(" ") +
  "), and grep-family over `node_modules` paths.";

const REGEX_NOTE = "Patterns match literally; pass `regex: true` for alternation (`foo|bar`).";

const UNREACHABLE = "Inform the user and stop this line of work.";

const blockBody = (
  gitRoot: string,
  violations: readonly string[],
  state: McpState,
  project: string,
): string => {
  const rewrites = violations.map((segment) => searchCallLine(project, searchPattern(segment)));
  if (state.registered && state.indexed) {
    return (
      "Try instead:\n" +
      rewrites.join("\n") +
      "\n\nIf those fail, the server is unreachable. " +
      UNREACHABLE
    );
  }
  if (state.registered) {
    return (
      "Index the repo, then search:\n" +
      indexCallLine(gitRoot) +
      "\n" +
      rewrites.join("\n") +
      "\n\nIf those fail, the server is unreachable. " +
      UNREACHABLE
    );
  }
  const first = violations[0] as string;
  return (
    '1. Not connected?    mcp({ connect: "codebase-memory-mcp" })\n' +
    '2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "' +
    gitRoot +
    '", mode: "fast" } })\n' +
    '3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })\n' +
    "4. Search:           " +
    searchCallLine("<name>", searchPattern(first)) +
    "\n" +
    "5. Still failing?    The server is unreachable. " +
    UNREACHABLE
  );
};

/** The stale-index note: which files changed after the last index, and the reindex call. */
const staleNote = (gitRoot: string, stale: readonly string[]): string =>
  stale.length === 0
    ? ""
    : "\n\n" +
      stale.map((target) => "`" + target + "`").join(", ") +
      " changed after the last index — search results for these files will be stale. Reindex before searching:\n" +
      indexCallLine(gitRoot);

/** The block message: a ready-made rewrite when the state is readable, the ladder when it is not. */
export const blockMessage = (
  gitRoot: string,
  violations: readonly string[],
  state: McpState,
  homeDir: string,
  stale: readonly string[],
): string => {
  const project = projectNameFor(gitRoot);
  const header = blockHeader(violations);
  const outside = violations.flatMap((segment) => outsideProjectTargets(segment, gitRoot, homeDir));
  const outsideNote =
    outside.length === 0
      ? ""
      : "\n\nNote: this search targets files outside the project (" +
        outside.map((target) => "`" + target + "`").join(", ") +
        "). codebase-memory-mcp can only search indexed repositories — check " +
        'mcp({ tool: "codebase-memory-mcp_list_projects" }). ' +
        "Use `read` for known paths, or run the search in a shell outside pi.";
  return (
    header +
    "\n\n" +
    blockBody(gitRoot, violations, state, project) +
    "\n\n" +
    REGEX_NOTE +
    outsideNote +
    staleNote(gitRoot, stale) +
    "\n\n" +
    EXEMPTIONS
  );
};

/** The pre-turn reminder: report the state, then the decision rule. */
export const reminderMessage = (gitRoot: string, state: McpState): string => {
  const project = projectNameFor(gitRoot);
  const rule =
    " Know the path → read. Filtering output, grepping named docs/config files, or grepping node_modules paths → bash grep is legal. " +
    "awk/sed over files is code search too — use MCP search or read. " +
    "Targets outside the project → MCP can only search indexed repositories (check list_projects); use read or a shell outside pi.";
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
