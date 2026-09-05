# ollama-models

A pi extension that owns the `ollama` provider. It registers the four
cloud-routed models served by the local Ollama daemon (127.0.0.1:11434) and
keeps their metadata fresh by asking the daemon directly.

## What it does

- Registers a seed catalog of the four `:cloud` models as tracked code:
  `glm-5.3:cloud`, `deepseek-v4-pro:cloud`, `gemma4:31b-cloud`, `qwen3.5:cloud`.
- On refresh, asks the daemon (`POST /api/show`) for each model. It copies the
  real context window and the reported capabilities (thinking, tools, vision)
  into the catalog. Contexts show as 1.0M for glm-5.3 and deepseek and 262K
  for gemma4 and qwen3.5, instead of pi's 128K default.
- A failed check for one model keeps that model's last known values. A stopped
  daemon is a normal state: the catalog falls back to the seed or the last
  stored copy. Nothing errors.
- No ollama.com, no API key, no new credentials. The daemon attaches the
  cloud sign-in itself when it proxies; the registered key is a literal dummy.
- Persists the refreshed catalog to pi's models-store.json with a 4-hour
  cooldown, so repeated refreshes never hammer the daemon.

This replaces the hand-maintained ollama block in ~/.pi/agent/models.json —
machine-local state that drifted stale and caused the 128K-footer bug.

## When it checks

Sending messages and running completions never triggers a check. The catalog
is already composed when you work. The only triggers are:

| Trigger                     | What happens                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| pi startup                  | Local restore first — no daemon contact. Interactive and rpc modes then fire one background check after the UI starts, capped at 15s. |
| `/model` open               | One refresh, capped at 15s.                                                                                                           |
| Within 4h of the last check | Any trigger returns the stored catalog. Zero requests to the daemon.                                                                  |
| `pi update --models`        | Never reaches extensions at pi 0.85.1. It builds a runtime without loading them.                                                      |
| `--offline` / `PI_OFFLINE`  | No network checks at all.                                                                                                             |

In practice: at most one check per 4-hour window. Ten pi starts inside the
window produce four quick POSTs total (one per model) on the first start and
nothing on the other nine. The window length is `REFRESH_COOLDOWN_MS` in
refresh.ts if it ever needs tuning.

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

Files: `index.ts` (registration), `seed.ts` (catalog data), `ollama-api.ts`
(daemon client), `assemble.ts` (live-data merge), `refresh.ts` (the pi
refreshModels callback). Each file has a colocated spec; keep every file at
100% coverage.

Run the checklist from `pi-extension-development/` before any change is
considered done: typecheck, lint, format, test (see AGENTS.md there).

Design decisions, verification history, and the implementation record live
in `ollama-plan.md`, one directory up.
