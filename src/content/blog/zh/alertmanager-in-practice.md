---
title: "Alertmanager 实战：告警路由、分组与静默，把噪声挡在通知之外"
description: "Alertmanager 实战：用一套临时 Docker 里的 Prometheus + Alertmanager 讲清职责拆分、配置树、告警路由与分组、抑制规则、amtool 静默，并附上 firing 与 resolved 的真实 webhook 载荷。"
pubDate: 2027-01-17
lang: zh
translationKey: alertmanager-in-practice
tags: [devops, self-hosting]
featured: false
keywords:
  - Alertmanager
  - 告警路由
  - 告警分组
  - 静默
  - 抑制规则
  - Prometheus 规则
  - webhook 接收端
---

大多数人第一次认真对待 **Alertmanager**，都是告警频道彻底不能用的那天：某条 `up == 0` 规则在五十台机器上一起触发，通知量冲到三位数，然后有人用「把这条告警关掉」来解决问题。我干了相反的事：在 Docker 里用 `127.0.0.1` 起了一套一次性的 **Prometheus** 加 **Alertmanager**，故意弄挂一个 target，然后看通知那一端到底吐出来什么。这篇讲**告警路由**、**告警分组**、**抑制**和**静默**，全部用真实的 webhook JSON 证明，而不是一张「本应该如何」的架构图。下面每一段输出都来自那套实验环境，未经修饰。

## 职责拆分：Prometheus 负责判定，Alertmanager 负责分发

两个进程，各干一件事。Prometheus 按间隔求值你的 **Prometheus 规则**，把结果 POST 给 Alertmanager；Alertmanager 负责所有「条件是否为真」以外的事：去重、分组、路由、抑制、静默、重试，以及那条 resolved 通知。

交接只在 `prometheus.yml` 里几行，这也是 Prometheus 唯一知道 Alertmanager 存在的地方：

```yaml
# prometheus.yml（节选）
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["am-am:9093"]

rule_files:
  - /etc/prometheus/rules.yml
```

「有哪些规则」是另一个问题，我在[《Prometheus 实战》](/zh/posts/prometheus-in-practice/)里写过。下面是这篇文章里所有告警的规则来源：

```yaml
# rules.yml
groups:
  - name: availability
    rules:
      - alert: TargetDown
        expr: up == 0
        for: 10s
        labels:
          severity: page
          team: infra

  - name: billing-symptoms
    rules:
      - alert: BillingErrorRateHigh
        expr: demo_app_error_rate > 0.2
        for: 20s
        labels: { severity: warning, service: billing }

      - alert: BillingLatencyHigh
        expr: demo_app_p95_latency_seconds > 0.5
        for: 20s
        labels: { severity: warning, service: billing }

      - alert: SharedDependencyDown
        expr: demo_switch_up == 0
        for: 10s
        labels: { severity: critical, service: billing }
```

实验环境本身是同一个网络里的五个容器，不用特权，不监听公网端口：

```bash
$ docker network create am-net
$ docker run -d --name am-node --network am-net \
    -v "$PWD/textfile:/textfile:ro" \
    prom/node-exporter:latest --collector.textfile.directory=/textfile
$ docker run -d --name am-app-exporter --network am-net prom/node-exporter:latest
$ docker run -d --name am-webhook --network am-net \
    -v "$PWD/webhook.py:/webhook.py:ro" python:3.13-alpine python3 /webhook.py 19195
$ docker run -d --name am-prom --network am-net -p 127.0.0.1:19190:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" prom/prometheus:latest
$ docker run -d --name am-am --network am-net -p 127.0.0.1:19193:9093 \
    -v "$PWD/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    prom/alertmanager:latest
```

两个 target 都是真的 exporter，后面我会停掉其中一个。症状类的指标来自 node_exporter 的 textfile collector——一个磁盘上的 `.prom` 文件，每次抓取都会重读。这里我要说清楚：机制是真的，数字是我写的。这是故意的，原因见「抑制」一节。

两个半边都要在信任之前先校验，否则一个拼写错误就是一个「起来了但什么都不做」的容器：

```text
$ docker exec am-am amtool check-config /etc/alertmanager/alertmanager.yml
Checking '/etc/alertmanager/alertmanager.yml'  SUCCESS
Found:
 - global config
 - route
 - 1 inhibit rules
 - 3 receivers
 - 0 templates

$ docker exec am-prom promtool check rules /etc/prometheus/rules.yml
Checking /etc/prometheus/rules.yml
  SUCCESS: 4 rules found
```

## 配置树：告警路由、`match` 与 `matchers`、receiver，以及那几个时间旋钮

一份 Alertmanager 配置就是一棵**树**，而这棵树就是产品的全部。每条告警从根 `route` 进入，一路往下走，直到某个 route 匹配上。第一个匹配即生效，除非子 route 写了 `continue: true`；如果一个都没匹配上，根 route 自己的 `receiver` 兜底——所以根必须指定 receiver，否则这条告警哪也不去。

每个节点都能覆盖那几个时间旋钮，而旋钮正是真正控制噪声的地方：

- **`group_by`**——决定哪些告警进同一个「通知桶」的标签。整个文件里最重要的一个字段。
- **`group_wait`**——一个*新*的分组先按住多久再发，好让同时涌来的一批告警合成一条消息。
- **`group_interval`**——同一个分组再次变化时，两次通知之间的最小间隔。
- **`repeat_interval`**——内容没变的分组隔多久重发一次，也就是「还没好吗」的心跳。

下面是我用的完整文件：一个根、两个子 route、三个 receiver、一条抑制规则：

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  receiver: default-webhook        # 根 = 兜底，必须指定 receiver
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 1m
  repeat_interval: 4h

  routes:
    # 1. 要打电话的：按 alertname 一条一个通知，重发快
    - matchers:
        - severity = "page"
      receiver: webhook-page
      group_by: ['alertname']
      group_wait: 10s
      group_interval: 30s
      repeat_interval: 30s

    # 2. 一个服务的症状：合并成一条通知
    - matchers:
        - service = "billing"
        - severity = "warning"
      receiver: webhook-billing
      group_by: ['service']
      group_wait: 10s
      group_interval: 30s
      repeat_interval: 1m

receivers:
  - name: default-webhook
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true
  - name: webhook-page
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true
  - name: webhook-billing
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true

inhibit_rules:
  - source_matchers:
      - severity = "critical"
    target_matchers:
      - severity = "warning"
    equal:
      - service
```

抄之前有两个细节要知道。`matchers` 用的是 Prometheus 标签选择器语法——`label = "x"`、`label != "x"`、`label =~ "re.*"`——这是现在的写法；`match` 和 `match_re` 是只支持相等的旧写法，已标记废弃。另外同一个节点上的多个 `matchers` 是**相加**关系：billing 这条 route 要求 `service="billing"` *且* `severity="warning"`，所以 billing 的 critical 告警会落到根 receiver 上。事实也正是如此——那条 critical 告警发到了 `default-webhook`：

```text
webhook-page       firing    first notification  groupKey={}/{severity="page"}:{alertname="TargetDown"}
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{service="billing"}
default-webhook    firing    first notification  groupKey={}:{alertname="SharedDependencyDown"}
```

一次运行，三个 route 节点，三个不同的桶：page 那条按 `{alertname}` 哈希，billing 那条按 `{service}` 哈希，没匹配上的 critical 告警则继承根节点的 `{alertname}`。

<figure>
<svg viewBox="0 0 900 250" width="100%" role="img" aria-label="Prometheus 送来的 firing 告警进入根 route，由子 route 按 severity、service 等标签匹配，按 group_by 分组后作为通知发出；被抑制和被静默的告警不会变成任何通知。">
  <defs>
    <marker id="am-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="8" y="14">Prometheus 送来的告警</text>
    <text x="190" y="14">route 树</text>
    <text x="540" y="14">通知</text>
  </g>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.75">
    <rect x="8" y="24" width="146" height="34" rx="6"/>
    <rect x="8" y="74" width="146" height="34" rx="6"/>
    <rect x="8" y="124" width="146" height="34" rx="6"/>
    <rect x="190" y="68" width="118" height="40" rx="6"/>
    <rect x="344" y="26" width="150" height="36" rx="6"/>
    <rect x="344" y="76" width="150" height="36" rx="6"/>
    <rect x="344" y="126" width="150" height="36" rx="6"/>
    <rect x="540" y="22" width="352" height="40" rx="6"/>
    <rect x="540" y="72" width="352" height="40" rx="6"/>
    <rect x="540" y="122" width="352" height="40" rx="6"/>
    <rect x="8" y="180" width="884" height="50" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="156" y1="41" x2="186" y2="74" marker-end="url(#am-arrow)"/>
    <line x1="156" y1="91" x2="186" y2="88" marker-end="url(#am-arrow)"/>
    <line x1="156" y1="141" x2="186" y2="102" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="44" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="94" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="144" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="44" x2="536" y2="42" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="94" x2="536" y2="92" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="144" x2="536" y2="142" marker-end="url(#am-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="81" y="45" text-anchor="middle">TargetDown</text>
    <text x="81" y="95" text-anchor="middle">BillingErrorRateHigh</text>
    <text x="81" y="145" text-anchor="middle">BillingLatencyHigh</text>
    <text x="249" y="86" text-anchor="middle">route</text>
    <text x="249" y="100" text-anchor="middle" font-size="10">group_wait 10s</text>
    <text x="419" y="41" text-anchor="middle">severity = "page"</text>
    <text x="419" y="54" text-anchor="middle" font-size="9">group_by [alertname]</text>
    <text x="419" y="91" text-anchor="middle">service + warning</text>
    <text x="419" y="104" text-anchor="middle" font-size="9">group_by [service]</text>
    <text x="419" y="141" text-anchor="middle">(没匹配上)</text>
    <text x="419" y="154" text-anchor="middle" font-size="9">根 receiver</text>
    <text x="716" y="39" text-anchor="middle">webhook-page · 1 条通知，1 个告警</text>
    <text x="716" y="89" text-anchor="middle">webhook-billing · 1 条通知，2 个告警</text>
    <text x="716" y="139" text-anchor="middle">default-webhook · 那条 critical</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="26" y="203">inhibit_rules（原因触发）和 silence（维护窗口）会把告警从所有分组里摘掉，</text>
    <text x="26" y="221">所以最常见的结果，恰恰就是「什么都不发」。</text>
  </g>
</svg>
<figcaption>告警进，通知出。`group_by` 才是把一堆 firing 时序收敛成有限条通知的东西；route 树只决定这堆告警落进哪个桶。</figcaption>
</figure>

## 告警分组：`group_by` 决定你收到 1 条还是 100 条

分组就是「频道还能用」和「一堵噪声墙」之间的差别。Alertmanager 用它持有的每条告警的 `group_by` 标签算哈希，一个哈希桶一条通知。改一下 key，同一场告警风暴发出的消息数就完全不同。

同一组告警我跑了两次，只改 `group_by`，webhook 日志把整个过程说得明明白白。billing route 用 `group_by: ['service']` 时，两个症状告警落进同一个桶，合成**一条包含两个告警的通知**：

```text
[00:58:06] POST /hook status=firing receiver=webhook-billing
          groupLabels={'service': 'billing'} alerts=2 [BillingErrorRateHigh,BillingLatencyHigh]
```

载荷一字未删：

```json
{
  "receiver": "webhook-billing",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "BillingErrorRateHigh", "instance": "am-node:9100", "job": "node", "service": "billing", "severity": "warning" },
      "annotations": { "summary": "Billing error rate 34%" },
      "startsAt": "2026-10-13T00:57:56.121Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "0efe0119f00205cf"
    },
    {
      "status": "firing",
      "labels": { "alertname": "BillingLatencyHigh", "instance": "am-node:9100", "job": "node", "service": "billing", "severity": "warning" },
      "annotations": { "summary": "Billing p95 latency 0.9s" },
      "startsAt": "2026-10-13T00:57:56.121Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "cde40a1a655a7af5"
    }
  ],
  "notification_reason": "first notification",
  "groupLabels": { "service": "billing" },
  "groupKey": "{}/{service=\"billing\",severity=\"warning\"}:{service=\"billing\"}",
  "truncatedAlerts": 0
}
```

注意这组减法，它把 `group_wait` 变具体了：告警的 `startsAt` 是 `00:57:56.121`，通知到达是 `00:58:06.149`，整整十秒，正好等于 `group_wait: 10s`。在那之前的十秒是规则里的 `for: 20s` 的一半。*这就是*为什么五十条一起炸的告警会变成一条消息。

然后我把 billing route 的 `group_by` 改成 `['alertname']`，重启 Alertmanager，重新喂同样的两个告警。数据一样、规则一样，只动了一个字段：

```text
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{alertname="BillingErrorRateHigh"}  alerts=1
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{alertname="BillingLatencyHigh"}   alerts=1
```

两条通知，各含一个告警，分开到达。乘上五十台主机，你就有了一堵噪声墙——而它完全是那个 `group_by` 列表造出来的。我带走的原则：按「有人认领的东西」分组（`service`、`team`、`cluster`），永远不要按 `instance` 或任何高基数标签分。另外，当一个已经开着的分组内容发生变化时，`group_interval` 是你听到它的最短等待时间——它是那个节流阀，防止抖动告警变成聊天软件里的节拍器。

## 一次真实的 firing → resolved 生命周期：`up{job="app"} == 0`

分组只是一半，另一半是告警有生命周期，而这个生命的两头你都会收到通知。我停掉了 `app` 这个 target，先看 Prometheus 自己的视角：

```text
# t+0s   targets up: up{job="app",instance="am-app-exporter:9100"} => 1
# stopping am-app-exporter
--- t+10s  ALERTS:       TargetDown{alertstate=pending,instance=am-app-exporter:9100,job="app",severity="page"} => 1
--- t+15s  ALERTS:       TargetDown{alertstate=pending,instance=am-app-exporter:9100,job="app",severity="page"} => 1
--- t+20s  ALERTS:       TargetDown{alertstate=firing,instance="am-app-exporter:9100",job="app",severity="page"} => 1
--- t+20s  ALERTS_FOR_STATE: TargetDown{instance="am-app-exporter:9100",job="app"} => 1791853231
```

规则里我写了 `for: 10s`，于是 `pending` 停了十秒，然后 `firing`。`ALERTS` 和 `ALERTS_FOR_STATE` 是你在 Prometheus 之外读它告警状态的两个口子：前者把告警当成指标，后者是进入该状态的 Unix 时间戳。随后到来的就是这条 `up{job="app"}` 告警，一个告警，`status: firing`：

```json
{
  "receiver": "webhook-page",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "TargetDown", "instance": "am-app-exporter:9100", "job": "app", "severity": "page", "team": "infra" },
      "annotations": { "summary": "Target app/am-app-exporter:9100 is down" },
      "startsAt": "2026-10-13T01:00:41.813Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "5720e89ba7a86cdf"
    }
  ],
  "notification_reason": "first notification",
  "commonLabels": { "alertname": "TargetDown", "job": "app", "severity": "page" },
  "externalURL": "http://am-am:9093"
}
```

因为那条 route 的 `repeat_interval` 是 30 秒（特意调短，免得这个演示要做四个小时），心跳也跟着来了——`notification_reason: "repeat interval elapsed"`，同一个分组，内容没变。这个字段最值得 grep：它告诉接收端这是新闻还是只是脉搏。然后我把容器重新拉起来，生命周期的另一头就到了：

```text
webhook-page   resolved   all alerts resolved   groupKey={}/{severity="page"}:{alertname="TargetDown"}  alerts=1
```

`status: resolved`，`endsAt` 是真实时间而不是那个零值时间戳。由此有两条：永远写上 `send_resolved: true`——resolved 通知才是让人在心里把这一页合上的东西，没有它，「还坏着」和「已修好」长得一模一样；以及 `resolve_timeout: 5m` 是安全网——如果 Prometheus 消失、不再告诉 Alertmanager 任何事，告警会在五分钟后自动 resolve，而不是永远呼你。

接收端本身只有二十行 Python，因为 webhook 就是一个 HTTP 端点：

```python
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = json.loads(body)          # 让它抛异常：我们就是要知道

        names = ",".join(a["labels"].get("alertname", "?") for a in data.get("alerts", []))
        print(f'[{datetime.now():%H:%M:%S}] status={data.get("status")} '
              f'receiver={data.get("receiver")} alerts={len(data.get("alerts", []))} [{names}]', flush=True)

        self.send_response(200)          # 任意 2xx，否则 Alertmanager 会重试
        self.end_headers()
        self.wfile.write(b"ok")
```

把原始 body 记下来。告警本身不对的时候，你需要的是那段精确的 JSON，而不是一句人工总结；如果你要留下这些载荷，[结构化日志](/zh/posts/structured-logging/) 就是让它们事后可查的办法——上面那些字段本身就是结构化的。

## 抑制：原因一响，症状闭嘴

**抑制**是这么一条规则：原因告警触发时，别再报症状。我的规则是任何 `severity: critical` 抑制带相同 `service` 的 `severity: warning`。我把 `demo_switch_up{service="billing"}` 置 0，共享依赖那条规则转为 critical，于是那两个症状告警——本来正在每分钟重发——不再被通知。Alertmanager 自己的 API 把它的决定写得一清二楚：

```text
$ curl -s localhost:19193/api/v2/alerts | jq -r '.[] | "\(.labels.alertname) \(.status.state)"'
BillingErrorRateHigh   suppressed
SharedDependencyDown    active
BillingLatencyHigh     suppressed

$ docker exec am-am amtool alert query            # 人该动手的那条
Alertname             Starts At                Summary                                          State
SharedDependencyDown  2026-10-13 01:07:46 UTC  Shared switch/rabbit for billing is unreachable  active

$ docker exec am-am amtool alert query --inhibited # 被咽下去的那些，以及为什么重要
Alertname             Starts At                Summary                   State
BillingErrorRateHigh  2026-10-13 00:57:56 UTC  Billing error rate 34%    suppressed
BillingLatencyHigh    2026-10-13 00:57:56 UTC  Billing p95 latency 0.9s  suppressed
```

原始 API 里的 `inhibitedBy` 写着负责抑制的那条告警的 fingerprint——这就是完整的审计链，也说明它值得被设计进配置。被抑制的告警没有被删掉，它只是被按住，原因一消失就回来（我把开关拨回 `1`，症状分组立刻恢复）。

两条诚实的提醒。抑制要求原因和症状**同时处于 firing**，并且有一个共享标签可以匹配——这里是 `equal: [service]`，它点的标签必须在两边都存在。而当 target 是真的没了的时候，这套模式比听起来弱：一台失联的主机会把自己的指标一起带走，于是 `up == 0` 响了，而它的 CPU、延迟、磁盘告警是直接消失、根本不需要被抑制。这正是我的 textfile 症状在模拟的那个限制，也是抑制真正的用武之地在于*共享*依赖——一台交换机、一个数据库、一个队列、一个 DNS——的原因：四十个依赖方会持续报告「连不上它」。

## 静默：一个带到期时间的维护窗口

**静默**是手动的、有期限的静音。不是改配置，不是重启，不需要 reload：你告诉一个正在运行的 Alertmanager，某组告警别再通知。`amtool` 就是干这个的 CLI，官方镜像里自带：

```text
$ docker exec am-am amtool silence add service="billing" severity="warning" \
    --duration=15m --comment="planned billing maintenance: rolling restart of the exporter"
a6f1d79a-d08a-4008-b828-90d29ac20f57

$ docker exec am-am amtool silence query
ID                                    Matchers                              Ends At                  Created By  Comment
a6f1d79a-d08a-4008-b828-90d29ac20f57  service="billing" severity="warning"  2026-10-13 01:25:29 UTC  nobody      planned billing maintenance: rolling restart of the exporter
```

「生效了」的确切含义是：告警还在 firing，而通知停了。

```text
$ curl -s localhost:19193/api/v2/alerts | jq -r '.[] | "\(.labels.alertname) state=\(.status.state) silencedBy=\(.status.silencedBy)"'
BillingErrorRateHigh state=suppressed silencedBy=['a6f1d79a-d08a-4008-b828-90d29ac20f57']
BillingLatencyHigh state=suppressed silencedBy=['a6f1d79a-d08a-4008-b828-90d29ac20f57']
```

最后一次重发在 `01:09:51`，`repeat_interval: 1m`，下一次本该在 `01:10:51`。到 `01:13` 为止，静默创建于 `01:10:29` 之后一条新通知都没有——间隔是一分钟，两分钟的空白就是证据。`silencedBy` 里带着静默 ID，所以每一次静音都能追溯到一个备注和一个结束时间，这正是重点。静默要选你能写出的最窄匹配（`service="billing" severity="warning"`，而不是 `alertname=~".+"`），时长按维护窗口给，一分钟都别多，干完用 `amtool silence expire <id>` 删掉。静默是一个承诺：这事之后有人会回头看。

## 反模式，因为配置其实是容易的那部分

诚实的清单，都是花过钱换来的：

- **对症状告警，不要对原因告警。**「CPU 90%」是一个事实，「磁盘将在保留周期内写满」才是一项任务。原因类告警（`up == 0`）几乎总是可行动的那条；症状是给原因做上下文的，而这就是抑制的用途。
- **只对可行动的呼人。**`severity: page` 的含义应该是「把人叫醒」。三十条 page 规则等于零条——修法是把它们路由到不呼人的 receiver，而不是删掉。
- **别用静默给自己挖的坑盖土。**一个永不过期的静默，就是一条被删掉的告警，只是多走了几步。如果你每周都要重建它，那是规则写错了。
- **永远不要按高基数标签分组。**`group_by: [instance]` 就是每台主机一条通知；把 `instance` 或者 pod 名放进 `group_by`，墙是你自己砌的。
- **在告警里说清楚该干什么。**annotation 是人凌晨三点唯一会读的文字。一条 runbook 链接加一句点名服务的话，胜过一整面标签。

Alertmanager 不是通知器，它是一个带着通知器的噪声过滤器。想通这一点，配置的读法就变了：每个字段都是一个「人该被多响地打扰一次」的决定，而 `group_by` 决定这个频道能不能活过第一个糟糕的夜晚。

这套实验环境是五个容器、两个文件、十五分钟，拆起来也一样干脆：

```bash
$ docker rm -f am-prom am-am am-node am-app-exporter am-webhook && docker network rm am-net
am-prom
am-am
am-node
am-app-exporter
am-webhook
am-net
```
