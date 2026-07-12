/**
 * Plan Mode Extension (dotfiles fork)
 *
 * Read-only exploration mode for safe code analysis, forked from pi's
 * `examples/extensions/plan-mode`. Same behavior, with one change:
 *
 * - Instead of fully disabling `edit`/`write`, those tools stay active but
 *   are gated by path: only writes/edits to a single user-named plan file
 *   (basename only, always resolved in cwd) are allowed while plan mode is
 *   active. Everything else is blocked, same as before. Bash is still
 *   restricted to a read-only allowlist (see utils.ts) so plan mode can't
 *   be bypassed via shell.
 *
 * - The plan file name is asked once per toggle-on (only if none is set
 *   yet, or the previously locked file no longer exists on disk) and reused
 *   afterward. Single active plan at a time - no multi-plan concurrency.
 *   Name collisions with existing files force a re-prompt.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - /plan-file to see which file is currently locked
 * - Bash restricted to allowlisted read-only commands
 * - Writes/edits allowed only to the locked plan file
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PLAN_FILE_NAME,
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

// Filesystem access the extension needs, injected so tests never touch real
// disk or process.cwd() - see PlanModeDeps below.
export interface PlanModeDeps {
  existsSync(path: string): boolean;
  cwd(): string;
}

const defaultDeps: PlanModeDeps = {
  existsSync,
  cwd: () => process.cwd(),
};

const planFileExists = (name: string, deps: PlanModeDeps): boolean =>
  deps.existsSync(join(deps.cwd(), name));

interface PlanModeState {
  enabled: boolean;
  todos?: TodoItem[];
  executing?: boolean;
  planFileName?: string;
}

// Type guard for assistant messages
const isAssistantMessage = (m: AgentMessage): m is AssistantMessage =>
  m.role === "assistant" && Array.isArray(m.content);

// Extract text content from an assistant message
const getTextContent = (message: AssistantMessage): string =>
  message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");

export const createPlanModeExtension = (
  pi: ExtensionAPI,
  deps: PlanModeDeps = defaultDeps,
): void => {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let planFileName: string | undefined;

  const isPlanFile = (path: string): boolean =>
    planFileName !== undefined && toBaseName(path).toLowerCase() === planFileName.toLowerCase();

  // Prompt for a plan file name, re-prompting while the name collides with
  // an existing file in cwd. Returns undefined if the user cancels. Recursive
  // rather than a loop - each attempt genuinely depends on the previous one's
  // answer, so there is nothing to run concurrently here.
  const promptForPlanFileName = async (
    ctx: ExtensionContext,
    previousAttempt = "",
  ): Promise<string | undefined> => {
    const promptText =
      previousAttempt.length > 0
        ? `"${previousAttempt}" already exists in this directory. Choose another plan file name (blank = ${DEFAULT_PLAN_FILE_NAME}):`
        : "Name your plan file (lives in cwd, blank = plan.md):";

    const input = await ctx.ui.editor(promptText, "");
    if (input == null) return undefined;

    const trimmed = input.trim();
    const candidate = withMdExt(toBaseName(trimmed.length > 0 ? trimmed : DEFAULT_PLAN_FILE_NAME));

    if (!planFileExists(candidate, deps)) return candidate;
    return promptForPlanFileName(ctx, candidate);
  };

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration, named plan file writable)",
    type: "boolean",
    default: false,
  });

  const updateStatus = (ctx: ExtensionContext): void => {
    // Footer status
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    // Widget showing todo list
    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg("success", "☑ ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
  };

  const persistState = (): void => {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
      planFileName,
    });
  };

  const togglePlanMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!planModeEnabled) {
      // Turning on: reuse the existing plan file if it's still set and
      // present on disk, otherwise ask for a (unique) name.
      if (!planFileName || !planFileExists(planFileName, deps)) {
        const chosen = await promptForPlanFileName(ctx);
        if (!chosen) return; // user cancelled naming, abort toggle-on
        planFileName = chosen;
      }

      planModeEnabled = true;
      executionMode = false;
      todoItems = [];
      ctx.ui.notify(`Plan mode enabled. Only ${planFileName} can be written/edited.`);
    } else {
      planModeEnabled = false;
      executionMode = false;
      todoItems = [];
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  };

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration, named plan file writable)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan", "info");
        return;
      }
      const list = todoItems
        .map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
        .join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("plan-file", {
    description: "Show the currently locked plan file",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        planFileName ? `Plan file: ${planFileName}` : "No plan file set yet. Use /plan to start.",
      );
    },
  });

  // Block destructive bash commands in plan mode
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled) return;

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
        };
      }
      return;
    }

    // Allow write/edit only for the locked-in plan file; block everything else.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (!isPlanFile(event.input.path)) {
        return {
          block: true,
          reason: `Plan mode: only ${planFileName ?? DEFAULT_PLAN_FILE_NAME} can be written/edited. Use /plan to disable plan mode first.`,
        };
      }
    }

    return undefined;
  });

  // Filter out stale plan mode context when not in plan mode
  pi.on("context", async (event) => {
    if (planModeEnabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  // Inject plan/execution context before agent starts
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Bash is restricted to an allowlist of read-only commands
- The only file you may write or edit is ${planFileName} (any other write/edit is blocked)

Ask clarifying questions using the questionnaire tool if available.

Create a detailed numbered plan under a "Plan:" header, and feel free to write it to ${planFileName}:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make other changes - just describe what you would do.`,
          display: false,
        },
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
          display: false,
        },
      };
    }

    return undefined;
  });

  // Track progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
    }
    persistState();
  });

  // Handle plan completion and plan mode UI
  pi.on("agent_end", async (event, ctx) => {
    // Check if execution is complete
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**Plan Complete!** ✓\n\n${completedList}`,
            display: true,
          },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        updateStatus(ctx);
        persistState(); // Save cleared state so resume doesn't restore old execution mode
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const lastAssistant = event.messages.findLast(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) {
        todoItems = extracted;
      }
    }

    if (todoItems.length === 0) return;
    persistState();

    // Show plan steps and prompt for next action
    const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
    const planTodoListMessage = {
      customType: "plan-todo-list",
      content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
      display: true,
    };

    const choice = await ctx.ui.select("Plan mode - what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      const firstTodoItem = todoItems[0];
      if (!firstTodoItem) return;

      planModeEnabled = false;
      executionMode = true;
      updateStatus(ctx);
      persistState();

      const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
      const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
      pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
      pi.sendMessage(
        { customType: "plan-mode-execute", content: execMessage, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // Restore persisted state
    const planModeEntry = entries.findLast(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "plan-mode",
    ) as { data?: PlanModeState } | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
      planFileName = planModeEntry.data.planFileName ?? planFileName;
    }

    // On resume: re-scan messages to rebuild completion state
    // Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
    const isResume = planModeEntry !== undefined;
    if (isResume && executionMode && todoItems.length > 0) {
      // Find the index of the last plan-mode-execute entry (marks when current execution started)
      const executeIndex = entries.findLastIndex(
        (entry) => (entry as { customType?: string }).customType === "plan-mode-execute",
      );

      // Only scan messages after the execute marker
      const messages: AssistantMessage[] = entries
        .slice(executeIndex + 1)
        .filter((entry) => entry !== undefined && entry.type === "message" && "message" in entry)
        .map((entry) => (entry as unknown as { message: AgentMessage }).message)
        .filter(isAssistantMessage);
      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, todoItems);
    }

    // Plan mode came on via --plan flag or restored state, but no plan file
    // locked in yet (or the old one vanished) - name one now if we can.
    if (planModeEnabled && (!planFileName || !planFileExists(planFileName, deps))) {
      if (ctx.hasUI) {
        const chosen = await promptForPlanFileName(ctx);
        if (chosen) {
          planFileName = chosen;
          persistState();
        } else {
          planModeEnabled = false; // cancelled naming, don't leave a lock with nothing to write
        }
      } else {
        planFileName = DEFAULT_PLAN_FILE_NAME; // no UI to prompt (headless run); fall back silently
      }
    }

    updateStatus(ctx);
  });
};

const planModeExtension = (pi: ExtensionAPI): void => {
  createPlanModeExtension(pi);
};

export default planModeExtension;
