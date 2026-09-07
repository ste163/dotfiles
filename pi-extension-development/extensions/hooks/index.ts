/**
 * hooks — config-driven shell hooks for pi.
 *
 * Reads `.pi/hooks.json` from the project root and runs the configured
 * shell commands on pi events (the Copilot CLI / Claude Code hooks model):
 *
 * - `tool_call`: the tool input JSON is passed as the last argument. A
 *   non-zero exit blocks the tool call with stdout as the reason.
 * - `agent_settled`: the command runs when the agent settles. With
 *   `"when": "dirty"`, it only runs after the session edited or wrote a
 *   file matching one of the configured `paths` patterns.
 *
 * The policy lives in the scripts, not here — this extension only wires
 * events to commands.
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
import { DEFAULT_TIMEOUT_MS, loadConfig } from "./config.ts";
import { defaultDeps, type HooksDeps } from "./deps.ts";
import { matchesAny, relativePath, shellQuote } from "./match.ts";

export { defaultDeps, type HooksDeps };

interface HooksState {
  dirty: boolean;
  running: boolean;
  status: HookStatus | null;
  widget: { invalidate(): void } | null;
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

const describeFailure = (result: ExecResult): string => {
  const prefix = result.killed ? "Hook timed out" : `Hook failed (exit ${result.code})`;
  const output = tail(result.stdout);
  return output === "" ? prefix : `${prefix}: ${output}`;
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
  const { config, error } = loadConfig(deps);
  if (error) {
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(error, "warning"));
    return;
  }
  if (!config) return;

  const state = createState();
  const settled = config.agent_settled;
  const dirtyPatterns = settled && settled.when === "dirty" ? settled.paths : [];
  if (settled?.status) {
    // A widget gives the hooks status its own section; setStatus texts all
    // share one footer line with no key labels.
    pi.on("session_start", (_event, ctx) => {
      updateStatus(state, null);
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
  }

  pi.on("tool_call", async (event, ctx) => {
    if (
      dirtyPatterns.length > 0 &&
      isPathToolCall(event) &&
      matchesAny(relativePath(event.input.path, ctx.cwd), dirtyPatterns)
    ) {
      state.dirty = true;
    }

    const hook = config.tool_call;
    if (!hook) return;
    if (hook.tools && !hook.tools.includes(event.toolName)) return;

    const result = await runHook(
      hook.command,
      JSON.stringify(event.input),
      ctx.cwd,
      timeoutOf(hook),
      deps,
    );
    if (result.killed || result.code !== 0) {
      return { block: true, reason: result.stdout.trim() || "Blocked by hook" };
    }
    return;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const hook = config.agent_settled;
    if (!hook) return;
    if (hook.when === "dirty" && !state.dirty) return;
    if (state.running) return;

    const label = hook.status;
    if (label) updateStatus(state, { label, kind: "running" });
    state.running = true;
    const result = await runHook(hook.command, "", ctx.cwd, timeoutOf(hook), deps);
    state.running = false;
    if (hook.when === "dirty") state.dirty = false;
    if (label) {
      updateStatus(state, {
        label,
        kind: result.killed || result.code !== 0 ? "failed" : "complete",
      });
    }

    if (result.killed || result.code !== 0) {
      ctx.ui.notify(describeFailure(result), "error");
    } else {
      const output = tail(result.stdout);
      ctx.ui.notify(output === "" ? "Hook passed" : output, "info");
    }
  });
};

export default createHooksExtension;
