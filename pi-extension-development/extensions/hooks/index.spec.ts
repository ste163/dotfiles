import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExecResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import createHooksExtension from "./index.ts";
import { defaultDeps, type HooksDeps } from "./deps.ts";

type Pi = Parameters<typeof createHooksExtension>[0];
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
  handlers: Record<string, Handler[]>;
  execCalls: { command: string; args: string[]; options: unknown }[];
  sentMessages: {
    message: { customType: string; content: string; display: boolean };
    options: unknown;
  }[];
  on(event: string, handler: Handler): void;
  exec(command: string, args: string[], options: unknown): Promise<ExecResult>;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: unknown,
  ): void;
}

const createFakePi = (): FakePi => {
  const handlers: Record<string, Handler[]> = {};
  const execCalls: { command: string; args: string[]; options: unknown }[] = [];
  const sentMessages: {
    message: { customType: string; content: string; display: boolean };
    options: unknown;
  }[] = [];
  return {
    handlers,
    execCalls,
    sentMessages,
    on(event, handler) {
      handlers[event] = [...(handlers[event] ?? []), handler];
    },
    exec(command, args, options) {
      execCalls.push({ command, args, options });
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
};

interface FakeDeps extends HooksDeps {
  execCalls: { command: string; args: string[]; options: unknown }[];
}

const createFakeDeps = (config: string | null, results: ExecResult[] = []): FakeDeps => {
  const execCalls: { command: string; args: string[]; options: unknown }[] = [];
  return {
    execCalls,
    readFile: () => config,
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return results.shift() ?? { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
};

interface Notification {
  message: string;
  type?: string;
}

interface FakeTheme {
  fg(color: string, text: string): string;
}

interface FakeTui {
  requestRender(): void;
}

interface WidgetComponent {
  render(): string[];
  invalidate(): void;
}

interface WidgetMount {
  key: string;
  factory: (tui: FakeTui, theme: FakeTheme) => WidgetComponent;
  options: unknown;
}

const createFakeTheme = (): FakeTheme => ({
  fg: (color, text) => `${color}:${text}`,
});

const createFakeCtx = (): {
  ctx: ExtensionContext;
  notifications: Notification[];
  widgets: WidgetMount[];
} => {
  const notifications: Notification[] = [];
  const widgets: WidgetMount[] = [];
  const ctx = {
    cwd: "/virtual/repo",
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push(type ? { message, type } : { message });
      },
      setWidget: (key: string, factory: WidgetMount["factory"], options: unknown) => {
        widgets.push({ key, factory, options });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, widgets };
};

// Handlers must run in registration order, so the walk is genuinely
// sequential and recursion replaces a loop with await inside.
const callHandler = async (
  pi: FakePi,
  event: string,
  eventPayload: unknown,
  ctx: unknown,
): Promise<unknown> => {
  const list = pi.handlers[event] ?? [];
  const runFrom = async (index: number): Promise<unknown> => {
    const handler = list[index];
    if (!handler) return undefined;
    const result = await handler(eventPayload, ctx);
    return result === undefined ? runFrom(index + 1) : result;
  };
  return runFrom(0);
};

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const failed = (stdout = "boom"): ExecResult => ({ stdout, stderr: "", code: 1, killed: false });

const FULL_CONFIG = JSON.stringify({
  tool_call: { command: "sh scripts/hooks/pre-tool.sh", tools: ["bash"] },
  agent_settled: {
    command: "sh scripts/hooks/verify.sh",
    when: "dirty",
    paths: ["src/**", "AGENTS.md"],
  },
});

const SETTLED_ONLY_CONFIG = JSON.stringify({
  agent_settled: { command: "sh scripts/hooks/verify.sh", when: "dirty", paths: ["src/**"] },
});

const ALWAYS_SETTLED_CONFIG = JSON.stringify({
  agent_settled: { command: "sh scripts/hooks/verify.sh" },
});

const TOOL_CALL_ONLY_CONFIG = JSON.stringify({
  tool_call: { command: "sh scripts/hooks/pre-tool.sh" },
});

const STATUS_CONFIG = JSON.stringify({
  agent_settled: {
    command: "sh scripts/hooks/verify.sh",
    when: "dirty",
    paths: ["src/**"],
    status: "Verification",
  },
});

const bashCall = (command: string): unknown => ({ toolName: "bash", input: { command } });
const editCall = (path: string): unknown => ({ toolName: "edit", input: { path } });
const writeCall = (path: string): unknown => ({ toolName: "write", input: { path } });
const readCall = (path: string): unknown => ({ toolName: "read", input: { path } });

// --- Wiring ---

test("registers handlers that do nothing when the config file is missing", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(null);
  createHooksExtension(pi as unknown as Pi, deps);
  assert.deepEqual(Object.keys(pi.handlers).toSorted(), [
    "agent_settled",
    "session_start",
    "tool_call",
    "turn_start",
  ]);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  await callHandler(pi, "turn_start", {}, ctx);
  assert.equal(deps.execCalls.length, 0);
  assert.equal(notifications.length, 0);
});

test("warns on session start and ignores events when the config is invalid", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps("not json");
  createHooksExtension(pi as unknown as Pi, deps);
  assert.deepEqual(Object.keys(pi.handlers).toSorted(), [
    "agent_settled",
    "session_start",
    "tool_call",
    "turn_start",
  ]);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.ok(notifications[0]?.message.includes("Invalid JSON"));
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 0);
});

test("registers all handlers for a valid config", () => {
  const pi = createFakePi();
  createHooksExtension(pi as unknown as Pi, createFakeDeps(FULL_CONFIG));
  assert.deepEqual(Object.keys(pi.handlers).toSorted(), [
    "agent_settled",
    "session_start",
    "tool_call",
    "turn_start",
  ]);
});

test("loads the config from the session cwd on the first event", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG);
  const readPaths: string[] = [];
  const readFile = deps.readFile;
  deps.readFile = (path) => {
    readPaths.push(path);
    return readFile(path);
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", readCall("README.md"), ctx);
  assert.deepEqual(readPaths, ["/virtual/repo/.pi/hooks.json"]);
});

// --- tool_call: dirty tracking (first branch of the handler) ---

test("marks dirty when an edit touches a matching path, then clears it after a successful run", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [ok("passed")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/pages/home/App.tsx"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
  assert.equal(notifications[0]?.message, "passed");
  assert.equal(notifications[0]?.type, "info");
  assert.equal(pi.sentMessages.length, 0);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
});

test("does not mark dirty for edits outside the patterns", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("README.md"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 0);
});

test("marks dirty for writes on matching paths", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [ok()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", writeCall("AGENTS.md"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
});

test("marks dirty for edits with absolute paths under the cwd", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [ok()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("/virtual/repo/AGENTS.md"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
});

test("ignores read and bash calls for dirty tracking", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", readCall("src/pages/home/App.tsx"), ctx);
  await callHandler(pi, "tool_call", bashCall("bun test"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 0);
});

// --- tool_call: hook dispatch ---

test("skips the hook for tools outside the tools filter", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = await callHandler(pi, "tool_call", readCall("README.md"), ctx);
  assert.equal(result, undefined);
  assert.equal(deps.execCalls.length, 0);
});

test("runs the hook for every tool when no tools filter is set", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(TOOL_CALL_ONLY_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", readCall("README.md"), ctx);
  assert.equal(deps.execCalls.length, 1);
});

test("blocks the tool call when the hook exits non-zero", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [failed("requires macOS")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = (await callHandler(pi, "tool_call", bashCall("bun run build"), ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.equal(result.reason, "requires macOS");
});

test("blocks with a generic reason when the hook fails silently", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [failed("")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = (await callHandler(pi, "tool_call", bashCall("bun run build"), ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.equal(result.reason, "Blocked by hook");
});

test("blocks with the stderr output when the hook fails on stderr", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [
    { stdout: "", stderr: "requires macOS", code: 1, killed: false },
  ]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = (await callHandler(pi, "tool_call", bashCall("bun run build"), ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.equal(result.reason, "requires macOS");
});

test("blocks the tool call when the hook is killed", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG, [{ stdout: "", stderr: "", code: 0, killed: true }]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = (await callHandler(pi, "tool_call", bashCall("bun run build"), ctx)) as {
    block: boolean;
  };
  assert.equal(result.block, true);
});

test("truncates long hook output in block reasons", async () => {
  const pi = createFakePi();
  const longOutput = "x".repeat(500);
  const deps = createFakeDeps(FULL_CONFIG, [failed(longOutput)]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = (await callHandler(pi, "tool_call", bashCall("bun run build"), ctx)) as {
    block: boolean;
    reason: string;
  };
  assert.equal(result.block, true);
  assert.equal(result.reason, "x".repeat(300));
});

test("runs the tool_call hook with the input JSON as a quoted argument", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(FULL_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  const result = await callHandler(pi, "tool_call", bashCall("bun run build"), ctx);
  assert.equal(result, undefined);
  assert.equal(deps.execCalls.length, 1);
  assert.equal(deps.execCalls[0]?.command, "sh");
  assert.deepEqual(deps.execCalls[0]?.args, [
    "-c",
    `sh scripts/hooks/pre-tool.sh '{"command":"bun run build"}'`,
  ]);
  assert.deepEqual(deps.execCalls[0]?.options, { cwd: "/virtual/repo", timeout: 120_000 });
});

test("honors a configured timeout", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(JSON.stringify({ tool_call: { command: "sh x.sh", timeout: 5000 } }));
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", bashCall("bun test"), ctx);
  assert.deepEqual(deps.execCalls[0]?.options, { cwd: "/virtual/repo", timeout: 5000 });
});

// --- agent_settled: hook dispatch ---

test("does nothing on settle when no settled hook is configured", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(TOOL_CALL_ONLY_CONFIG);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 0);
});

test("skips a second run while one is in flight", async () => {
  const pi = createFakePi();
  const gate: { resolve: (result: ExecResult) => void } = { resolve: () => {} };
  const pending = new Promise<ExecResult>((resolve) => {
    gate.resolve = resolve;
  });
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG);
  deps.exec = async (command, args, options) => {
    deps.execCalls.push({ command, args, options });
    return pending;
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  const first = callHandler(pi, "agent_settled", {}, ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
  gate.resolve(ok());
  await first;
});

test("resets the running flag and retries on the next settle when the hook rejects", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG);
  deps.exec = async (command, args, options) => {
    deps.execCalls.push({ command, args, options });
    if (deps.execCalls.length === 1) throw new Error("spawn failed");
    return ok("passed");
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.type, "error");
  assert.equal(notifications[0]?.message, "Hook error: spawn failed");
  assert.equal(pi.sentMessages[0]?.message.content, "Hook error: spawn failed");
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 2);
  assert.equal(notifications[1]?.message, "passed");
});

test("shows a failed status when the hook rejects", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(STATUS_CONFIG);
  deps.exec = async (command, args, options) => {
    deps.execCalls.push({ command, args, options });
    throw new Error("spawn failed");
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const component = mountWidget(widgets, { requestRender: () => {} });
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  error:Verification, failed"]);
});

test("stringifies the reason when the hook rejects with a non-Error", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG);
  deps.exec = async (command, args, options) => {
    deps.execCalls.push({ command, args, options });
    throw "spawn failed";
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "Hook error: spawn failed");
});

const mountWidget = (widgets: WidgetMount[], tui: FakeTui): WidgetComponent => {
  const mount = widgets[0];
  assert.ok(mount, "expected a widget mount");
  return mount.factory(tui, createFakeTheme());
};

test("mounts the hooks widget on session start when a status label is configured", async () => {
  const pi = createFakePi();
  createHooksExtension(pi as unknown as Pi, createFakeDeps(STATUS_CONFIG));
  assert.deepEqual(Object.keys(pi.handlers).toSorted(), [
    "agent_settled",
    "session_start",
    "tool_call",
    "turn_start",
  ]);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.key, "hooks");
  assert.deepEqual(widgets[0]?.options, { placement: "belowEditor" });
  assert.deepEqual(mountWidget(widgets, { requestRender: () => {} }).render(), []);
});

test("shows the running status while the hook runs and complete after", async () => {
  const pi = createFakePi();
  const gate: { resolve: (result: ExecResult) => void } = { resolve: () => {} };
  const pending = new Promise<ExecResult>((resolve) => {
    gate.resolve = resolve;
  });
  const deps = createFakeDeps(STATUS_CONFIG);
  deps.exec = async (command, args, options) => {
    deps.execCalls.push({ command, args, options });
    return pending;
  };
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const renderCount = { value: 0 };
  const tui: FakeTui = {
    requestRender: () => {
      renderCount.value += 1;
    },
  };
  const component = mountWidget(widgets, tui);
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  const first = callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  dim:Verification, running"]);
  gate.resolve(ok());
  await first;
  assert.deepEqual(component.render(), [" accent:hooks  success:Verification, complete"]);
  assert.ok(renderCount.value > 0);
});

test("shows a failed status when the hook exits non-zero", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(STATUS_CONFIG, [failed()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const component = mountWidget(widgets, { requestRender: () => {} });
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  error:Verification, failed"]);
});

test("shows a failed status when the hook is killed", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(STATUS_CONFIG, [{ stdout: "", stderr: "", code: 0, killed: true }]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const component = mountWidget(widgets, { requestRender: () => {} });
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  error:Verification, failed"]);
});

test("leaves the widget unmounted when no status label is configured", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [ok()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(widgets.length, 0);
});

test("clears the status on session start", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(STATUS_CONFIG, [ok()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const component = mountWidget(widgets, { requestRender: () => {} });
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  success:Verification, complete"]);
  await callHandler(pi, "session_start", {}, ctx);
  assert.deepEqual(component.render(), []);
});

test("clears the status when a new turn starts", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(STATUS_CONFIG, [failed()]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  const component = mountWidget(widgets, { requestRender: () => {} });
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.deepEqual(component.render(), [" accent:hooks  error:Verification, failed"]);
  await callHandler(pi, "turn_start", {}, ctx);
  assert.deepEqual(component.render(), []);
});

test("notifies an error and clears dirty when the hook fails", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [failed("typecheck failed")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.type, "error");
  assert.ok(notifications[0]?.message.includes("Hook failed (exit 1)"));
  assert.ok(notifications[0]?.message.includes("typecheck failed"));
  assert.equal(pi.sentMessages.length, 1);
  assert.deepEqual(pi.sentMessages[0]?.message, {
    customType: "hooks-failure",
    content: "Hook failed (exit 1): typecheck failed",
    display: true,
  });
  assert.deepEqual(pi.sentMessages[0]?.options, { deliverAs: "steer", triggerTurn: true });
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 1);
});

test("notifies a bare failure message when the hook fails silently", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [failed("")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "Hook failed (exit 1)");
});

test("notifies the stderr output when the hook fails on stderr", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [
    { stdout: "", stderr: "typecheck failed", code: 1, killed: false },
  ]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.ok(notifications[0]?.message.includes("Hook failed (exit 1)"));
  assert.ok(notifications[0]?.message.includes("typecheck failed"));
});

test("combines stdout and stderr in failure notifications", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [
    { stdout: "out", stderr: "err", code: 1, killed: false },
  ]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.ok(notifications[0]?.message.includes("out\nerr"));
});

test("notifies stderr output when the hook succeeds with warnings", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [
    { stdout: "", stderr: "warning: deprecated", code: 0, killed: false },
  ]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "warning: deprecated");
  assert.equal(notifications[0]?.type, "info");
});

test("notifies a timeout when the hook is killed", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [
    { stdout: "", stderr: "", code: 0, killed: true },
  ]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "Hook timed out");
  assert.equal(pi.sentMessages[0]?.message.content, "Hook timed out");
});

test("notifies Hook passed when the hook succeeds silently", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [ok("")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "Hook passed");
  assert.equal(notifications[0]?.type, "info");
});

test("truncates long hook output in notifications", async () => {
  const pi = createFakePi();
  const longOutput = "x".repeat(500);
  const deps = createFakeDeps(SETTLED_ONLY_CONFIG, [ok(longOutput)]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx, notifications } = createFakeCtx();
  await callHandler(pi, "tool_call", editCall("src/x.ts"), ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(notifications[0]?.message, "x".repeat(300));
});

test("runs the settled hook on every settle when no when field is set", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(ALWAYS_SETTLED_CONFIG, [ok("passed"), ok("passed")]);
  createHooksExtension(pi as unknown as Pi, deps);
  const { ctx } = createFakeCtx();
  await callHandler(pi, "agent_settled", {}, ctx);
  await callHandler(pi, "agent_settled", {}, ctx);
  assert.equal(deps.execCalls.length, 2);
});

test("does not mount a widget without a status label", async () => {
  const pi = createFakePi();
  createHooksExtension(pi as unknown as Pi, createFakeDeps(FULL_CONFIG));
  const { ctx, widgets } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);
  assert.equal(widgets.length, 0);
});

// --- Default deps ---

test("default deps delegate exec to pi and read through the injected fs", async () => {
  const pi = createFakePi();
  const deps = defaultDeps(pi as unknown as Pi, {
    existsSync: (path) => path !== "/missing.json",
    readFileSync: (path) => {
      if (path === "/unreadable.json") throw new Error("EACCES");
      return '{"tool_call":{"command":"sh x.sh"}}';
    },
  });
  const result = await deps.exec("echo", ["hi"], { cwd: "/tmp" });
  assert.equal(result.code, 0);
  assert.deepEqual(pi.execCalls, [{ command: "echo", args: ["hi"], options: { cwd: "/tmp" } }]);
  assert.equal(deps.readFile("/virtual/hooks.json"), '{"tool_call":{"command":"sh x.sh"}}');
  assert.equal(deps.readFile("/missing.json"), null);
  assert.equal(deps.readFile("/unreadable.json"), null);
});
