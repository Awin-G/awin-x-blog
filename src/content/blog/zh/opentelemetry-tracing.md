---
title: "分布式追踪入门：不搞仪式感的 OpenTelemetry"
description: "三大支柱的取舍、distributed tracing 到底解决什么问题、必备词汇（trace、span、trace context、attributes、sampling），以及一套最小可用的 OpenTelemetry 配置 —— 插桩应用、OTLP 导出、Jaeger 后端 —— 附真实的 span、真实的 traceparent 头和实测的采样输出。"
pubDate: 2026-12-12
lang: zh
translationKey: opentelemetry-tracing
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry
  - 分布式追踪
  - Jaeger
  - trace context
  - OTLP
---

一个请求进来，经过三个服务，用户说它很慢。你去看 A 机器上的日志，看着没问
题；指标显示 p99 升高了，但没说*为什么*。于是你开始猜。这正是
**distributed tracing**（分布式追踪）存在的意义：针对*一个*请求，跨过每一
跳，时间到底花在哪。而 **OpenTelemetry** 这个标准，把「收集这个答案」变得足
够无聊，无聊到你真的会去做。这篇是不搞仪式感的版本：我临时起了一个 Jaeger，
用 `curl` 和 SDK 分别给它发了真实的 span，然后把原始输出贴在下面。

## 三大支柱，以及追踪真正回答的那一个问题

可观测性通常被画成三根支柱：**logs**、**metrics**、**traces**。它们不是竞
争关系，回答的是不同的问题。

| 支柱 | 回答什么 | 成本模型 |
| --- | --- | --- |
| Metrics | 「现在是不是坏了，坏在多少？」 | 便宜、聚合、没有单请求细节 |
| Logs | 「这条代码路径上*发生*了什么？」 | 体量随流量增长 |
| **Traces** | 「*这个*请求里，哪一跳慢？」 | 按请求、需要采样 |

Metrics 告诉你 API 慢；traces 告诉你它慢是因为 `payment-service` 花了 50ms，
而其中 30ms 又是里面那条 SQL insert。Logs 也能告诉你 —— 前提是你已经知道该
看哪，而且你为那份日志量付了钱。就是这最后一公里，「**哪一跳慢**」，让
tracing 值得。它是三根支柱里唯一一个「一个请求的画面，胜过一千个聚合数字」
的东西。

## 按你相遇的顺序，过一遍词汇

**Trace（追踪）** —— 一个请求从边缘到最后一个服务的完整故事。里面每个 span
都共享同一个 **trace id**（32 位十六进制）。我下面那次跑的 trace id 是
`714d9c1fe324840626692e57028ee06c`。

**Span（跨度）** —— 一个工作单元：一个 HTTP handler、一次 DB 查询、或你决定
计时的某个函数。span 有名字、开始时间、时长、**span id**（16 位十六进制），
以及指向父 span 的指针。正是这条父子链，把一堆 span 变成一棵树。

**Trace context（追踪上下文）** —— 那袋被携带在*服务之间*的小 id（trace
id、span id、flags）。这是最被低估的部分。在建到请求离开你的进程之前，一切
都很简单。

**Attributes（属性）** —— span 上的键值元数据：`http.request.method`、
`http.response.status_code`、`db.system`。用标准的
[semantic conventions](https://opentelemetry.io/docs/specs/semconv/)，这样换
个语言也不用重写仪表盘；那些名字故意起得很无聊。

**Sampling（采样）** —— 提前决定某条 trace 到底记不记。理想情况下，这个决定
在根 span 做一次然后被继承，于是每条 trace 要么完整、要么不存在，绝不会只采
一半。

<figure>
<svg viewBox="0 0 720 210" width="100%" role="img" aria-label="一条跨三个服务的 trace。frontend 在根部处理 GET /cart；它调用 checkout-api 的 POST /checkout，后者先跑 SELECT carts，再用一个 HTTP 客户端 span 调 payment-service；payment-service 里是 POST /charge，里面包着 INSERT payments。每个 span 画成一根条，长度即时长，所以最底下的条就显示了时间花在哪。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="10" y="18" font-size="13" font-weight="600">一条 trace，三个服务（条长＝时长）</text>

    <text x="10" y="52" opacity="0.85">frontend</text>
    <rect x="120" y="40" width="420" height="18" rx="3" fill="#0f766e" opacity="0.85"/>
    <text x="130" y="53" fill="#ffffff" font-size="10">GET /cart</text>

    <text x="10" y="84" opacity="0.85">checkout-api</text>
    <rect x="150" y="72" width="370" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="160" y="85" font-size="10">POST /checkout</text>
    <rect x="165" y="94" width="70" height="14" rx="2" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>
    <text x="240" y="105" font-size="9" opacity="0.8">SELECT carts</text>
    <rect x="255" y="112" width="230" height="14" rx="2" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>
    <text x="490" y="123" font-size="9" opacity="0.8">HTTP POST /charge</text>

    <text x="10" y="146" opacity="0.85">payment-service</text>
    <rect x="270" y="134" width="205" height="18" rx="3" fill="#0f766e" opacity="0.6"/>
    <text x="280" y="147" font-size="10">POST /charge</text>
    <rect x="285" y="156" width="150" height="14" rx="2" fill="#0f766e" opacity="0.35"/>
    <text x="440" y="167" font-size="9">INSERT payments</text>

    <line x1="120" y1="30" x2="120" y2="182" stroke="currentColor" stroke-width="1" opacity="0.4"/>
    <text x="120" y="196" text-anchor="middle" opacity="0.75">0ms</text>
    <line x1="540" y1="30" x2="540" y2="182" stroke="currentColor" stroke-width="1" opacity="0.4"/>
    <text x="540" y="196" text-anchor="middle" opacity="0.75">~105ms</text>
  </g>
</svg>
<figcaption>六个 span，一个 trace id。最底下的条说明了毫秒花在哪：payment 那条 insert 在 payment 调用里面，payment 调用在 checkout 里面，checkout 又在页面加载里面。这种嵌套，就是一条 trace 的全部价值。</figcaption>
</figure>

## OpenTelemetry 是标准，不是后端

**OpenTelemetry**（OTel）是一套厂商中立的规范，加上各语言 SDK，加一个线上协
议。它分三块，把它们混为一谈是常见困惑的来源：

- **API + SDK** —— 你按它插桩，用你自己语言的那一份。
- **OTLP** —— OpenTelemetry Protocol，span 传输的格式。OTLP 有两种编码：
  gRPC（4317 端口）和 HTTP/protobuf 或 HTTP/JSON（4318 端口）。
- **后端** —— span 落地并显示的地方：**Jaeger**、Grafana Tempo，或某个商业
  产品。OTel 故意不含后端。

这套设计的好处是：换后端只是改配置，而插桩一个服务，无论什么语言都是同一个
形状。

## 最小配置：一个真实的 span 长什么样

我起了一个一次性的后端。Jaeger all-in-one 直接收 OTLP，所以没有别的东西要跑：

```bash
docker run -d --name otel-jaeger \
  -p 127.0.0.1:16686:16686 \
  -p 127.0.0.1:4318:4318 \
  -p 127.0.0.1:4317:4317 \
  jaegertracing/all-in-one:latest
```

要证明这条管道通，你甚至不需要 SDK。OTLP/HTTP 接受 JSON，所以 `curl` 就能发
一个手写的 span，Jaeger 会把它渲染出来：

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  --data @curl-span.json
# 200
```

```json
{
  "data": ["checkout-api"],
  "total": 1,
  "limit": 0,
  "offset": 0,
  "errors": null
}
```

那个 `200` 就是第一个里程碑：你应用里的 span 会走一模一样的路径。现在来看有
意思的版本 —— 一次真正的 **distributed tracing**。我写了三个小小的 Python
服务（`frontend`、`checkout-api`、`payment-service`），每个都有自己的
`TracerProvider`，通过 HTTP 导出到 OTLP，然后端到端地跑了一个请求：

```python
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "checkout-api"}))
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://127.0.0.1:4318/v1/traces"))
)
```

然后我问 Jaeger 它到底收到了什么。`/api/services` 是「span 真到了」而不是
「span 发出去了」的诚实检查：

```bash
curl -s http://127.0.0.1:16686/api/services | python3 -m json.tool
```

```json
{
  "data": ["checkout-api", "jaeger-all-in-one", "frontend", "payment-service"],
  "total": 4,
  "limit": 0,
  "offset": 0,
  "errors": null
}
```

三个服务，因为三个进程各自上报了自己。再把真正的 trace 从 `/api/traces` 里取
出来，就是这棵树，时长单位是微秒：

```
traceID: 714d9c1fe324840626692e57028ee06c  spans: 6
frontend         GET /cart              dur= 105817us  parent=ROOT
checkout-api     POST /checkout         dur=  82547us  parent=dfd48770a6cbef5d
checkout-api     SELECT carts           dur=  12125us  parent=1a9c149893e3c3de
checkout-api     HTTP POST /charge      dur=  70042us  parent=1a9c149893e3c3de
payment-service  POST /charge           dur=  50341us  parent=d43c03903dde9800
payment-service  INSERT payments        dur=  30133us  parent=b683bec70fdbc296
```

「哪一跳慢」的答案就在这，不需要任何猜测。`SELECT carts` 12ms；payment 调用
50ms，而其中大头是那条数据库 insert。你也能读出任意 span 的属性：

```
payment-service POST /charge
  otel.scope.name       = payment-service
  payment.amount_cents  = 4200   (int64)
  payment.currency      = usd    (string)
  span.kind             = internal
```

注意 `span.kind` —— `server`、`client`、`producer`、`consumer` 或
`internal`。跨一跳的 client/server 配对，正是后端用来判断该在两个服务之间画
箭头的东西。

## 最难的部分：跨服务传播

单进程的 trace 很简单，因为 SDK 握着「当前 span」，任何新 span 都自动嵌在它
下面。真正难的是跨进程那一跳。当 `frontend` 调 `checkout-api` 时，网络里没
有任何东西告诉 checkout 它属于哪条 trace —— 你得自己携带。

标准是 **W3C trace context**，载体就是一个 HTTP 头：`traceparent`。它有三个
字段：版本、trace id、父 span id、flags。

```python
from opentelemetry.propagate import inject, extract

# 在调用方，趁 client span 是「当前 span」时：
headers = {}
inject(headers)
# headers["traceparent"] = "00-<trace-id>-<span-id>-<flags>"

# 在被调方，开 server span 之前：
ctx = extract(request.headers)
with tracer.start_as_current_span("POST /checkout", context=ctx):
    ...
```

我把 `frontend` 真正发出去的那个头打了出来：

```
outgoing traceparent: 00-714d9c1fe324840626692e57028ee06c-dfd48770a6cbef5d-03
```

机制就这么点。问题都出在顺路之外的层次上，而这些坑值得在依赖 tracing 之前先
知道：

- **每个边界都得传播。** HTTP 有标准头；消息队列、cron 任务、后台 worker 没
  有。一条停在队列处的 trace 看起来完整，其实是个谎言。
- **`inject` 必须在*正确*的 span 是当前 span 时执行。** 我自己就踩了：我在开
  client span *之前* inject，结果 payment span 的父节点变成了 checkout 的
  *server* span，而不是 *client* span。trace 渲染出来没问题，只是箭头错了。
- **异步和线程池会隐藏上下文。** 任何跨线程或跨事件循环的东西都必须显式携带
  上下文，否则 span 会孤立成新的 trace。
- **这个头不是可信输入。** 后端应该校验 `traceparent`（`tracestate` 更是如
  此），而不是盲目续接收到的东西。

## 采样，以及 trace 到底花多少钱

流量一大你就留不住每条 trace。一条走 10 个服务、每服务 5 个 span 的调用路径，
每个请求就是 50 个 span；按 1000 rps 算，每秒 5 万个 span，每秒都这样。采样
就是那个杠杆。

默认、通常也正确的选择是 **头部采样（head sampling）**：在根上决定，然后让决
定往下流，于是 trace 是完整的。`ParentBased` 包住另一个采样器，让子 span 尊重
根的决定。我实测了 `TraceIdRatioBased` 根采样器在 2000 条 trace 上到底留下多
少：

```
ratio=1.0    started=2000  exported= 2000  (100.0%)
ratio=0.25   started=2000  exported=  480  (24.0%)
ratio=0.1    started=2000  exported=  201  (10.1%)
ratio=0.01   started=2000  exported=   30  (1.5%)
```

这张表有两件事值得记住。第一，它有效：内存、网络、存储都跟着比例缩放。第二，
它不会精确落在那个数字上 —— 0.25 出来 24%，0.1 出来 10.1%。这很正常，也值得
内化：比例采样器是统计性的，不是配额。

成本决策不是「采不采」，而是**用哪个采样器**。均匀比例会把罕见的慢请求，和
无聊的快请求一样频繁地丢掉 —— 而那恰恰是你最需要它的时候。更好的做法是尾部
采样：所有超过延迟阈值的 trace 全留，同时设一个下限比例好保证有基线。另外，
把 `parentbased_always_off` 留着对付健康检查和负载均衡探针，那些是纯噪声。

## 什么时候 logs + metrics 就够，tracing 是过度设计

Tracing 不免费，而可观测性内容里最大的谎言就是「第一天你就需要三根支柱」。如
果你在一台机器上跑一个进程，tracing 给你的东西，几乎不比「带 correlation id
的好日志」更多 —— 那就是
[结构化日志](/zh/posts/structured-logging/)，而它是我每次都会建议的起点。

这些条件成立时，才去碰 tracing：

- **你有跨服务的请求。** 没有第二跳，就没有分布式 trace 可画。
- **「哪一跳慢」是你真的会问的问题。** 如果你的 p99 一直正常，事故全是磁盘满
  和证书过期，那你需要的是
  [小规模服务器监控](/zh/posts/monitoring-a-small-fleet/)，不是 span。
- **日志体量本身成了问题。** Trace 用少得多得多的字节，携带了同样的关系信
  息，因为它天生就是采样且结构化的。

以下情况请跳过：单服务、低流量、事故全是资源耗尽、或者团队不会维护那条管道。
一个把 span 导出到没人看的后端的 `TraceProvider`，就是一个带着漂亮火焰图的成
本中心。先用日志，需要速率和告警时加指标，等第一次因为一个慢请求而不得不在三
台机器上 grep 时，再加 trace。

## 一句话版本

Metrics 告诉你出事了，logs 告诉你发生了什么，而 traces 告诉你*在哪* —— 哪一
跳，一个请求，端到端。OpenTelemetry 让收集这件事变成厂商中立且无聊；OTLP 负
责传输；Jaeger 或 Tempo 负责显示；一个 `traceparent` 头把服务缝在一起。人们
抱怨的「仪式感」，大部分其实是传播和采样 —— 那两块确实难，也正是在规模化之
前值得搞懂的两块。起一个 Jaeger，`curl` 一个 span 进去，把第一条 trace 显示
出来。之后的一切都是精雕细琢。
