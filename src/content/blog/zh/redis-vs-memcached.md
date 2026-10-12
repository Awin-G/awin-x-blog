---
title: "Redis vs Memcached：你到底该用哪个缓存？"
description: "Redis 和 Memcached 都是内存键值缓存，所以真正的问题不是速度，而是能力边界。本文用一次性的 Redis 7.4 与 Memcached 1.6 容器跑出真实输出：同一个值的存取、INFO 与 stats、TTL 过期、LRU/LFU 淘汰、1MB 条目上限与无持久化，以及 Memcached 根本不具备的那些数据类型。"
pubDate: 2026-12-22
lang: zh
translationKey: redis-vs-memcached
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis vs Memcached
  - Redis
  - Memcached
  - 内存缓存
  - 淘汰
---

**Redis vs Memcached** 几乎总是被摆成一场赛跑，而这场赛跑本身就是错的问法。两者都是**内存缓存**服务器，一个 `GET` 都在微秒级返回；在你真会部署的硬件上，谁都不在这场「速度」之争里赢得能改变你一天的东西，而一个孤零零的每秒查询数，只是一份把你自己的工作负载排除在外的跑分。真正的差别是能力边界：**Memcached** 把一件事做到极致；**Redis** 是一台小型数据结构服务器，只不过碰巧也是个极好的缓存。以下是务实版本，全部来自真实输出——我并排跑了一次性的 Redis 7.4.11 和 Memcached 1.6.45 容器，向两者问同样的问题，把返回结果原样贴出来。

## 两者都是内存缓存——差别在能力边界，不在速度

我见过的每一场 **Redis vs Memcached** 争论，最后都塌缩成两个人在捍卫自己技术栈里已经在跑的那台服务。这没有用。两者都把数据放在 RAM、都靠客户端 sharding 扩展读、都在 TCP 上用一套极简协议、都极其快。如果你永远只做 `SET key value` 和 `GET key`，在你感知得到的层面上它们可以互换，那就选你能运维好的那个。

差别只在你要求缓存做*更多*事的那一刻出现：存一个 hash、挺过一次重启、扇出一条消息、跑一段脚本、按频率淘汰。整个决策就这一句话，而且能塞进一张表。

| | Memcached | Redis |
|---|---|---|
| 数据模型 | 只有字符串（`set`/`get`/`incr`/`append`/`cas`） | 字符串、hash、list、set、sorted set、stream、bitmap、HyperLogLog |
| 命令数量 | 约 15 条 | 约 250 条 |
| 线程模型 | 多线程（默认 4 个工作线程） | 命令默认在单线程上执行 |
| 条目大小 | 默认 1 MiB，硬上限 | 每个字符串最大 512 MB |
| 持久化 | 无——只在内存 | RDB 快照、AOF、复制 |
| 淘汰策略 | 各 slab class 内 LRU | LRU、LFU、`volatile-*`、`allkeys-*`、`noeviction` |
| Pub/Sub、Lua、事务 | 无 | 有 |
| 集群 / 高可用 | 仅客户端分片 | Redis Cluster、Sentinel、模块 |
| 最适合 | 跨多核、超大的纯字符串缓存 | 几乎其他所有场景 |

## 这些输出是怎么来的

两个容器，事后删除，不做任何跑分声明：

```bash
docker run -d --name rvc-redis     -p 127.0.0.1:16379:6379 redis:7-alpine
docker run -d --name rvc-memcached -p 127.0.0.1:11211:11211 memcached:1.6-alpine
```

也就是 `Redis server v=7.4.11` 和 `memcached 1.6.45`。镜像大小已经讲出了权衡的一半——`memcached:1.6-alpine` 压缩后 6 MB，`redis:7-alpine` 是 16.7 MB——这个差距正是我那篇讲 [为什么容器镜像大小很重要](/zh/posts/container-image-size/) 的主题。下面每一行都可复现；键数量刻意很小，因为一份没有你的键大小、命中率和查询组合的跑分只是民间传说。

## 同一个值，各自存一遍、取一遍

先看 Redis，用它自带的客户端：

```bash
$ docker exec rvc-redis redis-cli SET greeting "hello from redis"
OK
$ docker exec rvc-redis redis-cli GET greeting
hello from redis
```

Memcached 的文本协议做同一件事，而这条命令的形态值得细读：`set <key> <flags> <exptime> <bytes>`。客户端必须在发送*之前*就知道负载长度。

```text
set greeting 0 0 16
hello from redis
STORED

get greeting
VALUE greeting 0 16
hello from redis
END
```

现在问它们各自在做什么。Redis 在 `INFO` 里报告累计的命中/未命中计数：

```bash
$ docker exec rvc-redis redis-cli INFO stats | grep keyspace
keyspace_hits:6
keyspace_misses:3
$ docker exec rvc-redis redis-cli INFO memory | grep -E 'used_memory_human|maxmemory'
used_memory_human:1.01M
maxmemory_human:0B
```

Memcached 通过 `stats` 报告同一个概念：

```text
STAT cmd_get 9
STAT cmd_set 1
STAT get_hits 6
STAT get_misses 3
STAT curr_items 1
STAT total_items 1
STAT bytes 83
STAT limit_maxbytes 67108864
STAT evictions 0
```

两者都正确追踪到 6 次命中和 3 次未命中，谁也没藏着自己的行为。但看内存：Memcached 把整个数据集记成 `bytes`（83），而 Redis 的 `used_memory_human` 在只有一个键时已经是 1.01 MB——这是更重引擎的基线开销。它不是浪费，而是把大得多的功能面扛在 RAM 里。请把它算进预算。

## Memcached 的性格：多线程、LRU，仅此而已

问 Memcached 它的配置，它会告诉你它的整个世界观：

```text
STAT maxconns 1024
STAT evictions on
STAT num_threads 4
STAT item_size_max 1048576
STAT slab_reassign yes
```

四个工作线程、1 MB 条目上限、LRU，没别的。这份简单正是它的特性。因为它只存不透明的字节串，Memcached 可以把每个连接交给任意线程，让内核调度器把活铺满所有核心；没有需要全局锁的共享数据结构。在一台 32 核的机器上，这就是 Memcached 真正的杀手锏。

Redis 是刻意反着来的。它的命令执行是单线程的——正是这个设计让它的数据结构操作能做到原子——线程相关的开关也印证了这点：

```bash
$ docker exec rvc-redis redis-cli CONFIG GET io-threads
1
$ docker exec rvc-redis redis-cli INFO server | grep io_threads_active
io_threads_active:0
```

具体点说，Memcached 大约暴露十五条命令，而 Redis 报出这个：

```bash
$ docker exec rvc-redis redis-cli COMMAND COUNT
250
```

那一个数字就是整个权衡。Redis 的单命令线程对大多数工作负载够快（瓶颈通常是网络和内存，不是 CPU），但这也解释了为什么「多加几个核」不像 Memcached 那样自动等于「Redis 吞吐更高」。

## Redis 的丰富——以及它的代价

这 250 条命令买来的是这些。Redis 存储真正的服务端数据结构，于是往返应用的次数变少了：

```bash
$ docker exec rvc-redis redis-cli HSET user:1 name alice role admin
2
$ docker exec rvc-redis redis-cli TYPE user:1
hash
$ docker exec rvc-redis redis-cli RPUSH queue a b c
3
$ docker exec rvc-redis redis-cli TYPE queue
list
$ docker exec rvc-redis redis-cli SADD tags redis cache eviction
3
$ docker exec rvc-redis redis-cli ZADD board 10 alice 30 bob 20 carol
3
$ docker exec rvc-redis redis-cli ZREVRANGE board 0 -1 WITHSCORES
bob
30
carol
20
alice
10
```

Memcached 连解析这些命令都做不到——它们会以 `ERROR` 返回。不是哪里坏了，而是这套词汇根本不存在：

```text
hset user:1 name alice   -> ERROR
rpush queue a            -> ERROR
sadd tags redis          -> ERROR
zadd board 10 alice      -> ERROR
```

Memcached *确实*有的东西一只手数得完：计数用的 `incr`/`decr`、字符串拼接的 `append`/`prepend`，以及乐观并发用的 `cas`。

```text
incr counter 5           -> 15
decr counter 3           -> 12
gets counter             -> VALUE counter 0 2 4  12  END   # 那个 "4" 就是 CAS token
append word bar          -> STORED
get word                 -> VALUE word 0 6  foobar  END
```

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="两个面板。Memcached：四个工作线程各自连到一个扁平字符串存储，只在内存里，没有磁盘。Redis：单条命令线程连到带类型的数据结构、磁盘上的 RDB/AOF 文件、副本，以及一个 pub/sub 频道。">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="24" font-weight="600" font-size="14">活儿在哪里发生</text>

    <text x="20" y="58" font-size="12" font-weight="600">Memcached · 多线程，一种形态</text>
    <rect x="20" y="70" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="104" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="138" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="172" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="50" y="87" font-size="10" text-anchor="middle">线程</text>
    <text x="50" y="121" font-size="10" text-anchor="middle">线程</text>
    <text x="50" y="155" font-size="10" text-anchor="middle">线程</text>
    <text x="50" y="189" font-size="10" text-anchor="middle">线程</text>
    <line x1="80" y1="84" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="117" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="151" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="185" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <rect x="180" y="105" width="120" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="240" y="125" font-size="11" text-anchor="middle">扁平字符串存储</text>
    <text x="240" y="141" font-size="10" text-anchor="middle" opacity="0.75">仅内存 · LRU</text>

    <text x="380" y="58" font-size="12" font-weight="600">Redis · 单条命令线程，多种形态</text>
    <rect x="380" y="105" width="80" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="420" y="125" font-size="11" text-anchor="middle">命令</text>
    <text x="420" y="141" font-size="11" text-anchor="middle">线程</text>
    <line x1="460" y1="118" x2="540" y2="88" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <line x1="460" y1="128" x2="540" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <line x1="460" y1="138" x2="540" y2="168" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <rect x="540" y="72" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="92" font-size="10" text-anchor="middle">sorted set · stream · Lua</text>
    <rect x="540" y="112" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="132" font-size="10" text-anchor="middle">磁盘上的 RDB / AOF</text>
    <rect x="540" y="152" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="172" font-size="10" text-anchor="middle">副本 · pub/sub</text>
    <text x="380" y="220" font-size="10" opacity="0.75">丰富的代价是一把全局命令锁——以及更多会被配错的旋钮</text>
  </g>
</svg>
<figcaption>Memcached 把并行都花在吞吐上；Redis 把它的单线程花在保证和类型上。两个选择都不免费，而且都是刻意的。</figcaption>
</figure>

代价是真实的。Redis 的单命令线程意味着一次缓慢的 `KEYS *` 或一段沉重的 Lua 脚本会卡住*每一个*客户端；Memcached 没有这种全局停顿。Redis 也有更多旋钮，以及一种经典误用：把它当成主数据库。如果你想要让 Redis 保持本分的那些模式（cache-aside、限流、stream、锁），我那篇 [真正有用的 Redis 模式](/zh/posts/redis-patterns/) 用同样风格的实时输出逐个讲过了。

## TTL 与淘汰：LRU 是标配，LFU 是 Redis 的加菜

两者都会让键过期。Redis 会把 TTL 倒数并明确告诉你它到哪一步了；Memcached 只是让键消失。

```bash
$ docker exec rvc-redis redis-cli SET session:abc "token-xyz" EX 3
OK
$ docker exec rvc-redis redis-cli TTL session:abc
3
$ docker exec rvc-redis redis-cli GET session:abc      # 4 秒后——键没了
                      （无输出）
$ docker exec rvc-redis redis-cli TTL session:abc
-2
```

```text
set session:abc 0 3 9
token-xyz
STORED
get session:abc        # 立刻
VALUE session:abc 0 9
token-xyz
END
get session:abc        # 4 秒后
END
```

淘汰才是两者分道扬镳的地方。我把 Redis 的内存上限设为 2 MB、策略设为 `allkeys-lru`，往里写了四十个 100 KB 的值：

```bash
$ docker exec rvc-redis redis-cli CONFIG SET maxmemory 2mb
$ docker exec rvc-redis redis-cli CONFIG SET maxmemory-policy allkeys-lru
$ docker exec rvc-redis redis-cli INFO stats | grep evicted_keys
evicted_keys:35
$ docker exec rvc-redis redis-cli INFO memory | grep -E 'used_memory_human|maxmemory_human'
used_memory_human:1.90M
maxmemory_human:2.00M
$ docker exec rvc-redis redis-cli DBSIZE
5
```

我对 Memcached 做了同样的事，用 `-m 2`（2 MB），同样四十个 100 KB 条目：

```text
attempted 40 items of 100000 bytes -> STORED 40
STAT limit_maxbytes 2097152
STAT bytes 2001480
STAT curr_items 20
STAT total_items 40
STAT evictions 20
STAT items:32:evicted 20
```

把这两段并排读，接口的差别很重要：Redis *主动告诉我*它淘汰了（35 个键没了），而 Memcached 对全部四十次写入都爽快回 `STORED`，然后默默腾地方——`total_items 40` 已写、`curr_items 20` 存活、`evictions 20`。Memcached 从不拒绝写入，它为了接纳而淘汰。在你纳闷某个键去哪了之前，先知道这一点。

另一个差别是*替换策略*。Memcached 就是 LRU（每个 slab class 内）。Redis 让你选，还多了 LFU——淘汰最不*频繁*使用的，而不是最久未使用的：

```bash
$ docker exec rvc-redis redis-cli CONFIG SET maxmemory-policy allkeys-lfu
OK
$ docker exec rvc-redis redis-cli GET hot   # 40 次
$ docker exec rvc-redis redis-cli OBJECT FREQ hot
7
$ docker exec rvc-redis redis-cli OBJECT FREQ cold
4
```

对经典缓存来说，LRU 就够了，两者都做得到。LFU 的价值出现在一波冷键否则会把热集合挤出去的时候——一次扫描、一个爬虫、一个批处理任务——这上面 Memcached 没有内置答案。

## Memcached 的两条硬上限：1 MB 条目与无持久化

第一条是条目大小。让默认服务器存任何超过 1 兆字节的东西，它在协议层就拒绝，甚至在你把内容发完之前：

```text
   under declared size   1000000: STORED
exact_1MiB declared size  1048576: SERVER_ERROR object too large for cache
    over declared size   1048577: SERVER_ERROR object too large for cache
STAT item_size_max 1048576
```

连正好 1 MiB 都失败，因为上限把条目开销也算进去了。你*可以*用 `-I` 抬高它，但 Memcached 的整个内存模型是围绕一个假定小对象的 slab 分配器建的。Redis 没有这种天花板——单个字符串能到 512 MB：

```bash
$ head -c 2097152 /dev/zero | tr '\0' 'x' | docker exec -i rvc-redis redis-cli -x SET bigvalue
OK
$ docker exec rvc-redis redis-cli STRLEN bigvalue
2097152
$ docker exec rvc-redis redis-cli CONFIG GET proto-max-bulk-len
536870912
```

（这并不等于许可你把大对象塞进 Redis——大值意味着大的复制流量和 OOM 压力。两者都偏好小对象。）

第二条是持久化。Memcached 就是内存，句号。我存了一个键，重启容器，再问一次：

```text
get persist:key     # 重启前
VALUE persist:key 0 18
survives a restart
END
get persist:key     # 重启后
END
```

Redis 执行一次 `SAVE` 后，扛过了同一次重启：

```bash
$ docker exec rvc-redis redis-cli SET persist:key "survives a restart"
OK
$ docker exec rvc-redis redis-cli SAVE
OK
$ docker exec rvc-redis redis-cli INFO persistence | grep aof_enabled
aof_enabled:0
$ docker restart rvc-redis
$ docker exec rvc-redis redis-cli GET persist:key
survives a restart
```

注意这个诚实的告诫：Redis 持久化是*可选*且*可调*的，而且它和数据库那种耐久性不是一回事。RDB 快照会丢掉自上次保存以来写入的一切；AOF（`appendfsync everysec`）最多可能丢一秒。但「可以被弄成能扛过重启」和「按设计就不可能」是类别上的差别，这也正是 Memcached 是缓存、而 Redis 可以（谨慎地）当一个小型存储的原因。

## 什么时候 Memcached 真的是更好的选择

我想说句公道话，因为诚实的答案是 Memcached 有一块真实的生态位，而且不是怀旧：

- **一个巨大的、简单的、纯字符串缓存。** 如果你的访问模式就是对 JSON 或渲染好的片段做 `GET`/`SET`，Memcached 就是完整产品，一个旋钮都不多。
- **多核、单一扁平键空间。** 因为它是多线程且每次请求无锁，Memcached 的吞吐几乎随工作线程数线性伸缩——`-t` 就是那个旋钮。Redis 的单命令线程做不到，`io-threads` 只卸载网络，不卸载命令执行。
- **你不想留诱惑。** 没有持久化、没有数据结构，就没人能把你的缓存悄悄变成一台意外的数据库。
- **极小的体积。** `memcached:1.6-alpine` 压缩后 6 MB，对比 Redis 的 16.7 MB。

这份清单之外的一切——想扛过一次发布的 session、计数器和排行榜、队列与 stream、pub/sub 扇出、Lua、集群模式、模块——都是 Redis，而且往往不是险胜。

## 那到底用哪个？一份决策清单

别再问谁更快，按顺序问这些：

1. **你需要的只是对字符串做 get/set 吗？** 需要 hash、list、set、sorted set、stream、pub/sub、Lua → Redis。纯字符串 → 继续往下看。
2. **数据需要活过一次重启吗？** 那就 Redis，或者一个真正的数据库。Memcached 会把它丢掉，正确地、安静地丢掉。
3. **这是一个跨多核、巨大而简单、且不需要数据结构能力的缓存吗？** Memcached 是个合理且出色的答案——而且常常是最无聊的那个。
4. **你需要一种能扛过冷键突袭的淘汰吗？** Redis 的 LFU；Memcached 只有 LRU。
5. **你想用一台服务器同时搞定缓存、计数器、锁和队列吗？** Redis。更少的活动部件，胜过一套你得喂养的双系统栈。
6. **还是拿不定主意？** 选 Redis。它是 Memcached 那活儿的一个超集，多出来的能力花的是你的内存和运维精力，而不是一次重写。

结论平淡得无聊：**Redis vs Memcached** 不是关于速度。Memcached 是为一件活打磨锋利的单件工具；Redis 是一个碰巧装着这件工具的工具箱。选你需要的那个边界，然后为更丰富的那个付出它索要的内存和纪律。
