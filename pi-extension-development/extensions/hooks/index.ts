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
 *   `"when": "dirty"`, it only runs after the session edited or wrote a
 *   file matching one of the configured `paths` patterns.
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
  status: HookStatus | null;
  widget: { invalidate(): void } | null;
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
  status: null,
  widget: null,
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

/** Combined hook output: stdout and stderr, whichever the hook wrote to. */
const outputOf = (result: ExecResult): string => {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout === "") return stderr;
  if (stderr === "") return stdout;
  return `${stdout}\n${stderr}`;
};

const describeFailure = (result: ExecResult): string => {
  const prefix = result.killed ? "Hook timed out" : `Hook failed (exit ${result.code})`;
  const output = tail(outputOf(result));
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

  pi.on("tool_call", async (event, ctx) => {
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
    ensureConfig(ctx.cwd);
    if (configState.error || !configState.config) return;

    const hook = configState.config.agent_settled;
    if (!hook) return;
    if (hook.when === "dirty" && !state.dirty) return;
    if (state.running) return;

    const label = hook.status;
    if (label) updateStatus(state, { label, kind: "running" });
    state.running = true;
    try {
      const result = await runHook(hook.command, "", ctx.cwd, timeoutOf(hook), deps);
      if (hook.when === "dirty") state.dirty = false;
      if (label)
        updateStatus(state, {
          label,
          kind: result.killed || result.code !== 0 ? "failed" : "complete",
        });

      if (result.killed || result.code !== 0) {
        const failure = describeFailure(result);
        ctx.ui.notify(failure, "error");
        pi.sendMessage(
          { customType: "hooks-failure", content: failure, display: true },
          { deliverAs: "steer", triggerTurn: true },
        );
      } else {
        const output = tail(outputOf(result));
        ctx.ui.notify(output === "" ? "Hook passed" : output, "info");
      }
    } catch (error) {
      // The hook never ran, so the changes stay unverified: dirty survives
      // and the next settle retries. Only the running flag must always reset.
      if (label) updateStatus(state, { label, kind: "failed" });
      const failure = describeError(error);
      ctx.ui.notify(failure, "error");
      pi.sendMessage(
        { customType: "hooks-failure", content: failure, display: true },
        { deliverAs: "steer", triggerTurn: true },
      );
    } finally {
      state.running = false;
    }
  });
};

export default createHooksExtension;
