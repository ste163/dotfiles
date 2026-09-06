/**
 * What the filesystem says about the codebase-memory-mcp server for this
 * repo. The server names projects by dashing the repo root, so the project
 * name and its db file are derivable without touching the server. A naming
 * mismatch just yields "not indexed" — the safe fallback.
 */

import { join } from "node:path";
import type { CodebaseMemoryMcpEnforcerDeps } from "./deps.ts";

export const projectNameFor = (gitRoot: string): string =>
  gitRoot.split("/").filter(Boolean).join("-");

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

export const mcpState = (gitRoot: string, deps: CodebaseMemoryMcpEnforcerDeps): McpState => {
  const configPath = mcpConfigPath(deps.homeDir());
  const registered =
    deps.existsSync(configPath) && isServerRegistered(parseJson(deps.readFile(configPath)));
  return { registered, indexed: deps.existsSync(projectDbPath(deps.homeDir(), gitRoot)) };
};
