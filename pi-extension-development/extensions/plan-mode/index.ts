/**
 * plan-mode — discussion-first planning with explicit phase transitions.
 *
 * /plan toggles between off and overview. Overview removes the built-in
 * write and edit tools from the active set and gates bash to a read-only
 * allowlist, so the plan lives only in the conversation. From overview the
 * user approves one path: continue planning, write the plan to a file
 * (plan-file phase: only that one file is writable), or execute the plan
 * (executing phase: full access with [DONE:n] progress tracking).
 *
 * Scope: this extension covers the built-in write and edit tools plus the
 * bash tool. Tools registered by other extensions or MCP servers are not
 * gated. The bash gate is a best-effort guardrail, not a security boundary.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { defaultDeps, type PlanModeDeps } from "./deps.ts";
import {
  completeMessage,
  executionContextMessage,
  executeMessage,
  formatCorrectionMessage,
  overviewContextMessage,
  planFileContextMessage,
  planFileCorrectionMessage,
  todoListMessage,
  writePlanFileMessage,
} from "./messages.ts";
import {
  DEFAULT_PLAN_FILE_NAME,
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  planFormatIssue,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

type Phase = "off" | "overview" | "plan-file" | "executing";

const WRITE_TOOL_NAMES: readonly string[] = ["write", "edit"];

/** Context messages injected per phase; filtered out of history while off. */
const CONTEXT_TYPES: readonly string[] = [
  "plan-mode-overview-context",
  "plan-mode-file-context",
  "plan-mode-execution-context",
];

interface PlanModeState {
  phase: Phase;
  todos: TodoItem[];
  planFileName: string | null;
  /** Active-tool snapshot taken when overview started; never persisted. */
  toolsBeforeOverview: string[] | null;
  /** Below-editor status widget handle; never persisted. */
  statusWidget: { invalidate(): void } | null;
  /** True after a format-correction turn was sent; cleared by a valid plan. */
  formatWarned: boolean;
}

interface PersistedState {
  phase?: Phase;
  todos?: TodoItem[];
  planFileName?: string | null;
}

const createState = (): PlanModeState => ({
  phase: "off",
  todos: [],
  planFileName: null,
  toolsBeforeOverview: null,
  statusWidget: null,
  formatWarned: false,
});

const isAssistantMessage = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant" && Array.isArray(message.content);

const getTextContent = (message: AssistantMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const planFileExists = (name: string, deps: PlanModeDeps): boolean =>
  deps.existsSync(join(deps.cwd(), name));

// The plan file is the source of truth in the plan-file phase: the agent
// writes the plan into it, and every read back uses the file, never the
// chat message that announced the write.
const planFileContent = (state: PlanModeState, deps: PlanModeDeps): string | null => {
  // SAFETY: callers only run in plan-file phase, which locks the name.
  const lockedName = state.planFileName as string;
  return deps.readFileSync(join(deps.cwd(), lockedName));
};

const planFileIssue = (state: PlanModeState, content: string | null): string => {
  // SAFETY: the plan-file phase guarantees a locked plan file name.
  const lockedName = state.planFileName as string;
  if (content === null) return `${lockedName} is missing`;
  if (content.trim() === "") return `${lockedName} is blank`;
  // SAFETY: non-empty content that extracted nothing, so planFormatIssue
  // names the exact problem instead of returning null.
  return planFormatIssue(content) as string;
};

// The status line mirrors the hooks widget's frame - accent label, two
// spaces, colored state - so the below-editor statuses share one format.
const planStatusLine = (theme: Theme, color: "accent" | "warning", text: string): string =>
  ` ${theme.fg("accent", "plan")}  ${theme.fg(color, text)}`;

const renderPlanStatus = (state: PlanModeState, theme: Theme): string[] => {
  if (state.phase === "executing" && state.todos.length > 0) {
    const completed = state.todos.filter((t) => t.completed).length;
    return [planStatusLine(theme, "accent", `executing ${completed}/${state.todos.length}`)];
  }
  if (state.phase === "overview") return [planStatusLine(theme, "warning", "overview")];
  if (state.phase === "plan-file") return [planStatusLine(theme, "warning", "file")];
  return [];
};

export const createPlanModeExtension = (
  pi: ExtensionAPI,
  deps: PlanModeDeps = defaultDeps(),
): void => {
  const state = createState();

  const isPlanFile = (path: string): boolean => {
    // SAFETY: the plan-file phase guarantees a locked plan file name.
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

  const enterOverview = (): void => {
    state.toolsBeforeOverview = pi.getActiveTools();
    pi.setActiveTools(state.toolsBeforeOverview.filter((name) => !WRITE_TOOL_NAMES.includes(name)));
  };

  const leaveOverview = (): void => {
    if (state.toolsBeforeOverview !== null) {
      pi.setActiveTools(state.toolsBeforeOverview);
      state.toolsBeforeOverview = null;
    }
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (state.phase === "executing" && state.todos.length > 0) {
      const lines = state.todos.map((item) =>
        item.completed
          ? ctx.ui.theme.fg("success", "[x] ") +
            ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
          : `${ctx.ui.theme.fg("muted", "[ ] ")}${item.text}`,
      );
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
    state.statusWidget?.invalidate();
  };

  const persistState = (): void => {
    pi.appendEntry("plan-mode", {
      phase: state.phase,
      todos: state.todos,
      planFileName: state.planFileName,
    });
  };

  const startExecuting = (ctx: ExtensionContext): void => {
    // SAFETY: callers only start execution when the todo list is non-empty.
    const first = (state.todos[0] as TodoItem).text;

    state.phase = "executing";
    updateStatus(ctx);
    persistState();

    pi.sendMessage(todoListMessage(state.todos), { deliverAs: "followUp" });
    pi.sendMessage(executeMessage(state.todos, first), {
      triggerTurn: true,
      deliverAs: "followUp",
    });
  };

  /**
   * Moves to the plan-file phase. Asks for a plan file name when none is
   * locked or the locked file no longer exists. Returns false when naming
   * is cancelled, leaving the current phase untouched.
   */
  const startPlanFile = async (ctx: ExtensionContext): Promise<boolean> => {
    if (state.planFileName === null || !planFileExists(state.planFileName, deps)) {
      const chosen = await promptForPlanFileName(ctx);
      if (chosen === null) return false;
      state.planFileName = chosen;
    }

    // SAFETY: the name lock above guarantees a non-null plan file name.
    const lockedName = state.planFileName as string;

    // The extension creates the file blank; the model only populates it.
    // The blank file is the success signal the agent writes after, so the
    // model never has to decide whether to create the file itself.
    if (!planFileExists(lockedName, deps)) {
      if (!deps.writeFileSync(join(deps.cwd(), lockedName), "")) {
        ctx.ui.notify(`Could not create ${lockedName}. Write to file was cancelled.`, "error");
        return false;
      }
    }

    // No-op unless coming from overview: only overview filters the tools.
    leaveOverview();

    state.phase = "plan-file";
    updateStatus(ctx);
    persistState();

    pi.sendMessage(writePlanFileMessage(lockedName, state.todos), {
      triggerTurn: true,
      deliverAs: "followUp",
    });
    return true;
  };

  const togglePlanMode = (ctx: ExtensionContext): void => {
    if (state.phase === "off") {
      enterOverview();
      state.phase = "overview";
      state.todos = [];
      ctx.ui.notify(
        "Plan mode enabled (overview). Write and edit tools are disabled. Discuss the plan first.",
      );
    } else {
      if (state.phase === "overview") leaveOverview();
      state.phase = "off";
      state.todos = [];
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  };

  pi.registerFlag("plan", {
    description: "Start in plan overview mode (discussion only, no writes)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode (starts in overview: no writes, discussion first)",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  pi.on("tool_call", (event) => {
    if (state.phase === "off" || state.phase === "executing") return;

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

    // Backstop for overview: the tools are already removed from the active
    // set, but block them here too in case another extension re-adds them.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (state.phase === "overview") {
        return {
          block: true,
          reason:
            "Plan mode (overview): write and edit tools are disabled. Approve the plan first.",
        };
      }
      if (!isPlanFile(event.input.path)) {
        // SAFETY: the plan-file phase guarantees a locked plan file name.
        const lockedName = state.planFileName as string;
        return {
          block: true,
          reason: `Plan mode: only ${lockedName} can be written/edited. Use /plan to disable plan mode first.`,
        };
      }
    }

    return;
  });

  pi.on("context", (event) => {
    if (state.phase !== "off") return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType !== undefined && CONTEXT_TYPES.includes(msg.customType)) return false;
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

  pi.on("before_agent_start", () => {
    if (state.phase === "overview") {
      return { message: overviewContextMessage };
    }

    if (state.phase === "plan-file") {
      // The write instruction repeats only while the file has no plan, so
      // a written plan does not leave a stale instruction in later turns.
      const content = planFileContent(state, deps);
      const extracted = content === null ? [] : extractTodoItems(content);
      if (extracted.length === 0) {
        // SAFETY: the plan-file phase guarantees a locked plan file name.
        return { message: planFileContextMessage(state.planFileName as string) };
      }
      return;
    }

    if (state.phase === "executing" && state.todos.length > 0) {
      return { message: executionContextMessage(state.todos) };
    }

    return;
  });

  pi.on("turn_end", (event, ctx) => {
    if (state.phase !== "executing" || state.todos.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const result = markCompletedSteps(getTextContent(event.message), state.todos);
    if (result.completed > 0) {
      state.todos = result.todos;
      updateStatus(ctx);
    }
    persistState();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (state.phase === "executing" && state.todos.length > 0) {
      if (state.todos.every((t) => t.completed)) {
        pi.sendMessage(completeMessage(state.todos), { triggerTurn: false });
        state.phase = "off";
        state.todos = [];
        updateStatus(ctx);
        persistState();
      }
      return;
    }

    if ((state.phase !== "overview" && state.phase !== "plan-file") || !ctx.hasUI) return;

    // plan-file phase: the plan file is the source of truth. The chat
    // message is not consulted - the agent writes the plan into the file,
    // so its reply can be anything without triggering a correction.
    if (state.phase === "plan-file") {
      const content = planFileContent(state, deps);
      const extracted = content === null ? [] : extractTodoItems(content);
      if (extracted.length > 0) {
        state.todos = extracted;
        state.formatWarned = false;
      } else {
        const issue = planFileIssue(state, content);
        if (!state.formatWarned) {
          state.formatWarned = true;
          ctx.ui.notify("Plan file invalid - asking for a rewrite", "warning");
          // SAFETY: the plan-file phase guarantees a locked plan file name.
          pi.sendMessage(planFileCorrectionMessage(issue, state.planFileName as string), {
            deliverAs: "followUp",
            triggerTurn: true,
          });
          persistState();
          return;
        }
        // A repeat failure only notifies; the corrective turn cannot loop.
        ctx.ui.notify(issue, "warning");
      }

      persistState();

      if (state.todos.length === 0) return;

      const choice = await ctx.ui.select("Plan mode - what next?", [
        "Execute the plan",
        "Continue planning",
        "Refine the plan",
      ]);

      if (choice === "Execute the plan") {
        startExecuting(ctx);
      } else if (choice === "Refine the plan") {
        const refinement = await ctx.ui.editor("Refine the plan:", "");
        if (refinement?.trim()) {
          pi.sendMessage(todoListMessage(state.todos), { deliverAs: "followUp" });
          pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
        }
      }
      return;
    }

    // overview phase: extraction reads the assistant message.
    const lastAssistant = event.messages.findLast(isAssistantMessage);
    if (lastAssistant) {
      const text = getTextContent(lastAssistant);
      const extracted = extractTodoItems(text);
      if (extracted.length > 0) {
        state.todos = extracted;
        state.formatWarned = false;
      } else {
        // SAFETY: extraction is empty, so planFormatIssue names a problem.
        const issue = planFormatIssue(text) as string;
        if (!state.formatWarned) {
          state.formatWarned = true;
          ctx.ui.notify("Plan format invalid - asking for a rewrite", "warning");
          pi.sendMessage(formatCorrectionMessage(issue), {
            deliverAs: "followUp",
            triggerTurn: true,
          });
          persistState();
          return;
        }
        // A repeat failure only notifies; the corrective turn cannot loop.
        ctx.ui.notify(issue, "warning");
      }
    }

    persistState();

    const baseChoices = ["Continue planning", "Write plan to file"];
    const choices = state.todos.length > 0 ? [...baseChoices, "Execute plan"] : baseChoices;
    const choice = await ctx.ui.select("Plan mode - what next?", choices);

    if (choice === "Write plan to file") {
      await startPlanFile(ctx);
      return;
    }

    if (choice === "Execute plan") {
      // SAFETY: the Execute plan option only exists when todos exist.
      leaveOverview();
      startExecuting(ctx);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // setStatus texts share one footer line with no key labels, so the plan
    // status renders in its own widget below the editor, like the hooks one.
    ctx.ui.setWidget(
      "plan-status",
      (tui, theme) => {
        const component = {
          render: (): string[] => renderPlanStatus(state, theme),
          invalidate: (): void => tui.requestRender(),
        };
        state.statusWidget = component;
        return component;
      },
      { placement: "belowEditor" },
    );

    if (pi.getFlag("plan") === true) {
      state.phase = "overview";
    }

    const entries = ctx.sessionManager.getEntries();

    const planEntry = entries.findLast(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "plan-mode",
    ) as { data?: PersistedState } | undefined;

    if (planEntry?.data) {
      state.phase = planEntry.data.phase ?? state.phase;
      state.todos = planEntry.data.todos ?? state.todos;
      state.planFileName = planEntry.data.planFileName ?? state.planFileName;
    }

    if (state.phase === "overview") {
      enterOverview();
    }

    const isResume = planEntry !== undefined;

    if (isResume && state.phase === "executing" && state.todos.length > 0) {
      // Scan only messages after the last execute marker, so [DONE:n] tags
      // from previous plans never leak into the restored list.
      const executeIndex = entries.findLastIndex(
        (entry) => (entry as { customType?: string }).customType === "plan-mode-execute",
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

    const planFileMissing =
      state.phase === "plan-file" &&
      (state.planFileName === null || !planFileExists(state.planFileName, deps));

    if (planFileMissing && ctx.hasUI) {
      const chosen = await promptForPlanFileName(ctx);
      if (chosen !== null) {
        state.planFileName = chosen;
        persistState();
      } else {
        // A resumed session persists the cancellation too, so the log
        // records the decision instead of the stale plan-file phase.
        state.phase = "off";
        if (isResume) persistState();
      }
    } else if (planFileMissing) {
      // Headless run: no UI to prompt, so fall back silently.
      state.planFileName = DEFAULT_PLAN_FILE_NAME;
      persistState();
    } else if (isResume || state.phase !== "off") {
      // A resumed session (or one started with the flag) keeps its phase
      // in the entry log, so the next session restores the same phase.
      persistState();
    }

    updateStatus(ctx);
  });
};

const planModeExtension = (pi: ExtensionAPI): void => {
  createPlanModeExtension(pi);
};

export default planModeExtension;
