---
title: "Redis Sentinel 与 Redis Cluster：一次真实的故障转移、真实的哈希槽，以及你到底需要哪个"
description: "Redis Sentinel 与 Redis Cluster 的务实对比：用三个 sentinel 跑一次真实故障转移，用三主节点的集群抓一个真实的 MOVED 重定向和 16384 个哈希槽，诚实地算清两者的复杂度代价，以及一份判断你到底需要哪个的决策清单。"
pubDate: 2027-01-11
lang: zh
translationKey: redis-sentinel-vs-cluster
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis Sentinel
  - Redis Cluster
  - 故障转移
  - 哈希槽
  - MOVED
---

人们问「该用 Redis Sentinel 还是 Redis Cluster？」，就像在问「该用锤子还是螺丝刀」——好像这两样是可以互换的。它们不是。**Redis Sentinel** 和 **Redis Cluster** 解决的是两个不同的问题：Sentinel 给的是单节点放得下的数据集上的自动**故障转移**（failover），Cluster 给的是通过**哈希槽**（hash slots）分片实现的水平扩展。大多数服务需要前者；很多从来不需要后者。这两套我都在一次性容器里搭起来跑过（Redis 8.10）：杀掉主节点，看 Sentinel 把副本提拔上来；建一个三主节点的集群，抓一个真实的 `MOVED`。下面每一条输出都来自真实运行。

## 两个问题，不是一个问题

在碰任何工具之前，先把问题定义对：

1. **可用性：** 我的主节点死了。谁去提拔副本、谁去重连其余副本、客户端怎么找到新主节点？这是**故障转移**。数据集仍然只存在于唯一一个主节点上。
2. **容量：** 我的数据集或写吞吐已经装不进一个节点了。再多的故障转移也救不了——数据必须分散到多个节点上。这是**分片**。

Sentinel 回答问题 1。Cluster 回答问题 2，*并且*自带按分片的故障转移。只在需要解决问题 1 时上了 Cluster，是我在 Redis 上见过最常见过度设计。

<figure>
<svg viewBox="0 0 680 330" width="100%" role="img" aria-label="两幅示意图。左：Redis Sentinel——三个 sentinel 进程监视一个主节点和一个副本；主节点死亡时，sentinel 们把副本提拔为新的主节点。右：Redis Cluster——一个键经 CRC16 对 16384 取余映射到一个哈希槽，每个槽区间归属一个特定的主节点。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="30" y="28" font-weight="600" font-size="14">Sentinel：故障转移，单一逻辑主节点</text>
    <g>
      <rect x="30" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="61" y="65" text-anchor="middle" font-size="12">S1</text>
      <rect x="100" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="131" y="65" text-anchor="middle" font-size="12">S2</text>
      <rect x="170" y="46" width="62" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="201" y="65" text-anchor="middle" font-size="12">S3</text>
    </g>
    <text x="252" y="65" font-size="11" opacity="0.75">quorum 2/3</text>
    <rect x="40" y="130" width="88" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.55"/>
    <text x="84" y="150" text-anchor="middle" font-size="12">主节点</text>
    <text x="84" y="166" text-anchor="middle" font-size="11" opacity="0.6">（被杀）</text>
    <rect x="170" y="130" width="88" height="44" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="214" y="150" text-anchor="middle" font-size="12" fill="#0f766e" font-weight="600">副本</text>
    <text x="214" y="166" text-anchor="middle" font-size="11" opacity="0.7">升为新主</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none">
      <path d="M61 76 L70 130" stroke-dasharray="4 3"/>
      <path d="M131 76 L140 130" stroke-dasharray="4 3"/>
      <path d="M201 76 L210 130" stroke-dasharray="4 3"/>
    </g>
    <path d="M214 118 L90 118" stroke="#0f766e" stroke-width="2" fill="none" marker-end="url(#arrowTeal)"/>
    <text x="152" y="112" text-anchor="middle" font-size="11" fill="#0f766e">提拔</text>
    <text x="30" y="210" font-size="11" opacity="0.75">客户端向 sentinel 询问主节点地址；</text>
    <text x="30" y="228" font-size="11" opacity="0.75">数据集始终只在唯一一个节点上。</text>
    <line x1="330" y1="20" x2="330" y2="300" stroke="currentColor" stroke-width="1" opacity="0.25"/>
    <text x="360" y="28" font-weight="600" font-size="14">Cluster：按哈希槽分片</text>
    <rect x="360" y="46" width="104" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="412" y="65" text-anchor="middle" font-size="12">键 “cart:7”</text>
    <rect x="486" y="46" width="150" height="30" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="561" y="65" text-anchor="middle" font-size="11">CRC16 mod 16384</text>
    <path d="M464 61 L486 61" stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrowTeal)"/>
    <g>
      <rect x="360" y="110" width="130" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="425" y="131" text-anchor="middle" font-size="11">M1：槽 0–5460</text>
      <rect x="360" y="152" width="130" height="34" rx="6" fill="none" stroke="#0f766e" stroke-width="2"/>
      <text x="425" y="173" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="600">M2：5461–10922</text>
      <rect x="360" y="194" width="130" height="34" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="425" y="215" text-anchor="middle" font-size="11">M3：10923–16383</text>
    </g>
    <text x="510" y="110" font-size="11" opacity="0.75">槽 9546 → M2</text>
    <path d="M561 76 L561 131" stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#arrowTeal)"/>
    <path d="M561 131 L490 152" stroke="#0f766e" stroke-width="2" fill="none" marker-end="url(#arrowTeal)"/>
    <text x="360" y="252" font-size="11" opacity="0.75">每个键恰好住在一个主节点上；</text>
    <text x="360" y="270" font-size="11" opacity="0.75">问错节点，它会用 MOVED 指路。</text>
    <defs>
      <marker id="arrowTeal" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="context-stroke"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>两种解法，两种形状：机器死掉时，Sentinel 搬动的是「角色」；Cluster 搬动的是「键」，好让任何一台机器都不必把它们全扛在手里。</figcaption>
</figure>

## Redis Sentinel：只做故障转移，不做分片

Sentinel 是独立进程——最好是三个——只做三件事：**监控**（主节点还在应答吗？）、**故障转移**（不在时提拔一个副本并重连其余副本）、**配置发现**（告诉客户端现在的主节点是谁）。它保持单一逻辑主节点；你的数据永远不切分。

### 搭建：一个主节点、一个副本、三个 sentinel

```bash
$ docker run -d --name r-primary --network redis-ha -p 127.0.0.1:6379:6379 redis:8-alpine
$ docker run -d --name r-replica --network redis-ha redis:8-alpine redis-server --replicaof r-primary 6379
```

每个 sentinel 拿一个自己的配置文件：

```bash
port 26379
sentinel monitor mymaster 172.19.0.2 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
```

结尾那个 `2` 就是 **quorum（法定人数）**：多少个 sentinel 认同「主节点挂了」，才允许启动一次故障转移。我跑了三个 sentinel，然后问其中一个它都知道什么：

```text
$ docker exec s1 redis-cli -p 26379 SENTINEL master mymaster   # selected fields
flags	master
down-after-milliseconds	5000
num-slaves	1
num-other-sentinels	2
quorum	2
failover-timeout	10000
parallel-syncs	1
```

我在主节点上写了 `SET pricing:hot "19.99"`，并从副本上读回了它；副本的 `INFO replication` 显示 `role:slave`、`master_host:172.19.0.2`、`master_link_status:up`。

### 杀掉主节点：Sentinel 到底做了什么

然后 `docker kill r-primary`——SIGKILL，没有优雅退出。与此同时一个一次性客户端在跑循环：问 Sentinel 当前主节点是谁、从它那里 `GET pricing:hot`、睡一秒、再重复。两边的日志各取一段：

```text
22:18:15 master=172.19.0.2:6379 -> 19.99        <- 客户端，健康
22:18:16 master=172.19.0.2:6379 -> 19.99        <- 杀之前最后一次成功
22:18:59 master=172.19.0.2:6379 -> Could not connect to Redis at 172.19.0.2:6379: Host is unreachable
22:19:00 master=172.19.0.3:6379 -> 19.99        <- 新主节点，数据没丢
22:19:01 master=172.19.0.3:6379 -> 19.99
```

客户端从来没有重连一个硬编码 IP 然后听天由命——每一轮它都执行 `SENTINEL get-master-addr-by-name mymaster` 并用返回的地址。这就是集成的全部契约。注意 22:18:16 → 22:18:59 的空档：那不是客户端在礼貌重试，是到死 IP 的连接一直挂到内核放弃为止——生产客户端行为完全一样，除非你把超时设短、并对重新发现的地址做重试。

Sentinel 自己的日志，同一时刻，把这次故障转移按顺序记了下来：

```text
22:18:21.936 # +sdown master mymaster 172.19.0.2 6379
22:18:22.012 # +odown master mymaster 172.19.0.2 6379 #quorum 2/2
22:18:22.012 # +try-failover master mymaster 172.19.0.2 6379
22:18:22.013 # +vote-for-leader 0739ae1b00fe75351dd41f3ecbae101f43ad16e0 1
22:18:22.089 # +elected-leader master mymaster 172.19.0.2 6379
22:18:22.089 # +failover-state-select-slave master mymaster 172.19.0.2 6379
22:18:22.173 # +selected-slave slave 172.19.0.3:6379 172.19.0.3 6379 @ mymaster 172.19.0.2 6379
22:18:23.049 # +failover-state-reconf-slaves master mymaster 172.19.0.2 6379
22:18:23.120 # +switch-master mymaster 172.19.0.2 6379 172.19.0.3 6379
```

按顺序读这条链：一个 sentinel 看到沉默（`+sdown`），第二个表示同意（`+odown ... #quorum 2/2`），sentinel 们选出一个唯一的指挥者（`+elected-leader`）以免多方同时动手，它挑出最好的副本（`+selected-slave`）并对其发送 `SLAVEOF NO ONE`——在 `INFO replication` 里就可见 `role:master`。`+switch-master` 是外界得知新地址的时刻。检测花掉了配置的 5 秒（22:18:16 杀，22:18:21.9 `+sdown`），选举加提拔又花了约 1 秒。可调的旋钮是 `down-after-milliseconds` 和 `failover-timeout`。

Sentinel 还主动收拾了残局。老主节点后来回来了——`docker start r-primary`——Sentinel 把它重配成了新主节点的副本，并用 `CONFIG REWRITE` 持久化这个重配，使它在重启后依然生效：

```text
$ docker exec r-primary redis-cli INFO replication
# Replication
role:slave
master_host:172.19.0.3
master_link_status:up
```

在它上面 `GET pricing:hot` 返回 `19.99`——杀之前写的键活了下来，因为复制早已把它送到后来被提拔的那个节点：Sentinel 搬动的是*角色*，副本的数据就此成为主节点的数据。新主节点的 `master_replid2` 还带着老主节点的复制 ID（`5c5d4fd4...`），这正是回来的节点能从部分重同步（partial resync）恢复、而不是全量重拷的原因。

### Quorum：为什么是三个 sentinel

Quorum 是算术开始咬人的地方。**三个 sentinel、quorum 2**，你扛得住一个 sentinel 死亡（剩 2 个，仍是多数），并且在它缺席期间依然能发起故障转移。单个 sentinel 则是由一个单点来决定你数据库的命运：一旦它失去网络，它会乐呵呵地「故障转移」，而真正的主节点活得好好的——于是你有两个写节点。用奇数：小规模 3 个，跨故障域铺开时 5 个。尽量别把它们和 Redis 节点放同一台机器上，并记住它们很便宜：每个只吃几 MB 内存。

### 客户端要做什么：发现，而不是魔法

Sentinel 不是代理——客户端必须参与：订阅 `+switch-master` 的 pub/sub 事件，轮询 `SENTINEL get-master-addr-by-name`（我的循环就是这么干的），或者用内置 Sentinel 支持的客户端库（redis-py、Lettuce、Jedis 都有）。副本在你显式指向它时会提供读服务；Sentinel 不会替你路由读请求。

## Redis Cluster：哈希槽与真正的扩展

Cluster 是另一种动物：每个节点都是一个分片，数据按键切分，故障转移按分片自动发生，不需要 Sentinel 掺和：

```bash
$ docker run -d --name c1 --network redis-cluster redis:8-alpine \
    redis-server --cluster-enabled yes --cluster-config-file nodes.conf --port 6379 \
    --cluster-node-timeout 2000 --appendonly yes
# ... c2、c3 完全相同 ...
$ docker run --rm --network redis-cluster redis:8-alpine \
    redis-cli --cluster create c1:6379 c2:6379 c3:6379 --cluster-replicas 0 --cluster-yes
>>> Performing hash slots allocation on 3 nodes...
Master[0] -> Slots 0 - 5460
Master[1] -> Slots 5461 - 10922
Master[2] -> Slots 10923 - 16383
[OK] All 16384 slots covered.
```

### 16384 个槽，一次性分配

键空间被切成 **16384 个哈希槽**。键的槽位是 `CRC16(key) mod 16384`——确定性、无查找表、每个节点算出的结果一致。每个槽恰好被一个主节点拥有，`CLUSTER NODES` 把这张映射写了下来：

```text
$ docker exec c1 redis-cli CLUSTER NODES
b8fd1c3704e73068b973a040765dffbc716fb257 172.22.0.4:6379@16379 master - 0 1791843648095 3 connected 10923-16383
c720456a5d1f451edbbbe167f0b9f98643284129 172.22.0.3:6379@16379 master - 0 1791843648196 2 connected 5461-10922
d4133a12f6cb7164bc933f690241134b5931e040 172.22.0.2:6379@16379 myself,master - 0 0 1 connected 0-5460

$ docker exec c1 redis-cli CLUSTER INFO
cluster_state:ok
cluster_slots_assigned:16384
cluster_slots_ok:16384
cluster_known_nodes:3
cluster_size:3
```

`CLUSTER INFO` 是健康读数的门面：`cluster_state:ok` 意味着每个已分配的槽都有一个能干活的拥有者。`@16379` 那些端口是集群总线（cluster bus）——节点之间互相监视、自行执行按分片故障转移的 gossip 通道。

### 一个真实的 MOVED 重定向

下面是人人都会引用、却很少真跑的那部分。拿一个键，问它哈希到哪个槽，然后把它发给不拥有该槽的节点：

```text
$ docker exec c1 redis-cli CLUSTER KEYSLOT cart:7
9546
$ docker exec c1 redis-cli SET cart:7 "3 items"
MOVED 9546 172.22.0.3:6379
$ docker exec c1 redis-cli -c SET cart:7 "3 items"
OK
$ docker exec c2 redis-cli GET cart:7
"3 items"
```

那句 `MOVED 9546 172.22.0.3:6379` 是协议在永久性地告知：槽 9546 住在 172.22.0.3，别再问我。`redis-cli -c` 会跟随重定向并缓存映射；智能客户端库做同样的事，并在收到 `MOVED` 时刷新。在 rehash 进行中你可能会看到 `ASK`，那是临时的——「这个键正在迁移，请把这一条请求发给目标节点，但映射本身没变」。

### 多键操作与 CROSSSLOT 这堵墙

这是决定大多数「我能上 Cluster 吗」的约束。一个原子操作里的键必须落在同一个槽，因为命令在单个节点上执行：

```text
$ docker exec c1 redis-cli MSET user:1000 alex cart:7 x
CROSSSLOT Keys in request don't hash to the same slot
$ docker exec c1 redis-cli CLUSTER KEYSLOT user:1000
1649
$ docker exec c1 redis-cli CLUSTER KEYSLOT cart:7
9546
```

`GET`、`SET`、`INCR` 在哪都行——每个键各自路由到自己的主人。但 `MSET`、多键的 `MGET`/`DEL`、`SUNION`、Lua 脚本，以及跨键的 `MULTI`/`EXEC` 事务，全都要求同一个槽。逃生门是 **hash tag**：只有花括号内的子串参与哈希，于是你可以有意把键放在一起。

```text
$ docker exec c1 redis-cli CLUSTER KEYSLOT '{cart}:7'
15997
$ docker exec c1 redis-cli CLUSTER KEYSLOT '{cart}:8'
15997
$ docker exec c1 redis-cli -c MSET '{cart}:7' '3 items' '{cart}:8' '1 item'
OK
$ docker exec c1 redis-cli -c MGET '{cart}:7' '{cart}:8'
1) "3 items"
2) "1 item"
```

分片就是分片。我的集群最后只有两个键——c1 上的 `session:42`、c2 上的 `cart:7`——`KEYS *` 在每个节点上只返回自己的那一份。没有任何命令能列出整个集群的键：要么逐个节点访问，要么用会扇出查询的客户端。

## 诚实地算账

**Sentinel 的实话：** 多三个要跑要监控的进程；故障转移期间有一段真实的短 outage——按秒算，且除非客户端选择等待，在途写入会丢；完全没有扩展性故事，主节点仍是吞吐天花板。换来的是：客户端语义照旧、没有重定向、没有数据模型约束，读还能靠加副本扩展。备份和持久化仍是你独立的问题：Sentinel 会一丝不苟地把一次糟糕的 `DELETE` 也复制过去（见[真正有用的 Redis 模式](/zh/posts/redis-patterns/)）。

**Cluster 的实话：** 生产上最小合理形态是六个节点（3 主 + 3 从）；必须用支持集群的客户端（重定向处理、槽位映射缓存、分节点连接池），否则什么都跑不起来；槽模型限制了多键语义，并且这限制会渗进你的 schema（到处是 `{user}:1` 风格的键）；运维多出新的失效模式——reshard 是一次你需要认真规划的真实迁移，故障转移按分片走所以故障暴露得不均匀，每个节点的内存都成了硬规划数字。买到的是：内存和写吞吐随加分片线性扩展，以及不需要第二套系统的自动故障转移。而如果悬而未决的问题是「你到底需不需要 Redis」，那个对比在[Redis vs Memcached](/zh/posts/redis-vs-memcached/)——HA 是排在它下游的问题。

## 你到底需要哪个

一份决策清单，按大多数服务应该走的顺序排列：

- **单节点，外加备份，外加像样的持久化设置。** 如果数据集装得进一台机器的内存、keyspace 是可重建的（缓存、限流器、session 存储）、崩溃后停机几分钟可以接受——你就可以收工了。落盘的 RDB/AOF 胜过一套你从不演练的第二套守护进程。
- **Sentinel，当你要的是可用性而容量不是。** 几秒内故障转移，数据集仍放得下单节点。写全落在一个主节点上，所以按「转移窗口会丢在途命令」来做设计。用 3 个 sentinel、quorum 2，`down-after-milliseconds` 设为正常 ping RTT 的 2–5 倍，免得一次网络抖动就触发转移，并让客户端去发现主节点而不是硬编码。
- **Cluster，当你真的长出了一个节点装不下的东西——内存或吞吐，而不是恐惧。** 承诺之前的检查单：数据集稳稳超过单节点内存（或写把它打满），访问模式是单键或可 hash tag 化的，你的客户端库是真的支持集群模式，并且有人会负责 rehash 和换节点。这四条里任何一条不成立，这个集群造成的宕机会比它防的机器死亡更多。

顺序很重要，因为每一步买到的都是不同性质的东西，代价也不同：备份买耐久，Sentinel 买可用，Cluster 买容量。只为你缺的那项付钱——昂贵的错误，是在缺可用性时买了容量，或者在缺耐久时买了他俩中的任何一个。
