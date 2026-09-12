/**
 * plan-mode-write-file — read-only exploration with one writable plan file.
 *
 * While enabled, bash is restricted to a read-only allowlist and
 * write/edit tools work only on the single user-named plan file (basename
 * only, always resolved in cwd). Everything else is blocked.
 *
 * The plan file name is asked once per toggle-on (only when none is set,
 * or the locked file no longer exists on disk) and reused afterward.
 * Name collisions with existing files force a re-prompt.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { defaultDeps, type PlanModeWriteFileDeps } from "./deps.ts";
import {
  completeMessage,
  executeMessage,
  executionContextMessage,
  planContextMessage,
  todoListMessage,
} from "./messages.ts";
import {
  DEFAULT_PLAN_FILE_NAME,
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

interface PlanModeWriteFileState {
  enabled: boolean;
  todos: TodoItem[];
  executing: boolean;
  planFileName: string | null;
}

interface PersistedState {
  enabled?: boolean;
  todos?: TodoItem[];
  executing?: boolean;
  planFileName?: string | null;
}

const createState = (): PlanModeWriteFileState => ({
  enabled: false,
  todos: [],
  executing: false,
  planFileName: null,
});

const isAssistantMessage = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant" && Array.isArray(message.content);

const getTextContent = (message: AssistantMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const planFileExists = (name: string, deps: PlanModeWriteFileDeps): boolean =>
  deps.existsSync(join(deps.cwd(), name));

export const createPlanModeWriteFileExtension = (
  pi: ExtensionAPI,
  deps: PlanModeWriteFileDeps = defaultDeps,
): void => {
  const state = createState();

  const isPlanFile = (path: string): boolean => {
    // SAFETY: the enabled state guarantees a plan file name is locked in.
    const lockedName = state.planFileName as string;
    return toBaseName(path).toLowerCase() === lockedName.toLowerCase();
  };

  const promptForPlanFileName = async (
    ctx: ExtensionContext,
    previousAttempt = "",
  ): Promise<string | null> => {
    const promptText =
      previousAttempt.length > 0
        ? `"${previousAttempt}" already exists in this directory. Choose another plan file name (blank = ${DEFAULT_PLAN_FILE_NAME}):`
        : "Name your plan file (lives in cwd, blank = plan.md):";

    const input = await ctx.ui.editor(promptText, "");
    if (input == null) return null;

    const trimmed = input.trim();
    const candidate = withMdExt(toBaseName(trimmed.length > 0 ? trimmed : DEFAULT_PLAN_FILE_NAME));

    // Each attempt depends on the previous answer, so recursion replaces a loop.
    if (!planFileExists(candidate, deps)) return candidate;
    return promptForPlanFileName(ctx, candidate);
  };

  pi.registerFlag("plan-write-file", {
    description: "Start in plan-write-file mode (read-only exploration, one plan file writable)",
    type: "boolean",
    default: false,
  });

  const updateStatus = (ctx: ExtensionContext): void => {
    if (state.executing && state.todos.length > 0) {
      const completed = state.todos.filter((t) => t.completed).length;
      ctx.ui.setStatus(
        "plan-mode-write-file",
        ctx.ui.theme.fg("accent", `plan ${completed}/${state.todos.length}`),
      );
    } else if (state.enabled) {
      ctx.ui.setStatus("plan-mode-write-file", ctx.ui.theme.fg("warning", "plan-write-file: on"));
    } else {
      ctx.ui.setStatus("plan-mode-write-file", undefined);
    }

    if (state.executing && state.todos.length > 0) {
      const lines = state.todos.map((item) =>
        item.completed
          ? ctx.ui.theme.fg("success", "[x] ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          : `${ctx.ui.theme.fg("muted", "[ ] ")}${item.text}`,
      );
      ctx.ui.setWidget("plan-write-file-todos", lines);
    } else {
      ctx.ui.setWidget("plan-write-file-todos", undefined);
    }
  };

  const persistState = (): void => {
    pi.appendEntry("plan-mode-write-file", {
      enabled: state.enabled,
      todos: state.todos,
      executing: state.executing,
      planFileName: state.planFileName,
    });
  };

  const togglePlanMode = async (ctx: ExtensionContext): Promise<void> => {
    if (!state.enabled) {
      // Reuse the locked file only while it still exists on disk.
      if (state.planFileName === null || !planFileExists(state.planFileName, deps)) {
        const chosen = await promptForPlanFileName(ctx);
        if (chosen === null) return;
        state.planFileName = chosen;
      }

      state.enabled = true;
      state.executing = false;
      state.todos = [];
      ctx.ui.notify(`Plan-write-file enabled. Only ${state.planFileName} can be written/edited.`);
    } else {
      state.enabled = false;
      state.executing = false;
      state.todos = [];
      ctx.ui.notify("Plan-write-file disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  };

  pi.registerCommand("plan-write-file", {
    description: "Toggle plan-write-file mode (read-only exploration, one plan file writable)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("plan-write-file-todos", {
    description: "Show current plan todo list",
    handler: async (_args, ctx) => {
      if (state.todos.length === 0) {
        ctx.ui.notify("No todos. Create a plan first with /plan-write-file", "info");
        return;
      }
      const list = state.todos
        .map((item, i) => `${i + 1}. ${item.completed ? "[x]" : "[ ]"} ${item.text}`)
        .join("\n");
      ctx.ui.notify(`Plan Progress:\n${list}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan-write-file mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("plan-write-file-name", {
    description: "Show the currently locked plan file",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.planFileName !== null
          ? `Plan file: ${state.planFileName}`
          : "No plan file set yet. Use /plan-write-file to start.",
      );
    },
  });

  pi.on("tool_call", (event) => {
    if (!state.enabled) return;

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan-write-file: command blocked (not allowlisted). Use /plan-write-file to disable first.\nCommand: ${command}`,
        };
      }
      return;
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (!isPlanFile(event.input.path)) {
        // SAFETY: the enabled state guarantees a plan file name is locked in.
        const lockedName = state.planFileName as string;
        return {
          block: true,
          reason: `Plan-write-file: only ${lockedName} can be written/edited. Use /plan-write-file to disable first.`,
        };
      }
    }

    return;
  });

  pi.on("context", (event) => {
    if (state.enabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-write-file-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN WRITE FILE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) =>
              c.type === "text" && (c as TextContent).text?.includes("[PLAN WRITE FILE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  pi.on("before_agent_start", () => {
    if (state.enabled) {
      // SAFETY: the enabled state guarantees a plan file name is locked in.
      return { message: planContextMessage(state.planFileName as string) };
    }

    if (state.executing && state.todos.length > 0) {
      return { message: executionContextMessage(state.todos) };
    }

    return;
  });

  pi.on("turn_end", (event, ctx) => {
    if (!state.executing || state.todos.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const result = markCompletedSteps(getTextContent(event.message), state.todos);
    if (result.completed > 0) {
      state.todos = result.todos;
      updateStatus(ctx);
    }
    persistState();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (state.executing && state.todos.length > 0) {
      if (state.todos.every((t) => t.completed)) {
        pi.sendMessage(completeMessage(state.todos), { triggerTurn: false });
        state.executing = false;
        state.todos = [];
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if (!state.enabled || !ctx.hasUI) return;

    const lastAssistant = event.messages.findLast(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) state.todos = extracted;
    }

    if (state.todos.length === 0) return;
    persistState();

    const choice = await ctx.ui.select("Plan-write-file - what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      // SAFETY: the guard above returns when the todo list is empty.
      const first = (state.todos[0] as TodoItem).text;

      state.enabled = false;
      state.executing = true;
      updateStatus(ctx);
      persistState();

      pi.sendMessage(todoListMessage(state.todos), { deliverAs: "followUp" });
      pi.sendMessage(executeMessage(state.todos, first), {
        triggerTurn: true,
        deliverAs: "followUp",
      });
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(todoListMessage(state.todos), { deliverAs: "followUp" });
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan-write-file") === true) {
      state.enabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    const planModeEntry = entries.findLast(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "plan-mode-write-file",
    ) as { data?: PersistedState } | undefined;

    if (planModeEntry?.data) {
      state.enabled = planModeEntry.data.enabled ?? state.enabled;
      state.todos = planModeEntry.data.todos ?? state.todos;
      state.executing = planModeEntry.data.executing ?? state.executing;
      state.planFileName = planModeEntry.data.planFileName ?? state.planFileName;
    }

    const isResume = planModeEntry !== undefined;
    let persisted = false;
    if (isResume && state.executing && state.todos.length > 0) {
      // Scan only messages after the last execute marker, so [DONE:n] tags
      // from previous plans never leak into the restored list.
      const executeIndex = entries.findLastIndex(
        (entry) => (entry as { customType?: string }).customType === "plan-write-file-execute",
      );

      const messages: AssistantMessage[] = entries
        .slice(executeIndex + 1)
        // SAFETY: the check below keeps only entries with a message property.
        .flatMap((entry) =>
          entry.type === "message" && "message" in entry
            ? [(entry as { message: AgentMessage }).message]
            : [],
        )
        .filter(isAssistantMessage);
      state.todos = markCompletedSteps(messages.map(getTextContent).join("\n"), state.todos).todos;
    }

    if (
      state.enabled &&
      (state.planFileName === null || !planFileExists(state.planFileName, deps))
    ) {
      if (ctx.hasUI) {
        const chosen = await promptForPlanFileName(ctx);
        if (chosen !== null) {
          state.planFileName = chosen;
          persistState();
          persisted = true;
        } else {
          state.enabled = false;
        }
      } else {
        // Headless run: no UI to prompt, so fall back silently.
        state.planFileName = DEFAULT_PLAN_FILE_NAME;
        persistState();
        persisted = true;
      }
    }

    // A resumed session always re-persists its state, so the entry log
    // reflects the restored (and possibly re-scanned) plan.
    if (isResume && !persisted) {
      persistState();
    }

    updateStatus(ctx);
  });
};

const planModeWriteFileExtension = (pi: ExtensionAPI): void => {
  createPlanModeWriteFileExtension(pi);
};

export default planModeWriteFileExtension;
