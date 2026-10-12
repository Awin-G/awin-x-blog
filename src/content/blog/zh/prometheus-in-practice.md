---
title: "Prometheus 实战：抓取、真正用得上的 PromQL，以及不狼来了的告警规则"
description: "一次在临时 Docker 环境里动手做的 Prometheus 走查：pull 模型与 scrape_configs、exposition 格式、真正用得上的 PromQL、recording/alerting rules、基数陷阱与保留策略——全部附上真实查询输出。"
pubDate: 2026-12-12
lang: zh
translationKey: prometheus-in-practice
tags: [devops, self-hosting]
featured: true
keywords:
  - Prometheus
  - PromQL
  - node_exporter
  - 告警规则
  - scrape_configs
  - histogram_quantile
  - 基数陷阱
---

大多数讲 **Prometheus** 的文章，开头是一张架构图，结尾是一张 Grafana 截图。我学一个工具的方式是先把它跑起来，所以这次我就这么干了：用 Docker 起一个一次性的 **Prometheus** 加 **node_exporter**，只监听 `127.0.0.1`，五分钟搭好，数字一拿到就删掉。这篇写的是我真正会用到的那部分——pull 模型和 `scrape_configs`、exposition 格式、值得占地方的 **PromQL**、指向「我真的会去修」的事的**告警规则**，以及会悄悄毁掉一套本来没问题的监控的两个坑：基数（cardinality）和保留策略。下面每一段输出都来自那个容器，未经修饰。

## Pull 而非 push：后面所有设计都由这一个选择决定

Prometheus 不会等你的服务主动把指标推给它。它是 **pull**：按固定间隔向每个 target 的 `/metrics` 发一个 HTTP `GET`，把返回的文本读进来。这一个决定塑造了整个系统的气质。

- **存活本身就是数据。** 一次失败的 `GET` 就是 `up = 0`，可以像任何序列一样告警。
- **没有 agent 侧的配置漂移。** target 负责暴露，Prometheus 负责决定。加一台主机只需要改一个文件。
- **你能手动排查。** `curl host:9100/metrics` 就是服务端发的那个请求。

Linux 上负责暴露 `/metrics` 的几乎总是 **node_exporter**——CPU、内存、磁盘、网络、systemd 单元状态。push 只有一个正当用途：生命周期短到撑不过下一次抓取的批处理任务，走 Pushgateway。凡是长期存在的东西，都用 pull。

抓取循环把样本写进本地时序数据库；仪表盘和告警规则再通过 **PromQL** 把数据读回来。整条路径就是这张图：

<figure>
<svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Prometheus 按抓取间隔通过 HTTP 从 node_exporter 等 target 拉取指标，把样本存进本地 TSDB，并应答来自仪表盘和告警规则的 PromQL 查询；触发的告警被交给 Alertmanager。">
  <defs>
    <marker id="p-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="88" width="152" height="72" rx="8"/>
    <rect x="264" y="88" width="152" height="72" rx="8"/>
    <rect x="520" y="88" width="152" height="72" rx="8"/>
    <rect x="520" y="12" width="152" height="48" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" color="#0f766e">
    <line x1="162" y1="124" x2="260" y2="124" marker-end="url(#p-arrow)"/>
    <line x1="418" y1="124" x2="516" y2="124" marker-end="url(#p-arrow)"/>
    <line x1="596" y1="86" x2="596" y2="64" marker-end="url(#p-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="84" y="120" text-anchor="middle">Targets</text>
    <text x="340" y="120" text-anchor="middle">Prometheus</text>
    <text x="596" y="120" text-anchor="middle">PromQL</text>
    <text x="596" y="42" text-anchor="middle">Alertmanager</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="84" y="140" text-anchor="middle">node_exporter :9100</text>
    <text x="340" y="140" text-anchor="middle">scrape loop + TSDB</text>
    <text x="596" y="140" text-anchor="middle">query / alert rules</text>
    <text x="211" y="112" text-anchor="middle">GET /metrics</text>
    <text x="467" y="112" text-anchor="middle">evaluate</text>
    <text x="596" y="76" text-anchor="middle" font-size="10">ALERTS</text>
  </g>
</svg>
<figcaption>拉取、存储、查询、告警。抓取循环是唯一写入的东西；其余一切——仪表盘、规则、API——都只是通过 PromQL 读取 TSDB。</figcaption>
</figure>

## `prometheus.yml`：scrape_configs、targets，以及一点点 relabeling

配置很小，值得从头读到尾。三个顶层概念：多久采一次、加载哪些规则、从哪些 target 采。

```yaml
# prometheus.yml
global:
  scrape_interval: 5s
  evaluation_interval: 5s
  external_labels:
    site: homelab

rule_files:
  - /etc/prometheus/rules.yml

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: node
    static_configs:
      - targets: ["node-exporter:9100"]
        labels:
          role: host
          env: prod

  # 一个故意死掉的 target，好让我们看到 up == 0 和一条真正触发的告警。
  - job_name: ghost-app
    static_configs:
      - targets: ["ghost-app:8080"]
```

`job_name` 会成为每条序列上的 `job` 标签；`static_configs` 是手写的 target 列表；`labels` 给这一组里每条序列都加上标签。我为了演示用了激进的 5s 间隔——15s 才是正常默认值。

两件事会绊住人。第一，不管 target 有没有应答，每次抓取都会产生一条合成的 `up` 和 `scrape_duration_seconds`，所以死掉的 target 依然可见。第二，`instance` 默认就是你写的那个 `host:port`，所以 `instance="node-exporter:9100"` 是容器名而不是主机名——在意的话就在 relabeling 里改掉。

**Relabeling，简单说。** `relabel_configs` 在抓取**之前**运行，决定**是否抓、抓哪里**。`metric_relabel_configs` 在抓取**之后**运行，作用在样本上——这里正是你丢掉某个吵闹指标或一颗基数炸弹的地方。同样的语法，不同的时机：

```yaml
    # before the scrape: drop anything tagged to-scrape=false
    relabel_configs:
      - source_labels: [to_scrape]
        regex: "false"
        action: drop
```

现在把它在一个一次性网络里跑起来，问 API 哪些 target 真的在线。不加特权参数，只绑 `127.0.0.1`：

```bash
$ docker network create prom-net
$ docker run -d --name node-exporter --network prom-net prom/node-exporter:latest
$ docker run -d --name prometheus --network prom-net \
    -p 127.0.0.1:19090:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" \
    prom/prometheus:latest

$ curl -s 'localhost:19090/api/v1/targets?state=active' | # trimmed
  python3 -c 'import sys,json;d=json.load(sys.stdin);[print(t["labels"]["job"],t["scrapeUrl"],t["health"]) for t in d["data"]["activeTargets"]]'
ghost-app http://ghost-app:8080/metrics down
node http://node-exporter:9100/metrics up
prometheus http://localhost:9090/metrics up
```

看到了：两个 target `up`，一个故意 `down`（它解析不到任何东西），还有一条 `lastError` 精确说明原因。这就是完整的排查闭环，而且只是一个 `curl`。

## Exposition 格式，以及给你自己的代码做 instrumentation

target 的 `/metrics` 就是纯文本，一行一个样本，带上 `# HELP` 和 `# TYPE` 注释。下面是这个栈里 node_exporter 的真实输出：

```text
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 39716.74
# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.
node_memory_MemAvailable_bytes 4.852969472e+09
```

三种类型覆盖了几乎全部情况。**counter** 只会涨（按惯例带 `_total` 后缀）。**gauge** 可涨可跌。**histogram** 把观测值数进 `le` 桶，同时暴露 `_sum` 和 `_count`，这才让延迟分位数成为可能；**summary** 无法跨实例聚合，所以优先用 histogram。

给你自己的服务加指标，用客户端库，只数你真的会去处理的东西：counter 加 `_total` 后缀，别把无界取值（用户 ID、request ID、完整 URL、错误字符串）放进标签，把 `/metrics` 做得便宜。最后这条就是**生产者一侧**的基数陷阱。

## 真正用得上的 PromQL

查询走的是 UI 用的同一个 HTTP API：`GET /api/v1/query?query=…`。最简单的一个回答「所有东西都能连上吗」——下面是 `up` 的原始 JSON，裁到只剩一条序列：

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "up",
          "env": "prod",
          "instance": "node-exporter:9100",
          "job": "node",
          "role": "host"
        },
        "value": [1791796978.112, "1"]
      }
    ]
  }
}
```

`resultType: vector` 意味着此刻每条序列一个值：标签是身份，`value` 是 `[时间戳, 值]`。裁掉杂项就是一行 `up{job="node"} => 1`。注意 `rate()` 至少需要两个样本，在一个刚起来的 target 上会什么都不返回——这是头一小时最常见的困惑。

**Counter 要变成 rate。** `rate()` 取一段区间上的 counter，返回每秒平均值，并且会正确处理 counter 重置。这里的原始 counter 是约 40,000 秒的 CPU 时间——作为一个数字毫无意义。

```text
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=0,...} => 0.1503463111111091
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=1,...} => 0.16478844444443771
rate(node_cpu_seconds_total{mode="user"}[1m]){cpu=2,...} => 0.13590417777778047
```

`irate()` 只用最后两个样本——跳得厉害，适合「刚刚发生了什么」的面板，不适合告警，因为一次慢抓取就会把它带偏。`increase()` 是 `rate()` 乘以区间秒数，返回的是计数而不是每秒速率：

```text
increase(node_network_receive_bytes_total{device="eth0"}[1m]){...} => 5843.1594000000005
```

**先聚合，再提问。** `rate()` 每个 CPU 返回一条序列，而没人想要八条。聚合算子（`sum`、`avg`、`min`、`max`、`count`、`topk`）把它们折叠起来；`by` 保留你点名的标签，`without` 丢掉你点名的、留下其余的。

```text
sum by (mode) (rate(node_cpu_seconds_total[1m]))
{mode=idle} => 1.6643598833330575
{mode=iowait} => 0.6462703666666662
{mode=system} => 0.3225777333333336
{mode=user} => 1.4573601166666552
```

gauge 直接读——不要 `rate()`——而 `offset` 通过把查询整体往回挪，让你和过去做比较：

```text
node_memory_MemAvailable_bytes{instance="node-exporter:9100"} => 4797026304
node_memory_MemAvailable_bytes offset 30s{...}                => 4814864384
```

**分位数需要一个 histogram。** 这正是 **histogram_quantile** 值回票价的地方。它读 `le` 桶，而唯一正确的写法是先用 `sum by (le)` 聚合：

```text
histogram_quantile(0.95, sum by (le) (rate(prometheus_http_request_duration_seconds_bucket[5m])))
{} => 0.095
```

这就是 Prometheus 内部 HTTP 请求耗时的 p95：95 毫秒。两个提醒。histogram 的分位数是在桶边界之间做*插值*，所以它的精度只取决于你的桶——按你真正在意的延迟来设计桶的布局。以及结果必须带 `le` 标签；忘了 `sum by (le)` 就是那个经典的「结果为空」bug。

## Recording rules：把昂贵的答案预先算好

PromQL 是查询时才求值的。如果某个仪表盘或告警永远在跑同一条沉重的表达式，就把它预先算掉：**recording rule** 会在每个 `evaluation_interval` 把结果作为一条新序列写回 TSDB，之后查询就便宜了。

```yaml
# rules.yml
groups:
  - name: node.rules
    rules:
      - record: instance:node_cpu_utilisation:rate1m
        expr: 1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m]))
```

它的输出没什么特别——就是一条你能按名字查询的序列，而这正是重点：

```text
instance:node_cpu_utilisation:rate1m{instance="node-exporter:9100"} => 0.7792161701389255
```

按 `level:metric:operation` 命名——`instance:node_cpu_utilisation:rate1m` 读作「instance 级别的 node CPU 利用率，1 分钟速率」——这样名字本身就说明了表达式做了什么。recording rules 不是免费的：每一条都增加序列和求值开销，所以只记录仪表盘或告警真正依赖的那几条。

## 告警规则，以及你到底要不要 Alertmanager

**告警规则**是一条带判决的 recording rule。它有 `expr`、可选的 `for`（条件必须持续多久才触发——你对付抖动的第一道防线）、`labels`，以及承载消息的 `annotations`。

```yaml
      - alert: TargetDown
        expr: up == 0
        for: 10s
        labels:
          severity: page
        annotations:
          summary: "Target {{ $labels.job }}/{{ $labels.instance }} is down"
          runbook: "https://blog.awin-x.top/posts/monitoring-a-small-fleet/"

      - alert: HostMemoryLow
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
        for: 1m
        labels:
          severity: warning
```

部署前先校验——否则配置错误只会换来一个沉默的 `CrashLoopBackOff`：

```text
$ docker exec prometheus promtool check config /etc/prometheus/prometheus.yml
Checking /etc/prometheus/prometheus.yml
  SUCCESS: 1 rule files found
 SUCCESS: /etc/prometheus/prometheus.yml is valid prometheus config file syntax

Checking /etc/prometheus/rules.yml
  SUCCESS: 3 rules found
```

因为我在配置里留了一个死 target，`up == 0` 变成真，规则触发。Prometheus 会跟踪告警状态（`inactive → pending → firing`），并把它作为 `ALERTS` 指标重新发布出来，于是你能从外部查询自己的告警：

```text
$ curl -s 'localhost:19090/api/v1/query' --data-urlencode 'query=ALERTS' | # trimmed
  python3 -c '...'
ALERTS{alertname=TargetDown,alertstate=firing,instance=ghost-app:8080,job=ghost-app,severity=page} => 1
```

`ALERTS` 比看起来有用：它是你构建「没有任何告警在流动」这条元告警的方式，也是 status page 或基于日志的 checker 在不讲 PromQL 的前提下读取 Prometheus 状态的方式。

你要不要 **Alertmanager**？它是个独立进程，接收触发的告警并处理那些重活：分组、去重、抑制（inhibition）、静默，以及路由到邮件、Slack、ntfy 或 webhook。它也是死人开关模式的归属地——一条永远触发的 `watchdog` 告警，外部服务在心跳*停止*时对它报警。一个人、一个渠道：一条规则加一个三十行的通知器就够正当。一旦你有了多个目的地、一个维护窗口，或者好几台主机，Alertmanager 就值回成本。把它和 watchdog 搭配起来，最小版本看[我是怎么监控一支小机队的](/zh/posts/monitoring-a-small-fleet/)。

更大的原则写在这篇的标题里：**告警不能狼来了。** 一条表达式只有在正确的应对是「去做点什么」时才值得告警。对 `up == 0`、对一条预计会在你的保留窗口内被写满的磁盘（`predict_linear`）、对一张即将到期的证书告警——不要对高 CPU 告警，那是事实，不是任务。`for:` 用大方一点，并把 `severity: page` 的规则控制在你会逐条读完的少数几条。同样的纪律也适用于 [status page](/zh/posts/status-page/)——一盏说谎的绿灯，比没有灯更糟。

## 基数陷阱：悄悄杀死你的那些标签

一条时序 = 一个指标名 + 一种唯一的标签组合。**每一种新组合都是一条新序列**，而序列会永久消耗内存、磁盘和查询时间。经典错误是把一个高基数取值放进标签：用户 ID、request ID、完整 URL 路径、session token、错误消息、原始时间戳。一个看起来只有一行的指标，两周后可能是上百万条序列。

你可以从 API 审计它——先看活跃序列总数，再看贡献最多的指标：

```text
count({__name__=~".+"}) => 1669topk(5, count by (__name__)({__name__=~".+"}))
node_cpu_seconds_total              => 64
prometheus_http_requests_total      => 64
node_scrape_collector_success       => 49
node_scrape_collector_duration_seconds => 49
prometheus_http_request_duration_seconds_bucket => 40
```

就这么个小栈，已经约 1,700 条序列：`node_cpu_seconds_total` 一个就是 64 条，因为它是 `8 个 CPU × 8 种 mode`。这里没有一样是病态的——但在真实服务里把 `cpu` 换成 `url_path`，同一个乘数就会砸到你的全部流量上。修复手段按优先级排：干脆不发这个标签；用 `metric_relabel_configs` 丢掉它；或者在 recording rule 里把它聚合掉。像盯磁盘一样盯你的序列数。

## 保留策略与存储：在你需要数据之前就把账算清

Prometheus 把所有东西都存在本地 TSDB 里——两小时一个块、一个预写日志、定期压实——你不给它设上限，它就会一直吃盘，按时间或按大小都行：

```bash
$ docker run -d --name prometheus --network prom-net \
    -p 127.0.0.1:19090:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" \
    prom/prometheus:latest \
    --storage.tsdb.retention.time=15d \
    --storage.tsdb.retention.size=10GB
```

保留策略本质上是一道基数算术：每秒样本数 ≈ 序列数 ÷ 抓取间隔。15s 间隔下，1,700 条序列约 113 样本/秒——四舍五入的误差。到了 1,000,000 条序列就是约 67,000 样本/秒，任何保留参数都救不了你，只能去修标签。当你真的需要多年历史时，把本地保留调短，用 `remote_write` 送到 VictoriaMetrics、Thanos 或 Mimir。对几台主机、几周趋势这种常见情形，本地存储加一个显式上限就够了。

## Prometheus 还是基于日志的 checker

这是解决不同问题的两种工具，选错很贵。

- **Prometheus 管的是随时间变化的数字**：速率、比率、分位数、「涨了多少 / 多快 / 有多少」，跨主机、跨时间窗比较。它便宜、本来就摆在那儿，而且是问「这东西是不是在变坏」的唯一清醒方式。
- **基于日志的 checker 管的是事件**：精确字符串、单条错误、「这件具体的事发生了没」。日志承载着那种一旦做成指标就会变成基数炸弹的高基数细节，而 `journalctl -u thing --since` 完全不需要 exporter。

对几台机器来说，诚实的答案是：[一个脚本、一个定时器和一个死人开关](/zh/posts/monitoring-a-small-fleet/)就能覆盖磁盘、服务和证书，一个新守护进程都不用加。当你有了好几台主机、一个阈值回答不了的趋势问题、或者一个 SLO，再把 Prometheus 加上——它会成为你那些脚本去喂的东西，而不是它们的替代品。指标告诉你*有东西*变了；日志告诉你*为什么*。去拿那把能回答你眼前这个问题的工具。

这篇里的整套栈就是三条 `docker run` 和两个文件。这就是 **Prometheus** 的承诺：难的从来不是安装，而是决定什么值得一条序列、什么值得一次告警、以及什么该放手。

```bash
$ docker rm -f prometheus node-exporter && docker network rm prom-net
```
