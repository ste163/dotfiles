import { strict as assert } from "node:assert";
import { test } from "node:test";
import planModeExtension, { createPlanModeExtension } from "./index.ts";
import type { PlanModeDeps } from "./deps.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type CommandHandler = (args: string | undefined, ctx: unknown) => unknown;
type ShortcutHandler = (ctx: unknown) => unknown;

interface SentMessage {
  message: { customType: string; content: string; display: boolean };
  options: Record<string, unknown>;
}

interface FakeEntry {
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: unknown;
}

const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit"];

interface FakePi {
  handlers: Record<string, Handler[]>;
  commands: Record<string, { description: string; handler: CommandHandler }>;
  shortcuts: ShortcutHandler[];
  flags: Record<string, unknown>;
  entries: FakeEntry[];
  sentMessages: SentMessage[];
  sentUserMessages: { text: string; options: Record<string, unknown> }[];
  activeTools: string[];
  on(event: string, handler: Handler): void;
  registerCommand(name: string, def: { description: string; handler: CommandHandler }): void;
  registerShortcut(_key: unknown, def: { handler: ShortcutHandler }): void;
  registerFlag(name: string, def: { default?: unknown }): void;
  getFlag(name: string): unknown;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  sendUserMessage(text: string, options?: Record<string, unknown>): void;
}

const createFakePi = (): FakePi => {
  const handlers: Record<string, Handler[]> = {};
  const commands: FakePi["commands"] = {};
  const shortcuts: ShortcutHandler[] = [];
  const flags: Record<string, unknown> = {};
  const entries: FakeEntry[] = [];
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: FakePi["sentUserMessages"] = [];

  return {
    handlers,
    commands,
    shortcuts,
    flags,
    entries,
    sentMessages,
    sentUserMessages,
    activeTools: [...DEFAULT_ACTIVE_TOOLS],
    on(event, handler) {
      handlers[event] = [...(handlers[event] ?? []), handler];
    },
    registerCommand(name, def) {
      commands[name] = def;
    },
    registerShortcut(_key, def) {
      shortcuts.push(def.handler);
    },
    registerFlag(name, def) {
      flags[name] = def.default;
    },
    getFlag(name) {
      return flags[name];
    },
    getActiveTools() {
      return [...this.activeTools];
    },
    setActiveTools(names) {
      this.activeTools = [...names];
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data: data as Record<string, unknown> });
    },
    sendMessage(message, options = {}) {
      sentMessages.push({
        message: message as SentMessage["message"],
        options,
      });
    },
    sendUserMessage(text, options = {}) {
      sentUserMessages.push({ text, options });
    },
  };
};

interface StatusWidget {
  render(): string[];
}

interface FakeCtx {
  ctx: unknown;
  notifications: { message: string; type?: string }[];
  widgetUpdates: Array<string[] | null>;
  statusWidget: { component: StatusWidget | null; placement: string | null };
  editorConsumed: () => number;
  selectConsumed: () => number;
}

const createFakeCtx = (
  options: {
    hasUI?: boolean;
    editorResponses?: Array<string | null>;
    selectResponses?: Array<string | null>;
    entries?: unknown[];
  } = {},
): FakeCtx => {
  const editorResponses = [...(options.editorResponses ?? [])];
  const selectResponses = [...(options.selectResponses ?? [])];
  const notifications: FakeCtx["notifications"] = [];
  const widgetUpdates: FakeCtx["widgetUpdates"] = [];
  const statusWidget: FakeCtx["statusWidget"] = { component: null, placement: null };

  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    strikethrough: (text: string) => text,
  };

  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push(type === undefined ? { message } : { message, type });
      },
      editor: (_prompt: string, _initial: string) =>
        Promise.resolve(editorResponses.shift() ?? null),
      select: (_prompt: string, _choices: string[]) =>
        Promise.resolve(selectResponses.shift() ?? null),
      setWidget: (
        _key: string,
        content: string[] | ((tui: unknown, theme: unknown) => StatusWidget) | undefined,
        widgetOptions?: { placement?: string },
      ): void => {
        if (typeof content === "function") {
          statusWidget.component = content({ requestRender: () => {} }, fakeTheme);
          statusWidget.placement = widgetOptions?.placement ?? null;
          return;
        }
        widgetUpdates.push(content ?? null);
      },
      theme: fakeTheme,
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
    },
  };

  return {
    ctx,
    notifications,
    widgetUpdates,
    statusWidget,
    editorConsumed: () => (options.editorResponses ?? []).length - editorResponses.length,
    selectConsumed: () => (options.selectResponses ?? []).length - selectResponses.length,
  };
};

const createFakeDeps = (files: string[]): PlanModeDeps => ({
  existsSync: (path: string) => files.includes(path),
  cwd: () => "/virtual/cwd",
});

// Handlers must run in registration order - recursion replaces a loop with
// await inside, matching pi's real dispatch semantics.
const callHandler = async (
  pi: FakePi,
  event: string,
  eventPayload: unknown,
  ctx: unknown,
): Promise<unknown> => {
  const list = pi.handlers[event] ?? [];
  const runFrom = async (index: number): Promise<unknown> => {
    if (index >= list.length) return undefined;
    const handler = list[index];
    if (!handler) return runFrom(index + 1);
    const result = await handler(eventPayload, ctx);
    if (index === list.length - 1) return result;
    return runFrom(index + 1);
  };
  return runFrom(0);
};

const customEntry = (customType: string, data: unknown): FakeEntry => ({
  type: "custom",
  customType,
  data: data as Record<string, unknown>,
});

const messageEntry = (message: unknown): FakeEntry => ({ type: "message", message });

const assistantMessage = (blocks: unknown[]): unknown => ({
  role: "assistant",
  content: blocks,
});

const userMessage = (content: unknown): unknown => ({ role: "user", content });

const textBlock = (text: string): unknown => ({ type: "text", text });

const createExtension = (files: string[] = []): { pi: FakePi } => {
  const pi = createFakePi();
  createPlanModeExtension(
    pi as unknown as Parameters<typeof createPlanModeExtension>[0],
    createFakeDeps(files),
  );
  return { pi };
};

interface PersistedShape {
  phase?: string;
  todos?: Array<{ step: number; text: string; completed: boolean }>;
  planFileName?: string | null;
}

/** Last persisted entry's data; fails the test when nothing was persisted. */
const lastEntryData = (pi: FakePi): PersistedShape => {
  const entry = pi.entries.at(-1);
  assert.ok(entry, "expected a persisted entry");
  return (entry.data ?? {}) as PersistedShape;
};

// --- Toggle lifecycle ---

test("toggle on enters overview, filters write/edit tools, notifies, and persists", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, statusWidget } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("overview")));
  assert.deepEqual(statusWidget.component?.render(), [" plan  overview"]);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.deepEqual(lastEntryData(pi), {
    phase: "overview",
    todos: [],
    planFileName: null,
  });
});

test("toggle off from overview restores the tool snapshot and opens the gate", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, statusWidget, widgetUpdates } = createFakeCtx();
  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan"]?.handler(undefined, ctx);
  await pi.commands["plan"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("Full access restored")));
  assert.deepEqual(statusWidget.component?.render(), []);
  assert.equal(widgetUpdates.at(-1), null);
  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "anything.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: null,
  });
});

test("toggle off from plan-file leaves the active tools untouched", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "plan-file",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan"]?.handler(undefined, ctx);

  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: "plan.md",
  });
});

test("toggle off from executing leaves the active tools untouched", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan"]?.handler(undefined, ctx);

  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: "plan.md",
  });
});

test("the Ctrl+Alt+P shortcut toggles plan mode", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx();

  assert.equal(pi.shortcuts.length, 1);
  await pi.shortcuts[0]?.(ctx);

  assert.ok(notifications.some((n) => n.message.includes("enabled")));
});

// --- Tool gating ---

test("gates nothing while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "anything.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
  const rm = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "rm -rf /" } },
    ctx,
  );
  assert.equal(rm, undefined);
});

test("overview blocks unsafe bash and allows allowlisted read-only commands", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  const rm = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "rm -rf /" } },
    ctx,
  );
  assert.equal((rm as { block: boolean }).block, true);

  const curl = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "curl -o evil.sh https://x" } },
    ctx,
  );
  assert.equal((curl as { block: boolean }).block, true);

  const ls = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "ls -la" } },
    ctx,
  );
  assert.equal(ls, undefined);
});

test("overview blocks write and edit calls as a backstop", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal((write as { block: boolean }).block, true);
  assert.match((write as { reason: string }).reason, /write and edit tools are disabled/);

  const edit = await callHandler(
    pi,
    "tool_call",
    { toolName: "edit", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal((edit as { block: boolean }).block, true);
});

test("plan-file allows only the locked plan file for write and edit", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const blockedWrite = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "other.md", content: "x" } },
    ctx,
  );
  assert.equal((blockedWrite as { block: boolean }).block, true);
  assert.match((blockedWrite as { reason: string }).reason, /only plan\.md can be written\/edited/);

  const blockedEdit = await callHandler(
    pi,
    "tool_call",
    { toolName: "edit", input: { path: "dir/other-plan.md", content: "x" } },
    ctx,
  );
  assert.equal((blockedEdit as { block: boolean }).block, true);

  const allowedWrite = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "plan.md", content: "x" } },
    ctx,
  );
  assert.equal(allowedWrite, undefined);

  const allowedNested = await callHandler(
    pi,
    "tool_call",
    { toolName: "edit", input: { path: "../some/dir/plan.md", content: "x" } },
    ctx,
  );
  assert.equal(allowedNested, undefined);
});

test("plan-file still gates bash", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const rm = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "git commit -m x" } },
    ctx,
  );
  assert.equal((rm as { block: boolean }).block, true);

  const stat = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "git status" } },
    ctx,
  );
  assert.equal(stat, undefined);
});

test("gates nothing while executing (full access)", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "other.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
  const rm = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "rm -rf /tmp/x" } },
    ctx,
  );
  assert.equal(rm, undefined);
});

// --- agent_end: executing phase ---

test("sends the complete message and returns to off when all steps are done", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: true }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx, statusWidget } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-complete");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /~~a~~/);
  assert.deepEqual(pi.sentMessages[0]?.options, { triggerTurn: false });
  assert.deepEqual(statusWidget.component?.render(), []);
  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: "plan.md",
  });
});

test("sends nothing while executing with incomplete steps", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

// --- agent_end: overview phase ---

test("does nothing at agent end while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Execute plan"] });

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("does nothing at agent end without UI", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ hasUI: false });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("Continue planning keeps the overview phase untouched", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Continue planning"] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("Write plan to file transitions to plan-file, restores tools, and triggers a turn", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["my-plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    {
      messages: [
        assistantMessage([
          { type: "tool_use", id: "x" },
          textBlock("Plan:\n1. First step here\n2. Second step here"),
        ]),
      ],
    },
    ctx,
  );

  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-todo-list");
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-write-file");
  assert.match(pi.sentMessages[1]?.message.content ?? "", /my-plan\.md/);
  assert.deepEqual(pi.sentMessages[1]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(lastEntryData(pi), {
    phase: "plan-file",
    todos: [
      { step: 1, text: "First step here", completed: false },
      { step: 2, text: "Second step here", completed: false },
    ],
    planFileName: "my-plan.md",
  });
});

test("Write plan to file without extracted todos still transitions", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("just some discussion")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-write-file");
  assert.deepEqual(lastEntryData(pi), {
    phase: "plan-file",
    todos: [],
    planFileName: "plan.md",
  });
});

test("cancelling the name prompt at Write plan to file keeps overview and the tool filter", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: [null],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("re-prompts on a plan file name collision before transitioning", async () => {
  const { pi } = createExtension(["/virtual/cwd/taken.md"]);
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["taken", "free"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(lastEntryData(pi).planFileName, "free.md");
});

test("Execute plan from overview starts execution with full access", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Execute plan"] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-todo-list");
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-execute");
  assert.match(pi.sentMessages[1]?.message.content ?? "", /Start with: First step here/);
  assert.deepEqual(pi.sentMessages[1]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(lastEntryData(pi), {
    phase: "executing",
    todos: [{ step: 1, text: "First step here", completed: false }],
    planFileName: null,
  });
});

test("Execute plan without a numbered plan notifies and stays in overview", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx({ selectResponses: ["Execute plan"] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no numbered plan here")])] },
    ctx,
  );

  assert.ok(notifications.some((n) => n.message.includes("No numbered plan found yet")));
  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("blank input at Write plan to file falls back to the default name", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: [""],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(lastEntryData(pi).planFileName, "plan.md");
});

test("handles agent end with no assistant messages in overview", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Continue planning"] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("a cancelled next-action select keeps overview unchanged", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: [null] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("reuses a locked plan file name without re-prompting on Write plan to file", async () => {
  const { pi } = createExtension(["/virtual/cwd/my-plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "overview", todos: [], planFileName: "my-plan.md" }),
  ];
  const { ctx, editorConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Write plan to file"],
    editorResponses: ["should-not-be-asked"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(editorConsumed(), 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

// --- agent_end: plan-file phase ---

test("Execute the plan from plan-file starts execution", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries, selectResponses: ["Execute the plan"] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-execute");
  assert.equal(lastEntryData(pi).phase, "executing");
});

test("Continue planning keeps the plan-file phase", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx, statusWidget } = createFakeCtx({ entries, selectResponses: ["Continue planning"] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(statusWidget.component?.render(), [" plan  file"]);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("Refine the plan sends the refinement as a user message", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({
    entries,
    selectResponses: ["Refine the plan"],
    editorResponses: ["make it smaller"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-todo-list");
  assert.deepEqual(pi.sentUserMessages[0], {
    text: "make it smaller",
    options: { deliverAs: "followUp" },
  });
});

test("an empty refinement sends nothing", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({
    entries,
    selectResponses: ["Refine the plan"],
    editorResponses: [""],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(pi.sentUserMessages.length, 0);
});

test("a cancelled select sends nothing and keeps the plan-file phase", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries, selectResponses: [null] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("plan-file without any todos skips the next-action prompt", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no numbered plan here")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 0);
});

test("keeps old todos when extraction finds none in plan-file", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "plan-file",
      todos: [{ step: 1, text: "old", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, selectResponses: ["Continue planning"] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no plan here")])] },
    ctx,
  );

  assert.deepEqual(lastEntryData(pi).todos, [{ step: 1, text: "old", completed: false }]);
});

// --- before_agent_start injection ---

test("injects the overview context while in overview", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string; display: boolean };
  };
  assert.equal(result.message.customType, "plan-mode-overview-context");
  assert.match(result.message.content, /\[PLAN MODE ACTIVE\]/);
  assert.match(result.message.content, /Do NOT write or edit any file/);
  assert.equal(result.message.display, false);
});

test("injects the plan-file context while in plan-file", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-mode-file-context");
  assert.match(result.message.content, /only file you may write or edit is plan\.md/);
});

test("injects the execution context while executing with unfinished steps only", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "a", completed: true },
        { step: 2, text: "b", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-mode-execution-context");
  assert.doesNotMatch(result.message.content, /1\. a/);
  assert.match(result.message.content, /2\. b/);
});

test("injects nothing while off or executing with an empty todo list", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  assert.equal(await callHandler(pi, "before_agent_start", {}, ctx), undefined);

  const entries = [customEntry("plan-mode", { phase: "executing", todos: [], planFileName: null })];
  const ctx2 = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx2.ctx);
  assert.equal(await callHandler(pi, "before_agent_start", {}, ctx2.ctx), undefined);
});

// --- Context filtering ---

test("filters plan-mode context messages out of history while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const result = await callHandler(
    pi,
    "context",
    {
      messages: [
        { customType: "plan-mode-overview-context", role: "user", content: "marker" },
        { customType: "plan-mode-file-context", role: "user", content: "marker" },
        { customType: "plan-mode-execution-context", role: "user", content: "marker" },
        { customType: "plan-mode-todo-list", role: "user", content: "keep me" },
        assistantMessage([textBlock("keep assistant")]),
        userMessage("text with [PLAN MODE ACTIVE] marker"),
        userMessage([textBlock("keeps [PLAN MODE ACTIVE]")]),
        userMessage([textBlock("clean array"), { type: "text" }]),
        userMessage("clean string"),
        userMessage(42),
      ],
    },
    ctx,
  );

  const kept = (result as { messages: unknown[] }).messages;
  assert.deepEqual(kept, [
    { customType: "plan-mode-todo-list", role: "user", content: "keep me" },
    assistantMessage([textBlock("keep assistant")]),
    userMessage([textBlock("clean array"), { type: "text" }]),
    userMessage("clean string"),
    userMessage(42),
  ]);
});

test("does not filter context while a phase is active", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  assert.equal(await callHandler(pi, "context", { messages: [] }, ctx), undefined);
});

// --- turn_end progress ---

test("ignores turns while not executing", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("x")]) }, ctx);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("ignores turns while executing with no todos", async () => {
  const { pi } = createExtension();
  const entries = [customEntry("plan-mode", { phase: "executing", todos: [], planFileName: null })];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);
  const entryCount = pi.entries.length;

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("x")]) }, ctx);

  assert.equal(pi.entries.length, entryCount);
});

test("ignores non-assistant messages at turn end", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "turn_end", { message: userMessage("[DONE:1]") }, ctx);

  assert.deepEqual(lastEntryData(pi).todos, [{ step: 1, text: "a", completed: false }]);
});

test("marks DONE steps at turn end and updates the status widget", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "a", completed: false },
        { step: 2, text: "b", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx, statusWidget, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("[DONE:1]")]) }, ctx);

  assert.deepEqual(statusWidget.component?.render(), [" plan  executing 1/2"]);
  assert.equal(statusWidget.placement, "belowEditor");
  assert.deepEqual(widgetUpdates.at(-1), ["[x] a", "[ ] b"]);
  assert.deepEqual(lastEntryData(pi).todos, [
    { step: 1, text: "a", completed: true },
    { step: 2, text: "b", completed: false },
  ]);
});

test("persists at turn end even without DONE markers", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);
  const entryCount = pi.entries.length;

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("no markers")]) }, ctx);

  assert.equal(pi.entries.length, entryCount + 1);
});

// --- session_start restore ---

test("the --plan flag starts the session in overview with filtered tools", async () => {
  const { pi } = createExtension();
  pi.flags["plan"] = true;
  const { ctx } = createFakeCtx();

  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.deepEqual(lastEntryData(pi), {
    phase: "overview",
    todos: [],
    planFileName: null,
  });
});

test("restores a persisted overview phase and re-applies the tool filter", async () => {
  const { pi } = createExtension();
  const entries = [customEntry("plan-mode", { phase: "overview", todos: [], planFileName: null })];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
});

test("restores a persisted plan-file phase without re-prompting while the file exists", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx, editorConsumed } = createFakeCtx({ entries, editorResponses: ["nope"] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(editorConsumed(), 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("re-prompts at startup when the restored plan file vanished", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "gone.md" }),
  ];
  const { ctx } = createFakeCtx({ entries, editorResponses: ["replacement"] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(lastEntryData(pi).planFileName, "replacement.md");
});

test("cancelling the replacement naming at startup turns plan mode off", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "gone.md" }),
  ];
  const { ctx } = createFakeCtx({ entries, editorResponses: [null] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: "gone.md",
  });
});

test("falls back silently to the default plan file name in headless runs", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "gone.md" }),
  ];
  const { ctx } = createFakeCtx({ entries, hasUI: false });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(lastEntryData(pi).planFileName, "plan.md");
});

test("restores an executing phase with an empty todo list without rescanning", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "executing", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx, statusWidget } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(lastEntryData(pi).phase, "executing");
  assert.deepEqual(lastEntryData(pi).todos, []);
  assert.deepEqual(statusWidget.component?.render(), []);
});

test("re-scans DONE markers after the execute marker on resume", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "a", completed: false },
        { step: 2, text: "b", completed: false },
      ],
      planFileName: "plan.md",
    }),
    customEntry("plan-mode-execute", {}),
    messageEntry(assistantMessage([textBlock("finished [DONE:1]")])),
    messageEntry(userMessage("[DONE:2] ignored")),
    messageEntry({ role: "assistant", content: "not an array" }),
    customEntry("other", {}),
    { type: "message" },
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(lastEntryData(pi).todos, [
    { step: 1, text: "a", completed: true },
    { step: 2, text: "b", completed: false },
  ]);
});

test("re-scans from the start when no execute marker exists", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: false }],
      planFileName: "plan.md",
    }),
    messageEntry(assistantMessage([textBlock("did [DONE:1]")])),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(lastEntryData(pi).todos, [{ step: 1, text: "a", completed: true }]);
});

test("restores with empty data by keeping the defaults", async () => {
  const { pi } = createExtension();
  const entries = [customEntry("plan-mode", {})];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(pi.entries.length, 1);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

test("ignores entries from the old extension custom type", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(pi.entries.length, 0);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

test("leaves plan mode off without a flag or persisted entry", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ entries: [] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(pi.entries.length, 0);
  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
});

// --- default export ---

test("the default export registers the extension with default deps", () => {
  const pi = createFakePi();
  planModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0]);

  assert.ok(pi.handlers["session_start"]?.length);
  assert.ok(pi.commands["plan"]);
  assert.equal(pi.shortcuts.length, 1);
  assert.equal(pi.flags["plan"], false);
});
