---
title: "Prometheus 记录规则与联邦：把频繁查询提前算好"
description: "记录规则按固定间隔预计算 PromQL 并存储为新指标；联邦通过 /federate 从多个本地 Prometheus 拉取聚合序列。使用 promtool、/api/v1/rules 和 /federate 的实时输出演示。"
pubDate: 2027-02-01
lang: zh
translationKey: prometheus-recording-rules
tags: [devops, self-hosting]
featured: false
keywords:
  - Prometheus 记录规则
  - rule_files
  - Prometheus 联邦
  - promtool
  - PromQL
---

如果你运行 Prometheus 有一段时间，一定遇到过这样的痛点：一个仪表盘有六个面板，每个都在跑 `avg_over_time(...[5m])` 或 `histogram_quantile(...)`，每次刷新都在锤击查询引擎。记录规则（recording rule）就是解决方案——一个由 Prometheus 按固定间隔求值并存储为全新指标的 PromQL 表达式。仪表盘查询预计算指标，几乎零成本。

本文展示记录规则和联邦在真实 Prometheus 上协同工作的完整过程，包含 `promtool`、HTTP API 和 `/federate` 端点的真实输出。它建立在 [Prometheus 实践](/zh/posts/prometheus-in-practice/) 和 [Alertmanager 实践](/zh/posts/alertmanager-in-practice/) 两篇文章之上——如果你是 Prometheus 新手，建议先读这两篇。

## 问题：仪表盘反复运行同一个昂贵查询

一个典型的仪表盘面板可能运行：

```promql
1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))
```

这个表达式在每次面板刷新时都要扫描五分钟的原始样本。一个仪表盘十个面板，成本乘以十，而且每三十秒重复一次。查询引擎反复做同样的工作，产出相同的数字（在评估间隔内）。

记录规则翻转了模型：计算一次，存储结果，之后随意查询存储结果。

<figure>
<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="记录规则流程图">
  <defs>
    <marker id="arrow-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <style>
    .box-zh { fill: none; stroke: currentColor; stroke-width: 1.5; rx: 4; }
    .label-zh { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: currentColor; }
    .small-zh { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; fill: currentColor; opacity: 0.7; }
    .expensive-zh { color: #b91c1c; }
    .cheap-zh { color: #0f766e; }
    .neutral-zh { color: #374151; }
  </style>
  <!-- 昂贵路径 -->
  <text x="10" y="20" class="label-zh expensive-zh">无记录规则</text>
  <rect x="10" y="30" width="160" height="50" class="box-zh expensive-zh"/>
  <text x="20" y="50" class="label-zh expensive-zh">仪表盘刷新</text>
  <text x="20" y="65" class="small-zh expensive-zh">立即执行 PromQL</text>
  <line x1="170" y1="55" x2="200" y2="55" stroke="currentColor" class="expensive-zh" marker-end="url(#arrow-zh)"/>
  <rect x="200" y="30" width="180" height="50" class="box-zh expensive-zh"/>
  <text x="210" y="50" class="label-zh expensive-zh">昂贵 PromQL</text>
  <text x="210" y="65" class="small-zh expensive-zh">avg_over_time[5m] 扫描</text>
  <line x1="380" y1="55" x2="410" y2="55" stroke="currentColor" class="expensive-zh" marker-end="url(#arrow-zh)"/>
  <rect x="410" y="30" width="100" height="50" class="box-zh expensive-zh"/>
  <text x="420" y="50" class="label-zh expensive-zh">慢</text>
  <text x="420" y="65" class="small-zh expensive-zh">重复开销</text>
  <!-- 记录规则路径 -->
  <text x="10" y="110" class="label-zh cheap-zh">有记录规则</text>
  <rect x="10" y="120" width="160" height="50" class="box-zh neutral-zh"/>
  <text x="20" y="140" class="label-zh neutral-zh">记录规则</text>
  <text x="20" y="155" class="small-zh neutral-zh">每 30s 执行</text>
  <line x1="170" y1="145" x2="200" y2="145" stroke="currentColor" class="cheap-zh" marker-end="url(#arrow-zh)"/>
  <rect x="200" y="120" width="180" height="50" class="box-zh cheap-zh"/>
  <text x="210" y="140" class="label-zh cheap-zh">预计算指标</text>
  <text x="210" y="155" class="small-zh cheap-zh">写入 TSDB</text>
  <line x1="380" y1="145" x2="410" y2="145" stroke="currentColor" class="cheap-zh" marker-end="url(#arrow-zh)"/>
  <rect x="410" y="120" width="100" height="50" class="box-zh cheap-zh"/>
  <text x="420" y="140" class="label-zh cheap-zh">廉价查询</text>
  <text x="420" y="155" class="small-zh cheap-zh">即时读取</text>
</svg>
<figcaption>图 1 — 记录规则按间隔预计算昂贵表达式；仪表盘查询存储结果，而非反复扫描原始样本。</figcaption>
</figure>

## 记录规则是什么

记录规则是一个 PromQL 表达式，由 Prometheus 按固定间隔求值（默认取全局配置中的 `evaluation_interval`）。结果以你指定的新指标名写回 TSDB。从那时起，新指标的行为和其他指标一样：可以查询、告警、绘图、联邦。

语法存放在独立的 YAML 文件中，由主配置的 `rule_files` 引用：

```yaml
groups:
  - name: node_recording
    interval: 30s
    rules:
      - record: job:node_memory_usage:ratio5m
        expr: |
          1 - (
            avg_over_time(node_memory_MemAvailable_bytes[5m])
            /
            avg_over_time(node_memory_MemTotal_bytes[5m])
          )
```

三个关键字段：

- **`groups`** — 规则组列表。每组有名称、可选的 `interval`（覆盖该组的全局评估间隔）和 `rules` 列表。
- **`record`** — 将创建的新指标的名称。这就是你之后查询的名字。
- **`expr`** — 要计算的 PromQL 表达式。结果作为新时间序列以 `record` 的名称存储。

你还可以给规则附加 **`labels`**，这会给它产出的每个序列添加静态标签。

## 实测：从记录规则到联邦的完整流程

我运行了一个临时 Prometheus，使用 node-exporter 作为抓取目标，配了一条记录规则。以下是完整设置和每一步的真实输出。

### 规则文件

完整的 `recording.yml`：

```yaml
groups:
  - name: node_recording
    interval: 30s
    rules:
      - record: job:node_memory_usage:ratio5m
        expr: |
          1 - (
            avg_over_time(node_memory_MemAvailable_bytes[5m])
            /
            avg_over_time(node_memory_MemTotal_bytes[5m])
          )
```

主配置引用它：

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "recording.yml"

scrape_configs:
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
```

### promtool check rules

在重新加载 Prometheus 之前，用 `promtool` 验证文件：

```console
$ promtool check rules recording.yml
Checking recording.yml
  SUCCESS: 1 rules found
```

`promtool` 解析 YAML、检查 PromQL 语法、确认规则结构。它能在运行时错误之前捕获指标名拼写错误、表达式格式错误和无效的间隔格式。

### 新指标出现

Prometheus 加载规则文件且 `interval`（30s）过去后，规则开始产出数据。查询规则 API 查看健康状态：

```json
{
  "status": "success",
  "data": {
    "groups": [
      {
        "name": "node_recording",
        "file": "/etc/prometheus/recording.yml",
        "rules": [
          {
            "name": "job:node_memory_usage:ratio5m",
            "query": "1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))",
            "labels": {},
            "health": "ok",
            "evaluationTime": 0.000227469,
            "lastEvaluation": "2026-10-14T03:24:51.571453842Z",
            "type": "recording"
          }
        ],
        "interval": 30,
        "limit": 0,
        "evaluationTime": 0.000255283,
        "lastEvaluation": "2026-10-14T03:24:51.571430076Z"
      }
    ]
  }
}
```

关键字段：

- **`health: "ok"`** — 规则上次运行求值成功。
- **`evaluationTime: 0.000227469`** — 求值耗时（这个简单表达式亚毫秒级）。
- **`lastEvaluation`** — 最近一次求值的时间戳。
- **`type: "recording"`** — 区分记录规则和告警规则。

现在直接查询新指标：

```console
$ curl -s 'http://localhost:9090/api/v1/query' \
    --data-urlencode 'query=job:node_memory_usage:ratio5m'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "job:node_memory_usage:ratio5m",
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948311.687, "0.7272438878982002"]
      }
    ]
  }
}
```

指标 `job:node_memory_usage:ratio5m` 现在存在于 TSDB 中。它带有源序列的 `instance` 和 `job` 标签，以及表达式计算的值。仪表盘面板可以查询这个指标并获得即时结果。

### 它所替代的昂贵查询

作为对比，原始 PromQL 表达式（没有记录规则时仪表盘会运行的查询）：

```console
$ curl -s 'http://localhost:9090/api/v1/query' \
    --data-urlencode 'query=1 - (avg_over_time(node_memory_MemAvailable_bytes[5m]) / avg_over_time(node_memory_MemTotal_bytes[5m]))'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948322.370, "0.7255751954730405"]
      }
    ]
  }
}
```

相同的值（在评估间隔内），但查询引擎必须扫描五分钟的原始样本才能计算。使用记录规则后，这种扫描每三十秒只发生一次；每次仪表盘刷新只读取一个预计算点。

复杂度越高，差距越大。`histogram_quantile` 套 `rate()` 加上大量标签组合，或跨数百个序列的 `sum()`，每次求值可能需要数百毫秒。预计算一次，仪表盘成本就降为简单查询。

## 命名约定：level:metric:operations

Prometheus 对记录规则名称有约定：**`level:metric:operations`**。

- **`level`** — 聚合层级：`job`、`instance`、`service`、`cluster` 等。
- **`metric`** — 基础指标名，通常与源指标匹配。
- **`operations`** — 所应用的操作，按顺序：`rate5m`、`sum`、`avg` 等。

示例：

| 名称 | 含义 |
|------|------|
| `job:node_memory_usage:ratio5m` | 每 job 内存使用率，5m 平均 |
| `instance:node_cpu_usage:ratio5m` | 每实例 CPU 使用率，5m 平均 |
| `job:node_disk_used:ratio1h` | 每 job 磁盘使用率，1h 平均 |
| `service:http_requests:rate5m` | 每服务 HTTP 请求速率，5m 窗口 |

这个约定让指标的含义和聚合层级一目了然，同时也防止冲突：两个在不同层级计算相同内容的规则获得不同名称。

## 联邦：从多个本地实例获得全局视图

联邦允许"全局"Prometheus 通过 `/federate` 端点从一个或多个"本地"Prometheus 拉取选定的指标。全局实例抓取本地实例、存储数据、为仪表盘和告警提供统一查询接口。

全局配置：

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'federate-local'
    honor_labels: true
    metrics_path: '/federate'
    params:
      'match[]':
        - '{job="node"}'
    static_configs:
      - targets: ['prom-local:9090']
```

`params` 块选择要拉取哪些指标。这里 `{job="node"}` 拉取所有带 `job="node"` 的序列——包括记录规则的输出，因为记录规则继承源序列的标签。

### /federate 端点

直接查询本地 Prometheus 看联邦会拉取什么：

```console
$ curl -s 'http://localhost:9090/federate?match[]=%7Bjob%3D%22node%22%7D'
```

输出是 Prometheus 文本格式。在联邦序列中包含记录规则指标：

```
# TYPE job:node_memory_usage:ratio5m untyped
job:node_memory_usage:ratio5m{instance="localhost:9100",job="node"} 0.7272438878982002 1791948291570
```

记录规则的输出像其他指标一样被联邦。全局 Prometheus 存储它并使其可查询。

### 查询联邦数据

在全局 Prometheus 上，记录规则指标可用：

```console
$ curl -s 'http://localhost:9091/api/v1/query' \
    --data-urlencode 'query=job:node_memory_usage:ratio5m'
```

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "job:node_memory_usage:ratio5m",
          "instance": "localhost:9100",
          "job": "node"
        },
        "value": [1791948311.705, "0.7272438878982002"]
      }
    ]
  }
}
```

值与本地 Prometheus 匹配（在联邦抓取间隔内）。指向全局实例的仪表盘可以看到预计算指标，无需接触本地 Prometheus。

### 联邦的适用场景（和不适用场景）

联邦适用于：

- 你有**多个 Prometheus 实例**（按集群、按区域、按租户），需要**统一查询接口**用于跨切面仪表盘或告警。
- 你想将本地指标的**子集**（不是全部）聚合到中央视图。
- 你需要一个**简单的、基于拉取**的拓扑，不依赖外部组件。

联邦**不是**长期存储。它不进行去重、压缩，也不保留超出全局实例自身保留期的数据。对于长期存储、全局跨 fleet 查询能力或高可用性，请使用专用系统：

- **Thanos** — sidecar + 存储网关 + 查询层，支持对象存储。
- **Mimir**（原 Cortex）— 多租户、水平可扩展、对象存储后端。
- **VictoriaMetrics** — 单二进制或集群，高效压缩，Prometheus 兼容。

联邦是轻量聚合层，不是真正的长期存储替代品。

## 基数成本

每条记录规则都会创建新的时间序列。输出的基数取决于源序列的标签和表达式：

- 聚合掉标签的规则（如 `sum(...) by (job)`）产生的序列比源**少**。
- 保留所有标签的规则（如不带聚合的 `avg_over_time(...[5m])`）产生与源**相同数量**的序列。
- 添加标签的规则（通过 `labels:`）可能产生**更多**序列。

成本在存储和内存。每个新序列消耗 TSDB 块，并在内存中保存近期数据。一条在繁忙 Prometheus 上创建一万条新序列的规则，就是一万条额外的序列要存储、压缩和查询。

添加规则前，先问：有多少源序列匹配这个表达式？如果答案是"成千上万"，这个规则将创建成千上万条新序列。确保收益（更快的仪表盘、更稳定的告警）值得这个成本。

## 你是否需要它？

对于单个小型 Prometheus——一个实例、少量目标、几个仪表盘——**可能不需要**。查询引擎对简单表达式足够快，而管理规则文件、用 `promtool` 验证、监控规则健康的运维复杂度不值得。

记录规则值得投入的场景：

- **仪表盘慢**——面板在每次刷新时重新运行昂贵 PromQL。
- **告警需要稳定序列**——记录规则确保告警表达式查询预计算指标，而非在评估时行为可能不同的原始表达式。
- **多个消费者**（仪表盘、告警、其他规则）需要相同计算——计算一次，处处使用。
- **联邦**——记录规则让你在本地层级预计算，联邦结果，减轻全局实例负载。

从一条针对最贵仪表盘查询的规则开始。衡量改善。只有在收益明确时才添加更多。

## 结论

记录规则是 Prometheus 对"别反复算同一件事"的回答。你写一个 PromQL 表达式，Prometheus 按间隔求值，结果成为新指标——查询、告警、联邦都很廉价。联邦让你从多个本地实例拉取这些预计算指标到单一全局视图。

工具很简单：`rule_files` 中的 YAML 文件、`promtool check rules` 验证、`/api/v1/rules` 查看健康、`/federate` 聚合。纪律在于命名（`level:metric:operations`）和基数意识（每条新规则都创建新序列）。

对单个小型 Prometheus，记录规则是可选的。对 fleet 来说，它们是不可或缺的。
