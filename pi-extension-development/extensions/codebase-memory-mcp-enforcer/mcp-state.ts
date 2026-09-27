/**
 * What the filesystem says about the codebase-memory-mcp server for this
 * repo. The server names projects by dashing the repo root, so the project
 * name and its db file are derivable without touching the server. A naming
 * mismatch just yields "not indexed" — the safe fallback.
 *
 * Registration is read from the pi-mcp-adapter config sources (v3 layout):
 * the user-global shared files, the adapter config in the Pi agent dir,
 * and the project files. Pi's own mcp.json files belong to Pi's built-in
 * MCP support, not the adapter, so they are ignored here.
 */

import { join } from "node:path";
import type { CodebaseMemoryMcpEnforcerDeps } from "./deps.ts";

export const projectNameFor = (gitRoot: string): string =>
  gitRoot.split("/").filter(Boolean).join("-");

const projectDbPath = (homeDir: string, gitRoot: string): string =>
  join(homeDir, ".cache/codebase-memory-mcp", projectNameFor(gitRoot) + ".db");

/** The Pi agent dir: PI_CODING_AGENT_DIR wins, else ~/.pi/agent. */
const agentDirPath = (deps: CodebaseMemoryMcpEnforcerDeps): string =>
  deps.env("PI_CODING_AGENT_DIR") ?? join(deps.homeDir(), ".pi/agent");

/**
 * The adapter's normal config sources, in the adapter's precedence order
 * (later entries win). The enforcer only needs membership, so the order
 * is irrelevant here.
 */
const configSourcePaths = (deps: CodebaseMemoryMcpEnforcerDeps): readonly string[] => [
  join(deps.homeDir(), ".config/mcp/mcp.json"),
  join(deps.homeDir(), ".agents/mcp.json"),
  join(deps.homeDir(), ".agents/mcp/mcp.json"),
  join(agentDirPath(deps), "mcp-adapter.json"),
  join(deps.cwd(), ".mcp.json"),
  join(deps.cwd(), ".pi/mcp-adapter.json"),
];

const parseJson = (raw: string): unknown | null => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** A parsed config registers the server when its mcpServers object holds the name. */
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

export const mcpState = (gitRoot: string, deps: CodebaseMemoryMcpEnforcerDeps): McpState => {
  const registered = configSourcePaths(deps).some(
    (path) => deps.existsSync(path) && isServerRegistered(parseJson(deps.readFile(path))),
  );
  return { registered, indexed: deps.existsSync(projectDbPath(deps.homeDir(), gitRoot)) };
};

/** The index db's mtime, or null when the db is missing. */
export const indexDbMtimeMs = (
  gitRoot: string,
  deps: CodebaseMemoryMcpEnforcerDeps,
): number | null => {
  const dbPath = projectDbPath(deps.homeDir(), gitRoot);
  return deps.existsSync(dbPath) ? deps.statSync(dbPath).mtimeMs : null;
};
