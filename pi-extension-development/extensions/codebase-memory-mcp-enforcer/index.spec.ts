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
  stats: Record<string, { mtimeMs: number; isFile: boolean }> = {},
): CodebaseMemoryMcpEnforcerDeps => ({
  existsSync: (path) => existingPaths.includes(path),
  readFile: (path) => files[path] ?? "",
  statSync: (path) => stats[path] ?? { mtimeMs: 0, isFile: true },
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

test("still blocks searches with mixed or non-node_modules targets", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("grep -rn foo node_modules src/", deps);
  await blocked("grep -rn foo .", deps);
  await blocked("grep foo node_modules/x $(echo y)", deps);
});

test("blocks -e and -f searches whose value is the pattern", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("grep -e pattern src/", deps);
  await blocked("grep -f patterns.txt src/", deps);
  await blocked("grep --regexp pattern src/", deps);
  await blocked("grep --file patterns.txt src/", deps);
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

test("adds outside-project guidance when a blocked search targets absolute paths outside the repo", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -rn foo /outside/dir", deps);
  assert.ok(reason.includes("outside the project"));
  assert.ok(reason.includes("`/outside/dir`"));
  assert.ok(reason.includes("can only search indexed repositories"));
  assert.ok(reason.includes("codebase-memory-mcp_list_projects"));
  const findReason = await blocked("find /outside -name x", deps);
  assert.ok(findReason.includes("`/outside`"));
});

test("omits outside-project guidance for searches inside the repo", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -rn foo /virtual/repo/src", deps);
  assert.ok(!reason.includes("outside the project"));
  const patternReason = await blocked("grep -rn /foo/bar /virtual/repo/src", deps);
  assert.ok(!patternReason.includes("outside the project"));
  const subReason = await blocked("grep foo $(echo /outside)", deps);
  assert.ok(!subReason.includes("outside the project"));
});

test("expands ~ against the home dir when judging outside targets", async () => {
  const outsideReason = await blocked(
    "grep -rn foo ~/other",
    createFakeDeps(["/virtual/repo/.git"], "/virtual/repo"),
  );
  assert.ok(outsideReason.includes("outside the project"));
  const insideReason = await blocked(
    "grep -rn foo ~/repo",
    createFakeDeps(["/virtual/home/repo/.git"], "/virtual/home/repo"),
  );
  assert.ok(!insideReason.includes("outside the project"));
});

test("names outside targets after -e patterns", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -e foo /outside", deps);
  assert.ok(reason.includes("`/outside`"));
});

test("omits the stale note when the index db is missing", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -rn foo src/", deps);
  assert.ok(!reason.includes("changed after the last index"));
});

test("omits the stale note when substitution hides the targets or the segment is find", async () => {
  const deps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    {
      [DB_PATH]: { mtimeMs: 100, isFile: true },
      "/virtual/repo/src": { mtimeMs: 200, isFile: true },
    },
  );
  const reason = await blocked("grep foo src/ $(echo x)", deps);
  assert.ok(!reason.includes("changed after the last index"));
  const findReason = await blocked("find . -name x", deps);
  assert.ok(!findReason.includes("changed after the last index"));
});

test("resolves ~ targets against the home dir for the stale check", async () => {
  const dbPath = "/virtual/.cache/codebase-memory-mcp/virtual-repo.db";
  const deps = createFakeDeps(
    ["/virtual/repo/.git", dbPath, CONFIG_PATH, "/virtual/repo/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual",
    {
      [dbPath]: { mtimeMs: 100, isFile: true },
      "/virtual/repo/src": { mtimeMs: 200, isFile: true },
    },
  );
  const reason = await blocked("grep -rn foo ~/repo/src", deps);
  assert.ok(reason.includes("`/virtual/repo/src` changed after the last index"));
});

test("omits the stale note for targets outside the git root", async () => {
  const deps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH, "/outside/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    {
      [DB_PATH]: { mtimeMs: 100, isFile: true },
      "/outside/src": { mtimeMs: 200, isFile: true },
    },
  );
  const reason = await blocked("grep -rn foo /outside/src", deps);
  assert.ok(!reason.includes("changed after the last index"));
});

test("omits the stale note for missing files, directory targets, and unrecorded stats", async () => {
  const deps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH, "/virtual/repo/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    {
      [DB_PATH]: { mtimeMs: 100, isFile: true },
      "/virtual/repo/src": { mtimeMs: 200, isFile: false },
    },
  );
  const missingReason = await blocked("grep -rn foo missing.ts", deps);
  assert.ok(!missingReason.includes("changed after the last index"));
  const reason = await blocked("grep -rn foo src/", deps);
  assert.ok(!reason.includes("changed after the last index"));
  const unrecordedDeps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH, "/virtual/repo/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    { [DB_PATH]: { mtimeMs: 100, isFile: true } },
  );
  const unrecordedReason = await blocked("grep -rn foo src/", unrecordedDeps);
  assert.ok(!unrecordedReason.includes("changed after the last index"));
});

test("omits the stale note when the file is older than the index db", async () => {
  const deps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH, "/virtual/repo/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    {
      [DB_PATH]: { mtimeMs: 100, isFile: true },
      "/virtual/repo/src": { mtimeMs: 50, isFile: true },
    },
  );
  const reason = await blocked("grep -rn foo src/", deps);
  assert.ok(!reason.includes("changed after the last index"));
});

test("adds a stale-index note when a targeted file is newer than the index db", async () => {
  const deps = createFakeDeps(
    ["/virtual/repo/.git", DB_PATH, CONFIG_PATH, "/virtual/repo/src"],
    "/virtual/repo",
    { [CONFIG_PATH]: REGISTERED_MCP },
    "/virtual/home",
    {
      [DB_PATH]: { mtimeMs: 100, isFile: true },
      "/virtual/repo/src": { mtimeMs: 200, isFile: true },
    },
  );
  const reason = await blocked("grep -rn foo src/", deps);
  assert.ok(reason.includes("`/virtual/repo/src` changed after the last index"));
  assert.ok(reason.includes("Reindex first:"));
  assert.ok(reason.includes('repo_path: "/virtual/repo", mode: "fast"'));
  const absoluteReason = await blocked("grep -rn foo /virtual/repo/src", deps);
  assert.ok(absoluteReason.includes("`/virtual/repo/src` changed after the last index"));
});

test("lists the implemented carve-outs in the exemptions note", async () => {
  const reason = await blocked("grep -rn foo src/", createFakeDeps(["/virtual/repo/.git"]));
  assert.ok(reason.includes("Legal without the server"));
  assert.ok(reason.includes("`node_modules` paths"));
  assert.ok(reason.includes("`.md`"));
  assert.ok(reason.includes("`.json`"));
});

// --- Allows ---

test("allows pipe filters over command output", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed('npm test 2>&1 | grep -E "^ℹ (tests|pass)"', deps);
  await allowed("npm ls -g --depth=0 | grep -i permission", deps);
  await allowed("npm test | grep --color=auto fail", deps);
  await allowed("npm test | grep -A 8 'codebase-memory-mcp-enforcer'", deps);
  await allowed("npm test | grep -m 5 fail", deps);
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

test("allows the exact docs grep from the session finding", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed(
    'grep -n "bun test" AGENTS.md README.md plan.md .pi/prompts/test-generator.md',
    deps,
  );
});

test("allows grep-family over node_modules paths", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("grep -rn foo node_modules/pi-lens/dist", deps);
  await allowed("rg foo /virtual/repo/node_modules/x", deps);
  await allowed("grep foo node_modules/a node_modules/b", deps);
  await allowed("git grep foo -- node_modules/x", deps);
  await allowed("grep foo node_modules/x 2>/dev/null", deps);
});

test("allows -e and -f over named docs files", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("grep -e pattern file.md", deps);
  await allowed("grep -f patterns.txt file.md", deps);
});

test("allows grep-family over named docs or config files with redirections", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("grep -n 'mcp' a.md b.md 2>/dev/null", deps);
  await allowed("grep foo notes.md > out.txt", deps);
  await allowed("grep foo 2>&1", deps);
  await allowed("grep foo 2>/dev/null", deps);
  await allowed("grep foo 2>/dev/null file.md", deps);
  await allowed("rg -i pattern README.md 2>&1", deps);
});

test("handles value-taking flags when judging targets", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("grep -A 8 pattern file.md", deps);
  await allowed("grep -e pattern file.md", deps);
  await allowed("grep --after-context 8 pattern file.md", deps);
  await allowed("grep -iA 8 pattern file.md", deps);
  await allowed("grep -- pattern", deps);
  await blocked("grep -m 5 pattern src/", deps);
  await blocked("grep -A 8 pattern src/*.ts", deps);
});

test("extracts the pattern, not a flag value, in the rewrite", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -A 8 pattern src/", deps);
  assert.ok(reason.includes('pattern: "pattern"'));
  assert.ok(!reason.includes('pattern: "8"'));
});

test("extracts the pattern from -e searches in the rewrite", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git", DB_PATH, CONFIG_PATH], "/virtual/repo", {
    [CONFIG_PATH]: REGISTERED_MCP,
  });
  const reason = await blocked("grep -e pattern src/", deps);
  assert.ok(reason.includes('pattern: "pattern"'));
  assert.ok(!reason.includes('pattern: "src/"'));
});

test("allows cat with a glob over dotfile dirs or docs extensions", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await allowed("cat .husky/*", deps);
  await allowed("cat .github/workflows/*.yml", deps);
  await allowed("cat .pi/*.json", deps);
  await allowed("cat .agents/skills/*/SKILL.md", deps);
  await allowed("cat *.md", deps);
  await allowed("cat .husky/* 2>/dev/null", deps);
  await allowed("cat .husky/pre-commit", deps);
  await allowed("cat /virtual/repo/.husky/*", deps);
  await allowed("cat /virtual/repo/.github/workflows/*.yml", deps);
});

test("still blocks cat with a glob over code or ambiguous paths", async () => {
  const deps = createFakeDeps(["/virtual/repo/.git"]);
  await blocked("cat src/*.ts", deps);
  await blocked("cat *", deps);
  await blocked("cat src/*", deps);
  await blocked("cat ../other/*.ts", deps);
  await blocked("cat .husky/* $(echo x)", deps);
  await blocked("cat /virtual/repo/src/*.ts", deps);
  await blocked("cat /virtual/repo/../other/*.ts", deps);
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
  const dotStats = defaultDeps.statSync(".");
  assert.equal(dotStats.isFile, false);
  assert.equal(typeof dotStats.mtimeMs, "number");
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
  assert.ok(result.systemPrompt.includes("node_modules"));
  assert.ok(result.systemPrompt.includes("outside the project"));
  assert.ok(result.systemPrompt.includes("list_projects"));
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
