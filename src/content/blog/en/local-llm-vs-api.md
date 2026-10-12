---
title: "Local LLM vs API: an honest cost and capability comparison"
description: "I ran Qwen2.5 in a throwaway Ollama container on CPU-only hardware and measured real tokens per second, memory use and load time. Here is what local actually buys, what it costs, the break-even maths against published API prices, and where each side wins."
pubDate: 2026-12-27
lang: en
translationKey: local-llm-vs-api
tags: [ai, self-hosting]
featured: true
keywords:
  - local LLM vs API
  - run LLM locally
  - Ollama
  - tokens per second
  - quantization
  - VRAM
  - cost per token
---

The "local LLM vs API" argument is usually fought with vibes: one side says local is free and private, the other says it is slow and worse. I wanted numbers, so I ran a throwaway [Ollama](/posts/running-models-locally/) container on CPU-only hardware, measured real tokens per second, and did the cost arithmetic against published API prices.

The short version: local wins on privacy, marginal cost, offline use and rate limits, and loses on capability and on the cost of hardware and your time. Whether that trade is worth it depends almost entirely on one number — how many tokens a month you actually push.

## What local buys you — and what it costs

**What it buys.** Data never leaves the machine, which is the whole point for anything with PII, internal documents, or client text. There is no per-token bill, so a loop that fires on every keystroke costs the same as one that fires once an hour. It works offline and on a plane. There are no rate limits, no per-seat terms, and no vendor deciding next quarter that your model is deprecated.

**What it costs.** You pay in hardware, electricity, and operations: drivers, quant choices, context sizing, the flag that silently made everything slow. And you pay in capability — a small local model is not a frontier model. The sneaky cost is your time: debugging a GPU that will not offload is not free just because the tokens are.

## The real constraint is memory bandwidth and VRAM

Parameter count is a distraction. Inference generates one token at a time, and each token reads essentially all the weights once. So tokens per second is roughly **memory bandwidth ÷ model size in bytes**. Two limits decide what runs:

- **Capacity** — does the model fit in VRAM, or at least in RAM? If it spills to disk it stops being usable.
- **Bandwidth** — how fast can you stream those weights? A CPU reading from system memory trails a GPU by an order of magnitude, which is why the same model that crawls on a laptop flies on a card.

That is exactly what my measurements show. On this machine (an 8-thread CPU, no GPU), generation speed halved each time I doubled the model. That is bandwidth, not parameter count, and it is the number that should drive your sizing decision. For the longer version, see [run models locally](/posts/running-models-locally/).

## Quantization: what Q4_K_M actually buys

Almost nobody runs models at native precision. **Quantization** stores each weight in fewer bits, trading a little quality for a lot of size and speed. My whole test ran at **Q4_K_M** — roughly 4.5 bits per weight, the common default. The tradeoffs, honestly:

- **Q8_0** — near-reference quality at half of FP16. The safe pick when memory is not tight.
- **Q5_K_M / Q4_K_M** — the usual default. Extraction, summarising and classification barely notice.
- **Q3 and below** — visible damage, especially on reasoning. Use it only if it is the only way to fit.

Two things worth saying plainly: the letters matter (`Q4_0` and `Q4_K_M` are both "4-bit" and behave differently), and the **KV cache** is a memory tax people forget — it grows with context length and concurrency, so a model that fits at 4k context can run out at 32k.

## Run LLM locally with Ollama: real tokens per second

I did not want a benchmark harness I had tuned. I wanted the boring, default experience. So: official `ollama/ollama` image, a throwaway container bound to `127.0.0.1` only, three Qwen2.5 models at Q4_K_M, CPU-only. The image is **9.36 GB on disk** (3.78 GB compressed), which is itself worth knowing before you pull it.

```bash
docker run -d --rm --name ollama-bench \
  -p 127.0.0.1:11499:11434 ollama/ollama:latest

docker exec ollama-bench ollama pull qwen2.5:1.5b
docker exec ollama-bench ollama list
```

```text
NAME            ID              SIZE      QUANT
qwen2.5:0.5b    a8b0c5157701    397 MB    Q4_K_M
qwen2.5:1.5b    65ec06548149    986 MB    Q4_K_M
qwen2.5:3b      357c53fb659c    1.9 GB    Q4_K_M
```

Then one fixed prompt, `num_predict: 200`, `temperature: 0`, and the timing fields Ollama returns in `/api/generate`:

```bash
curl -s http://127.0.0.1:11499/api/generate -d '{
  "model": "qwen2.5:1.5b",
  "prompt": "Explain in exactly three sentences why a home server should use a UPS.",
  "stream": false,
  "options": { "num_predict": 200, "temperature": 0 }
}' | jq '{load_s: (.load_duration/1e9),
         prompt_tok_s: (.prompt_eval_count / (.prompt_eval_duration/1e9)),
         gen_tok_s: (.eval_count / (.eval_duration/1e9))}'
```

```json
{ "load_s": 3.57, "prompt_tok_s": 51.0, "gen_tok_s": 17.2 }
```

Here is the full measured set. Load time is the cold model load; generation is steady-state tokens per second; RAM is the whole container with the model resident (idle, with no model loaded, the container sat at ~55 MiB).

| Model (Q4_K_M) | File | Cold load | Prompt eval | Generation | Container RAM |
| --- | --- | --- | --- | --- | --- |
| qwen2.5:0.5b | 397 MB | 2.1 s | 108 tok/s | **36 tok/s** | 555 MiB |
| qwen2.5:1.5b | 986 MB | 3.6 s | 51 tok/s | **17 tok/s** | 1.15 GiB |
| qwen2.5:3b | 1.9 GB | 11.9 s | 23 tok/s | **8.4 tok/s** | 2.10 GiB |

Three things jump out. Generation speed halves as the model doubles — the bandwidth story, confirmed. Prompt evaluation runs about three times faster than generation, because reading a prompt is one parallel pass, not one-token-at-a-time. And cold load is not free: 2 to 12 seconds before the first token, which matters if you spin models up on demand. Warm generation speed was identical to cold (17.2 vs 17.4 tok/s for the 1.5B), so once it is loaded, it stays loaded — keep it resident and the latency is fine.

## The break-even maths: cost per token

Now the honest part. Local is not free; it is a different bill. Let me put real numbers on both sides. Assume a laptop or mini-PC that draws about **30 W** while generating, at **$0.20/kWh** — that is **$0.006 per hour** of generation. To make 1M output tokens:

| Model | tok/s | Hours per 1M tok | Electricity per 1M tok |
| --- | --- | --- | --- |
| qwen2.5:0.5b | 36 | 7.7 h | ~$0.05 |
| qwen2.5:1.5b | 17 | 16.3 h | ~$0.10 |
| qwen2.5:3b | 8.4 | 33 h | ~$0.20 |

Compare that to published API prices (as of writing, and they move — check them). Per 1M output tokens: **DeepSeek V4.1 Flash** is about **$0.60** off-peak and **$1.20** at peak, **GPT-4o mini** about **$0.60**, and **Claude Haiku 4.5** about **$5**.

So if you **already own the machine**, local's marginal cost of ~$0.10 per 1M output tokens is roughly **six times cheaper** than the cheapest API. The break-even is the very first token. That is the real, unglamorous reason local is popular: for the tasks a small model can do, the running cost is nearly nothing.

If you **buy hardware for it**, the maths changes. A $300 mini-PC amortised over three years is about **$8.33/month**. Break-even against each API:

- vs a **cheap API** ($0.60/1M): you save ~$0.50/1M, so you need **~17M output tokens/month** (~550k/day) just to repay the box.
- vs a **premium API** ($5/1M): you save ~$4.90/1M, so you need only **~1.7M output tokens/month** (~57k/day).

That is the whole lesson in two lines: local pays back slowly against a cheap API and quickly against an expensive one. If your workload would otherwise run on a frontier model, the hardware pays for itself fast; if it would run on a $0.60 model, you need a genuine pipeline to justify buying anything.

<figure>
  <svg viewBox="0 0 760 420" role="img" aria-label="Break-even chart: local LLM monthly cost versus API monthly cost by volume" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" fill="currentColor">
      <!-- axes -->
      <line x1="70" y1="360" x2="720" y2="360" stroke="currentColor" stroke-opacity="0.6"/>
      <line x1="70" y1="360" x2="70" y2="40" stroke="currentColor" stroke-opacity="0.6"/>
      <g fill-opacity="0.75" font-size="11">
        <text x="70" y="378" text-anchor="middle">0</text>
        <text x="232" y="378" text-anchor="middle">5M</text>
        <text x="395" y="378" text-anchor="middle">10M</text>
        <text x="557" y="378" text-anchor="middle">15M</text>
        <text x="720" y="378" text-anchor="middle">20M</text>
        <text x="62" y="364" text-anchor="end">$0</text>
        <text x="62" y="284" text-anchor="end">$5</text>
        <text x="62" y="204" text-anchor="end">$10</text>
        <text x="62" y="124" text-anchor="end">$15</text>
        <text x="62" y="44" text-anchor="end">$20</text>
      </g>
      <text x="395" y="404" text-anchor="middle" font-size="11.5" fill-opacity="0.8">output tokens per month</text>
      <text x="30" y="200" text-anchor="middle" font-size="11.5" fill-opacity="0.8" transform="rotate(-90 30 200)">monthly cost (USD)</text>
      <!-- local line: 8.33 + 0.10x -->
      <line x1="70" y1="226.7" x2="720" y2="194.7" stroke="#0f766e" stroke-width="2.2"/>
      <text x="470" y="184" fill="#0f766e">local: ~$8.33/mo + ~$0.10 per 1M tok</text>
      <!-- cheap API: 0.60x -->
      <line x1="70" y1="360" x2="720" y2="168" stroke="currentColor" stroke-width="2" stroke-opacity="0.85"/>
      <text x="600" y="150" text-anchor="end" fill-opacity="0.9">API @ $0.60 / 1M out</text>
      <!-- premium API: 5x, clipped at top -->
      <line x1="70" y1="360" x2="200" y2="40" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" stroke-opacity="0.7"/>
      <text x="205" y="52" fill-opacity="0.85">API @ $5.00 / 1M out</text>
      <!-- break-even markers -->
      <circle cx="611.5" cy="200" r="4.5" fill="#0f766e"/>
      <circle cx="125.3" cy="224" r="4.5" fill="currentColor"/>
      <g font-size="11" fill-opacity="0.85">
        <text x="611.5" y="222" text-anchor="middle">break-even ~17M tok/mo</text>
        <text x="133" y="248" text-anchor="start">~1.7M</text>
      </g>
    </g>
  </svg>
  <figcaption>Same hardware, two APIs. Against a cheap API the local line only crosses at a serious volume; against a premium API it crosses early. If you already own the box, the local line starts at the electricity cost instead of $8.33.</figcaption>
</figure>

## Where local wins, and where an API wins

**Local wins** when the work is high-volume, low-stakes and well-scoped: bulk **embeddings** for a RAG index, classification, deduplication, summarising a folder of notes, redacting PII before anything leaves the building, anything that must run **offline**, and any loop that fires constantly and would rack up a rate-limit or a bill. These are exactly the jobs a 1–3B quantised model does acceptably, at a marginal cost near zero.

**An API wins** on frontier reasoning — hard maths, subtle multi-step logic, tasks where the model must be *right*; on low volume, where a few dollars a month beats any hardware; and on bursty work, where you would otherwise buy a GPU that idles 23 hours a day. It also wins on long agentic loops, where a small model drifts and loops and a big one holds the plan.

My quality spot-checks on the 1.5B model make the line concrete. Given "extract name, port, protocol as JSON", it returned the right values — but wrapped them in a markdown fence and gave `"protocol": "HTTP over TCP"` instead of a clean field, so you need a cleanup pass. A token-rate arithmetic question it got **right** (360,000 tokens) — but ignored the instruction to put the final number on its own line. Asked for a stdlib one-liner to count lines in a file, it produced `print(len(open(argv[1]).readlines()))`, which is *wrong as written* — `argv` is never imported. Usable with a fix; not something I would ship unread.

## The decision list

1. **Do not buy hardware to save money at low volume.** Under a few million output tokens a month, an API is cheaper and better. Full stop.
2. **Buy local when the alternative is a premium API or a privacy requirement.** Against $5/1M output, or for data that cannot leave, local repays fast.
3. **Measure your own tokens per second before you commit.** Bandwidth decides everything; my table is a starting guess, not your answer.
4. **Start at Q4_K_M or Q5_K_M**, budget for the KV cache, and cap context to what you need.
5. **Keep the model resident.** Cold load was 2–12 seconds here; warm generation was identical to cold, so idle eviction is pure latency for no gain.
6. **Run both.** Local for the private, the bulk, the offline and the constant; an API key for the frontier and the long loops. The mistake is treating it as either/or.

That is the honest version. Local is not a cheaper frontier model — it is a filter that absorbs the large share of calls that never needed one, so your API budget goes to the small share that genuinely did. And if you are running the rest of your stack yourself too, the same tradeoffs show up in [self-hosting without Docker](/posts/self-hosting-without-docker/).
