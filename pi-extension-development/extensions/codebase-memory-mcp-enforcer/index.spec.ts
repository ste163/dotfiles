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

// Fully in-memory deps fake — no real disk I/O, no chdir, no temp dirs.
// `existingPaths` holds the exact paths existsSync answers for; the extension
// joins "<dir>/.git" itself, so tests list those full paths.
const createFakeDeps = (
  existingPaths: readonly string[] = [],
  cwd = "/virtual/repo",
): CodebaseMemoryMcpEnforcerDeps => ({
  existsSync: (path) => existingPaths.includes(path),
  cwd: () => cwd,
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

const inRepo = async (command: string): Promise<unknown> => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git"]),
  );
  return callHandler(pi, "tool_call", bashCall(command));
};

const blocked = async (command: string): Promise<string> => {
  const result = (await inRepo(command)) as { block: boolean; reason: string };
  assert.equal(result.block, true, `expected block: ${command}`);
  return result.reason;
};

const allowed = async (command: string): Promise<void> => {
  const result = await inRepo(command);
  assert.equal(result, undefined, `expected allow: ${command}`);
};

// 20 directory levels deep: the walk checks at most 17 directories (the
// cwd plus 16 parents), so it exhausts its budget before reaching the
// filesystem root and findGitRoot returns null.
const DEEP_CWD =
  "/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/thirteen/fourteen/fifteen/sixteen/seventeen/eighteen/nineteen/twenty";

// --- Blocks ---

test("blocks bash code-search and names the offending segment in the ladder", async () => {
  const reason = await blocked("grep -rn foo src/");
  assert.ok(reason.includes("MCP FIRST"));
  assert.ok(reason.includes("`grep -rn foo src/`"));
  // Real gateway tool names, and the git root is interpolated into step 2.
  assert.ok(reason.includes("codebase-memory-mcp_search_code"));
  assert.ok(reason.includes('mcp({ connect: "codebase-memory-mcp" })'));
  assert.ok(reason.includes('repo_path: "/virtual/repo", mode: "fast"'));
  // Step 5 carries the unreachable exit, and no prose escape hatch anywhere.
  assert.ok(reason.includes("Inform the user and stop this line of work"));
  assert.ok(!reason.includes("genuinely unavailable"));
  assert.ok(!reason.includes("codebase_memory_mcp_"));
});

test("blocks every violating segment of a chain and names them all", async () => {
  const reason = await blocked("rg foo && find . -name '*permission*'");
  assert.ok(reason.includes("`rg foo`"));
  assert.ok(reason.includes("`find . -name '*permission*'`"));
  const siblingReason = await blocked("ls -A a && ls -A b && find . -name x");
  assert.ok(siblingReason.includes("find . -name x"));
  assert.ok(!siblingReason.includes("ls -A a"));
});

test("blocks rg with no targets — rg recurses by default", async () => {
  await blocked("rg foo");
  await blocked("rg -il caveman");
  await blocked("rg");
});

test("blocks recursive grep filters", async () => {
  await blocked("grep -rn foo");
  await blocked("grep --recursive foo");
});

test("blocks searches with code or directory targets", async () => {
  await blocked("grep foo src/*.ts");
  await blocked("rg foo docs/");
  await blocked("git grep foo -- '*.ts'");
  await blocked("git grep foo");
});

test("blocks find by name or type", async () => {
  await blocked('find . -name "*permission*"');
  await blocked("find . -type f");
});

test("blocks substitution hiding inside an exempted segment", async () => {
  await blocked("grep pattern $(basename x) notes.md");
  await blocked("echo x | grep $(rg foo src)");
  await blocked("echo $(rg -n foo src)");
  await blocked("ls <(rg foo)");
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
  await allowed('npm test 2>&1 | grep -E "^ℹ (tests|pass)"');
  await allowed("npm ls -g --depth=0 | grep -i permission");
  await allowed("npm test | grep --color=auto fail");
  await allowed("ls foo | grep bar");
  await allowed("cat config.json | grep pattern -");
  await allowed("pi --list-models | head -8");
});

test("allows chain siblings that do not search, with trailing and empty segments", async () => {
  await allowed("ls -A a && ls -A b && stat file");
  await allowed("npm test;");
  await allowed("ls ;; pwd");
});

test("allows quoted mentions of search commands and --grep flags", async () => {
  await allowed('git commit -m "fix the grep hack"');
  await allowed('echo "use rg foo src"');
  await allowed("git log --grep=author");
});

test("allows grep-family over named docs or config files", async () => {
  await allowed("grep -F 'x' README.md");
  await allowed("rg 'foo\\|bar' *.md");
  await allowed('grep "two words" docs/file.md');
  await allowed("ack pattern notes.txt");
  await allowed("ag term config.json");
  await allowed("rg -i pattern README.md docs/notes.txt");
  await allowed("git grep 'pattern' -- '*.md'");
  await allowed("git grep pattern README.md docs/notes.txt");
});

test("allows commands that are neither allowlisted nor code search", async () => {
  await allowed("date");
  await allowed("npm run format");
});

test("allows every allowlisted leading command", async () => {
  await allowed("ls -la");
  await allowed("pwd");
  await allowed("echo hi");
  await allowed("readlink /virtual/repo");
  await allowed("stat README.md");
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

test("default deps use the real cwd", () => {
  assert.equal(defaultDeps.cwd(), process.cwd());
});

test("prepends the MCP reminder when inside a git repo", async () => {
  const pi = createFakePi();
  createCodebaseMemoryMcpEnforcerExtension(
    pi as unknown as Pi,
    createFakeDeps(["/virtual/repo/.git"]),
  );
  const result = (await callHandler(pi, "before_agent_start", {
    systemPrompt: "BASE PROMPT",
  })) as { systemPrompt: string };
  assert.ok(result.systemPrompt.startsWith("MCP FIRST"));
  assert.ok(result.systemPrompt.endsWith("BASE PROMPT"));
  // The reminder names the real gateway tool and the two legal exemptions.
  assert.ok(result.systemPrompt.includes("codebase-memory-mcp_search_code"));
  assert.ok(result.systemPrompt.includes("docs/config files are legal"));
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
