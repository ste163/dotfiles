# ollama-models

A pi extension that owns the `ollama` provider: the cloud-routed models
served by the local Ollama daemon. No ollama.com account, no API key — the
daemon attaches its own cloud sign-in when it proxies.

## How it works

1. `config.json` (this directory) names the models you want — ids only.
2. At every pi start, the extension asks the daemon for each id's live data
   (POST /api/show) and registers the provider in memory from that data
   alone: context window, vision, thinking.
3. The daemon is the only data source. Nothing is cached, nothing is written
   to disk, and pi's own model files are never touched.

If the daemon yields no usable model, the extension fails to load loudly:
pi reports the failure, the ollama provider is absent for that session, and
a fresh pi start is the retry.

## config.json

| Field     | Meaning                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `baseUrl` | Daemon root, e.g. `http://127.0.0.1:11434`. No path — the code derives `/v1` and `/api/show` from it. |
| `models`  | The model ids you want. Non-empty, unique.                                                            |

Validation is strict and throws at load: unknown fields, a bad URL, or
duplicate/empty ids stop the extension with a message naming the problem.

## Adding or removing a model

Edit the `models` array. That is the whole change: the next pi start
fetches the new list's data from the daemon. An id the daemon cannot
describe simply comes back missing — you get a warning naming them.

## Development

Same workflow as the rest of `pi-extension-development/` (typecheck, lint,
format, test). This directory is symlinked into `.pi/extensions/`, so edits
are live on the next pi start.
