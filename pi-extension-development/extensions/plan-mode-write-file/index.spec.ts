import { strict as assert } from "node:assert";
import { test } from "node:test";
import planModeWriteFileExtension, { createPlanModeWriteFileExtension } from "./index.ts";
import type { PlanModeWriteFileDeps } from "./deps.ts";

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

interface FakePi {
  handlers: Record<string, Handler[]>;
  commands: Record<string, { description: string; handler: CommandHandler }>;
  shortcuts: ShortcutHandler[];
  flags: Record<string, unknown>;
  entries: FakeEntry[];
  sentMessages: SentMessage[];
  sentUserMessages: { text: string; options: Record<string, unknown> }[];
  on(event: string, handler: Handler): void;
  registerCommand(name: string, def: { description: string; handler: CommandHandler }): void;
  registerShortcut(_key: unknown, def: { handler: ShortcutHandler }): void;
  registerFlag(name: string, def: { default?: unknown }): void;
  getFlag(name: string): unknown;
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

interface FakeCtx {
  ctx: unknown;
  notifications: { message: string; type?: string }[];
  statusUpdates: Array<string | undefined>;
  widgetUpdates: Array<string[] | undefined>;
}

const createFakeCtx = (
  options: {
    hasUI?: boolean;
    editorResponses?: Array<string | null>;
    selectResponses?: Array<string | null>;
    entries?: unknown[];
  } = {},
) => {
  const editorResponses = [...(options.editorResponses ?? [])];
  const selectResponses = [...(options.selectResponses ?? [])];
  const notifications: FakeCtx["notifications"] = [];
  const statusUpdates: FakeCtx["statusUpdates"] = [];
  const widgetUpdates: FakeCtx["widgetUpdates"] = [];

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
      setStatus: (_key: string, value: string | undefined) => {
        statusUpdates.push(value);
      },
      setWidget: (_key: string, lines: string[] | undefined) => {
        widgetUpdates.push(lines);
      },
      theme: {
        fg: (_color: string, text: string) => text,
        strikethrough: (text: string) => text,
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
    },
  };

  return { ctx, notifications, statusUpdates, widgetUpdates, editorResponses };
};

const createFakeDeps = (files: string[]): PlanModeWriteFileDeps => ({
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
  createPlanModeWriteFileExtension(
    pi as unknown as Parameters<typeof createPlanModeWriteFileExtension>[0],
    createFakeDeps(files),
  );
  return { pi };
};

// --- Tool gating: failures first ---

test("blocks write and edit to any file other than the locked plan file", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

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
    { toolName: "edit", input: { path: "other.md", content: "x" } },
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

  const allowedEdit = await callHandler(
    pi,
    "tool_call",
    { toolName: "edit", input: { path: "plan.md", content: "x" } },
    ctx,
  );
  assert.equal(allowedEdit, undefined);
});

test("basename comparison: paths that end in the plan file name are allowed", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  const nested = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "../some/dir/plan.md", content: "x" } },
    ctx,
  );
  assert.equal(nested, undefined);

  const blocked = await callHandler(
    pi,
    "tool_call",
    { toolName: "edit", input: { path: "dir/other-plan.md", content: "x" } },
    ctx,
  );
  assert.equal((blocked as { block: boolean }).block, true);
});

test("blocks unsafe bash commands and allows allowlisted read-only ones", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  const rm = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "rm -rf /" } },
    ctx,
  );
  assert.equal((rm as { block: boolean }).block, true);

  const sudo = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "sudo ls" } },
    ctx,
  );
  assert.equal((sudo as { block: boolean }).block, true);

  const ls = await callHandler(
    pi,
    "tool_call",
    { toolName: "bash", input: { command: "ls -la" } },
    ctx,
  );
  assert.equal(ls, undefined);
});

test("leaves tools that are not bash, write, or edit alone", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  const result = await callHandler(
    pi,
    "tool_call",
    { toolName: "read", input: { path: "any.md" } },
    ctx,
  );
  assert.equal(result, undefined);
});

test("does not gate anything while plan mode is off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const result = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "anything.md", content: "x" } },
    ctx,
  );
  assert.equal(result, undefined);
});

// --- Naming failures ---

test("cancelling the name prompt aborts toggle-on", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, statusUpdates } = createFakeCtx({ editorResponses: [null] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(!notifications.some((n) => n.message.includes("enabled")));
  assert.equal(statusUpdates.length, 0);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

test("re-prompts when the chosen name already exists in cwd", async () => {
  const { pi } = createExtension(["/virtual/cwd/taken.md"]);
  const { ctx, notifications } = createFakeCtx({ editorResponses: ["taken", "free"] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("free.md")));
  assert.ok(!notifications.some((n) => n.message.includes("taken.md")));
});

test("cancelling the second attempt after a collision leaves plan mode off", async () => {
  const { pi } = createExtension(["/virtual/cwd/taken.md"]);
  const { ctx, notifications } = createFakeCtx({ editorResponses: ["taken", null] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(!notifications.some((n) => n.message.includes("enabled")));
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

// --- Toggle lifecycle ---

test("toggles on: locks the name, notifies, persists, and sets status", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, statusUpdates } = createFakeCtx({ editorResponses: ["my-plan"] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("Only my-plan.md")));
  assert.equal(statusUpdates.at(-1), "plan-write-file: on");
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: true,
    todos: [],
    executing: false,
    planFileName: "my-plan.md",
  });
});

test("blank input falls back to the default plan.md name", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx({ editorResponses: [""] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("Only plan.md")));
  await pi.commands["plan-write-file-name"]?.handler(undefined, ctx);
  assert.ok(notifications.some((n) => n.message === "Plan file: plan.md"));
});

test("reuses the existing lock without re-prompting while the file exists", async () => {
  const { pi } = createExtension(["/virtual/cwd/my-plan.md"]);
  const { ctx, editorResponses } = createFakeCtx({ editorResponses: ["my-plan"] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // on
  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // off
  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // on again, no prompt

  assert.equal(editorResponses.length, 0);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "my-plan.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

test("re-prompts when the locked file vanished between toggles", async () => {
  const files = ["/virtual/cwd/my-plan.md"];
  const { pi } = createExtension(files);
  const { ctx, notifications } = createFakeCtx({ editorResponses: ["my-plan", "fresh"] });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // on
  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // off
  files.pop(); // locked file vanishes
  await pi.commands["plan-write-file"]?.handler(undefined, ctx); // on, re-prompt

  assert.ok(notifications.some((n) => n.message.includes("Only fresh.md")));
});

test("toggles off: notifies, clears status, and opens the gate", async () => {
  const { pi } = createExtension();
  const { ctx, notifications, statusUpdates, widgetUpdates } = createFakeCtx({
    editorResponses: ["plan"],
  });

  await pi.commands["plan-write-file"]?.handler(undefined, ctx);
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("disabled")));
  assert.equal(statusUpdates.at(-1), undefined);
  assert.equal(widgetUpdates.at(-1), undefined);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "anything.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

// --- Commands ---

test("plan-write-file-name shows the hint before a name is locked", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx();

  await pi.commands["plan-write-file-name"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("No plan file set yet")));
});

test("plan-write-file-todos with no todos shows the info message", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx();

  await pi.commands["plan-write-file-todos"]?.handler(undefined, ctx);

  assert.ok(notifications.some((n) => n.message.includes("No todos. Create a plan first")));
});

test("plan-write-file-todos lists items with done markers", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [
        { step: 1, text: "a", completed: true },
        { step: 2, text: "b", completed: false },
      ],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx, notifications } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan-write-file-todos"]?.handler(undefined, ctx);

  const list = notifications.find((n) => n.message.includes("Plan Progress"));
  assert.ok(list);
  assert.match(list.message, /1\. \[x\] a/);
  assert.match(list.message, /2\. \[ \] b/);
});

test("the Ctrl+Alt+P shortcut toggles plan mode", async () => {
  const { pi } = createExtension();
  const { ctx, notifications } = createFakeCtx({ editorResponses: ["plan"] });

  assert.equal(pi.shortcuts.length, 1);
  await pi.shortcuts[0]?.(ctx);

  assert.ok(notifications.some((n) => n.message.includes("enabled")));
});

// --- Context filtering ---

test("filters plan-write-file context out of history while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const result = await callHandler(
    pi,
    "context",
    {
      messages: [
        { customType: "plan-write-file-context", role: "user", content: "marker" },
        assistantMessage([textBlock("keep assistant")]),
        userMessage("text with [PLAN WRITE FILE ACTIVE] marker"),
        userMessage([textBlock("keeps [PLAN WRITE FILE ACTIVE]")]),
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

test("does not filter context while plan mode is on", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  const result = await callHandler(pi, "context", { messages: [] }, ctx);
  assert.equal(result, undefined);
});

// --- before_agent_start injection ---

test("injects the plan context before an agent starts while on", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ editorResponses: ["plan"] });
  await pi.commands["plan-write-file"]?.handler(undefined, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string; display: boolean };
  };
  assert.equal(result.message.customType, "plan-write-file-context");
  assert.match(result.message.content, /\[PLAN WRITE FILE ACTIVE\]/);
  assert.match(result.message.content, /only file you may write or edit is plan\.md/);
  assert.equal(result.message.display, false);
});

test("injects the execution context before an agent starts while executing", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-write-file-execution-context");
  assert.match(result.message.content, /1\. a/);
});

test("execution context lists only unfinished steps", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [
        { step: 1, text: "a", completed: true },
        { step: 2, text: "b", completed: false },
      ],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = (await callHandler(pi, "before_agent_start", {}, ctx)) as {
    message: { customType: string; content: string };
  };
  assert.equal(result.message.customType, "plan-write-file-execution-context");
  assert.doesNotMatch(result.message.content, /1\. a/);
  assert.match(result.message.content, /2\. b/);
});

test("injects nothing before an agent starts while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  const result = await callHandler(pi, "before_agent_start", {}, ctx);
  assert.equal(result, undefined);
});

test("injects nothing while executing with an empty todo list", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [],
      executing: true,
      planFileName: null,
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  const result = await callHandler(pi, "before_agent_start", {}, ctx);
  assert.equal(result, undefined);
});

// --- turn_end progress ---

test("ignores turns while not executing", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx();

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("x")]) }, ctx);
  assert.equal(pi.entries.length, 0);
});

test("ignores turns while executing with no todos", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [],
      executing: true,
      planFileName: null,
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("x")]) }, ctx);
  assert.equal(pi.entries.length, 1);
});

test("ignores non-assistant messages at turn end", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "turn_end", { message: userMessage("[DONE:1]") }, ctx);

  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [{ step: 1, text: "a", completed: false }],
    executing: true,
    planFileName: "plan.md",
  });
});

test("marks DONE steps at turn end and updates the status widget", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [
        { step: 1, text: "a", completed: false },
        { step: 2, text: "b", completed: false },
      ],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx, statusUpdates, widgetUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("[DONE:1]")]) }, ctx);

  assert.equal(statusUpdates.at(-1), "plan 1/2");
  assert.deepEqual(widgetUpdates.at(-1), ["[x] a", "[ ] b"]);
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [
      { step: 1, text: "a", completed: true },
      { step: 2, text: "b", completed: false },
    ],
    executing: true,
    planFileName: "plan.md",
  });
});

test("persists at turn end even without DONE markers", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx, statusUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);
  const statusCount = statusUpdates.length;

  await callHandler(pi, "turn_end", { message: assistantMessage([textBlock("no markers")]) }, ctx);

  assert.equal(statusUpdates.length, statusCount);
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [{ step: 1, text: "a", completed: false }],
    executing: true,
    planFileName: "plan.md",
  });
});

// --- agent_end completion and next-action prompt ---

test("sends the complete message and clears execution when all steps are done", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: true }],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx, statusUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);

  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-write-file-complete");
  assert.match(pi.sentMessages[0]?.message.content ?? "", /~~a~~/);
  assert.deepEqual(pi.sentMessages[0]?.options, { triggerTurn: false });
  assert.equal(statusUpdates.at(-1), undefined);
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [],
    executing: false,
    planFileName: "plan.md",
  });
});

test("sends nothing while executing with incomplete steps", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: true,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("does nothing at agent end while off", async () => {
  const { pi } = createExtension();
  const { ctx } = createFakeCtx({ selectResponses: ["Execute the plan (track progress)"] });

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("does nothing at agent end without UI", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, hasUI: false });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(pi, "agent_end", { messages: [] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("does nothing at agent end when no todos were extracted", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
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

  await callHandler(pi, "agent_end", { messages: [userMessage("no plan")] }, ctx);
  assert.equal(pi.sentMessages.length, 0);
});

test("keeps the old todos when extraction finds none", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [{ step: 1, text: "old", completed: false }],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, selectResponses: ["Stay in plan mode"] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("no plan here")])] },
    ctx,
  );

  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: true,
    todos: [{ step: 1, text: "old", completed: false }],
    executing: false,
    planFileName: "plan.md",
  });
});

test("extracts todos and executes the plan on the Execute choice", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({
    entries,
    selectResponses: ["Execute the plan (track progress)"],
  });
  await callHandler(pi, "session_start", {}, ctx);

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

  assert.equal(pi.sentMessages.length, 2);
  assert.equal(pi.sentMessages[0]?.message.customType, "plan-write-file-todo-list");
  assert.equal(pi.sentMessages[1]?.message.customType, "plan-write-file-execute");
  assert.match(pi.sentMessages[1]?.message.content ?? "", /Start with: First step here/);
  assert.deepEqual(pi.sentMessages[1]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [
      { step: 1, text: "First step here", completed: false },
      { step: 2, text: "Second step here", completed: false },
    ],
    executing: true,
    planFileName: "plan.md",
  });
});

test("stays in plan mode on the Stay choice", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, selectResponses: ["Stay in plan mode"] });
  await callHandler(pi, "session_start", {}, ctx);

  await callHandler(
    pi,
    "agent_end",
    { messages: [assistantMessage([textBlock("Plan:\n1. First step here")])] },
    ctx,
  );

  assert.equal(pi.sentMessages.length, 0);
  const entry = pi.entries.at(-1);
  assert.ok(entry);
  assert.equal((entry.data as { enabled: boolean }).enabled, true);
});

test("refines the plan by sending the refinement as a user message", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
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

  assert.equal(pi.sentMessages[0]?.message.customType, "plan-write-file-todo-list");
  assert.deepEqual(pi.sentUserMessages[0], {
    text: "make it smaller",
    options: { deliverAs: "followUp" },
  });
});

test("sends nothing for an empty refinement", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
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

test("sends nothing when the next-action prompt is cancelled", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "plan.md",
    }),
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
});

// --- session_start restore ---

test("prompts for a name when started with the plan-write-file flag", async () => {
  const { pi } = createExtension();
  pi.flags["plan-write-file"] = true;
  const { ctx, notifications } = createFakeCtx({ editorResponses: ["from-flag"] });

  await callHandler(pi, "session_start", {}, ctx);

  await pi.commands["plan-write-file-name"]?.handler(undefined, ctx);
  assert.ok(notifications.some((n) => n.message === "Plan file: from-flag.md"));
});

test("falls back silently to the default name in headless runs", async () => {
  const { pi } = createExtension();
  pi.flags["plan-write-file"] = true;
  const { ctx } = createFakeCtx({ hasUI: false });

  await callHandler(pi, "session_start", {}, ctx);

  const entry = pi.entries.at(-1);
  assert.ok(entry);
  assert.equal((entry.data as { planFileName: string }).planFileName, "plan.md");
});

test("disables plan mode when naming is cancelled at startup", async () => {
  const { pi } = createExtension();
  pi.flags["plan-write-file"] = true;
  const { ctx, statusUpdates } = createFakeCtx({ editorResponses: [null] });

  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(statusUpdates.at(-1), undefined);
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

test("restores state and re-scans DONE markers after the execute marker", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [
        { step: 1, text: "a", completed: false },
        { step: 2, text: "b", completed: false },
      ],
      executing: true,
      planFileName: "plan.md",
    }),
    customEntry("plan-write-file-execute", {}),
    messageEntry(assistantMessage([textBlock("finished [DONE:1]")])),
    messageEntry(userMessage("[DONE:2] ignored")),
    messageEntry({ role: "assistant", content: "not an array" }),
    customEntry("other", {}),
    { type: "message" },
  ];
  const { ctx, statusUpdates } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.equal(statusUpdates.at(-1), "plan 1/2");
  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: true,
    todos: [
      { step: 1, text: "a", completed: true },
      { step: 2, text: "b", completed: false },
    ],
    executing: true,
    planFileName: "plan.md",
  });
});

test("re-scans from the start when no execute marker exists", async () => {
  const { pi } = createExtension(["/virtual/cwd/plan.md"]);
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: false,
      todos: [{ step: 1, text: "a", completed: false }],
      executing: true,
      planFileName: "plan.md",
    }),
    messageEntry(assistantMessage([textBlock("did [DONE:1]")])),
  ];
  const { ctx } = createFakeCtx({ entries });
  await callHandler(pi, "session_start", {}, ctx);

  assert.deepEqual(pi.entries.at(-1)?.data, {
    enabled: false,
    todos: [{ step: 1, text: "a", completed: true }],
    executing: true,
    planFileName: "plan.md",
  });
});

test("restores with empty data by keeping the defaults", async () => {
  const { pi } = createExtension();
  const entries = [customEntry("plan-mode-write-file", {})];
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

test("re-prompts at startup when the restored file vanished", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "gone.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, editorResponses: ["replacement"] });
  await callHandler(pi, "session_start", {}, ctx);

  const entry = pi.entries.at(-1);
  assert.ok(entry);
  assert.equal((entry.data as { planFileName: string }).planFileName, "replacement.md");
});

test("disables plan mode at startup when the replacement naming is cancelled", async () => {
  const { pi } = createExtension();
  const entries = [
    customEntry("plan-mode-write-file", {
      enabled: true,
      todos: [],
      executing: false,
      planFileName: "gone.md",
    }),
  ];
  const { ctx } = createFakeCtx({ entries, editorResponses: [null] });
  await callHandler(pi, "session_start", {}, ctx);

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
  const write = await callHandler(
    pi,
    "tool_call",
    { toolName: "write", input: { path: "x.md", content: "x" } },
    ctx,
  );
  assert.equal(write, undefined);
});

// --- default export ---

test("the default export registers the extension with default deps", () => {
  const pi = createFakePi();
  planModeWriteFileExtension(
    pi as unknown as Parameters<typeof createPlanModeWriteFileExtension>[0],
  );

  assert.ok(pi.handlers["session_start"]?.length);
  assert.ok(pi.commands["plan-write-file"]);
  assert.ok(pi.commands["plan-write-file-todos"]);
  assert.ok(pi.shortcuts.length > 0);
});
