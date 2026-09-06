/**
 * codebase-memory-mcp-enforcer — blocks bash code search in git repos and
 * redirects the agent to codebase-memory-mcp.
 *
 * The system-prompt rule tells the agent to use codebase-memory-mcp instead
 * of grep/bash for code search. This extension enforces that rule by
 * intercepting bash tool calls and judging each top-level segment of the
 * command on its own (command-analysis.ts), then answering with a block
 * message or pre-turn reminder derived from the filesystem state
 * (mcp-state.ts, messages.ts).
 *
 * The extension tracks no runtime state; everything is derived from the
 * filesystem at block time.
 */

import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodeSearchSegment, splitSegments } from "./command-analysis.ts";
import { mcpState } from "./mcp-state.ts";
import { blockMessage, reminderMessage } from "./messages.ts";
import { defaultDeps, type CodebaseMemoryMcpEnforcerDeps } from "./deps.ts";

export { defaultDeps, type CodebaseMemoryMcpEnforcerDeps };

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

export const createCodebaseMemoryMcpEnforcerExtension = (
  pi: ExtensionAPI,
  deps: CodebaseMemoryMcpEnforcerDeps = defaultDeps,
): void => {
  // Hard-intercept bash code search, judging each top-level segment.
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const violations = splitSegments(event.input.command).filter(isCodeSearchSegment);
    if (violations.length === 0) return;

    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, allow

    return { block: true, reason: blockMessage(gitRoot, violations, mcpState(gitRoot, deps)) };
  });

  // Pre-turn reminder (fights context decay)
  pi.on("before_agent_start", (event) => {
    const gitRoot = findGitRoot(deps.cwd(), deps);
    if (!gitRoot) return; // not in a git repo, no reminder needed

    // Prepend, not append — keeps it at top of context
    return {
      systemPrompt: reminderMessage(gitRoot, mcpState(gitRoot, deps)) + "\n\n" + event.systemPrompt,
    };
  });
};

export default createCodebaseMemoryMcpEnforcerExtension;
