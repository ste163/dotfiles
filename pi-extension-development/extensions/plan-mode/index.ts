/**
 * plan-mode — discussion-first planning with explicit phase transitions.
 *
 * /plan toggles between off and overview. Overview removes the built-in
 * write and edit tools from the active set and gates bash to a read-only
 * allowlist, so the plan lives only in the conversation. From overview the
 * user approves one path: continue planning, write the plan to a file
 * (plan-file phase: only that one file is writable), or execute the plan
 * (executing phase: full access; the model registers each completed step
 * with the plan_step_complete tool, and the extension runs the
 * progress-check protocol when a run writes but registers nothing).
 *
 * Scope: this extension covers the built-in write and edit tools plus the
 * bash tool. Tools registered by other extensions or MCP servers are not
 * gated. The bash gate is a best-effort guardrail, not a security boundary.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import {
  defineTool,
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
  executeText,
  formatCorrectionMessage,
  overviewContextMessage,
  planFileContextMessage,
  planFileCorrectionMessage,
  progressAckMessage,
  progressCheckText,
  registeredStepResult,
  stepAlreadyRegisteredReason,
  stepNotNextReason,
  stepOutOfRangeReason,
  stepToolPhaseReason,
  todoListMessage,
  writePlanFileMessage,
} from "./messages.ts";
import {
  DEFAULT_PLAN_FILE_NAME,
  extractTodoItems,
  hasOpenQuestions,
  isSafeCommand,
  missingSteps,
  planFormatIssue,
  sameNumbers,
  toBaseName,
  type TodoItem,
  withMdExt,
} from "./utils.ts";

type Phase = "off" | "overview" | "plan-file" | "executing";

const WRITE_TOOL_NAMES: readonly string[] = ["write", "edit"];
const PLAN_TOOL_NAME = "plan_step_complete";

// The todo widget shows a sliding window: up to TODO_WINDOW_SIZE steps, and
// once TODO_WINDOW_DROP_AFTER of them complete, the completed ones drop for
// good and only the next pending steps stay visible. Display only: the
// model still gets the full list in the execution context.
const TODO_WINDOW_SIZE = 4;
const TODO_WINDOW_DROP_AFTER = 2;

/** Display and trigger artifacts; they never enter the model's context. */
const DROPPED_TYPES: readonly string[] = [
  "plan-mode-todo-list",
  "plan-mode-execute",
  "plan-mode-complete",
];

/**
 * Steering messages. Only the newest copy of each enters the model's
 * context, and only while plan mode is active. When plan mode is off,
 * none of them do. The transcript keeps every message regardless.
 */
const STEERING_TYPES: readonly string[] = [
  "plan-mode-overview-context",
  "plan-mode-file-context",
  "plan-mode-execution-context",
  "plan-mode-plan-format",
  "plan-mode-write-file",
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
  /** Write/edit tool calls in the current run; reset at agent_start. */
  runWriteCalls: number;
  /** Steps registered with plan_step_complete in the current run; reset at agent_start. */
  runRegistered: number;
  /** Missing step numbers while a progress check is open; null = no open check. Never persisted. */
  checkMissing: number[] | null;
  /** True once the todo widget dropped its first batch of completed items. */
  todoDropped: boolean;
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
  runWriteCalls: 0,
  runRegistered: 0,
  checkMissing: null,
  todoDropped: false,
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
  if (hasOpenQuestions(content)) {
    return `${lockedName} still has a '## Questions' section - fold the answers into Reasoning and remove it`;
  }
  // SAFETY: non-empty content without questions that extracted nothing, so
  // planFormatIssue names the exact problem instead of returning null.
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
    pi.setActiveTools(
      state.toolsBeforeOverview.filter(
        (name) => !WRITE_TOOL_NAMES.includes(name) && name !== PLAN_TOOL_NAME,
      ),
    );
  };

  const leaveOverview = (): void => {
    if (state.toolsBeforeOverview !== null) {
      pi.setActiveTools(state.toolsBeforeOverview);
      state.toolsBeforeOverview = null;
    }
  };

  // The plan tool exists only for the executing phase: it is kept out of
  // the active set everywhere else, on top of the tool_call phase guard.
  const setPlanToolActive = (active: boolean): void => {
    const tools = pi.getActiveTools();
    const has = tools.includes(PLAN_TOOL_NAME);
    if (active === has) return;
    pi.setActiveTools(
      active ? [...tools, PLAN_TOOL_NAME] : tools.filter((name) => name !== PLAN_TOOL_NAME),
    );
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (state.phase === "executing" && state.todos.length > 0) {
      let visible: TodoItem[];
      if (state.todoDropped) {
        visible = state.todos.filter((item) => !item.completed).slice(0, TODO_WINDOW_SIZE);
      } else {
        visible = state.todos.slice(0, TODO_WINDOW_SIZE);
        const completedInWindow = visible.filter((item) => item.completed).length;
        if (completedInWindow >= TODO_WINDOW_DROP_AFTER) {
          // The first batch dropped: from now on only pending steps show,
          // so a stuck pending step cannot freeze the window.
          state.todoDropped = true;
          visible = state.todos.filter((item) => !item.completed).slice(0, TODO_WINDOW_SIZE);
        }
      }
      const lines = visible.map((item) =>
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
    state.todoDropped = false;
    state.checkMissing = null;
    setPlanToolActive(true);
    updateStatus(ctx);
    persistState();

    pi.sendMessage(todoListMessage(state.todos), { deliverAs: "followUp" });
    pi.sendMessage(executeMessage(state.todos, first), { deliverAs: "followUp" });
    // The user message is the real turn trigger. Queued as a follow-up, it
    // reaches the model through the post-run continuation, which never gets
    // the before_agent_start injection.
    pi.sendUserMessage(executeText(state.todos, first), { deliverAs: "followUp" });
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
    setPlanToolActive(false);
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
      state.todoDropped = false;
      state.checkMissing = null;
      ctx.ui.notify(
        "Plan mode enabled (overview). Write and edit tools are disabled. Discuss the plan first.",
      );
    } else {
      if (state.phase === "overview") leaveOverview();
      state.phase = "off";
      state.todos = [];
      state.todoDropped = false;
      state.checkMissing = null;
      setPlanToolActive(false);
      ctx.ui.notify("Plan mode disabled. Full access restored.");
    }
    updateStatus(ctx);
    persistState();
  };

  // Validates a plan_step_complete call. Allowed calls mark the step, so
  // registration is a validated tool_call: wrong, duplicate, and
  // out-of-order calls are blocked with a reason naming the problem.
  const registerStep = (
    stepRaw: unknown,
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined => {
    if (state.phase !== "executing") {
      return { block: true, reason: stepToolPhaseReason() };
    }
    const step = Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > state.todos.length) {
      return {
        block: true,
        reason: stepOutOfRangeReason(
          Number.isInteger(step) ? step : String(stepRaw),
          state.todos.length,
        ),
      };
    }
    // SAFETY: the range check above keeps the index inside the todo list.
    const item = state.todos[step - 1] as TodoItem;
    if (item.completed) {
      return { block: true, reason: stepAlreadyRegisteredReason(step) };
    }
    // SAFETY: item is incomplete, so the first pending step always exists.
    const pending = state.todos.find((t) => !t.completed) as TodoItem;
    if (pending.step !== step) {
      return { block: true, reason: stepNotNextReason(step, pending) };
    }

    state.todos = state.todos.map((t) => (t.step === step ? { ...t, completed: true } : t));
    state.runRegistered += 1;
    updateStatus(ctx);
    persistState();
    return;
  };

  pi.registerTool(
    defineTool({
      name: PLAN_TOOL_NAME,
      label: "Plan step complete",
      description:
        "Register one completed step of the executing plan. Call once per step, in order, right after the step's work finished. The tool blocks calls for the wrong, duplicate, or out-of-order step and reports the registered count.",
      promptSnippet:
        "plan_step_complete(step) — register a completed plan step (executing phase only)",
      parameters: Type.Object({
        step: Type.Integer({ description: "Plan step number to register", minimum: 1 }),
      }),
      defaultActive: false,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        // SAFETY: the tool_call handler validated and marked the step
        // before execution, so the index resolves to the registered item.
        const item = state.todos[params.step - 1] as TodoItem;
        const completed = state.todos.filter((t) => t.completed).length;
        return {
          content: [
            { type: "text", text: registeredStepResult(item, completed, state.todos.length) },
          ],
          details: { step: params.step },
        };
      },
    }),
  );

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

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === PLAN_TOOL_NAME) {
      return registerStep((event.input as { step?: unknown }).step, ctx);
    }

    // Progress tracking: during execution, write and edit calls are the
    // signal that a step may have completed without registration.
    if (
      state.phase === "executing" &&
      (isToolCallEventType("write", event) || isToolCallEventType("edit", event))
    ) {
      state.runWriteCalls += 1;
      return;
    }

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
    const lastSteeringIndex = new Map<string, number>();
    event.messages.forEach((message, index) => {
      const customType = (message as AgentMessage & { customType?: string }).customType;
      if (customType !== undefined && STEERING_TYPES.includes(customType)) {
        lastSteeringIndex.set(customType, index);
      }
    });

    return {
      messages: event.messages.filter((m, index) => {
        const msg = m as AgentMessage & { customType?: string };
        const customType = msg.customType;

        if (customType !== undefined && DROPPED_TYPES.includes(customType)) {
          // Display and trigger artifacts never enter the model's context.
          return false;
        }
        if (customType !== undefined && STEERING_TYPES.includes(customType)) {
          // Only the newest steering copy survives, and only while plan
          // mode is active. Off drops every plan-mode message.
          return state.phase !== "off" && lastSteeringIndex.get(customType) === index;
        }

        if (msg.role !== "user" || state.phase !== "off") return true;

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

  // Per-run counters reset here: agent_start fires for every run,
  // including post-run continuations that never get before_agent_start.
  pi.on("agent_start", () => {
    state.runWriteCalls = 0;
    state.runRegistered = 0;
  });

  pi.on("before_agent_start", () => {
    // Re-assert the tool gate at every agent run: a mid-session extension
    // reload re-registers the tool inactive, and only this handler re-runs
    // for a restored executing phase.
    setPlanToolActive(state.phase === "executing");

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

  // Registration happens at tool_call time and persists right away, so
  // turn_end only checkpoints the state.
  pi.on("turn_end", () => {
    if (state.phase !== "executing" || state.todos.length === 0) return;
    persistState();
  });

  // Sends a progress check naming every missing step with its file path.
  const fireProgressCheck = (missing: number[], reason: "write" | "narrowed"): void => {
    const completed = state.todos.filter((t) => t.completed).length;
    pi.sendUserMessage(
      progressCheckText(
        state.todos.filter((t) => missing.includes(t.step)),
        completed,
        state.todos.length,
        reason,
      ),
      { deliverAs: "followUp" },
    );
  };

  // The check protocol: one check per state. A reply that changes the
  // missing set re-fires once with the narrowed set; a reply that does
  // not closes the check with an ack, so nothing ever loops.
  const handleProgressCheck = (missing: number[]): void => {
    if (state.checkMissing !== null) {
      if (sameNumbers(missing, state.checkMissing)) {
        const completed = state.todos.filter((t) => t.completed).length;
        pi.sendMessage(progressAckMessage(missing, completed, state.todos.length), {
          triggerTurn: false,
        });
        state.checkMissing = null;
      } else {
        state.checkMissing = missing;
        fireProgressCheck(missing, "narrowed");
      }
      return;
    }

    if (state.runWriteCalls > 0 && state.runRegistered === 0) {
      state.checkMissing = missing;
      fireProgressCheck(missing, "write");
    }
  };

  pi.on("agent_end", async (event, ctx) => {
    if (state.phase === "executing" && state.todos.length > 0) {
      const missing = missingSteps(state.todos).map((t) => t.step);

      if (missing.length === 0) {
        pi.sendMessage(completeMessage(state.todos), { triggerTurn: false });
        state.phase = "off";
        state.todos = [];
        state.checkMissing = null;
        updateStatus(ctx);
        persistState();
        return;
      }

      handleProgressCheck(missing);
      return;
    }

    if ((state.phase !== "overview" && state.phase !== "plan-file") || !ctx.hasUI) return;

    // plan-file phase: the plan file is the source of truth. The chat
    // message is not consulted - the agent writes the plan into the file,
    // so its reply can be anything without triggering a correction.
    if (state.phase === "plan-file") {
      const content = planFileContent(state, deps);
      const openQuestions = content !== null && hasOpenQuestions(content);
      const extracted = content === null ? [] : extractTodoItems(content);
      if (extracted.length > 0 && !openQuestions) {
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
    let openQuestions = false;
    const lastAssistant = event.messages.findLast(isAssistantMessage);
    if (lastAssistant) {
      const text = getTextContent(lastAssistant);
      const extracted = extractTodoItems(text);
      if (extracted.length > 0) {
        state.todos = extracted;
        state.formatWarned = false;
        openQuestions = hasOpenQuestions(text);
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
    // Execute appears only when a plan parsed and no questions are open:
    // the user answers them first and the model folds the answers back.
    const choices =
      state.todos.length > 0 && !openQuestions ? [...baseChoices, "Execute plan"] : baseChoices;
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
    } else if (state.phase === "executing") {
      setPlanToolActive(true);
    } else {
      setPlanToolActive(false);
    }

    const isResume = planEntry !== undefined;

    if (isResume && state.phase === "executing" && state.todos.length > 0) {
      // Scan only entries after the last execute marker, so registrations
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
      const registered = messages.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "toolCall" &&
          block.name === PLAN_TOOL_NAME &&
          typeof block.arguments?.["step"] === "number"
            ? [block.arguments["step"] as number]
            : [],
        ),
      );
      state.todos = state.todos.map((t) =>
        registered.includes(t.step) ? { ...t, completed: true } : t,
      );
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
