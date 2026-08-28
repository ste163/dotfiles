/**
 * mcp-enforcer — blocks bash code search in git repos and redirects the
 * agent to codebase-memory-mcp.
 *
 * The system-prompt rule tells the agent to use codebase-memory-mcp instead
 * of grep/bash for code search. This extension enforces that rule by
 * intercepting bash tool calls that look like code search and blocking them
 * with a status-aware message.
 *
 * What passes:
 * - One simple allowlisted command (`ls`, `pwd`, `echo`, `readlink`,
 *   `stat`). Substitution, pipes, and chains disqualify the pass.
 * - One simple grep-family command (`grep`, `rg`, `ack`, `ag`) whose named
 *   targets are all docs/config files.
 *
 * Everything else that looks like code search blocks. The message depends on
 * the MCP server's status: redirect with the exact calls (connected),
 * connect-first (not connected), or stop and report (unreachable). The
 * status provider starts "not connected" and tracks the snapshots the mcp
 * adapter pushes on pi's shared event bus (`pi-mcp-adapter/status/v1`).
 *
 * Every filesystem and MCP-state access comes through injected deps (the
 * PlanModeDeps pattern from plan-mode), so tests run fully in memory.
 *
 * Also injects a short MCP-first reminder at the top of the system prompt
 * every turn to fight context decay in long sessions.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Dependencies (injected — tests never touch real disk or process state)
// ---------------------------------------------------------------------------

/** MCP connection state as the enforcer understands it. */
export type McpStatus = "connected" | "not_connected" | "unreachable";

/** Filesystem and MCP-state access the extension needs (the PlanModeDeps pattern). */
export interface McpEnforcerDeps {
  existsSync(path: string): boolean;
  cwd(): string;
  getMcpStatus(): McpStatus;
  recordMcpStatusSnapshot(snapshot: unknown): void;
}

// The adapter's versioned status-event channel (pi-mcp-adapter/types.ts).
// The enforcer deliberately does not import the adapter package; the channel
// string is copied and the adapter versions it.
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

// The only MCP server the enforcer redirects to.
const SERVER_NAME = "codebase-memory-mcp";

/** Map an adapter status snapshot onto the enforcer's tri-state. */
const statusFromSnapshot = (snapshot: unknown): McpStatus => {
  if (typeof snapshot !== "object" || snapshot === null) return "not_connected";
  const servers = (snapshot as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return "not_connected";
  const server = servers.find(
    (entry): entry is { status?: unknown } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { name?: unknown }).name === SERVER_NAME,
  );
  if (server?.status === "connected") return "connected";
  if (server?.status === "failed") return "unreachable";
  return "not_connected";
};

/**
 * Default deps: the real filesystem, plus a status provider that starts
 * "not connected" (the safe default — connecting an already-connected server
 * is a no-op) and updates from the adapter's status events.
 */
export const createDefaultDeps = (): McpEnforcerDeps => {
  let status: McpStatus = "not_connected";
  return {
    existsSync,
    cwd: () => process.cwd(),
    getMcpStatus: () => status,
    recordMcpStatusSnapshot: (snapshot: unknown): void => {
      status = statusFromSnapshot(snapshot);
    },
  };
};

const defaultDeps = createDefaultDeps();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk up from `dir` looking for a `.git` directory, at most 16 levels. */
const findGitRoot = (dir: string, deps: McpEnforcerDeps): string | null => {
  let current = dir;
  for (let i = 0; i < 16; i++) {
    if (deps.existsSync(join(current, ".git"))) return current;
    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
};

// Patterns that indicate code search (not general shell use).
// These are deliberately aggressive — false positives are fine because the
// agent can always use `read` on a known path (allowed by the rule).
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

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

// Leading commands that always pass, before any block pattern runs.
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set(["ls", "pwd", "echo", "readlink", "stat"]);

// Operators that end the allowlist pass. A command that contains any of these
// is not one simple command: pipes and chains run a second command the
// allowlist never covered, and the substitutions nest another command inside
// this one. The block patterns run on the whole string instead.
const DISQUALIFIERS: readonly string[] = ["$(", "`", "|", "&", ";", "\n", "<(", ">("];

/** True when the whole command is one simple allowlisted command. */
const isAllowlisted = (command: string): boolean => {
  if (DISQUALIFIERS.some((d) => command.includes(d))) return false;
  const leading = command.trim().split(/\s+/)[0] as string;
  return ALLOWED_COMMANDS.has(leading);
};

// ---------------------------------------------------------------------------
// Docs-target exemption
// ---------------------------------------------------------------------------

// Docs/config file extensions: grep over named files with these extensions
// is not code search. This list is the only knob in the exemption.
const DOCS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".conf",
  ".ini",
]);

// The content-search commands the exemption covers.
const SEARCH_FAMILY: ReadonlySet<string> = new Set(["grep", "rg", "ack", "ag"]);

// Replace every quoted segment with one placeholder token, so a pattern with
// spaces stays one token and operators inside quotes do not disqualify.
const stripQuoted = (command: string): string =>
  command.replace(/'[^']*'/g, "QUOTED").replace(/"[^"]*"/g, "QUOTED");

const fileExtension = (token: string): string => {
  const dot = token.lastIndexOf(".");
  return dot === -1 ? "" : token.slice(dot);
};

/**
 * True for one simple grep-family command whose named targets are all
 * docs/config files. The pattern itself does not matter.
 */
const isDocsOnlySearch = (command: string): boolean => {
  const stripped = stripQuoted(command);
  if (DISQUALIFIERS.some((d) => stripped.includes(d))) return false;
  const tokens = stripped.trim().split(/\s+/);
  const leading = tokens[0] as string;
  if (!SEARCH_FAMILY.has(leading)) return false;
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  const pattern = args[0];
  if (pattern === undefined) return false;
  const targets = args.slice(1);
  if (targets.length === 0) return false; // cwd-wide scan, no named targets
  return targets.every((target) => DOCS_EXTENSIONS.has(fileExtension(target)));
};

// ---------------------------------------------------------------------------
// Block messages
// ---------------------------------------------------------------------------

/** The connected-state block message: a cheat sheet with the real calls. */
const redirectMessage = (gitRoot: string): string =>
  `🔴 MCP FIRST — code search blocked.\n\n` +
  `1. Not connected?    mcp({ connect: "codebase-memory-mcp" })\n` +
  `2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "${gitRoot}", mode: "fast" } })\n` +
  `3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })\n` +
  `4. Search:          mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "...", project: "<name>", mode: "files" } })\n\n` +
  `Docs/config files? Name them and bash grep is legal for that.`;

const CONNECT_FIRST_MESSAGE =
  `🔴 MCP FIRST — code search blocked. The codebase-memory-mcp server is not connected.\n\n` +
  `Connect it first, then search with the MCP tools:\n` +
  `  mcp({ connect: "codebase-memory-mcp" })\n\n` +
  `Do not fall back to bash for code search.`;

const STOP_MESSAGE =
  `🔴 MCP FIRST — code search blocked. The codebase-memory-mcp server failed to connect on the last attempt.\n\n` +
  `Inform the user that the MCP server is unreachable. Stop this line of work.\n` +
  `Do not fall back to bash for code search.\n\n` +
  `This state is last-observed from the adapter's status events, not a live query.`;

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const createMcpEnforcerExtension = (
  pi: ExtensionAPI,
  deps: McpEnforcerDeps = defaultDeps,
): void => {
  // --- Track the MCP server's status from the adapter's event bus ---
  pi.events.on(MCP_STATUS_EVENT, (snapshot) => {
    deps.recordMcpStatusSnapshot(snapshot);
  });

  // --- Hard-intercept bash code search ---
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;

    if (isAllowlisted(command)) return; // one simple allowlisted command, pass

    if (!looksLikeCodeSearch(command)) return;

    if (isDocsOnlySearch(command)) return; // grep-family over named docs files, allow

    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, allow

    const status = deps.getMcpStatus();
    if (status === "unreachable") {
      return { block: true, reason: STOP_MESSAGE };
    }
    if (status === "not_connected") {
      return { block: true, reason: CONNECT_FIRST_MESSAGE };
    }
    return { block: true, reason: redirectMessage(gitRoot) };
  });

  // --- Pre-turn MCP reminder (fights context decay) ---
  pi.on("before_agent_start", (event) => {
    if (!findGitRoot(deps.cwd(), deps)) return; // not in a git repo, no reminder needed

    const reminder =
      `🔴 MCP FIRST: In git repos, search code with mcp({ tool: "codebase-memory-mcp_search_code", ` +
      `args: { pattern: "...", project: "<name>", mode: "files" } }) — not grep/rg. ` +
      `Named docs/config files: bash grep is legal.`;

    // Prepend, not append — keeps it at top of context
    return {
      systemPrompt: reminder + "\n\n" + event.systemPrompt,
    };
  });
};

const mcpEnforcerExtension = (pi: ExtensionAPI): void => {
  createMcpEnforcerExtension(pi);
};

export default mcpEnforcerExtension;
