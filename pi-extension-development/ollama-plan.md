# ollama-models — plan

Status: implemented 2026-09-05. Phases 0-3 done; Phase 4 smoke done live
except the daemon-stopped check (unit-covered; see Implementation record).
The plan-mode gate landed before execution; the Phase 0 pin bump went in
solo.

Everything below was verified live or read from source on 2026-08-28 against
pi 0.84.3 and pi-ollama-cloud 0.9.0, then re-checked on 2026-09-05 against
pi 0.85.1 and pi-ollama-cloud 0.10.0 (source anchors re-read; daemon probes
re-run; only the reasoning_effort live probes were not repeated). pi dist
internals drift across versions — line numbers AND file paths (the
openai-completions API moved from pi-coding-agent into the pi-ai package at
0.85.1); exported function and constant names are the stable anchors, and
paths are re-resolved at execution. Resolve pi's install path portably per
pi-extension-development/AGENTS.md (`npm root -g`) — never hardcode the fnm
path.

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
key. The daemon attaches the cloud sign-in when it proxies. Probed all four
(values unchanged on the 2026-09-05 re-probe):

| id                    | model_info key             | contextWindow | capabilities                        |
| --------------------- | -------------------------- | ------------- | ----------------------------------- |
| glm-5.3:cloud         | glm_dsa_moe.context_length | 1048576       | completion, thinking, tools         |
| deepseek-v4-pro:cloud | deepseek4.context_length   | 1048576       | completion, tools, thinking         |
| gemma4:31b-cloud      | gemma4.context_length      | 262144        | completion, thinking, tools, vision |
| qwen3.5:cloud         | qwen3.5.context_length     | 262144        | completion, thinking, tools, vision |

Enumeration does NOT work: `GET /api/tags` → `{"models":[]}`, `GET /v1/models`
→ `data:null`. The daemon does not list cloud models; `ollama list` (CLI)
fetches the cloud catalog from ollama.com with stored credentials.
Consequence: the extension is seed-driven, not discovery-driven.

### reasoning_effort behavior through the daemon (live probes)

- `"max"` → visible reasoning on all four models (HTTP 200, reasoning content).
- `"low"` / `"high"` → accepted (200) but produced no reasoning content on glm-5.3.
- field absent → glm-5.3 thinks by default.
- pi reads Ollama's reasoning field: the openai-completions API (at 0.85.1
  shipped inside the pi-ai package, `pi-ai/dist/api/openai-completions.js`;
  it sat at `dist/api/openai-completions.js` in pi-coding-agent before
  0.85) checks `OPENAI_COMPLETIONS_REASONING_FIELDS =
["reasoning","reasoning_content","reasoning_text"]` — thinking displays.

### pi's provider composition (source: dist/core/provider-composer.js, 0.85.1)

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

- pi calls it on startup and `/model` open (model-runtime.js). Startup =
  restore phase at `ModelRuntime.create`, then a background network refresh
  after TUI init in interactive mode; rpc mode refreshes at startup too
  (`pi --mode rpc` is the headless trigger). `/model` open refreshes
  directly, capped at 15s. 0.85.1 correction: `pi update --models` builds a
  bare ModelRuntime without loading extensions, so it never reaches
  extension refreshModels — see Implementation record.
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

### Upstream reference: pi-ollama-cloud (MIT, v0.10.0)

`git clone --depth 1 https://github.com/fgrehm/pi-ollama-cloud`
(~1,450 source lines; we adopt parts of ~600). /tmp clones do not survive
reboots — re-clone when executing this plan. What we adopt / replace / skip
is in the decisions table. v0.10.0 deltas that touch this plan: per-model
probed maxTokens (Decision #4 — we keep the flat 32768), official
ollama.com pricing (Decision #9 — we keep zero cost), and glm-5.3's
generated thinkingLevelMap now maps low/medium/xhigh with `off: "none"`
(Decision #6 — we keep our probe-backed map). The refreshModels
architecture we adopt is unchanged from v0.9.0.

## Design decisions (locked)

| #   | Decision                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider id stays `ollama`                         | settings.json defaultModel/defaultProvider unchanged; /model UX unchanged; same-id validated as legal. Fallback if live composition misbehaves: new id + 2-line settings change.                                                                                                                                                                                                                            |
| 2   | Local daemon only                                  | baseUrl `http://127.0.0.1:11434/v1`, apiKey literal `"ollama"` (as today). No ollama.com, no new key.                                                                                                                                                                                                                                                                                                       |
| 3   | Seed-driven                                        | SEED_MODEL_IDS = the four `:cloud` ids. The suffix stays — it is the daemon's cloud routing. No discovery: the daemon cannot enumerate cloud models.                                                                                                                                                                                                                                                        |
| 4   | maxTokens 32768                                    | Deliberate bump from pi's 16384 default; /api/show exposes no max-output. Upstream v0.10.0 switched to per-model probed limits (glm-5.3 524288, gemma4:31b 262144, deepseek/qwen families 65536 — probed against ollama.com, not our daemon route); we keep the flat conservative 32768, which stays upstream's own unprobed-fallback value. Optional Phase 4 daemon probe can justify a later raise.       |
| 5   | Vision from capabilities                           | gemma4 + qwen3.5 gain input `["text","image"]` — never had it in models.json.                                                                                                                                                                                                                                                                                                                               |
| 6   | Thinking map `{off: null, max: "max"}` on all four | off hidden = "reasoning always on" (locked in the settings session); max verified live. Mid levels stay default-mapped pass-through — probes showed they may not produce visible reasoning; treat them as user choice, not guaranteed thinking. defaultThinkingLevel "max" stays in settings.json. Upstream v0.10.0's glm-5.3 entry maps low/medium/xhigh with `off: "none"`; we deliberately keep our map. |
| 7   | Per-model fallback, never throw                    | Divergence from upstream: a failed /api/show for one model keeps that model's seed/stored values; the refresh still returns all four. Daemon fully down → network phase returns seed merge and advances checkedAt (cooldown applies). Daemon-down is a normal state, not a surfaced error.                                                                                                                  |
| 8   | 4h refresh cooldown, force bypass                  | Mirrors upstream and pi's remote-catalog-provider. The callback honors `force` per the pi-ai contract (unit-tested), but at 0.85.1 `pi update --models` does not load extensions, so the bypass is not live-triggered.                                                                                                                                                                                      |
| 9   | Zero cost entries                                  | No pricing. `cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}` placeholder (required field).                                                                                                                                                                                                                                                                                                        |
| 10  | Compat block from upstream `buildCompat()`         | Listed below, adopted verbatim.                                                                                                                                                                                                                                                                                                                                                                             |
| 11  | models.json ollama block deleted at cutover        | Extension replaces it; file left as `{"providers":{}}`. models.json stays machine-local (unchanged repo policy).                                                                                                                                                                                                                                                                                            |
| 12  | Name: `ollama-models`                              | Directory `pi-extension-development/extensions/ollama-models/`.                                                                                                                                                                                                                                                                                                                                             |
| 13  | DI per PlanModeDeps rule                           | `OllamaModelsDeps { fetch, now }` injectable; tests use fakes; no real network in unit tests.                                                                                                                                                                                                                                                                                                               |

### Compat block (adopt verbatim from upstream models.ts `buildCompat()`)

`supportsDeveloperRole: false`, `supportsReasoningEffort: true`,
`supportsStore: false`, `maxTokensField: "max_tokens"`,
`supportsUsageInStreaming: true`, `requiresToolResultName: false`,
`requiresAssistantAfterToolResult: false`, `requiresThinkingAsText: false`,
`requiresReasoningContentOnAssistantMessages: false`,
`thinkingFormat: "openai"`, `supportsStrictMode: false`,
`sendSessionAffinityHeaders: false`, `supportsLongCacheRetention: false`,
`zaiToolStream: false`.

Verified 2026-09-05: `buildCompat()` is unchanged in v0.10.0, and every
field still exists in pi-ai 0.85.1's `OpenAICompletionsCompat`. Fields added
since 0.84.3 (`thinkingTokenBudgetField`, `supportsOpenAIGrammarTools`,
`supportsFinishReason`) default sanely and stay unset.

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

### Phase 0 — environment (solo now; the parallel extension landed)

1. Bump the four `@earendil-works` pins in pi-extension-development/
   package.json from `0.80.6` to `0.85.1` (exact-pin rule; the four packages
   are lockstep-versioned with pi at 0.85.1). refreshModels and
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
- `pi update --models`: forced refresh bypasses cooldown. (0.85.1 finding:
  the command does not load extensions — unit-tested only; see the
  Implementation record.)
- glm-5.3:cloud at `/think max`: visible reasoning in session output.
- Optional: image input on gemma4 through the daemon proxy.

## Test matrix (unit)

| Case                                             | Expectation                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| getContextLength finds `<arch>.context_length`   | number                                                           |
| getContextLength with no matching key            | undefined → caller keeps seed value                              |
| assemble: thinking→reasoning, vision→image input | mapped                                                           |
| assemble: model without tools capability         | filtered out                                                     |
| fetchShow: non-ok status                         | per-model failure, no throw                                      |
| fetchShow: timeout via injected fetch + signal   | per-model failure                                                |
| restore phase (allowNetwork false)               | stored ?? SEED; never []                                         |
| cooldown: within 4h, not forced                  | zero fetch calls                                                 |
| force=true or window expired                     | fetches                                                          |
| signal aborted mid-flight                        | returns fallback, no publish                                     |
| one /api/show fails                              | that model keeps seed values; list still has all four            |
| publish({persist}) returns false or throws       | warn, still return list                                          |
| index: registerProvider                          | id "ollama", apiKey "ollama", models=SEED, refreshModels defined |

## Open questions (verify in phase, none block writing code)

1. Does the network phase run for a literal apiKey? Analysis says yes
   (`composeApiKeyAuth` resolves literal keys as "configured API key"; the
   llama provider gates on `context.credential?.type` — a resolved literal is
   api_key). Re-verified at 0.85.1: pi-ai `Models.refresh` runs the network
   phase when `apiKey.resolve` returns a credential, and the composed literal
   resolves. Phase 3 step 4 verifies live. If gated: switch apiKey to the
   `"$OLLAMA_LOCAL_KEY"` env form (value "ollama", exported in .zshrc.shared)
   — same dummy, env-resolved. Seed still works either way; only live
   refresh is affected.
2. Image input through the daemon's OpenAI endpoint for gemma4/qwen3.5 —
   smoke it; harmless if it errors (drop input to text for that model).
3. pi dist drift — anchor on exported function/constant names, not line
   numbers; at 0.85.1 even file paths move (openai-completions now lives in
   the pi-ai package). Re-resolve paths at execution.

## Out of scope

- Web tools (keep `npm:@ollama/pi-web-search`), usage bar, pricing, cost data.
- Model discovery/enumeration (impossible via the local daemon today).
- Local non-cloud models via /api/tags (returns [] today; revisit if local
  pulls appear — the extension could merge them later).
- plan-mode coverage debt (repo-wide npm test gate stays red until paid).
- settings.json (no changes in this plan).

## Execution order

Phase 0 → 1 → 2 → 3 → 4. The parallel extension (plan-mode) has landed, so
Phase 0 step 1 (the pin bump to 0.85.1) is a solo change to the shared
package.json.

## Implementation record (2026-09-05)

- Phases 0-3 executed as planned. All ten extension files sit at 100% line,
  branch, and function coverage; the repo-wide gate stays red only on the
  pre-existing plan-mode debt.
- Open question 1 answered live: the literal apiKey resolves as a
  credential, the network phase runs, and publish persisted the ollama entry
  to models-store.json (triggered headlessly with `pi --mode rpc`; the four
  entries match the seed table, with gemma4/qwen3.5 gaining image input from
  the live capabilities).
- Cooldown verified live: a second startup inside the window re-fetched
  nothing and left checkedAt untouched.
- Thinking verified live: glm-5.3:cloud at --thinking max streams a thinking
  block (pi reads it through OPENAI_COMPLETIONS_REASONING_FIELDS).
- 0.85.1 correction: `pi update --models` builds a bare ModelRuntime and
  does not load extensions, so it never calls extension refreshModels. The
  live triggers are startup (interactive and rpc) and /model open; the force
  bypass stays in the callback per the pi-ai contract and is unit-tested.
- Not verified live: the daemon-stopped /model check (that would stop the
  user's daemon mid-session). Covered by unit tests: a fully down daemon
  returns the fallback catalog and advances checkedAt.
- models.json backup kept at ~/.pi/agent/models.json.pre-ollama-extension.bak
  before the cutover deleted the ollama block.

Resume point: none — implementation complete.

## Rework plan (2026-09-05): startup-only refresh — Option B

Status: implemented 2026-09-05. R1-R3 executed as written; see the
implementation record at the end of this section.

### Why rework (user decision)

The cooldown, persist, restore, and publish machinery mirrors upstream's
internet-facing catalog. For a local daemon with four fixed models it is
features without a need: restarting pi takes seconds, so fresh-on-every-start
is enough. Two hard limits of the v1 design also surface:

- `refreshModels` cannot pick its trigger. pi calls it on startup AND on
  /model open, and the callback cannot tell them apart (no source field in
  RefreshModelsContext — verified at 0.85.1).
- `refreshModels` has no UI access, so the success/failure visuals the user
  wants cannot come from it.

New contract: fetch once per process start; show one message on success; show
a warning visual on any failure so it can be investigated; seed values fill
any gap. This also revises Decision #7: daemon-down now surfaces a visual
(the silent-degradation stays — the seed catalog still serves).

### Verified against pi 0.85.1 (rework)

1. Runtime re-registration is sanctioned. After the load phase,
   `pi.registerProvider` routes straight to `modelRuntime.registerProvider`
   (runner.js bindCore: "takes effect immediately without requiring a
   /reload"). Caveat: validation runs on the RAW incoming config before the
   merge, so the swap must re-register the FULL locked config (name,
   baseUrl, apiKey, api, models) — a `{models}`-only call fails validation.
2. `session_start` fires in every mode (agent-session.js defaults to reason
   "startup"; /reload emits reason "reload"; new/resume/fork carry their
   own). pi awaits handlers sequentially, so the handler must return
   synchronously — fire-and-forget is mandatory and guarantees startup is
   never blocked. Handler throws are caught and shown as extension errors.
3. `ctx.ui.notify(message, type?: "info" | "warning" | "error")` exists;
   `ctx.hasUI` is true only in TUI and RPC, so headless modes stay silent.
4. Models are process-lifetime state, so the reason filter is
   `startup` | `reload` only: /new, /resume, /fork in the same process reuse
   the already-fetched catalog. No repeated fetches, no message noise.
5. With no refreshModels, pi's refresh cycles (startup background, /model
   open, pi update --models) skip the ollama provider entirely.
6. models-store.json becomes dead data for this extension: nothing reads it
   (no restore) and nothing writes it. The ollama key is removed at cutover.
7. fetchShow's external-signal parameter becomes dead code (nothing aborts a
   batch now) — it is removed in the rework.

### Design

- `index.ts` registers the locked config, then subscribes
  `pi.on("session_start", ...)`.
- The handler filters reasons (`startup`/`reload`), then fire-and-forgets
  `refreshCatalog(pi, ctx, deps)` — returns synchronously, never blocks.
- `refreshCatalog` (exported for tests): four concurrent fetchShows →
  assembleModels(SEED_MODELS, shows) → if any model fetched AND the list is
  non-empty, re-register the full config with the merged list → messages:
  - any fetch failed → warning:
    `ollama-models: couldn't fetch N of 4 models from the daemon — using
built-in values`
  - all fetched but the list is empty (pathological no-tools responses) →
    warning: `ollama-models: daemon returned no usable models — using built-in
catalog`
  - clean success → info: `ollama-models: fetched the latest model data
from the daemon`
  - Messages only when `ctx.hasUI`; everything wrapped in a top-level
    try/catch (async-void must never reject) whose catch path shows a
    warning: `ollama-models: catalog refresh failed`.
- Re-register condition: `failed < SEED_MODEL_IDS.length && models.length > 0`
  — a total failure never re-registers (the seed registration already
  serves); a partial failure applies fresh values for the models that came
  back.
- `refreshCatalog` takes a structural ctx type
  `{ hasUI: boolean; ui: { notify(...) } }` so tests need no full-interface
  fake.
- `ollama-api.ts`: fetchShow drops the external-signal parameter and the
  listener plumbing; keeps the internal timeout, fail-soft semantics, and
  the getContextLength divergence (undefined keeps the seed value).
- Two rapid session_starts (e.g. /reload mid-fetch) race harmlessly: both
  fetch, the later re-register wins, same data.

### Files

- Delete: `refresh.ts`, `refresh.spec.ts`
- Simplify: `ollama-api.ts` + spec (drop signal param and its two
  external-abort tests; keep ok / non-ok / reject / malformed / timeout and
  the getContextLength trio)
- Rewrite: `index.ts` + spec (registration lock, session_start wiring,
  reason filter, refreshCatalog behavior table below)
- Unchanged: `seed.ts`, `assemble.ts` + specs
- Net: about 450 lines of source and spec removed; concepts drop from five
  (restore/cooldown/persist/publish/refresh) to one (fetch at start)

### Test matrix (rework)

| Case                         | Expectation                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| registration                 | full locked config; models === SEED_MODELS                        |
| session_start wiring         | handler returns undefined (non-blocking); fire-and-forget settles |
| reason "new"/"resume"/"fork" | no fetch, no re-register, no message                              |
| all four fetches ok          | re-register with live values; info message                        |
| hasUI false                  | re-register happens; no messages                                  |
| one fetch fails              | re-register merges seed for the failed id; warning "1 of 4"       |
| all fetches fail             | no re-register; warning "4 of 4"                                  |
| all responses lack tools     | no re-register; "no usable models" warning                        |
| registerProvider throws      | warning "catalog refresh failed" (catch path)                     |

### Phases

R1 — code: delete/simplify/rewrite per Files; checklist green; every
ollama-models file back at 100% coverage.
R2 — cutover + live smoke: new pi session shows the info message and lists
the four models; /reload re-fetches; /model shows no refresh activity;
remove the dead ollama key from models-store.json (backup first).
R3 — docs: README trigger table and messages; plan implementation record
for the rework.

### Implementation record (rework, 2026-09-05)

- R1: refresh.ts and refresh.spec.ts deleted; ollama-api.ts simplified
  (fetchShow lost the external-signal parameter and listener plumbing; the
  deps interface shrank to { fetch } — the fake clock died with the
  cooldown); index.ts rewritten around the session_start handler and the
  exported refreshCatalog. 86/86 tests; every ollama-models file at 100%
  line, branch, and function coverage; typecheck/lint/format clean.
- R2: live smoke passed. `pi --mode rpc` startup produced the exact info
  message in the RPC stream ("ollama-models: fetched the latest model data
  from the daemon", notifyType info), proving the session_start fetch,
  swap, and notify end to end. The dead ollama key was removed from
  models-store.json (backup at models-store.json.pre-rework.bak); the store
  now holds only pi's own github-copilot entry and nothing writes to it
  anymore. `pi --list-models` shows the four models from the registration
  alone.
- R3: README trigger table and messages updated (this pass); this record
  written. Decision #7's silent-daemon-down stance is revised per the user:
  failures now surface a warning visual, while the seed catalog still
  serves.
- Not verified live: the /reload re-fetch path (interactive-only command;
  unit-tested via the reason filter) and a real daemon-down warning (would
  stop the user's daemon mid-session; unit-tested).

Resume point: none — rework complete.
