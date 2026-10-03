/**
 * What the filesystem says about the codebase-memory-mcp server for this
 * repo. The server names projects by dashing the repo root, so the project
 * name and its db file are derivable without touching the server. A naming
 * mismatch just yields "not indexed" — the safe fallback.
 *
 * Registration is read from Pi's built-in MCP config sources: the
 * user-level mcp.json in the Pi agent dir and the project-level
 * .pi/mcp.json.
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
 * Pi's built-in MCP config sources. The enforcer only needs membership,
 * so the order is irrelevant here.
 */
const configSourcePaths = (deps: CodebaseMemoryMcpEnforcerDeps): readonly string[] => [
  join(agentDirPath(deps), "mcp.json"),
  join(deps.cwd(), ".pi/mcp.json"),
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
