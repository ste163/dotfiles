# ollama-models

A pi extension that owns the `ollama` provider. The model catalog lives here
as tracked code instead of hand-maintained, machine-local models.json state.
pi registers the built-in catalog at load, then fetches live metadata (context window,
capabilities) from the local Ollama daemon once per pi process start and
swaps it in. A failed fetch keeps the built-in values; the session shows a
message on success and a warning when the daemon could not be reached.

No ollama.com, no API keys, no new credentials — the daemon attaches the
cloud sign-in itself when it proxies.

## Adding a model

The daemon cannot list its models (its enumeration endpoints return
nothing), so the built-in catalog is the source of truth:

1. Probe the daemon for the model's metadata:
   `curl http://127.0.0.1:11434/api/show -d '{"model":"<id>"}'`
   Note the `*.context_length` value under `model_info` and the
   `capabilities` array.
2. Add the id to `SEED_MODEL_IDS` and a matching `buildSeed(...)` entry in
   `seed.ts`. Use the probed context window, and set vision true only when
   the daemon reports the vision capability.
3. Update `seed.spec.ts` to match, then run the checklist from
   `pi-extension-development/` (typecheck, lint, format, test — see AGENTS.md
   there). Every file stays at 100% coverage.

Removing a model is the same in reverse. Design history and verification
records live in `ollama-plan.md`, one directory up.
