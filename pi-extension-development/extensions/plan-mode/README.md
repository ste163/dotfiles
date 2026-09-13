# plan-mode

Discussion-first planning for pi. `/plan` toggles between off and the
overview phase. Overview removes the built-in `write` and `edit` tools from
the active tool set, so the plan lives only in the conversation. Nothing
touches disk until you approve a path.

## Phases

| Phase     | Write/edit tools         | Bash                | Notes                                        |
| --------- | ------------------------ | ------------------- | -------------------------------------------- |
| overview  | Removed from the model   | Read-only guardrail | Discuss, question, propose. No file touched. |
| plan-file | One locked file writable | Read-only guardrail | The approved plan is written to that file.   |
| executing | Full access              | Full access         | Steps tracked with `[DONE:n]` tags.          |

The only way to reach plan-file is through overview. Not every plan needs a
file: from overview you can also execute directly.

## Commands

| Command | What it does                                                   |
| ------- | -------------------------------------------------------------- |
| `/plan` | Toggle plan mode. Turning on always enters the overview phase. |

The shortcut `Ctrl+Alt+P` toggles the mode. The `--plan` flag starts a
session in overview.

## Workflow

1. Run `/plan`. The session enters overview. Write and edit tools vanish
   from the model. Bash passes a read-only guardrail.
2. The agent asks questions, reads code, presents options, and ends with a
   numbered plan under a `Plan:` header — in the conversation only.
3. At the end of the turn, choose one:
   - `Continue planning` — keep discussing.
   - `Write plan to file` — name the plan file; the agent writes the
     numbered plan into it. Only that file is writable.
   - `Execute plan` — skip the file; full access returns and the plan is
     executed with progress tracking.
4. In the plan-file phase the same choice appears, plus `Refine the plan`.
5. The agent marks each finished step with a `[DONE:n]` tag.

## Plan format

The execute option appears only when a plan parses. The required shape:

```text
Plan:
1. First step description
2. Second step description
```

- The `Plan` header line accepts markdown forms: `Plan:`, `Plan`,
  `## Plan`, or `**Plan:**`.
- Steps are lines that start with a number and a period or a closing
  paren. Markdown inside a step is stripped.
- When the last response has no parseable plan, the agent gets one
  corrective turn that restates the format and the exact problem. The
  execute option stays hidden until a plan parses.

## Plan file rules

- The name is asked once when moving to the plan-file phase. It is reused
  while the file still exists on disk. A name collision with an existing
  file forces a new prompt.
- Only the basename is kept. Directory parts are stripped, so the file
  always lives in the cwd.
- The phase persists across sessions. A session that resumes in plan-file
  while the plan file vanished asks for a new name. A headless session
  falls back to `plan.md`.

## Scope

What is covered:

- The built-in `write` and `edit` tools are removed from the active tool
  set during overview. During plan-file they are gated to one file by
  basename comparison.
- The `bash` tool passes a read-only guardrail during overview and
  plan-file: the command must start with an allowlisted read-only command
  and must not match a destructive pattern (`rm`, `sudo`, redirects,
  `curl`, `wget`, `find -delete`, and so on). `curl` and `wget` are never
  allowed; use the `web_search` and `web_fetch` tools for web research.

What is not covered:

- Tools registered by other extensions or MCP servers.
- The bash guardrail is best-effort and is not a security boundary. It is
  a pattern list, not a parser.
