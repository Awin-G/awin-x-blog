---
title: "Consul 实战：没有 Kubernetes 做服务发现、健康检查与 KV"
description: "一次真实的 Consul 实验：在 127.0.0.1 上跑一个一次性 dev agent，注册一个带 HTTP 健康检查的服务，看着它变成 critical，用 DNS 接口和 HTTP API 查询，再用 Consul KV 存配置——全部是真输出，跑完即拆。"
pubDate: 2027-01-09
lang: zh
translationKey: consul-in-practice
tags: [devops, networking]
featured: false
keywords:
  - Consul
  - 服务发现
  - 健康检查
  - Consul KV
  - DNS 接口
---

每当我看到有人在几台机器、又没有 Kubernetes 的机群上纠结**服务发现**怎么落地，我都会推荐 **Consul**。它提供的东西无聊但好用：一份「谁在跑、在哪跑」的注册表，一套**健康检查**机制告诉消费方哪些实例真的活着，还有一个小型复制的键值存储——**Consul KV**——顺带就是配置中心。它还有第四样东西，**服务网格**，但那只有在服务量和团队规模大到值得为之付费时才用得上；核心部分远比这个简单。我在 `127.0.0.1` 上起了一个一次性的 dev agent，注册了一个挂真实 HTTP 检查的服务，故意把后端弄坏，然后看整个系统怎么跟着变。下面全部是 Consul 2.0.4 的真实输出，用官方二进制跑完就拆——我机器上 Docker Hub 拉不了镜像，不过 HTTP/DNS 接口两种方式完全一样。

## Consul 到底做什么

剥掉营销词，Consul 干四件事：

- **服务注册表。** 服务自己声明：「我是 `web`，住在 `127.0.0.1:8080`，找我。」别的机器不用预先知道它的地址就能找到它。
- **健康检查。** agent 不只是记下注册，还会对它跑检查——HTTP、脚本或 TTL 心跳——把服务标记成 `passing`、`warning` 或 `critical`。消费方可以只接健康的实例。
- **DNS 接口。** 每个服务都能以 `<service>.service.consul`（以及 `<tag>.<service>.service.consul`）被查询，所以任何会发 DNS 查询的客户端都能用服务发现，不需要任何 SDK。
- **Consul KV。** 一棵层级化的键值树，带 compare-and-set，跨 server 复制，走 HTTP 读写。放特性开关、数据库地址这类改了不想重新发版的东西很合适。

**服务网格**（加密、mTLS、重试、服务间路由）属于付费档能力，需要跑 sidecar 或开启 proxy 模式。三到十个服务的规模上它是过度设计，据我所知在二十个服务以下基本用不到。

## 要理解的五个对象

- **Agent（代理）**——跑在每台机器上的进程（客户端 agent），以及达成 quorum 的 server。它持有本机状态、跑检查，并把注册转发给 server。
- **Service（服务）**——一个命名的实例（`web`，ID `web-1`），带地址、端口，以及像 `v1` 这样的可选 tag。tag 就是 DNS 过滤器。
- **Check（检查）**——挂在服务（或节点）上的健康探针。类型有 `http`、`script`、`ttl`。每个检查有一个三态状态，`critical` 是唯一要紧的那个。
- **Catalog（目录）**——server 持有的全集群合并视图：每个节点、服务、检查。想要「真相」而不是某个 agent 的意见时，查它。
- **KV**——键值空间。扁平、按前缀分层，HTTP 上值是 base64，单键上限 512 KB。

## 实验环境：一个一次性的 dev agent

dev agent 就是单节点、内存态的 Consul——测试完美，别指望它给你生产级的持久承诺，而测试环境要的就是这个：

```
$ consul agent -dev -node=lab
==> Starting Consul agent...
            Node name: 'lab'
           Datacenter: 'dc1' (Segment: '<all>')
               Server: true (Bootstrap: false)
          Client Addr: [127.0.0.1] (HTTP: 8500, HTTPS: -1, gRPC: 8502, gRPC-TLS: 8503, DNS: 8600)
          Cluster Addr: 127.0.0.1 (LAN: 8301, WAN: 8302)

$ curl http://127.0.0.1:8500/v1/status/leader
"127.0.0.1:8300"
```

HTTP API 在 `8500`，DNS 在 `8600`。注意此刻缺了什么：在服务注册进来、而且检查通过之前，这个 agent 上一个 DNS 记录都没有。

## 注册一个带 HTTP 健康检查的服务

生产上你会用配置文件或 CLI；HTTP API 是同一件事，而且只需要 `curl`，不需要别的工具：

```
$ curl -X PUT http://127.0.0.1:8500/v1/agent/service/register -d '{
    "Name": "web",
    "ID": "web-1",
    "Tags": ["lab", "v1"],
    "Address": "127.0.0.1",
    "Port": 8080,
    "Check": {
      "HTTP": "http://127.0.0.1:8080/health",
      "Interval": "2s",
      "Timeout": "1s",
      "DeregisterCriticalServiceAfter": "1m"
    }
  }'
$ curl http://127.0.0.1:8500/v1/catalog/services
{ "consul": [], "web": ["lab", "v1"] }
```

空 body、200 状态码——agent 收下了注册，并且立刻开始探测。几秒后，检查就有了结论：

```
$ curl -s http://127.0.0.1:8500/v1/health/service/web |（节选）
[
  {
    "Node": "lab",
    "Service": { "ID": "web-1", "Service": "web", "Tags": ["lab", "v1"], "Address": "127.0.0.1", "Port": 8080 },
    "Checks": [
      { "CheckID": "serfHealth", "Status": "passing", "Output": "Agent alive and reachable" },
      { "CheckID": "service:web-1", "Status": "passing",
        "Output": "HTTP GET http://127.0.0.1:8080/health: 200 OK Output: ok",
        "Type": "http", "Interval": "2s", "Timeout": "1s" }
    ]
  }
]
```

有三个细节值得记住。检查的 `Output` 带着原始结果——一次 GET、一个状态行；失败时原因就读这里，不用猜。`serfHealth` 是节点级检查，总是存在，它区分的是「机器没了」还是「服务病」。而 `Interval`/`Timeout` 决定了消费方多久知道真相——这里是两秒，所有消费方大约两秒内达成一致。

## DNS 接口与 HTTP API

现在到了让它随处可用的部分。Consul 自带 DNS 服务器，`web.service.consul` 是任何客户端都能问的名字——`curl`、浏览器、一个 Postgres 连接串，任何会做解析的东西：

```
$ dig +short web.service.consul            # 这台机器没有 dig，所以换成
$ python3 dnsq.py web.service.consul A      # 一个 40 行的裸 UDP 客户端，同一批字节
A 127.0.0.1 (ttl 0)
$ python3 dnsq.py web.service.consul SRV
SRV -> 127.0.0.1:8080 prio 1 weight 1 (ttl 0)
$ python3 dnsq.py v1.web.service.consul A
A 127.0.0.1 (ttl 0)
$ python3 dnsq.py nope.web.service.consul A
(no records)
```

`A` 记录列出健康实例；`SRV` 记录额外带上端口，所以做注册表的话 `SRV` 才是诚实的原语。前缀加 tag 就能过滤：`v1.web.service.consul` 只匹配带 `v1` tag 的实例，不存在的 tag 解析为空。而 tag 覆盖（`canary.web.service.consul`，即 `enableTagOverride`）让你不搭任何控制面也能做穷人版金丝雀。

对程序化消费方来说，HTTP API 是同一个 catalog 的另一张脸。`catalog` 端点是集群范围的读路径，`agent` 端点是节点本地的；而 `?passing` 是整个 API 里最有用的过滤器，因为它区分的是「注册过」和「能用」：

```
$ curl -s 'http://127.0.0.1:8500/v1/health/service/web?passing'  → 恰好一条，检查 passing
```

## 检查翻车成 critical 时

没有健康检查的注册表，就是一片过时地址的坟场，所以这个实验才是重点。我让后端返回 `503`——最阴间的故障类型：进程明明活着，应用却挂了：

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health
503

# agent 日志里立刻出现：
2026-10-13T04:28:42 [WARN] agent: Check is now critical: check=service:web-1

$ curl -s http://127.0.0.1:8500/v1/health/service/web |（节选）
        "CheckID": "service:web-1", "Status": "critical",
        "Output": "HTTP GET http://127.0.0.1:8080/health: 503 Service Unavailable Output: down"

$ curl -s 'http://127.0.0.1:8500/v1/health/service/web?passing'
[]

$ python3 dnsq.py web.service.consul A
(no records)
```

`critical` 的意思是「别把流量发到这来」，DNS 接口会立刻执行这个决定——名字直接不再解析到该实例，而不是发一个死地址出去。这就是跑检查而不是信任注册的全部意义。注册里的 `DeregisterCriticalServiceAfter: "1m"` 是清理通道：持续 critical 满一分钟的服务会被自动注销——一次烂发布后你肯定想要这个，而两分钟抖动期间你肯定不想——按环境调。后端恢复后，检查自己回到了 `passing`，什么都没重启。

## 用 Consul KV 放配置

KV 是最不性感、用得最多的功能。`PUT` 写（可选 `?cas=` 做 compare-and-set），`GET` 读，值以 base64 返回，前缀分出层级：

```
$ curl -X PUT --data 'db-01.internal:5432' http://127.0.0.1:8500/v1/kv/app/db/host
true
$ curl http://127.0.0.1:8500/v1/kv/app/db/host
[ { "LockIndex": 0, "Key": "app/db/host", "Flags": 0,
    "Value": "ZGItMDEuaW50ZXJuYWw6NTQzMg==", "CreateIndex": 46, "ModifyIndex": 46 } ]

$ curl -s 'http://127.0.0.1:8500/v1/kv/app?recurse' | 解码后
app/db/host    = db-01.internal:5432   (CreateIndex 46)
app/db/timeout = 30s                   (CreateIndex 47)

$ consul kv put app/feature/flags '{"newNav": true}'
Success! Data written to: app/feature/flags
$ consul kv get app/feature/flags
{"newNav": true}
```

`CreateIndex`/`ModifyIndex` 是 Raft 索引——需要顺序和 watch 语义时它们就是原材料：阻塞查询和 watch 会挂起直到索引前进，于是配置消费方是被*推*变更，而不是轮询。KV 上长出来的锁（`?acquire=`/`?release=`）则是给想要 leader election 的人准备的。

## 完整生命周期，一镜到底

我实际跑完的这一轮，放在一张图里：

```
$ consul members
Node  Address         Status  Type    Build  Protocol  DC   Partition  Segment
lab   127.0.0.1:8301  alive   server  2.0.4  2         dc1  default    <all>

# agent 日志，浓缩：
2026-10-13T04:23:06 [INFO] agent: Synced service: service=web-1
2026-10-13T04:28:42 [WARN] agent: Check is now critical: check=service:web-1
2026-10-13T04:30:05 [INFO] agent: Deregistered service: service=web-1

$ curl -X PUT http://127.0.0.1:8500/v1/agent/service/deregister/web-1
$ curl http://127.0.0.1:8500/v1/catalog/services
{ "consul": [] }
```

`consul members` 展示的是 gossip 成员关系——catalog 底下的那一层。注意它全程是 `alive`：节点一直没事，出事的是服务。这个区分才是值得留下来的心智模型。catalog 里会出现 `consul` 自己，是因为 server 也会对自己跑健康检查。

<figure>
<svg viewBox="0 0 680 288" width="100%" role="img" aria-label="服务向 Consul 注册并接受健康检查，消费方通过 DNS 接口只查询到健康实例的示意图。左侧 web-1 与 db-1 两个服务注册到中间的 Consul；Consul 每两秒向 web-1 发 GET /health；右侧客户端查 A 记录 web.service.consul，只拿回 127.0.0.1。">
  <defs>
    <marker id="consul-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="238" y="86" width="204" height="118" rx="14" fill="#0f766e" opacity="0.07" stroke="#0f766e" stroke-width="2.5"/>
  <text x="340" y="114" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="17" font-weight="700">consul</text>
  <text x="340" y="136" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">catalog · 健康检查 · KV</text>
  <text x="340" y="160" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">node lab · dc1 · server</text>
  <text x="340" y="184" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">HTTP :8500 · DNS :8600</text>

  <rect x="30" y="34" width="190" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="46" y="58" fill="#0f766e" font-family="system-ui, sans-serif" font-size="14" font-weight="600">web-1</text>
  <text x="46" y="78" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">127.0.0.1:8080 · passing ✓</text>

  <rect x="30" y="200" width="190" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="46" y="224" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">db-1</text>
  <text x="46" y="244" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">127.0.0.1:5432</text>

  <rect x="470" y="86" width="180" height="118" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="560" y="116" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">client app</text>
  <text x="560" y="138" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">A web.service.consul →</text>
  <text x="560" y="156" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">只拿到健康实例</text>
  <text x="560" y="182" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" font-weight="600">127.0.0.1:8080</text>

  <g fill="none" stroke="#0f766e" stroke-width="2" marker-end="url(#consul-arrow)">
    <line x1="222" y1="62" x2="236" y2="104"/>
    <line x1="222" y1="228" x2="236" y2="184"/>
  </g>
  <text x="232" y="52" text-anchor="end" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">注册</text>

  <line x1="290" y1="206" x2="196" y2="200" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#consul-arrow)"/>
  <text x="243" y="226" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">GET /health 每 2s</text>

  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="468" y1="128" x2="450" y2="128" marker-end="url(#consul-arrow)"/>
    <line x1="440" y1="158" x2="468" y2="158" marker-end="url(#consul-arrow)"/>
  </g>
</svg>
<figcaption>Consul 的两条主数据流：服务注册进来并接受定期健康检查（web-1 的 HTTP 检查挂了，它的 A 记录就消失）；消费方查 DNS，只会拿到健康实例的地址。</figcaption>
</figure>

## Consul 对 etcd：不同的活，重叠的工具

诚实的对比，因为 KV 总让人想把它们放一起比。[etcd 是 KV 加线性一致共识](/zh/posts/consensus-and-etcd/)：一条有序的 Raft 日志、watch 式的读，Kubernetes 就是照着这个模型建起来的。Consul 也有 KV，但重心不一样：

- **etcd** = *控制面数据库*。正确性是线性一致的有序日志；小键；低延迟；存集群状态，不是服务状态。
- **Consul** = *一个恰巧带配置功能的实时注册表*。成员关系用 gossip，注册用 anti-entropy，而且它会说 DNS，客户端不需要装库。它跑检查；etcd 根本不检查你的服务。

如果你的问题是「安全地复制集群自己的状态」，那是 etcd 的活。如果你的问题是「服务 A 现在怎么找到服务 B 的健康实例」，那是 Consul 的活。另外，只跑 Consul 的 server 没有意义——`consul agent -dev` 一个进程就完事，但生产拓扑是 3（或 5）台 server 加每台机器一个 client agent，这才是要称重的真实成本。

## 什么时候你什么都不需要

我能给的最强建议，其实是克制。Consul 值回票价，是在服务的变动和数量超过你脑子装得下的时候。在那条线以下，老实说：

- **十来个地址稳定的服务**——[你自己的解析器上几条 DNS 记录](/zh/posts/self-hosted-dns-resolver/)就够，用 git 版本化，零新增基础设施。
- **只在发布时变的配置**——烤进镜像，或者启动时拉。为一个本该在故障时省事的组件增加一个要在故障时排查的移动部件，不划算。
- **单机**——`localhost` 就是一种服务发现协议。

大致在这些情况下 Consul 开始回本：服务生灭快到改 DNS 跟不上、你想让流量*自动*停止流向坏实例、或者你有许多环境想要同一套配置面。如果是这些情况，上面那一轮——注册、检查、查询、critical、注销——就是它的全部功能，而且视线之内根本不需要 Kubernetes 集群。
