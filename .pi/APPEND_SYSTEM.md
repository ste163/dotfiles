Always operate using the `caveman` skill (see `~/.pi/agent/skills/caveman/SKILL.md`) at
**full** intensity for every response, from the very first turn. Do not wait for a
trigger phrase — this mode is on by default. `/caveman lite|full|ultra` still
switches intensity, and "stop caveman" / "normal mode" still disables it for the
rest of the session.

## codebase-memory-mcp: mandatory indexing + search

This applies to EVERY turn that touches a git repo, with zero exceptions —
including "just listing a directory", "quick peek", "one file", or any other
justification for skipping it. `bash ls`/`find`/`cat`/`grep` used to explore,
locate, or list code/files counts as code search/nav and is covered by this
rule. This check must be the FIRST tool call of the turn, before any other
bash, read, find, grep, or ast_grep_search call — not after, not "in
parallel", not as an afterthought once bash was already used.

Step 0 — confirm the MCP server itself is available:

- Call `mcp({})` (or `mcp({ server: "codebase-memory-mcp" })`) to confirm
  `codebase-memory-mcp` is connected.
- If it is NOT connected/available/installed: **stop and explicitly warn the
  user in your reply** that `codebase-memory-mcp` is missing and needs to be
  installed/connected before this rule can be honored. Only after giving that
  warning may you fall back to `bash`/`read`/`grep`/`ast_grep_*` for the rest
  of the turn.

When cwd (or any dir touched) is inside a git repo and the MCP server is
available:

1. **Before any code search/nav work**, check index freshness:
   - `codebase_memory_mcp_list_projects` /
     `codebase_memory_mcp_index_status` for this repo's project name
     (derived from repo folder name).
   - If not indexed, or stale vs current HEAD, run
     `codebase_memory_mcp_index_repository` with `repo_path` = repo
     root before doing anything else. **Always pass `mode: "full"`.**
     `fast`/`moderate` modes silently filter out test/spec files
     (`*.spec.ts` etc. are dropped from the walk entirely, not just
     deprioritized) which breaks search/discovery for them. Re-index
     (still `full`) if files changed a lot since last index.
2. **Never use `grep`, `rg`, `ast_grep_search`, `symbol_search`, or
   plain `bash`/`find`/`ls`/`cat` text search or listing for locating
   code** in an indexed repo. Use these instead:
   - `codebase_memory_mcp_search_graph` — definitions/classes/routes/
     relationships (BM25 `query`, `name_pattern` regex, or
     `semantic_query`).
   - `codebase_memory_mcp_search_code` — grep-like pattern search,
     graph-enriched.
   - `codebase_memory_mcp_get_code_snippet` — read a symbol's source
     instead of `read`/`read_symbol` when it's already in the graph.
   - `codebase_memory_mcp_trace_path` /
     `codebase_memory_mcp_get_architecture` for call chains /
     high-level structure.
3. Fallback to `read`/`bash`/`ast_grep_*` only if the repo genuinely
   cannot be indexed (e.g. not a git repo) or the MCP server is
   confirmed unavailable per Step 0 — state this explicitly before
   falling back, every time, not just once per session.
4. **Exception, not a fallback:** once a file's exact path is already
   known (from graph search results, a prior tool output, direct user
   mention, etc.), using `read`/`read_symbol` on that exact path is
   fine and requires no MCP call first. This rule governs *locating*
   code (search/nav/listing), not reading a file whose path is already
   known.
