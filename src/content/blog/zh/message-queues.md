---
title: "你真的需要消息队列吗？pub/sub、工作队列、NATS 与 RabbitMQ vs Kafka"
description: "消息队列是几乎所有扩容问题的默认答案，而大多数时候它是错的。我用一次性的 NATS、RabbitMQ 和 Postgres 容器，演示队列到底给你带来什么：真实的 pub/sub 扇出、带竞争消费者的工作队列、进入死信队列的 at-least-once 重投，以及一个用 FOR UPDATE SKIP LOCKED 的普通 SQL 表。"
pubDate: 2026-12-10
lang: zh
translationKey: message-queues
tags: [devops, networking]
featured: false
keywords:
  - 消息队列
  - pub/sub
  - NATS
  - RabbitMQ vs Kafka
  - at-least-once
---

**消息队列**是几乎所有扩容问题的默认答案，而大多数时候它是错的。给一个小系统加上 NATS、RabbitMQ 或 Kafka，等于多养一个要运维、要监控、半夜会把你叫醒的分布式系统——往往只是为了搬运那些一张表加一个 worker 循环就能干完的活。这篇写务实版：**消息队列**到底解决什么，不用它你能怎么做（用 `FOR UPDATE SKIP LOCKED` 的 SQL 表、进程内 channel、cron），三种真正的形态（**pub/sub**、工作队列、日志），**at-least-once** 与 exactly-once 的区别，以及 Redis、**NATS**、RabbitMQ、Kafka 各自的取舍。下面每条命令都在一次性容器里真跑过，输出原样粘贴。

## 消息队列到底解决什么

队列夹在「有活要干的生产者」和「把活干掉的消费者」之间。这层间接性**就是**它的全部价值，而它做五件事：

- **解耦**生产者和消费者，双方不必知道对方是否在线、是否够快、甚至是否已经写好。
- **削峰**——一万个请求的突发灌进队列，工作节点按数据库扛得住的速率慢慢取走。
- **重试**失败的工作而不丢失它，按队列的节奏、而不是请求的节奏。
- **扇出**：一个事件分发给多个彼此独立的消费者（计费、搜索索引、邮件）。
- **把工作挪出请求路径**，让用户在慢活开始之前就拿到响应。

在动手安装任何东西之前，先说清你需要这五件事里的哪一件。说不出来，那这个队列就是纯粹的开销：又一个高可用系统、又一块仪表盘、又一个会在半夜把你叫醒的东西。

## 不用消息队列你能怎么做

### 一张数据库表通常就够了

你技术栈里最古老的队列，就是你早就有的那张表。建一张 `jobs` 表，让 worker 去认领行，用 `FOR UPDATE SKIP LOCKED` 保证两个 worker 不会抢到同一行。Postgres、MySQL 8 和 SQLite 都直接支持：

```sql
CREATE TABLE jobs (
  id      serial PRIMARY KEY,
  status  text NOT NULL DEFAULT 'pending',
  payload text NOT NULL
);
INSERT INTO jobs (payload) SELECT 'job-' || g FROM generate_series(1, 5) g;
```

真跑一遍，用两个并发的 `psql` 会话：worker A 认领两行并保持事务打开，一秒后 worker B 跑同样的查询：

```text
-- worker A: claim up to 2 rows, then sleep 4s before committing
BEGIN;
SELECT id, payload FROM jobs
 WHERE status = 'pending'
 ORDER BY id
   FOR UPDATE SKIP LOCKED
 LIMIT 2;
 id | payload
----+---------
  1 | job-1
  2 | job-2
(2 rows)

-- worker B runs the SAME query at the same moment.
-- It does not block: SKIP LOCKED makes it ignore the rows A holds.
 id | payload
----+---------
  3 | job-3
  4 | job-4
(2 rows)
```

worker A 提交 `UPDATE jobs SET status = 'done' WHERE id IN (1, 2)`，表最终的状态正如你所愿：

```text
 id | status  | payload
----+---------+---------
  1 | done    | job-1
  2 | done    | job-2
  3 | pending | job-3
  4 | pending | job-4
  5 | pending | job-5
```

它常常真的够用，原因是：

- **认领和你的业务写入在同一个事务里。** 把任务标记完成、写订单行，要么一起提交，要么都不提交；换成外部 broker，这就变成了一个你必须去推理的分布式事务。
- **你已经在运行、备份、监控它了。** 不需要新的高可用系统，不需要新的仪表盘。
- **重试就是一个字段。** `attempts = attempts + 1`，用 `next_run_at` 做退避，而**死信队列**不过是 `status = 'dead'` 加一条查询。

它的局限同样真实：轮询带来延迟，热点表意味着锁竞争和需要 `VACUUM` 的膨胀，没有推送，吞吐被单个主库封顶。一旦每秒几百个任务，或者你需要向多个服务真正的扇出，你就该去选购了。

### 进程内的 channel

如果这些活从来不需要在重启后存活，一个 channel 就是队列：

```go
// an in-process queue: no network, no broker, no serialization
jobs := make(chan Job, 1024)
for i := 0; i < 4; i++ {          // four workers, one channel
    go func() {
        for j := range jobs {
            process(j)
        }
    }()
}
jobs <- Job{ID: 8842}             // producer
```

背压（backpressure）是白送的：缓冲区一满，生产者就阻塞——这正是你想要的信号。代价同样刺眼：进程一退出，队列里的活全没了，跨重启的重试得你自己解决。

### cron，处理周期性的活

很多所谓「队列」的活，其实是「每 N 分钟干一次」。一个 `systemd` timer 或 cron job，扫描到期的工作并幂等地处理它，不需要 broker，也不需要常驻 worker——只要这个任务跑两次是安全的，而这是消费者的性质，不是运行器的性质。怎么做到安全：[幂等键](/zh/posts/idempotency-keys/)。

## 三种形态：工作队列、pub/sub 与日志

「消息队列」是三个不同的东西共用了一个名字，选错形态就是大多数痛苦的来源。

<figure>
<svg viewBox="0 0 720 200" width="100%" role="img" aria-label="三种消息形态并排展示。工作队列把每条消息投递给若干竞争工作者中的恰好一个。pub/sub 把每条消息扇出给每一个订阅者，各自拿到一份副本。日志保存一个有序、保留的消息序列，彼此独立的读者可以各自按自己的偏移读取。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="10" y="16" font-size="13" font-weight="600">工作队列</text>
    <rect x="10" y="40" width="62" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="41" y="58" text-anchor="middle">生产者</text>
    <path d="M72 54 L96 54" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="96" y="30" width="34" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <line x1="96" y1="50" x2="130" y2="50" stroke="currentColor" stroke-width="1"/>
    <line x1="96" y1="70" x2="130" y2="70" stroke="currentColor" stroke-width="1"/>
    <path d="M130 40 L160 40" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M130 60 L160 60" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M130 80 L160 80" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="160" y="30" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="44" text-anchor="middle">工作者 1</text>
    <rect x="160" y="50" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="64" text-anchor="middle">工作者 2</text>
    <rect x="160" y="70" width="62" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="191" y="84" text-anchor="middle">工作者 3</text>
    <text x="10" y="118" opacity="0.75">每条消息 → 一个工作者</text>

    <text x="250" y="16" font-size="13" font-weight="600">pub/sub</text>
    <rect x="250" y="74" width="62" height="28" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="281" y="92" text-anchor="middle">生产者</text>
    <path d="M312 88 L336 88" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="336" y="74" width="46" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="359" y="92" text-anchor="middle">主题</text>
    <path d="M382 88 L412 44" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M382 88 L412 88" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <path d="M382 88 L412 132" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <rect x="412" y="34" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="48" text-anchor="middle">订阅 A</text>
    <rect x="412" y="78" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="92" text-anchor="middle">订阅 B</text>
    <rect x="412" y="122" width="60" height="20" rx="4" fill="none" stroke="currentColor"/>
    <text x="442" y="136" text-anchor="middle">订阅 C</text>
    <text x="250" y="118" opacity="0.75">每条消息 → 每个订阅者</text>

    <text x="500" y="16" font-size="13" font-weight="600">日志 / 流</text>
    <rect x="500" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="542" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="584" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="626" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <rect x="668" y="46" width="42" height="30" fill="none" stroke="currentColor"/>
    <text x="521" y="65" text-anchor="middle">1</text>
    <text x="563" y="65" text-anchor="middle">2</text>
    <text x="605" y="65" text-anchor="middle">3</text>
    <text x="647" y="65" text-anchor="middle">4</text>
    <text x="689" y="65" text-anchor="middle">5</text>
    <path d="M521 100 L521 76" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <text x="521" y="114" text-anchor="middle">读者 A</text>
    <path d="M626 100 L626 76" stroke="currentColor" stroke-width="1.5" marker-end="url(#ar)"/>
    <text x="626" y="114" text-anchor="middle">读者 B</text>
    <path d="M626 132 C 626 156, 521 156, 521 132" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ar)"/>
    <text x="573" y="164" text-anchor="middle" opacity="0.75">重放</text>
    <text x="500" y="186" opacity="0.75">保留 + 有序：每个读者有自己的偏移</text>

    <defs>
      <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>三种形态，三种保证。工作队列意味着「有一个人处理它一次」；pub/sub 意味着「每个关心它的订阅者都拿到一份副本」；日志意味着「它还在那里，你可以重读」。</figcaption>
</figure>

### 工作队列：每条消息一个消费者

也叫竞争消费者。你发布一个任务，任意一个工作者取走并完成它。加工作者，吞吐就上去，彼此之间无需协调。这是后台任务、邮件、缩略图，以及上面那张 SQL 表该有的形态。

### pub/sub：每个订阅者拿到一份副本

发布者根本不知道谁在听。一个 `order.created` 事件同时到达计费、搜索索引、邮件服务和审计日志，彼此独立、各按各的节奏，新增消费者也不用改动生产者。代价是：pub/sub 本身没有记忆。如果某个订阅者在消息发出时宕机，那条消息就没了——持久化是一个得单独打开的开关。

### 日志 / 流：有序且可重放

日志是一个带偏移量的只追加序列。读者不是「消费并删除」，而是读、推进游标，或者把游标倒回去。这带来重放（从零重建搜索索引）、向彼此独立的消费者扇出，以及把保留期当成一种策略——也是运维机械最多的形态，因为那些偏移和那份保留总得存在某处。

## NATS 实战：pub/sub 与队列组

NATS 小、快，而且有最干净的心智模型之一：subject，以及在 subject 上的队列组（queue group）。我跑了 `nats-server v2.10.29`（开启 JetStream），把 `nats` CLI 指向它。

先是纯粹的 **pub/sub**——同一个 subject 上两个订阅者，一次发布，两个都收到：

```text
$ nats sub demo.audit        # subscriber A
$ nats sub demo.audit        # subscriber B
$ nats pub demo.audit 'order.created id=8842'
09:08:12 Published 21 bytes to "demo.audit"

# subscriber A
09:08:10 Subscribing on demo.audit
[#1] Received on "demo.audit"
order.created id=8842

# subscriber B
09:08:10 Subscribing on demo.audit
[#1] Received on "demo.audit"
order.created id=8842
```

再看工作队列。同样的 subject，但订阅者用 `--queue` 加入一个**队列组**。六个任务发给三个工作者，每个任务只到一个：

```text
$ nats sub demo.jobs --queue workers   # worker-1, worker-2, worker-3
$ for i in 1 2 3 4 5 6; do nats pub demo.jobs "job-$i"; done

# worker-1: job-3, job-5, job-6
# worker-2: job-1, job-2
# worker-3: job-4
```

发布六个，投递六个，无一重复——3 / 2 / 1 的分配正是 broker 分出来的。这就是两种形态的全部差别：去掉 `--queue` 就是扇出，保留它就是工作队列，同一个产品里搞定。

## RabbitMQ vs Kafka，以及 Redis 的位置

### RabbitMQ：聪明的 broker，笨的消费者

RabbitMQ 是经典的工作队列 broker：声明队列、绑定到 exchange、消费者去竞争。我跑了 `rabbitmq:3.13.7`，配一对很小的 `pika` 生产者/消费者——六个持久化任务，第七个是消费者会拒绝的「毒药」任务，一个死信 exchange 把拒绝路由到 `jobs.dlq`。

```text
# two competing consumers on the SAME queue, draining six jobs
worker-1: ack        job-1
worker-1: ack        job-3
worker-1: ack        job-5
worker-1: NACK -> DLQ  job-BOOM
worker-2: ack        job-2
worker-2: ack        job-4
worker-2: ack        job-6
```

一条永远处理不成功的消息不会卡住队列；它被 `NACK`（不重新入队），落进**死信队列**——你可以把它当成一个普通队列来看：

```text
$ rabbitmqctl list_queues name messages messages_ready messages_unacknowledged
name      messages  messages_ready  messages_unacknowledged
jobs.dlq  1         1               0
jobs      0         0               0
```

那行 `jobs 0 / jobs.dlq 1` 就是 broker 的全部意义：路由、确认、重投，以及给毒药消息一个停放区，全都是一等公民、还带仪表盘。当你要丰富的路由、又不想要太多仪式感，消息*速率*不高但路由逻辑不少时，RabbitMQ 正合适。

### Kafka：一个日志，以及配套的运维

Kafka 是一个分布式、可分区的日志，不是队列。Topic 按配置的时长保留消息，消费者在一个消费者组里跟踪偏移量，分区内保证有序。它在高吞吐的事件流、重放，以及大量独立读者读同一份数据上很强。所以「**RabbitMQ vs Kafka**」根本不是一场公平的比较：RabbitMQ 把每条消息投递给某个消费者一次；Kafka 保留一份持久、可重放的历史。当你真的需要那份历史和吞吐时才上 Kafka；每天一万个任务，它是一台要不停投喂的大家伙。

### Redis：快，而且对此很诚实

Redis 是从进程内 channel 往上走的最小一步。`LPUSH`/`BRPOP` 是工作队列，`PUBLISH`/`SUBSCRIBE` 是尽力而为的 pub/sub，Streams（`XADD`/`XREADGROUP` 加 `XACK`）给你消费者组和一份持久日志。它内存优先：做协调极好，做事实来源极差。队列与 Stream 的取舍、以及持久化的坑，我写在[真正有用的 Redis 模式](/zh/posts/redis-patterns/)里了。

## at-least-once、exactly-once 与幂等消费者

诚实的投递承诺是 **at-least-once**：消息一定会被投递，但一次重试或重投可能把它交给消费者两次。exactly-once 多半是一个关于*事务边界*的故事，而不是关于网络的故事。

我在 JetStream 上把重投做成了真的：一个 pull consumer，`--max-deliver 3`、2 秒 ack 窗口，接收但从不确认。

<figure>
<svg viewBox="0 0 700 170" width="100%" role="img" aria-label="一个 at-least-once 投递循环：broker 投递一条消息，消费者处理它，然后尝试确认。如果 ack 在可见性超时前没有到达，broker 就重投。达到最大尝试次数后，消息被移入死信队列。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <rect x="20" y="60" width="120" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="80" y="80" text-anchor="middle">broker 存储</text>
    <text x="80" y="96" text-anchor="middle" opacity="0.75">这条消息</text>
    <rect x="280" y="60" width="150" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="355" y="80" text-anchor="middle">消费者处理</text>
    <text x="355" y="96" text-anchor="middle" opacity="0.75">然后发送 ack</text>
    <path d="M140 82 L276 82" stroke="currentColor" stroke-width="1.5" marker-end="url(#b)"/>
    <text x="208" y="74" text-anchor="middle" font-size="11">投递</text>
    <path d="M280 118 C 200 150, 160 150, 120 128" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#b)"/>
    <text x="200" y="160" text-anchor="middle" font-size="11">无 ack → 重投</text>
    <rect x="490" y="60" width="180" height="44" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="580" y="80" text-anchor="middle">死信队列</text>
    <text x="580" y="96" text-anchor="middle" opacity="0.75">达到最大尝试次数后</text>
    <path d="M430 82 L486 82" stroke="currentColor" stroke-width="1.5" marker-end="url(#b)"/>
    <text x="458" y="74" text-anchor="middle" font-size="11">放弃</text>
    <defs>
      <marker id="b" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>尝试次数有上界的 at-least-once。这个循环就是特性本身；死信队列是循环停下的地方。</figcaption>
</figure>

```text
$ nats pub demo.orders 'charge-card order=8842 amount=19.99'
09:08:39 Published 35 bytes to "demo.orders"

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 1
[09:08:39] subj: demo.orders / tries: 1 / cons seq: 1 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 2 (redelivery)
[09:08:41] subj: demo.orders / tries: 2 / cons seq: 2 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 5s   # attempt 3 (again)
[09:08:43] subj: demo.orders / tries: 3 / cons seq: 3 / str seq: 1
charge-card order=8842 amount=19.99

$ nats consumer next ORDERS worker --no-ack --timeout 3s   # attempt 4
nats: error: no message received: nats: timeout
```

三行里的 `str seq: 1` 是同一条消息：它被投递了三次，因为消费者从没 ack。到 `max-deliver=3`，broker 不再投放它——而 stream 里仍然留着它（`"messages": 1`），是被停放，不是丢了。一张截图里就是 **at-least-once**，也正是你的消费者必须幂等的原因：给每个工作单元一个唯一键，让重复处理变成空操作——机制在[幂等键](/zh/posts/idempotency-keys/)。

exactly-once 在被宣传时，指的是 broker 加一个事务型消费者在*单个系统内*去重——Kafka 事务，或者一张去重表。一旦工作离开那个边界、去调邮件 API 或支付网关，你就又回到了 at-least-once 加幂等。为那次重试做好打算。

## 运维成本：又一个高可用系统

这部分从不上幻灯片。你加的每个 broker 都是一个会独立故障的系统：

- **可用性。** 一个 NATS 节点是单点故障；三节点集群就是一个要推理、要逐台升级、要盯着看的 quorum。你的队列可用性变成了你应用的可用性。
- **磁盘与保留。** 日志会保留，队列会填满。总得有人决定卷满了怎么办。
- **监控与告警** —— 队列深度、消费延迟、重投率、死信数量。队列深度上涨是第一个预警信号；你要的是一条告警，而不是事故当中才发现。
- **背压（backpressure）。** 快的生产者对慢的消费者，队列会无界增长。进程内它白送（生产者阻塞）；隔着 broker，你得选一种策略——暂停、丢弃，还是在边缘削峰。
- **毒药消息与死信队列。** 一条一直重新入队的消息会占住一个工作者，直到把它挪走。这就是 DLQ 的用途；它也需要有人负责，因为没人看的 DLQ 就是你没察觉到的数据丢失。
- **另一个有状态服务的升级与迁移**，有它自己的兼容性规则。

这些都不是反对 broker 的理由。它是反对在*它们解决的问题真的成为你的问题之前*就上它们的理由。

## 一份决策指南

- **带 `SKIP LOCKED` 的表** —— 单应用的默认选择，活能装进一个主库，任务必须和你的数据同事务时用它。
- **进程内 channel** —— 重启可丢的活，或者你想在一个进程内白嫖背压。
- **Redis** —— 本来就在跑、吞吐高，故障时丢几条排队项可以接受。需要消费者组和 ack 时换用 Streams。
- **NATS** —— 你要一个小而快、pub/sub 与工作队列同一个产品搞定、运维足迹极小的 broker。
- **RabbitMQ** —— 你需要丰富的路由（exchange、binding、优先级），把逐消息 ack 和死信队列当一等公民，消息速率中等。「**RabbitMQ vs Kafka**」的选择通常在这里就定了，除非你需要历史。
- **Kafka** —— 你需要一个高吞吐、持久、可重放、有序的日志，且有很多独立消费者。只有真需要时才为它买单。

## 一句话总结

**消息队列**解耦、削峰，替你买到重试和扇出；代价是多养一个分布式系统。从你已有的那张表和 `FOR UPDATE SKIP LOCKED` 开始，等你能说出自己缺的那个具体属性时再上 broker——更轻的运维足迹、扇出、可重放的日志，这三者是不同的东西。真上时，按形态选——工作队列、**pub/sub**、还是日志——并且假定 **at-least-once** 投递，因为无论 broker 是 NATS、RabbitMQ 还是 Kafka，你的消费者都必须幂等。
