import { strict as assert } from "node:assert";
import { test } from "node:test";
import mcpEnforcerExtension, {
  createDefaultDeps,
  createMcpEnforcerExtension,
  type McpEnforcerDeps,
  type McpStatus,
} from "./index.ts";

// --- Minimal fake for the pi extension API surface this extension uses ---

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
  handlers: Map<string, Handler[]>;
  statusHandlers: Map<string, (data: unknown) => void>;
  subscribedChannels: string[];
  on(event: string, handler: Handler): void;
  events: {
    on(channel: string, handler: (data: unknown) => void): void;
  };
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const statusHandlers = new Map<string, (data: unknown) => void>();
  const subscribedChannels: string[] = [];
  return {
    handlers,
    statusHandlers,
    subscribedChannels,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: {
      on(channel, handler) {
        subscribedChannels.push(channel);
        statusHandlers.set(channel, handler);
      },
    },
  };
}

// The extension always subscribes before a test fires an event, so the cast
// is safe and keeps the helper branch-free.
const fireStatusEvent = (pi: FakePi, snapshot: unknown): void => {
  const handler = pi.statusHandlers.get("pi-mcp-adapter/status/v1") as (data: unknown) => void;
  handler(snapshot);
};

// Fully in-memory deps fake — no real disk I/O, no chdir, no temp dirs.
// `existingPaths` holds the exact paths existsSync answers for; the extension
// joins "<dir>/.git" itself, so tests list those full paths.
function createFakeDeps(
  existingPaths: string[] = [],
  status: McpStatus = "not_connected",
  cwd = "/virtual/repo",
): McpEnforcerDeps & { recorded: unknown[] } {
  const paths = new Set(existingPaths);
  const recorded: unknown[] = [];
  return {
    existsSync: (path: string) => paths.has(path),
    cwd: () => cwd,
    getMcpStatus: () => status,
    recordMcpStatusSnapshot: (snapshot: unknown): void => {
      recorded.push(snapshot);
    },
    recorded,
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

// A snapshot carrying exactly one server entry for the configured server.
const snapshotWithStatus = (status: string): unknown => ({
  version: 1,
  servers: [{ name: "codebase-memory-mcp", status, toolCount: 15, disabled: false }],
  totalTools: 15,
  totalResources: 0,
  connectedCount: status === "connected" ? 1 : 0,
  disabledCount: 0,
});

test("registers handlers and subscribes to the adapter status channel", () => {
  const pi = createFakePi();
  createMcpEnforcerExtension(pi as unknown as Pi);
  assert.deepEqual([...pi.handlers.keys()].toSorted(), ["before_agent_start", "tool_call"]);
  assert.deepEqual(pi.subscribedChannels, ["pi-mcp-adapter/status/v1"]);
});

test("default export wires the factory with the default deps", () => {
  const pi = createFakePi();
  mcpEnforcerExtension(pi as unknown as Pi);
  assert.ok(pi.handlers.has("tool_call"));
  assert.ok(pi.handlers.has("before_agent_start"));
  assert.ok(pi.statusHandlers.has("pi-mcp-adapter/status/v1"));
});

test("default deps use the real cwd and start not connected", () => {
  const deps = createDefaultDeps();
  assert.equal(typeof deps.cwd(), "string");
  assert.equal(deps.getMcpStatus(), "not_connected");
});

test("the default status provider maps adapter snapshots onto the tri-state", () => {
  const deps = createDefaultDeps();

  deps.recordMcpStatusSnapshot(snapshotWithStatus("connected"));
  assert.equal(deps.getMcpStatus(), "connected");

  deps.recordMcpStatusSnapshot(snapshotWithStatus("failed"));
  assert.equal(deps.getMcpStatus(), "unreachable");

  deps.recordMcpStatusSnapshot(snapshotWithStatus("not-connected"));
  assert.equal(deps.getMcpStatus(), "not_connected");
});

test("the default status provider treats other snapshot statuses as not connected", () => {
  const deps = createDefaultDeps();
  // Sequential updates on one provider; each snapshot replaces the last state.
  for (const status of ["cached", "needs-auth", "disabled"]) {
    deps.recordMcpStatusSnapshot(snapshotWithStatus(status));
    assert.equal(deps.getMcpStatus(), "not_connected");
  }
});

test("the default status provider ignores malformed snapshots and missing servers", () => {
  const deps = createDefaultDeps();

  deps.recordMcpStatusSnapshot(null);
  deps.recordMcpStatusSnapshot("not a snapshot");
  deps.recordMcpStatusSnapshot({ version: 1 });
  deps.recordMcpStatusSnapshot({ version: 1, servers: [] });
  deps.recordMcpStatusSnapshot({
    version: 1,
    servers: [
      42,
      { name: "some-other-server", status: "connected", toolCount: 3, disabled: false },
    ],
  });
  assert.equal(deps.getMcpStatus(), "not_connected");
});

test("subscribes to the status channel and records every snapshot", () => {
  const pi = createFakePi();
  const deps = createFakeDeps();
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  fireStatusEvent(pi, snapshotWithStatus("connected"));
  fireStatusEvent(pi, snapshotWithStatus("failed"));
  assert.equal(deps.recorded.length, 2);
});

test("blocks bash code-search with the redirect message when connected", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"], "connected");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "grep -rn foo src/" },
  })) as { block: boolean; reason: string };

  assert.equal(result.block, true);
  assert.ok(result.reason.includes("MCP FIRST"));
  // Real gateway tool names, and the git root is interpolated into step 2.
  assert.ok(result.reason.includes("codebase-memory-mcp_search_code"));
  assert.ok(result.reason.includes('mcp({ connect: "codebase-memory-mcp" })'));
  assert.ok(result.reason.includes('repo_path: "/virtual/repo", mode: "fast"'));
  assert.ok(!result.reason.includes("codebase_memory_mcp_"));
  // No prose escape hatch anywhere.
  assert.ok(!result.reason.includes("genuinely unavailable"));
});

test("blocks with a connect-first message when the server is not connected", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"], "not_connected");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "grep -rn foo src/" },
  })) as { block: boolean; reason: string };

  assert.equal(result.block, true);
  assert.ok(result.reason.includes("The codebase-memory-mcp server is not connected"));
  assert.ok(result.reason.includes('mcp({ connect: "codebase-memory-mcp" })'));
  assert.ok(result.reason.includes("Do not fall back to bash"));
});

test("blocks with a stop message when the server is unreachable", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"], "unreachable");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "grep -rn foo src/" },
  })) as { block: boolean; reason: string };

  assert.equal(result.block, true);
  assert.ok(result.reason.includes("failed to connect"));
  assert.ok(result.reason.includes("Inform the user"));
  assert.ok(result.reason.includes("unreachable"));
  assert.ok(result.reason.includes("Do not fall back to bash"));
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

test("allows bash commands that are neither allowlisted nor code search", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "date" },
  });
  assert.equal(result, undefined);
});

test("allows every allowlisted leading command", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  // The five calls are independent of each other, so they run concurrently.
  const results = await Promise.all(
    ["ls", "pwd", "echo hi", "readlink /virtual/repo", "stat README.md"].map((command) =>
      callHandler(pi, "tool_call", { toolName: "bash", input: { command } }),
    ),
  );
  assert.ok(results.every((result) => result === undefined));
});

test("allows ls with flags and with dashed paths", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const flags = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "ls -la" },
  });
  assert.equal(flags, undefined);

  const dashed = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "ls pi-extension-development" },
  });
  assert.equal(dashed, undefined);
});

test("blocks allowlisted leading commands that nest a search in substitution", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "echo $(rg -n foo src)" },
  })) as { block: boolean };

  assert.equal(result.block, true);
});

test("blocks an allowlisted command piped, chained, or process-substituted into search", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const piped = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "ls foo | grep bar" },
  })) as { block: boolean };
  assert.equal(piped.block, true);

  const chained = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "ls && rg foo" },
  })) as { block: boolean };
  assert.equal(chained.block, true);

  const processSub = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "ls <(rg foo)" },
  })) as { block: boolean };
  assert.equal(processSub.block, true);
});

test("allows grep-family searches that name only docs or config files", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"], "connected");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  // The calls are independent of each other, so they run concurrently.
  const results = await Promise.all(
    [
      "grep -F 'x' README.md",
      "rg 'foo\\|bar' *.md",
      'grep "two words" docs/file.md',
      "ack pattern notes.txt",
      "ag term config.json",
      "rg -i pattern README.md docs/notes.txt",
    ].map((command) => callHandler(pi, "tool_call", { toolName: "bash", input: { command } })),
  );
  assert.ok(results.every((result) => result === undefined));
});

test("blocks searches with code targets, no targets, or compound forms", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"], "connected");
  createMcpEnforcerExtension(pi as unknown as Pi, deps);

  const commands = [
    "grep foo src/*.ts",
    "rg -il caveman",
    "rg",
    "rg foo docs/",
    "grep foo README.md | head",
    "grep foo -r . --include='*.md'",
    "git grep foo -- '*.md'",
  ];

  // The calls are independent of each other, so they run concurrently.
  const results = await Promise.all(
    commands.map((command) =>
      callHandler(pi, "tool_call", { toolName: "bash", input: { command } }),
    ),
  );
  commands.forEach((command, index) => {
    assert.equal((results[index] as { block: boolean }).block, true, command);
  });
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
  // The reminder names the real gateway tool and the docs exemption.
  assert.ok(result.systemPrompt.includes("codebase-memory-mcp_search_code"));
  assert.ok(result.systemPrompt.includes("bash grep is legal"));
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
