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
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk up from `dir` looking for a `.git` directory. */
const findGitRoot = (dir: string): string | null => {
	let current = dir;
	for (let i = 0; i < 16; i++) {
		if (existsSync(join(current, ".git"))) return current;
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

export default function (pi: ExtensionAPI): void {
	// --- Tier 2: hard-intercept grep/bash code-search ---
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!looksLikeCodeSearch(command)) return;

		const gitRoot = findGitRoot(process.cwd());
		if (!gitRoot) return; // not in a git repo, allow

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
	pi.on("before_agent_start", async (event) => {
		const gitRoot = findGitRoot(process.cwd());
		if (!gitRoot) return; // not in a git repo, no reminder needed

		// Prepend a short reminder to the system prompt so it's always at the top
		const reminder =
			`🔴 MCP FIRST: In git repos, use codebase_memory_mcp_search_code (not grep), ` +
			`search_graph (not find/ls). mcp({}) is your first call each turn.`;

		// Prepend, not append — keeps it at top of context
		return {
			systemPrompt: reminder + "\n\n" + event.systemPrompt,
		};
	});
}
