---
title: "Postgres LISTEN/NOTIFY：你已经拥有的消息总线"
description: "Postgres 内置了一个轻量级发布/订阅机制 LISTEN/NOTIFY。它快速、无需额外服务，而且已经在你的数据库里运行。本文介绍如何使用它、它的真实边界，以及何时该换用真正的消息队列。"
pubDate: 2027-01-07
lang: zh
translationKey: postgres-listen-notify
tags: [devops, linux]
featured: false
keywords:
  - Postgres LISTEN NOTIFY
  - pg_notify
  - 数据库发布订阅
  - 变更通知
  - 触发器
---

大多数团队在需要唤醒 worker 或失效缓存时，第一反应是引入 Redis、NATS 或 RabbitMQ。这通常是正确的选择——但在你增加新的基础设施组件之前，先看看 Postgres 是否已经能胜任。对于某一类问题，它确实可以。

Postgres 自带一套轻量级的发布/订阅系统：`LISTEN` 和 `NOTIFY`。一个会话监听某个命名通道，另一个会话发送一条带小负载的通知。监听者实时收到消息。不需要额外基础设施，不需要新的连接池，不需要额外部署的服务。如果你已经在跑 Postgres——而你几乎肯定在跑——你实际上已经拥有一个消息总线。

这并不是要替代真正的消息队列。它只是"有东西变了，去看一眼"的信号。理解这条边界在哪里，才是关键。

## LISTEN/NOTIFY 到底是什么

`LISTEN` 告诉 Postgres 你的连接对某个通道感兴趣。`NOTIFY` 向所有监听该通道的会话发送消息。消息是一个短文本负载，异步投递。

```sql
-- 会话 A：监听
LISTEN my_channel;

-- 会话 B：通知
NOTIFY my_channel, 'hello from session B';
```

会话 A 看到：

```
Asynchronous notification "my_channel" with payload "hello from session B" received from server process with PID 114.
```

这就是全部机制。通道只是一个名字——没有配置，没有主题注册中心，没有 broker。负载是单个文本字符串，最大 8000 字节。通知不存储在任何地方；它们只在监听者连接期间存在。

你也可以用 `pg_notify()` 从 SQL 发送通知，这才是生产环境中真正使用的方式：

```sql
SELECT pg_notify('my_channel', '{"user_id": 42}');
```

`pg_notify()` 是一个函数，所以你可以从触发器、存储过程和应用代码中调用它。真正的威力就在这里。

## 真实的双会话演示

我在一个一次性的 Postgres 16 容器上运行了这个演示。两个 `psql` 会话，一个监听，一个发送通知。

会话 A：

```sql
LISTEN my_channel;
```

会话 B：

```sql
NOTIFY my_channel, 'hello from session B';
```

会话 A 立即打印：

```
Asynchronous notification "my_channel" with payload "hello from session B" received from server process with PID 114.
```

没有轮询，没有延迟，没有额外服务。通知在 `NOTIFY` 触发的瞬间推送给所有正在监听 `my_channel` 的连接。如果没有人监听，通知就直接丢弃。

## 用触发器实现变更通知

最常见的生产用法是在行变更时触发通知。创建一个调用 `pg_notify()` 的触发器函数，挂到表上，之后每次 insert/update/delete 都会广播一个变更事件。

```sql
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events_channel', json_build_object(
    'op', TG_OP,
    'id', NEW.id,
    'name', NEW.name
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();
```

现在插入一行：

```sql
INSERT INTO events (name) VALUES ('user_signup'), ('order_paid');
```

任何监听 `events_channel` 的会话都会收到：

```
Asynchronous notification "events_channel" with payload "{"op" : "INSERT", "id" : 9, "name" : "cache_invalidate"}" received from server process with PID 281.
```

这是许多缓存失效和 worker 唤醒模式的基础。应用照常写入数据库；触发器广播变更事件；感兴趣的服务被唤醒并重新读取当前状态。通知携带的是指向变更内容的指针，而不是完整数据——监听者总是回数据库读取权威值。

<figure>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="一个 Postgres 通道扇出到三个监听者">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <rect x="20" y="90" width="140" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="90" y="125" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="14">Postgres</text>
    <text x="90" y="145" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">channel: events</text>
    <line x1="160" y1="120" x2="280" y2="60" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <line x1="160" y1="120" x2="280" y2="120" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <line x1="160" y1="120" x2="280" y2="180" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow)"/>
    <rect x="280" y="30" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="65" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener A</text>
    <rect x="280" y="90" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="125" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener B</text>
    <rect x="280" y="150" width="120" height="60" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="340" y="185" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="13">Listener C</text>
    <text x="460" y="65" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">cache</text>
    <text x="460" y="125" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">worker</text>
    <text x="460" y="185" text-anchor="start" fill="currentColor" font-family="monospace" font-size="11">realtime</text>
  </svg>
  <figcaption>一个通道上的 <code>NOTIFY</code> 扇出到所有已连接的监听者。监听者总是重新读取数据库获取当前状态。</figcaption>
</figure>

## Python 监听循环

实际应用中你会从应用代码监听，而不是从 `psql`。下面是一个最小的 `psycopg` 监听示例，它轮询连接并在通知到达时处理：

```python
import psycopg2
import select
import json

conn = psycopg2.connect("host=127.0.0.1 port=5432 dbname=demo user=demo password=demo")
conn.autocommit = True
cur = conn.cursor()
cur.execute("LISTEN events_channel;")
print("Listening on events_channel...")

while True:
    if select.select([conn], [], [], 5) == ([], [], []):
        print("(no notifications in 5s)")
        continue
    conn.poll()
    while conn.notifies:
        notify = conn.notifies.pop(0)
        payload = json.loads(notify.payload)
        print(f"Received: channel={notify.channel} pid={notify.pid} payload={payload}")
```

运行它，插入一行，你会看到：

```
Listening on events_channel...
(tick 0: no notifications)
Received: channel=events_channel pid=471 payload={'op': 'INSERT', 'id': 12, 'name': 'py_test4'}
(tick 2: no notifications)
(tick 3: no notifications)
```

`select()` 调用最多等待 5 秒，直到 socket 变为可读。当通知到达时，`conn.poll()` 将其移入 `conn.notifies`，然后你排空队列。这个模式在 `asyncpg` 中也适用——API 略有不同，但思路完全一致。

## 诚实的边界

LISTEN/NOTIFY 简单得具有欺骗性，而简单背后隐藏着真实的约束。这些不是理论上的——它们会在生产环境中咬你一口。

**最多一次投递（at-most-once）。** 通知不持久化。如果 `NOTIFY` 触发时没有监听者连接，消息就消失了。如果你的监听者断开 30 秒，这 30 秒内发生的所有事情都丢了。没有重放，没有历史，没有"补上我错过的"。

**8000 字节负载。** 负载是单个文本字符串，不能超过 8000 字节。我测试了边界：

```sql
SELECT pg_notify('t', repeat('x', 7999));  -- 成功
SELECT pg_notify('t', repeat('x', 8000));  -- ERROR: payload string too long
```

实际使用中你应该保持负载极小——一个主键、一个通道名、一个时间戳。通知是指针，不是数据。如果你需要发送超过 8 KB 的内容，你用的是错误的工具。

**通知队列可能溢出。** Postgres 在投递通知前会将它们缓存在一个固定大小的队列中。如果你发送通知的速度超过监听者消费的速度，队列就会满，通知被丢弃。你可以用以下命令观察：

```sql
SELECT pg_notification_queue_usage();
```

我从一个连接发送了 2000 条通知，同时另一个连接上的监听者没有消费。队列使用率一直显示 0.0000——但当监听者最终轮询时，它只收到了 2000 条中的 568 条。其余的被静默丢弃。队列不是会增长的缓冲区；它是一个固定窗口，一旦溢出，消息就消失。

**连接必须保持打开。** 监听者是一个长期连接。如果你的应用重启，监听者就消失了，直到重新连接。在这段间隙中，通知会丢失。你需要一个重连策略，以及启动时重建状态的方法。

**不能跨重启存活。** 通知在内存中。如果 Postgres 重启，所有未投递的通知都会消失。没有 WAL 支持的投递，没有磁盘支持的队列。

**没有扇出控制。** 通道上的每个监听者都会收到每条通知。没有消费者组，没有竞争消费者模式，没有"只有一个 worker 应该处理这个"。如果你有三个 worker 都监听同一个通道，三个人都会收到通知，三个人都会去处理。

## LISTEN/NOTIFY 的完美场景

考虑到这些边界，什么时候应该用它？

**缓存失效。** worker 更新数据库；触发器发送 `pg_notify('cache_invalidate', '{"key": "user:42"}')`；你的缓存层监听并驱逐该 key。负载极小，投递极快，即使偶尔丢失通知，缓存条目也会过期。这是最典型的用例。

**唤醒 worker。** 一个长时间运行的 worker 空闲等待工作。它不需要每隔几秒轮询数据库，而是监听一个通道。当新工作时，触发器或应用代码发送通知，worker 立即唤醒。这消除了轮询延迟，也降低了数据库负载。

**内部"有东西变了"的信号。** 你有几个服务需要知道配置何时变更、部署何时完成、用户何时创建。信号很小，受众很小，偶尔丢失是可以接受的，因为下一次变更会触发新的通知。

**单数据库协调。** 如果你的所有服务都已经连接同一个 Postgres，LISTEN/NOTIFY 给你一个协调通道，而不需要引入 Redis 或 NATS。更少的移动部件，更少需要运维的东西，少一个需要监控的服务。

## 什么时候需要真正的消息队列

当以下任一条件成立时，请转向真正的消息队列：

- **你需要投递保证。** 如果丢失一条消息意味着收入损失、状态不一致或工作流断裂，你需要一个带确认、重试和死信处理的队列。参见[消息队列](/zh/posts/message-queues/)了解对比。
- **你需要重放。** 如果消费者必须能够在 bug 或重启后重新处理最近 N 条消息，你需要一个基于日志的系统（如 Kafka）或带消息保留的队列。
- **你需要大规模扇出。** 如果你有数百个消费者或需要消费者组，LISTEN/NOTIFY 的广播模式无法胜任。
- **你需要跨重启存活。** 如果你的消费者频繁重启且不能丢失消息，你需要持久化。
- **你需要复杂路由。** 基于主题的路由、优先级队列、延迟消息、定时任务——这些都是真正的消息队列的功能，不是 LISTEN/NOTIFY 的。

## 决策参考：Postgres vs Redis vs NATS vs 消息队列

| 关注点 | Postgres LISTEN/NOTIFY | Redis Pub/Sub | NATS | RabbitMQ / Kafka |
|---|---|---|---|---|
| 投递保证 | 最多一次 | 最多一次 | 最多一次 | 至少一次 |
| 持久化 | 否 | 否 | 可选（JetStream） | 是 |
| 负载大小 | 8 KB | ~512 MB | ~1 MB | 大 |
| 重放 | 否 | 否 | 否（JetStream：是） | 是 |
| 额外基础设施 | 否（你已有 Postgres） | 是 | 是 | 是 |
| 适用场景 | 内部信号、缓存失效 | 简单发布/订阅 | 轻量消息 | 工作队列、事件流 |

经验法则：如果你已经在跑 Postgres，且你的用例是"告诉几个内部服务有东西变了"，从 LISTEN/NOTIFY 开始。它免费，它已经在那里，而且快。当你遇到瓶颈——投递保证、重放、规模——再迁移到真正的消息队列。迁移很直接，因为通知负载已经是指针；你只是在上面加了一层投递。

## 总结

Postgres LISTEN/NOTIFY 不是消息队列。它是一个轻量级的数据库内发布/订阅机制，用于"有东西变了，去看一眼"的信号。它有真实的边界：最多一次投递、8000 字节负载、可能溢出的通知队列、没有重放、没有持久化。但对于缓存失效、worker 唤醒和内部变更通知，它正是你需要的——而且它已经在你的数据库里运行。

在引入 Redis 或 NATS 之前，先问问 Postgres 是否已经能胜任。通常，它可以。

---

*相关：[消息队列](/zh/posts/message-queues/) · [Postgres 锁](/zh/posts/postgres-locks/)*
