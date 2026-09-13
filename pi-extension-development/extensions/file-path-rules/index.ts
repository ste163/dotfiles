/**
 * file-path-rules — declarative glob-to-doc reminders for pi.
 *
 * Reads `.pi/rules/*.md` from the session cwd. Each file is one rule: a
 * `paths:` front-matter field (a string or a list) maps glob patterns to
 * the doc body. When the model touches a matching path with read, edit,
 * or write, the extension appends the doc body as a reminder text block
 * into the tool result content, once per file per session.
 *
 * Firing is split across two events: tool_call marks the path fired and
 * records the matched rules per toolCallId (preflight runs sequentially,
 * so parallel calls on one file cannot double-fire); tool_result appends
 * the reminder blocks. A call that gets blocked after marking consumes
 * its reminder without appending it - exactly-once wins over completeness.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  isToolCallEventType,
  type EditToolCallEvent,
  type ExtensionAPI,
  type ReadToolCallEvent,
  type ToolCallEvent,
  type WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { loadRules, RULES_DIR_NAME, type Rule } from "./config.ts";
import { defaultDeps, type FilePathRulesDeps } from "./deps.ts";
import { matchesAny, relativePath } from "./match.ts";

interface FilePathRulesState {
  rules: readonly Rule[];
  /** Normalized paths that already got their reminder this session. */
  fired: readonly string[];
  /** Matched rules keyed by toolCallId, between tool_call and tool_result. */
  pending: Record<string, readonly Rule[]>;
}

const createState = (): FilePathRulesState => ({
  rules: [],
  fired: [],
  pending: {},
});

type PathToolCallEvent = ReadToolCallEvent | EditToolCallEvent | WriteToolCallEvent;

const isPathToolCallEvent = (event: ToolCallEvent): event is PathToolCallEvent =>
  isToolCallEventType("read", event) ||
  isToolCallEventType("edit", event) ||
  isToolCallEventType("write", event);

const inputPath = (input: unknown): string | null => {
  const candidate = (input as { path?: unknown }).path;
  return typeof candidate === "string" ? candidate : null;
};

const reminderBlock = (rule: Rule, matchedPath: string): TextContent => ({
  type: "text",
  text: `[file-path-rules] rule: ${CONFIG_DIR_NAME}/${RULES_DIR_NAME}/${rule.file} - matched: ${matchedPath}\n\n${rule.body}`,
});

export const createFilePathRulesExtension = (
  pi: ExtensionAPI,
  deps: FilePathRulesDeps = defaultDeps(),
): void => {
  const state = createState();

  pi.on("session_start", (_event, ctx) => {
    state.rules = [];
    state.fired = [];
    state.pending = {};
    if (!ctx.isProjectTrusted()) return;

    const loaded = loadRules(deps, ctx.cwd);
    state.rules = loaded.rules;
    loaded.errors.forEach((error) => ctx.ui.notify(error, "warning"));
  });

  pi.on("tool_call", (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    if (!isPathToolCallEvent(event)) return;

    const normalized = relativePath(event.input.path, ctx.cwd);
    if (state.fired.includes(normalized)) return;

    const matched = state.rules.filter((rule) => matchesAny(normalized, rule.patterns));
    if (matched.length === 0) return;

    state.fired = [...state.fired, normalized];
    state.pending[event.toolCallId] = matched;
  });

  pi.on("tool_result", (event, ctx) => {
    // Pending entries only fill through the gated tool_call, so a result
    // event alone can never fire a reminder.
    const matched = state.pending[event.toolCallId];
    if (!matched) return;

    const path = inputPath(event.input);
    const normalized = path === null ? "" : relativePath(path, ctx.cwd);
    const blocks = matched.map((rule) => reminderBlock(rule, normalized));

    state.pending = Object.fromEntries(
      Object.entries(state.pending).filter(([id]) => id !== event.toolCallId),
    );
    return { content: [...event.content, ...blocks] };
  });
};

const filePathRulesExtension = (pi: ExtensionAPI): void => {
  createFilePathRulesExtension(pi);
};

export default filePathRulesExtension;
