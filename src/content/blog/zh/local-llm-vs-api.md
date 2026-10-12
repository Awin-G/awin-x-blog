---
title: "本地 LLM 对比 API：一份诚实的成本与能力对照"
description: "我在一台只有 CPU 的机器上，用一次性的 Ollama 容器跑了 Qwen2.5，测出了真实的每秒 tokens、内存占用和加载时间。本文讲清本地到底买到了什么、代价是什么、对照公开 API 价格的盈亏平衡账，以及两边各自该在什么时候胜出。"
pubDate: 2026-12-27
lang: zh
translationKey: local-llm-vs-api
tags: [ai, self-hosting]
featured: true
keywords:
  - 本地 LLM 对比 API
  - 本地运行 LLM
  - Ollama
  - 每秒 tokens
  - 量化
  - VRAM
  - 每 token 成本
---

「本地 LLM 对比 API」这场争论通常靠感觉打：一边说本地免费又私密，另一边说它又慢又差。我想要数字，于是用一次性的 [Ollama](/zh/posts/running-models-locally/) 容器在一台只有 CPU 的机器上跑了一遍，测出真实的每秒 tokens，并对照公开的 API 价格算了一笔账。

先说结论：本地在隐私、边际成本、离线可用和无速率限制上赢，在能力和「硬件加你花掉的时间」这两项成本上输。这笔交换值不值，几乎完全取决于一个数字——你每个月到底要推多少 token。

## 本地买到了什么，又付出了什么

**买到了什么。** 数据从不离开这台机器，这对任何带 PII、内部文档或客户文本的东西来说就是全部意义。没有按 token 计费的账单，所以一个「每敲一个键就触发」的循环，和一个「每小时才触发一次」的循环，成本一样。它能在离线和飞机上工作。没有速率限制，没有按席位计费，也没有哪个厂商在下一季度决定把你的模型下架。

**付出了什么。** 你用硬件、电费和运维来付账：驱动、量化选择、上下文大小、那个悄悄让一切变慢的开关。你还用能力付账——小的本地模型不是前沿模型。最隐蔽的一项成本是你的时间：调试一块不肯 offload 的 GPU，并不因为 token 免费就也免费。

## 真正的约束是内存带宽和 VRAM

参数量是个障眼法。推理一次只生成一个 token，而每个 token 基本上都要把所有权重读一遍。所以每秒 tokens 大致等于**内存带宽 ÷ 模型字节数**。两个限制决定什么能跑：

- **容量**——模型能不能塞进 VRAM，或者至少塞进内存？如果溢出到磁盘，它就彻底不可用了。
- **带宽**——你能多快地流式读取那些权重？CPU 从系统内存里读，比 GPU 慢一个数量级，这就是为什么同一个模型在笔记本上爬、在显卡上飞。

我的测量正好印证了这一点。在这台机器上（8 线程 CPU，无 GPU），我每把模型翻一倍，生成速度就减半。这是带宽，不是参数量，而它才是该驱动你选型决策的那个数字。更长的版本见[本地跑大模型](/zh/posts/running-models-locally/)。

## 量化：Q4_K_M 到底买到了什么

几乎没人用原生精度跑模型。**量化**用更少的比特存储每个权重，用一点点质量换回大量的体积和速度。我这次测试全程用 **Q4_K_M**——大约每个权重 4.5 比特，是常见的默认档。诚实地讲这些取舍：

- **Q8_0**——接近参考质量，体积只有 FP16 的一半。内存不紧张时的稳妥选择。
- **Q5_K_M / Q4_K_M**——通常的默认档。抽取、摘要和分类几乎察觉不到损失。
- **Q3 及以下**——损伤可见，尤其在推理上。除非是唯一能塞下的办法，否则别用。

有两点值得直说：字母很重要（`Q4_0` 和 `Q4_K_M` 都叫「4 比特」，行为却不一样），而 **KV 缓存**是一笔人们常忘的内存税——它随上下文长度和并发增长，所以一个在 4k 上下文能塞下的模型，到 32k 就可能撑爆。

## 用 Ollama 本地运行 LLM：真实的每秒 tokens

我不想要一套被我调过参的基准测试。我想要那个无聊的、默认的体验。于是：官方 `ollama/ollama` 镜像，一个只绑定到 `127.0.0.1` 的一次性容器，三个 Qwen2.5 的 Q4_K_M 模型，纯 CPU。镜像本身**磁盘上 9.36 GB**（压缩后 3.78 GB），这在你 pull 之前就值得知道。

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

然后一个固定 prompt，`num_predict: 200`、`temperature: 0`，用 Ollama 在 `/api/generate` 里返回的计时字段：

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

下面是完整的实测结果。加载时间是冷启动加载模型的时间；生成是稳态的每秒 tokens；内存是整个容器在模型常驻时的占用（不加载模型、空闲时，容器约 55 MiB）。

| 模型（Q4_K_M） | 文件 | 冷加载 | Prompt 求值 | 生成 | 容器内存 |
| --- | --- | --- | --- | --- | --- |
| qwen2.5:0.5b | 397 MB | 2.1 s | 108 tok/s | **36 tok/s** | 555 MiB |
| qwen2.5:1.5b | 986 MB | 3.6 s | 51 tok/s | **17 tok/s** | 1.15 GiB |
| qwen2.5:3b | 1.9 GB | 11.9 s | 23 tok/s | **8.4 tok/s** | 2.10 GiB |

有三点很扎眼。模型翻倍、生成速度减半——带宽的故事被印证了。Prompt 求值大约比生成快三倍，因为读 prompt 是一次并行扫描，而不是一次一个 token。而冷加载不是免费的：第一个 token 之前要等 2 到 12 秒，如果你按需拉起模型，这很要命。热生成速度和冷启动完全一样（1.5B 是 17.2 对 17.4 tok/s），所以一旦加载好，它就一直是热的——让它常驻，延迟就没问题。

## 盈亏平衡账：每 token 成本

现在是最诚实的部分。本地不免费，它只是另一张账单。我用真实数字把两边都摆出来。假设一台在生成时大约耗 **30 W** 的笔记本或迷你主机，电价 **$0.20/kWh**——也就是**每小时 $0.006**。要产出 100 万个输出 token：

| 模型 | tok/s | 每 100 万 token 的小时数 | 每 100 万 token 的电费 |
| --- | --- | --- | --- |
| qwen2.5:0.5b | 36 | 7.7 h | ~$0.05 |
| qwen2.5:1.5b | 17 | 16.3 h | ~$0.10 |
| qwen2.5:3b | 8.4 | 33 h | ~$0.20 |

再对照公开的 API 价格（截至写作时，价格会变——请自己核对）。每 100 万输出 token：**DeepSeek V4.1 Flash** 谷时约 **$0.60**、峰时约 **$1.20**，**GPT-4o mini** 约 **$0.60**，**Claude Haiku 4.5** 约 **$5**。

所以如果你**已经拥有这台机器**，本地约 **$0.10/100 万输出 token** 的边际成本，比最便宜的 API 便宜大约**六倍**。盈亏平衡点就是第一个 token。这才是本地流行背后那个真实、不性感的原因：对小的本地模型能做的任务来说，运行成本几乎为零。

如果你是**为了它去买硬件**，账就变了。一台 $300 的迷你主机按三年摊销，约 **$8.33/月**。对照各个 API 的盈亏平衡：

- 对比**便宜的 API**（$0.60/100 万）：你每 100 万省约 $0.50，所以光是回本这台机器就需要**约 1700 万输出 token/月**（约 55 万/天）。
- 对比**昂贵的 API**（$5/100 万）：你每 100 万省约 $4.90，所以只需要**约 170 万输出 token/月**（约 5.7 万/天）。

两行话就是全部教训：对比便宜的 API，本地回本很慢；对比昂贵的 API，本地回本很快。如果你的负载本来会跑在前沿模型上，硬件很快就能自我回本；如果本来会跑在 $0.60 的模型上，你需要一条真正的流水线才撑得起买任何东西。

<figure>
  <svg viewBox="0 0 760 420" role="img" aria-label="盈亏平衡图：本地 LLM 月成本与 API 月成本随用量的关系" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" fill="currentColor">
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
      <text x="395" y="404" text-anchor="middle" font-size="11.5" fill-opacity="0.8">每月输出 token</text>
      <text x="30" y="200" text-anchor="middle" font-size="11.5" fill-opacity="0.8" transform="rotate(-90 30 200)">每月成本（美元）</text>
      <line x1="70" y1="226.7" x2="720" y2="194.7" stroke="#0f766e" stroke-width="2.2"/>
      <text x="470" y="184" fill="#0f766e">本地：约 $8.33/月 + 约 $0.10/100 万 tok</text>
      <line x1="70" y1="360" x2="720" y2="168" stroke="currentColor" stroke-width="2" stroke-opacity="0.85"/>
      <text x="600" y="150" text-anchor="end" fill-opacity="0.9">API @ $0.60 / 100 万 输出</text>
      <line x1="70" y1="360" x2="200" y2="40" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" stroke-opacity="0.7"/>
      <text x="205" y="52" fill-opacity="0.85">API @ $5.00 / 100 万 输出</text>
      <circle cx="611.5" cy="200" r="4.5" fill="#0f766e"/>
      <circle cx="125.3" cy="224" r="4.5" fill="currentColor"/>
      <g font-size="11" fill-opacity="0.85">
        <text x="611.5" y="222" text-anchor="middle">盈亏平衡 ~1700 万 tok/月</text>
        <text x="133" y="248" text-anchor="start">~170 万</text>
      </g>
    </g>
  </svg>
  <figcaption>同一台硬件，两个 API。对比便宜的 API，本地线要到相当大的用量才交叉；对比昂贵的 API，它很早就交叉。如果你已经拥有这台机器，本地线从电费起步，而不是从 $8.33 起步。</figcaption>
</figure>

## 本地在哪儿赢，API 在哪儿赢

**本地赢**，当工作是高频、低风险、边界清晰的时候：给 RAG 索引做批量 **embeddings**、分类、去重、给一整个文件夹的笔记做摘要、在任何东西离开大楼前脱敏 PII、任何必须**离线**运行的活，以及任何频繁触发、会撞上速率限制或账单的循环。这些正是 1–3B 量化模型做得还行的活，边际成本接近零。

**API 赢**在前沿推理上——硬核数学、微妙的多步逻辑、模型必须*正确*的任务；也赢在低用量上，一个月几美元胜过任何硬件；还赢在突发型工作上，否则你会买一块 23 小时都在闲置的 GPU。它在长 agent 循环上也赢——小的本地模型会漂移、打转，大的模型能守住计划。

我对 1.5B 模型做的质量抽查，把这条线画得很具体。给它「抽取 name、port、protocol 为 JSON」，它返回了正确的值——但外面套了层 markdown 代码围栏，还把 `"protocol"` 给成了 `"HTTP over TCP"` 而不是干净的字段，所以你需要一道清洗。一道 token 速率的算术题它做**对了**（360,000 个 token）——却无视了「把最终数字单独放一行」的指令。让它写一行标准库代码数文件行数，它给出 `print(len(open(argv[1]).readlines()))`，这**照原样是错的**——`argv` 从未被 import。修一下能用；但我不会不读就上生产。

## 决策清单

1. **低用量时别为了省钱买硬件。** 一个月不到几百万输出 token，API 更便宜也更好。没有例外。
2. **当替代品是昂贵 API、或存在隐私要求时，才买本地。** 对比 $5/100 万输出，或对比不能外流的数据，本地回本很快。
3. **投入之前先测你自己的每秒 tokens。** 带宽决定一切；我这张表是起点猜测，不是你的答案。
4. **从 Q4_K_M 或 Q5_K_M 起步**，为 KV 缓存留预算，把上下文压到你真正需要的长度。
5. **让模型常驻。** 这里冷加载是 2–12 秒；热生成和冷启动完全一样，所以空闲卸载只会白白增加延迟。
6. **两个都跑。** 本地负责私密、批量、离线和频繁的活；一把 API key 负责前沿和长循环。错误在于把它当成二选一。

这就是诚实的版本。本地不是更便宜的前沿模型——它是一层过滤器，吸收掉大量本就不需要前沿模型的调用，让你的 API 预算花在真正需要的那一小部分上。而如果你也在自己跑栈里的其他部分，同样的取舍还会在[不用 Docker 做自托管](/zh/posts/self-hosting-without-docker/)里出现。
