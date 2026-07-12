Always operate using the `caveman` skill (see `~/.pi/agent/skills/caveman/SKILL.md`) at
**full** intensity for every response, from the very first turn. Do not wait for a
trigger phrase — this mode is on by default. `/caveman lite|full|ultra` still
switches intensity, and "stop caveman" / "normal mode" still disables it for the
rest of the session.

## codebase-memory-mcp: mandatory indexing + search

When cwd (or any dir touched) is inside a git repo:

1. **Before any code search/nav work**, check index freshness:
   - `codebase_memory_mcp_list_projects` /
     `codebase_memory_mcp_index_status` for this repo's project name
     (derived from repo folder name).
   - If not indexed, or stale vs current HEAD, run
     `codebase_memory_mcp_index_repository` with `repo_path` = repo
     root before doing anything else. Re-index (fast mode ok) if
     files changed a lot since last index.
2. **Never use `grep`, `rg`, `ast_grep_search`, `symbol_search`, or
   plain `bash`/`find` text search for locating code** in an indexed
   repo. Use these instead:
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
   cannot be indexed (e.g. not a git repo, or MCP server unavailable)
   — state this explicitly before falling back.
