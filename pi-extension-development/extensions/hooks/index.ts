/**
 * hooks — config-driven shell hooks for pi.
 *
 * Reads `.pi/hooks.json` from the session cwd and runs the configured
 * shell commands on pi events (the Copilot CLI / Claude Code hooks model):
 *
 * - `tool_call`: the tool input JSON is passed as the last argument. A
 *   non-zero exit blocks the tool call with the hook's stdout/stderr as
 *   the reason.
 * - `agent_settled`: the command runs when the agent settles. With
 *   `"when": "dirty"`, it runs after the session edited or wrote a file
 *   matching one of the configured `paths` patterns, and keeps re-running
 *   on each settle while the last run failed - so a failure fixed through
 *   bash (which never marks dirty) still gets re-verified. A failure is
 *   injected into the session on the first failure, again after new edits,
 *   and again when the failure message changes; the failed status stays
 *   visible until a run passes.
 *
 * The config loads lazily on the first event, resolved against the session
 * cwd — never `process.cwd()`, which can diverge from it. The policy lives
 * in the scripts, not here — this extension only wires events to commands.
 */

import {
  isToolCallEventType,
  type EditToolCallEvent,
  type ExecResult,
  type ExtensionAPI,
  type Theme,
  type ToolCallEvent,
  type WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT_MS, loadConfig, type HooksConfig } from "./config.ts";
import { defaultDeps, type HooksDeps } from "./deps.ts";
import { matchesAny, relativePath, shellQuote } from "./match.ts";

interface HooksState {
  dirty: boolean;
  running: boolean;
  failed: boolean;
  lastFailure: string | null;
  status: HookStatus | null;
  widget: { invalidate(): void } | null;
  /** True when the current run ended because the user aborted it. */
  abortedByUser: boolean;
}

interface ConfigState {
  loaded: boolean;
  config: HooksConfig | null;
  error: string | null;
}

type StatusKind = "running" | "complete" | "failed";

interface HookStatus {
  label: string;
  kind: StatusKind;
}

const createState = (): HooksState => ({
  dirty: false,
  running: false,
  failed: false,
  lastFailure: null,
  status: null,
  widget: null,
  abortedByUser: false,
});

const createConfigState = (): ConfigState => ({ loaded: false, config: null, error: null });

const isPathToolCall = (event: ToolCallEvent): event is EditToolCallEvent | WriteToolCallEvent =>
  isToolCallEventType("edit", event) || isToolCallEventType("write", event);

const timeoutOf = (hook: { timeout?: number }): number => hook.timeout ?? DEFAULT_TIMEOUT_MS;

const runHook = async (
  command: string,
  payload: string,
  cwd: string,
  timeout: number,
  deps: HooksDeps,
): Promise<ExecResult> => {
  const fullCommand = payload === "" ? command : `${command} ${shellQuote(payload)}`;
  return deps.exec("sh", ["-c", fullCommand], { cwd, timeout });
};

const tail = (text: string, max = 300): string => {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(-max);
};

/** The steered failure message keeps enough tail to include diffs and coverage reports. */
const FAILURE_MESSAGE_MAX = 10_000;

/** Combined hook output: stdout and stderr, whichever the hook wrote to. */
const outputOf = (result: ExecResult): string => {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout === "") return stderr;
  if (stderr === "") return stdout;
  return `${stdout}\n${stderr}`;
};

const describeFailure = (result: ExecResult, max = 300): string => {
  const prefix = result.killed ? "Hook timed out" : `Hook failed (exit ${result.code})`;
  const output = tail(outputOf(result), max);
  return output === "" ? prefix : `${prefix}: ${output}`;
};

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `Hook error: ${message}`;
};

const statusColor = (kind: StatusKind): "success" | "error" | "dim" =>
  kind === "complete" ? "success" : kind === "failed" ? "error" : "dim";

const renderStatusLine = (status: HookStatus | null, theme: Theme): string[] =>
  status
    ? [
        ` ${theme.fg("accent", "hooks")}  ${theme.fg(statusColor(status.kind), `${status.label}, ${status.kind}`)}`,
      ]
    : [];

const updateStatus = (state: HooksState, status: HookStatus | null): void => {
  state.status = status;
  state.widget?.invalidate();
};

export const createHooksExtension = (pi: ExtensionAPI, deps: HooksDeps = defaultDeps(pi)): void => {
  const state = createState();
  const configState = createConfigState();

  // The config path resolves against the session cwd, which only exists on
  // the first event - so the config loads lazily, once per extension lifetime.
  const ensureConfig = (cwd: string): void => {
    if (configState.loaded) return;
    configState.loaded = true;
    const loaded = loadConfig(deps, cwd);
    configState.config = loaded.config;
    configState.error = loaded.error;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    ensureConfig(ctx.cwd);
    if (configState.error) {
      ctx.ui.notify(configState.error, "warning");
      return;
    }
    if (!configState.config) return;

    updateStatus(state, null);
    // A widget gives the hooks status its own section; setStatus texts all
    // share one footer line with no key labels.
    if (configState.config.agent_settled?.status)
      ctx.ui.setWidget(
        "hooks",
        (tui, theme) => {
          const component = {
            render: () => renderStatusLine(state.status, theme),
            invalidate: () => tui.requestRender(),
          };
          state.widget = component;
          return component;
        },
        { placement: "belowEditor" },
      );
  });

  // A failed status stays visible until a later run passes, so an unfixed
  // failure is not silently cleared by the next turn. Running and complete
  // statuses are transient and clear as before. A new turn is a fresh run,
  // so an abort from an earlier turn no longer applies.
  pi.on("turn_start", () => {
    state.abortedByUser = false;
    if (state.status?.kind !== "failed") updateStatus(state, null);
  });

  pi.on("turn_end", (event) => {
    const message = event.message;
    if (message.role === "assistant" && message.stopReason === "aborted")
      state.abortedByUser = true;
  });

  pi.on("agent_end", (event) => {
    const aborted = event.messages.findLast(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    );
    if (aborted) state.abortedByUser = true;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    ensureConfig(ctx.cwd);
    if (configState.error || !configState.config) return;

    const settled = configState.config.agent_settled;
    if (
      settled?.when === "dirty" &&
      isPathToolCall(event) &&
      matchesAny(relativePath(event.input.path, ctx.cwd), settled.paths)
    )
      state.dirty = true;

    const hook = configState.config.tool_call;
    if (!hook) return;
    if (hook.tools && !hook.tools.includes(event.toolName)) return;

    const result = await runHook(
      hook.command,
      JSON.stringify(event.input),
      ctx.cwd,
      timeoutOf(hook),
      deps,
    );
    if (result.killed || result.code !== 0)
      return { block: true, reason: tail(outputOf(result)) || "Blocked by hook" };
    return;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    // A user abort is a hard stop: no hook runs and nothing re-engages the
    // agent. The signal check also covers aborts before any assistant
    // message was finalized, which the message check cannot see.
    if (ctx.signal?.aborted || state.abortedByUser) return;
    ensureConfig(ctx.cwd);
    if (configState.error || !configState.config) return;

    const hook = configState.config.agent_settled;
    if (!hook) return;

    // A failed run stays pending until a later run passes, so the next
    // settle re-runs even without new edits. A failure fixed through bash
    // (which never marks dirty) is still re-verified this way.
    const wasFailed = state.failed;
    if (hook.when === "dirty" && !state.dirty && !wasFailed) return;
    if (state.running) return;

    const label = hook.status;
    if (label) updateStatus(state, { label, kind: "running" });
    state.running = true;
    try {
      const result = await runHook(hook.command, "", ctx.cwd, timeoutOf(hook), deps);
      const dirtyRun = hook.when === "dirty" && state.dirty;
      if (hook.when === "dirty") state.dirty = false;

      const failedRun = result.killed || result.code !== 0;
      state.failed = failedRun;
      if (label) updateStatus(state, { label, kind: failedRun ? "failed" : "complete" });

      if (failedRun) {
        const failure = describeFailure(result);
        ctx.ui.notify(failure, "error");
        // The toast keeps a short tail; the steered message keeps a long
        // one, so diffs and the coverage report reach the agent in one turn.
        const steered = describeFailure(result, FAILURE_MESSAGE_MAX);
        // Steer the agent on the first failure, when it edited files and
        // still failed, and when the failure message changed - new output
        // is new information. A repeated identical failure with no new
        // changes only refreshes the status, so the loop cannot run forever.
        if (!wasFailed || dirtyRun || steered !== state.lastFailure) {
          pi.sendMessage(
            { customType: "hooks-failure", content: steered, display: true },
            { deliverAs: "steer", triggerTurn: true },
          );
        }
        state.lastFailure = steered;
      } else {
        state.lastFailure = null;
        const output = tail(outputOf(result));
        ctx.ui.notify(output === "" ? "Hook passed" : output, "info");
      }
    } catch (error) {
      // The hook never ran, so the failure carries the retry obligation:
      // the next settle re-runs regardless of dirty. Only the running flag
      // must always reset.
      state.failed = true;
      if (label) updateStatus(state, { label, kind: "failed" });
      const failure = describeError(error);
      ctx.ui.notify(failure, "error");
      if (!wasFailed || failure !== state.lastFailure) {
        pi.sendMessage(
          { customType: "hooks-failure", content: failure, display: true },
          { deliverAs: "steer", triggerTurn: true },
        );
      }
      state.lastFailure = failure;
    } finally {
      state.running = false;
    }
  });
};

export default createHooksExtension;
