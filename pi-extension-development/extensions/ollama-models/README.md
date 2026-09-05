# ollama-models

A pi extension that owns the `ollama` provider. It registers the four
cloud-routed models served by the local Ollama daemon (127.0.0.1:11434) and
fetches their live metadata (context window, capabilities) once per pi
process start.

## What it does

- Registers a seed catalog of the four `:cloud` models as tracked code:
  `glm-5.3:cloud`, `deepseek-v4-pro:cloud`, `gemma4:31b-cloud`, `qwen3.5:cloud`.
- On session start, asks the daemon (`POST /api/show`) for each model. It
  copies the real context window and the reported capabilities (thinking,
  tools, vision) into the catalog and swaps it in. Contexts show as 1.0M for
  glm-5.3 and deepseek and 262K for gemma4 and qwen3.5, instead of pi's 128K
  default.
- A failed fetch for one model keeps that model's built-in values. The
  messages below tell you when something failed so you can look into it.
- No ollama.com, no API key, no new credentials. The daemon attaches the
  cloud sign-in itself when it proxies; the registered key is a literal dummy.

This replaces the hand-maintained ollama block in ~/.pi/agent/models.json —
machine-local state that drifted stale and caused the 128K-footer bug.

## When it checks

Exactly once per pi process start: at startup, and again on `/reload`. The
fetch runs in the background and never blocks. Sessions created inside the
same process (`/new`, `/resume`, `/fork`) reuse what was already fetched.
Everything else — sending messages, completions, `/model` opens — never
triggers a check.

| Trigger                    | What happens                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------- |
| pi startup                 | Four concurrent POSTs to the daemon, then the catalog swap.                            |
| `/reload`                  | Same as startup (extensions reload, so the catalog re-fetches).                        |
| `/new` / `/resume` /fork   | Nothing; the process catalog already holds the data.                                   |
| `--offline` / `PI_OFFLINE` | Still fetches from the local daemon (localhost is not the internet; no flag stops it). |

Messages appear in the session when UI is available (TUI and RPC modes;
headless runs stay silent):

- info: `ollama-models: fetched the latest model data from the daemon`
- warning: `ollama-models: couldn't fetch N of 4 models from the daemon — using built-in values`
- warning: `ollama-models: catalog refresh failed` (only if the swap itself throws — defense in depth)

## How to use it

Nothing to configure. install.sh symlinks this directory into
~/.pi/agent/extensions, and pi loads it in every session.

- `/model` lists the four models under ollama, with real context values in
  the footer (1.0M on glm-5.3:cloud and deepseek-v4-pro:cloud).
- `gemma4:31b-cloud` and `qwen3.5:cloud` accept image input; the daemon
  reports the vision capability.
- `/think max` sends `reasoning_effort: "max"`; models that think show a
  reasoning block in the session output.
- `pi --list-models` verifies the catalog headlessly.

## Development

Files: `index.ts` (registration + the session_start refresh), `seed.ts`
(catalog data), `ollama-api.ts` (daemon client), `assemble.ts` (live-data
merge). Each file has a colocated spec; keep every file at 100% coverage.

Run the checklist from `pi-extension-development/` before any change is
considered done: typecheck, lint, format, test (see AGENTS.md there).

Design decisions, verification history, and the implementation records live
in `ollama-plan.md`, one directory up.
