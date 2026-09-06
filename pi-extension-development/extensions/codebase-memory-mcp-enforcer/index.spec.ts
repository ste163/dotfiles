import { strict as assert } from "node:assert";
import { test } from "node:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const createFakePi = (): FakePi => {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      handlers.set(event, [...list, handler]);
    },
  };
};

const CONFIG_PATH = "/virtual/home/.pi/agent/mcp.json";
const DB_PATH = "/virtual/home/.cache/codebase-memory-mcp/virtual-repo.db";
const REGISTERED_MCP =
  '{"mcpServers":{"codebase-memory-mcp":{"command":"codebase-memory-mcp","lifecycle":"eager"}}}';

// Fully in-memory deps fake — no real disk I/O, no chdir, no temp dirs.
// `existingPaths` holds the exact paths existsSync answers for; `files` holds
// the exact contents readFile answers for.
const createFakeDeps = (
  existingPaths: readonly string[] = [],
  cwd = "/virtual/repo",
  files: Record<string, string> = {},
  homeDir = "/virtual/home",
): CodebaseMemoryMcpEnforcerDeps => ({
  existsSync: (path) => existingPaths.includes(path),
  readFile: (path) => files[path] ?? "",
  cwd: () => cwd,
  homeDir: () => homeDir,
});

// Handlers must run in registration order — later ones can observe mutations
// made by earlier ones (matches pi's real dispatch semantics) — so the walk
// is genuinely sequential and recursion replaces a loop with await inside.
const callHandler = async (pi: FakePi, event: string, eventPayload: unknown): Promise<unknown> => {
  const list = pi.handlers.get(event) ?? [];
  const runFrom = async (index: number): Promise<unknown> => {
    const handler = list[index];
    if (!handler) return undefined;
    const result = await handler(eventPayload, undefined);
    return result === undefined ? runFrom(index + 1) : result;
  };
  return runFrom(0);
};

type Pi = Parameters<typeof createCodebaseMemoryMcpEnforcerExtension>[0];

const bashCall = (command: string): { toolName: "bash"; input: { command: string } } => ({
  toolName: "bash",
  input: { command },
});

const inRepo = async (command: string, deps: CodebaseMemoryMcpEnforcerDeps): Promise<unknown> => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, deps);
  return callHandler(pi, "tool_call", bashCall(command));
};

const blocked = async (command: string, deps: CodebaseMemoryMcpEnforcerDeps): Promise<string> => {
  const result = (await inRepo(command, deps)) as { block: boolean; reason: string };
  assert.equal(result.block, true, `expected block: ${command}`);
  return result.reason;
};

const allowed = async (command: string, deps: CodebaseMemoryMcpEnforcerDeps): Promise<void> => {
  const result = await inRepo(command, deps);
  assert.equal(result, undefined, `expected allow: ${command}`);
};

// 20 directory levels deep: the walk checks at most 17 directories (the
// cwd plus 16 parents), so it exhausts its budget before reaching the
// filesystem root and findGitRoot returns null.
const DEEP_CWD =
  "/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/thirteen/fourteen/fifteen/sixteen/seventeen/eighteen/nineteen/twenty";

// --- Blocks ---

test("blocks bash code-search with the full ladder when the server is not registered", async () => {
  const reason = await blocked("grep -rn foo src/", createFakeDeps(["/virtual/repo/.git"]));
  assert.ok(reason.includes("MCP FIRST"));
  assert.ok(reason.includes("`grep -rn foo src/`"));
  assert.ok(reason.includes("1. Not connected?"));
  assert.ok(reason.includes('mcp({ connect: "codebase-memory-mcp" })'));
  assert.ok(reason.includes('repo_path: "/virtual/repo", mode: "fast"'));
  assert.ok(reason.includes("codebase-memory-mcp_list_projects"));
  // Step 4 carries the extracted pattern even in the ladder.
  assert.ok(reason.includes('pattern: "foo", project: "<name>"'));
  assert.ok(reason.includes("Inform the user and stop this line of work"));
  assert.ok(!reason.includes("genuinely unavailable"));
  assert.ok(!reason.includes("codebase_memory_mcp_"));
  assert.ok(reason.includes("Legal without the server"));
});

test("blocks with a ready-made rewrite when the server is registered and the repo is indexed", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked('grep -rn "session_start" src/', deps);
  assert.ok(reason.includes("Try instead:"));
  assert.ok(
    reason.includes(
      'mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "session_start", project: "virtual-repo", mode: "files" } })',
    ),
  );
  assert.ok(!reason.includes("Not connected?"));
  assert.ok(!reason.includes("codebase-memory-mcp_list_projects"));
});

test("rewrites every violating segment with its own extracted pattern", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("rg foo && find . -name '*permission*'", deps);
  assert.ok(reason.includes('pattern: "foo"'));
  assert.ok(reason.includes('pattern: "*permission*"'));
});

test("falls back to a placeholder pattern for unbalanced quotes and patternless segments", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  // "two words" splits into an unbalanced opener, and bare rg has no pattern at all.
  const reason = await blocked('grep "two words" src/ && rg', deps);
  assert.ok(reason.includes('pattern: "...", project: "virtual-repo"'));
  assert.ok(reason.includes('mcp({ tool: "codebase-memory-mcp_search_code"'));
});

test("falls back to the ladder when the config path exists but reads empty", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", CONFIG_PATH]);
  const reason = await blocked("rg foo", deps);
  assert.ok(reason.includes("1. Not connected?"));
});

test("blocks with the index-first path when the server is registered but the repo is not indexed", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("rg foo", deps);
  assert.ok(reason.includes("Index the repo, then search:"));
  assert.ok(reason.includes('repo_path: "/virtual/repo", mode: "fast"'));
  assert.ok(!reason.includes("Try instead:"));
  assert.ok(!reason.includes("Not connected?"));
});

test("treats a malformed or wrong-shaped mcp.json as not registered, even with a db present", async () => {
  const configs = [
    "not json",
    "42",
    "null",
    "[]",
    "{}",
    '{"mcpServers": []}',
    '{"mcpServers":{"other":{}}}',
  ];
  // Each config gets its own fake pi, so the checks are independent of each other.
  const results = await Promise.all(
    configs.map(async (config) => {
      const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
        [CONFIG_PATH]: config,
      });
      return { config, reason: await blocked("rg foo", deps) };
    }),
  );
  for (const { config, reason } of results) {
    assert.ok(reason.includes("1. Not connected?"), config);
  }
});

test("blocks every violating segment of a chain and names them all", async () => {
  const reason = await blocked(
    "rg foo && find . -name '*permission*'",
    createFakeDeps(["/virtual/repo/.git"]),
  );
  assert.ok(reason.includes("`rg foo`"));
  assert.ok(reason.includes("`find . -name '*permission*'`"));
  const siblingReason = await blocked(
    "ls -A a && ls -A b && find . -name x",
    createFakeDeps(["/virtual/repo/.git"]),
  );
  assert.ok(siblingReason.includes("find . -name x"));
  assert.ok(!siblingReason.includes("ls -A a"));
});

test("blocks rg with no targets — rg recurses by default", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("rg foo", deps);
  await blocked("rg -il caveman", deps);
  await blocked("rg", deps);
});

test("blocks recursive grep filters", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("grep -rn foo", deps);
  await blocked("grep --recursive foo", deps);
});

test("blocks searches with code or directory targets", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("grep foo src/*.ts", deps);
  await blocked("rg foo docs/", deps);
  await blocked("git grep foo -- '*.ts'", deps);
  await blocked("git grep foo", deps);
});

test("blocks find by name or type", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked('find . -name "*permission*"', deps);
  await blocked("find . -type f", deps);
});

test("blocks substitution hiding inside an exempted segment", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("grep pattern $(basename x) notes.md", deps);
  await blocked("echo x | grep $(rg foo src)", deps);
  await blocked("echo $(rg -n foo src)", deps);
  await blocked("ls <(rg foo)", deps);
});

test("blocks when the git root sits above the cwd", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/.git"], "/virtual/repo"),
  );
  const result = (await callHandler(pi, "tool_call", bashCall("rg foo"))) as { block: boolean };
  assert.equal(result.block, true);
});

// --- Allows ---

test("allows pipe filters over command output", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed('npm test 2>&1 | grep -E "^ℹ (tests|pass)"', deps);
  await allowed("npm ls -g --depth=0 | grep -i permission", deps);
  await allowed("npm test | grep --color=auto fail", deps);
  await allowed("ls foo | grep bar", deps);
  await allowed("cat config.json | grep pattern -", deps);
  await allowed("pi --list-models | head -8", deps);
});

test("allows chain siblings that do not search, with trailing and empty segments", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("ls -A a && ls -A b && stat file", deps);
  await allowed("npm test;", deps);
  await allowed("ls ;; pwd", deps);
});

test("allows quoted mentions of search commands and --grep flags", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed('git commit -m "fix the grep hack"', deps);
  await allowed('echo "use rg foo src"', deps);
  await allowed("git log --grep=author", deps);
});

test("allows grep-family over named docs or config files", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("grep -F 'x' README.md", deps);
  await allowed("rg 'foo\\|bar' *.md", deps);
  await allowed('grep "two words" docs/file.md', deps);
  await allowed("ack pattern notes.txt", deps);
  await allowed("ag term config.json", deps);
  await allowed("rg -i pattern README.md docs/notes.txt", deps);
  await allowed("git grep 'pattern' -- '*.md'", deps);
  await allowed("git grep pattern README.md docs/notes.txt", deps);
});

test("allows commands that are neither allowlisted nor code search", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("date", deps);
  await allowed("npm run format", deps);
});

test("allows every allowlisted leading command", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("ls -la", deps);
  await allowed("pwd", deps);
  await allowed("echo hi", deps);
  await allowed("readlink /virtual/repo", deps);
  await allowed("stat README.md", deps);
});

test("allows tool calls that are not bash", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git"]),
  );
  const result = await callHandler(pi, "tool_call", {
    toolName: "read",
    input: { path: "README.md" },
  });
  assert.equal(result, undefined);
});

test("allows code search outside a git repo (walk exhausts its depth budget)", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, createFakeDeps([], DEEP_CWD));
  const result = await callHandler(pi, "tool_call", bashCall("rg foo"));
  assert.equal(result, undefined);
});

// --- Wiring ---

test("registers one handler each for tool_call and before_agent_start", () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi);
  assert.deepEqual([...pi.handlers.keys()].toSorted(), ["before_agent_start", "tool_call"]);
});

test("default deps read the real filesystem", () => {
  assert.ok(defaultDeps.existsSync("."));
  assert.equal(defaultDeps.cwd(), process.cwd());
  assert.equal(defaultDeps.homeDir(), homedir());
  const extensionSource = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
  assert.ok(defaultDeps.readFile(extensionSource).includes("codebase-memory-mcp"));
});

test("prepends the READY reminder with the decision rule when indexed", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
      [CONFIG_PATH]: REGISTERED_MCP,
    }),
  );
  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("MCP READY"));
  assert.ok(result.systemPrompt.includes('project "virtual-repo" is indexed'));
  assert.ok(result.systemPrompt.includes("codebase-memory-mcp_search_code"));
  assert.ok(result.systemPrompt.includes("Know the path → read"));
  assert.ok(result.systemPrompt.includes("bash grep is legal"));
  assert.ok(result.systemPrompt.endsWith("BASE PROMPT"));
});

test("prepends the COLD reminder when registered but not indexed", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git", CONFIG_PATH], "/virtual/repo", {
      [CONFIG_PATH]: REGISTERED_MCP,
    }),
  );
  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("MCP COLD"));
  assert.ok(result.systemPrompt.includes("not indexed"));
  assert.ok(result.systemPrompt.includes('repo_path: "/virtual/repo", mode: "fast"'));
});

test("prepends the not-registered reminder when the server is missing", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git"]),
  );
  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("MCP FIRST"));
  assert.ok(result.systemPrompt.includes('mcp({ connect: "codebase-memory-mcp" })'));
});

test("leaves the system prompt alone outside a git repo (walk breaks at the root)", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(pi as unknown as Pi, createFakeDeps([], "/w"));
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
