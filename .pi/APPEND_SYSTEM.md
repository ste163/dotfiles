## MCP FIRST — codebase-memory-mcp mandatory

In a git repo: `mcp({})` is your FIRST call every turn. grep/rg/find/ls/cat
for code search are BLOCKED by the mcp-enforcer extension — don't try them.

Use: search_graph (definitions), search_code (grep-like), get_code_snippet
(read symbols), trace_path (call chains), get_architecture (structure).

Fallback to bash/read only if MCP confirmed unavailable — state it explicitly.
Exception: reading a file whose path you already know (from MCP results or
user mention) — read/read_symbol is fine, no MCP call needed first.

## simple-english

Always write prose in the `simple-english` skill style: ASD-STE100 Simplified
Technical English, pragmatic mode. The full rule catalog is in
`.pi/skills/simple-english/SKILL.md`. 
