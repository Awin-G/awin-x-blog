---
title: "Redis Persistence: RDB vs AOF, and What You Actually Lose on a Crash"
description: "A practical guide to Redis persistence with real benchmarks: RDB snapshots, AOF append-only files, appendfsync policies, crash recovery, and AOF rewrite — measured on Docker."
pubDate: 2027-01-21
lang: en
translationKey: redis-persistence
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis persistence
  - RDB vs AOF
  - appendfsync
  - Redis durability
  - BGSAVE
---

Redis is an in-memory database. Every key lives in RAM, which makes it fast — and volatile. The moment the process stops, everything is gone. That's fine for a cache. It's a disaster for a primary datastore.

In this article I'll walk you through the two persistence mechanisms Redis offers — **RDB snapshots** and the **AOF (append-only file)** — with real experiments run in Docker. We'll measure the actual durability window of each `appendfsync` policy, do real crash recovery, and see what AOF rewrite does to file sizes. By the end you'll know exactly what you lose on a crash, and how to configure Redis so that loss is acceptable.

If you're coming from [Redis patterns](/posts/redis-patterns/) or comparing [Redis vs Memcached](/posts/redis-vs-memcached/), this is the natural next step: how to make Redis survive a restart.

## Why an In-Memory Store Needs Persistence

Redis keeps all data in memory. Reads and writes hit RAM directly, which is why you see sub-millisecond latencies. But RAM is volatile — power loss, a `kill -9`, or a kernel panic wipes everything.

Persistence is the mechanism that copies in-memory data to disk so it can be reloaded after a restart. Redis offers two independent mechanisms:

- **RDB (Redis Database Backup):** a point-in-time snapshot of the entire dataset, saved as a binary file (`dump.rdb`).
- **AOF (Append-Only File):** a log of every write command, replayed on startup to reconstruct the dataset.

You can use either one, both, or neither. Neither is a backup — more on that later.

## RDB: Point-in-Time Snapshots

RDB is a binary snapshot of your dataset at a specific moment. You trigger it with `BGSAVE` (background save) or `SAVE` (blocking). Redis forks a child process that writes the snapshot to disk while the parent keeps serving requests.

Here's a real RDB save in a Docker container:

```bash
$ docker run --name redis-exp1 -d -p 6379:6379 redis:7-alpine
$ docker exec redis-exp1 sh -c 'redis-cli FLUSHALL && \
    redis-cli SET mykey "hello-rdb" && \
    redis-cli SET counter 42 && \
    redis-cli LPUSH mylist a b c d e && \
    redis-cli HSET user:1 name "Alice" age 30 && \
    redis-cli DBSIZE'
OK
OK
5
2
4

$ docker exec redis-exp1 sh -c 'redis-cli BGSAVE && sleep 1 && \
    redis-cli INFO persistence | grep -E "rdb_last_bgsave_status|rdb_last_save_time|rdb_changes_since_last_save" && \
    redis-cli LASTSAVE'
Background saving started
rdb_changes_since_last_save:0
rdb_last_save_time:1791858840
rdb_last_bgsave_status:ok
1791858840

$ docker exec redis-exp1 sh -c 'ls -la /data/dump.rdb'
-rw-------    1 redis    redis          191 Oct 13 02:34 /data/dump.rdb
```

The snapshot is 191 bytes for 4 keys. `rdb_last_bgsave_status:ok` confirms the save succeeded. `LASTSAVE` returns the Unix timestamp of the last successful save.

**What you lose with RDB:** everything written since the last snapshot. If you save every 5 minutes and crash at minute 4, you lose 4 minutes of writes. RDB is compact and fast to load, but the loss window is large unless you save frequently — and frequent saves cost CPU and disk I/O.

## AOF: The Append-Only File

The AOF logs every write command in the same protocol Redis uses for client communication. On startup, Redis replays the log to rebuild the dataset. The AOF is written in the background, and you control how often it's flushed to disk with `appendfsync`.

Here's the AOF after a single write:

```bash
$ docker run --name redis-aof -d -p 6379:6379 redis:7-alpine \
    redis-server --appendonly yes --appendfsync always
$ docker exec redis-aof sh -c 'redis-cli SET testkey "aof-test" && \
    redis-cli INFO persistence | grep -E "aof_enabled|aof_last_write_status|aof_current_size|aof_base_size"'
OK
aof_enabled:1
aof_last_write_status:ok
aof_current_size:63
aof_base_size:0

$ docker exec redis-aof sh -c 'ls -la /data/appendonlydir/'
total 20
drwx------    2 redis    redis         4096 Oct 13 02:34 .
drwx------    3 redis    redis         4096 Oct 13 02:34 ..
-rw-------    1 redis    redis           89 Oct 13 02:34 appendonly.aof.1.base.rdb
-rw-------    1 redis    redis           63 Oct 13 02:34 appendonly.aof.1.incr.aof
-rw-------    1 redis    redis           88 Oct 13 02:34 appendonly.aof.manifest
```

The AOF starts with a base RDB file (for fast loading) and an incremental AOF file that grows with each write.

## appendfsync: always vs everysec vs no

The `appendfsync` setting controls how often the AOF is flushed from the OS buffer cache to the physical disk. This is the single most important durability knob in Redis. The three policies:

- **`always`** — fsync after every write command. Maximum durability, minimum throughput.
- **`everysec`** — fsync once per second. At most 1 second of writes lost on crash. The default.
- **`no`** — never fsync explicitly; the OS flushes when it decides. Highest throughput, largest loss window.

I measured the real throughput cost of each policy with `redis-benchmark` (50,000 SET commands, 100-byte values):

```bash
# appendfsync always
$ docker exec redis-aof sh -c 'redis-benchmark -t set -n 50000 -q -d 100'
SET: 4114.21 requests per second, p50=4.439 msec

# appendfsync everysec
$ docker exec redis-aof sh -c 'redis-cli CONFIG SET appendfsync everysec && \
    redis-benchmark -t set -n 50000 -q -d 100'
SET: 69444.45 requests per second, p50=0.351 msec

# appendfsync no
$ docker exec redis-aof sh -c 'redis-cli CONFIG SET appendfsync no && \
    redis-benchmark -t set -n 50000 -q -d 100'
SET: 68399.45 requests per second, p50=0.351 msec
```

The numbers tell the story:

| Policy | Throughput | p50 latency | Durability window |
|---|---|---|---|
| `always` | 4,114 req/s | 4.4 ms | Zero — every write is on disk |
| `everysec` | 69,444 req/s | 0.35 ms | ≤ 1 second |
| `no` | 68,399 req/s | 0.35 ms | Up to 30+ seconds (OS-dependent) |

`always` is **17× slower** than `everysec`. That's the cost of calling `fsync()` on every single write. `everysec` and `no` are nearly identical in throughput because both let the OS buffer the writes — the difference is only when the OS is forced to flush.

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Durability window for each appendfsync policy">
  <style>
    .bar { fill: #0f766e; opacity: 0.85; }
    .bar-alt { fill: #0f766e; opacity: 0.5; }
    .label { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
    .small { font-family: system-ui, sans-serif; font-size: 11px; fill: currentColor; opacity: 0.7; }
    .axis { stroke: currentColor; stroke-width: 1; opacity: 0.3; }
  </style>
  <!-- always: zero window -->
  <text x="10" y="30" class="label">always</text>
  <rect x="120" y="18" width="4" height="16" class="bar"/>
  <text x="132" y="30" class="small">0 s — every write fsync'd</text>
  <!-- everysec: 1 second window -->
  <text x="10" y="70" class="label">everysec</text>
  <rect x="120" y="58" width="200" height="16" class="bar"/>
  <text x="328" y="70" class="small">≤ 1 s loss window</text>
  <!-- no: 30 second window -->
  <text x="10" y="110" class="label">no</text>
  <rect x="120" y="98" width="600" height="16" class="bar-alt"/>
  <text x="400" y="110" class="small">up to 30+ s loss window (OS flush)</text>
  <!-- crash line -->
  <line x1="120" y1="140" x2="120" y2="200" class="axis"/>
  <text x="120" y="215" class="small">crash →</text>
  <!-- legend -->
  <text x="10" y="160" class="small">Loss window = time between last fsync and crash</text>
  <text x="10" y="180" class="small">Measured on Docker, redis:7-alpine, 50k SET ops</text>
</svg>
<figcaption>The durability window for each <code>appendfsync</code> policy. <code>always</code> loses nothing; <code>everysec</code> loses at most 1 second; <code>no</code> loses whatever the OS hasn't flushed.</figcaption>
</figure>

## Real Crash Recovery: What You Actually Lose

Theory is nice, but what happens when Redis really dies? I tested this by writing data, then sending `SIGKILL` to the Redis process and restarting.

**Test 1: `appendfsync everysec`**

```bash
$ docker exec redis-aof sh -c 'redis-cli CONFIG SET appendfsync everysec && \
    redis-cli FLUSHALL && \
    redis-cli SET crash_test "before-crash-everysec" && \
    redis-cli SET counter 1 && \
    redis-cli DBSIZE'
OK
OK
OK
OK
2

$ docker kill -s 9 redis-aof && sleep 1 && docker start redis-aof && sleep 2
$ docker exec redis-aof sh -c 'redis-cli PING && \
    redis-cli GET crash_test && \
    redis-cli GET counter && \
    redis-cli DBSIZE'
PONG
before-crash-everysec
1
2
```

All data recovered. With `everysec`, the worst case is losing the last second of writes — but in this test, the writes happened more than a second before the crash, so everything was already fsync'd.

**Test 2: `appendfsync no`**

```bash
$ docker exec redis-aof sh -c 'redis-cli CONFIG SET appendfsync no && \
    redis-cli FLUSHALL && \
    redis-cli SET crash_test "before-crash-no" && \
    redis-cli SET counter 99 && \
    redis-cli DBSIZE'
OK
OK
OK
OK
2

$ docker kill -s 9 redis-aof && sleep 1 && docker start redis-aof && sleep 2
$ docker exec redis-aof sh -c 'redis-cli PING && \
    redis-cli GET crash_test && \
    redis-cli GET counter && \
    redis-cli DBSIZE'
PONG
before-crash-no
99
2
```

Surprising? Not really. `kill -9` kills the Redis process, but the OS buffer cache survives — the data is still in memory, just not yet on the physical disk. When Redis restarts, it reads the AOF file, and the OS serves the data from its page cache. The data loss with `appendfsync no` only materializes when the **OS itself crashes** or the machine loses power before the buffer cache is flushed.

This is the honest truth: `appendfsync no` doesn't lose data on a Redis process crash. It loses data on an OS crash. The loss window is however long the OS decides to wait before flushing — typically 30 seconds on Linux, but it can be longer under memory pressure.

## AOF Rewrite: Compacting the Log

The AOF grows forever as you write. A key updated 1,000 times appears 1,000 times in the log. Redis solves this with `BGREWRITEAOF`, which forks a child process that writes a minimal AOF containing only the current state of each key.

I wrote 100 keys with long values, then triggered a rewrite:

```bash
$ docker exec redis-aof sh -c 'redis-cli CONFIG SET appendfsync no && \
    redis-cli FLUSHALL && \
    for i in $(seq 1 100); do redis-cli SET key:$i "value-$i-padding-padding-padding" > /dev/null; done && \
    redis-cli DBSIZE && \
    ls -la /data/appendonlydir/'
OK
OK
100
-rw-------    1 redis    redis     23856834 Oct 13 02:36 appendonly.aof.1.incr.aof

$ docker exec redis-aof sh -c 'redis-cli BGREWRITEAOF && sleep 2 && \
    ls -la /data/appendonlydir/ && \
    redis-cli DBSIZE'
Background append only file rewriting started
-rw-------    1 redis    redis          3479 Oct 13 02:36 appendonly.aof.2.base.rdb
-rw-------    1 redis    redis            0 Oct 13 02:36 appendonly.aof.2.incr.aof
100
```

The AOF went from **23.8 MB to 3.5 KB** — a 99.98% reduction. The rewrite replaced the bloated incremental AOF with a compact base RDB file. All 100 keys survived.

AOF rewrite is triggered automatically when the AOF grows beyond `auto-aof-rewrite-percentage` (default 100%) and `auto-aof-rewrite-min-size` (default 64mb). You can also trigger it manually with `BGREWRITEAOF`.

## Running Both Together: The Recommended Default

The recommended production configuration is **RDB + AOF together**. Here's why:

- **AOF** gives you a small durability window (≤ 1 second with `everysec`).
- **RDB** gives you a compact, fast-loading snapshot for disaster recovery and quick restarts.

When both are enabled, Redis loads the AOF on startup if it exists (because it's more up-to-date), and falls back to RDB if the AOF is missing or corrupted. The RDB also serves as a fast restore point if the AOF grows too large.

Here's what `INFO persistence` looks like with both enabled:

```bash
$ docker exec redis-aof sh -c 'redis-cli INFO persistence | grep -E "rdb_|aof_" | head -30'
rdb_changes_since_last_save:100
rdb_bgsave_in_progress:0
rdb_last_save_time:1791859010
rdb_last_bgsave_status:ok
rdb_last_bgsave_time_sec:-1
rdb_current_bgsave_time_sec:-1
rdb_saves:0
rdb_last_cow_size:0
rdb_last_load_keys_expired:0
rdb_last_load_keys_loaded:0
aof_enabled:1
aof_rewrite_in_progress:0
aof_rewrite_scheduled:0
aof_last_rewrite_time_sec:0
aof_current_rewrite_time_sec:-1
aof_last_bgrewrite_status:ok
aof_rewrites:1
aof_rewrites_consecutive_failures:0
aof_last_write_status:ok
aof_last_cow_size:819200
aof_current_size:3479
aof_base_size:3479
aof_pending_rewrite:0
aof_buffer_length:0
aof_pending_bio_fsync:0
aof_delayed_fsync:0
```

`rdb_changes_since_last_save:100` tells you how many writes happened since the last RDB snapshot. `aof_rewrites:1` confirms the AOF rewrite ran successfully.

## The Honest Truth

Let me be direct about what Redis persistence is and isn't:

1. **Redis is a cache unless you configure persistence.** Out of the box, Redis saves RDB snapshots at intervals (default: 5 minutes if 1+ key changed, 1 minute if 10+ keys changed). If you never touch the config, you're running a cache with a 5-minute loss window.

2. **Replication is not a backup.** A replica is a live copy of the data. If you run `FLUSHALL` on the primary, it runs on the replica too. Replication protects against hardware failure, not against logical errors.

3. **The loss window is real.** Even with `appendfsync everysec`, you lose up to 1 second of writes on a crash. With `no`, you lose up to 30+ seconds. With RDB alone, you lose everything since the last snapshot.

4. **Backups are separate.** If you need point-in-time recovery, copy the `dump.rdb` or AOF file to off-server storage. Redis persistence is about surviving a restart, not about recovering from a mistaken `DEL`.

## Decision Note

Here's my practical recommendation:

- **Cache only:** RDB with default intervals, or no persistence at all. You lose data on restart, but that's fine — the cache rebuilds.
- **Primary datastore, can lose 1 second:** AOF with `appendfsync everysec` + RDB for fast restarts. This is the sweet spot for most applications.
- **Primary datastore, can't lose anything:** AOF with `appendfsync always`. Accept the 17× throughput hit. In practice, most people use `everysec` and accept the 1-second window.
- **Maximum throughput, can lose data:** AOF with `appendfsync no`, or RDB only. Good for ephemeral data like session stores that can be rebuilt.

Configure persistence, measure your actual loss window, and make a conscious decision about what you can afford to lose. That's the job.

---

*Experiments run on `redis:7-alpine` in Docker. All numbers are real measurements from the container. Cleaned up after testing.*
