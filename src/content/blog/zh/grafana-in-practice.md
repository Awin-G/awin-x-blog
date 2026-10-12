---
title: "Grafana 实战：仪表盘即代码，而不是靠点出来"
description: "在 127.0.0.1 上起一套一次性的 Grafana + Prometheus，全部用文件预置。Grafana 到底是什么（一个查询前端，不是 TSDB）、Grafana provisioning 把数据源和仪表盘变成代码、查询编辑器与裸 PromQL、会骗人的面板、模板变量、告警该放哪里——附真实 API 输出。"
pubDate: 2026-12-15
lang: zh
translationKey: grafana-in-practice
tags: [devops, self-hosting]
featured: false
keywords:
  - Grafana
  - Grafana provisioning
  - 仪表盘即代码
  - Prometheus 数据源
  - 模板变量
---

我不止一次把仪表盘点出来，然后又把它弄丢了：没导出、没进版本控制，某个面板被人改了名，谁也说不清为什么。**Grafana** 是一个指向数据源的查看器，而「先点再说」是错误的工作方式。这篇写的是相反的那条路：在 `127.0.0.1` 上起一套一次性的 Grafana 加 Prometheus 和 node_exporter，用 **Prometheus 数据源**、一个仪表盘和一条告警规则，全部交给 **Grafana provisioning** 交付——*仪表盘即代码（dashboards as code）*，文件进 git，一条命令就能复现。下面每一段输出都来自这套栈，未经修饰。

## Grafana 是什么——以及不是什么

Grafana 几乎不存东西。它是一个查询前端：你选一个**数据源**（Prometheus、Loki、PostgreSQL、InfluxDB、Elasticsearch，还有很多），写一条查询，Grafana 把结果画出来。它自己的 SQLite/Postgres 里存的是仪表盘、变量、用户和告警状态——但它**不**存你的指标。

这一点就能终结大部分争论：

- **它不是时序数据库。** 样本的保留、降采样和基数都属于 Prometheus（或者 VictoriaMetrics、Mimir 之类）。Grafana 只负责读，不拥有样本。如果你的 Grafana 很慢，先看查询和数据源，再怪渲染。
- **它不是采集器。** 没有任何东西会把主机指标抓进 Grafana。是 Prometheus 去拉 `/metrics`，Grafana 再去问 Prometheus。
- **它不是真相之源。** 既然一切都是文件，运行中的 Grafana 只是你仓库的一份缓存。点选是一时的方便，不是产物。

数据流刻意设计得很无聊:数据源存样本，Grafana 读样本，仪表盘和告警是那两个读者。这套栈就是这张图。

<figure>
<svg viewBox="0 0 700 230" width="100%" role="img" aria-label="Prometheus 数据源持有指标；Grafana 通过预置的数据源查询它，并把结果渲染进预置的仪表盘和预置的告警规则。数据源、仪表盘和告警规则全部由 Grafana provisioning 以文件方式交付。">
  <defs>
    <marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="80" width="150" height="70" rx="8"/>
    <rect x="270" y="80" width="150" height="70" rx="8"/>
    <rect x="532" y="22" width="160" height="54" rx="8"/>
    <rect x="532" y="96" width="160" height="54" rx="8"/>
    <rect x="532" y="170" width="160" height="52" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" color="#0f766e">
    <line x1="158" y1="115" x2="266" y2="115" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="112" x2="528" y2="52" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="117" x2="528" y2="122" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="122" x2="528" y2="194" marker-end="url(#g-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="83" y="110" text-anchor="middle">数据源</text>
    <text x="345" y="110" text-anchor="middle">Grafana</text>
    <text x="612" y="54" text-anchor="middle">仪表盘</text>
    <text x="612" y="128" text-anchor="middle">告警</text>
    <text x="612" y="200" text-anchor="middle">provisioning</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="83" y="130" text-anchor="middle">Prometheus / Loki…</text>
    <text x="345" y="130" text-anchor="middle">查询 + 渲染</text>
    <text x="612" y="71" text-anchor="middle">JSON 文件</text>
    <text x="612" y="145" text-anchor="middle">YAML 文件</text>
    <text x="612" y="218" text-anchor="middle">YAML 文件</text>
    <text x="212" y="103" text-anchor="middle">PromQL</text>
  </g>
</svg>
<figcaption>Grafana 不拥有任何样本。它查询数据源并渲染；仪表盘和告警是文件，由 Grafana provisioning 在启动时加载。</figcaption>
</figure>

## Grafana provisioning：把 Prometheus 数据源写成代码

想让 Grafana 的配置可复现，最快的办法就是从不手动配置。`GF_PATHS_PROVISIONING` 指向一个目录（默认 `/etc/grafana/provisioning`），Grafana 启动时扫描它：`datasources/` 放数据源，`dashboards/` 放仪表盘 provider，`alerting/` 放告警规则。把这个目录只读挂进去，容器的全部配置就是你仓库里的一个文件夹。

下面是这套 compose 栈——三个服务，只监听 `127.0.0.1`，没有任何 privileged 参数：

```yaml
# docker-compose.yml
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports: ["127.0.0.1:19090:9090"]

  node-exporter:
    image: prom/node-exporter:latest

  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
      - ./dashboards:/var/lib/grafana/dashboards:ro
    ports: ["127.0.0.1:3000:3000"]
```

**Prometheus 数据源**就是一个小文件。`uid` 很关键：仪表盘靠这个稳定的 id 引用数据源，而不是靠显示名，所以改数据源名字永远不会弄坏面板。

```yaml
# provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prom-main
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      httpMethod: POST
      timeInterval: 5s
```

`access: proxy` 表示由 Grafana 后端去请求 Prometheus——浏览器根本不需要能连到它，所以把 Prometheus 放在内网的 `127.0.0.1` 上照样能用。起起来，问问 Grafana 它加载了什么：

```bash
$ docker compose up -d
$ curl -s localhost:3000/api/health
{
  "database": "ok",
  "version": "13.2.3",
  "commit": "90ffed056f0884267356c12a0eeb72a022af53f1"
}

$ curl -s -u admin:admin localhost:3000/api/datasources | # 已截断
  python3 -c '...'
name=Prometheus uid=prom-main type=prometheus isDefault=True readOnly=True
```

`readOnly: true` 就是回报：预置的数据源在 UI 里改不了。文件说了算。Grafana 自己的日志也这么说：

```text
logger=provisioning.datasources msg="inserting datasource from configuration" name=Prometheus uid=prom-main
logger=provisioning.dashboard msg="starting to provision dashboards"
logger=provisioning.alerting msg="finished to provision alerting"
```

## 仪表盘即代码：JSON 才是产物

仪表盘 provider 是文件树和 Grafana 数据库之间的桥。它声明 JSON 文件在哪个文件夹，以及 UI 能不能覆盖它们：

```yaml
# provisioning/dashboards/dashboards.yml
apiVersion: 1
providers:
  - name: homelab
    orgId: 1
    folder: Homelab
    type: file
    disableDeletion: true
    updateIntervalSeconds: 30
    allowUiUpdates: false        # 文件是权威
    options:
      path: /var/lib/grafana/dashboards
```

`allowUiUpdates: false` 和 `disableDeletion: true` 这两行才让「即代码」成立。仪表盘就是一份普通的 JSON 文档——`uid`、`title`、一个 `templating` 块，和一个 `panels` 数组。一个面板 = 一个数据源 + 一条查询 + 一种显示类型：

```json
{
  "uid": "node-overview",
  "title": "Node Overview (provisioned)",
  "templating": { "list": [ { "name": "instance",
    "type": "query",
    "query": "label_values(up{job=\"node\"}, instance)",
    "includeAll": true, "multi": true } ] },
  "panels": [
    { "type": "stat",  "title": "Targets up",
      "targets": [ { "expr": "sum(up{job=\"node\", instance=~\"$instance\"})" } ] },
    { "type": "gauge", "title": "Memory available %",
      "targets": [ { "expr":
        "100 * node_memory_MemAvailable_bytes{instance=~\"$instance\"} / node_memory_MemTotal_bytes{instance=~\"$instance\"}" } ] }
  ]
}
```

用 API 搜一下，仪表盘就在那儿，带着标签、归在文件夹里，元数据也确认它来自文件而不是来自点选：

```bash
$ curl -s -u admin:admin 'localhost:3000/api/search?type=dash-db' | # 已截断
  python3 -c '...'
uid=node-overview title="Node Overview (provisioned)" tags=[node, provisioned] folder=Homelab

$ curl -s -u admin:admin localhost:3000/api/dashboards/uid/node-overview | # 已截断
  python3 -c '...'
provisioned=True provisionedExternalId="node-overview.json"
panels=4 vars=[instance]
```

这就是**仪表盘即代码**的全部：一份 git diff 就能看出改了什么，一次 review 就能拦下坏面板，一个全新的 Grafana 自己就能重建。给每个仪表盘一个文件；给每个数据源一个 `uid`；永不把 UI 当成唯一的副本。

## 查询编辑器与裸 PromQL

Grafana 的查询编辑器是一个 PromQL 构造器：指标选择器、标签过滤、函数菜单、explain 面板。用来探索很好——找到指标名，看有哪些标签。但它对你真正要跑的那条查询是一种有损翻译，生成的东西有时刻意很丑（自动生成的正则过滤、一长串你没写的函数）。

每个面板最终都是把一条 PromQL 字符串发给数据源。你可以手动发同一条字符串——走 Grafana 自己的代理——看到面板看到的东西：

```bash
$ curl -s -u admin:admin \
    'localhost:3000/api/datasources/proxy/uid/prom-main/api/v1/query' \
    --data-urlencode 'query=up'
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      { "metric": { "__name__": "up", "env": "demo", "instance": "node-exporter:9100",
                    "job": "node", "role": "host" }, "value": [1791798871.408, "1"] },
      { "metric": { "__name__": "up", "instance": "localhost:9090",
                    "job": "prometheus" }, "value": [1791798871.408, "1"] }
    ]
  }
}
```

两条经验。**一旦查询不再简单，就切到代码模式**（`editorMode: "code"`）——可视化编辑器是给初稿用的，不是给一句 histogram 上的 rate 用的。以及，**API 才是地面真相**：面板显示为空时，用同一条表达式打一下代理 URL，看看 Prometheus 返回的是空向量（你的查询错了）还是错误（你的标签错了）。面板只是渲染；代理才是答案。

## 真正重要的面板——以及它们各自怎么骗你

四种面板类型几乎撑起所有有用的仪表盘，每一种都有一种让你舒服的撒谎方式。

- **Time series**——折线图。默认选项，通常也对：rate、延迟、队列深度随时间变化。当 Y 轴从零自动缩放到最大值，3% 的抖动看起来像悬崖时，它就在撒谎；把轴钉住，并对 counter 用 `rate()`，而不是画只会一直上涨的原始总量。
- **Stat**——一个大数字。非常适合「它活着吗」「有多少」、带阈值的单个值。它撒谎的方式是把形状平均掉：一个双峰延迟的 `avg()` 看起来风平浪静，实际上一半请求已经超时。如果分布重要，就不要把它压成一个 stat。
- **Gauge**——量程已知的 stat。内存 %、磁盘 %、饱和度比值。量程设错时它撒谎：一台 64 GB 的主机把内存 gauge 设成 `0..100`，一次冲到 90% 会被一个半满的表盘盖过去。`min`/`max` 要按被测量的东西来设。
- **Table**——很多序列并排。最适合「哪台实例是异类」：按错误率 top-N、每台主机的剩余磁盘、标签值的分解。它撒谎的方式是变成一堵没人看的数字墙——用 `topk(10, …)` 封顶，按真正重要的那一列排序。

这个选择不是装饰。**Stat** 回答「现在是多少」；**time series** 回答「正在发生什么」；**table** 回答「是哪一个」。按问题选，并且显式地设单位、阈值和轴的边界——因为一个会撒谎的面板，比没有面板更糟。

## 模板变量：为了复用

一个写死单台 `instance` 的仪表盘，是每加一台主机就要复制一份的仪表盘。**模板变量（templating）** 解决这个：一个会变成下拉框的仪表盘变量，用 `$name` 插进每一条查询。上面那个是 query 变量——选项直接来自 Prometheus 自己：

```text
label_values(up{job="node"}, instance)   →  node-exporter:9100
```

`includeAll` 加出一个 `All` 选项（展开成覆盖所有值的正则），`multi` 允许一次选多个，`instance=~"$instance"` 就是面板查询里的插值。两个值得养成的习惯：即使你预期只有一个值，也用 `=~` 配变量（All 的情况需要正则），并用标签（`{job="node"}`）限定变量查询的范围，免得它去枚举整个存储里的每一条序列。一个模板化的仪表盘就覆盖了整个机队，新主机自动出现在下拉框里，一次都不用点。

## Grafana 告警 vs Prometheus 告警

两边都能告警，而诚实的答案是：它们重叠得足够多，以至于容易让人迷惑。真正重要的区别是：

- **Prometheus 告警规则**在 Prometheus 内部按 `evaluation_interval` 求值。规则是文件，求值很便宜（数据本来就在那儿），触发的告警交给 Alertmanager 做路由、分组和静默。简单的、基于表达式的指标条件，就该住在这里。
- **Grafana 告警**在 Grafana 里求值，一条规则能查询**任意**数据源（不限于 Prometheus），并给你一个 UI 来管 contact point、通知策略和静默。它适合「Loki 里日志条数突增就告警」，或者条件横跨多个数据源的情况。

既然这套栈把一切都预置成代码，Grafana 规则也是一个文件：

```yaml
# provisioning/alerting/rules.yml
apiVersion: 1
groups:
  - orgId: 1
    name: homelab
    folder: Homelab
    interval: 1m
    rules:
      - uid: target-down
        title: TargetDown
        condition: C
        for: 30s
        labels: { severity: page }
        data:
          - refId: A
            datasourceUid: prom-main
            model: { expr: "up == 0", instant: true, editorMode: code }
          - refId: C
            datasourceUid: __expr__
            model: { type: threshold, expression: A, conditions: [ { evaluator: { type: gt, params: [0] } } ] }
```

注意那两个 `datasourceUid`：`A` 对 `prom-main` 跑 PromQL，`C` 是对 `A` 做阈值判断的表达式——Grafana 告警是一条小的表达式流水线，而不是单个 PromQL 字符串。API 会返回它最后构建出的规则，这也是你检查一条预置告警是否真的加载的方式：

```bash
$ curl -s -u admin:admin localhost:3000/api/v1/provisioning/alert-rules | # 已截断
  python3 -c '...'
uid=target-down title=TargetDown condition=C for=30s labels={severity: page}
expr="up == 0" datasourceUid=prom-main
```

建议（在[我写 Prometheus 的那篇](/zh/posts/prometheus-in-practice/)里也有）是：不要为同一个条件同时跑两边。按数据住在哪里来选归属，把 `for:` 设得足够长以扛过一次抖动，并且只对「人会真的去处理」的事告警。一个撒谎的绿灯比没有更糟——这也是[小规模机队那套做法](/zh/posts/monitoring-a-small-fleet/)赖以成立的原则。

## 值得点名的反模式

- **没人打开的仪表盘。** 如果一个仪表盘一个月都没回答过一个问题，它就是一份假装成监控的维护负担。删掉；git 记得它。
- **没用的平均值。** 跨机房、跨主机、跨请求类型的 `avg()` 恰好藏起你最在意的那个异类。只对同质的东西取平均，其余一律用 `max`、`topk` 或分位数。
- **一百个面板的墙。** 仪表盘是一个叙事，不是数据倾倒。六个各回答一个问题的面板，胜过六十个什么都不回答的；其余的拆到第二个仪表盘，用一个链接挂过去。
- **点了却没提交的改动。** 一次没变成文件的 UI 编辑，是留给下一个人的谜。有 `allowUiUpdates: false`，UI 直接拒绝——而修法是一次 commit。

## 清理

整套栈就是一个 compose 文件、三份预置 YAML 和一份仪表盘 JSON——输出一到手就删掉：

```bash
$ docker compose down -v && cd ..
```

**Grafana provisioning** 的承诺很小，也很真实：安装从来不是难的部分，难的是决定一个面板回答什么问题，然后把它提交。把 Grafana 指向一个数据源，把数据源和仪表盘都写成代码，那你在一台新机器上重建出来的仪表盘，就是你 review 过的那个仪表盘。
