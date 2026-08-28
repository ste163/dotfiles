# mcp-enforcer v2 — plan

Status: Phases 0 through 4 and 6 complete. Phase 5 (the optional upstream
request) is all that remains. This file supersedes the v1 plan (the previous
content of this file). Read the v1 design in git history.

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
4. Docs-target exemption. A grep-family command over named docs/config files
   is legal grep, any pattern.
5. Real tool names and params in every message.
6. The enforcer is a signal. The permission system is the control.

## Current state (after Phase 4)

- Source: `pi-extension-development/extensions/mcp-enforcer/index.ts`,
  symlinked from `.pi/extensions/mcp-enforcer` by `install.sh`.
- Phases 0 through 4 shipped the factory, the allowlist, the status-aware
  block flow, the docs-target exemption, and the message rewrite:
  `createMcpEnforcerExtension(pi, deps)` with `McpEnforcerDeps` =
  `{ existsSync, cwd, getMcpStatus, recordMcpStatusSnapshot }` (the
  PlanModeDeps pattern) and a colocated `index.spec.ts`. Enforcer files sit
  at 100% coverage. The live reload after Phase 0 closed the duplicate-module
  question from `extension-setup.md`: the extension loads and blocks
  through the symlink. The `ls` flag pattern is gone. The allowlist (`ls`,
  `pwd`, `echo`, `readlink`, `stat`) passes one simple command only. A
  grep-family command over named docs/config files passes too (Phase 3).
  The block flow consults the status provider: redirect message when
  connected, connect-first when not connected, stop message when
  unreachable. The status tracks the adapter's snapshots on the shared
  event bus and starts "not connected". The prose escape hatch is gone.
  Phase 4 rewrote every surface — block messages, reminder,
  APPEND_SYSTEM.md — with the real gateway tool names and the git root
  interpolated.
- `npm test` is green on all assertions. The coverage threshold stays red only
  on the plan-mode debt (see "Out of scope").
- Before the fix, both sessions started with the server disconnected (0/1).
  `mcp.json` said `lifecycle: "always"`, a value the adapter does not know,
  so the server started lazy. `mcp.json` now sets `lifecycle: "eager"`: the
  adapter connects eager servers at startup and keeps them alive. Verify at
  the next session start that the server auto-connects. The status check
  still reads live state, never the config.
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

## Phase 1 — Allowlist plus ls removal (complete)

1. Delete the `ls` pattern from `CODE_SEARCH_PATTERNS`. There is exactly one.
2. Add an `ALLOWED` check that runs before the block patterns. If the leading
   command is in the list, pass immediately.
3. Substitution and operator guard: a command that contains `$(`, a backtick,
   `|`, `&`, `;`, a newline, `<(`, or `>(` never passes the allowlist. The
   block patterns run on the whole string. Otherwise `echo $(rg -n foo src)`
   would bypass through an allowlisted leading command. The permission system
   already descends into substitutions and process substitution. The
   enforcer, as a signal, must not be weaker than the control it points at.
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
| `ls && rg foo` | Block | A chain operator ends the allowlist pass |
| `ls <(rg foo)` | Block | Process substitution ends the allowlist pass |

## Phase 2 — MCP-down hard block (complete)

1. Removed the prose escape hatch from the redirect message.
2. The injected status provider answers one of: connected, not connected, or
   unreachable. Tests inject all three.
3. Shipped implementation, better than the draft in this file: the mcp
   adapter publishes versioned status snapshots on pi's shared event bus
   (channel `pi-mcp-adapter/status/v1`, see `pi-mcp-adapter/types.ts`). The
   enforcer subscribes on that channel and records every snapshot. No text
   parsing of tool results, no `pgrep` process check.
   - Default state: "not connected". The first blocked call gets the
     connect-first message.
   - Snapshot mapping: our server with status "connected" maps to connected;
     "failed" maps to unreachable; every other status ("cached",
     "needs-auth", "not-connected", "disabled") and malformed snapshots map
     to not connected.
   - The adapter publishes on startup, connect, connect failure, reconnect,
     backoff expiry, and idle shutdown, so the state self-heals.
   - A connect call on a connected server is a no-op, so the default state is
     safe to send first.
4. Flow when a command looks like code search:
   - Connected: block with the redirect message.
   - Not connected: block with a connect-first message. The message names the
     exact call `mcp({ connect: "codebase-memory-mcp" })`.
   - Unreachable: block with a stop message. The message says: inform the
     user, stop that line of work, do not fall back to bash. The state is
     last-observed, not a live query.

## Phase 3 — Docs-target exemption (complete)

Rule: a grep-family command (`grep`, `rg`, `ack`, `ag`) that names its
files, where every named file is docs or config, is allowed. The pattern
itself does not matter — regex over markdown is still not code search.
Simplified from the first draft after review: the literal/metacharacter test
is gone. It bought nothing and was the most fragile part.

- Docs/config extensions: `.md .txt .json .yaml .yml .toml .conf .ini`.
  This list is the only knob.
- Target extraction: replace every quoted segment with one placeholder
  token, so a pattern with spaces stays one token and operators inside
  quotes do not disqualify. Drop flags. The first remaining argument is the
  pattern, the rest are the targets. No shell parsing beyond that.
- A compound command (pipe, chain, substitution) never gets the exemption.
  The exemption uses the same disqualifier set as the allowlist.
- No target arguments (a cwd-wide scan such as `rg -il foo`) blocks. A
  target without an extension, such as a directory, blocks too.
- `git grep`, `find -name`, `find -type`, and `cat` with a glob or a pipe
  stay blocked. The exemption covers only the grep family.
- `--include` filters and rg `-t`/`-g` filters do not count as targets.

Test cases to lock:

| Command | Result | Reason |
| --- | --- | --- |
| `grep -F 'x' README.md` | Allow | Docs target |
| `rg 'foo\|bar' *.md` | Allow | Docs target — regex over docs is fine |
| `grep "two words" docs/file.md` | Allow | A quoted pattern stays one token |
| `grep foo src/*.ts` | Block | Code target |
| `rg -il caveman` | Block | Cwd-wide scan |
| `rg` | Block | No pattern, no targets |
| `rg foo docs/` | Block | A directory target has no extension |
| `grep foo README.md \| head` | Block | A pipe ends the exemption |
| `grep foo -r . --include='*.md'` | Block | An include filter is not a target |
| `git grep foo -- '*.md'` | Block | Not the grep family |

Extension points, all data changes: add extensions, add tools to the family,
adjust target parsing if a real command shape misbehaves. If regex over docs
ever bites, re-adding an `-F` requirement is a small follow-up.

## Phase 4 — Message rewrite plus three-surface sync (complete)

New block message (connected state), as shipped:

```text
🔴 MCP FIRST — code search blocked.

1. Not connected?   mcp({ connect: "codebase-memory-mcp" })
2. First time here?  mcp({ tool: "codebase-memory-mcp_index_repository", args: { repo_path: "<gitRoot>", mode: "fast" } })
3. Project name?     mcp({ tool: "codebase-memory-mcp_list_projects" })
4. Search:           mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "...", project: "<name>", mode: "files" } })

Docs/config files? Name them and bash grep is legal for that.
```

Name rules: the gateway form needs the `codebase-memory-mcp_` prefix on every
tool name. The proxy tool `mcp__codebase_memory_mcp` takes bare names and
works too. The message uses the gateway form only, so the agent learns one
path. Step 3 exists because the project name derives from the repo path (for
this repo, `Users-sam-Github-dotfiles`) and is not guessable.

Shipped as drafted, plus two improvements: the message interpolates the real
git root into step 2, and the spec locks out every underscored tool name.

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

## Phase 6 — Verification (complete)

1. Gates: `npm run typecheck`, `npm run lint`, `npm test` all clean.
   Assertions pass, enforcer files sit at 100%, and the repo-wide threshold
   stays red only on the recorded plan-mode debt.
2. Live matrix, run in a real session:
   - `ls -la` and `ls pi-extension-development`: allowed.
   - `grep -F x README.md`: allowed, and the grep ran.
   - `rg` on `.ts` files: blocked, with the four-step redirect message and
     the real git root interpolated.
   - `rg 'foo\|bar' *.md`: allowed, and the search ran.
   - `ls foo | grep bar`: blocked.
   - `echo $(rg foo src)`: blocked.
   - Session start: the server auto-connects (`lifecycle: "eager"`).
     Verified in three consecutive sessions.
3. Consistency check across the three policy surfaces: done with Phase 4.
   All three state the same rules.
4. The connect-first and stop rows stayed unit-verified only. Killing the
   server process does not force them live: the adapter keeps reporting
   "connected" for a dead process until its own detection runs, so no
   not-connected snapshot is published and the enforcer faithfully mirrors
   the adapter. The redirect message's step-1 connect call covers the lag.
   A true live test needs a deliberate broken-config reload (missing
   binary), not a process kill.

## Decisions (resolved in review)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Allowlist entries | `ls`, `pwd`, `echo`, `readlink`, `stat`. Plus the substitution guard: `$(` or a backtick never passes the allowlist. |
| 2 | "Stop agent interaction" scope | Light option. Block the bash call. Tell the agent to report and stop that line of work. "Unreachable" is an inference, and a heuristic must not deny all tools. |
| 3 | Cwd-wide scans without explicit targets | Block. Only explicit path arguments count as targets. Include and type filters do not count in this version. |
| 4 | Phase 5 scope | Keep `bash: { "*": "ask" }`. The permission system already gates the class. Reduce Phase 5 to the upstream wrapper-floor request. |

## Out of scope (file as separate bugs)

- `lifecycle: "always"` in `mcp.json` never connected the server at session
  start. Root cause: the adapter accepts only `keep-alive`, `lazy`,
  `lazy-keep-alive`, and `eager`; an unknown value falls through to `lazy`.
  Fixed: `mcp.json` now sets `"lifecycle": "eager"`. The next session start
  must confirm that the server auto-connects.
- plan-mode coverage debt (~82% lines). The repo-wide `npm test` threshold
  stays red until this is paid. `extension-setup.md` already records it as
  deferred work. It blocks the repo-wide gate, not the enforcer work.

## Execution order

Phase 0, then 1, 2, 3, 4, then 6. Phase 5 is the upstream request, optional,
and comes last. Phase 0 is the big lift. Phases 1 through 4 are small after
the scaffold exists.

Resume point after machine restart: all code phases done. Only the optional
Phase 5 upstream request remains.
