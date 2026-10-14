---
title: "OpenTelemetry 指标与 exemplar：从一次毛刺追到引发它的那条 trace"
description: "计数器、仪表、直方图各自何时该用；OTLP 直方图在 Prometheus 里变成什么（_bucket/_sum/_count）；delta 时间性如何悄悄冻住计数器；以及 exemplar——一条携带 trace_id 的指标样本。附真实的 collector 与 PromQL 输出。"
pubDate: 2027-02-10
lang: zh
translationKey: opentelemetry-metrics-and-exemplars
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry 指标
  - exemplar
  - histogram 与 summary
  - prometheusremotewrite
  - delta 时间性
---

`/checkout` 的 p99 延迟曲线竖起来了，而我说不出*是哪个请求*干的。指标擅长告诉我**某件事变慢了**、**有多少件变慢了**；它在结构上就不擅长告诉我**是哪一件**。从"数字涨了"到"这就是那个 span"之间的最后一跳，正是 **exemplar** 要补上的，也是这篇文章要讲的东西。

我起了一个一次性的 OpenTelemetry Collector、一个一次性的 Prometheus、一个一次性的 Jaeger，发了一条真实的、带显式分桶的 OTLP 直方图，下面贴的都是原始输出。凡是和我预期不一致的地方，我都如实写出来。

## 我实际跑的东西

三个容器，全部绑在 `127.0.0.1`，用的官方镜像：`otel/opentelemetry-collector-contrib:0.162.0`、`prom/prometheus:3.15.0`、`jaegertracing/all-in-one`。

```console
$ docker run -d --name otelcol --network otelnet \
    -p 127.0.0.1:4317:4317 -p 127.0.0.1:4318:4318 -p 127.0.0.1:8889:8889 \
    -v $PWD/otelcol.yaml:/etc/otelcol/config.yaml \
    otel/opentelemetry-collector-contrib:latest --config=/etc/otelcol/config.yaml

$ docker run -d --name prom --network otelnet -p 127.0.0.1:19091:9090 \
    -v $PWD/prometheus.yml:/etc/prometheus/prometheus.yml \
    prom/prometheus:latest --config.file=/etc/prometheus/prometheus.yml \
    --enable-feature=exemplar-storage
```

collector 的配置刻意写得很小——一个 `otlp` receiver、一个监听 `:8889` 的 `prometheus` exporter，外加一个 `debug` exporter，好让我在被翻译之前先看清收进来的是什么：

```yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 0.0.0.0:4318 }
processors:
  memory_limiter: { check_interval: 1s, limit_mib: 256, spike_limit_mib: 64 }
  batch: { send_batch_size: 512, timeout: 1s }
exporters:
  debug: { verbosity: detailed }
  prometheus:
    endpoint: 0.0.0.0:8889
    send_timestamps: true
    enable_open_metrics: true
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, prometheus]
```

如果 receiver/processor/exporter 这套还让你觉得是仪式感，我把管道模型写在 [OpenTelemetry Collector](/zh/posts/opentelemetry-collector-pipelines/) 那篇里了。这里我只关心一条*指标*会经历什么。

## 真正重要的三种仪器

OpenTelemetry 有一小把指标仪器，但重量几乎都压在这三个上：

| 仪器 | 是什么 | 用来记 | 在 PromQL 里 |
| --- | --- | --- | --- |
| **Counter** | 单调递增的 sum | 请求数、字节数、错误数、跑完的任务数 | `rate()` / `increase()` |
| **Gauge** | 此刻的值 | 队列深度、连接数、缓存大小、温度 | 原值；`avg_over_time()` |
| **Histogram** | 按桶统计的分布 | 延迟、报文大小、返回行数 | `histogram_quantile()` |

我用的规则是：**如果这个数字唯一可能发生的事就是"变大"，它就是 counter。** counter 存储便宜、推理简单，因为 `rate()` 让它与流量无关。不要因为"顺便也想要当前值"就把 counter 改成 gauge——`increase()` 已经给你了。

**Gauge** 用于那些既会涨也会跌的量。常见的坑是对 gauge 取 `rate()`，那是没有意义的：队列深度在 3 和 8 之间摆动，不等于"每秒 5 个队列"。

**Histogram** 是这里最有意思的一个，这篇文章剩下的部分基本都在讲它。只要问题形式是"有多慢、对谁而言"而不是"平均有多慢"，就该用直方图。延迟是长尾分布，平均值恰好把你需要的信息毁掉了。

此外还有 `UpDownCounter`（用于在途请求数），以及 OTel 的**指数直方图**，可以映射到 Prometheus 原生直方图——本文没有测试。

## 一条 OTLP 直方图在 Prometheus 里变成什么

下面是我实际 POST 到 `http://127.0.0.1:4318/v1/metrics` 的那条指标（OTLP/HTTP，JSON 编码），裁到只剩直方图。注意 `explicitBounds` 和 `bucketCounts`——后者比前者多一个元素，最后那个计数就是 `+Inf` 溢出桶：

```json
{
  "name": "http.server.request.duration",
  "unit": "ms",
  "histogram": {
    "aggregationTemporality": 2,
    "dataPoints": [{
      "attributes": [{ "key": "http.route", "value": { "stringValue": "/checkout" } }],
      "count": "6", "sum": 391.0, "min": 3.0, "max": 180.0,
      "bucketCounts": ["2", "2", "1", "1", "0"],
      "explicitBounds": [10.0, 25.0, 50.0, 100.0],
      "exemplars": [{
        "timeUnixNano": "1791959284359035552",
        "asDouble": 180.0,
        "spanId": "00f067aa0ba902b7",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
      }]
    }]
  }
}
```

collector 的 `debug` exporter 确认了收到的东西——注意它已经把 exemplar 显示出来了：

```text
Metric #1
Descriptor:
     -> Name: http.server.request.duration
     -> Unit: ms
     -> DataType: Histogram
     -> AggregationTemporality: Cumulative
HistogramDataPoints #0
Data point attributes:
     -> http.route: Str(/checkout)
Count: 6
Sum: 391.000000
Min: 3.000000
Max: 180.000000
ExplicitBounds #0: 10.000000
ExplicitBounds #1: 25.000000
ExplicitBounds #2: 50.000000
ExplicitBounds #3: 100.000000
Buckets #0, Count: 2
Buckets #1, Count: 2
Buckets #2, Count: 1
Buckets #3, Count: 1
Buckets #4, Count: 0
Exemplars:
Exemplar #0
     -> Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736
     -> Span ID: 00f067aa0ba902b7
     -> Value: 180.000000
     -> FilteredAttributes:
          -> http.route: Str(/checkout)
```

再看 `curl http://127.0.0.1:8889/metrics` 拿到的 Prometheus 暴露格式：

```text
# HELP http_server_request_duration_milliseconds HTTP request duration
# TYPE http_server_request_duration_milliseconds histogram
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="10"} 2
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="25"} 4
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="50"} 5
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="100"} 6
http_server_request_duration_milliseconds_bucket{http_route="/checkout",le="+Inf"} 6
http_server_request_duration_milliseconds_sum{http_route="/checkout"} 391
http_server_request_duration_milliseconds_count{http_route="/checkout"} 6
```

（真实输出里还有 `job`、`otel_scope_name`、`otel_scope_version` 等标签和一个时间戳——因为我设了 `send_timestamps: true`。这里为了排版裁掉了。）

有三件事值得指出，因为它们都会让人意外：

1. **名字变了。** 点号变成了下划线，单位 `ms` 被追加成 `_milliseconds`。你的看板查询是 `http_server_request_duration_milliseconds_bucket`，不是 `http.server.request.duration`。
2. **桶是累积的。** `le="25"` 是 4，其中*包含*了 10 ms 以下的 2 个请求。`+Inf` 桶永远等于 `_count`。
3. **`_sum` 和 `_count` 是白送的。** 直方图本身就带着它们，所以一个仪器同时给你平均值和分布。

整个翻译过程就是这样：OTel 直方图就是 Prometheus 直方图，因为 Prometheus 直方图是唯一被广泛支持的、可聚合的分布原语。

## 直方图 vs summary，说点实话

Prometheus 还有第二种分布类型：**summary**。它在*客户端*计算分位数，导出成 `_count`、`_sum` 以及一组 `{quantile="0.5"}`、`{quantile="0.95"}` 序列。

summary 很有诱惑力，因为分位数是精确的、还不要钱。它也是个陷阱：

- **summary 的分位数无法聚合。** 两个 p95 不能相加，也不能取平均。十个实例各导出一个 p95，你得不到全集群的 p95——需要的数据在客户端就被丢掉了。
- **直方图的分桶边界在创建仪器时就固定了。** 它在*单实例*层面更差（桶内插值误差），但它在*跨实例*层面可聚合，而后者才是你真正面对的场景。

这就是 OpenTelemetry 干脆没有 summary 仪器的原因：**可聚合性胜过单实例精度。** 一个偏差 3% 的全集群 p95 是有用的；十个精确的单实例 p95 不是。

同一份数据回答这两个问题，在 Prometheus 3.15 上：

```promql
# 从桶算出的全集群 p95
histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_milliseconds_bucket[2m])))
# -> 97.5

# 请求速率
sum(rate(http_server_request_duration_milliseconds_count[2m]))
# -> 0.1333

# 大家最爱问的"平均"延迟
sum(rate(http_server_request_duration_milliseconds_sum[2m]))
  / sum(rate(http_server_request_duration_milliseconds_count[2m]))
# -> 103.5
```

看最后两个数。平均延迟是 **103.5 ms**，而 p95 是 **97.5 ms**——平均值*比*95 分位还差，因为少数几个 180 ms 的请求把它拖了上去。如果只有平均值，你会得出"这个接口有点慢"的结论，而真相是"95% 的请求在 100 ms 以内，只有一小截尾巴不在"。用直方图，不要用平均值；如果非要挑一个数，就挑一个大家事先约定好的分位数。

## delta 与 cumulative：那个把计数器冻住的坑

每一条 OTel sum 和直方图都携带**聚合时间性（aggregation temporality）**。`Cumulative` 表示"这是进程启动以来的总量"，`Delta` 表示"这是自上次上报以来发生的量"。

Prometheus 是拉取式系统，它的计数器按定义就是累积的。那么一条 delta 时间性的 sum 送进 `prometheus` exporter 会怎样？我把同一批 delta（`+10`）发了四次，每次之间抓一次：

```text
after delta batch 1 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 2 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 3 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 4 -> jobs_processed_fixed_total{job="checkout-api",...} 10
```

跑完了四十个任务，计数器纹丝不动。exporter 把每个 delta 直接写进了 `_total` 序列，于是这个计数器被永久钉在一个区间的量上。对它取 `rate()` 会返回*增量*除以抓取间隔——结果看起来还挺合理，这正是这个坑难缠的地方。collector 日志确认输入确实是 delta：

```text
     -> Name: jobs.processed.fixed
     -> DataType: Sum
     -> IsMonotonic: true
     -> AggregationTemporality: Delta
```

修法是加一个 processor：`deltatocumulative` 会在 exporter 之前把 delta 累加成累积值。

```yaml
processors:
  deltatocumulative:
    max_stale: 5m
service:
  pipelines:
    metrics:
      processors: [memory_limiter, deltatocumulative, batch]
```

同样四批数据、同一个 collector，只多了一个 processor：

```text
after delta batch 1 -> jobs_processed_fixed_total{job="checkout-api",...} 10
after delta batch 2 -> jobs_processed_fixed_total{job="checkout-api",...} 20
after delta batch 3 -> jobs_processed_fixed_total{job="checkout-api",...} 30
after delta batch 4 -> jobs_processed_fixed_total{job="checkout-api",...} 40
```

为什么这在实践里会咬人？因为各语言 OTel SDK 的*默认*时间性并不一样，还取决于 exporter 类型，于是对某个服务正常的管道，可能对另一个服务静默地报错数据。两个习惯：确认你的 SDK 到底导出的是什么（debug 输出里的 `Cumulative` 就是证据），以及只要上游可能发 delta，就把 `deltatocumulative` 放进 metrics 管道。反向的 processor 叫 `cumulativetodelta`，给那些想要 delta 的 TSDB 用。

## exemplar：一条带着 `trace_id` 的指标样本

现在是回报环节。**exemplar** 是挂在直方图或计数器*单次观测*上的可选注解：观测值加上产生它的那个请求的 `trace_id` 和 `span_id`。它不参与聚合，不影响 `_count` 和 `_sum`，过了保留窗口就被丢掉。它是一个指针。

<figure>
  <svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一个携带 exemplar 的直方图桶，指向产生它的那条 trace">
    <defs>
      <marker id="exarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor">
      <line x1="30" y1="196" x2="336" y2="196" stroke="currentColor" stroke-width="1"/>
      <line x1="30" y1="196" x2="30" y2="54" stroke="currentColor" stroke-width="1"/>
      <rect x="44"  y="140" width="44" height="56"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="98"  y="140" width="44" height="56"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="152" y="168" width="44" height="28"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="206" y="168" width="44" height="28"  fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <rect x="260" y="86"  width="44" height="110" fill="#0f766e" opacity="0.20" stroke="#0f766e" stroke-width="1.5"/>
      <circle cx="282" cy="78" r="4.5" fill="#0f766e"/>
      <text x="66"  y="212" text-anchor="middle">10</text>
      <text x="120" y="212" text-anchor="middle">25</text>
      <text x="174" y="212" text-anchor="middle">50</text>
      <text x="228" y="212" text-anchor="middle">100</text>
      <text x="282" y="212" text-anchor="middle">+Inf</text>
      <text x="30" y="46">count</text>
      <text x="282" y="68" text-anchor="middle" fill="#0f766e">exemplar</text>
      <path d="M 296 78 C 350 78, 372 104, 408 112" fill="none" stroke="#0f766e" stroke-width="1.5"
            stroke-dasharray="4 3" marker-end="url(#exarrow)"/>
      <text x="410" y="62">trace_id = 4bf92f35…e4736</text>
      <rect x="410" y="100" width="272" height="24" rx="3" fill="#0f766e" opacity="0.20" stroke="#0f766e"/>
      <text x="420" y="116">GET /checkout            3.90 s</text>
      <rect x="430" y="132" width="72" height="20" rx="3" fill="currentColor" opacity="0.16" stroke="currentColor"/>
      <text x="438" y="146">db.query</text>
      <text x="410" y="178" opacity="0.75">同一个请求，以 span 的形式</text>
    </g>
  </svg>
  <figcaption>FIG. 1 — 最后一个桶带着一个 exemplar：观测值，加上产生它的那个请求的 <code>trace_id</code>。顺着这个 id 走，你就能落到那个精确的 span 上。</figcaption>
</figure>

我把 exemplar 挂在了文章开头那份 payload 里 180 ms 的那次观测上，它一路活到了抓取端点——但只在一组特定条件下成立，这些条件我是踩出来的。

**第一，exporter 必须被允许说 OpenMetrics。** 在 `enable_open_metrics: false` 下，即使客户端明确索要 OpenMetrics，拿到的也是经典格式：

```console
$ curl -s -D- -o /dev/null -H 'Accept: application/openmetrics-text; version=1.0.0' \
    http://127.0.0.1:8889/metrics | grep -i content-type
Content-Type: text/plain; version=0.0.4; charset=utf-8; escaping=underscores
```

**第二，抓取方必须协商格式。** 打开 `enable_open_metrics: true` 之后，同一个 URL 直接 `curl` 拿到的还是经典文本，主动索要才是 OpenMetrics：

```console
$ curl -s -H 'Accept: application/openmetrics-text; version=1.0.0' \
    http://127.0.0.1:8889/metrics | grep -E 'le="\+Inf"'
http_server_request_duration_milliseconds_bucket{http_route="/checkout",...,le="+Inf"} 6 1.791959284359e+09 # {trace_id="4bf92f3577b34da6a3ce929d0e0e4736",span_id="00f067aa0ba902b7"} 180.0 1.7919592843590355e+09
```

就是它：样本行后面追加了一段 exemplar 注释 `# {trace_id="…",span_id="…"} 180.0 <timestamp>`。而在 Prometheus 文本格式下，同一次抓取里一个 exemplar 都没有。**如果你的抓取格式是 `text/plain`，你就没有 exemplar，而且不会有任何报错告诉你这件事。**

**第三，得让 Prometheus 愿意存它们。** Prometheus 3.15 在没有开特性开关时，`query_exemplars` 返回空列表，直到我加上参数重启：

```console
$ docker run -d --name prom ... prom/prometheus:latest \
    --config.file=/etc/prometheus/prometheus.yml --enable-feature=exemplar-storage
```

之后 exemplar 就可以通过 API 查到了：

```console
$ curl -s --get --data-urlencode 'query=http_server_request_duration_milliseconds_bucket' \
    --data-urlencode "start=$(date -d '-10 min' +%s)" --data-urlencode "end=$(date +%s)" \
    http://127.0.0.1:19091/api/v1/query_exemplars
```

```text
series: http_server_request_duration_milliseconds_bucket le=+Inf
  exemplar: {'span_id': '00f067aa0ba902b7', 'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736'} value=180
```

现在是最能说明这个特性价值的一跳。我还把一条带同样 `trace_id` 的 span 通过 collector 的 trace 管道发给了 Jaeger，然后向 Jaeger 索要它：

```console
$ curl -s http://127.0.0.1:16686/api/traces/4bf92f3577b34da6a3ce929d0e0e4736
```

```text
traceID: 4bf92f3577b34da6a3ce929d0e0e4736
  spanID: 00f067aa0ba902b7 | op: GET /checkout | dur: 3900000 us
  service: checkout-api
  tags: {'http.request.method': 'GET', 'url.path': '/checkout',
         'http.response.status_code': 200, 'db.system': 'postgresql',
         'otel.status_code': 'OK', 'span.kind': 'server'}
```

毛刺、exemplar、span 三者对上了：`(100, +Inf]` 桶里的一次 180 ms 观测，来自一个端到端耗时 3.9 s 的请求。在真正的 UI 里这就是一次点击：悬停毛刺、点 exemplar、落到 trace 上。指标告诉你*有*和*有多少*；exemplar 告诉你*是哪一个*。

两个前提要说清楚。exemplar 只在 trace 存在时才存在——如果还没搭过 tracing，[从那里开始](/zh/posts/opentelemetry-tracing/)。另外它是逐次观测的，所以需要一个*分布*才有意思；计数器也能带，但"第 137 个请求"远不如"那个 180 ms 的请求"有用。

## collector 在这套东西里干了什么

管道模型我写在[别处](/zh/posts/opentelemetry-collector-pipelines/)了，这里只说和指标相关的部分：

**`prometheus` receiver** —— 把现有的 Prometheus 端点拉进 OTel。我把它指向 Prometheus 自己的 `/metrics`，一次抓取就吃进来 **518 条序列**；暴露格式里能看出出处：

```text
prometheus_build_info{branch="HEAD",goarch="amd64",...,instance="prom:9090",job="prometheus-itself",
  otel_scope_name="github.com/open-telemetry/opentelemetry-collector-contrib/receiver/prometheusreceiver",...} 1
```

这就是迁移路径：把 receiver 指向你现有的 exporter，然后让所有东西走同一条管道。

**`prometheus` exporter 与 `prometheusremotewrite`** —— 前者是我这里用的拉取路径：数据放在 collector 里，Prometheus 来抓。`prometheusremotewrite` 是推送路径，给那些不做抓取的后端用（Mimir、Thanos、VictoriaMetrics，或者托管 Prometheus）。规模上去之后推送才是该走的路，但本文没有测试 exemplar 走 remote write——能不能活下来取决于协议版本和后端，用之前请自己验证。

**`memory_limiter` 和 `batch`** —— 指标是成批涌进来的，collector 会开开心心把自己缓冲到死。每条管道里 `memory_limiter` 放最前面，`batch` 放它后面。这是 collector OOM 最常见的成因。

**基数控制。** 我发了一个计数器，五个数据点各自带一个不同的 `user.id`：

```text
cache_misses_total{...,user_id="u0"} 1
cache_misses_total{...,user_id="u1"} 1
cache_misses_total{...,user_id="u2"} 1
cache_misses_total{...,user_id="u3"} 1
cache_misses_total{...,user_id="u4"} 1
```

五个请求就是五条序列。放到真实流量下这是无界的——每个用户、每个端点、每个状态码一条。`transform` processor 可以在到达后端之前把这个标签剥掉：

```yaml
processors:
  transform:
    metric_statements:
      - context: datapoint
        statements:
          - delete_key(attributes, "user.id")
```

```text
cache_misses_total{job="api",...} 5
```

五条序列变成一条。但要老实说清刚才发生了什么：留下来的值是**那五个数据点里的某一个（最后一个），不是它们的和**。`delete_key` 合并的是*身份*，不做聚合。我把值设成 1 到 5 时，活下来的序列显示的是 `5`，不是 `15`。如果你要的是求和，请在 SDK 层（metric *view*）就把标签去掉，或者显式地做聚合——别指望 collector 替你算了算术。

## 我实际会怎么做

- **只埋 RED，别什么都埋。** 每个服务：**R**ate、**E**rrors、**D**uration——请求数用 counter、错误数用 counter、耗时用直方图。每台主机：**U**tilization、**S**aturation、**E**rrors。这些足以回答绝大多数故障；另外两百条指标大多只是在花钱。
- **用直方图，不用平均值，也不用 summary。** 长尾分布的平均值谁也描述不了（上面 103.5 ms 对 97.5 ms）。summary 又无法跨实例聚合。
- **假定 delta 时间性一定会找上你。** 看清 debug 输出，把 `deltatocumulative` 放进管道。它的失败形态是计数器冻住，而不是报错。
- **基数是预算。** `user.id`、`request.id`、原始 `url.path`、任何长得像 UUID 的东西都不该做标签。用 `transform` 集中剥离。
- **exemplar 是这里最便宜的一笔收益。** 三件事必须同时对上（exporter 开 OpenMetrics、抓取协商 OpenMetrics、Prometheus 开 exemplar storage），一旦对上，每一个延迟毛刺都变得可点击。如果 trace 已经在跑了，就把它们打开。

指标是告诉你"往哪看"的那根柱子；exemplar 让"往哪看"从一个搜索动作变成一个链接。
