# mcp-enforcer v2 — plan

Status: Phase 0 complete. Phases 1 through 4, then 6 remain. Phase 5 is the
optional upstream request. All decision points are resolved. This file
supersedes the v1 plan (the previous content of this file). Read the v1
design in git history.

Source: field report from the simple-english swap session, plus a second
review session that re-tested every fault live and closed the open research
items. New evidence lives in "Current state" and in the phases.

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
6. Cold start costs five calls: connect, two schema errors, index, then
   search. The block message also names tools (`codebase_memory_mcp_search_code`)
   that do not match the real invocation path.
7. The regex tests the whole command string, so paths trip the flag patterns.
   The second session saw `ls pi-extension-development` block, because
   `-development` matches the `-l`-flag pattern. A plain `ls` on any path with
   a dash in its name blocks.

## Design decisions (locked)

1. MCP down means a hard block. No bash fallback. The agent connects the
   server, or reports failure and stops that line of work.
2. Allowlist from the start. `bash ls` is always OK.
3. Block intent, not command names.
4. Literal-search exemption. A plain pattern plus non-code targets is legal
   grep.
5. Real tool names and params in every message.
6. The enforcer is a signal. The permission system is the control.

## Current state (after Phase 0)

- Source: `pi-extension-development/extensions/mcp-enforcer/index.ts`,
  symlinked from `.pi/extensions/mcp-enforcer` by `install.sh`.
- Phase 0 shipped the factory: `createMcpEnforcerExtension(pi, deps)` with
  `McpEnforcerDeps` = `{ existsSync, cwd, getMcpStatus }` (the PlanModeDeps
  pattern) and a colocated `index.spec.ts`. Enforcer files sit at 100%
  coverage. The behavior is still v1: regex blocklist, escape-hatch message,
  reminder injection. `getMcpStatus` is scaffold, defaulting to
  "not_connected" until Phase 2 wires it in.
- `npm test` is green on all assertions. The coverage threshold stays red only
  on the plan-mode debt (see "Out of scope").
- `mcp.json` says `lifecycle: "always"`, but both sessions started with the
  server disconnected (0/1). The status check must read live state, never the
  config. "Not connected" is the normal state at session start, so the
  connect-first message is the primary path, not an edge case.
- `ExtensionAPI` at 0.80.6 exposes no MCP status surface. No method, no event,
  no bus topic. Verified against the full `types.d.ts`. Status detection must
  come from tool results or a process check.
- The MCP gateway requires server-prefixed tool names:
  `codebase-memory-mcp_search_code`, not `search_code`. Bare names fail. The
  proxy tool `mcp__codebase_memory_mcp` also works and takes bare names.
- The `pi-permission-system` config sets `bash: { "*": "ask" }`. Every bash
  command asks for approval. The matcher also evaluates commands nested inside
  `$(...)`, backticks, and subshells.

## Phase 0 — Relocate to the dev project (complete)

1. Fix the one-line spec bug in `plan-mode/utils.spec.ts`. The test "ignores
   DONE markers with no matching step" expects `count === 1`. The correct
   value is `0`: the marker `[DONE:99]` matches no step, so nothing is marked.
   This failure blocks the whole suite today.
2. Run `git mv .pi/extensions/mcp-enforcer pi-extension-development/extensions/mcp-enforcer`.
3. Rework `index.ts` to the factory pattern: `createMcpEnforcerExtension(pi,
   deps)` with injected `findGitRoot` and an MCP status provider (the
   `PlanModeDeps` pattern from `plan-mode`).
4. Add `index.spec.ts`. All assertions must pass, and enforcer-owned files must
   reach 100% coverage. `npm run typecheck`, `npm run lint`, and
   `npm run format` must pass clean. The repo-wide coverage threshold stays
   red until the plan-mode debt is paid (separate bug, below).
5. Rerun `install.sh`. `.pi/extensions/mcp-enforcer` becomes a symlink, the
   same as `plan-mode`.

Do this phase first. Every later phase needs the test scaffold.

## Phase 1 — Allowlist plus ls removal

1. Delete the `ls` pattern from `CODE_SEARCH_PATTERNS`. There is exactly one.
2. Add an `ALLOWED` check that runs before the block patterns. If the leading
   command is in the list, pass immediately.
3. Substitution guard: a command that contains `$(` or a backtick never passes
   the allowlist. The block patterns run on the whole string. Otherwise
   `echo $(rg -n foo src)` would bypass through an allowlisted leading command.
   The permission system already descends into substitutions. The enforcer,
   as a signal, must not be weaker than the control it points at.
4. The allowlist covers only the leading command. `ls foo | grep bar` still
   hits the grep pattern and blocks.

Entries: `ls`, `pwd`, `echo`, `readlink`, `stat`.

Test rows to lock:

| Command | Result | Reason |
| --- | --- | --- |
| `ls -la` | Allow | Leading command `ls`, no substitution |
| `ls pi-extension-development` | Allow | Dashed paths must not trip the old flag pattern |
| `echo $(rg -n foo src)` | Block | Substitution guard |
| `ls foo \| grep bar` | Block | Pipe reaches the grep pattern |

## Phase 2 — MCP-down hard block

1. Remove the prose escape hatch from the message.
2. The injected status provider answers one of: connected, not connected, or
   unreachable. Tests inject all three.
3. Default implementation, because no status API exists (see Current state):
   - Default state: "not connected". The first blocked call gets the
     connect-first message.
   - Refinement: listen on `tool_execution_end` for `mcp` tool calls. Parse
     the status lines (`MCP: 0/1 servers`) and the connect errors. Update the
     state from what you parse.
   - Optional live check: `pi.exec("pgrep", ["-f", "codebase-memory-mcp"])`.
     No process means no connection.
   - A connect call on a connected server is a no-op, so the default state is
     safe to send first.
4. Flow when a command looks like code search:
   - Connected: block with the redirect message (current behavior).
   - Not connected: block with a connect-first message. Include the exact call
     `mcp({ connect: "codebase-memory-mcp" })`.
   - Unreachable after a connect attempt: block with a stop message. The
     message says: inform the user, do not fall back to bash. Name the state
     as last-observed, because no live API exists.

## Phase 3 — Literal-search exemption

Keep blocking: `grep`, `rg`, `ack`, `ag`, `git grep`, `find -name`, `find
-type`, `cat` with a glob or a pipe.

New classifier for content-search commands. Parse out the pattern, the flags,
and the target globs:

- Literal test: `-F` or `--fixed-strings` flag, or the pattern contains no
  regex metacharacters (`| ( ) [ ] { } * + ? ^ $ \`).
- Non-code targets: every explicit target resolves to docs or config
  extensions (`.md .txt .json .yaml .yml .toml .conf .ini`).
- Both true: allow. This matches the MCP server's own guidance.
- Either false: block.
- No explicit targets (a cwd-wide scan such as `rg -il foo`): treat as code
  search and block.
- Only explicit path arguments count as targets. `--include` filters and rg
  `-t` or `-g` filters do not count in this version. Conservative by design.
  Revisit only if real sessions hit it.

Test cases to lock:

| Command | Result | Reason |
| --- | --- | --- |
| `grep -F 'x' README.md` | Allow | Literal, docs target |
| `rg 'foo\|bar' *.md` | Block | Regex pattern |
| `grep foo src/*.ts` | Block | Code targets |
| `rg -il caveman` | Block | Cwd-wide scan |
| `grep -F foo -r . --include='*.md'` | Block | An include filter is not a target |

## Phase 4 — Message rewrite plus three-surface sync

New block message (connected state), draft:

```text
🔴 MCP FIRST — code search blocked.

1. Not connected?   mcp({ connect: "codebase-memory-mcp" })
2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "<gitRoot>", mode: "fast" } })
3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })
4. Search:           mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "...", project: "<name>", mode: "files" } })

Literal string in docs/config? bash grep is legal for that — use -F with explicit non-code targets.
```

Name rules: the gateway form needs the `codebase-memory-mcp_` prefix on every
tool name. The proxy tool `mcp__codebase_memory_mcp` takes bare names and
works too. The message uses the gateway form only, so the agent learns one
path. Step 3 exists because the project name derives from the repo path (for
this repo, `Users-sam-Github-dotfiles`) and is not guessable.

Then sync three policy surfaces so they state the same rules:

1. `APPEND_SYSTEM.md` — the MCP-FIRST section.
2. The `before_agent_start` reminder — real tool names, `ls` no longer listed
   as blocked.
3. The block messages.

Update this file when a phase changes the behavior.

## Phase 5 — Wrapper-floor request (optional, separate track)

Decision: keep `bash: { "*": "ask" }` in the `pi-permission-system` config.
The permission system already gates the `python3 -c` and `node -e` class:

1. The catch-all asks approval for every bash command.
2. The matcher evaluates commands nested inside `$(...)`, backticks, and
   subshells, in addition to the enclosing command.

No config rule is needed. An extra "ask" rule for `python3 -c` changes
nothing while the catch-all stands.

One gap remains, for upstream: interpreter `-c`/`-e` flags are not
wrapper-floored. The permission system floors opaque wrappers (`bash -c`,
`eval`) and indirection wrappers (`sudo`, `xargs`, `time`, and more) to at
least "ask", but `python3 -c` and `node -e` carry opaque programs too, and
the matcher treats them as ordinary commands. File a request with
`@gotgenes/pi-permission-system`: add interpreter `-c`/`-e` flags to the
opaque-wrapper floor. This matters the day the bash catch-all is loosened.

This phase touches no code in this repo.

## Phase 6 — Verification

1. Run in `pi-extension-development`: `npm run typecheck`, `npm run lint`,
   `npm test`. Assertions pass, enforcer files sit at 100%, and the repo-wide
   threshold stays red only on the recorded plan-mode debt.
2. Live matrix in a real session:
   - `ls` anywhere, any flags, any path: allowed. Test `ls -la` and
     `ls pi-extension-development` specifically.
   - `grep -F x README.md`: allowed.
   - `rg` on `.ts` files: blocked.
   - Regex pattern: blocked.
   - `ls foo | grep bar`: blocked.
   - `echo $(rg foo src)`: blocked.
   - Server disconnected at session start (the normal state): connect-first
     message.
   - Server down after a connect attempt: stop message.
3. Consistency check across the three policy surfaces.

## Decisions (resolved in review)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Allowlist entries | `ls`, `pwd`, `echo`, `readlink`, `stat`. Plus the substitution guard: `$(` or a backtick never passes the allowlist. |
| 2 | "Stop agent interaction" scope | Light option. Block the bash call. Tell the agent to report and stop that line of work. "Unreachable" is an inference, and a heuristic must not deny all tools. |
| 3 | Cwd-wide scans without explicit targets | Block. Only explicit path arguments count as targets. Include and type filters do not count in this version. |
| 4 | Phase 5 scope | Keep `bash: { "*": "ask" }`. The permission system already gates the class. Reduce Phase 5 to the upstream wrapper-floor request. |

## Out of scope (file as separate bugs)

- `lifecycle: "always"` in `mcp.json` did not connect the server at session
  start in either session. Config and runtime disagree. Investigate before you
  trust any always-on assumption.
- plan-mode coverage debt (~82% lines). The repo-wide `npm test` threshold
  stays red until this is paid. `extension-setup.md` already records it as
  deferred work. It blocks the repo-wide gate, not the enforcer work.

## Execution order

Phase 0, then 1, 2, 3, 4, then 6. Phase 5 is the upstream request, optional,
and comes last. Phase 0 is the big lift. Phases 1 through 4 are small after
the scaffold exists.

Resume point after machine restart: Phase 1, step 1.
