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

// Plan fixtures in the wrapped code proposal format: "# Plan" header,
// "##" sections, "###" path blocks, optional "## Questions".
const PLAN_ONE_STEP = `# Plan
## Reasoning
- one thing.

## Files
- src/a.ts (modify) — first purpose

## Implementation
### src/a.ts
change a.`;

const PLAN_TWO_STEPS = `# Plan
## Reasoning
- two things.

## Files
- src/a.ts (modify) — first purpose
- src/b.ts (new) — second purpose

## Implementation
### src/a.ts
change a.

### src/b.ts
create b.`;

const PLAN_WITH_QUESTIONS = `${PLAN_TWO_STEPS}
## Questions
1. window size?
   Proposed solution: 4
`;

interface FakePi {
  handlers: Record<string, Handler[]>;
  commands: Record<string, { description: string; handler: CommandHandler }>;
  shortcuts: ShortcutHandler[];
  flags: Record<string, unknown>;
  entries: FakeEntry[];
  sentMessages: SentMessage[];
  sentUserMessages: { text: string; options: Record<string, unknown> }[];
  activeTools: string[];
  tools: Record<string, { execute?: (...args: unknown[]) => Promise<unknown> }>;
  on(event: string, handler: Handler): void;
  registerCommand(name: string, def: { description: string; handler: CommandHandler }): void;
  registerShortcut(_key: unknown, def: { handler: ShortcutHandler }): void;
  registerFlag(name: string, def: { default?: unknown }): void;
  registerTool(def: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }): void;
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
  const tools: FakePi["tools"] = {};

  return {
    handlers,
    commands,
    shortcuts,
    flags,
    entries,
    sentMessages,
    sentUserMessages,
    activeTools: [...DEFAULT_ACTIVE_TOOLS],
    tools,
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
    registerTool(def) {
      tools[def.name] = def;
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
  selectChoices: string[][];
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
  const selectChoices: string[][] = [];

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
      select: (_prompt: string, choices: string[]) => {
        selectChoices.push([...choices]);
        return Promise.resolve(selectResponses.shift() ?? null);
      },
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
    selectChoices,
    editorConsumed: () => (options.editorResponses ?? []).length - editorResponses.length,
    selectConsumed: () => (options.selectResponses ?? []).length - selectResponses.length,
  };
};

interface FakeDeps extends PlanModeDeps {
  /** File contents by absolute path; the tests mutate it directly. */
  store: Record<string, string>;
}

const createFakeDeps = (
  files: readonly string[],
  contents: Record<string, string> = {},
  options: { writeFails?: boolean } = {},
): FakeDeps => {
  const store: Record<string, string> = {
    ...Object.fromEntries(files.map((file) => [file, ""])),
    ...contents,
  };
  return {
    store,
    existsSync: (path: string) => path in store,
    readFileSync: (path: string) => (path in store ? (store[path] ?? null) : null),
    writeFileSync: (path: string, content: string) => {
      if (options.writeFails) return false;
      store[path] = content;
      return true;
    },
    cwd: () => "/virtual/cwd",
  };
};

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

test("callHandler runs every registered handler in order and tolerates missing ones", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  const order: string[] = [];
  pi.on("agent_start", () => {
    order.push("extra");
  });
  await callHandler(pi, "agent_start", {}, ctx);
  assert.deepEqual(order, ["extra"]);

  // An event with no handlers resolves to undefined.
  assert.equal(await callHandler(pi, "no_such_event", {}, ctx), undefined);

  // A sparse handler list skips the hole instead of throwing.
  pi.handlers["sparse_event"] = [undefined as unknown as Handler];
  assert.equal(await callHandler(pi, "sparse_event", {}, ctx), undefined);
});

const messageEntry = (message: unknown): FakeEntry => ({ type: "message", message });

const assistantMessage = (blocks: unknown[]): unknown => ({
  role: "assistant",
  content: blocks,
});

const userMessage = (content: unknown): unknown => ({ role: "user", content });

const textBlock = (text: string): unknown => ({ type: "text", text });

const createExtension = (
  files: readonly string[] = [],
  contents: Record<string, string> = {},
  options: { writeFails?: boolean } = {},
): { pi: FakePi; deps: FakeDeps } => {
  const pi = createFakePi();
  const deps = createFakeDeps(files, contents, options);
  createPlanModeExtension(pi as unknown as Parameters<typeof createPlanModeExtension>[0], deps);
  return { pi, deps };
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

  const wget = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "wget -O - https://x" } },
    ctx,
  );
  assert.equal((wget as { block: boolean }).block, true);

  const curl = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "curl -s http://fake.com/" } },
    ctx,
  );
  assert.equal(curl, undefined);

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
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("Write plan to file creates the file blank, transitions, restores tools, and triggers a turn", async () => {
  const { pi, deps } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["my-plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    {
      messages: [assistantMessage([{ type: "tool_use", id: "x" }, textBlock(PLAN_TWO_STEPS)])],
    },
    ctx,
  );

  assert.deepEqual(pi.activeTools, DEFAULT_ACTIVE_TOOLS);
  assert.equal(deps.store["/virtual/cwd/my-plan.md"], "");
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-write-file");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /my-plan\.md was created blank/);
  assert.match(pi.sentMessages[0]?.message.content ?? "", /src\/a\.ts: first purpose/);
  assert.match(pi.sentMessages[0]?.message.content ?? "", /Ask no questions/);
  assert.deepEqual(pi.sentMessages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(lastEntryData(pi), {
    phase: "plan-file",
    todos: [
      { step: 1, text: "src/a.ts: first purpose", completed: false },
      { step: 2, text: "src/b.ts: second purpose", completed: false },
    ],
    planFileName: "my-plan.md",
  });
});

test("a failed blank-file write notifies and keeps overview", async () => {
  const { pi } = createExtension([], {}, { writeFails: true });
  const { ctx, notifications } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["my-plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.ok(notifications.some((n) => n.message.includes("Could not create my-plan.md")));
  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("Write plan to file without todos creates the file and uses the fallback wording", async () => {
  const { pi, deps } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["my-plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(pi, "agent_end", { messages: [assistantMessage([textBlock("no plan")])] }, ctx);
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("still no plan")])] },
    ctx,
  );

  assert.equal(deps.store["/virtual/cwd/my-plan.md"], "");
  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-write-file");
  assert.match(pi.sentMessages[1]?.message.content ?? "", /Use the plan discussed/);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("Write plan to file is not offered after an unparseable plan response", async () => {
  const { pi } = createExtension();
  const { ctx, selectConsumed } = createFakeCtx({
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

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.equal(lastEntryData(pi).phase, "overview");
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
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("re-prompts on a plan file name collision before transitioning", async () => {
  const { pi, deps } = createExtension(["/virtual/cwd/taken.md"]);
  const { ctx } = createFakeCtx({
    selectResponses: ["Write plan to file"],
    editorResponses: ["taken", "free"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.equal(lastEntryData(pi).planFileName, "free.md");
  assert.equal(deps.store["/virtual/cwd/free.md"], "");
});

test("Execute plan from overview starts execution with full access", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Execute plan"] });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.deepEqual(pi.activeTools, [...DEFAULT_ACTIVE_TOOLS, "plan_step_complete"]);
  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-todo-list");
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-execute");
  assert.match(pi.sentMessages[1]?.message.content ?? "", /Start with: src\/a\.ts: first purpose/);
  assert.match(
    pi.sentMessages[1]?.message.content ?? "",
    /plan_step_complete tool with its number/,
  );
  assert.deepEqual(pi.sentMessages[1]?.options, { deliverAs: "followUp" });
  assert.equal(pi.sentUserMessages.length, 1);
  assert.deepEqual(pi.sentUserMessages[0]?.options, { deliverAs: "followUp" });
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Execute the plan\./);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Start with: src\/a\.ts: first purpose/);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Background events are not signals/);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /calling the plan_step_complete tool/);
  assert.deepEqual(lastEntryData(pi), {
    phase: "executing",
    todos: [{ step: 1, text: "src/a.ts: first purpose", completed: false }],
    planFileName: null,
  });
});

test("an unparseable plan sends one format correction and skips the next-action prompt", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, selectConsumed } = createFakeCtx({
    selectResponses: ["Execute plan"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no numbered plan here")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /missing a '# Plan' header/);
  assert.deepEqual(pi.sentMessages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  assert.ok(notifications.some((n) => n.message.includes("Plan format invalid")));
  assert.deepEqual(pi.activeTools, ["read", "bash", "grep", "find", "ls"]);
  assert.equal(lastEntryData(pi).phase, "overview");
});

test("a second unparseable plan only notifies and shows the prompt once", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, selectChoices } = createFakeCtx({
    selectResponses: ["Continue planning", "Continue planning"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no plan here")])] },
    ctx,
  );
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("still no plan here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 1);
  assert.equal(selectChoices.length, 1);
  assert.deepEqual(selectChoices[0], ["Continue planning", "Write plan to file"]);
  assert.ok(notifications.some((n) => n.message.includes("missing a '# Plan' header")));
});

test("a valid plan clears the format warning so corrections stay one per streak", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({
    selectResponses: ["Continue planning", "Continue planning"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no plan here")])] },
    ctx,
  );
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("bad again")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-plan-format");
  assert.deepEqual(lastEntryData(pi).todos, [
    { step: 1, text: "src/a.ts: first purpose", completed: false },
  ]);
});

test("the Execute plan option appears only when a plan parsed", async () => {
  const { pi } = createExtension();
  const { ctx, selectChoices } = createFakeCtx({
    selectResponses: ["Continue planning", "Continue planning"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.deepEqual(selectChoices[0], ["Continue planning", "Write plan to file"]);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );
  assert.deepEqual(selectChoices[1], ["Continue planning", "Write plan to file", "Execute plan"]);
});

test("Execute plan stays hidden while questions are open and appears after folding", async () => {
  const { pi } = createExtension();
  const { ctx, selectChoices } = createFakeCtx({
    selectResponses: ["Continue planning", "Continue planning"],
  });
  await pi.commands["plan"]?.handler(undefined, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_WITH_QUESTIONS)])] },
    ctx,
  );
  assert.deepEqual(selectChoices[0], ["Continue planning", "Write plan to file"]);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock(PLAN_TWO_STEPS)])] },
    ctx,
  );
  assert.deepEqual(selectChoices[1], ["Continue planning", "Write plan to file", "Execute plan"]);
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
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
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
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
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
    { messages: [assistantMessage([textBlock(PLAN_ONE_STEP)])] },
    ctx,
  );

  assert.equal(editorConsumed(), 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

// --- agent_end: plan-file phase ---
// The plan file is the source of truth: the chat message is never
// consulted, so a reply without a Plan: header cannot trigger a correction.

const planFilePlan = PLAN_ONE_STEP;

const seededPlanFile = (): { pi: FakePi } =>
  createExtension(["/virtual/cwd/plan.md"], { "/virtual/cwd/plan.md": planFilePlan });

const planFileEntries = (todos: Array<{ step: number; text: string; completed: boolean }> = []) => [
  customEntry("plan-mode", { phase: "plan-file", todos, planFileName: "plan.md" }),
];

test("Execute the plan from plan-file starts execution", async () => {
  const { pi } = seededPlanFile();
  const entries = planFileEntries();
  const { ctx } = createFakeCtx({ entries, selectResponses: ["Execute the plan"] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-mode-execute");
  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Start with: src\/a\.ts: first purpose/);
  assert.equal(lastEntryData(pi).phase, "executing");
});

test("Continue planning keeps the plan-file phase", async () => {
  const { pi } = seededPlanFile();
  const entries = planFileEntries();
  const { ctx, statusWidget } = createFakeCtx({ entries, selectResponses: ["Continue planning"] });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(statusWidget.component?.render(), [" plan  file"]);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("Refine the plan sends the refinement as a user message", async () => {
  const { pi } = seededPlanFile();
  const entries = planFileEntries();
  const { ctx } = createFakeCtx({
    entries,
    selectResponses: ["Refine the plan"],
    editorResponses: ["make it smaller"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-todo-list");
  assert.deepEqual(pi.sentUserMessages[0], {
    text: "make it smaller",
    options: { deliverAs: "followUp" },
  });
});

test("an empty refinement sends nothing", async () => {
  const { pi } = seededPlanFile();
  const entries = planFileEntries();
  const { ctx } = createFakeCtx({
    entries,
    selectResponses: ["Refine the plan"],
    editorResponses: [""],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(pi.sentUserMessages.length, 0);
});

test("a cancelled select sends nothing and keeps the plan-file phase", async () => {
  const { pi } = seededPlanFile();
  const entries = planFileEntries();
  const { ctx } = createFakeCtx({ entries, selectResponses: [null] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(lastEntryData(pi).phase, "plan-file");
});

test("a blank plan file asks for a format correction instead of prompting", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = planFileEntries();
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /plan\.md is blank/);
});

test("a vanished plan file asks for a format correction instead of prompting", async () => {
  const { pi, deps } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = planFileEntries();
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  delete deps.store["/virtual/cwd/plan.md"];
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /plan\.md is missing/);
});

test("an unparseable plan file names the exact format problem", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"], {
    "/virtual/cwd/plan.md": "no numbered plan here",
  });
  const entries = planFileEntries();
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /missing a '# Plan' header/);
});

test("a plan file with open questions asks for a correction", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"], {
    "/virtual/cwd/plan.md": PLAN_WITH_QUESTIONS,
  });
  const entries = planFileEntries();
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /## Questions/);
});

test("keeps old todos and corrects when the plan file is blank", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = planFileEntries([{ step: 1, text: "old", completed: false }]);
  const { ctx, selectConsumed } = createFakeCtx({
    entries,
    selectResponses: ["Continue planning"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is written")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-mode-plan-format");
  assert.deepEqual(lastEntryData(pi).todos, [{ step: 1, text: "old", completed: false }]);
});

test("a repeated format failure in plan-file with no todos returns without prompting", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = planFileEntries();
  const { ctx, selectConsumed, notifications } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan"],
  });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("the file is still blank")])] },
    ctx,
  );
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("still blank")])] },
    ctx,
  );

  assert.equal(selectConsumed(), 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(notifications.length, 2);
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

test("injects nothing once the plan file parses", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"], {
    "/virtual/cwd/plan.md": PLAN_ONE_STEP,
  });
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(await callHandler(pi, "before_agent_start", {}, ctx), undefined);
});

test("injects the write context when the plan file is missing", async () => {
  const { pi, deps } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "plan-file", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  delete deps.store["/virtual/cwd/plan.md"];
  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-mode-file-context");
  assert.match(result.message.content, /plan\.md is not written yet/);
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
  assert.match(result.message.content, /Completed: 1\/2/);
  assert.match(result.message.content, /Next: step 2 - b/);
  assert.match(result.message.content, /plan_step_complete/);
  assert.match(result.message.content, /One call per step, in order/);
  assert.doesNotMatch(result.message.content, /1\. a/);
  assert.match(result.message.content, /2\. b/);
});

test("injects the execution context with the completed line when every step is done", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: true }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-mode-execution-context");
  assert.match(result.message.content, /All steps completed\./);
  assert.match(result.message.content, /Completed: 1\/1/);
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

test("drops every plan-mode message out of context while off", async () => {
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
        { customType: "plan-mode-todo-list", role: "user", content: "marker" },
        { customType: "plan-mode-execute", role: "user", content: "marker" },
        { customType: "plan-mode-complete", role: "user", content: "marker" },
        { customType: "plan-mode-write-file", role: "user", content: "marker" },
        { customType: "plan-mode-plan-format", role: "user", content: "marker" },
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
    assistantMessage([textBlock("keep assistant")]),
    userMessage([textBlock("clean array"), { type: "text" }]),
    userMessage("clean string"),
    userMessage(42),
  ]);
});

test("keeps only the newest steering copy while a phase is active", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();
  await pi.commands["plan"]?.handler(undefined, ctx);

  const result = await callHandler(
    pi,
    "context",
    {
      messages: [
        { customType: "plan-mode-overview-context", role: "user", content: "old steering" },
        { customType: "plan-mode-todo-list", role: "user", content: "dropped artifact" },
        { customType: "other-extension", role: "user", content: "kept custom" },
        assistantMessage([textBlock("keep assistant")]),
        { customType: "plan-mode-overview-context", role: "user", content: "new steering" },
        { customType: "plan-mode-plan-format", role: "user", content: "old correction" },
        { customType: "plan-mode-plan-format", role: "user", content: "new correction" },
        userMessage("kept [PLAN MODE ACTIVE] while active"),
      ],
    },
    ctx,
  );

  const kept = (result as { messages: unknown[] }).messages;
  assert.deepEqual(kept, [
    { customType: "other-extension", role: "user", content: "kept custom" },
    assistantMessage([textBlock("keep assistant")]),
    { customType: "plan-mode-overview-context", role: "user", content: "new steering" },
    { customType: "plan-mode-plan-format", role: "user", content: "new correction" },
    userMessage("kept [PLAN MODE ACTIVE] while active"),
  ]);
});

// --- turn_end checkpoint ---

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

test("persists at turn end without reading the message", async () => {
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

  await callHandler(pi, "turn_end", { message: userMessage("no markers") }, ctx);

  assert.equal(pi.entries.length, entryCount + 1);
});

// --- todo window ---

const windowTodos = (): Array<{ step: number; text: string; completed: boolean }> => [
  { step: 1, text: "one", completed: false },
  { step: 2, text: "two", completed: false },
  { step: 3, text: "three", completed: false },
  { step: 4, text: "four", completed: false },
  { step: 5, text: "five", completed: false },
  { step: 6, text: "six", completed: false },
];

test("the todo widget shows at most four pending steps", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "executing", todos: windowTodos(), planFileName: "plan.md" }),
  ];
  const { ctx, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(widgetUpdates.at(-1), ["[ ] one", "[ ] two", "[ ] three", "[ ] four"]);
});

const stepCall = (step: unknown): unknown => ({ toolName: "plan_step_complete", input: { step } });

const registerStep = (ctx: unknown, pi: FakePi, step: number): Promise<unknown> =>
  callHandler(pi, "tool_call", stepCall(step), ctx);

test("one completed step stays visible in the window", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "executing", todos: windowTodos(), planFileName: "plan.md" }),
  ];
  const { ctx, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await registerStep(ctx, pi, 1);

  assert.deepEqual(widgetUpdates.at(-1), ["[x] one", "[ ] two", "[ ] three", "[ ] four"]);
});

test("two completed steps batch-drop and refill the window", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "executing", todos: windowTodos(), planFileName: "plan.md" }),
  ];
  const { ctx, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await registerStep(ctx, pi, 1);
  await registerStep(ctx, pi, 2);

  assert.deepEqual(widgetUpdates.at(-1), ["[ ] three", "[ ] four", "[ ] five", "[ ] six"]);
});

test("a stuck pending step does not freeze the todo window", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "one", completed: false },
        { step: 2, text: "two", completed: true },
        { step: 3, text: "three", completed: true },
        { step: 4, text: "four", completed: true },
        { step: 5, text: "five", completed: false },
        { step: 6, text: "six", completed: false },
        { step: 7, text: "seven", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(widgetUpdates.at(-1), ["[ ] one", "[ ] five", "[ ] six", "[ ] seven"]);

  await registerStep(ctx, pi, 1);

  assert.deepEqual(widgetUpdates.at(-1), ["[ ] five", "[ ] six", "[ ] seven"]);
});

// --- step registration tool ---

const executingEntries = (): FakeEntry[] => [
  customEntry("plan-mode", {
    phase: "executing",
    todos: [{ step: 1, text: "one", completed: false }],
    planFileName: "plan.md",
  }),
];

const writeCall = (ctx: unknown, pi: FakePi): Promise<unknown> =>
  callHandler(pi, "tool_call", { toolName: "write", input: { path: "x.md", content: "x" } }, ctx);

test("registers a valid step, persists, and updates the widget", async () => {
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
  const { ctx, widgetUpdates, statusWidget } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = await registerStep(ctx, pi, 1);

  assert.equal(result, undefined);
  assert.deepEqual(statusWidget.component?.render(), [" plan  executing 1/2"]);
  assert.deepEqual(widgetUpdates.at(-1), ["[x] a", "[ ] b"]);
  assert.deepEqual(lastEntryData(pi).todos, [
    { step: 1, text: "a", completed: true },
    { step: 2, text: "b", completed: false },
  ]);
});

test("the plan_step_complete tool reports the registered result", async () => {
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

  const tool = pi.tools["plan_step_complete"] as {
    execute: (...args: unknown[]) => Promise<{
      content: { type: string; text: string }[];
      details: { step: number };
    }>;
  };
  assert.ok(tool, "expected the plan_step_complete tool to be registered");

  await registerStep(ctx, pi, 1);
  const result = await tool.execute("id", { step: 1 }, undefined, undefined, {});

  assert.deepEqual(result.content, [
    { type: "text", text: "Registered step 1 (a). Completed: 1/1." },
  ]);
  assert.deepEqual(result.details, { step: 1 });
});

test("blocks registration outside the executing phase", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const offResult = await registerStep(ctx, pi, 1);
  assert.equal((offResult as { block: boolean }).block, true);
  assert.match((offResult as { reason: string }).reason, /only available while executing/);

  await pi.commands["plan"]?.handler(undefined, ctx);
  const overviewResult = await registerStep(ctx, pi, 1);
  assert.equal((overviewResult as { block: boolean }).block, true);
  assert.match((overviewResult as { reason: string }).reason, /only available while executing/);
  assert.deepEqual(lastEntryData(pi).todos, []);
});

test("blocks out-of-range and non-integer steps", async () => {
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

  const zero = await registerStep(ctx, pi, 0);
  assert.equal((zero as { block: boolean }).block, true);
  assert.match((zero as { reason: string }).reason, /No matching step 0/);

  const high = await registerStep(ctx, pi, 99);
  assert.equal((high as { block: boolean }).block, true);
  assert.match((high as { reason: string }).reason, /the plan has steps 1\.\.1/);

  const text = await callHandler(pi, "tool_call", stepCall("x"), ctx);
  assert.equal((text as { block: boolean }).block, true);
  assert.match((text as { reason: string }).reason, /No matching step x/);

  assert.deepEqual(lastEntryData(pi).todos, [{ step: 1, text: "a", completed: false }]);
});

test("blocks registration when the executing todo list is empty", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", { phase: "executing", todos: [], planFileName: "plan.md" }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = await registerStep(ctx, pi, 1);

  assert.equal((result as { block: boolean }).block, true);
  assert.match((result as { reason: string }).reason, /the plan has no steps/);
});

test("blocks duplicate registration", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [{ step: 1, text: "a", completed: true }],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = await registerStep(ctx, pi, 1);

  assert.equal((result as { block: boolean }).block, true);
  assert.match((result as { reason: string }).reason, /already registered/);
});

test("blocks out-of-order registration and names the pending step", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "a", completed: false },
        { step: 2, text: "b", completed: false },
        { step: 3, text: "c", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = await registerStep(ctx, pi, 3);

  assert.equal((result as { block: boolean }).block, true);
  assert.match(
    (result as { reason: string }).reason,
    /Step 3 is not next: step 1 \(a\) is still pending/,
  );
});

// --- progress check protocol ---

test("fires a progress check when a run wrote but registered no step", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const { ctx } = createFakeCtx({ entries: executingEntries() });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.deepEqual(pi.sentUserMessages[0]?.options, { deliverAs: "followUp" });
  assert.match(pi.sentUserMessages[0]?.text ?? "", /PROGRESS CHECK/);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Step 1 \(one\): call plan_step_complete\(1\)/);
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Completed: 0\/1/);
});

test("does not check when the run registered a step", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "one", completed: false },
        { step: 2, text: "two", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await registerStep(ctx, pi, 1);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 0);
});

test("does not check when the run made no writes", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const { ctx } = createFakeCtx({ entries: executingEntries() });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 0);
});

test("the handoff replay: blocked calls surface the missing step, one check, one repair", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "src/domain/weekView.ts", completed: false },
        { step: 2, text: "src/domain/weekView.spec.ts", completed: false },
        { step: 3, text: "src/pages/home/components/WeekStrip/WeekStrip.tsx", completed: false },
        { step: 4, text: "src/pages/home/components/WeekStrip/WeekStrip.css", completed: false },
        { step: 5, text: "src/pages/home/components/WeekStrip/index.ts", completed: false },
        { step: 6, text: "src/pages/home/Home.tsx", completed: false },
        { step: 7, text: "src/pages/home/Home.spec.tsx", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => writeCall(ctx, pi)));
  await Promise.all(
    [2, 3, 4, 5, 6, 7].map(async (step) => {
      const result = await registerStep(ctx, pi, step);
      assert.equal((result as { block: boolean }).block, true);
      assert.match(
        (result as { reason: string }).reason,
        /Step \d+ is not next: step 1 \(src\/domain\/weekView\.ts\) is still pending/,
      );
    }),
  );
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(
    pi.sentUserMessages[0]?.text ?? "",
    /Step 1 \(src\/domain\/weekView\.ts\): call plan_step_complete\(1\)/,
  );
  assert.match(pi.sentUserMessages[0]?.text ?? "", /Completed: 0\/7/);

  // The reply run registers every step; the plan completes without a second check.
  await callHandler(pi, "agent_start", {}, ctx);
  // Registration order matters (the strict cursor blocks out-of-order calls),
  // so the reply steps stay sequential.
  for (let step = 1; step <= 7; step++) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await registerStep(ctx, pi, step);
    assert.equal(result, undefined);
  }
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.ok(pi.sentMessages.some((m) => m.message.customType === "plan-mode-complete"));
  assert.deepEqual(lastEntryData(pi), {
    phase: "off",
    todos: [],
    planFileName: "plan.md",
  });
});

test("a partial reply fires a narrowed check for the remaining steps", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode", {
      phase: "executing",
      todos: [
        { step: 1, text: "one", completed: true },
        { step: 2, text: "two", completed: false },
        { step: 3, text: "three", completed: false },
      ],
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 1);

  await callHandler(pi, "agent_start", {}, ctx);
  await registerStep(ctx, pi, 2);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 2);
  assert.match(
    pi.sentUserMessages[1]?.text ?? "",
    /Step 3 \(three\): call plan_step_complete\(3\)/,
  );
  assert.doesNotMatch(pi.sentUserMessages[1]?.text ?? "", /plan_step_complete\(2\)/);
  assert.match(pi.sentUserMessages[1]?.text ?? "", /Completed: 2\/3/);

  await callHandler(pi, "agent_start", {}, ctx);
  await registerStep(ctx, pi, 3);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 2);
  assert.ok(pi.sentMessages.some((m) => m.message.customType === "plan-mode-complete"));
});

test("a text-only reply acks the missing state and closes the check", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const { ctx } = createFakeCtx({ entries: executingEntries() });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 1);

  await callHandler(pi, "agent_start", {}, ctx);
  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("none completed")])] },
    ctx,
  );

  assert.equal(pi.sentUserMessages.length, 1);
  const ack = pi.sentMessages.find((m) => m.message.customType === "plan-mode-progress-ack");
  assert.ok(ack, "expected a progress ack");
  assert.match(ack.message.content, /Missing registrations: 1/);
  assert.match(ack.message.content, /Completed: 0\/1/);
  assert.deepEqual(ack.options, { triggerTurn: false });
});

test("a later write run without registration fires a fresh check", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const { ctx } = createFakeCtx({ entries: executingEntries() });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 1);

  await callHandler(pi, "agent_start", {}, ctx);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 1);

  await callHandler(pi, "agent_start", {}, ctx);
  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 2);
});

test("an invalid reply keeps the check closed without re-firing", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const { ctx } = createFakeCtx({ entries: executingEntries() });
  await callHandler(pi, "session_start", {}, ctx);

  await writeCall(ctx, pi);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentUserMessages.length, 1);

  await callHandler(pi, "agent_start", {}, ctx);
  const blocked = await registerStep(ctx, pi, 99);
  assert.equal((blocked as { block: boolean }).block, true);
  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  const ack = pi.sentMessages.find((m) => m.message.customType === "plan-mode-progress-ack");
  assert.ok(ack, "expected a progress ack");
  assert.match(ack.message.content, /Missing registrations: 1/);
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

const toolCallBlock = (step: unknown): unknown => ({
  type: "toolCall",
  id: "x",
  name: "plan_step_complete",
  arguments: { step },
});

test("re-scans plan_step_complete tool calls after the execute marker on resume", async () => {
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
    messageEntry(assistantMessage([toolCallBlock(1)])),
    messageEntry(
      assistantMessage([{ type: "toolCall", id: "y", name: "other_tool", arguments: { step: 2 } }]),
    ),
    messageEntry(
      assistantMessage([{ type: "toolCall", id: "z", name: "plan_step_complete", arguments: {} }]),
    ),
    messageEntry(assistantMessage([{ type: "toolCall", id: "w", name: "plan_step_complete" }])),
    messageEntry(assistantMessage([textBlock("no calls here")])),
    messageEntry(userMessage("ignored")),
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
    messageEntry(assistantMessage([toolCallBlock(1)])),
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
  assert.ok(pi.tools["plan_step_complete"], "expected the plan_step_complete tool");
});
