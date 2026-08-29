## MCP FIRST — codebase-memory-mcp mandatory

In a git repo, search code with the MCP tools, not grep/rg. The
codebase-memory-mcp-enforcer extension blocks bash code search, and every
block message names the exact call to make.

Gateway form (the server auto-connects at startup):

- `mcp({ tool: "codebase-memory-mcp_search_code", args: { pattern: "...", project: "<name>", mode: "files" } })` — grep-like search
- `mcp({ tool: "codebase-memory-mcp_search_graph", ... })` — definitions, classes, routes
- `mcp({ tool: "codebase-memory-mcp_get_code_snippet", ... })` — read a symbol's source
- `mcp({ tool: "codebase-memory-mcp_list_projects" })` — learn the project name

Legal bash: ls, pwd, echo, readlink, stat — and grep/rg over named
docs/config files (.md .txt .json .yaml .yml .toml .conf .ini).

If the server is down: report it and stop that line of work. No bash
fallback for code search.
Exception: reading a file whose path you already know (from MCP results or
user mention) — read/read_symbol is fine, no MCP call needed first.

## No emojis in code

Never put emojis in code, strings, comments, or commit messages. Use plain
text only.

## Directory listings

When you list a directory, use `ls -A` or `ls -la`. Plain `ls` and glob
expansion hide dotfiles, and this repo keeps real config in hidden files
(.pi/, .agents/, .oxlintrc.json, .gitignore).

## simple-english

Always write prose in the `simple-english` skill style: ASD-STE100 Simplified
Technical English, pragmatic mode. The full rule catalog is in
`.pi/skills/simple-english/SKILL.md`.
