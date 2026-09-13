import { strict as assert } from "node:assert";
import { test } from "node:test";
import filePathRulesExtension, { createFilePathRulesExtension } from "./index.ts";
import type { FilePathRulesDeps } from "./deps.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  handlers: Record<string, Handler[]>;
  on(event: string, handler: Handler): void;
}

const createFakePi = (): FakePi => {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = [...(handlers[event] ?? []), handler];
    },
  };
};

interface FakeCtx {
  trusted: boolean;
  cwd: string;
  notifications: { message: string; type?: string }[];
  isProjectTrusted(): boolean;
  ui: { notify(message: string, type?: string): void };
}

const createFakeCtx = (trusted = true): FakeCtx => {
  const notifications: FakeCtx["notifications"] = [];
  return {
    trusted,
    cwd: "/repo",
    notifications,
    isProjectTrusted() {
      return this.trusted;
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push(type ? { message, type } : { message });
      },
    },
  };
};

const ruleDoc = (paths: string, body: string): string => `---\npaths: ${paths}\n---\n${body}`;

const createFakeDeps = (files: Record<string, string>): FilePathRulesDeps => ({
  readFile: (path) => files[path] ?? null,
  readdir: (path) => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = Object.keys(files)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes("/"));
    return names.length > 0 ? names : null;
  },
});

const RULES = {
  "/repo/.pi/rules/pages.md": ruleDoc("'src/pages/**'", "Load the app-domain skill."),
  "/repo/.pi/rules/tests.md": ruleDoc("'**/*.spec.tsx'", "Load the testing-standards skill."),
  "/repo/.pi/rules/agentic.md": ruleDoc("['.agents/**/*.md', 'AGENTS.md']", "Keep edits minimal."),
};

type Extension = Parameters<typeof createFilePathRulesExtension>[0];

const createExtension = (
  files: Record<string, string> = RULES,
  trusted = true,
): { pi: FakePi; ctx: FakeCtx } => {
  const pi = createFakePi();
  createFilePathRulesExtension(pi as unknown as Extension, createFakeDeps(files));
  return { pi, ctx: createFakeCtx(trusted) };
};

// Handlers run in registration order - recursion replaces a loop with
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

const toolCallEvent = (toolName: string, toolCallId: string, path: string): unknown => ({
  toolName,
  toolCallId,
  input: { path },
});

const toolResultEvent = (
  toolName: string,
  toolCallId: string,
  input: unknown,
  content: unknown[] = [{ type: "text", text: "original content" }],
): unknown => ({ toolName, toolCallId, input, content });

const textBlock = (text: string): { type: "text"; text: string } => ({ type: "text", text });

const startSession = async (pi: FakePi, ctx: FakeCtx): Promise<void> => {
  await callHandler(pi, "session_start", {}, ctx);
};

const appendedTextOf = (result: unknown): string => {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const appended = content[content.length - 1];
  return appended?.text ?? "";
};

// --- loading and trust ---

test("loads rules and notifies each config error at session start", async () => {
  const { pi, ctx } = createExtension({
    ...RULES,
    "/repo/.pi/rules/bad.md": ruleDoc("[]", "body"),
    "/repo/.pi/rules/worse.md": "---\npaths: [unclosed\n---\nbody",
  });
  await startSession(pi, ctx);

  assert.equal(ctx.notifications.length, 2);
  assert.match(ctx.notifications[0]?.message ?? "", /bad\.md: "paths" must be/);
  assert.match(ctx.notifications[1]?.message ?? "", /worse\.md: invalid front matter/);
});

test("an untrusted session loads nothing, notifies nothing, and never fires", async () => {
  const { pi, ctx } = createExtension({ "/repo/.pi/rules/bad.md": ruleDoc("[]", "body") }, false);
  await startSession(pi, ctx);
  assert.equal(ctx.notifications.length, 0);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "AGENTS.md"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "AGENTS.md" }),
    ctx,
  );
  assert.equal(result, undefined);
});

// --- firing ---

test("edit on a matching path appends one reminder block", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  const result = (await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.ts" }),
    ctx,
  )) as { content: unknown[] };

  assert.equal(result.content.length, 2);
  assert.deepEqual(result.content[0], textBlock("original content"));
  const appended = result.content[1] as { type: string; text: string };
  assert.equal(appended.type, "text");
  assert.match(
    appended.text,
    /\[file-path-rules\] rule: \.pi\/rules\/pages\.md - matched: src\/pages\/a\.ts/,
  );
  assert.match(appended.text, /Load the app-domain skill\./);
});

test("read and write fire the same way", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("read", "c1", "src/pages/a.ts"), ctx);
  const readResult = (await callHandler(
    pi,
    "tool_result",
    toolResultEvent("read", "c1", { path: "src/pages/a.ts" }),
    ctx,
  )) as { content: unknown[] };
  assert.equal(readResult.content.length, 2);

  await callHandler(pi, "tool_call", toolCallEvent("write", "c2", "src/pages/b.ts"), ctx);
  const writeResult = (await callHandler(
    pi,
    "tool_result",
    toolResultEvent("write", "c2", { path: "src/pages/b.ts" }),
    ctx,
  )) as { content: unknown[] };
  assert.equal(writeResult.content.length, 2);
});

test("a non-path tool never fires", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("bash", "c1", "src/pages/a.ts"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("bash", "c1", { path: "src/pages/a.ts" }),
    ctx,
  );
  assert.equal(result, undefined);
});

test("a path with no matching rule fires nothing", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/lib/a.ts"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/lib/a.ts" }),
    ctx,
  );
  assert.equal(result, undefined);
});

test("an absolute path inside the cwd matches after normalization", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "/repo/src/pages/a.ts"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "/repo/src/pages/a.ts" }),
    ctx,
  );
  assert.match(appendedTextOf(result), /matched: src\/pages\/a\.ts/);
});

test("a path outside the cwd never matches", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "/other/AGENTS.md"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "/other/AGENTS.md" }),
    ctx,
  );
  assert.equal(result, undefined);
});

// --- dedupe and pending ---

test("a second touch of the same file stays silent", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.ts" }),
    ctx,
  );

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c2", "src/pages/a.ts"), ctx);
  const second = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c2", { path: "src/pages/a.ts" }),
    ctx,
  );
  assert.equal(second, undefined);
});

test("a different file under the same rule fires again", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.ts" }),
    ctx,
  );

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c2", "src/pages/b.ts"), ctx);
  const second = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c2", { path: "src/pages/b.ts" }),
    ctx,
  );
  assert.match(appendedTextOf(second), /matched: src\/pages\/b\.ts/);
});

test("a blocked call consumes its reminder without appending it", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);

  const retry = await callHandler(
    pi,
    "tool_call",
    toolCallEvent("edit", "c2", "src/pages/a.ts"),
    ctx,
  );
  assert.equal(retry, undefined);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c2", { path: "src/pages/a.ts" }),
    ctx,
  );
  assert.equal(result, undefined);
});

test("pending entries are independent per toolCallId", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  await callHandler(pi, "tool_call", toolCallEvent("edit", "c2", "src/pages/b.ts"), ctx);

  const second = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c2", { path: "src/pages/b.ts" }),
    ctx,
  );
  assert.match(appendedTextOf(second), /matched: src\/pages\/b\.ts/);

  const first = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.ts" }),
    ctx,
  );
  assert.match(appendedTextOf(first), /matched: src\/pages\/a\.ts/);
});

test("multiple rules on one path append one block per rule in file order", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.spec.tsx"), ctx);
  const result = (await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.spec.tsx" }),
    ctx,
  )) as { content: Array<{ text?: string }> };

  assert.equal(result.content.length, 3);
  const texts = result.content.slice(1).map((block) => block.text ?? "");
  assert.match(texts[0] ?? "", /rule: \.pi\/rules\/pages\.md/);
  assert.match(texts[1] ?? "", /rule: \.pi\/rules\/tests\.md/);
  assert.match(texts[1] ?? "", /Load the testing-standards skill\./);
});

test("a reload re-reads the rules and resets the dedupe", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: "src/pages/a.ts" }),
    ctx,
  );

  await startSession(pi, ctx);
  await callHandler(pi, "tool_call", toolCallEvent("edit", "c2", "src/pages/a.ts"), ctx);
  const afterReload = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c2", { path: "src/pages/a.ts" }),
    ctx,
  );
  assert.match(appendedTextOf(afterReload), /Load the app-domain skill\./);
});

test("a tool result without a path string still appends with an empty match", async () => {
  const { pi, ctx } = createExtension();
  await startSession(pi, ctx);

  await callHandler(pi, "tool_call", toolCallEvent("edit", "c1", "src/pages/a.ts"), ctx);
  const result = await callHandler(
    pi,
    "tool_result",
    toolResultEvent("edit", "c1", { path: 42 }),
    ctx,
  );
  assert.match(appendedTextOf(result), /matched: /);
});

// --- default export ---

test("the default export registers the extension with default deps", () => {
  const pi = createFakePi();
  filePathRulesExtension(pi as unknown as Extension);

  assert.ok(pi.handlers["session_start"]?.length);
  assert.ok(pi.handlers["tool_call"]?.length);
  assert.ok(pi.handlers["tool_result"]?.length);
});
