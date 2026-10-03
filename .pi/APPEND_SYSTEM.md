## MCP FIRST — codebase-memory-mcp mandatory

In a git repo, search code with the MCP tools, not grep/rg. The
codebase-memory-mcp-enforcer extension blocks bash code search, and every
block message names the exact call to make.

Direct calls (the built-in MCP server connects at session start):

- `mcp__codebase_memory_mcp__search_code({ pattern: "...", project: "<name>", mode: "files" })` — grep-like search
- `mcp__codebase_memory_mcp__search_graph({ ... })` — definitions, classes, routes
- `mcp__codebase_memory_mcp__get_code_snippet({ ... })` — read a symbol's source
- `mcp__codebase_memory_mcp__list_projects()` — learn the project name

Legal bash: ls, pwd, echo, readlink, stat — and grep/rg over named
docs/config files (.md .txt .json .yaml .yml .toml .conf .ini).

If the server is down: report it and stop that line of work. No bash
fallback for code search.
Exception: reading a file whose path you already know (from MCP results or
user mention) — read/read_symbol is fine, no MCP call needed first.

## Never commit
You will never use git commit or git push. You make code updates, but I am the reviewer.

## No emojis in code

Never put emojis in code, strings, comments, or commit messages. Use plain
text only.

## Directory listings

When you list a directory, use `ls -A` or `ls -la`. Plain `ls` and glob
expansion hide dotfiles, and this repo keeps real config in hidden files
(.pi/, .agents/, .oxlintrc.json, .gitignore).

## caveman

Always write prose in the `caveman` skill style: terse, answer first, no
ceremony. The full rules are in `.pi/skills/caveman/SKILL.md`.
Chat replies only. Files, docs, code, and commits stay normal prose — the
skill itself requires it.
