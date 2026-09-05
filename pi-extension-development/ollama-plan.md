# ollama-models — plan

Status: approved design. Not yet implemented. No code written.
Execution waits until the parallel extension in development lands; the only
shared touchpoint is the type-dependency pin bump (Phase 0).

Everything below was verified live or read from source on 2026-08-28 against
pi 0.84.3 (installed runtime) and pi-ollama-cloud 0.9.0 (upstream reference).
pi dist line numbers drift; file paths and function names are the stable
anchors. Resolve pi's install path portably per pi-extension-development/
AGENTS.md (`npm root -g`) — never hardcode the fnm path.

## Problem

pi defaults a missing `contextWindow` to 128000 (`dist/core/provider-composer.js`,
`modelFromJson`: `contextWindow: definition.contextWindow ?? 128000`). Our four
Ollama cloud models run through the local daemon (`127.0.0.1:11434`) with
hand-maintained `~/.pi/agent/models.json` entries, which drifted stale and
caused the 128K-footer bug. models.json is machine-local state by this repo's
own design (install.sh: "secrets/state ... must never be synced via a public
dotfiles repo"), so the catalog config cannot be version-controlled today.

The metadata pi needs — context length, capabilities — already sits on the
local daemon, one POST away. pi never asks for it.

## Goal

An extension, `pi-extension-development/extensions/ollama-models/`, that owns
the `ollama` provider:

- a seed catalog of our four `:cloud` models (verified values below), which
  doubles as the offline/first-launch fallback, and
- a `refreshModels` callback that enriches each seed model live from the
  local daemon's `/api/show`, riding the existing local sign-in.

No ollama.com, no API key, no new credentials, no new provider name. The
catalog config becomes tracked code in this repo.

## Current state (verified)

### The local daemon gives us everything except enumeration

`POST http://127.0.0.1:11434/api/show` with `{"model":"<id>"}` — no auth, no
key. The daemon attaches the cloud sign-in when it proxies. Probed all four:

| id | model_info key | contextWindow | capabilities |
| --- | --- | --- | --- |
| glm-5.3:cloud | glm_dsa_moe.context_length | 1048576 | completion, thinking, tools |
| deepseek-v4-pro:cloud | deepseek4.context_length | 1048576 | completion, tools, thinking |
| gemma4:31b-cloud | gemma4.context_length | 262144 | completion, thinking, tools, vision |
| qwen3.5:cloud | qwen3.5.context_length | 262144 | completion, thinking, tools, vision |

Enumeration does NOT work: `GET /api/tags` → `{"models":[]}`, `GET /v1/models`
→ `data:null`. The daemon does not list cloud models; `ollama list` (CLI)
fetches the cloud catalog from ollama.com with stored credentials.
Consequence: the extension is seed-driven, not discovery-driven.

### reasoning_effort behavior through the daemon (live probes)

- `"max"` → visible reasoning on all four models (HTTP 200, reasoning content).
- `"low"` / `"high"` → accepted (200) but produced no reasoning content on glm-5.3.
- field absent → glm-5.3 thinks by default.
- pi reads Ollama's reasoning field: openai-completions checks
  `["reasoning_content","reasoning","reasoning_text"]`
  (`dist/api/openai-completions.js`, `reasoningFields`) — thinking displays.

### pi's provider composition (source: dist/core/provider-composer.js, 0.84.3)

- Extensions register providers: `pi.registerProvider(id, ProviderConfigInput)`.
  ProviderConfigInput (provider-composer.d.ts): name?, baseUrl?, apiKey?, api?,
  headers?, authHeader?, oauth?, models?, refreshModels?.
- Layer order in `composeModelProvider`: built-in base → models.json →
  extension. When the extension sets `models`, they REPLACE earlier layers
  (`applyExtension`). models.json `modelOverrides` remain the TOPMOST user
  layer — a per-model escape hatch that still works after the extension.
- `validateExtensionProvider` only rejects streamSimple-without-api and
  dry-runs the composition. Registering the same id that models.json also
  defines is legal. Same-id is safe.
- A literal apiKey resolves as a credential ("configured API key",
  `composeApiKeyAuth`), satisfying both the "no authentication method
  configured" check and the network-phase credential gate.

### refreshModels contract (source + two reference implementations)

- pi calls it on startup, `/model` open, and `pi update --models`
  (model-runtime.js; startup restore = `refresh({allowNetwork:false})`).
- Two phases per refresh: restore (`allowNetwork:false`, before credential
  resolution) then network (`allowNetwork:true`, only when a credential
  resolves).
- RefreshModelsContext fields: `signal` (the /model picker aborts after 15s —
  stay under), `force` (true on `pi update --models`), `stored`
  (`{models, checkedAt}` from pi's FileModelsStore), `credential`,
  `publish`.
- `publish` takes `{update?}` and/or `{persist:}` — update swaps in memory,
  persist writes through to models-store.json. Returns false when superseded
  (generation check). When refreshModels RETURNS a list, the composer
  publishes the update itself — upstream relies on this; we do too.
- Never return `[]`. On a thrown error pi keeps the last good catalog.
- References: `dist/extensions/llama/provider.js` (pi's built-in LOCAL-server
  provider — closest analog to ours; publish({update}) style) and upstream
  pi-ollama-cloud `models.ts` (return-value style + publish({persist}) +
  4h cooldown + guards).

### Upstream reference: pi-ollama-cloud (MIT, v0.9.0)

`git clone --depth 1 https://github.com/fgrehm/pi-ollama-cloud`
(~1,420 source lines; we adopt parts of ~600). /tmp clones do not survive
reboots — re-clone when executing this plan. What we adopt / replace / skip
is in the decisions table.

## Design decisions (locked)

| # | Decision | Notes |
| --- | --- | --- |
| 1 | Provider id stays `ollama` | settings.json defaultModel/defaultProvider unchanged; /model UX unchanged; same-id validated as legal. Fallback if live composition misbehaves: new id + 2-line settings change. |
| 2 | Local daemon only | baseUrl `http://127.0.0.1:11434/v1`, apiKey literal `"ollama"` (as today). No ollama.com, no new key. |
| 3 | Seed-driven | SEED_MODEL_IDS = the four `:cloud` ids. The suffix stays — it is the daemon's cloud routing. No discovery: the daemon cannot enumerate cloud models. |
| 4 | maxTokens 32768 | Deliberate bump from pi's 16384 default; /api/show exposes no max-output; matches upstream's tested value. |
| 5 | Vision from capabilities | gemma4 + qwen3.5 gain input `["text","image"]` — never had it in models.json. |
| 6 | Thinking map `{off: null, max: "max"}` on all four | off hidden = "reasoning always on" (locked in the settings session); max verified live. Mid levels stay default-mapped pass-through — probes showed they may not produce visible reasoning; treat them as user choice, not guaranteed thinking. defaultThinkingLevel "max" stays in settings.json. |
| 7 | Per-model fallback, never throw | Divergence from upstream: a failed /api/show for one model keeps that model's seed/stored values; the refresh still returns all four. Daemon fully down → network phase returns seed merge and advances checkedAt (cooldown applies). Daemon-down is a normal state, not a surfaced error. |
| 8 | 4h refresh cooldown, force bypass | Mirrors upstream and pi's remote-catalog-provider; `pi update --models` forces. |
| 9 | Zero cost entries | No pricing. `cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}` placeholder (required field). |
| 10 | Compat block from upstream `buildCompat()` | Listed below, adopted verbatim. |
| 11 | models.json ollama block deleted at cutover | Extension replaces it; file left as `{"providers":{}}`. models.json stays machine-local (unchanged repo policy). |
| 12 | Name: `ollama-models` | Directory `pi-extension-development/extensions/ollama-models/`. |
| 13 | DI per PlanModeDeps rule | `OllamaModelsDeps { fetch, now }` injectable; tests use fakes; no real network in unit tests. |

### Compat block (adopt verbatim from upstream models.ts `buildCompat()`)

`supportsDeveloperRole: false`, `supportsReasoningEffort: true`,
`supportsStore: false`, `maxTokensField: "max_tokens"`,
`supportsUsageInStreaming: true`, `requiresToolResultName: false`,
`requiresAssistantAfterToolResult: false`, `requiresThinkingAsText: false`,
`requiresReasoningContentOnAssistantMessages: false`,
`thinkingFormat: "openai"`, `supportsStrictMode: false`,
`sendSessionAffinityHeaders: false`, `supportsLongCacheRetention: false`,
`zaiToolStream: false`.

## Architecture

```text
extensions/ollama-models/
  index.ts        entry; default export → createOllamaModelsExtension(pi, defaultDeps);
                  pi.registerProvider("ollama", { name, baseUrl, apiKey: "ollama",
                  api: "openai-completions", models: SEED_MODELS, refreshModels })
  seed.ts         SEED_MODEL_IDS + SEED_MODELS (ProviderModelConfig[]; table above)
  ollama-api.ts   fetchShow(id, baseUrl, deps): POST /api/show, 10s timeout,
                  AbortSignal-aware; getContextLength(model_info)
  assemble.ts     show response → ProviderModelConfig (capabilities →
                  reasoning/input; tools filter; thinking map; maxTokens; compat)
  refresh.ts      refreshModels(context): restore → stored ?? SEED; cooldown;
                  network → per-model fetchShow with per-model fallback;
                  publish({persist}) best-effort; never []
  *.spec.ts       colocated per module; 100% coverage on extension files
```

Estimate: ~350–450 source lines, ~400–500 test lines. One focused session.
structure.spec.ts picks the new directory up automatically (hard rules apply);
install.sh needs one rerun for the symlink.

## Phases

### Phase 0 — environment (coordinate with the parallel extension!)

1. Bump the four `@earendil-works` pins in pi-extension-development/
   package.json from `0.80.6` to `0.84.3` (exact-pin rule). refreshModels and
   ProviderConfigInput types require 0.84.0+. `npm install`.
2. Run the full checklist (typecheck/lint/format/test). The repo-wide coverage
   gate stays red on plan-mode debt — pre-existing, out of scope. Watch the
   duplicate-module risk (extension-setup.md, "Left for a future session" #2);
   the vendored `.d.ts` stub is the documented fallback if it bites.
3. Read the two reference implementations: pi's
   `dist/extensions/llama/provider.js` and upstream `models.ts`
   (re-clone the upstream repo — /tmp copies do not survive reboots).

### Phase 1 — pure core

seed.ts, ollama-api.ts, assemble.ts + specs. No registration yet. Pure
functions with injected fetch. Checklist green; extension files at 100%.

### Phase 2 — refresh + registration

refresh.ts, index.ts + specs. Fake pi captures registerProvider args; fake
fetch serves canned /api/show responses; fake clock drives cooldown tests.

### Phase 3 — cutover

1. `bash install.sh` (creates the `.pi/extensions/ollama-models` symlink).
2. New pi session (or /reload). Verify: `/model` lists the four under ollama,
   footer shows 1.0M, `pi --list-models` shows thinking yes.
3. Delete the ollama block from `~/.pi/agent/models.json` (leave
   `{"providers":{}}`). Re-verify `/model` — the extension now owns the catalog.
4. Watch `~/.pi/agent/models-store.json` gain ollama entries + `checkedAt`
   after the first network refresh — this confirms publish persist AND the
   literal-apiKey credential gate.

### Phase 4 — live smoke matrix

- Daemon up: refresh persists; footer values match the seed table.
- Daemon stopped: `/model` still lists all four (restore phase, seed/stored).
- `pi update --models`: forced refresh bypasses cooldown.
- glm-5.3:cloud at `/think max`: visible reasoning in session output.
- Optional: image input on gemma4 through the daemon proxy.

## Test matrix (unit)

| Case | Expectation |
| --- | --- |
| getContextLength finds `<arch>.context_length` | number |
| getContextLength with no matching key | undefined → caller keeps seed value |
| assemble: thinking→reasoning, vision→image input | mapped |
| assemble: model without tools capability | filtered out |
| fetchShow: non-ok status | per-model failure, no throw |
| fetchShow: timeout via injected fetch + signal | per-model failure |
| restore phase (allowNetwork false) | stored ?? SEED; never [] |
| cooldown: within 4h, not forced | zero fetch calls |
| force=true or window expired | fetches |
| signal aborted mid-flight | returns fallback, no publish |
| one /api/show fails | that model keeps seed values; list still has all four |
| publish({persist}) returns false or throws | warn, still return list |
| index: registerProvider | id "ollama", apiKey "ollama", models=SEED, refreshModels defined |

## Open questions (verify in phase, none block writing code)

1. Does the network phase run for a literal apiKey? Analysis says yes
   (`composeApiKeyAuth` resolves literal keys as "configured API key"; the
   llama provider gates on `context.credential?.type` — a resolved literal is
   api_key). Phase 3 step 4 verifies live. If gated: switch apiKey to the
   `"$OLLAMA_LOCAL_KEY"` env form (value "ollama", exported in .zshrc.shared)
   — same dummy, env-resolved. Seed still works either way; only live
   refresh is affected.
2. Image input through the daemon's OpenAI endpoint for gemma4/qwen3.5 —
   smoke it; harmless if it errors (drop input to text for that model).
3. pi dist line drift — anchor on function names, not line numbers.

## Out of scope

- Web tools (keep `npm:@ollama/pi-web-search`), usage bar, pricing, cost data.
- Model discovery/enumeration (impossible via the local daemon today).
- Local non-cloud models via /api/tags (returns [] today; revisit if local
  pulls appear — the extension could merge them later).
- plan-mode coverage debt (repo-wide npm test gate stays red until paid).
- settings.json (no changes in this plan).

## Execution order

Phase 0 → 1 → 2 → 3 → 4. Phase 0 step 1 touches the shared root package.json —
land it together with the parallel extension work so both sit on 0.84.3.

Resume point: Phase 0, step 1.
