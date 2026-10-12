---
title: "用 Grafana Loki 做日志聚合：便宜的日志，真实的查询"
description: "Grafana Loki 只索引标签而不索引全文，这正是日志聚合能便宜下来的原因。一次真实的 Loki 3.4 实操：推送日志行、LogQL 流选择器、行过滤器、rate() 指标查询，以及标签基数这个坑。"
pubDate: 2027-01-10
lang: zh
translationKey: loki-log-aggregation
tags: [devops, self-hosting]
featured: false
keywords:
  - Grafana Loki
  - LogQL
  - 日志聚合
  - 标签基数
  - Promtail
---

日志是你采过最便宜的遥测数据——直到你试着把它存上一周。一个繁忙的服务一天就能写
好几个 GB；一旦把十几个服务集中到一起，存储账单就不再是好笑的事了。**Grafana Loki**
跟 Elastic 那套走的是另一条路：它索引的是*标签*，不是日志行。正是这一个决定，让
**日志聚合**在自建预算里重新变成可能，而这篇就是对它的一次动手走查——真实的
Loki 3.4.1、真实的推送、真实的 **LogQL** 输出。

## 日志为什么会变贵，以及 Loki 的不同之处

传统的**日志聚合**方案（ELK、Splunk）本质上是一个搜索引擎。每一行日志都被解析、
切词，写进一个倒排索引，而这个索引经常和被它指向的原文一样大、甚至更大。你在写入
时为它付一次钱（CPU、内存、磁盘），查询时再付一次。

Loki 把这个取舍对调过来。它把日志行写进廉价存储上的压缩 **chunk**（本地磁盘、S3、
GCS），只为**标签**建索引，也就是描述「这一行从哪来」的那几个键值对（`job`、
`service`、`level`）。日志行本身从不进索引：你先按标签选中流，再用子串或正则去过滤
行。这跟 Prometheus 是同一套哲学，只是对象换成了日志。如果你读过[我那篇
Prometheus 实战](/zh/posts/prometheus-in-practice/)，心智模型可以直接搬过来——一条流
就是一个 series，LogQL 就是 PromQL 外挂一个行过滤器。对「哪个服务在十分钟前开始报
错、报了多少次」这类问题，它是我知道的最便宜的正确答案。

## 架构：agent 推送、Loki 存 chunk、Grafana 查询

数据路径只有三部分：

1. **Agent**（Promtail、Fluent Bit、Grafana Alloy）tail 日志文件、打上标签，推送到
   `/loki/api/v1/push`。
2. **Loki** 去重、把日志行压成 chunk、写标签索引，两者一起落到配置好的后端上。
3. **Grafana** 用 LogQL 查 Loki，渲染日志面板或指标图。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 250" width="720" height="250" role="img" aria-label="Promtail 等 agent 通过 POST /loki/api/v1/push 把带标签的日志流推给 Loki。Loki 在对象存储上保存 gzip 压缩后的日志行 chunk，外加一个只把标签集合映射到流的很小索引。Grafana 用 LogQL 查询这些数据，渲染日志面板和指标图。">
  <defs>
    <marker id="loki-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <style>
    .box  { fill: none; stroke: currentColor; stroke-width: 2; }
    .t    { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
    .s    { font-family: system-ui, sans-serif; font-size: 11px; fill: currentColor; opacity: 0.75; }
    .b    { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; font-weight: bold; }
    .teal { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    .arrow{ stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#loki-arrow); }
    .inner{ fill: none; stroke: currentColor; stroke-width: 1.5; opacity: 0.6; }
  </style>
  <rect class="box" x="16" y="80" width="150" height="84" rx="8"/>
  <text class="b" x="91" y="112" text-anchor="middle">Promtail</text>
  <text class="s" x="91" y="132" text-anchor="middle">tail /var/log</text>
  <text class="s" x="91" y="148" text-anchor="middle">打上标签</text>
  <path class="arrow" d="M166 122 L212 122"/>
  <text class="teal" x="189" y="112" text-anchor="middle">推送</text>
  <rect class="box" x="214" y="32" width="260" height="180" rx="8"/>
  <text class="b" x="344" y="60" text-anchor="middle" font-size="15">Loki</text>
  <text class="s" x="344" y="78" text-anchor="middle">POST /loki/api/v1/push</text>
  <rect class="inner" x="230" y="92" width="110" height="66" rx="4"/>
  <text class="t" x="285" y="116" text-anchor="middle" font-weight="bold">chunk</text>
  <text class="s" x="285" y="133" text-anchor="middle">gzip 压缩的日志行</text>
  <text class="s" x="285" y="149" text-anchor="middle">落在对象存储</text>
  <rect class="inner" x="352" y="92" width="110" height="66" rx="4"/>
  <text class="t" x="407" y="116" text-anchor="middle" font-weight="bold">标签索引</text>
  <text class="s" x="407" y="133" text-anchor="middle">job · service</text>
  <text class="s" x="407" y="149" text-anchor="middle">level → 流</text>
  <text class="s" x="344" y="178" text-anchor="middle">高基数字段留在日志行里</text>
  <path class="arrow" d="M474 122 L520 122"/>
  <text class="teal" x="497" y="112" text-anchor="middle">LogQL</text>
  <rect class="box" x="522" y="80" width="150" height="84" rx="8"/>
  <text class="b" x="597" y="112" text-anchor="middle">Grafana</text>
  <text class="s" x="597" y="132" text-anchor="middle">日志面板</text>
  <text class="s" x="597" y="148" text-anchor="middle">指标面板</text>
  <text class="teal" x="360" y="238" text-anchor="middle">索引里只有标签——从来没有日志行本身</text>
</svg>
<figcaption>agent 把带标签的流推给 Loki，Loki 存下压缩 chunk 和一个很小的标签索引。Grafana 用 LogQL 把两者读回来，所以同一份数据既可以是日志面板，也可以是一张图。</figcaption>
</figure>

打标签是 agent 干的活，Loki 接近一个哑存储，所有智能都在查询语言里。这个切分就是
Loki 只是一个二进制、没有任何外部依赖（没有 ZooKeeper、没有 Elasticsearch 集群）的
原因。

## 跑一个真实的 Loki：配置、真实推送、标签索引

我用 Docker 跑了一个一次性的 Loki 3.4.1（单体、文件系统存储、只听 `127.0.0.1`、无认
证）。下面所有输出都来自一个数据目录为空的全新实例。这就是全部配置，没有别的：

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki-data
  storage:
    filesystem:
      chunks_directory: /loki-data/chunks
      rules_directory: /loki-data/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  allow_structured_metadata: true
  retention_period: 168h

compactor:
  working_directory: /loki-data/compactor
  retention_enabled: true
  delete_request_store: filesystem
```

### 推送日志行

推送接口就是普通 JSON——一个标签集合一条流，每条日志一个 `[时间戳, 行]` 二元组：

```bash
$ curl -sS -X POST http://127.0.0.1:3100/loki/api/v1/push \
    -H "Content-Type: application/json" \
    -d '{"streams":[{"stream":{"job":"blog-demo","level":"info","service":"api"},
        "values":[["1791841400000000000","GET /posts/loki-log-aggregation 200 12ms"]]}]}' \
    -w "HTTP %{http_code}\n"
HTTP 204
```

`HTTP 204`，空响应体。写完即忘——Loki 确认的是一批，不是每一行。

### 标签索引里到底存了什么

```bash
$ curl -s http://127.0.0.1:3100/loki/api/v1/labels
{"status":"success","data":["job","level","service","service_name"]}

$ curl -s http://127.0.0.1:3100/loki/api/v1/label/level/values
{"status":"success","data":["error","info"]}

$ curl -s -G http://127.0.0.1:3100/loki/api/v1/series \
    --data-urlencode 'match[]={job="blog-demo"}'
{"status":"success","data":[
  {"job":"blog-demo","level":"info","service":"nginx","service_name":"nginx"},
  {"job":"blog-demo","level":"error","service":"api","service_name":"api"},
  {"job":"blog-demo","level":"info","service":"api","service_name":"api"}]}
```

七个日志行，四个标签*名字*——整个索引就这些。其中三个是我自己给的（`job`、`level`、
`service`），`service_name` 是 Loki 3.x 默认的 `discover_service_name` 自动注入的。
查询结果里还会多出一个 `detected_level`（来自 `discover_log_levels: true`），但它不会
出现在 `/labels` 里。每一个唯一的标签组合就是一条**流**，而流是存储的单位：一个 chunk、
一条索引项。上面三组标签，三条流，七行日志。

## LogQL：流选择器、行过滤器、指标查询

LogQL 有三层，从左到右拼起来：花括号里的**流选择器**、竖线后面的**行过滤器**，以及
可选地包在整个表达式外面的**指标查询**。

### 流选择器

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query={job="blog-demo"}' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" \
    --data-urlencode 'limit=4' | python3 -m json.tool
```

```json
{
  "resultType": "streams",
  "result": [
    {
      "stream": {
        "detected_level": "error",
        "job": "blog-demo",
        "level": "error",
        "service": "api",
        "service_name": "api"
      },
      "values": [
        ["1791841405000000000", "ERROR upstream 502 bad gateway from 10.0.0.5:8080"],
        ["1791841404000000000", "ERROR database connection refused: timeout after 30s"]
      ]
    },
    {
      "stream": {
        "detected_level": "info",
        "job": "blog-demo",
        "level": "info",
        "service": "nginx",
        "service_name": "nginx"
      },
      "values": [
        ["1791841407000000000", "192.168.1.43 - - [13/Oct/2026:04:20:19 +0000] \"GET /posts/structured-logging HTTP/1.1\" 200 892"],
        ["1791841406000000000", "192.168.1.42 - - [13/Oct/2026:04:20:18 +0000] \"GET /zh/posts/loki-log-aggregation HTTP/1.1\" 200 1234"]
      ]
    }
  ],
  "stats": {
    "summary": {
      "totalLinesProcessed": 7,
      "totalEntriesReturned": 4,
      "totalBytesProcessed": 458,
      "execTime": 0.006074
    }
  }
}
```

行的顺序是新的在前（默认 `direction=backward`）。`stats` 才是我真正会看的部分：
`totalLinesProcessed: 7` 对 `totalEntriesReturned: 4`，就是 `limit=4` 在起作用。

### 行过滤器

`|=` 子串、`!=` 排除、`|~` 正则（加 `(?i)` 忽略大小写）。它们跑在流选择器*之后*，所
以标签集合可以保持便宜，精确匹配交给文本搜索：

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query={job="blog-demo"} |= "ERROR"' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" | python3 -m json.tool
```

```json
{
  "resultType": "streams",
  "result": [
    {
      "stream": {"detected_level": "error", "job": "blog-demo", "level": "error",
                 "service": "api", "service_name": "api"},
      "values": [
        ["1791841405000000000", "ERROR upstream 502 bad gateway from 10.0.0.5:8080"],
        ["1791841404000000000", "ERROR database connection refused: timeout after 30s"]
      ]
    }
  ],
  "stats": {"summary": {"totalLinesProcessed": 7, "totalEntriesReturned": 2}}
}
```

扫了七行，返回两行——这就是没有全文索引的代价（`execTime: 0.004581`，五毫秒），完
全可以接受。

### 指标查询

把日志查询包进一个 range 函数，日志文本就变成了一条 Prometheus 风格的时间序列。这
才是「哪怕你从不打开日志面板也值得跑 Loki」的理由：

```bash
$ curl -s -G http://127.0.0.1:3100/loki/api/v1/query_range \
    --data-urlencode 'query=rate({job="blog-demo"} |= "ERROR" [1m])' \
    --data-urlencode "start=$((EPOCHSECONDS-900))000000000" \
    --data-urlencode "end=$EPOCHSECONDS000000000" \
    --data-urlencode 'step=60' | python3 -m json.tool
```

```json
{
  "resultType": "matrix",
  "result": [
    {
      "metric": {"detected_level": "error", "job": "blog-demo", "level": "error",
                 "service": "api", "service_name": "api"},
      "values": [[1791841440, "0.03333333333333333"]]
    }
  ]
}
```

60 秒窗口里两行 error：2 / 60 = `0.0333` 行每秒——能手算复核，这正是仪表盘该有的样
子。聚合也一样能用：

```json
{
  "resultType": "matrix",
  "result": [
    {"metric": {"service": "api"},   "values": [[1791841440, "0.016666666666666666"],
                                                [1791841500, "0.016666666666666666"]]},
    {"metric": {"service": "nginx"}, "values": [[1791841440, "0.006666666666666667"],
                                                [1791841500, "0.006666666666666667"]]}
  ]
}
```

这就是 `sum by (service) (rate({job="blog-demo"}[5m]))`——300 秒里 5 行 api、2 行
nginx，和原始条数对得上。而 `| json | unwrap duration_ms` 能把结构化日志里的数字字
段取出来，日志直接变延迟分位点：

```bash
$ curl -s -G .../loki/api/v1/query_range \
    --data-urlencode 'query=quantile_over_time(0.95, {job="blog-demo"} | json | unwrap duration_ms [5m])' ...
{"resultType":"matrix",
 "result":[{"metric":{"job":"blog-demo","service":"api","host":"demo-1","env":"test",
                      "level":"error","path":"/zh/posts/loki-log-aggregation","status":"500",
                      "duration_ms":"926","msg":"request handled"},
            "values":[[1791841140,"926"]]}]}
```

日志变成了延迟分位点，不需要任何指标管道。注意解析出来的字段都回到了 `metric` 里——
它们是行级数据，从不进索引。

## Promtail：打标签这件事是 agent 干的

Promtail 是默认的搬运工：tail 文件、在一个 positions 文件里记字节偏移、打上你配置的
标签。一个最小配置，外加一个只把低基数字段提升为标签的流水线阶段：

```yaml
server:
  http_listen_port: 9080

clients:
  - url: http://loki:3100/loki/api/v1/push

positions:
  filename: /run/promtail/positions.yaml

scrape_configs:
  - job_name: blog-demo
    static_configs:
      - targets: [localhost]
        labels:
          job: blog-demo
          service: api
          host: demo-1
          env: test
          __path__: /var/log/blog-demo/*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            status: status
            path: path
            duration_ms: duration_ms
      - labels:
          level:            # 只把这一个提升为标签
      - timestamp:
          source: ts
          format: RFC3339
```

它接手一个十行的 JSON 日志文件之后，positions 文件证明它读完了整个文件：

```bash
$ docker exec promtail-cat /run/promtail/positions.yaml
positions:
  /var/log/blog-demo/api.log: "1152"
```

而 Loki 里的这些行，带着 agent 打的标签和 Loki 自动加的标签：

```json
{
  "stream": {
    "detected_level": "info", "env": "test", "filename": "/var/log/blog-demo/api.log",
    "host": "demo-1", "job": "blog-demo", "level": "info", "service": "api",
    "service_name": "api"
  },
  "values": [
    ["1791841114074267075", "{\"ts\": \"2026-10-12T21:38:19Z\", \"level\": \"info\", \"status\": 201, \"path\": \"/api/v1/comments\", \"duration_ms\": 2230, \"msg\": \"request handled\"}"]
  ]
}
```

`status` 和 `path` 留在了日志行里——高基数，可以用 `| json | status >= 500` 搜，但永
远不进索引。整套纪律就在这一份配置里。（让这一切变便宜的是结构化日志，生产端的事见
[结构化日志](/zh/posts/structured-logging/)。）

Grafana 那一环我也是照样验证的：一个一次性 Grafana，数据源代理到 `http://loki:3100`，
通过 `/api/ds/query` 查询，返回的 Grafana 数据帧里是同样的 `ERROR upstream 502` 那
一行。

## 标签基数：最贵的那个错

上面这些都让人愉快，这部分才咬人。**保持标签基数低**：每一个唯一的标签组合就是一
条新流，而每条流都要吃内存、一个 chunk、一条索引项。

我量过。同一台机器、同一份配置，500 行日志推两次——一次用低基数标签，一次把
`request_id` 当成标签：

```bash
=== before cardA ===
  loki_ingester_memory_streams=3  labels_bytes=203
=== after cardA (500 lines, 1 stream) ===
  loki_ingester_memory_streams=4  labels_bytes=250
  delta streams=1  delta label bytes=47
=== after cardB (the same 500 lines, request_id as a label) ===
  loki_ingester_memory_streams=504  labels_bytes=35250
  delta streams=500  delta label bytes=35000
```

日志内容完全一样。索引成本：**47 字节对 35,000 字节——745 倍**——同时活动流从 1 条
变成 500 条。标签元数据大约是每条流 70 字节，所以一天一百万个不同的 `request_id`
就是每天约 70 MB 的索引，而你还没存进任何一行日志。

Loki 也不会让你错得很离谱。`max_label_names_per_series` 默认是 15，推 18 个直接报
错：

```bash
$ curl -sS -X POST http://127.0.0.1:3100/loki/api/v1/push -H "Content-Type: application/json" -d @limit.json
entry for stream '{job="limit-demo", l00="v", ... l15="v", service="api", service_name="api"}' has 18 label names; limit 15
```

我实际在用的规则：

- **好标签：** `job`、`service`、`level`、`env`、`instance`、`host`——有界集合，最多
  几十个值。
- **坏标签：** `request_id`、`user_id`、`trace_id`、`url_path`、`ip`——无界。把它们放
  进行里，用 `|=` / `|~` / `| json` 过滤。
- **判据：** SQL 里你不会 `GROUP BY` 的东西，就别拿来做标签。
- **检查：** `loki_ingester_memory_streams` 和 `..._labels_bytes` 是两个该告警的
  gauge。流数跟着流量走而不是跟着服务数走，那就是这个 bug。

经典事故：有人为了让链路追踪「刚好能用」把 `trace_id` 做成标签，流数跟着流量垂直上
升，修复方式是把它降回日志行里。基数是 Loki 里唯一一个「做起来很贵、避开却免费」的
错误。

## 保留策略与存储

保留是 schema 周期的事，不是后补的。用 TSDB 索引（2.4 之后的默认）时，`period: 24h`
每天开一张新索引表，compactor 删掉比 `retention_period: 168h` 更老的表：

```yaml
limits_config:
  retention_period: 168h        # 7 天，在 /config 里显示为 "1w"

compactor:
  working_directory: /loki-data/compactor
  retention_enabled: true
  delete_request_store: filesystem   # <- 必填，见下
```

两个真实的坑：第一，不写 `delete_request_store` 就开保留，验证直接失败——我第一遍就是
这么栽的：

```
level=error msg="error running loki" err="CONFIG ERROR: invalid compactor config:
compactor.delete-request-store should be configured when retention is enabled"
```

第二，`reject_old_samples_max_age: 168h` 会静默丢掉早于一周的行：它是时钟漂移的安全
网，也是 agent 重放 backlog 时「日志怎么少了」的困惑来源。

关于存储：chunk 是 gzip 压过的（默认 `chunk_encoding: gzip`），标签索引则随流数增
长——基数那套论证换个说法再说一遍。这个实例的实测：1,008 行、80,001 字节推送载荷、
504 条流、35,250 字节标签元数据、磁盘上 168 KB，其中大部分还是我为了论证故意造出来
的 500 条流。文件系统存储对单机足够；需要第二个写入方时上 S3/GCS。

## Loki 对 ELK，以及 Loki 对 journald

**ELK** 是一个有主见的搜索引擎：Elasticsearch、Logstash 或 Beats、Kibana，再加上你
为之付费的倒排索引。当问题是「在 2 TB 日志里找出所有提到这个词的行」，或者你想对日
志*内容*做聚合时，它赢。其余场合都是 Loki 赢：一个二进制、一个存储后端、一门你从
PromQL 里已经会一半的查询语言，以及一份不需要 CFO 过目的存储账单。实话实说这个取
舍：Loki 不擅长临时性的全文搜索，多少标签都补不回来。

**journald** 不是竞品，它是本地的地板。在单台 Linux 上，
`journalctl -u nginx --since "10 min ago" -p err` 比任何聚合器都快，而且是自带的。等
到你有两台主机需要关联、需要一份轮转策略、或者有个不能 SSH 的人要看日志时，
journald 就不够了——而 Promtail 可以直接读 journald，所以集中化不用动应用。

## 几台服务器上，grep 什么时候真的够用

五台机器以下、团队不大的时候，组织良好的 SSH + `grep` 是一个真实策略，不是你要摆脱
的过渡阶段。`ansible all -i inv -m shell -a 'grep -c ERROR /var/log/app.log'` 几秒
钟就能回答「有没有在报错」，零新增基础设施。具体的临界点在这几处：

- 你需要把多个服务或多台主机的日志**关联**到一个视图里；
- 有个没有 SSH 权限的人需要读日志；
- 保留时长必须超过本地磁盘；
- 你想对一个模式**告警**（「5xx 比例五分钟内超过 1%」）；
- 你想从 grep 的同一份数据里拿到 `rate()` 和分位点。

越过前两条，一台跑在 5 美元 VPS 上的 Loki 容器就是最便宜的进阶；在这两条以下，`grep`
真的是对的工具，Loki 只是开销。

## 收尾

**Grafana Loki** 并不想成为 Elasticsearch。它想做的是回答「我的日志里现在正在发生什
么」的最便宜方式，靠的是索引标签而不是全文、把 chunk 压到对象存储上、以及复用你脑
子里已经有的 Prometheus 模型。只用低基数字段打标签，把有意思的值留在日志行里用
LogQL 过滤，除了日志速率也告警流数，保留策略写在 schema 加 compactor 里。照这个开
始，Loki 就会一直很无聊——这是我能给一套日志栈的最高评价。

---

*同系列还有：[结构化日志](/zh/posts/structured-logging/) 和 [Prometheus
实战](/zh/posts/prometheus-in-practice/)。*
