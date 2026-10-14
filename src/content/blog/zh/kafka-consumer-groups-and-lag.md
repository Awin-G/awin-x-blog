---
title: "Kafka 消费者组与 lag：那个告诉你正在落后的数字"
description: "Kafka 消费者组把 topic 的分区分给组内各消费者，各自提交 offset；consumer lag 就是已提交 offset 与日志末尾之间的差。我用一个一次性单 broker KRaft 集群跑出真实输出：lag 增长、一次真实的 rebalance，以及重置 offset。"
pubDate: 2027-02-09
lang: zh
translationKey: kafka-consumer-groups-and-lag
tags: [devops, self-hosting]
featured: false
keywords:
  - Kafka 消费者组
  - consumer lag
  - kafka-consumer-groups
  - rebalance
  - offset
---

**Consumer lag**（消费滞后）是唯一一个能告诉你 Kafka 消费者是否跟上了的数字——而它恰恰是没人看、直到事情已经烧起来才被想起来的那个数字。一个 **Kafka 消费者组**是一组共同承担读取同一个 topic 工作的消费者：topic 的分区在它们之间分配，每个成员提交一个 **offset** 表明自己读到了哪儿。lag 就是 `LOG-END-OFFSET - CURRENT-OFFSET`，按分区算。当它开始往上爬，你就在落后——而**变化速率**比绝对值更重要。

我在 [Kafka 实战：它是日志，不是队列](/zh/posts/kafka-in-practice/) 里论证过 Kafka 是日志而不是队列，在[消息队列选型指南](/zh/posts/message-queues/) 里论证过你到底要不要一个 broker。这篇是架在上面的运维层：消费者组到底在干什么、怎么读 `kafka-consumer-groups --describe`、lag 为什么涨、一次 **rebalance** 要付出什么代价，以及挖了坑之后怎么重置 offset。下面每一条输出都来自一个一次性的单 broker KRaft 集群（`apache/kafka:3.9.0`），原样贴出。

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --create --topic orders --partitions 3 --replication-factor 1
Created topic orders.
```

三个分区，一个 broker。这是本文余下部分的全部拓扑——同时也是这个 topic 在并行度上永远无法突破的硬上限。

## Kafka 消费者组到底是什么

消费者组就是在一个**名字**下对 topic 的订阅。每个用同一个 `group.id` 加入的消费者都成为一个成员，broker 上的 group coordinator 负责把分区分发下去，使得**每个分区在同一时刻只被组内一个成员拥有**。规则就这一条，而它有一个巨大的后果：组内的并行度上限就是分区数。三个分区，就意味着最多只有三个消费者在干实事。

我往 `orders` 生产了 12 条带 key 的消息——它们均匀散开，每个分区 4 条——然后用组 `dlt-worker` 里的单个消费者把它们全部消费掉：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker

Consumer group 'dlt-worker' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
dlt-worker      orders          0          4               4               0
dlt-worker      orders          1          4               4               0
dlt-worker      orders          2          4               4               0
```

每个分区 `LAG 0`，而 `has no active members` 是因为消费者消费完就正常退出了。下一个加入的消费者会从这些已提交的 offset 继续——而不是从头开始。这就是消费者组的全部契约，一张表说完了。

现在看看把组**横向扩容**会发生什么。我重启消费者让它追平，然后一次加一个成员，直到有四个：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker --members

GROUP           CONSUMER-ID                                           HOST            CLIENT-ID        #PARTITIONS
dlt-worker      console-consumer-f4088647-6dcd-4ad7-bad6-ccf33240f6a4  /127.0.0.1      console-consumer  0
dlt-worker      console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1      console-consumer  1
dlt-worker      console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1      console-consumer  1
dlt-worker      console-consumer-48e42eb9-eb8a-4a90-8dbe-f0c428571b26  /127.0.0.1      console-consumer  1
```

四个消费者，三个分区，而 `console-consumer-f4088647…` 的 `#PARTITIONS` 是 `0`。它加入了组、它在心跳、它在烧 CPU——而它永远处理不了一条消息。**给一个已经顶到分区上限的组加消费者，除了成本什么都买不到。** 正确的做法是加分区，而不是加消费者；而分区只能增加、永远不能删除，所以这个选择近乎永久：已存在的 key 会继续哈希到它原来的分区，因此重新分区意味着一个新 topic、一段双写期和一次切换。

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="一个含三个分区的 Kafka topic 被分给同一组内的两个消费者。每个分区条大部分已消费并提交，右端带斜纹的尾巴就是 consumer lag，即最后一个已提交 offset 与日志末尾之间的差。">
  <defs>
    <marker id="cgar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <pattern id="cglag" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="7" stroke="#0f766e" stroke-width="2" stroke-opacity="0.4"/>
    </pattern>
  </defs>

  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="12" y="16">topic: orders</text>
    <text x="120" y="16" opacity="0.6">3 个分区 · 组 dlt-worker</text>
  </g>

  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="currentColor">
    <text x="12" y="52" opacity="0.8">p0</text>
    <rect x="48" y="40" width="200" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="248" y="40" width="72" height="16" fill="url(#cglag)"/>
    <rect x="48" y="40" width="200" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="248" y="40" width="72" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="256" y="72" opacity="0.65">已提交</text>
    <text x="336" y="72" fill="#0f766e">LAG</text>

    <text x="12" y="122" opacity="0.8">p1</text>
    <rect x="48" y="110" width="140" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="188" y="110" width="132" height="16" fill="url(#cglag)"/>
    <rect x="48" y="110" width="140" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="188" y="110" width="132" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="196" y="142" fill="#0f766e">LAG</text>

    <text x="12" y="192" opacity="0.8">p2</text>
    <rect x="48" y="180" width="276" height="16" fill="#0f766e" fill-opacity="0.16"/>
    <rect x="324" y="180" width="60" height="16" fill="url(#cglag)"/>
    <rect x="48" y="180" width="276" height="16" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
    <rect x="324" y="180" width="60" height="16" fill="none" stroke="#0f766e" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="332" y="212" fill="#0f766e">LAG</text>
  </g>

  <g fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2">
    <path d="M150 66 C150 110 70 160 70 232" marker-end="url(#cgar)"/>
    <path d="M250 142 C265 190 290 210 295 232" marker-end="url(#cgar)"/>
    <path d="M200 208 C200 222 160 220 150 232" marker-end="url(#cgar)"/>
  </g>

  <g fill="none" stroke="currentColor" stroke-opacity="0.5">
    <rect x="12" y="234" width="150" height="48" rx="8"/>
    <rect x="220" y="234" width="150" height="48" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" text-anchor="middle">
    <text x="87" y="254">消费者 A</text>
    <text x="87" y="271" opacity="0.65">拥有 p0, p2</text>
    <text x="295" y="254">消费者 B</text>
    <text x="295" y="271" opacity="0.65">拥有 p1</text>
  </g>
</svg>
<figcaption>FIG. 1 — 一个组、三个分区、两个消费者。每个分区只被一个成员拥有，lag 就是每条分区右端未被读取的尾巴。这个 topic 上的第三、第四个消费者会拿到零个分区。</figcaption>
</figure>

## Offset、COMMITTED 与 LOG-END，以及 lag 从哪来

Offset 是分区内单调递增的整数——只追加日志里的位置。一个消费者会跟踪其中两个：

- **CURRENT-OFFSET** 是组最后一次*提交*的 offset。它是那个持久书签：如果所有消费者此刻全死，重启后的消费者就从这里继续。
- **LOG-END-OFFSET** 是下一条将被追加的记录的 offset——也就是此刻日志的头部。

**Consumer lag 就是这两者之差**，按分区算，没有别的含义。`LAG 0` 不意味着"没活干"，只意味着"在这一刻追平了"。`LAG 600` 意味着有六百条记录已经落进日志，而这个组还没有提交过它们。

提交是一个独立于读取的决定，默认是每五秒自动提交一次——这就是为什么刚消费的数据仍可能显示几秒 lag，也是为什么"已处理"与"已提交"之间崩溃一次的代价是至少一次重投，而不是静默丢失。先处理、后提交，这个顺序不能反。

## 读懂 `kafka-consumer-groups --describe`

这就是那个工具，而且它差不多就是你需要的大部分仪表盘：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker --state

GROUP                     COORDINATOR (ID)          ASSIGNMENT-STRATEGY  STATE     #MEMBERS
dlt-worker                localhost:9092  (1)                            Stable   1
```

加 `--members` 看谁拥有什么，加 `--export` 拿机器可读的输出。普通的 `--describe` 输出里要读三样东西：**每个分区的 LAG**（永远不要只看总和——一个热分区会躲在健康分区后面）、**CONSUMER-ID** 列（`-` 表示这个组根本没有任何活跃成员），以及组的 **STATE**（`Stable`、`Empty`、`PreparingRebalance`、`CompletingRebalance`、`Dead`）。一个卡在 `PreparingRebalance` 的组，正在一边争论归属一边什么都不消费。

## 是什么让 consumer lag 增长

我彻底停掉消费者，又生产了十八条消息。没有任何人去提交它们：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker

Consumer group 'dlt-worker' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
dlt-worker      orders          0          4               10              6
dlt-worker      orders          1          4               10              6
dlt-worker      orders          2          4               10              6
```

十八条消息，每个分区 `LAG 6`。实际重要的四个原因：

1. **消费者停了或崩了。** 如果整个组都没了，没有任何东西提交，lag 就沿一条直线增长。就是上面那张表。
2. **处理速率低于到达速率。** 下游慢、一把锁、GC 停顿、每条记录一次 N+1 查询。这是最阴险的那个——它从不像是事故，直到它真的是。
3. **突发流量。** 我在一个健康消费者在线时，两秒内生产了 3,000 条消息，并抓住了它消费到一半的样子：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group dlt-worker
dlt-worker      orders     0     8312     8912     600
dlt-worker      orders     1     16612    17812    1200
dlt-worker      orders     2     16612    17812    1200
```

一条平稳的 `LAG 0` 冲到 3,000 又在半分钟内归零，这不是事故——这是一个健康的消费者在吸收一次突发。这正是**要按变化速率而不是绝对值告警**的原因：一个没有斜率的 lag 数字，信息量和一张没有时间轴的 CPU 图差不多。

4. **分区数少于你已经在跑的消费者。** 如果组已经顶到分区上限，扩容部署毫无作用，剩下的唯一手段就是重新分区。

## Rebalance：什么会触发它，以及它的代价

只要组成员或订阅发生变化就会发生 rebalance：消费者加入、消费者离开、消费者的 `session.timeout.ms` 超时、有人订阅了额外的 topic，或者分区数变了。组必须就新的分配达成一致，而在达成一致期间它不消费任何东西。

这是一次真实的。一个消费者 `console-consumer-9b53099e…` 拥有全部三个分区；然后我启动了第二个 `console-consumer-793325b8…`。前后对比直接来自 `--describe`：

```text
# 之前 — 一个消费者拥有全部
dlt-worker      orders     0     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
dlt-worker      orders     1     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
dlt-worker      orders     2     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1

# 之后 — 第二个消费者加入
dlt-worker      orders     0     10     10     0     console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1
dlt-worker      orders     1     10     10     0     console-consumer-793325b8-a341-47d9-8bd5-62fea2cd7f41  /127.0.0.1
dlt-worker      orders     2     10     10     0     console-consumer-9b53099e-df87-4e13-9e9b-b28b615c96bc  /127.0.0.1
```

粘性分配器尽量保留了原有归属：`9b53099e` 保住了 `orders-2`，新来的拿走 `orders-0` 和 `orders-1`。而从第一个消费者自己的日志看——这次暂停，用它自己的话：

```text
[2026-10-14 06:53:28,156] INFO Revoke previously assigned partitions orders-0, orders-1, orders-2
    (org.apache.kafka.clients.consumer.internals.ConsumerRebalanceListenerInvoker)
[2026-10-14 06:53:28,159] INFO Successfully joined group with generation
    Generation{generationId=4, memberId='console-consumer-9b53099e-...', protocol='range'}
[2026-10-14 06:53:28,160] INFO Finished assignment for group at generation 4:
    {console-consumer-9b53099e-...=Assignment(partitions=[orders-2]),
     console-consumer-793325b8-...=Assignment(partitions=[orders-0, orders-1])}
[2026-10-14 06:53:28,163] INFO Adding newly assigned partitions: orders-2
```

注意 `Revoke previously assigned partitions orders-0, orders-1, orders-2`。在默认的** eager（抢占式）** 协议下，每个成员都要在新分配下发之前放弃*全部*分区。消费者停止 poll，在途的工作被丢弃，然后它重新加入、拿到一次 generation 递增（`generationId=4`），并为它现在拥有的分区重新拉取已提交的 offset。消费不是变慢；是直接停摆，停满整个过程。

有两个值得知道的缓解手段。**协同式 rebalance**（`partition.assignment.strategy=CooperativeStickyAssignor`，或现代客户端上的 `consumer` 组协议）只会撤销真正要移动的分区，未受影响的分区继续不停地流。**静态组成员**（`group.instance.id`）让一个快速重启的消费者带着原来的分配重新加入，完全跳过 rebalance——这正是逐个滚动发布实例时你想要的东西。

要担心的故障模式是 rebalance 风暴：消费者因为 GC 停顿或长批次超过 `session.timeout.ms` 而不断超时，于是组 rebalance，这又让它们更慢，于是再次超时。按你最慢的那个批次诚实地设定 `max.poll.interval.ms`，并且把 rebalance 速率当成一级告警。

## Offset 存在哪里：`__consumer_offsets` 与协调者

没有什么魔法。已提交的 offset 是一个内部紧凑主题 `__consumer_offsets` 里的记录，而每个组通过对组名做哈希被钉在它五十个分区中的某一个上。那个分区的 leader 就是这个组的**协调者**——负责仲裁成员资格并保存组状态的 broker。

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --describe --topic __consumer_offsets
Topic: __consumer_offsets   TopicId: 2Pz8USrWTpC5_kwEZ1Zhcw   PartitionCount: 50
    ReplicationFactor: 1   Configs: compression.type=producer,cleanup.policy=compact,segment.bytes=104857600
```

`cleanup.policy=compact` 意味着 broker 对每个 key 只永久保留最新的那次提交——这就是为什么几周后重启一个组，它还能从当初停下的地方精确继续。`--describe --state` 里的 `COORDINATOR (ID)` 列，就是这个分区的 leader。我扫描了全部五十个分区，只打印那些记录里提到我们这个组的：

```text
$ for p in $(seq 0 49); do
>   n=$(docker exec kafka-lag-demo /opt/kafka/bin/kafka-console-consumer.sh \
>         --bootstrap-server localhost:9092 --topic __consumer_offsets --partition $p \
>         --offset earliest --timeout-ms 3000 --property print.key=true 2>/dev/null \
>       | strings | grep -c dlt-worker)
>   [ "$n" != "0" ] && echo "partition $p -> $n records mention dlt-worker"
> done
partition 25 -> 1029 records mention dlt-worker

$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-get-offsets.sh \
    --bootstrap-server localhost:9092 --topic __consumer_offsets
__consumer_offsets:25:1050
```

在单 broker 下，`localhost:9092 (id=1)` 是协调者，因为它领导着每一个分区。无论集群多大，有两条运维后果：`__consumer_offsets` 是你要盯的 broker 磁盘增长来源；而如果承载某个热组协调者的 broker 挂掉，落在那个分区上的每一个组都会 rebalance。

## `auto.offset.reset` 与手动重置 offset

`auto.offset.reset` 决定的是：当一个消费者对某个分区**没有已提交 offset** 时怎么办——全新的组，或者 offset 已经从 `__consumer_offsets` 里过期被清掉。默认值 `latest` 意味着"从日志头部开始"，这会静默跳过已经存在的一切。我用两个新组去读一个已经有 36 条未读消息的 topic，证明了这一点：

```text
# 组 'reporting'，auto.offset.reset=latest（默认值）
Processed a total of 0 messages
$ ... --describe --group reporting
reporting      orders     0     12     12     0
reporting      orders     1     12     12     0
reporting      orders     2     12     12     0

# 组 'backfill'，auto.offset.reset=earliest
Processed a total of 36 messages
$ ... --describe --group backfill
backfill      orders     0     12     12     0
backfill      orders     1     12     12     0
backfill      orders     2     12     12     0
```

零条对三十六条。如果你想让新组读历史，设 `auto.offset.reset=earliest` 并接受那一次性的重放；如果你只想让它看新流量，`latest` 就是对的。陷阱在于你不知道自己拿到的是哪一个。

当 offset 干脆就是错的，就用 `kafka-consumer-groups.sh` 重置。**组必须处于停止状态**，而默认行为是一次演练——这正是你在动生产环境的 offset 之前想要的安全带：

```text
$ docker exec kafka-lag-demo /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --group dlt-worker --topic orders \
    --reset-offsets --to-earliest --dry-run

GROUP           TOPIC           PARTITION   NEW-OFFSET
dlt-worker      orders          0           0
dlt-worker      orders          1           0
dlt-worker      orders          2           0
```

```text
# 同一条命令，把 --dry-run 换成 --execute
GROUP           TOPIC           PARTITION   NEW-OFFSET
dlt-worker      orders          0           0
dlt-worker      orders          1           0
dlt-worker      orders          2           0
```

执行之后，组在每个分区上都停在 `LAG 12`，下一个启动的消费者会重放整个 topic。其他可用的规格还有 `--to-latest`（"这个积压我放弃了"按钮）、`--to-datetime`、`--by-duration`、`--to-offset`、`--shift-by N`，以及 `--from-file`（用一份存好的 CSV 精确驱动重放）。我真实踩到的一个尖角：`--to-latest` 和 `--shift-by` 不能组合使用，而这个工具告诉你的方式是把你整份帮助文档倒出来。

## 诚实的运维建议

- **按分区告警 lag，并且告警它的变化速率。** 一个分区 50,000 且在下降，没问题；一个分区 500 且涨了一小时，有问题。总和会掩盖真正重要的那个分区。
- **告警 rebalance 速率。** 一个稳定的部署每小时超过几次，说明你的超时设错了，而不是 Kafka 坏了。
- **需要吞吐就加分区，而不是加消费者**——而且要早、要有意识地做，因为分区删不掉，而给带 key 的 topic 重新分区会毁掉你原本依赖的顺序保证。
- **永远不要把 `auto.offset.reset` 当恢复手段。** 它只在无事可续的情况下生效；一个已提交 offset 错的组，需要一次深思熟虑的 `--reset-offsets`。
- **盯住 `__consumer_offsets` 的磁盘增长**，以及你自己那个导出 lag 的消费者的 lag。一个落后了的监控消费者，比没有监控更糟。

`kafka-consumer-groups --describe` 不是事故时才翻出来的调试工具。它是你将会运行的每一个流式系统的首要健康信号，而且它只有一条命令那么长。
