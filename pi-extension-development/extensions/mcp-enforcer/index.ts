/**
 * mcp-enforcer — blocks grep/rg/find/ls/cat code-search in git repos.
 *
 * The system-prompt rule tells the agent to use codebase-memory-mcp instead
 * of grep/bash for code search. This extension enforces that rule by
 * intercepting bash tool calls that look like code search and blocking them
 * with a redirect message.
 *
 * Also injects a short MCP-first reminder at the top of the system prompt
 * every turn to fight context decay in long sessions.
 *
 * v2 Phase 0 (see plan.md at the repo root): the extension moved into
 * pi-extension-development and now follows the PlanModeDeps pattern from
 * plan-mode — every filesystem and MCP-state access comes through injected
 * deps, so tests run fully in memory. `getMcpStatus` is scaffold for Phase 2
 * and no call site reads it yet.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Dependencies (injected — tests never touch real disk or process state)
// ---------------------------------------------------------------------------

/** MCP connection state as the enforcer understands it. Used from Phase 2. */
export type McpStatus = "connected" | "not_connected" | "unreachable";

/** Filesystem and MCP-state access the extension needs (the PlanModeDeps pattern). */
export interface McpEnforcerDeps {
  existsSync(path: string): boolean;
  cwd(): string;
  getMcpStatus(): McpStatus;
}

/**
 * Phase 0 placeholder: pi exposes no MCP status API (plan.md, Current state),
 * so the default provider answers "not connected". Phase 2 replaces it with a
 * provider that parses `mcp` tool results. `existsSync` and `cwd` are the real
 * implementations; tests inject in-memory fakes instead.
 */
export const defaultDeps: McpEnforcerDeps = {
  existsSync,
  cwd: () => process.cwd(),
  getMcpStatus: (): McpStatus => "not_connected",
};

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
  // ls with recursive or long-listing flags (code exploration)
  /\bls\s+.*-[a-zA-Z]*[lR]/,
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
// Extension
// ---------------------------------------------------------------------------

export const createMcpEnforcerExtension = (
  pi: ExtensionAPI,
  deps: McpEnforcerDeps = defaultDeps,
): void => {
  // --- Tier 2: hard-intercept grep/bash code-search ---
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;

    if (!looksLikeCodeSearch(event.input.command)) return;

    if (!findGitRoot(deps.cwd(), deps)) return; // not in a git repo, allow

    return {
      block: true,
      reason:
        `🔴 MCP FIRST — grep/rg/find/ls/cat for code search blocked.\n\n` +
        `Use these instead:\n` +
        `  codebase_memory_mcp_search_code  — grep-like pattern search\n` +
        `  codebase_memory_mcp_search_graph — definitions, classes, routes\n` +
        `  codebase_memory_mcp_get_code_snippet — read a symbol's source\n\n` +
        `If MCP is genuinely unavailable, state that explicitly and I'll disable this block.`,
    };
  });

  // --- Tier 1c: pre-turn MCP reminder (fights context decay) ---
  pi.on("before_agent_start", (event) => {
    if (!findGitRoot(deps.cwd(), deps)) return; // not in a git repo, no reminder needed

    const reminder =
      `🔴 MCP FIRST: In git repos, use codebase_memory_mcp_search_code (not grep), ` +
      `search_graph (not find/ls). mcp({}) is your first call each turn.`;

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
