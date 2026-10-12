---
title: "Kafka 实战：它是日志，不是队列（而这改变了一切）"
description: "Kafka 不是队列——它是一个只追加、可分区的日志，配上消费者 offset，而这一个差别解锁了重放与多组彼此独立的消费者。我用一个一次性、单 broker、KRaft 模式的集群跑了真实的 topic 创建、消费者组 offset、rebalance 与日志压实，输出原样贴出，并诚实交代它什么时候是过度设计。"
pubDate: 2026-12-17
lang: zh
translationKey: kafka-in-practice
tags: [devops, networking]
featured: false
keywords:
  - Kafka
  - Kafka 消费者组
  - Kafka 分区
  - 事件流
  - KRaft
---

**Kafka** 不是队列，而这一句话就解释了围绕它的绝大部分困惑。传统队列把一条消息交给一个 worker 就让它消失；Kafka 保留一个只追加的**日志**，许多互相独立的读者——每一个**Kafka 消费者组**都按自己的 **offset** 前进——可以按各自的节奏重放。正是这个差别，把一条消息总线变成了一个**事件流**平台；也正是它，让 Kafka 对某些问题恰好是那个对的工具，对另一些问题又荒唐地过度设计。我起了一个一次性的单 broker、**KRaft** 模式（没有 ZooKeeper）的 Kafka，跑了大家真正部署时用的命令，把终端原样贴回来。下面每一段输出都是真的。

如果你还在纠结到底要不要一个 broker，我的[消息队列选型指南](/zh/posts/message-queues/)是前置阅读；这篇讲的是当答案是"具体来说，要一个日志"时会发生什么。它底层的复制，和[共识与 etcd](/zh/posts/consensus-and-etcd/)是同一个思路，只是应用在了流上。

## Kafka 到底是什么：一个只追加的日志

先把队列那套词放一边。一个 Kafka topic 就是一条命名的流。每个 topic 被切成若干个 **Kafka 分区**，而每个分区就是一条朴素的、只追加的记录序列，每条记录被打上一个单调递增的编号，叫作 **offset**。生产者永远只追加。消费者从不删除任何东西——它只是通过提交 offset 来记住自己读到哪儿了。一条躺在 offset 3 的记录，对所有人来说都一直在 offset 3；你再回去读它一遍，它还是 offset 3。

一个 broker（或一组 broker）把这些分区存在磁盘上，每个分区都会复制到你配置的若干个 broker 上，这样掉一台机器也不会丢日志。现代 Kafka 跑在 **KRaft** 模式下，集群自身的元数据也放在一条 Kafka 日志里，由一个 controller 仲裁组管理——对 ZooKeeper 的依赖没有了。建一个四分区 topic 就一条命令：

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
    --create --topic orders --partitions 4 --replication-factor 1
Created topic orders.

$ docker exec kafka-demo /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
    --describe --topic orders
Topic: orders	TopicId: yF2pitsBTHOp8ePxuApscw	PartitionCount: 4	ReplicationFactor: 1	Configs:
	Topic: orders	Partition: 0	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 1	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 2	Leader: 1	Replicas: 1	Isr: 1	Elr:
	Topic: orders	Partition: 3	Leader: 1	Replicas: 1	Isr: 1	Elr:
```

`Isr` 是同步副本集合（in-sync replica）——对某个分区来说完全跟上了的那些 broker。在单 broker 演示里它平凡的等于 `1`；在生产里，它是某块磁盘卡住时你要盯的那个数字。

<figure>
<svg viewBox="0 0 700 430" width="100%" role="img" aria-label="一个名为 orders 的 topic，有四个分区，每个都是编号 offset 的只追加序列。消费者组 audit-svc 有两个成员：成员一读分区 0 和 1，成员二读分区 2 和 3。第二个组 search-svc 用自己的一套 offset 独立地读全部四个分区。">
  <defs>
    <marker id="kafka-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <text x="16" y="26" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">topic: orders — 只追加、可分区的日志</text>

  <rect x="16" y="52" width="330" height="100" rx="12" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <rect x="16" y="160" width="330" height="100" rx="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="6 5" opacity="0.6"/>

  <text x="30" y="80" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p0</text>
  <rect x="74" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="81" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="81" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="62" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="176" y="81" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="62" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="81" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="62" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="81" text-anchor="middle" fill="currentColor" font-size="11">4</text>
  <text x="288" y="80" fill="currentColor" opacity="0.7" font-family="system-ui, sans-serif" font-size="10">offsets →</text>

  <text x="30" y="134" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p1</text>
  <rect x="74" y="116" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="135" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="116" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="135" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="176" y="135" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="135" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="116" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="135" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="30" y="188" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p2</text>
  <rect x="74" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="189" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="189" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="170" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="176" y="189" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="170" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="189" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="170" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="189" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="30" y="242" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">p3</text>
  <rect x="74" y="224" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="92" y="243" text-anchor="middle" fill="currentColor" font-size="11">0</text>
  <rect x="116" y="224" width="36" height="28" rx="5" fill="#0f766e" opacity="0.28"/><text x="134" y="243" text-anchor="middle" fill="currentColor" font-size="11">1</text>
  <rect x="158" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="176" y="243" text-anchor="middle" fill="currentColor" font-size="11">2</text>
  <rect x="200" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="218" y="243" text-anchor="middle" fill="currentColor" font-size="11">3</text>
  <rect x="242" y="224" width="36" height="28" rx="5" fill="currentColor" opacity="0.07"/><text x="260" y="243" text-anchor="middle" fill="currentColor" font-size="11">4</text>

  <text x="356" y="98" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">audit-svc 的成员 1</text>
  <text x="356" y="114" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">已提交 p0 → 3, p1 → 2</text>
  <text x="356" y="206" fill="currentColor" opacity="0.8" font-family="system-ui, sans-serif" font-size="11">audit-svc 的成员 2</text>
  <text x="356" y="222" fill="currentColor" opacity="0.8" font-family="system-ui, sans-serif" font-size="11">已提交 p2 → 3, p3 → 2</text>

  <g stroke="#0f766e" fill="none" stroke-width="2">
    <line x1="181" y1="152" x2="150" y2="300" marker-end="url(#kafka-arrow)"/>
    <line x1="181" y1="260" x2="215" y2="300" marker-end="url(#kafka-arrow)"/>
    <line x1="352" y1="210" x2="520" y2="300" marker-end="url(#kafka-arrow)"/>
  </g>

  <rect x="16" y="302" width="300" height="106" rx="12" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="30" y="326" fill="#0f766e" font-family="system-ui, sans-serif" font-size="13" font-weight="600">消费者组：audit-svc</text>
  <text x="30" y="348" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">两个成员瓜分四个分区。</text>
  <text x="30" y="366" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">每个分区 → 恰好一个成员。</text>
  <text x="30" y="388" fill="currentColor" opacity="0.75" font-family="system-ui, sans-serif" font-size="11">成员离开会触发 rebalance。</text>

  <rect x="368" y="302" width="316" height="106" rx="12" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.7"/>
  <text x="382" y="326" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="600">消费者组：search-svc</text>
  <text x="382" y="348" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">从 offset 0 读取同样的四个分区，</text>
  <text x="382" y="366" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">用自己的一套 offset。</text>
  <text x="382" y="388" fill="currentColor" opacity="0.75" font-family="system-ui, sans-serif" font-size="11">不会从 audit-svc 那里"消费掉"任何东西。</text>
</svg>
<figcaption>一个 topic，四个分区，每个都是编号 offset 的只追加序列。同一个组的成员瓜分这些分区；第二个独立的组用自己的一套 offset 读取同样的记录。读者的任何操作都不会把数据从日志里拿走。</figcaption>
</figure>

## Kafka 分区与顺序保证

分区既是 Kafka 并行度的单位，也是顺序的单位。单个分区内的记录严格按 offset 有序，而这个顺序是 Kafka 唯一承诺的顺序。跨分区则完全没有全局顺序。

分区由生产者决定：如果一条记录没有 key，它被轮询（或按粘性批次）铺到各分区上；如果它有 key，Kafka 对该 key 做哈希，于是同一个 key 的所有记录落到同一个分区，从而保住相对顺序。生产六条带 key 的订单事件再读回来：

```text
$ printf 'user-1:created order 100\nuser-2:created order 101\nuser-1:paid order 100\n
user-3:created order 102\nuser-2:paid order 101\nuser-3:paid order 102\n' \
  | docker exec -i kafka-demo /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server 127.0.0.1:9092 --topic orders --property parse.key=true --property key.separator=:

$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic orders --from-beginning --max-messages 6 --property print.partition=true \
    --property print.offset=true --property print.key=true
Partition:0	Offset:0	user-1	created order 100
Partition:0	Offset:1	user-2	created order 101
Partition:0	Offset:2	user-1	paid order 100
Partition:0	Offset:3	user-2	paid order 101
Partition:3	Offset:0	user-3	created order 102
Partition:3	Offset:1	user-3	paid order 102
```

`user-1` 和 `user-2` 哈希到了分区 0；`user-3` 落到了分区 3。关键的是，`created order 100`（offset 0）在同分区内先于 `paid order 100`（offset 2），所以顺序处理分区 0 的消费者，看到的是某个用户的事件按发生顺序排列。**Kafka 分区**同时也是并行度的上限：一个四分区的 topic，在*单个组内*最多能让四个消费者忙起来。

## 日志，而非队列：改变了什么

现在进入心智模型的转变。在队列里，读一条消息就把它删了；第二个消费者看到的是一个空队列。在日志里，读取是非破坏性的——它只是推进*你自己*的 offset。两个后果立刻显现。

**重放。** 只要保留策略还留着数据，任何消费者都能从 offset 0 开始重读整段历史。这就是你重建搜索索引、给一个新微服务做引导、或对一个下游作业里修好的 bug 做重跑的方式。

**多组彼此独立的消费者。** 每个消费者组都有自己的 offset。对同一个 topic 起一个全新的组，它就会从头读遍所有内容，独立于其他所有人：

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic orders --group search-svc --from-beginning --max-messages 15 \
    --property print.partition=true --property print.offset=true --property print.key=true
Partition:0	Offset:0	user-1	created order 100
Partition:0	Offset:1	user-2	created order 101
Partition:0	Offset:2	user-1	paid order 100
Partition:0	Offset:3	user-2	paid order 101
Partition:0	Offset:4	user-1	shipped order 100
Partition:0	Offset:5	user-2	shipped order 101
Partition:0	Offset:6	user-1	refunded order 100
Partition:0	Offset:7	user-2	delivered order 101
Partition:0	Offset:8	user-1	note order 100
Partition:0	Offset:9	user-2	note order 101
Partition:0	Offset:10	user-1	closed order 100
Partition:3	Offset:0	user-3	created order 102
Partition:3	Offset:1	user-3	paid order 102
Partition:3	Offset:2	user-3	shipped order 102
Partition:3	Offset:3	user-3	note order 102
```

一个审计服务和一个搜索索引服务读同一个 topic，谁都不会从对方那里抢走事件，再加第三个消费者对前两个也毫无影响。这正是**事件流**相对于工作队列的全部意义。

## Kafka 消费者组与 rebalance

一个 **Kafka 消费者组**是横向扩容的单位。往组里加成员，Kafka 就在它们之间分配分区；保证是，同一个组内，每个分区同一时刻只被一个成员读取。一个组里的两个成员干净地瓜分一个四分区 topic：

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 \
    --describe --group audit-svc
GROUP      TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG  CONSUMER-ID                HOST        CLIENT-ID
audit-svc  orders  0          4               4               0    console-consumer-1134bb44  /127.0.0.1  console-consumer
audit-svc  orders  1          0               0               0    console-consumer-1134bb44  /127.0.0.1  console-consumer
audit-svc  orders  2          0               0               0    console-consumer-dd6c5758  /127.0.0.1  console-consumer
audit-svc  orders  3          2               2               0    console-consumer-dd6c5758  /127.0.0.1  console-consumer
```

成员一拥有分区 0 和 1，成员二拥有 2 和 3。`CURRENT-OFFSET` 是已提交位置；`LOG-END-OFFSET` 是日志的尾部；两者之差就是 `LAG`——一个组落后了多少条记录。停掉消费者，让事件堆积，lag 就会增长，而不用重写任何东西：

```text
$ docker exec kafka-demo /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 \
    --all-groups --describe
GROUP       TOPIC   PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
audit-svc   orders  0          8               11              3
audit-svc   orders  1          0               0               0
audit-svc   orders  2          0               0               0
audit-svc   orders  3          3               4               1
search-svc  orders  0          11              11              0
search-svc  orders  1          0               0               0
search-svc  orders  2          0               0               0
search-svc  orders  3          4               4               0
```

两个组，同一个 topic，两套彼此独立的 offset。当一个成员加入或离开一个组——或者不告而别地挂掉——Kafka 会触发一次 **rebalance** 并重新分配分区。在 rebalance 期间消费会暂停；这个暂停是以 Kafka 为底座的系统里，最常见的意外延迟来源。如果成员是崩溃的，它已提交的 offset 会保留下来：等它回来，就精确地从离开的地方接着读，把 lag 排干，上面的 offset 也会随之归位。

## 保留、offset 与日志压实

一条永远不删东西的日志是个磁盘空间问题，所以 Kafka 是按策略裁剪，而不是按消费裁剪。普通 topic 的默认是按时间删除——在我的 broker 上，`log.retention.hours=168`（七天）、`log.retention.bytes=-1`（不限大小），清理由 `log.cleanup.policy=delete` 驱动。你也能按大小给 topic 封顶。由于删除是按时间或字节而不是按读取进行的，一个慢消费者可能丢掉它从没看过的数据——这是真实的设计约束，不是脚注。

另一种策略是**日志压实**（log compaction）。在压实过的 topic 上，Kafka 为每个 key 保留*最新*的值，并最终丢弃更早的，把 topic 变成一份持久、可重放的变更日志，而不是一段转瞬即逝的流。建一个压实 topic，看清理器把重复 key 折叠掉：

```text
$ ... --create --topic user-profiles --partitions 4 --replication-factor 1 \
      --config cleanup.policy=compact --config segment.ms=1000

# 先为两个 key 写了五条记录，第六次追加滚动了 segment：
$ docker exec kafka-demo /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 \
    --topic user-profiles --from-beginning --property print.offset=true --property print.key=true
Partition:3	Offset:0	user-3	{"name":"Carol"}
Partition:0	Offset:3	user-1	{"name":"Ada Lovelace"}
Partition:0	Offset:4	user-2	{"name":"Bob B."}
Partition:0	Offset:5	user-1	{"name":"Ada L3"}
```

分区 0 上 offset 0–2 直接没了——被同一批 key 更晚的写入取代——而留下的 offset 被保留下来，带着空洞。消费者在每个 key 上仍然看到一条一致、有序的流。这就是为什么压实 topic 是"当前状态"的正确归宿（Kafka 自己的 `__consumer_offsets` 就是压实的），也是为什么压实 topic 永远不该是你只追加事件的唯一副本。

## 什么时候 Kafka 是对的工具，什么时候是过度设计

只要下面有一条成立，Kafka 就值回票价：

- **你需要重放。** 重建一个投影、重建索引、或重处理历史，是一等公民操作。
- **多个独立消费者需要同一条流。** 扇出是免费的，每个读者有自己的 offset。
- **吞吐与持久性重要。** Kafka 是一套真正高吞吐、落盘、带复制的日志；它极其擅长把大量事件可靠地搬来搬去。
- **需要按 key 保序。** 带 key 的记录落到同一个分区，保持有序。

而当上面一条都不成立时，它就是错的工具。如果你的小应用只是要把活交给一个后台 worker，一张带 `FOR UPDATE SKIP LOCKED` 的数据库表、或者 NATS、Redis Streams 这类轻量 broker，用很小一部分运维面就能做到——这套推理在[消息队列那篇](/zh/posts/message-queues/)里有详述。为了每分钟几件小活上 Kafka，等于为了避免写一张 `jobs` 表而去买一整个分布式系统。

## 运维分量，实话实说

那个单 broker 演示不是生产，假装它是，团队就会栽跟头。真实的 Kafka 部署意味着：多 broker、复制因子至少 3、机架感知的放置（这样掉一个机架不会把某个分区的副本一起带走），以及远超"是否存活"的监控。我会设置告警的四个信号是：**消费者 lag**（某个组悄悄落后）、**副本不足的分区**（副本已经掉出 ISR）、**离线分区**，以及相对保留策略的**磁盘占用**。你还得自己承担：分区数这种事后很难改的抉择、会让消费者暂停的 rebalance、schema 演进（通常靠 Schema Registry），以及必须一台一台滚动的 broker 升级。

当问题真的是一个事件流时，所有这些都不是回避 Kafka 的理由。它只意味着要老实承认：Kafka 是基础设施，附带一个 on-call 值班表。日志与队列这个心智模型，正是用来判断你签下的是不是对的东西：如果你要的是消息投递一次就被遗忘，你要的是队列；如果你要的是一段持久、可重放、能被许多读者按各自节奏走过的历史，你要的是日志——而 Kafka 恰恰就是那个日志。

## 常见问题

**消费一条消息会删掉它吗？** 不会。你只是推进消费者组的 offset；记录会一直留到保留或压实把它清掉。另一个组照样能读到它。

**我该用多少个分区？** 足够喂满你目标消费者并行度就行，别更多——分区要带文件、带复制、带 rebalance 成本。以后可以加分区，但改动前后对已有 key 的保序不成立。

**顺序是全局保证的吗？** 不是。顺序是按分区的。要让同一个实体的事件保序，就给它们相同的 key。

**保留和压实有什么区别？** 保留按时间或大小删记录，不管 key。压实按 key 保留最新记录、丢弃更早的。同一个 topic 上两者可以组合。
