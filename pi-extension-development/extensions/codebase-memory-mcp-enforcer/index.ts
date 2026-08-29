/**
 * codebase-memory-mcp-enforcer — blocks bash code search in git repos and
 * redirects the agent to codebase-memory-mcp.
 *
 * The system-prompt rule tells the agent to use codebase-memory-mcp instead
 * of grep/bash for code search. This extension enforces that rule by
 * intercepting bash tool calls that look like code search and blocking them.
 *
 * What passes:
 * - One simple allowlisted command (`ls`, `pwd`, `echo`, `readlink`,
 *   `stat`). Substitution, pipes, and chains disqualify the pass.
 * - One simple grep-family command (`grep`, `rg`, `ack`, `ag`) whose named
 *   targets are all docs/config files.
 *
 * Everything else that looks like code search blocks with one message: a
 * self-correcting ladder naming the exact calls — connect, index, project,
 * search, and the unreachable exit. The extension tracks no runtime state;
 * the agent discovers the server's state by walking the ladder.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Filesystem access the extension needs (the PlanModeDeps pattern). */
export interface CodebaseMemoryMcpEnforcerDeps {
  existsSync(path: string): boolean;
  cwd(): string;
}

/** Default deps: the real filesystem. A plain immutable value. */
export const defaultDeps: CodebaseMemoryMcpEnforcerDeps = {
  existsSync,
  cwd: () => process.cwd(),
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

// Patterns that indicate code search (not general shell use).
// These are deliberately aggressive — false positives are fine because the
// agent can always use `read` on a known path (allowed by the rule).
// Not exhaustive: awk, sed, and friends also search file contents and pass
// unblocked. Extend this list if agents continuously skip the MCP server
// with them.
const CODE_SEARCH_PATTERNS: RegExp[] = [
  // grep / rg used for searching file contents
  /\bgrep\b/,
  /\brg\b/,
  // find used for locating files by name/type
  /\bfind\b.*-name\b/,
  /\bfind\b.*-type\b/,
  // cat with glob or piped to grep/head (reading unknown files)
  /\bcat\s+.*\*/,
  /\bcat\b.*\|\s*(grep|head|tail|sort|uniq)\b/,
  // ack/ag (alternative grep tools)
  /\back\b/,
  /\bag\b/,
  // git grep
  /\bgit\s+grep\b/,
];

const looksLikeCodeSearch = (command: string): boolean =>
  CODE_SEARCH_PATTERNS.some((p) => p.test(command));

// Leading commands that always pass, before any block pattern runs.
const ALLOWED_COMMANDS: readonly string[] = ["ls", "pwd", "echo", "readlink", "stat"];

// Operators that end the allowlist pass. A command that contains any of these
// is not one simple command: pipes and chains run a second command the
// allowlist never covered, and the substitutions nest another command inside
// this one. The block patterns run on the whole string instead.
const DISQUALIFIERS: readonly string[] = ["$(", "`", "|", "&", ";", "\n", "<(", ">("];

const isAllowlisted = (command: string): boolean => {
  if (DISQUALIFIERS.some((d) => command.includes(d))) return false;
  const leading = command.trim().split(/\s+/)[0] as string;
  return ALLOWED_COMMANDS.includes(leading);
};

// Docs/config file extensions: grep over named files with these extensions
// is not code search. This list is the only knob in the exemption.
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

// The content-search commands the exemption covers.
const SEARCH_FAMILY: readonly string[] = ["grep", "rg", "ack", "ag"];

// Replace every quoted segment with one placeholder token, so a pattern with
// spaces stays one token and operators inside quotes do not disqualify.
const stripQuoted = (command: string): string =>
  command.replace(/'[^']*'/g, "QUOTED").replace(/"[^"]*"/g, "QUOTED");

const fileExtension = (token: string): string => {
  const dot = token.lastIndexOf(".");
  return dot === -1 ? "" : token.slice(dot);
};

const isDocsOnlySearch = (command: string): boolean => {
  const stripped = stripQuoted(command);
  if (DISQUALIFIERS.some((d) => stripped.includes(d))) return false;
  const tokens = stripped.trim().split(/\s+/);
  const leading = tokens[0] as string;
  if (!SEARCH_FAMILY.includes(leading)) return false;
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  const pattern = args[0];
  if (pattern === undefined) return false;
  const targets = args.slice(1);
  if (targets.length === 0) return false; // cwd-wide scan, no named targets
  return targets.every((target) => DOCS_EXTENSIONS.includes(fileExtension(target)));
};

/** The single block message: a self-correcting ladder with the real calls. */
const blockMessage = (gitRoot: string): string =>
  `MCP FIRST — code search blocked.\n\n` +
  `1. Not connected?    mcp({ connect: "codebase-memory-mcp" })\n` +
  `2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "${gitRoot}", mode: "fast" } })\n` +
  `3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })\n` +
  `4. Search:           mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "...", project: "<name>", mode: "files" } })\n` +
  `5. Still failing?    The server is unreachable. Inform the user and stop this line of work.\n\n` +
  `Docs/config files? Name them and bash grep is legal for that.`;

export const createCodebaseMemoryMcpEnforcerExtension = (
  pi: ExtensionAPI,
  deps: CodebaseMemoryMcpEnforcerDeps = defaultDeps,
): void => {
  // Hard-intercept bash code search
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;

    if (isAllowlisted(command)) return; // one simple allowlisted command, pass

    if (!looksLikeCodeSearch(command)) return;

    if (isDocsOnlySearch(command)) return; // grep-family over named docs files, allow

    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, allow

    return { block: true, reason: blockMessage(gitRoot) };
  });

  // Pre-turn MCP reminder (fights context decay)
  pi.on("before_agent_start", (event) => {
    if (!findGitRoot(deps.cwd(), deps)) return; // not in a git repo, no reminder needed

    const reminder =
      `MCP FIRST: In git repos, search code with mcp({ tool: "codebase-memory-mcp_search_code", ` +
      `args: { pattern: "...", project: "<name>", mode: "files" } }) — not grep/rg. ` +
      `Named docs/config files: bash grep is legal.`;

    // Prepend, not append — keeps it at top of context
    return {
      systemPrompt: reminder + "\n\n" + event.systemPrompt,
    };
  });
};

export default createCodebaseMemoryMcpEnforcerExtension;
