# mcp-enforcer extension

Stop agent from using grep/rg/find/ls/cat for code search in git repos.
Enforce MCP-first rule with a hard block, not just advisory text.

## Problem

APPEND_SYSTEM.md tells agent to use codebase-memory-mcp, but:

- Rule is advisory text, not enforced
- LLM defaults to grep/bash (training bias)
- Context decay in long sessions → rule forgotten

## Solution

Three layers:

### Tier 1 — Config fixes (already done)

- `mcp.json`: lifecycle `lazy` → `always` (server connected at start)
- `APPEND_SYSTEM.md`: rule simplified, moved to top, mentions extension block

### Tier 2 — mcp-enforcer extension (this plan)

- `pi-extension-development/extensions/mcp-enforcer/index.ts`
- `pi-extension-development/extensions/mcp-enforcer/index.spec.ts`

Two hooks:

| Hook | What |
|------|------|
| `tool_call` (bash) | Block grep/rg/find -name/ls -laR/cat */git grep in git repos. Return redirect to MCP tools. |
| `before_agent_start` | Prepend `🔴 MCP FIRST: ...` reminder to system prompt each turn. |

Pattern: follow plan-mode exactly — `createMcpEnforcerExtension(pi, deps)` factory,
dependency-injected `findGitRoot`, `export default` wrapper.

### Tier 3 — Permission system (future)

Add grep/rg/find patterns to pi-permission-system config as defense-in-depth.

## Files

```
pi-extension-development/extensions/mcp-enforcer/
├── index.ts          # Extension entry point
└── index.spec.ts     # Tests (100% coverage)
```

## Checklist (all must pass)

```sh
cd pi-extension-development
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint
npm run format      # oxfmt --write
npm test            # 100% coverage
```

Then `./install.sh` from repo root (auto-discovers and symlinks).

## How it works

```
Agent: "I'll grep for that..."
  → Extension blocks: "Use codebase_memory_mcp_search_code"
  → Agent sees block in context (in-context learning)
  → Next turn: system prompt reminder at top says "MCP FIRST"
  → Agent calls MCP → works → learns MCP is the way
  → After 2-3 turns, agent defaults to MCP
```
