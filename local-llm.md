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
- 32GB DDR4 (single channel bandwidth ~40GB/s is the CPU-offload ceiling)
- 1TB NVMe
- Recent AMD CPU (unknown model, does not matter much for this plan)
- Mac runs pi + local Ollama (search relay only)

SteamOS rules: everything runs in containers (podman). Never pacman-install anything. The host only needs the kernel amdgpu driver, which ships with SteamOS. Container images bundle ROCm userspace.

## Test order

1. Test A first: Strata engine + Qwen3.8-Flash-Next (the big efficiency bet)
2. Test B second: rdna-boosts llama.cpp fork + Qwen3.8-27B (the boring, proven path)

Both serve OpenAI-compatible APIs, so pi connects to either without changes. V4 Pro stays as the brain regardless of test results; the tests decide what work gets routed to the body.

---

## Test A: Strata + Qwen3.8-Flash-Next

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

32GB RAM is the floor. Installer recommends the Coder variant for 32GB. ISTA-DASLab packs are the recommended source (Q2_0, IQ2_XS, IQ3_XXS, IQ3_S; Coder: IQ1_M).

Measured on RX 9070 XT 16GB (kr4ckhe4d/local-llm-benchmarks, strata.md):

- IQ3_XXS: 107-114 tok/s generation, 12 GiB RAM headroom
- Code quality (executed differential stdlib suite): 86% no-thinking, 94% thinking-medium - the highest quality scores in the entire benchmark repo, beating dense Qwen3.8's 60-76% at 3x the speed
- Coder IQ1_M was tried and deleted by that rig (weaker, variable quality on thinking runs)

Start with IQ3_XXS. Note: that rig had 64GB RAM; we have 32GB, expect more SSD streaming, slower but functional. The PLE table wants to live on the NVMe.

### Risks / unknowns

- Young project, releases multiple times a day, single maintainer
- Not validated beyond 16K context on the 9070 XT specifically - must test against real repos
- pi tool-calling against Strata's OpenAI endpoint is untested - run the tool-calling probe early
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

Start: IQ4_XS, 32K context.

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
- Tool calling: verified working on Qwen3.x through llama.cpp (single + parallel probe). Unverified on Strata - test first thing.

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

## Open questions

1. Strata on 32GB RAM: which pack actually works (IQ3_XXS vs Coder IQ1_M)? Expect SSD streaming; measure.
2. Strata context beyond 16K on 9070 XT: unvalidated. Real-repo sessions decide.
3. pi tool-calling against Strata's OpenAI endpoint: untested. Run the get_probe_token probe before anything else.
4. Judge model for eval readout: which model, same for all runs.
5. SteamOS container runtime: podman ships on SteamOS, but confirm container image compatibility (podman vs docker) before pulling.
6. Routing mechanics: how does pi pick brain vs body per task? Options: manual per-repo/model switch, task-class rules, or start local and escalate to V4 Pro on failure. Decide after the eval produces the routing table.

## Fresh-context checklist

- Test A first (Strata + Flash-Next IQ3_XXS), Test B second (rdna-boosts + Qwen3.8 IQ4_XS).
- Reasoning budget, KV type matching, thread count, MTP context cap: see Test B traps.
- Never pacman on SteamOS. Containers only.
- Ollama stays on the Mac, signed in, for search. Extension hits localhost:11434.
- Eval: execution-graded repo tasks, borrowed probe scripts, isolated SWE-bench-style harness, judge model for readout, engine as a test dimension.
- V4 Pro stays as the brain. Eval output is a routing table, not a replacement decision.
