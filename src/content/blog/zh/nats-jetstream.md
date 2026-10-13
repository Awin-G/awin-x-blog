---
title: "NATS JetStream 实战：不用集群的持久化流"
description: "我跑了一个一次性的单节点 NATS JetStream，输出全部原样贴出：建流、发布消息、持久化消费者、显式 consumer acks，以及一次 least-once 反例演示——故意不 ack 的消息带着 tries: 2 和 num_redelivered: 1 回来了。另附 retention 策略、limit 上限和 KV 层的真实结果，以及与 Kafka 的诚实对比。"
pubDate: 2027-01-25
lang: zh
translationKey: nats-jetstream
tags: [networking, devops]
featured: false
keywords:
  - NATS JetStream
  - 持久化流
  - at-least-once
  - consumer acks
  - retention 策略
  - KV store
---

**NATS** 是一个很小的 pub/sub broker：一个二进制文件，没有 JVM，没有外部依赖，几乎所有语言都有客户端。而 **NATS JetStream** 是你在"发完就不管"不够用时打开的那一层——它给你**持久化流**、**at-least-once 投递**、消息重放和 **consumer acks**，全部来自同一个服务器进程。没有 ZooKeeper，没有 KRaft，不需要集群也能得到一个真正够生产用的形态。我起了一个一次性的单节点 JetStream，建流、发布真实消息、创建持久化消费者、故意不 ack 一条消息然后看它被重新投递，并把三种 retention 策略都跑了一遍。下面的每段输出都是真的。

如果你还在判断自己到底要不要一个 broker，先看我的[消息队列决策指南](/zh/posts/message-queues/)；如果你想知道那个重量级替代方案长什么样，我用同样的方式拆过 [Kafka 实战](/zh/posts/kafka-in-practice/)。这篇文章是光谱的另一端：当答案是"只要保证消息不丢"时会发生什么。

## Core NATS 与 JetStream：发完就忘 vs 落盘

原生 NATS 是一张基于 subject 的 pub/sub 网络。你往 `orders.new` 这样的 subject 发布，每个订阅了匹配 subject 的订阅者各得一份副本，然后消息就没了。不碰磁盘、没有 ack、没有重放——没人听，消息就蒸发；订阅者处理到一半崩了，那是你的问题。这个行为是特性：core NATS 一毫秒内完成投递、每秒能推几百万条，因为它几乎什么都不做。

JetStream 是服务器的一个子系统（命令行加 `-js`），它把消息持久化进一个**流（stream）**——一个绑定到一个或多个 subject 的、有序的、带 ack 追踪的日志。发布/消费的 API 仪式感多一点（底层是 `$JS.ACK...` 之类的回复 subject），但保证完全变了：消息能在 broker 重启后存活，消费者精确记录自己读到了哪里，消费者不确认时消息会被重新投递。

这两种模式值得在脑子里分开。你后面会看到：往一个既没有流也没有订阅者的 subject 发布，不会留下任何痕迹。Core NATS 是电线；JetStream 是电线加日记本。

## 实验环境：一次性 JetStream

一个容器，两个回环端口映射，`-js` 打开持久化层：

```text
$ docker run -d --name natsjslab-srv -p 127.0.0.1:14722:4222 -p 127.0.0.1:18222:8222 \
    nats:latest -js -m 8222 -sd /data --server_name lab1
```

```text
[INF] Starting nats-server
[INF]   Version:  2.15.1
[INF] Starting http monitor on 0.0.0.0:8222
[INF] Starting JetStream
[INF]   Max Memory:      8.67 GB
[INF]   Max Storage:     55.05 GB
[INF]   Store Directory: "/data/jetstream"
```

下面的 `nats` CLI 来自官方 `natsio/nats-box` 镜像（`nats --version` 报 0.5.0）。先说一个诚实的注意事项：这个 CLI 的 `consumer next` 默认就会 ack，所以下面演示不 ack 的地方都显式加了 `--no-ack`。另外非交互的 `add` 命令要加 `--defaults`（老版本 CLI 的类似惯例是 `--no-prompt`）。

## 创建持久化流

流是一个有名字的 subject 桶。我给 ORDERS 加了 limit，好让 retention 的故事有东西可咬：

```text
$ nats stream add ORDERS --subjects "orders.>" --storage file --retention limits --discard old \
    --max-msgs 1000 --max-age 24h --max-msgs-per-subject 100 --dupe-window 2m --defaults
```

```text
Stream ORDERS was created

                     Subjects: orders.>
                      Storage: File
                    Retention: Limits
               Discard Policy: Old
             Duplicate Window: 2m0s
 Maximum Messages: 1,000
          Maximum Per Subject: 100
                  Maximum Age: 1d0h0m0s
```

发布就是原生 NATS 的语法——JetStream 拦截属于某个流的 subject，由它的 API 在背后处理落盘和回复：

```text
$ nats pub orders.new "order-1 payload"
13:16:29 Published 15 bytes to "orders.new"
$ nats pub orders.new "order-2 payload"
13:16:30 Published 15 bytes to "orders.new"
$ nats pub orders.new "order-3 payload"
13:16:30 Published 15 bytes to "orders.new"
$ nats pub orders.eu "order-eu-1 payload"
13:16:30 Published 18 bytes to "orders.eu"
```

```text
$ nats stream info ORDERS
                 Messages: 4
                    Bytes: 222 B
           First Sequence: 1 @ 2026-10-13 13:16:29
            Last Sequence: 4 @ 2026-10-13 13:16:30
         Number of Subjects: 2
```

四条消息、两个 subject（`orders.>` 是通配符），序号 1–4。然后是验证"core NATS 会忘记"的对照实验：

```text
$ nats pub core.plain "this subject has no stream and no subscriber"
13:27:30 Published 44 bytes to "core.plain"
```

`nats stream ls` 里没有任何新流，ORDERS 里也仍然正好是 4 条消息。没有订阅者、没有日志、没有记录。这就是 core NATS。

## 持久化消费者与显式 consumer acks

**消费者（consumer）**是读的一侧：流之上一 durable 的、服务端保存的游标，它记住自己的位置。最重要的三个设置是投递模式（push 或 pull）、ack 策略和 ack 等待时间。一个带显式 ack 的 durable pull 消费者长这样：

```text
$ nats consumer add ORDERS WORKER --pull --ack explicit --deliver all --wait 60s --defaults
```

```text
                    Name: WORKER
               Pull Mode: true
          Deliver Policy: All
              Ack Policy: Explicit
                Ack Wait: 1m0s
       Max Ack Pending: 1,000
```

按默认行为消费（这个 CLI 收到就自动 ack）：

```text
$ nats consumer next ORDERS WORKER --count 2 --ack
[13:17:34] subj: orders.new / tries: 1 / cons seq: 1 / str seq: 1 / pending: 3
order-1 payload
Acknowledged message
[13:17:34] subj: orders.new / tries: 1 / cons seq: 2 / str seq: 2 / pending: 2
order-2 payload
Acknowledged message
```

```text
$ nats consumer info ORDERS WORKER
  Last Delivered Message: Consumer sequence: 2 Stream sequence: 2
    Acknowledgment Floor: Consumer sequence: 2 Stream sequence: 2
        Outstanding Acks: 0 out of maximum 1,000
    Redelivered Messages: 0
           Unprocessed Messages: 2
```

三个数字讲完了整个故事：**Outstanding Acks 0**（交出去的消息都确认了）、**ack floor 停在 stream seq 2**（消费者的持久位置）、**Unprocessed 2**（第 3、4 条还在等）。消费者状态存在服务端，所以哪怕地球上所有 worker 进程都死了，明天这个游标还在。

<figure>
<svg viewBox="0 0 720 350" width="100%" role="img" aria-label="流 ORDERS 保存序号 1 到 4 的四条消息；1 和 2 在 ack floor 之下，3 和 4 之上。pull 消费者 WORKER 收到第 N 条消息，可以发送 ack 使 floor 前进，也可以在 ack wait 到期前沉默，服务端随后重新投递该消息，tries 计数器加一。">
  <defs>
    <marker id="js-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
    <marker id="js-arrow-mark" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b45309"/>
    </marker>
  </defs>

  <text x="16" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">stream ORDERS — file storage, retention: limits, discard: old</text>
  <text x="452" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">consumer WORKER — pull, ack: explicit</text>

  <!-- stream body -->
  <rect x="16" y="40" width="330" height="150" rx="12" fill="#0f766e" opacity="0.06" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 5"/>
  <rect x="16" y="128" width="330" height="62" fill="none" stroke="#0f766e" stroke-width="1" stroke-dasharray="3 4" opacity="0.7"/>
  <text x="30" y="66" fill="#0f766e" font-family="ui-monospace, monospace" font-size="12">ack floor</text>

  <!-- acked messages -->
  <rect x="30" y="78" width="60" height="30" rx="5" fill="currentColor" opacity="0.10"/>
  <text x="60" y="98" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#1</text>
  <rect x="100" y="78" width="60" height="30" rx="5" fill="currentColor" opacity="0.10"/>
  <text x="130" y="98" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#2</text>
  <text x="176" y="98" fill="currentColor" font-size="11" opacity="0.8">acked</text>

  <!-- unprocessed messages -->
  <rect x="30" y="142" width="60" height="30" rx="5" fill="#0f766e" opacity="0.30"/>
  <text x="60" y="162" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#3</text>
  <rect x="100" y="142" width="60" height="30" rx="5" fill="#0f766e" opacity="0.30"/>
  <text x="130" y="162" text-anchor="middle" fill="currentColor" font-size="11" font-family="ui-monospace, monospace">#4</text>
  <text x="176" y="162" fill="currentColor" font-size="11" opacity="0.8">unprocessed</text>

  <!-- consumer body -->
  <rect x="452" y="40" width="250" height="150" rx="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="6 5" opacity="0.6"/>
  <text x="470" y="70" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">cursor: seq 2</text>
  <text x="470" y="94" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">outstanding: 0</text>
  <text x="470" y="118" fill="currentColor" font-size="12" font-family="ui-monospace, monospace">num_redelivered: 0</text>
  <text x="470" y="150" fill="currentColor" font-size="11" opacity="0.75">位置保存在服务端，</text>
  <text x="470" y="168" fill="currentColor" font-size="11" opacity="0.75">worker 重启也不丢</text>

  <!-- delivery arrow -->
  <path d="M346 100 H 440" stroke="#0f766e" stroke-width="1.5" marker-end="url(#js-arrow)"/>
  <text x="360" y="90" fill="#0f766e" font-size="11" font-family="ui-monospace, monospace">pull → deliver</text>

  <!-- ack arrow -->
  <path d="M440 130 H 346" stroke="#0f766e" stroke-width="1.5" marker-end="url(#js-arrow)"/>
  <text x="352" y="150" fill="#0f766e" font-size="11" font-family="ui-monospace, monospace">ack → floor 前进</text>

  <!-- redelivery loop -->
  <path d="M452 200 C 400 280, 120 280, 60 224" stroke="#b45309" stroke-width="1.5" fill="none" stroke-dasharray="6 5" marker-end="url(#js-arrow-mark)"/>
  <text x="150" y="300" fill="#b45309" font-size="12" font-family="ui-monospace, monospace">ack wait 内未 ack → 重新投递，tries: 2</text>
  <text x="150" y="320" fill="#b45309" font-size="12" font-family="ui-monospace, monospace">num_redelivered: 1</text>

  <!-- footer caption inside svg note -->
  <text x="16" y="336" fill="currentColor" font-size="11" opacity="0.7">stream seq 数的是消息，consumer seq 数的是投递次数——一条消息、多次投递，这就是 at-least-once。</text>
</svg>
<figcaption>一条消息，多次投递。流本身不动；消费者游标和重投计数器就是 at-least-once 的代价。</figcaption>
</figure>

## At-least-once 投递，真实演示

这才是我真正想看到的部分。我又建了一个消费者 `RDL`，配置完全相同，只是 ack wait 设为 **4 秒**，好让演示不用耗一整天：

```text
$ nats consumer add ORDERS RDL --pull --ack explicit --deliver all --wait 4s --defaults
```

拉一条消息，然后故意**不 ack**（`--no-ack`）：

```text
$ nats consumer next ORDERS RDL --count 1 --no-ack
[13:19:22] subj: orders.new / tries: 1 / cons seq: 2 / str seq: 2 / pending: 2
order-2 payload
```

（补充说明：这个消费者停在 `cons seq: 2`，是因为第 1 次投递在前面某一步已经被消费并 ack 了。真正重要的是 `str seq: 2` / `tries: 1` 这一对——流序号 2，投递过一次。）

六秒之后，超过 4 秒的 ack wait：

```text
$ nats consumer info ORDERS RDL
  Last Delivered Message: Consumer sequence: 2 Stream sequence: 2 Last delivery: 6.37s ago
    Acknowledgment Floor: Consumer sequence: 1 Stream sequence: 1
        Outstanding Acks: 1 out of maximum 1,000
    Redelivered Messages: 0
           Unprocessed Messages: 2
```

注意这个计数器：**Redelivered Messages: 0**，而 **Outstanding Acks: 1**。计时器到期了，但还没有发生重投——消息只是*有资格*被重投；只有新的投递真正发生时，计数器才会动。所以再拉一次：

```text
$ nats consumer next ORDERS RDL --count 1 --no-ack
[13:19:39] subj: orders.new / tries: 2 / cons seq: 3 / str seq: 2 / pending: 2
order-2 payload
```

```text
$ nats consumer info ORDERS RDL
  Last Delivered Message: Consumer sequence: 3 Stream sequence: 2 Last delivery: 360ms ago
    Acknowledgment Floor: Consumer sequence: 1 Stream sequence: 1
        Outstanding Acks: 1 out of maximum 1,000
    Redelivered Messages: 1
           Unprocessed Messages: 2
```

原始 JSON 里也是这几个数字：

```text
$ nats consumer info ORDERS RDL -j | grep -E 'num_redelivered|num_ack_pending|num_pending'
  "num_ack_pending": 1,
  "num_redelivered": 1,
  "num_pending": 2
```

`tries: 2`、`num_redelivered: 1`，payload 仍是同一个 `str seq: 2`。这就是**at-least-once 投递**的具体形态：你的处理函数必须幂等，因为它*注定*会两次看到同一条消息。反过来这一点同样重要——pull 消费者只在被请求时才重投，所谓"重投"指的是"ack wait 过期之后你再拉，服务端就重发"，而不是什么需要你去调的后台重试线程。最后我让 CLI 正常 ack（它默认就 ack），这条消息在第三次投递时才被确认：

```text
$ nats consumer next ORDERS RDL --count 1
[13:20:26] subj: orders.new / tries: 3 / cons seq: 4 / str seq: 2 / pending: 2
order-2 payload
Acknowledged message
```

第三次投递，终于 ack，floor 前进，outstanding 归零。这正是动钱的流水线需要的语义。

## Retention 策略：limits、interest、workqueue

我上面用的 `--retention limits` 策略是"全部保留，按 max-age / max-msgs / max-bytes 删除"。我建了一个 max-age 8 秒的流，亲眼看 broker 真的丢弃：

```text
$ nats stream add TTL --subjects "ttl.>" --storage file --retention limits --discard old \
    --max-age 8s --max-msgs 100 --defaults
$ nats pub ttl.a "m1"; nats pub ttl.b "m2"; nats pub ttl.c "m3"
$ nats stream info TTL | grep Messages
                     Messages: 3
$ sleep 12 && nats stream info TTL | grep Messages
                     Messages: 0
```

三条消息，十二秒，没了。消息数上限同理：`--max-msgs 2 --discard old` 之下发布四条，只剩最新两条，`First Sequence` 移到 3，存量永远不超过承诺。整个数据生命周期治理就两个 flag，没有压实守护进程要伺候。

另外两种 retention 更有意思。**interest 型**（`interest`）流只保留"至少还有一个消费者没 ack"的消息——往一个没有消费者的 interest 流发布，消息到达即被丢弃（序号照样前进：两次发布之后 `First Sequence: 3` 而 `Last Sequence: 2`）。加上消费者，同一条消息就会被留到 ack 为止：

```text
$ nats consumer add EVENTS LIVE --pull --ack explicit --filter 'events.>' --defaults
$ nats pub events.login "kept-until-acked"
$ nats stream info EVENTS | grep Messages
                     Messages: 1
$ nats consumer next EVENTS LIVE --count 1
[13:21:28] subj: events.login / tries: 1 / cons seq: 1 / str seq: 3 / pending: 0
kept-until-acked
$ nats stream info EVENTS | grep Messages
                     Messages: 0
```

一 ack 就立刻消失——这已经有点像工作队列的语义。而显式的 **workqueue** 策略（`--retention work`）把它变成了官方行为：消息随 ack 删除，没有重放。两个任务进、ack 一个、剩一个：

```text
$ nats stream info JOBS | grep Messages    # 发布 2 条之后
                     Messages: 2
$ nats consumer next JOBS WQ --count 1
[13:21:45] subj: jobs.a / tries: 1 / cons seq: 1 / str seq: 1 / pending: 1
$ nats stream info JOBS | grep Messages    # ack 一条之后
                     Messages: 1
```

所以选型就是一个一行命令的事：要可重放的事件日志用 `limits`；"发给关心的人然后忘掉"用 `interest`；"必须恰好做一次然后消失"的任务用 `workqueue`。

## Request-reply 是自带的，不是后粘的

Core NATS 原生带 request-reply 原语：自动生成的 inbox subject 加超时。JetStream 不替代它，两者可以组合。我在一个容器里起了回复服务，从另一个容器发请求：

```text
$ nats reply svc.upper --command 'printenv NATS_REQUEST_BODY'    # 服务端，另一个容器
$ nats request svc.upper 'shipped order 4711'
13:27:14 Sending request on "svc.upper"
shipped order 4711
13:27:14 Received with rtt 1.117301ms
```

回环上 1.1 ms 的往返，不需要自己写任何中转逻辑。（诚实细节：这个 CLI 通过 `NATS_REQUEST_BODY` 环境变量把请求体交给 `--command`，而不是 stdin——命令字符串里的 shell 管道不会执行，所以演示直接把请求体原样打回。）

## KV 层：戴着友好帽子的 JetStream

`nats kv` 给你一个带版本的键值桶，笑点在于它不是独立的存储引擎——它就是一个流：

```text
$ nats kv add CONFIG --history 5
Information for Key-Value Store Bucket CONFIG created 2026-10-13 13:24:12

Configuration:

            Bucket Name: CONFIG
           History Kept: 5
          Values Stored: 0
             Compressed: false
$ nats kv put CONFIG region eu
eu
$ nats kv put CONFIG region us
us
$ nats kv get CONFIG region
CONFIG > region revision: 2 created @ 2026-10-13 13:24:13

us
$ nats stream ls -a
│ Name       │ Created             │ Messages │ Size  │ Last Message │
│ KV_CONFIG  │ 2026-10-13 13:24:12 │ 2        │ 98 B  │ 1m19s        │
```

每个桶本质上就是一个流：`nats stream info KV_CONFIG` 报告 `Subjects: $KV.CONFIG.>`、`Storage: File`、`Retention: Limits`、`Messages: 2`。每次 `put` 就是一条消息，`get` 读最新 revision，history 只是消息保留量。同一个套路还有面向大 blob 的 object store。如果你曾经只是为了存一点共享配置就上了一套 Redis，这确实是个诱人的替代品——还自带 `watch` API。

## 与 Kafka 的诚实对比

Kafka 的日志模型我在 [Kafka 实战](/zh/posts/kafka-in-practice/) 里拆过；对这篇文章来说简短版本是：JetStream 不是缩小版 Kafka，它是另一种形状。

**JetStream 决定性胜出的地方：运维。**一个 26 MB 的容器，没有 JVM，没有 KRaft 仲裁，没有"建 topic 前先决定分区数"这种事。它的整个运维模型——流、消费者、计数器、KV——可以塞进一个人的脑子，账户级用量统计也只要一条命令：

```text
$ nats account info
JetStream Account Information:
Account Usage:
                        Storage: 361 B
                         Memory: 46 B
                        Streams: 6
                      Consumers: 4
```

处理延迟以个位数毫秒计，request-reply 是原生的，需要的话还能嵌进你自己的应用，一个额外进程都不用。

**Kafka 决定性胜出的地方：生态和规模。**Connect、ksqlDB、整个托管服务宇宙、积累了十年运维智慧的客户端库、事务级 exactly-once，以及"每 topic 分区"这个能让单个 topic 被水平扩展的消费组以 JetStream 根本不尝试的吞吐量消费的模型。如果你要以 500 MB/s 重放三年的事件，用 Kafka。

**这些都不会印在包装盒上：**JetStream *确实*能组集群（每个流一个 RAFT 组，三或五台服务器），但我这里跑的单服务器没有复制。磁盘坏了，流就没了。这就是 26 MB broker 的诚实代价——而对很多负载来说，它仍然比拥抱那套重型替代方案的运维负担更划算。

**对比普通队列**（Redis list、RabbitMQ）：队列 ack 即删，所以不可能重放，所有消费者还抢同一批消息。而 JetStream 的 `limits` 流让你对同一份保留数据有多个*彼此独立*的消费者组——一个管记账，一个管分析，各有各的游标——这个特性悄悄移除了大量中型架构对 Kafka 的第一需求。底层的决策框架见我的[消息队列指南](/zh/posts/message-queues/)。

## 我什么时候真的会选它

服务间消息、每秒几千到几十万条、想要重放和背压但又不想运营一个数据平台：JetStream，单节点，文件存储，完事。耐用的工作队列：`--retention workqueue` 加显式 ack，再加幂等 handler。共享配置或功能开关：KV 层。大型分析体系的事件骨干：Kafka，这一点我不装。

本次会话结束时，六个流一共只占了文件存储 361 字节。Kafka 到那时连 JVM 线程都还没起完。这个对比本身，比任何 benchmark 都更像一篇评测。

## 清理

```text
$ docker rm -f natsjslab-srv
$ docker network rm natsjslab-net
$ docker ps -a --filter name=natsjslab --format '{{.Names}} {{.Status}}'
$ docker network ls --filter name=natsjslab
NETWORK ID     NAME      DRIVER    SCOPE
```

一个进程、一个一次性网络、零残留——而这一次，重点恰恰就在这里。
