import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPlanModeExtension, type PlanModeDeps } from "./index.ts";

// --- Minimal fakes for the pi extension API/context surface this extension uses ---

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
  handlers: Map<string, Handler[]>;
  commands: Map<
    string,
    { description: string; handler: (args: string | undefined, ctx: unknown) => unknown }
  >;
  flags: Map<string, { default?: unknown }>;
  entries: unknown[];
  on(event: string, handler: Handler): void;
  registerCommand(
    name: string,
    def: { description: string; handler: (args: string | undefined, ctx: unknown) => unknown },
  ): void;
  registerShortcut(key: unknown, def: unknown): void;
  registerFlag(name: string, def: { default?: unknown }): void;
  getFlag(name: string): unknown;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(text: string, options?: unknown): void;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands: FakePi["commands"] = new Map();
  const flags = new Map<string, { default?: unknown }>();
  const entries: unknown[] = [];

  return {
    handlers,
    commands,
    flags,
    entries,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut() {},
    registerFlag(name, def) {
      flags.set(name, def);
    },
    getFlag(name) {
      return flags.get(name)?.default;
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage() {},
    sendUserMessage() {},
  };
}

function createFakeCtx(
  options: { editorResponses?: (string | null | undefined)[]; hasUI?: boolean } = {},
) {
  const editorResponses = [...(options.editorResponses ?? [])];
  const notifications: string[] = [];
  const statusUpdates: Array<string | undefined> = [];

  return {
    hasUI: options.hasUI ?? true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      editor(_prompt: string, _initial: string) {
        return Promise.resolve(editorResponses.shift());
      },
      select(_prompt: string, choices: string[]) {
        return Promise.resolve(choices[0]);
      },
      setStatus(_key: string, value: string | undefined) {
        statusUpdates.push(value);
      },
      setWidget() {},
      theme: {
        fg: (_color: string, text: string) => text,
        strikethrough: (text: string) => text,
      },
    },
    sessionManager: {
      getEntries: () => [],
    },
    notifications,
    statusUpdates,
  };
}

// Fully in-memory filesystem fake - no real disk I/O, no temp dirs, no chdir.
function createFakeDeps(existingFiles: string[] = []): PlanModeDeps {
  const files = new Set(existingFiles);
  return {
    existsSync: (path: string) => files.has(path),
    cwd: () => "/virtual/cwd",
  };
}

async function callHandler(pi: FakePi, event: string, eventPayload: unknown, ctx: unknown) {
  const list = pi.handlers.get(event) ?? [];
  // Handlers must run in registration order - later ones can observe mutations
  // made by earlier ones (matches pi's real dispatch semantics), so this is
  // genuinely sequential and recursion replaces the loop rather than looping
  // with await inside.
  async function runFrom(index: number): Promise<unknown> {
    if (index >= list.length) return undefined;
    const handler = list[index];
    if (!handler) return runFrom(index + 1);
    const result = await handler(eventPayload, ctx);
    if (index === list.length - 1) return result;
    return runFrom(index + 1);
  }
  return runFrom(0);
}

test("toggling plan mode on prompts for a name and locks it in", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: ["my-plan"] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);

  await planCommand.handler(undefined, ctx);

  assert.ok(ctx.notifications.some((n) => n.includes("my-plan.md")));

  const planFileCommand = pi.commands.get("plan-file");
  assert.ok(planFileCommand);
  await planFileCommand.handler(undefined, ctx);
  assert.ok(ctx.notifications.some((n) => n === "Plan file: my-plan.md"));
});

test("blank input falls back to the default plan.md name", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: [""] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);

  await planCommand.handler(undefined, ctx);

  assert.ok(ctx.notifications.some((n) => n.includes("plan.md")));
});

test("re-prompts when the chosen name already exists in cwd", async () => {
  const deps = createFakeDeps(["/virtual/cwd/taken.md"]);
  const pi = createFakePi();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: ["taken", "free"] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);

  await planCommand.handler(undefined, ctx);

  assert.ok(ctx.notifications.some((n) => n.includes("free.md")));
  assert.ok(!ctx.notifications.some((n) => n.includes("taken.md")));
});

test("blocks write/edit to any file other than the locked plan file", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: ["plan"] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);
  await planCommand.handler(undefined, ctx);

  const blockedResult = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "other.md", content: "x" } },
    ctx,
  );
  assert.deepEqual((blockedResult as { block: boolean }).block, true);

  const allowedResult = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "plan.md", content: "x" } },
    ctx,
  );
  assert.equal(allowedResult, undefined);
});

test("blocks unsafe bash commands and allows safe ones while plan mode is active", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: ["plan"] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);
  await planCommand.handler(undefined, ctx);

  const blocked = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "rm -rf /" } },
    ctx,
  );
  assert.deepEqual((blocked as { block: boolean }).block, true);

  const allowed = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "ls -la" } },
    ctx,
  );
  assert.equal(allowed, undefined);
});

test("toggling off disables the lock's write/edit gating for that turn", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);

  const ctx = createFakeCtx({ editorResponses: ["plan"] });
  const planCommand = pi.commands.get("plan");
  assert.ok(planCommand);

  await planCommand.handler(undefined, ctx); // on
  await planCommand.handler(undefined, ctx); // off

  const result = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "anything.md", content: "x" } },
    ctx,
  );
  assert.equal(result, undefined);
});

test("session_start with --plan flag prompts for a name when none is locked yet", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);
  pi.flags.set("plan", { default: true });

  const ctx = createFakeCtx({ editorResponses: ["from-flag"] });
  await callHandler(pi, "session_start", {}, ctx);

  const planFileCommand = pi.commands.get("plan-file");
  assert.ok(planFileCommand);
  await planFileCommand.handler(undefined, ctx);
  assert.ok(ctx.notifications.some((n) => n === "Plan file: from-flag.md"));
});

test("session_start falls back silently to the default name when there's no UI", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);
  pi.flags.set("plan", { default: true });

  const ctx = createFakeCtx({ hasUI: false });
  await callHandler(pi, "session_start", {}, ctx);

  const planFileCommand = pi.commands.get("plan-file");
  assert.ok(planFileCommand);
  await planFileCommand.handler(undefined, ctx);
  assert.ok(ctx.notifications.some((n) => n === "Plan file: plan.md"));
});
