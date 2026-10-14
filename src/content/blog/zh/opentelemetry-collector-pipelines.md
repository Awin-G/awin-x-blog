---
title: "OpenTelemetry Collector：应用与后端之间的管道"
description: "OpenTelemetry Collector 如何通过 receivers、processors、exporters 将应用与后端解耦——附真实 OTLP 容器输出。"
pubDate: 2027-02-03
lang: zh
translationKey: opentelemetry-collector-pipelines
tags: [devops, self-hosting]
featured: false
keywords:
  - OpenTelemetry Collector
  - OTLP
  - collector pipeline
  - receivers processors exporters
  - tail sampling
---

如果你读过我关于 [OpenTelemetry 链路追踪](/zh/posts/opentelemetry-tracing/) 的文章，你已经知道如何给应用埋点产生 span。但这些 span 得送到*某个地方*。那个"地方"通常不是你的应用代码——而是一个独立的基础设施组件：**OpenTelemetry Collector**。这篇文章讲 Collector 做什么、管道模型怎么工作、以及你什么时候真正需要它。

## 为什么需要 Collector

没有 Collector 时，每个应用都得知道怎么跟每个后端通信：Jaeger 的 API、Prometheus 的 remote-write、Loki 的 push 接口、Honeycomb 的 key、Datadog 的 agent。换后端就意味着重新给每个服务埋点。这是供应商锁定的噩梦。

Collector 反转了这个关系。你的应用只说 **OTLP**（OpenTelemetry 协议）——一个协议、一次 SDK 调用——Collector 负责翻译成你今天用的任何后端。从 Jaeger 换到 Tempo？改一个配置文件，重新部署一个二进制，应用零改动。

两种部署模式：

- **Agent（代理）模式**：每台主机跑一个 Collector，收集本地应用数据。类似本地 syslog 守护进程。
- **Gateway（网关）模式**：中心化 Collector 集群接收所有 Agent 的 OTLP 数据，统一做重处理（tail sampling、 enrichment）。

对于跑几个服务的自部署场景，每台机器上的 Agent 模式就够了。

## 管道模型：Receivers → Processors → Exporters

Collector 的配置由三种组件类型通过命名管道连接而成：

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, attributes]
      exporters: [debug]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, batch]
      exporters: [debug]
```

每种信号类型（traces、metrics、logs）有自己的管道。Receiver 接收数据，Processor 转换数据，Exporter 输出数据。组件按名称引用——同一个 `otlp` receiver 可以同时喂给 traces 和 metrics 管道。

<figure>
  <svg viewBox="0 0 720 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Collector pipeline diagram">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
      </marker>
    </defs>
    <g font-family="ui-monospace, monospace" font-size="12">
      <!-- Receivers -->
      <rect x="20" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="80" y="85" text-anchor="middle" fill="currentColor">Receivers</text>
      <text x="80" y="103" text-anchor="middle" fill="#0f766e" font-size="10">otlp · prometheus</text>
      <!-- Arrow 1 -->
      <line x1="140" y1="90" x2="180" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
      <!-- Processors -->
      <rect x="180" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="240" y="85" text-anchor="middle" fill="currentColor">Processors</text>
      <text x="240" y="103" text-anchor="middle" fill="#0f766e" font-size="10">batch · attributes</text>
      <!-- Arrow 2 -->
      <line x1="300" y1="90" x2="340" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"/>
      <!-- Exporters -->
      <rect x="340" y="60" width="120" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="400" y="85" text-anchor="middle" fill="currentColor">Exporters</text>
      <text x="400" y="103" text-anchor="middle" fill="#0f766e" font-size="10">otlp · debug · loki</text>
      <!-- Signal labels -->
      <text x="80" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">OTLP/gRPC</text>
      <text x="240" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">memory_limiter</text>
      <text x="400" y="40" text-anchor="middle" fill="currentColor" font-size="11" opacity="0.7">backend</text>
    </g>
  </svg>
  <figcaption>FIG. 1 — Traces 管道：OTLP 输入，处理后输出到后端。</figcaption>
</figure>

## Receivers：数据入口

Receiver 监听传入的遥测数据。实际会用到的两个：

- **`otlp`** — 通过 gRPC（端口 4317）和 HTTP（端口 4318）接收 OTLP。你的埋点应用发送的就是这个协议。支持 protobuf 和 JSON 编码。
- **`prometheus`** — 抓取 Prometheus 格式的端点。适合已有的 exporter，不需要重写。

这是我测试容器中的 receiver 配置：

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      scrape_configs:
        - job_name: 'otel-collector'
          scrape_interval: 5s
          static_configs:
            - targets: ['127.0.0.1:8888']
```

我通过 OTLP/HTTP JSON 发送了一条真实的 trace：

```bash
curl -s -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d @trace.json
# Response: {"partialSuccess":{}}
```

## Processors：数据转换

Processor 位于 receiver 和 exporter 之间。真正重要的几个：

### memory_limiter

在其他 processor 之前检查内存使用。接近上限时丢弃数据而不是让 Collector 被 OOM Kill。始终放在第一位：

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 100
    spike_limit_mib: 20
```

Collector 启动时打印了日志：

```
2026-10-14T04:31:49.205Z  info  memorylimiter@v0.162.0/memorylimiter.go:109
  Memory limiter configured  {"limit_mib": 100, "spike_limit_mib": 20, "check_interval": 1}
```

### batch

缓冲遥测数据后批量发送，而不是每个 span 发一次请求。大幅降低 CPU 和网络开销：

```yaml
processors:
  batch:
    send_batch_size: 512
    timeout: 5s
```

在 Collector 自身指标中可以看到 batch processor 的工作情况：

```
otelcol_processor_batch_batch_send_size_count{processor="batch"} 7
otelcol_processor_batch_batch_send_size_sum{proprocessor="batch"} 141
```

### attributes

在遥测数据上插入、更新或删除属性。我用它给每个 span 打上环境标签：

```yaml
processors:
  attributes:
    actions:
      - key: environment
        value: dev
        action: insert
      - key: dropped_field
        action: delete
```

debug exporter 打印的 span 中包含 `environment: dev`——证明 processor 确实运行了：

```
Span #0
    Name           : test-operation
    ...
Attributes:
     -> http.method: Str(GET)
     -> http.status_code: Int(200)
     -> environment: Str(dev)
```

### filter

丢弃匹配条件的遥测数据。我用它排除了 Collector 自身的 uptime 和 CPU 指标：

```yaml
processors:
  filter/metrics:
    metrics:
      exclude:
        match_type: strict
        metric_names:
          - otelcol_process_uptime
          - otelcol_process_cpu_seconds
```

filter processor 记录了配置日志，debug 输出确认那两个指标被丢弃了——`otelcol_process_memory_rss` 和 `scrape_samples_scraped` 还在，但排除的两个不见了。

### tail_sampling

最复杂的 processor。它等一条 trace *完整结束后*再决定是否保留。这样你可以 100% 保留错误和慢请求，只对常规流量采样 1%：

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 10000
    policies:
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: sample-1-percent
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
```

对自部署场景来说，`tail_sampling` 可能过度了——但它解决了"如何对感兴趣的请求保留完整 trace 而不被数据淹没"的问题。

## Exporters：数据出口

Exporter 把遥测数据发到后端。值得了解的几个：

- **`otlp`** — 转发 OTLP 到另一个 Collector 或直接到支持 OTLP 的后端（Tempo、带 OTLP 支持的 Jaeger）。
- **`debug`** — 把遥测数据打印到 Collector 日志。调试时很有用，生产环境无用。
- **`prometheusremotewrite`** — 推送指标到 Prometheus 兼容后端（Mimir、Cortex、VictoriaMetrics）。
- **`loki`** — 推送日志到 Loki。

典型的自部署配置：

```yaml
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: http://victoria:8428/api/v1/write
```

## Collector 自身指标

Collector 在 `:8888/metrics` 暴露 Prometheus 格式指标——接收了多少 span、处理了多少、发送了多少，以及自身的内存和 CPU 使用：

```
otelcol_receiver_accepted_spans{receiver="otlp",transport="http"} 1
otelcol_exporter_sent_spans{exporter="debug"} 1
otelcol_process_memory_rss 2.1272576e+08
otelcol_process_uptime 54.007314091
```

这些指标告诉你 Collector 是否健康、是否积压、是否丢数据。我的配置里 Prometheus receiver 每 5 秒抓取一次这个端点——Collector 监控自己。

## Agent 还是 Gateway

**Agent 模式**在每台主机运行一个 Collector，通常作为 sidecar 或 systemd 服务。简单直接：本机应用发 OTLP 到本地，Agent 转发到后端。我推荐自部署用这种模式。

**Gateway 模式**运行中心化集群。Agent 转发 OTLP 到网关，由网关做重处理（tail sampling、一致性哈希路由）。当你有几十个服务、想集中决策时才需要。

一台服务器加几个容器？那台服务器上跑一个 Agent 模式就够了。完事。

## 配置验证

Collector 在启动时和 `--config ... validate` 时验证配置。配置有问题会快速失败：

```bash
$ otelcol-contrib --config bad-config.yaml validate
Error: service::pipelines::traces: references processor "memory_limiter" which is not configured
Exited with code 1
```

部署配置变更前务必先验证。

## 实在的建议

Collector 很强大，但它是*另一个要运行的东西*。如果你只有一个应用和一个后端，可以完全跳过它——SDK 直接指向后端。如果你有多个应用、想以后换后端、或者需要 tail sampling，Collector 立刻就回本。

自部署建议：每台主机跑一个 Agent，配置 `memory_limiter` → `batch` → 你的 exporter。就这样。你获得协议解耦、批量发送、以及换后端时不用改应用代码的灵活性。这就是全部意义。

我的 [结构化日志](/zh/posts/structured-logging/) 配置可以通过同一个 Collector 发送日志——一个 traces 管道、一个 metrics 管道、一个 logs 管道，全在一个 YAML 文件里配置。一个进程，三种信号，换后端时应用零改动。

Collector 不让遥测数据变得*好*——它让数据变得*可移植*。质量取决于你怎么埋点，那部分我在 [OpenTelemetry 链路追踪](/zh/posts/opentelemetry-tracing/) 里讲了。但没有 Collector，你的遥测数据就被锁死在第一天选的后端上。有了它，你明天就能换主意，代价只是一个配置文件。
