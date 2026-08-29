import { strict as assert } from "node:assert";
import { test } from "node:test";
import createCodebaseMemoryMcpEnforcerExtension, {
  defaultDeps,
  type CodebaseMemoryMcpEnforcerDeps,
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
  cwd = "/virtual/repo",
): CodebaseMemoryMcpEnforcerDeps {
  return {
    existsSync: (path: string) => existingPaths.includes(path),
    cwd: () => cwd,
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

type Pi = Parameters<typeof createCodebaseMemoryMcpEnforcerExtension>[0];

// 20 directory levels deep: the walk checks at most 17 directories (the
// cwd plus 16 parents), so it exhausts its budget before reaching the
// filesystem root and findGitRoot returns null.
const DEEP_CWD =
  "/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/thirteen/fourteen/fifteen/sixteen/seventeen/eighteen/nineteen/twenty";

test("registers one handler each for tool_call and before_agent_start", () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi);
  assert.deepEqual([...pi.handlers.keys()].toSorted(), ["before_agent_start", "tool_call"]);
});

test("default deps use the real cwd", () => {
  assert.equal(defaultDeps.cwd(), process.cwd());
});

test("blocks bash code-search with the ladder message", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  // Step 5 carries the unreachable exit.
  assert.ok(result.reason.includes("Inform the user and stop this line of work"));
  assert.ok(!result.reason.includes("codebase_memory_mcp_"));
  // No prose escape hatch anywhere.
  assert.ok(!result.reason.includes("genuinely unavailable"));
});

test("blocks when the git root sits above the cwd", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/.git"], "/virtual/repo");
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "rg foo" },
  })) as { block: boolean };

  assert.equal(result.block, true);
});

test("allows bash commands that are neither allowlisted nor code search", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "date" },
  });
  assert.equal(result, undefined);
});

test("allows every allowlisted leading command", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "echo $(rg -n foo src)" },
  })) as { block: boolean };

  assert.equal(result.block, true);
});

test("blocks an allowlisted command piped, chained, or process-substituted into search", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "read",
    input: { path: "README.md" },
  });
  assert.equal(result, undefined);
});

test("allows code search outside a git repo (walk exhausts its depth budget)", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps([], DEEP_CWD);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = await callHandler(pi, "tool_call", {
    toolName: "bash",
    input: { command: "rg foo" },
  });
  assert.equal(result, undefined);
});

test("prepends the MCP reminder when inside a git repo", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };

  assert.ok(result.systemPrompt.startsWith("MCP FIRST"));
  assert.ok(result.systemPrompt.endsWith("BASE PROMPT"));
  // The reminder names the real gateway tool and the docs exemption.
  assert.ok(result.systemPrompt.includes("codebase-memory-mcp_search_code"));
  assert.ok(result.systemPrompt.includes("bash grep is legal"));
});

test("leaves the system prompt alone outside a git repo (walk breaks at the root)", async () => {
  const pi = createFakePi();
  const deps = createFakeDeps([], "/w");
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);

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
