---
title: "Run LLM locally: what you can actually run, and what it's good for"
description: "You can run LLM locally on ordinary hardware, but the real limits are memory bandwidth and VRAM, not parameter count. I cover quantization, when to pick llama.cpp, Ollama, MLX or vLLM, a sizing rule of thumb, realistic local use cases, and an honest API comparison."
pubDate: 2026-11-01
lang: en
translationKey: running-models-locally
tags: [ai, self-hosting, linux]
featured: false
keywords:
  - run LLM locally
  - local LLM
  - llama.cpp
  - quantization
  - Ollama
---

I keep models running on my own machines, and people keep asking the same thing: can I run LLM locally, and is it worth it? The honest answer is narrower than the marketing and more useful than the cynicism. A local LLM will not match a frontier model on hard reasoning — that was never the point. The point is that a surprising amount of real work does not need a frontier model at all, and that work can run on hardware you already own: offline, with no per-token bill, and with nothing leaving the machine.

What decides whether it works is not the parameter count — it is quantization, memory, and tooling, in that order.

## The real constraint is memory bandwidth and VRAM, not parameter count

When people say "my laptop can't run that", they usually mean memory. Two separate limits matter, and both are more honest than parameter count alone.

The first is **capacity**: does the model fit in VRAM (GPU memory) or, failing that, in system RAM? If it fits in VRAM, generation is fast. If it spills into system RAM, it still runs, but the GPU stalls waiting over the bus. If it fits nowhere, it swaps to disk and stops being usable at all.

The second limit, the one people miss, is **memory bandwidth**. Inference generates one token at a time, and each token needs to read essentially the whole set of model weights once. So tokens per second is roughly memory bandwidth divided by model size in bytes. That is why a model can fit in RAM and still be painfully slow: a CPU streaming from system memory at tens of GB/s will trail a GPU that reads hundreds of GB/s. It is also why a Mac with unified memory punches above its weight — CPU and GPU share one fast pool, so a larger model fits *and* streams at once.

Parameter count tells you the size of the weights, which sets the bar. Bandwidth tells you whether you clear it quickly. Capacity and bandwidth together decide what is actually runnable — not "can my machine run a 70B" but "can my machine hold it *and* stream it at a speed I will tolerate".

## Quantization: what Q4 and Q8 actually mean

Almost nobody runs models at native precision. Quantization stores each weight in fewer bits, trading a little quality for a lot of size and speed.

- **FP16 / BF16** — 16 bits per weight, the reference point. Highest quality, twice the memory.
- **Q8_0** — 8 bits. For most tasks, practically indistinguishable from the reference at half the size. The safe choice when memory is not tight.
- **Q5_K_M / Q4_K_M** — roughly 4–5 bits with smarter rounding. The usual default: noticeably smaller, and for summarising, extraction, and code completion the quality loss is hard to notice.
- **Q3 and below** — aggressive. Fine if it is the only way to fit, but quality degrades visibly, especially on reasoning and long outputs.

Two things are worth saying plainly. First, quantization is not free, but it is cheap at the top: Q8 and Q5 lose almost nothing, and the damage compounds as you go down. Second, the letters matter. Plain `Q4_0` and `Q4_K_M` are both "4-bit" and behave differently — the K-quants use a better scheme and are the ones I reach for. When a model ships in several quants, try Q5_K_M first; if it will not fit, drop to Q4_K_M before you drop to Q3.

There is also a memory tax people forget: the **KV cache**. Every token of context you hold keeps key/value tensors in memory, and it grows with context length and concurrency. A model that "fits" at 4k context can run out of VRAM at 32k. Quantizing the KV cache helps; so does capping context to what you actually need.

## The tooling: llama.cpp, Ollama, MLX, and vLLM

Four tools cover almost everything, and the choice is about your hardware and your patience, not brand loyalty.

**llama.cpp** is the foundation under much of the rest. It runs GGUF quantized models on CPU and GPU, supports a huge range of hardware, and gives you the raw knobs — how many layers to offload, context size, batch size. If you want to understand what is happening, or you have unusual hardware, this is the one. The learning curve is the cost.

**Ollama** wraps that engine in the experience most people want: a model store, one command to pull and run, and a local HTTP API that speaks the common format. Fewer knobs, sensible defaults, and quantized models fetched for you. This is what I would hand a colleague on day one; the trade is control.

**MLX** is Apple's framework for Apple silicon, and it is the right answer on a Mac. It uses unified memory properly and tends to be the fastest option on M-series hardware for the models it supports. The ecosystem is smaller than GGUF, so model availability lags.

**vLLM** is the other end of the spectrum: a serving engine built for throughput, with continuous batching so many concurrent requests share the GPU efficiently. For one user at a time it is overkill; for a team or a batch job it makes the GPU earn its money.

The rough rule: **Ollama for convenience, llama.cpp for control, MLX on a Mac, vLLM when several people or requests hit it at once.** They are not rivals; three of them share the same underlying techniques.

## What a local LLM is good for — and what it is not

The pattern is consistent: local models are excellent at **high-volume, low-stakes, well-scoped** work, and poor at **rare, high-stakes, open-ended** work.

It genuinely works, today, for:

- **Summarisation and extraction.** Turning a long document, a pile of notes, or a noisy log into a summary or a set of fields. The task is constrained, the source is right there, and a mid-size quantized model does it well.
- **Code completion and small edits.** Autocomplete, boilerplate, a function from a docstring, renaming a concept across files. Latency matters more than brilliance here, and local wins on latency.
- **Embeddings.** Vector search, deduplication, clustering, a local RAG index. Embedding models are small, fast even on CPU, and the privacy win is real. This is often the best first local workload.
- **Privacy-sensitive data.** Anything you would rather not send to a third party — internal documents, medical or legal text, customer data. Running it locally is the whole point.

It does not work well for:

- **Frontier reasoning.** Hard maths, subtle multi-step logic, tasks where the model must be *right* and you cannot easily check it. You will feel the gap immediately.
- **Long agentic loops.** Agents that plan, call tools, recover from errors, and run for dozens of steps need a model that holds a plan and self-corrects. Small local models drift and loop. This is the case where the API still wins — you can read why in [how I run coding agents](/posts/running-coding-agents/).
- **Broad world knowledge on demand.** A smaller local model simply memorises less. If the job is "answer anything", you want the biggest model you can reach, and that usually means an API.

The honest framing: local is a **filter**, not a replacement. It handles the large share of calls that never needed a frontier model, so you spend API budget on the smaller share that genuinely did.

## A sizing rule of thumb

Memory is the gate. The rough arithmetic:

- weights ≈ **0.6 GB per billion parameters at 4-bit**, ≈ **1.1 GB per billion at 8-bit**;
- add **room for the KV cache and runtime overhead** — a couple of GB is a decent floor, more with long context;
- keep the total under your VRAM, or accept CPU-speed generation.

| Model size | Q4_K_M weights | Q8_0 weights | Where it comfortably sits |
| --- | --- | --- | --- |
| 1–3B | ~1–2 GB | ~2–4 GB | CPU-only; extraction, classification |
| 7–8B | ~5–6 GB | ~9–10 GB | 8–12 GB GPU; CPU-only if patient |
| 13–14B | ~9–11 GB | ~16–18 GB | 12–16 GB GPU, or a 32 GB+ Mac |
| 30–34B | ~20–24 GB | ~36–40 GB | 24 GB GPU at Q4; else unified memory |
| 70B+ | ~40–48 GB | ~75 GB+ | multi-GPU or 64 GB+ unified memory |

These numbers are approximate and move with context length, KV-cache settings, and the exact quant — measure your own, do not trust a table, including this one.

Two commands to make it concrete. With Ollama, everything is a model name:

```bash
ollama run llama3.1:8b           # fetch + run; the quant is chosen for you
ollama pull nomic-embed-text     # a small embeddings model for local RAG
```

With llama.cpp you say exactly what you want:

```bash
cmake -B build && cmake --build build -j

# Run a GGUF quant directly; tune the offload to your VRAM.
./build/bin/llama-server \
  -hf <user>/<model>-GGUF:Q4_K_M \
  --n-gpu-layers 99 \
  -c 8192 \
  --port 8080
```

The one flag that changes everything is `--n-gpu-layers`. Set it too high and you run out of VRAM; set it low and generation crawls. Tune it to your card once, then leave it alone.

## The honest economics vs an API

Here is the part the "run it locally, it's free" crowd skips: local is not free. It is a different bill.

The API bill is money. It scales with tokens and needs no hardware, no driver debugging, no quant experiments. At low volumes it is trivially cheaper than any hardware, and you get the best models available.

The local bill is hardware plus time. You pay once for a GPU or a Mac, plus electricity, plus the hours spent on builds, drivers, and the flag that silently made everything slow. That hardware is only "cheaper" if you use it enough — and "enough" depends entirely on your volume. For a handful of summaries a day, the API wins on cost, full stop. For a constant stream of embeddings, bulk classification, or a completion loop that fires on every keystroke, local wins on cost *and* latency.

Then there are the things you cannot buy from an API at all: **data that must not leave the machine**, **availability when the network is down**, and **no rate limits or per-seat terms** standing between you and your own workload. For privacy-sensitive work, local is not an economic choice — it is the only choice that satisfies the requirement.

My honest position: run both. Keep a local LLM for the private, the high-volume, and the always-available; keep an API key for the frontier reasoning and the long agentic loops. The mistake is treating it as either/or. It is also just one part of the setup — the rest of what I run is in [what I self-host](/posts/what-i-self-host-2026/).

## Rules I follow

1. Size by memory and bandwidth, not by parameter count.
2. Start at Q4_K_M or Q5_K_M; go lower only if you must, and expect the drop.
3. Budget for the KV cache, not just the weights.
4. Ollama to start, llama.cpp to tune, MLX on Apple silicon, vLLM when it serves many.
5. Local for the private, the bulk, and the offline; API for the frontier and the long loops.
6. Measure on your own machine — every table, including mine, is a starting guess.

That is the whole honest version. You can run LLM locally and get real value from it today — as long as you pick the right model, quantize it sensibly, and are honest about which jobs it should never have been given.
