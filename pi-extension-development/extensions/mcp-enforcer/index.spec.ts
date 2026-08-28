import { strict as assert } from "node:assert";
import { test } from "node:test";
import mcpEnforcerExtension, {
  createMcpEnforcerExtension,
  defaultDeps,
  type McpEnforcerDeps,
  type McpStatus,
} from "./index.ts";

// --- Minimal fake for the pi extension API surface this extension uses ---

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
  handlers: Map<string, Handler[]>;
  on(event: string, handler: Handler): void;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

// Fully in-memory deps fake — no real disk I/O, no chdir, no temp dirs.
// `existingPaths` holds the exact paths existsSync answers for; the extension
// joins "<dir>/.git" itself, so tests list those full paths.
function createFakeDeps(
  existingPaths: string[] = [],
  status: McpStatus = "not_connected",
  cwd = "/virtual/repo",
): McpEnforcerDeps {
  const paths = new Set(existingPaths);
  return {
    existsSync: (path: string) => paths.has(path),
    cwd: () => cwd,
    getMcpStatus: () => status,
  };
}

async function callHandler(pi: FakePi, event: string, eventPayload: unknown): Promise<unknown> {
  const list = pi.handlers.get(event) ?? [];
  // Handlers must run in registration order — later ones can observe
  // mutations made by earlier ones (matches pi's real dispatch semantics),
  // so this is genuinely sequential and recursion replaces a loop with
  // await inside.
  async function runFrom(index: number): Promise<unknown> {
    if (index >= list.length) return undefined;
    const handler = list[index] as Handler;
    // The enforcer's handlers ignore ctx; pass undefined for the second slot.
    const result = await handler(eventPayload, undefined);
    if (index === list.length - 1) return result;
    return runFrom(index + 1);
  }
  return runFrom(0);
}

type Pi = Parameters<typeof createMcpEnforcerExtension>[0];

// 20 directory levels deep: the walk's 16-level budget ends before the walk
// can reach the filesystem root, so findGitRoot returns null via exhaustion.
const DEEP_CWD =
  "/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/thirteen/fourteen/fifteen/sixteen/seventeen/eighteen/nineteen/twenty";

test("registers one handler each for tool_call and before_agent_start", () => {
  const pi = createFakePi();
  createMcpEnforcerExtension(pi as unknown as Pi);
  assert.deepEqual([...pi.handlers.keys()].toSorted(), ["before_agent_start", "tool_call"]);
});

test("default export wires the factory with the default deps", () => {
  const pi = createFakePi();
  mcpEnforcerExtension(pi as unknown as Pi);
  assert.ok(pi.handlers.has("tool_call"));
  assert.ok(pi.handlers.has("before_agent_start"));
});

test("default deps use the real cwd and the Phase-0 placeholder status", () => {
  assert.equal(typeof defaultDeps.cwd(), "string");
  assert.equal(defaultDeps.getMcpStatus(), "not_connected");
});

test("deps carry an injectable MCP status (scaffold for Phase 2)", () => {
  const deps = createFakeDeps([], "unreachable");
  assert.equal(deps.getMcpStatus(), "unreachable");
});

test("blocks bash code-search inside a git repo", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "grep -rn foo src/" },
  })) as { block: boolean; reason: string };

  assert.equal(result.block, true);
  assert.ok(result.reason.includes("MCP FIRST"));
  assert.ok(result.reason.includes("codebase_memory_mcp_search_code"));
  // The v1 prose escape hatch stays until Phase 2 removes it.
  assert.ok(result.reason.includes("If MCP is genuinely unavailable"));
});

test("blocks when the git root sits above the cwd", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/.git"], "not_connected", "/virtual/repo");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "rg foo" },
  })) as { block: boolean };

  assert.equal(result.block, true);
});

test("allows bash commands that do not look like code search", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "echo hello" },
  });
  assert.equal(result, undefined);
});

test("allows tool calls that are not bash", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "read",
    input: { path: "README.md" },
  });
  assert.equal(result, undefined);
});

test("allows code search outside a git repo (walk exhausts its depth budget)", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps([], "not_connected", DEEP_CWD);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "rg foo" },
  });
  assert.equal(result, undefined);
});

test("prepends the MCP reminder when inside a git repo", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };

  assert.ok(result.systemPrompt.startsWith("🔴 MCP FIRST"));
  assert.ok(result.systemPrompt.endsWith("BASE PROMPT"));
});

test("leaves the system prompt alone outside a git repo (walk breaks at the root)", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps([], "not_connected", "/w");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "before_agent_start", { systemPrompt: "BASE" });
  assert.equal(result, undefined);
});

test("callHandler runs handlers in registration order and returns the last result", async () => {
  const pi = createFakePi();
  const seen: string[] = [];
  pi.on("tool_call", () => {
    seen.push("first");
  });
  pi.on("tool_call", () => {
    seen.push("second");
    return { block: true, reason: "from the second handler" };
  });

  const result = (await callHandler(pi, "tool_call", {})) as { block: boolean };
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(result.block, true);

  assert.equal(await callHandler(pi, "event-without-handlers", {}), undefined);
});
