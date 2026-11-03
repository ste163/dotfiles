## MCP FIRST — codebase-memory-mcp

In a git repo, search code with the MCP tools first. If MCP fails, is slow,
or doesn't cover what you need, fall back to bash grep/rg — that's fine, no
penalty.

At session start in a git repo (or after compaction), learn the project name
once with `list_projects()`, then use it in the calls below.

Direct calls (the built-in MCP server connects at session start):

- `mcp__codebase_memory_mcp__search_code({ pattern: "...", project: "<name>", mode: "files" })` — grep-like search
- `mcp__codebase_memory_mcp__search_graph({ ... })` — definitions, classes, routes
- `mcp__codebase_memory_mcp__get_code_snippet({ ... })` — read a symbol's source
- `mcp__codebase_memory_mcp__list_projects()` — learn the project name
- `mcp__codebase_memory_mcp__index_status({ project: "<name>" })` — index freshness/coverage check

Legal bash: ls, pwd, echo, readlink, stat — and grep/rg over named
docs/config files (.md .txt .json .yaml .yml .toml .conf .ini).

Reading a file whose path you already know (from MCP results or user
mention) — read/read_symbol is fine, no MCP call needed first.

## Never commit
You will never use git commit or git push. You make code updates, but I am the reviewer. Plans and proposals never include git commit or push steps; the user handles git.

## Consent before edits

Never write or edit files without explicit consent. Discuss and propose first; "discuss" and "write" are separate gates. Implement only on a go.

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

## Code proposal format

When proposing code changes bigger than a one-line tweak, reply in three
sections, plus a Questions section when anything needs asking, in this
order:

## Reasoning
- terse why: approach, key decisions, tradeoffs, assumptions.
- surface the decision points first — the user redirects here before reading
  the rest.

## Files
- repo-root-relative paths, one per line, annotated `(new)`, `(modify)`,
  or `(delete)`, each with a terse one-line purpose.

## Implementation
One pseudo-code block per file, headed `### <path>`:
- named functions/symbols first, abstract pseudo-code inside the bodies.
- sketch-level: signatures + behavior, not full code.

## Questions
Only if anything is genuinely ambiguous or needs a user decision.
Omit the section entirely when nothing needs asking. Each item is one
numbered line, phrased as a concrete question, so the user can reply by
number. If there's a proposed solution, say "Proposed solution" under the
question. Answered questions get folded into the Reasoning section.
1. `question`?
   Proposed solution: `solution`
2. `question`?

After any correction or redirect, re-emit the full plan (three sections
plus Questions when present) updated to match.

When plan mode is active, wrap the whole plan under a `# Plan` header:
the section headings become `##` and the pseudo-code path blocks become
`###`.
