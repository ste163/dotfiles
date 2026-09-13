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
import { resolve } from "node:path";
import { loadRules, RULES_DIR_NAME, type Rule } from "./config.ts";
import { defaultDeps, type FilePathRulesDeps } from "./deps.ts";
import { matchesAny, relativePath } from "./match.ts";

interface PendingReminder {
  /** Project-relative form shown in the reminder header. */
  path: string;
  rules: readonly Rule[];
}

interface FilePathRulesState {
  rules: readonly Rule[];
  /** Fully normalized absolute paths that already got their reminder this session. */
  fired: readonly string[];
  /** Reminders keyed by toolCallId, between tool_call and tool_result. */
  pending: Record<string, PendingReminder>;
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

    // The absolute key collapses every spelling of one file (./, //, ..),
    // so the dedupe is per file, not per spelling. Pattern matching keeps
    // the project-relative form rules are written against.
    const firedKey = resolve(ctx.cwd, event.input.path);
    if (state.fired.includes(firedKey)) return;

    const normalized = relativePath(event.input.path, ctx.cwd);
    const matched = state.rules.filter((rule) => matchesAny(normalized, rule.patterns));
    if (matched.length === 0) return;

    state.fired = [...state.fired, firedKey];
    state.pending[event.toolCallId] = { path: normalized, rules: matched };
  });

  pi.on("tool_result", (event) => {
    // Pending entries only fill through the gated tool_call, so a result
    // event alone can never fire a reminder.
    const pending = state.pending[event.toolCallId];
    if (!pending) return;

    const blocks = pending.rules.map((rule) => reminderBlock(rule, pending.path));

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
