# Local LLM Setup Plan

State of research: mid-November 2026. Everything below is from web research and measured benchmark repos, not training data. Numbers cited are from published measurements on RX 9070 XT / Radeon AI PRO R9700 (same gfx1201 RDNA4 silicon, 16GB vs 32GB VRAM).

## Goal

DeepSeek V4 Pro stays. It is the brain: hardest reasoning, multi-file application refactors, anything the local layer fails or is not trusted for.

The desktop PC (RX 9070 XT + Strata/rdna-boosts) is the body: offload as much routine work as possible to local models. Cut API spend, keep V4 Pro where it matters. This is a routing design, not a replacement plan.

Task surface: two private repos, described by class only:

- A config-heavy infra-as-code repo (YAML, ansible, terraform - prime offload candidate, local models handle this class well)
- A larger application repo with multi-file refactors and a build system (the hard case, likely stays with the brain)

Current baseline - the brain: DeepSeek V4 Pro 0813. 1.6T params MoE, 49B active, 1M context, MIT weights. Independent scores: Vals SWE-bench 96.4, AA Intelligence Index 23. Its weights are ~920GB quantized - cannot run on this hardware, so it stays on the API.

Harness: pi (coding agent) against both layers. Walk-away speeds acceptable for local work (home use, not interactive latency). Web research must keep working through the existing pi ollama web-search extension.

## Hardware

- Gaming PC, real SteamOS (immutable Arch, read-only root)
- RX 9070 XT 16GB (gfx1201, RDNA4)
- 32GB DDR4 now (2x16GB); the board (MSI MPG B550I, ITX) has 2 slots, max 64GB via 2x32GB - see the future-state section
- 1TB NVMe
- 6-core AMD CPU (CPU cores peg during MoE expert overflow - observed)
- Mac runs pi + local Ollama (search relay only)

SteamOS rules: never pacman-install anything. Strata runs bare on the host (its engine package bundles ROCm wheels, nothing system-level, survives SteamOS updates). Containers (podman) only for Test B if it happens. The host only needs the kernel amdgpu driver, which ships with SteamOS.

## Test order

1. Test A WIPED: Strata removed from the box (clean cut); the timings below stay as eval data
2. Test B DONE: rdna-boosts llama.cpp fork + Qwen3.8-27B (Q3_K_XL + MTP-2) is the shipped worker model. Option B (gpt-oss-20b) was tested and rejected - details in its section below.
Both serve OpenAI-compatible APIs, so pi connects to either without changes. V4 Pro stays as the brain regardless; the tests decide what work gets routed to the body.

---

## Test A: Strata (WIPED - clean cut)

### What it is

- Engine: Niko1221/Strata, MIT, one-command installer. Purpose-built for Qwen3.8-Flash-Next.
- Model: Qwen3.8-Flash-Next, 125B total / ~6B active MoE. 24,576 experts, 10 routed per token. Hot experts cached in VRAM, rest streamed from RAM, PLE n-gram table on SSD. The NVMe matters here.
- Prebuilt engine packages for Linux rx9070 (gfx1200/gfx1201) with bundled ROCm wheels. Host needs only kernel driver. Nothing installed at system level - survives SteamOS updates.

### Install

```bash
curl -fsSL https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o install.sh && sh install.sh
strata launch --plan    # dry run, shows what would happen
strata launch           # interactive: picks model pack by RAM, downloads, serves
```

Serves OpenAI API on localhost:8080/v1, Anthropic /v1/messages, /v1/responses. `strata connect` prints setup instructions for coding tools. Remote access from other machines: host flag + API key.

### Model pack choice

What was tried, in order:

- **Qwen3.8-Flash-Next IQ3_XXS** (125B MoE, 6B active): worked, but 32GB RAM is below its floor. Measured on our box: 31.3 tok/s cold prefill, 16.4 tok/s decode, CPU pegged, GPU bouncing (expert cache misses with SSD streaming). A worker subagent doing a one-sentence README edit took minutes and was aborted.
- **Qwen3.8-Flash-Next Coder IQ1_M** (half the experts kept, 29.6GB shard): fit better, but still too slow for a worker. Timed one-sentence worker edit: 1-2 min at default thinking effort, 52s with reasoning effort low (set via pi models.json samplingParams).
- **Qwen3.6-35B-A3B UD-Q4_K_XL** (22.9GB, 3B active): the one that fits the 32GB tier. Timed one-sentence worker edit: **41s**. First engine token 0.188s. GPU fully loaded (15.9/15.9GiB), far less CPU involvement. Shipped - this is the worker model.

Strata catalog for this box, from the official docs: Strata serves Qwen3.8-Flash-Next packs (ISTA-DASLab, Unsloth, Gyro, Swift, Coder, NVFP4) and Qwen3.6-35B-A3B (Unsloth packs only). No dense models - Qwen3.8-27B does not run on Strata (that is Test B territory). Gyro-M/Gyro-S are the same 125B model memory-squeezed, not actually smaller in compute.

Model management (learned the hard way): there is no delete command. Deletion is manual: `strata models explain <catalog-name>` shows the files (note: it takes the catalog name like IQ1_M, not the folder tag coder-iq1_m), then rm the model folder, the packs/ dir and the mtp/ dir in the data folder. The IQ3_XXS and Coder share shard 2 via hard link - deleting one does not hurt the other. After deleting all Flash-Next models the disk went from 164G to 344G free.

Strata was fully removed from the box (terminal, engine, data, config, shell profile). The Flash-Next family is feasible - measured 107-114 tok/s decode and 94% code quality thinking-medium on a 64GB rig - but only with 64GB of RAM. That is a potential future improvement, not a current path.

### Risks / unknowns

- Young project, releases multiple times a day, single maintainer
- Not validated beyond 16K context on the 9070 XT specifically - must test against real repos
- pi tool-calling against Strata's OpenAI endpoint: VERIFIED - the worker subagent (pinned to the strata provider) made real edits through pi on Qwen3.6-35B-A3B.
- Fast-moving interfaces; pin a working version once found

---

## Test B: rdna-boosts llama.cpp fork + Qwen3.8-27B

### What it is

stew675/llama-cpp-rdna-boosts: 17-patch RDNA-specific set on llama.cpp (fork point a691b2345). Ships prebuilt container images on ghcr.io (ROCm 7.14.1 / 10.1 variants, `server-rocm-<tag>`, `light-rocm-<tag>`, `full-rocm-<tag>`, `latest` = ROCm 10.1). Use the container; building from source is the fallback.

Measured wins over upstream llama.cpp on this hardware:

- +24-41% prefill (WMMA flash-attention, chunked gated-delta-net kernels)
- Adaptive MTP + ngram-mod speculative decoding: code decode 26.3 to 72.7 tok/s, ~2x on dense 27B, fixes upstream BF16 KV depth degradation
- Same llama-server API (OpenAI /v1 + native Anthropic /v1/messages). pi known to work (kr4ckhe4d ships pi-local.sh).

### Model: Qwen3.8-27B (dense hybrid attention, arch qwen35)

Unsloth Dynamic 3.0 quants. Warning: same filenames for v2/v3 builds; v3 is current, identify by byte size / LFS oid.

| Quant | Size | BPW | KLD vs BF16 | Use |
| --- | --- | --- | --- | --- | --- |
| UD-IQ4_XS | 13.3GB | 4.131 | 0.0179 | best weights, 32K ctx, 30.3 tok/s |
| UD-Q3_K_XL | 12.2GB | 3.802 | 0.0263 | balanced, up to 128K ctx |
| UD-IQ3_XXS | 10.2GB | 3.148 | 0.0589 | max context, 192K at q4_0 KV |

Current on the box: IQ4_XS, 32K, reasoning-budget 0 (worker timings in the eval section). Next: Option A below.

### Option A: Q3_K_XL + MTP draft depth 2 (next test)

Independent measurement on an RX 9070 XT 16GB (roksblog.de, Aug 2026, llama.cpp build 10640, ROCm under WSL2):

```bash
llama-server -m models/Qwen3.8-27B-UD-Q3_K_XL.gguf -ngl 999 \
  -c 65536 -fa on --jinja --reasoning on --reasoning-effort low \
  --reasoning-budget 1024 --no-reasoning-preserve --reasoning-format auto \
  --spec-type draft-mtp --spec-draft-n-max 2 \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  -b 1024 -ub 256 --parallel 1 --host 0.0.0.0 --port 8080
```

Measured on that card: 48.78 tok/s short context, ~39 tok/s at ~21.6K context, ~795-1022 tok/s prefill at depth, 75.3% draft acceptance. The key discovery: `--spec-draft-n-max 2` shrinks the MTP draft context to ~178 MiB (against ~2.2GB for the full drafter), which is why MTP fits a 16GB card at all. Their rule: full GPU offload first, MTP second. VRAM ~15.7/16GB - tight.

Our adaptation for the SteamOS box: same flags but `-c 32768` to start (desktop compositor holds more VRAM than their rig). The file is Qwen3.8-27B-UD-Q3_K_XL.gguf, 13,146,393,504 bytes (Dynamic 3.0, verified against the HF listing). The rdna-boosts fork also has its own adaptive MTP (`--spec-type draft-mtp-adaptive,ngram-mod`); try the plain upstream flags first since they are the measured config, the fork variant second.

### Option B: gpt-oss-20b (after A)

OpenAI's Apache-2.0 MoE (20.9B total, ~3.6B active, 24 layers, MXFP4 native ~12.8GiB), designed for 16GB cards. Independent evidence: an 8-task mechanically-scored coding eval on a 16GB card had it pass 8/8 including a two-turn agentic tool-calling task, fully resident at 178-190 tok/s (techfuelhq, Aug 2026); community reports on the RX 9070 XT put it at ~70-154 tok/s on llama.cpp (llamaperf, Nov 2026). VERDICT: REJECTED, model file and container deleted. Measured on this box: decode 108-142 tok/s (fastest of anything tested), raw single tool call passes, write-only task passes - but every multi-step agent task failed. Two failure modes, both documented upstream: (1) under --reasoning-budget 0 it claimed tool calls it never made (3 of 4 runs; budget-0 is documented as aberrant for gpt-oss, which cannot not-reason, per PR #20297 and PR #20393); (2) with correct flags (--reasoning on --reasoning-effort low) it looped in its reasoning channel for the full 16,384-token output cap without emitting any tool call - 2 of 2 battery runs, 216s and 245s, matching llama.cpp issue #30377 (gpt-oss reasoning-channel loop, tool_calls=0, terminates at token budget). Single-step tasks passed (no-tool 13s, write-only 23s) but the worker's job is multi-step edits. Also relevant: pi + gpt-oss on llama.cpp is a known-broken combo (issue #32624, filed Nov 19 2026 against pi 1.5.2, harmony tokens inside tool arguments, strict PEG parse 500s) and gpt-oss requires reasoning_content round-tripping on tool turns which pi does not do (issue #27720). Qwen stays the worker.

### Verified server config (measured on RX 9070 XT)

```bash
llama-server -m models/Qwen3.8-27B-UD-IQ4_XS.gguf -ngl 99 \
  -ub 1024 -b 2048 -fa on -ctk q8_0 -ctv q8_0 -c 32768 \
  --reasoning-budget 1024 --host 0.0.0.0 --port 8090
```

Context ladder on 16GB (all measured): 32K = q8_0 KV, ub 1024. 64K = q8_0 KV, ub 512. 128K = q4_0 KV only, ub 256. 128K at q8_0 fails to allocate. Native context is 262K but VRAM-capped.

Speculative decoding (opt-in): `--spec-type draft-mtp-adaptive,ngram-mod --spec-ngram-mod-n-match 45 --spec-draft-n-max 9 --spec-draft-n-start 9`. Costs ~2.2GB VRAM fixed, caps MTP at 16K context on a 16GB card. Worth 2.4x generation where it fits.

### Mandatory traps (learned from the measured rig)

- `--reasoning-budget 1024` is NOT optional on thinking models. Without it the model burns the entire token budget on reasoning and returns empty content. Client max_tokens must exceed reasoning budget + answer.
- Match -ctk and -ctv. Never mix KV types (costs ~23% prompt throughput).
- q4_0 KV is the price of admission for 128K, not an optimization: up to -23% generation at 32K depth.
- Threads: 16, never 32 (SMT contention collapses generation).
- `--sleep-idle-seconds 900` releases VRAM when idle so the PC can game; model reloads on next request.

### Secondary model

Qwen3.6-35B-A3B MoE (20.6GB, -ncmoe 16 floor on 16GB, 128K ctx, 39-44 tok/s): the context-heavy alternative. Lower quality than Qwen3.8-27B on coding boards (64 vs 74). Only if context hunger beats quality.

---

## Shared infrastructure

### Network

- Gaming PC serves the engine on the LAN (0.0.0.0 bind). Mac's pi points at `http://<gaming-pc-ip>:<port>/v1`.
- Home servers stay out of the path (no GPU there). Optional future: self-hosted SearXNG as zero-cost search backend, but the pi extension is hardwired to Ollama endpoints, so it would need a different plugin.
- Outside-home access later: Tailscale. Not now.

### Web search (unchanged, already works)

- Extension: @ollama/pi-web-search (installed in this repo's pi npm tree). Hits localhost:11434/api/experimental/web_search and web_fetch.
- Reality: the local Ollama daemon signs with the `ollama signin` keypair and relays to https://ollama.com/api/web_search. Search executes on Ollama's cloud, not locally. Free tier with an account, unpublished quota, 429 on exhaustion. User accepts Ollama's zero-retention policy.
- The extension hardcodes localhost:11434 and ignores OLLAMA_HOST. Keep Ollama running on the Mac (the pi machine), signed in. No changes needed.
- Cost: model tokens are the only bill. Search was never billed.

### pi wiring

- Both engines speak OpenAI /v1/chat/completions. pi needs model + endpoint config only.
- Tool calling: verified working through pi against Strata's OpenAI endpoint (worker subagent on Qwen3.6-35B-A3B made real edits; reasoning effort low via models.json samplingParams).

---

## Evaluation plan

Purpose: DeepSeek V4 Pro vs local engines, on our specific repos, execution-graded, no vibes.

### Method

1. Harvest 10-20 tasks per repo:
   - Application repo: bug fix with failing test (pass = test green), refactor with tests (pass = suite green, behavior unchanged), feature add with lint/build gate
   - Infra repo: config change (pass = validate / lint clean), template change, playbook fix
2. Same prompt, same tools, same context budget through pi against each endpoint: V4 Pro (baseline), Strata/Flash-Next, rdna-boosts/Qwen3.8.
3. Score per task: pass/fail, attempt count, wall time, tokens burned. Greedy sampling for repeatability.
4. Separate judge model for high-level readout (another API model, not the one under test).
5. Engine dimension: where a model runs on both engines, run it on both. Flash-Next GGUF also runs on rdna-boosts (qwen4exp support in block 11) - a third arm that isolates engine vs model. Optional.

### Final worker-model battery (write+delete probe, 10 runs per model)

Identical task each run: worker subagent writes worker-probe.md with a fixed paragraph, then deletes it. Timed wall-to-wall per run. Failures logged, no retries.

| Model | Runs | Pass | Median | Range | Notes |
| --- | --- | --- | --- | --- | --- |
| DeepSeek V4 Pro (cloud, brain) | 10 | 10/10 | 13.5s | 12-17s | baseline |
| Qwen3.8-27B Q3_K_XL + MTP-2 (local, body) | 10 | 10/10 | 30s | 29-38s | shipped worker |
| gpt-oss-20b MXFP4 (local) | 5 + 2 | 0 | - | - | reasoning loops, zero tool calls (details in Option B) |

Per-run Qwen times: 32, 38, 30, 35, 30, 29, 35, 30, 29, 30s. Per-run DeepSeek times: 14, 15, 17, 13, 14, 14, 12, 13, 13, 14s.

Readout: the local worker is 2.2x slower per task than the cloud brain at zero marginal cost, with identical 10/10 reliability on this task class. The ~30s floor is mostly fixed overhead: child pi boot plus several LLM round-trips per edit, not slow decode (decode measured 48 tok/s).

### Probe designs to borrow (open source, execution-based)

- kr4ckhe4d/local-llm-benchmarks, benchmarks/ dir: code-quality-test.py (differential stdlib reimplementation, code executed and compared against real stdlib - saturated benchmarks are worthless, differential testing separates models), needle-test.py (recall at depth), semantic-recall-test.py (meaning-based recall with near-miss distractors, the "did it notice the helper exists" test), tool-calling probe (get_probe_token, unguessable outputs), kld-test.sh (quantization fidelity via KL divergence against BF16)
- SWE-bench Lite bakeoff methodology: mattbucci/2x-R9700-RDNA4-GFX1201-sglang-inference, evals/swebench/ - official Docker harness per instance, network isolated, git history re-initialized to one commit, opaque paths (benchmark-recall leak audit design). Their v2-vs-v4 story is the cautionary tale: agents read the gold patch through future git history and web search, inflating scores. Isolate everything.
- Tool-calling probe is mandatory before any agentic eval: a model that cannot call tools reliably scores zero regardless of quality.

### Expected honest outcome

V4 Pro wins pass rate on the hard application-repo tasks (DeepSWE 62.7 vs 42.2, Terminal-Bench 4.0 14% vs 6% for Qwen3.8-27B class). Local wins on cost (zero marginal) for the routine class. The output of eval is a routing table: which repo, which task class, which model. Per-task routing, not replacement.

---

## Research links

### Primary measured sources (this hardware)

- https://github.com/kr4ckhe4d/local-llm-benchmarks - measured llama.cpp on RX 9070 XT: model matrix, quants, KLD, MTP, 128K context, agent harnesses (pi-local.sh, claude-harness.md), strata.md (Strata/Flash-Next numbers), real-world-testing.md (agentic runs). The single most valuable reference.

### Second-round sources (model selection for the worker, Nov 2026)

- https://www.roksblog.de/can-a-16gb-amd-gpu-run-a-local-ai-agent-rocm-llama-cpp-hermes-in-wsl2/ - measured Qwen3.8-27B Q3_K_XL + MTP draft depth 2 on an RX 9070 XT 16GB: 48.8 tok/s short, ~39 at 21K context, 178 MiB drafter, full GPU offload
- https://llamaperf.com/gpu/rx-9070-xt-16gb - community report aggregator for this exact card (27 reports as of Nov 21, 2026): Qwen3.8-27B IQ3_M 65 tok/s, gpt-oss-20b ~154 tok/s class, ExLlamaV3 Qwen3.8 ~150 tok/s, Qwen3 8B 98.8 tok/s
- https://techfuelhq.com/articles/best-local-llm-coding-2026/ - 8-task mechanically-scored coding eval on a 16GB card (Aug 2026): gpt-oss:20b 8/8 including two-turn tool calling at 178-190 tok/s; Devstral Small 2 6/8 but only 4K context; Qwen3-Coder 30B 6/8 with speed hostage to free RAM
- https://rigperdollar.com/guides/best-local-llm-16gb-vram/ - 16GB fit/context math (Nov 13, 2026): gpt-oss-20b full 128K context on 16GB; JetBrains Mellum2.1 12B-A2.5B (8GB) purpose-built for agentic repo work at full 128K; Devstral Small only 3-7K context on 16GB
- https://kingy.ai/blog/best-local-ai-models-16gb/ - board scores on 16GB cards (Nov 15, 2026): Qwen3.8-27B UD-IQ2_S (8.37GB) scored 97.9 and fits with 4.7GB spare; the 3-bit file needs ~15GB at 8K under their conservative fit rule
- https://atomic.chat/blog/guides/best-local-llm-16gb - 16GB model picks (Aug 23, 2026): Qwen3.8-27B AD-IQ3_S 13.8GB with ~8K practical context; Ornith 1.5 35B-A3B AD-IQ3_XXS-IQ2_S 13.7GB fully GPU-resident agentic-coding candidate (proprietary quant, RDNA4 unverified)

### gpt-oss on llama.cpp: the rejection evidence (issues and PRs, Nov 2026)

- https://github.com/ggml-org/llama.cpp/issues/30377 - gpt-oss-120b loops in reasoning channel, never emits tool call, terminates at token budget (tool_calls=0) - the exact failure our battery measured on the 20B
- https://github.com/ggml-org/llama.cpp/issues/32624 - pi 1.5.2 driving gpt-oss-120b: harmony tokens inside tool arguments break the strict PEG parse, server 500s, generation discarded (open as of Nov 19, 2026; still unfixed on current master)
- https://github.com/ggml-org/llama.cpp/issues/27720 - gpt-oss goes erratic when the client does not round-trip reasoning_content on tool-call turns (0/120 failures with it, 7/120 without)
- https://github.com/ggml-org/llama.cpp/pull/20297 - reasoning-budget machinery; budget-0 on a reasoning-trained model is documented as causing aberrant behavior
- https://github.com/ggml-org/llama.cpp/pull/20393 - gpt-oss parser rework: model is 'incapable of not reasoning', emits single tool calls only, parallel-call logic removed

- https://github.com/stew675/llama-cpp-rdna-boosts - the RDNA patch set, releases, ghcr containers
- https://github.com/Niko1221/Strata - the Strata engine
- https://github.com/sorenfalch/llama.cpp-rocm-rdna4 - podman ROCm 10 container build for gfx1201, rdna-boosts validation, build gotchas
- https://github.com/shawnq-msft/rx9070-qwen-rocm - RX 9070 field notes: rocWMMA FATTN build flag, head-dim-256 trap, KV quant fast paths, WSL angle
- https://github.com/overdoingism/llama-cpp-overdoing - extra opt-in lossy prefill patches on top of rdna-boosts (K1 fp8 +16-22% prefill, F8 +17%). Optional tuning layer, test separately.

### Engines ruled out (with reasons)

- vLLM on RDNA4: FP8 falls back to FP32 dequant on gfx1201, NaN bugs under cudagraphs, community fork images required. Wins are concurrency; single-user rig. https://github.com/vllm-project/vllm/issues/28649 (long thread, current state), https://digtvbg.com/blog/llama-server-vulkan-rdna4-vllm-rocm-benchmark/ (Vulkan beats vLLM on this card), https://github.com/Capicua25x/vllm-rocm-rdna4 (best RDNA4 port, context only)
- SGLang: datacenter-first, RDNA4 support barely landing (official docs require disabling AITER on Radeon), 73-patch community forks for consumer cards. https://rocm.docs.amd.com/projects/ai-ecosystem/en/latest/inference/sglang.html, https://github.com/mattbucci/2x-R9700-RDNA4-GFX1201-sglang-inference (best RDNA4 work, mostly 2x32GB rigs)
- KTransformers NVMe-tier cache: real but for 200GB+ models at 1-3 tok/s, NVIDIA/Intel-AMX oriented. Ruled out for 16GB/32GB agentic use. https://github.com/kvcache-ai/ktransformers, https://github.com/ubergarm/r1-ktransformers-guide
- Ollama as engine: uses llama.cpp underneath, hides the flags this plan depends on. Only used as the search relay on the Mac.

### Model quality and comparison

- https://whatmodel.sh/llm/for/coding-16gb-vram-local - 16GB coding leaderboard (Qwen3.8-27B top local)
- https://llmrun.dev/use/coding - coding model tiers by VRAM
- https://artificialanalysis.ai/models/comparisons/qwen3-8-27b-vs-deepseek-v4-pro - AA Index: V4 Pro 23 vs Qwen3.8 20
- https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813 - V4 Pro official benchmarks (SWE-bench 80.6 vendor, agentic suite)
- https://www.ridgebench.com/models/deepseek-v4-pro - independent V4 Pro scores (Vals SWE-bench 96.4)
- https://benchlm.ai/compare/deepseek-v4-pro-0813-vs-qwen3-8-27b - head-to-head board (Qwen3.8 wins SWE-bench Pro 61.7 vs 55.4, Vibe Code 64.8 vs 49.9; V4 Pro wins DeepSWE 62.7 vs 42.2, TB2.1 vendor 87.9 vs 73.0)

### Web search plumbing

- https://github.com/ollama/ollama/pull/14753 - the experimental web_search/web_fetch routes added to the local daemon (thin proxy to ollama.com)
- https://docs.ollama.com/capabilities/web-search - official API docs (account required, free tier)
- https://ollama.com/blog/web-search - launch post ("generous free tier")
- https://mrsaynothing.dev/en/space/2026-11-02-ollama-web-search-api-the-search-isn-t-local - independent verification: keyless 401 in 0.13s, search executes on ollama.com, weights local / search not

---

## Future state: 64GB DDR4

The board (MSI MPG B550I, ITX, 2 RAM slots) maxes at 64GB via 2x32GB DDR4. Cost roughly $350-500 now; DRAM prices are rising (DDR4 being wound down, HBM fab shifts), so if we want this, buy sooner rather than later.

What 64GB unlocks:

- Strata Flash-Next IQ3_XXS fully RAM-resident: the benchmark rig with 64GB measured 107-114 tok/s decode and 94% code quality thinking-medium (the highest in the repo) - our 32GB box got 16.4 tok/s on the same model because it streams experts from SSD.
- Coder IQ1_M and Q2_0 packs with real headroom.
- Qwen3.8-27B Q6_K on llama.cpp (13x lower KLD than Q3_K_XL; needs the RAM because it does not fit the card).
- Any future thinking-heavy local model that wants resident experts.

Why not now: the Qwen3.6-35B-A3B worker works (41s tiny edit, correct). The upgrade is deferred until the eval shows a quality gap that bigger resident models would fix, or until DRAM prices make waiting clearly worse.

Feasibility of Flash-Next is gated on this upgrade only.

---

## Open questions

1. Judge model for eval readout: which model, same for all runs.
2. Routing mechanics: how does pi pick brain vs body per task? Options: manual per-repo/model switch, task-class rules, or start local and escalate to V4 Pro on failure. Decide after the eval produces the routing table.
3. 64GB DDR4 upgrade: buy now (prices rising) or defer? See the future-state section.
4. Test B: run rdna-boosts + Qwen3.8-27B - the path forward after the Strata wipe.

## Fresh-context checklist

- Test A wiped (Strata removed, clean cut). Test B (rdna-boosts + Qwen3.8 IQ4_XS) is the path forward.
- Test B shipped: Qwen3.8-27B Q3_K_XL + MTP-2 on the rdna-boosts fork is the worker (qwen container, 10/10 battery at 30s median). gpt-oss-20b rejected and deleted (multi-step reasoning loops, upstream #30377). DeepSeek cloud baseline: 13.5s median.
- Reasoning budget, KV type matching, thread count, MTP context cap: see Test B traps.
- Never pacman on SteamOS. Strata runs bare on the host; containers only for Test B.
- Ollama stays on the Mac, signed in, for search. Extension hits localhost:11434.
- Eval: execution-graded repo tasks, borrowed probe scripts, isolated SWE-bench-style harness, judge model for readout, engine as a test dimension.
- V4 Pro stays as the brain. Eval output is a routing table, not a replacement decision.
