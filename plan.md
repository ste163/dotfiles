# mcp-enforcer v2 — plan

Status: approved design, not yet implemented. This file supersedes the v1 plan
(the previous content of this file). Read the v1 design in git history.

Source: field report from the simple-english swap session. The agent worked one
full session inside the enforcer and recorded every block, bypass, and failure.

## Problem

The v1 enforcer moved the agent onto MCP tooling, but it had these faults:

1. The block message promised a prose escape hatch ("state that MCP is
   unavailable and this block disables"). No code reads the agent's prose.
2. The user said "you can allow bash ls" mid-session. The hook has no runtime
   allowlist, so the block stayed. Conversation cannot change the hook.
3. The blocklist matched command names, not intent. `ls -l` blocked, but plain
   `ls`, `readlink`, `printf` globs, and `python3 -c` with `os.walk` passed.
4. It blocked file operations (symlink inspection with `ls`), not only code
   search. The harness guidelines tell the agent to use bash for those.
5. It is stricter than the tool it enforces. The MCP server's own instructions
   say: "Use search_code or filesystem grep for literal or non-code" text.
6. Cold start costs five calls: connect, two schema errors, index, then search.
   The block message also names tools (`codebase_memory_mcp_search_code`) that
   do not match the real invocation path.

## Design decisions (locked)

1. MCP down means a hard block. No bash fallback. The agent connects the
   server, or reports failure and stops that line of work.
2. Allowlist from the start. `bash ls` is always OK.
3. Block intent, not command names.
4. Literal-search exemption. A plain pattern plus non-code targets is legal
   grep.
5. Real tool names and params in every message.
6. The enforcer is a signal. The permission system is the control.

## Current state (verified)

- Source: `.pi/extensions/mcp-enforcer/index.ts`. About 100 lines, regex
  blocklist, no tests, no dependency injection.
- It violates the repo rules in `extension-setup.md`: every extension lives in
  `pi-extension-development/extensions/<name>/` with `index.ts` plus a
  colocated `*.spec.ts`, and passes the 100% coverage gate.
- The v1 plan (git history of this file) designed a factory with injected
  dependencies. The shipped code has none of it.
- `mcp.json` says `lifecycle: "always"`, but the session started with the
  server disconnected (0/1). The status check must read live state, never the
  config.

## Phase 0 — Relocate to the dev project

1. Run `git mv .pi/extensions/mcp-enforcer pi-extension-development/extensions/mcp-enforcer`.
2. Rework `index.ts` to the factory pattern: `createMcpEnforcerExtension(pi,
   deps)` with injected `findGitRoot` and an MCP status provider (the
   `PlanModeDeps` pattern from `plan-mode`).
3. Add `index.spec.ts`. Pass `typecheck`, `lint`, `format`, `test` with the
   100% coverage gate.
4. Rerun `install.sh`. `.pi/extensions/mcp-enforcer` becomes a symlink, the
   same as `plan-mode`.

Do this phase first. Every later phase needs the test scaffold.

## Phase 1 — Allowlist plus ls removal

1. Delete both `ls` patterns from `CODE_SEARCH_PATTERNS`.
2. Add an `ALLOWED` check that runs before the block patterns. If the leading
   command is in the list, pass immediately.
3. The allowlist covers only the leading command. `ls foo | grep bar` still
   hits the grep pattern and blocks.

Proposed list: `ls`, `pwd`, `echo`, `readlink`, `stat`. Decision point 1
(below) fixes the exact entries.

## Phase 2 — MCP-down hard block

1. Remove the prose escape hatch from the message.
2. The injected status provider answers one of: connected, not connected, or
   unreachable.
3. Flow when a command looks like code search:
   - Connected: block with the redirect message (current behavior).
   - Not connected: block with a connect-first message. Include the exact call
     `mcp({ connect: "codebase-memory-mcp" })`.
   - Unreachable after a connect attempt: block with a stop message. The
     message says: inform the user, do not fall back to bash.
4. Research item: the `ExtensionAPI` surface for MCP status. If pi exposes no
   status query, degrade to the connect-first message for every blocked call
   and say so in the message.

## Phase 3 — Literal-search exemption

Keep blocking: `grep`, `rg`, `ack`, `ag`, `git grep`, `find -name`, `find
-type`, `cat` with a glob or a pipe.

New classifier for content-search commands. Parse out the pattern, the flags,
and the target globs:

- Literal test: `-F` or `--fixed-strings` flag, or the pattern contains no
  regex metacharacters (`| ( ) [ ] { } * + ? ^ $ \`).
- Non-code targets: every target resolves to docs or config extensions
  (`.md .txt .json .yaml .yml .toml .conf .ini`).
- Both true: allow. This matches the MCP server's own guidance.
- Either false: block.
- No explicit targets (a cwd-wide scan such as `rg -il foo`): treat as code
  search and block.

Test cases to lock:

| Command | Result | Reason |
| --- | --- | --- |
| `grep -F 'x' README.md` | Allow | Literal, docs target |
| `rg 'foo\|bar' *.md` | Block | Regex pattern |
| `grep foo src/*.ts` | Block | Code targets |
| `rg -il caveman` | Block | Cwd-wide scan |

## Phase 4 — Message rewrite plus three-surface sync

New block message (connected state), draft:

```text
🔴 MCP FIRST — code search blocked.

1. Not connected?  mcp({ connect: "codebase-memory-mcp" })
2. First time here? mcp({ tool: "index_repository", args: { repo_path: "<gitRoot>", mode: "fast" } })
3. Search:         mcp({ tool: "search_code", args: { pattern: "...", project: "<name>", mode: "files" } })

Literal string in docs/config? bash grep is legal for that — use -F with explicit non-code targets.
```

Then sync three policy surfaces so they state the same rules:

1. `APPEND_SYSTEM.md` — the MCP-FIRST section.
2. The `before_agent_start` reminder — real tool names, `ls` no longer listed
   as blocked.
3. The block messages.

Update this file when a phase changes the behavior.

## Phase 5 — Permission-system hardening (optional, separate track)

Close the `python3 -c` and `node -e` bypass. Add an approval-gated rule for
commands that contain `os.walk`, `os.listdir`, or `readdirSync`. Use approval,
not deny: the agent used `python3 -c` for a GitHub API call in the swap
session, and a hard deny would have blocked legal work.

This lives in `pi-permission-system/config.json`, not in the enforcer.

## Phase 6 — Verification

1. Run in `pi-extension-development`: `npm run typecheck`, `npm run lint`,
   `npm test` (100% coverage gate).
2. Live matrix in a real session:
   - `ls` anywhere: allowed.
   - `grep -F x README.md`: allowed.
   - `rg` on `.ts` files: blocked.
   - Regex pattern: blocked.
   - Server disconnected: connect-first message.
   - Server down: stop message.
3. Consistency check across the three policy surfaces.

## Open decision points

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Allowlist entries | `ls`, `pwd`, `echo`, `readlink`, `stat` |
| 2 | "Stop agent interaction" scope | Block the bash call and instruct the agent to report and stop. Heavier option: deny all non-essential tools until the server returns |
| 3 | Cwd-wide scans without explicit targets | Treat as code search and block |
| 4 | Phase 5 timing | Later, after phases 0 through 4 |

## Out of scope (file as separate bugs)

- `lifecycle: "always"` in `mcp.json` did not connect the server at session
  start. Config and runtime disagree. Investigate before you trust any
  always-on assumption.

## Execution order

Phase 0, then 1, 2, 3, 4, then 6. Phase 5 is optional and comes last. Phase 0
is the big lift. Phases 1 through 4 are small after the scaffold exists.

Resume point after machine restart: Phase 0, step 1.
