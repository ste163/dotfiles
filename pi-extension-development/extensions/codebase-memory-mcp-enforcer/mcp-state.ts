/**
 * What the filesystem says about the codebase-memory-mcp integration for
 * this repo. The server names projects by dashing the repo root, so the
 * project name and its db file are derivable without touching the server.
 *
 * Registration follows the pi extension era: the generated cbmem.ts
 * extension spawns the CLI binary per tool call, so "registered" means the
 * binary exists at the standard install path it hardcodes. No mcp.json
 * stdio entry is read anymore — that path was removed because a stale
 * coordination lock could block every new connection.
 */

import { join } from "node:path";
import type { CodebaseMemoryMcpEnforcerDeps } from "./deps.ts";

export const projectNameFor = (gitRoot: string): string =>
  gitRoot.split("/").filter(Boolean).join("-");

const projectDbPath = (homeDir: string, gitRoot: string): string =>
  join(homeDir, ".cache/codebase-memory-mcp", projectNameFor(gitRoot) + ".db");

/** The binary path the generated cbmem.ts extension spawns. */
const binaryPath = (homeDir: string): string =>
  join(homeDir, ".local", "bin", "codebase-memory-mcp");

/** What the filesystem says about the integration for this repo. */
export interface McpState {
  registered: boolean;
  indexed: boolean;
}

export const mcpState = (gitRoot: string, deps: CodebaseMemoryMcpEnforcerDeps): McpState => ({
  registered: deps.existsSync(binaryPath(deps.homeDir())),
  indexed: deps.existsSync(projectDbPath(deps.homeDir(), gitRoot)),
});

/** The index db's mtime, or null when the db is missing. */
export const indexDbMtimeMs = (
  gitRoot: string,
  deps: CodebaseMemoryMcpEnforcerDeps,
): number | null => {
  const dbPath = projectDbPath(deps.homeDir(), gitRoot);
  return deps.existsSync(dbPath) ? deps.statSync(dbPath).mtimeMs : null;
};
