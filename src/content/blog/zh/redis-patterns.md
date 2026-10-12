---
title: "真正有用的 Redis 模式：cache-aside、限流、Streams 与分布式锁"
description: "一份务实的 Redis 模式指南：cache-aside 配 TTL 与真实的 SET NX EX 防击穿锁、INCR 限流的固定窗口与滑动窗口、队列与 Streams 的取舍、分布式锁的坑、持久化怎么选，以及 maxmemory 淘汰策略。所有命令都在一次性容器里真跑过，输出为真实结果。"
pubDate: 2026-12-08
lang: zh
translationKey: redis-patterns
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis 模式
  - Redis cache-aside
  - Redis 限流
  - Redis 分布式锁
  - SET NX EX
---

**Redis 模式**会在没人记得它为什么存在之后，继续被复制粘贴。一个带 TTL 的 `SET` 变成了「我们的缓存」，一个 `INCR` 变成了「我们的限流器」，某处的 `SET NX EX` 变成了没人敢动的「我们的分布式锁」。这些模式大多确实值得保留——但前提是你清楚每一个到底在干什么。这篇是务实版本：**Redis cache-aside** 与缓存击穿（stampede）问题、用 `INCR` 做的 **Redis 限流**、队列与 **Redis Streams** 的取舍、**Redis 分布式锁** 以及 Redlock 的争议，还有大家总跳过的持久化和 `淘汰（eviction）` 决策。下面每条命令都在一次性的 `redis:7-alpine` 容器里跑过（`redis-server v=7.4.11`），输出原样粘贴。

## Redis 真正擅长什么

Redis 是一个内存数据结构服务器：数据放在 RAM 里，操作小而原子、可预测——一个 `GET` 就是一个 `GET`，不是一份查询计划。这正好适配一组特定的活儿：

- **缓存** —— 可重建的计算结果，放在应用旁边。
- **计数器** —— 统计、配额、连接数的原子自增。
- **限流** —— 一个计数器，或一个带时间窗口的集合。
- **临时队列** —— 机器挂了可以丢掉的工作。
- **排行榜** —— 有序集合，`ZADD` 加 `ZRANGE`，排名白送。
- **锁** —— 短命、尽力而为的互斥。

注意它们的共同点：每一个都是 *可推导* 或 *临时* 的。整个 keyspace 丢了你都能重建。正是这个性质让 Redis 成为极好的缓存、极差的事实来源（source of truth）。

## 人们把 Redis 用错在哪

最常见的两种误用。第一是 **把 Redis 当主数据库**。它有可选的持久化（后面会讲），但它从来不是为「你记录的持久、可查询、强一致的家」而设计的。第二是 **把 Redis 当巨型 blob 存储**——把几 MB 的 JSON、PDF 或图片往里塞。Redis 把所有东西放在 RAM，值类型也是为偏小的对象优化的；大值意味着巨大的复制流量，以及数据集一超内存就 OOM。

判断标准就一个问题：*如果此刻 keyspace 消失了，什么会坏掉？* 答案若是「没事，我们重建」，那你用对了。答案若涉及恢复预案，那你手里握着一个比你本来就有的数据库宽容得多的数据库。

## Redis cache-aside：TTL 与缓存击穿问题

Cache-aside（也叫懒加载）是应用自己掌管缓存的模式。读的时候先问 Redis；未命中就从源里算出来，带 TTL 写回，再返回。Redis 自己不取数据——它只存你放进去的东西。

```text
127.0.0.1:6379> SET user:42:profile '{"name":"Ada","plan":"pro"}' EX 300
OK
127.0.0.1:6379> GET user:42:profile
"{\"name\":\"Ada\",\"plan\":\"pro\"}"
127.0.0.1:6379> TTL user:42:profile
(integer) 300
127.0.0.1:6379> GET user:99:profile
(nil)
```

未命中返回 `(nil)`，这就是你去打数据库并回填的信号。一定设 TTL——上面那个 `EX 300`。没有 TTL，一个你从不失效的键就变成了一句比它描述的数据活得还久的谎言。TTL 限定了陈旧答案最多能活多久。

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="cache-aside 读流程：应用先查 Redis。命中就直接返回值。未命中则先取 SET NX EX 锁，只有抢到的那个调用者去数据库重建，并带 TTL 写回 Redis。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <rect x="30" y="120" width="110" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="85" y="150" text-anchor="middle">应用</text>
    <rect x="250" y="40" width="130" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="315" y="70" text-anchor="middle">Redis（缓存）</text>
    <rect x="250" y="210" width="130" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="315" y="240" text-anchor="middle">数据库</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none">
      <path d="M140 138 L250 66" marker-end="url(#a)"/>
      <path d="M250 80 L140 146" marker-end="url(#a)" stroke-dasharray="4 3"/>
      <path d="M140 158 L250 232" marker-end="url(#a)"/>
      <path d="M250 218 L140 168" marker-end="url(#a)"/>
    </g>
    <text x="200" y="88" text-anchor="middle" font-size="11">GET key</text>
    <text x="205" y="118" text-anchor="middle" font-size="11" opacity="0.75">命中 → 返回</text>
    <text x="200" y="212" text-anchor="middle" font-size="11">未命中 → 查库</text>
    <text x="205" y="255" text-anchor="middle" font-size="11" opacity="0.75">SET key ... EX ttl</text>
    <text x="470" y="120" font-size="12" font-weight="600">只有一个去重建：</text>
    <text x="470" y="145" font-size="12" font-family="ui-monospace, monospace">SET lock NX EX 10</text>
    <text x="470" y="166" font-size="11" opacity="0.75">其余等待，再重读缓存</text>
    <defs>
      <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>cache-aside 的读流程。锁只在热点键在高负载下过期时才有意义——那就是击穿。</figcaption>
</figure>

### 缓存击穿（stampede）与真实的 SET NX EX 锁

失效模式很容易复现。一个热点键过期了。一百个请求在同一瞬间未命中。这一百个都去数据库重建 *同一个* 值，你的源被一个过期键打满。这就是 **缓存击穿**（也叫 thundering herd / 惊群）。

解法是让恰好一个调用者去重建，其余人等缓存。`SET key value NX EX seconds` 是原子的：只有当键不存在时才设置，带过期时间，一次往返完成。第一个调用者赢；其他人看到已存在的锁。

```text
127.0.0.1:6379> SET lock:rebuild:home:feed tok-1 NX EX 10
OK
127.0.0.1:6379> SET lock:rebuild:home:feed tok-2 NX EX 10
(nil)
127.0.0.1:6379> TTL lock:rebuild:home:feed
(integer) 10
```

第二个 `SET` 返回 `(nil)`——它没有覆盖。整个锁就这些：只有 `tok-1` 的持有者继续。两个细节让它安全。第一，`EX 10` 比锁本身更重要：如果赢家重建到一半崩了，锁必须自己过期，否则这个键永远卡住。第二，释放锁时 **必须确认你仍持有它**，否则一个慢的赢家会删掉快的新来者的锁。用 token 校验来做，并且放到服务端以保证原子：

```text
127.0.0.1:6379> EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 lock:rebuild:home:feed tok-2
(integer) 0
127.0.0.1:6379> EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 lock:rebuild:home:feed tok-1
(integer) 1
127.0.0.1:6379> EXISTS lock:rebuild:home:feed
(integer) 0
```

`tok-2` 的持有者拿到 `0`——它的释放被拒绝，因为它从未持有锁。`tok-1` 的释放成功，键没了。

## Redis 限流：INCR，固定窗口 vs 滑动窗口

计数器模式就一条命令。`INCR` 是原子的，所以并发调用者不会竞争出丢失更新。用 `EXPIRE` 挂一个窗口，你就有了一版限流。

```text
127.0.0.1:6379> INCR api:req:203.0.113.7
(integer) 1
127.0.0.1:6379> INCR api:req:203.0.113.7
(integer) 2
127.0.0.1:6379> EXPIRE api:req:203.0.113.7 60
(integer) 1
127.0.0.1:6379> TTL api:req:203.0.113.7
(integer) 60
```

显而易见的写法里藏着两个 bug。如果你分两次调用 `INCR` 再 `EXPIRE`，进程在中间挂了，键就没有 TTL，计数器永远活着——经典的「永不复位的限流」。而每次请求都重跑 `EXPIRE` 会不断 *延长* 窗口，于是持续流量永远不会让计数器复位。修法是 `EXPIRE ... NX`，只在还没有 TTL 时设置：

```text
127.0.0.1:6379> INCR rl:fixed:9.9.9.9
(integer) 1
127.0.0.1:6379> EXPIRE rl:fixed:9.9.9.9 60 NX
(integer) 1          # 第一次命中占住窗口
127.0.0.1:6379> INCR rl:fixed:9.9.9.9
(integer) 2
127.0.0.1:6379> EXPIRE rl:fixed:9.9.9.9 60 NX
(integer) 0          # 后续命中不碰窗口
127.0.0.1:6379> TTL rl:fixed:9.9.9.9
(integer) 60
```

这是 **固定窗口**：便宜，用于多数滥用防护够用，但有个边界怪癖——客户端可以在一个窗口末尾打满额度，再到下个窗口开头又打满一次。**滑动窗口** 用按时间戳打分的有序集合修掉它，计数前先裁掉超出窗口的成员：

```text
127.0.0.1:6379> ZADD rl:sliding:9.9.9.9 1791795400 req1
(integer) 1
127.0.0.1:6379> ZADD rl:sliding:9.9.9.9 1791795430 req3
(integer) 1
127.0.0.1:6379> ZREMRANGEBYSCORE rl:sliding:9.9.9.9 -inf 1791795370
(integer) 0
127.0.0.1:6379> ZCARD rl:sliding:9.9.9.9
(integer) 3
127.0.0.1:6379> ZREMRANGEBYSCORE rl:sliding:9.9.9.9 -inf 1791795460
(integer) 3          # 全部过期
127.0.0.1:6379> ZCARD rl:sliding:9.9.9.9
(integer) 0
```

滑动窗口要为每个被跟踪的客户端付出内存，每请求多一次写入。如果你要做更复杂的东西——令牌桶、按路由限流——我在 [超出一个计数器的限流](/zh/posts/rate-limiting/) 里写了更完整的设计；与之相邻的、不让重试客户端被重复扣费的问题在 [幂等键](/zh/posts/idempotency-keys/)。

## 队列与 Streams：LPUSH/BRPOP vs XADD/XREADGROUP

Redis 列表是最原始的队列。生产者 `LPUSH` 到头部，消费者从尾部 `BRPOP`，阻塞弹出让空闲 worker 睡觉而不是空转：

```text
127.0.0.1:6379> LPUSH queue:tasks 'task:1'
(integer) 1
127.0.0.1:6379> LPUSH queue:tasks 'task:2'
(integer) 2
127.0.0.1:6379> LRANGE queue:tasks 0 -1
1) "task:2"
2) "task:1"
127.0.0.1:6379> BRPOP queue:tasks 1
1) "queue:tasks"
2) "task:1"
```

推头、弹尾，就得到 FIFO。简单又快。但要老实承认它 **不是** 什么：`BRPOP` 一交给你就把条目移除了，所以 worker 干到一半崩了，那个任务就没了。没有 ack、没有重试、没有历史。队列为空时它阻塞，然后放弃：

```text
127.0.0.1:6379> BRPOP queue:tasks 1
(nil)
```

如果任务丢失不可接受，用 stream。`XADD` 追加到一条日志，每个条目有 ID 且原地保留，消费者组记录哪些已投递、哪些还没确认：

```text
127.0.0.1:6379> XADD jobs:emails '*' type welcome to ada@example.com
"1791795312268-0"
127.0.0.1:6379> XLEN jobs:emails
(integer) 2
127.0.0.1:6379> XGROUP CREATE jobs:emails workers 0
OK
127.0.0.1:6379> XREADGROUP GROUP workers alice COUNT 2 STREAMS jobs:emails '>'
1) 1) "jobs:emails"
   2) 1) 1) "1791795312268-0"
         2) 1) "type"
            2) "welcome"
            3) "to"
            4) "ada@example.com"
127.0.0.1:6379> XPENDING jobs:emails workers
1) (integer) 2
2) "1791795312268-0"
3) "1791795312363-0"
4) 1) 1) "alice"
      2) "2"
```

那两个 pending 条目正是重点：它们已投递但从未 `XACK`，所以崩溃消费者的活儿可以用 `XCLAIM` 回收。Streams 比列表重——它保留历史，这要么是特性，要么是磁盘账单。按和别的模式一样的问题来选：这条消息丢了会怎样？

## Redis 分布式锁：SET NX EX 与 Redlock 的坑

防击穿那节的锁就是诚实的基本原语：`SET id value NX EX ttl` 获取，token 校验释放，TTL 扛崩溃。这覆盖了绝大多数真实需求——「这个 cron 别跑两份」「一个 worker 重建这个键」。

麻烦从人们想要一个 **正确性关键（correctness-critical）** 的分布式锁开始，那种守护金钱或跨集群独占所有权的锁。`SET NX EX` 有裂缝：持有者停顿（GC、慢盘、`SIGSTOP`），TTL 过期，另一个节点拿到锁，现在两个进程都以为锁在自己手里。TTL 既不能短于你最坏的停顿，也不能长于你能容忍死掉的持有者。

Redlock（多节点算法）试图通过在多数独立 Redis 节点上获取来让锁健壮。它至今有争议。它的安全论证假设时钟漂移有界、停顿有界；在长时间 GC 停顿或时钟跳变下，同一个重叠持有窗口又回来了。我的规则很直接：**如果锁失效意味着数据损坏或双花，这个锁就不该只活在 Redis 里**——在写路径里放 fencing token，或让数据库用条件写、唯一约束来强行保证不变量。Redis 锁擅长 *协调* 和 *效率*；它不是持久一致性检查的替代品。

## 持久化的现实：RDB、AOF，还是「我不在乎，它就是个缓存」

Redis 给你两套持久化机制，而很多人两套都不开。开箱你就得到 RDB 时间点快照：

```text
127.0.0.1:6379> CONFIG GET save
1) "save"
2) "3600 1 300 100 60 10000"
127.0.0.1:6379> CONFIG GET appendonly
1) "appendonly"
2) "no"
127.0.0.1:6379> INFO persistence
rdb_changes_since_last_save:18
rdb_last_save_time:1791795305
aof_enabled:0
```

把 `save` 那行读成：3600 秒内有 1 个键改动，或 300 秒内有 100 个，或 60 秒内有 10000 个，就快照一次。两次快照之间，非正常关机就会丢掉自上次快照以来的改动。AOF（append-only file）记录每一次写，可以每秒 `fsync` 一次或每条命令一次，用磁盘和延迟换持久性。

回答一个问题就够了。如果这是 **缓存**，诚实的配置就是完全不开持久化——让数据随进程一起死，因为事实来源在别处。如果它存着你无法重建的东西，那就打开 AOF `everysec`，*并且* 接受 Redis 现在就是一个带着数据库问题的数据库：复制延迟、故障转移、备份，整张清单。「它就是个缓存」不是一个可以忘掉的配置；它是一个要有意做出的决定。

## 内存：maxmemory 与淘汰（eviction）

大家跳过的最后一个决定，是 Redis 内存耗尽时会发生什么。默认是拒绝写入，而不是丢数据：

```text
127.0.0.1:6379> CONFIG GET maxmemory
1) "maxmemory"
2) "0"                 # 无限制——会用光所有 RAM，然后被杀
127.0.0.1:6379> CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "noeviction"        # 写入开始失败，而不是淘汰
```

`maxmemory 0` 意思是「无上限」——压力之下由操作系统 OOM killer 决定你的命运。设一个真实上限，并选一个匹配负载的淘汰策略：

```text
127.0.0.1:6379> CONFIG SET maxmemory 100mb
OK
127.0.0.1:6379> CONFIG SET maxmemory-policy allkeys-lru
OK
127.0.0.1:6379> CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "allkeys-lru"
```

对纯缓存，`allkeys-lru`（淘汰最久未使用的键）通常是正确答案——你宁愿丢掉一个冷键，也不愿拒绝一次写入。如果有些键比别的更重要，`volatile-lru` 只淘汰带 TTL 的键，于是热点且不过期的键能活下来。如果你真的 *什么都不能丢*，那你又回到了想要持久化、更大的机器，或者一个数据库。

## 一句话总结

当数据可重建或临时，Redis 才配得上它的位置。用 `SET ... EX` 做缓存并永远设 TTL；用 `SET NX EX` 防击穿锁护住热点键；用 `INCR` 加 `EXPIRE ... NX` 限流，固定窗口边界太松时就上有序集合。队列（`LPUSH`/`BRPOP`）用于可以丢的工作；streams（`XADD`/`XREADGROUP` 加 `XACK`）用于不能丢的工作。锁是协调，不是正确性。并且对持久化和 `maxmemory` 要有明确决断——「以后再说」正是把一个缓存变成一次故障的方式。
