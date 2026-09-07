import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { HooksDeps } from "./deps.ts";

/** Hook that runs before a tool executes. A non-zero exit blocks the call. */
export interface ToolCallHookConfig {
  command: string;
  /** Only run for these tool names. Default: every tool. */
  tools?: string[];
  /** Timeout in milliseconds. Default: 120000. */
  timeout?: number;
}

/** Hook that runs when the agent settles. */
export type AgentSettledHookConfig =
  | { command: string; timeout?: number; status?: string; when?: undefined }
  | { command: string; timeout?: number; status?: string; when: "dirty"; paths: string[] };

export interface HooksConfig {
  tool_call?: ToolCallHookConfig;
  agent_settled?: AgentSettledHookConfig;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

const validateConfig = (config: HooksConfig, path: string): string | null => {
  const settled = config.agent_settled as { when?: string; paths?: string[] } | undefined;
  if (settled && settled.when !== undefined && settled.when !== "dirty") {
    return `Unsupported "when" value in ${path}: ${settled.when}`;
  }
  if (settled && settled.when === "dirty" && (!settled.paths || settled.paths.length === 0)) {
    return `"when": "dirty" requires a non-empty "paths" list in ${path}`;
  }
  return null;
};

const parseConfig = (raw: string): HooksConfig | null => {
  try {
    return JSON.parse(raw) as HooksConfig;
  } catch {
    return null;
  }
};

export const loadConfig = (
  deps: Pick<HooksDeps, "readFile" | "cwd">,
): { config: HooksConfig | null; error: string | null } => {
  const path = join(deps.cwd(), CONFIG_DIR_NAME, "hooks.json");
  const raw = deps.readFile(path);
  if (raw === null) return { config: null, error: null };
  const config = parseConfig(raw);
  if (!config) return { config: null, error: `Invalid JSON in ${path}` };
  const error = validateConfig(config, path);
  if (error) return { config: null, error };
  return { config, error: null };
};
