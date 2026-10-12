---
title: "Redis patterns that actually earn their place: cache-aside, rate limits, streams, locks"
description: "A practical tour of the Redis patterns worth keeping: cache-aside with TTLs and a real SET NX EX stampede lock, INCR rate limiting fixed versus sliding, queues versus streams, distributed locks and their caveats, persistence, and maxmemory eviction. Real command output from a throwaway container."
pubDate: 2026-12-08
lang: en
translationKey: redis-patterns
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis patterns
  - Redis cache-aside
  - Redis rate limiting
  - Redis locks
  - SET NX EX
---

**Redis patterns** get copied around long after anyone remembers why they existed. A `SET` with a TTL becomes "our cache", an `INCR` becomes "our rate limiter", and somewhere a `SET NX EX` becomes "our distributed lock" that nobody dares touch. Most of these patterns do earn their place — but only when you know the exact job each one is doing. This is the practical version: **Redis cache-aside** and the stampede problem, **Redis rate limiting** with `INCR`, queues versus **Redis streams**, **Redis locks** and the Redlock caveat, plus the persistence and `eviction` decisions people skip. Every command below was run against a throwaway `redis:7-alpine` container (`redis-server v=7.4.11`) and the output is pasted verbatim.

## What Redis is genuinely good at

Redis is an in-memory data structure server: data lives in RAM and operations are small, atomic, and predictable — a `GET` is a `GET`, not a query plan. That fits a specific set of jobs:

- **Caches** — a computed value you can rebuild, stored next to the app.
- **Counters** — atomic increments for stats, quotas, connections.
- **Rate limits** — a counter or a set with a time window attached.
- **Ephemeral queues** — work you can afford to lose if the box dies.
- **Leaderboards** — sorted sets, `ZADD` and `ZRANGE`, ranking for free.
- **Locks** — short-lived, best-effort mutual exclusion.

Notice the common thread: every one of these is *derivable* or *transient*. You can lose the whole keyspace and the system can rebuild it. That property is what makes Redis a great cache and a terrible source of truth.

## What people misuse Redis for

Two misuses cause most of the pain. The first is **Redis as a primary database**. It has optional persistence (we will get to that), but it was not designed to be the durable, queryable, consistent home of your records. The second is **Redis as a giant blob store** — pushing multi-megabyte JSON, PDFs, or images through it. Redis stores everything in RAM and its value types are optimized for small-ish objects; big values mean big replication traffic and OOM the moment your dataset exceeds memory.

The tell is this question: *if the keyspace vanished right now, what breaks?* If the answer is "nothing, we rebuild it", you are using Redis correctly. If the answer involves a restore plan, you are holding a database that is much less forgiving than the one you already have.

## Redis cache-aside: TTL and the stampede problem

Cache-aside (also called lazy loading) is the pattern where the application owns the cache. On read, ask Redis first; on a miss, compute from the source, write the result back with a TTL, and return it. Redis itself does no fetching — it just holds what you put there.

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

The miss returns `(nil)`, and that is your cue to hit the database and repopulate. Always set a TTL — the `EX 300` above. Without one, a key you never invalidate becomes a lie that outlives the data it describes. A TTL bounds how long a stale answer can survive.

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="Cache-aside read flow: the app checks Redis first. On a hit it returns the value. On a miss it takes a SET NX EX lock, and only the winner rebuilds from the database and writes the value back to Redis with a TTL.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <rect x="30" y="120" width="110" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="85" y="150" text-anchor="middle">App</text>
    <rect x="250" y="40" width="130" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="315" y="70" text-anchor="middle">Redis (cache)</text>
    <rect x="250" y="210" width="130" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="315" y="240" text-anchor="middle">Database</text>
    <g stroke="currentColor" stroke-width="1.5" fill="none">
      <path d="M140 138 L250 66" marker-end="url(#a)"/>
      <path d="M250 80 L140 146" marker-end="url(#a)" stroke-dasharray="4 3"/>
      <path d="M140 158 L250 232" marker-end="url(#a)"/>
      <path d="M250 218 L140 168" marker-end="url(#a)"/>
    </g>
    <text x="200" y="88" text-anchor="middle" font-size="11">GET key</text>
    <text x="205" y="118" text-anchor="middle" font-size="11" opacity="0.75">hit → return</text>
    <text x="200" y="212" text-anchor="middle" font-size="11">miss → query</text>
    <text x="205" y="255" text-anchor="middle" font-size="11" opacity="0.75">SET key ... EX ttl</text>
    <text x="470" y="120" font-size="12" font-weight="600">Only one rebuilds:</text>
    <text x="470" y="145" font-size="12" font-family="ui-monospace, monospace">SET lock NX EX 10</text>
    <text x="470" y="166" font-size="11" opacity="0.75">losers wait, then re-read the cache</text>
    <defs>
      <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/>
      </marker>
    </defs>
  </g>
</svg>
<figcaption>A cache-aside read. The lock only matters when a popular key expires under load — that is the stampede.</figcaption>
</figure>

### The stampede problem and a real SET NX EX lock

The failure mode is easy to reproduce. A hot key expires. A hundred requests miss at the same instant. All hundred hit the database to rebuild the *same* value, and your origin gets pegged by one expired key. That is a **cache stampede** (also called thundering herd).

The fix is to let exactly one caller rebuild while the others wait for the cache. `SET key value NX EX seconds` is atomic: it sets the key only if it does not already exist, with an expiry, in one round trip. The first caller wins; everyone else sees the existing lock.

```text
127.0.0.1:6379> SET lock:rebuild:home:feed tok-1 NX EX 10
OK
127.0.0.1:6379> SET lock:rebuild:home:feed tok-2 NX EX 10
(nil)
127.0.0.1:6379> TTL lock:rebuild:home:feed
(integer) 10
```

The second `SET` returns `(nil)` — it did not overwrite. That is the entire lock: only `tok-1`'s holder proceeds. Two details make it safe. First, the `EX 10` matters more than the lock itself: if the winner crashes mid-rebuild, the lock must expire on its own or the key stays stuck forever. Second, you must release the lock **only if you still own it**, or a slow winner will delete the fast newcomer's lock. Do that with a token check, and do it server-side so it is atomic:

```text
127.0.0.1:6379> EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 lock:rebuild:home:feed tok-2
(integer) 0
127.0.0.1:6379> EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 lock:rebuild:home:feed tok-1
(integer) 1
127.0.0.1:6379> EXISTS lock:rebuild:home:feed
(integer) 0
```

The `tok-2` holder gets `0` — its release was refused because it never held the lock. `tok-1`'s release succeeds and the key is gone.

## Redis rate limiting: INCR, fixed versus sliding

The counter pattern is one command. `INCR` is atomic, so concurrent callers cannot race each other into a lost update. Attach a window with `EXPIRE` and you have a rate limit.

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

Two bugs hide in the obvious version. If you `INCR` and then `EXPIRE` in two calls and the process dies in between, the key has no TTL and the counter lives forever — the classic "rate limit that never resets". And re-running `EXPIRE` on every request keeps *extending* the window, so a steady stream of traffic never lets the counter reset. The fix is `EXPIRE ... NX`, which sets the TTL only if there is none yet:

```text
127.0.0.1:6379> INCR rl:fixed:9.9.9.9
(integer) 1
127.0.0.1:6379> EXPIRE rl:fixed:9.9.9.9 60 NX
(integer) 1          # first hit owns the window
127.0.0.1:6379> INCR rl:fixed:9.9.9.9
(integer) 2
127.0.0.1:6379> EXPIRE rl:fixed:9.9.9.9 60 NX
(integer) 0          # later hits leave the window alone
127.0.0.1:6379> TTL rl:fixed:9.9.9.9
(integer) 60
```

This is a **fixed window**: cheap and good enough for most abuse control, but it has a boundary quirk — a client can send its full allowance at the end of one window and again at the start of the next. A **sliding window** fixes that with a sorted set scored by timestamp, trimming anything older than the window before counting:

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
(integer) 3          # everything aged out
127.0.0.1:6379> ZCARD rl:sliding:9.9.9.9
(integer) 0
```

Sliding windows cost memory per tracked client and one extra write per request. If you are doing anything more elaborate — token buckets, per-route limits — I wrote up the broader design in [rate limiting beyond a counter](/posts/rate-limiting/), and the sibling problem of not double-charging a client that retries in [idempotency keys](/posts/idempotency-keys/).

## Queues and streams: LPUSH/BRPOP versus XADD/XREADGROUP

A Redis list is the original queue. Producers `LPUSH` to the head, consumers `BRPOP` from the tail, and the blocking pop makes an idle worker sleep instead of spin:

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

Push to the head, pop from the tail gives you FIFO. It is simple and fast. Be honest about what it is **not**: `BRPOP` removes the item the moment it hands it to you, so if your worker crashes mid-job, that job is gone. There is no ack, no retry, no history. On an empty queue it blocks and then gives up:

```text
127.0.0.1:6379> BRPOP queue:tasks 1
(nil)
```

If losing a job is unacceptable, use a stream. `XADD` appends to a log, every entry gets an ID and stays put, and a consumer group tracks what has been delivered and not yet acknowledged:

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

Those two pending entries are the point: they were delivered but never `XACK`'d, so a crashed consumer's work can be reclaimed with `XCLAIM`. Streams are heavier than a list — they keep history, which is either a feature or a disk bill. Pick based on the same question as everything else: what happens if this message is lost?

## Redis locks: SET NX EX and the Redlock caveat

The lock from the stampede section is the honest primitive: `SET id value NX EX ttl` to acquire, a token check to release, a TTL to survive a crash. That covers the vast majority of real needs — "don't run two copies of this cron job", "one worker rebuilds this key".

The trouble starts when people want a **correctness-critical** distributed lock, the kind guarding money or exclusive ownership across a fleet. `SET NX EX` has a gap: the holder pauses (GC, a slow disk, a `SIGSTOP`), its TTL expires, another node acquires the lock, and now two processes believe they own it. A TTL cannot be shorter than your worst-case pause and cannot be longer than you can tolerate a dead holder.

Redlock (the multi-node algorithm) tries to make the lock robust by acquiring on a majority of independent Redis nodes. It is still controversial. Its safety argument assumes bounded clock drift and bounded pauses; under a long GC pause or clock jump, the same overlapping-ownership window reappears. My rule is blunt: **if the lock's failure means corrupting data or double-spending, the lock should not live in Redis alone** — put a fencing token in the write path or let the database enforce the invariant with a conditional write or unique constraint. Redis locks are great at *coordination* and *efficiency*; they are not a substitute for a durable consistency check.

## Persistence reality: RDB, AOF, or "I don't care, it's a cache"

Redis gives you two persistence mechanisms and a lot of people turn on neither. Out of the box you get RDB point-in-time snapshots:

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

Read that `save` line as: snapshot if 1 key changed in 3600s, or 100 changed in 300s, or 10000 changed in 60s. Between snapshots, an unclean shutdown loses whatever changed since the last one. AOF (append-only file) logs every write and can be `fsync`'d every second or every command, trading disk and latency for durability.

Answer one question. If this is a **cache**, the honest configuration is no persistence at all — let the data die with the process, because the source of truth is elsewhere. If it holds something you cannot rebuild, turn on AOF `everysec` *and* accept that Redis is now a database with database problems: replication lag, failover, backup, the whole list. "It's just a cache" is not a configuration you forget; it is a decision you make on purpose.

## Memory: maxmemory and eviction

The last decision people skip is what happens when Redis runs out of memory. The default is to refuse writes rather than lose data:

```text
127.0.0.1:6379> CONFIG GET maxmemory
1) "maxmemory"
2) "0"                 # unlimited — it will use all RAM, then get killed
127.0.0.1:6379> CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "noeviction"        # writes start failing instead of evicting
```

`maxmemory 0` means "no limit" — under pressure the OS OOM-killer decides your fate. Set a real ceiling and choose an eviction policy that matches the workload:

```text
127.0.0.1:6379> CONFIG SET maxmemory 100mb
OK
127.0.0.1:6379> CONFIG SET maxmemory-policy allkeys-lru
OK
127.0.0.1:6379> CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "allkeys-lru"
```

For a pure cache, `allkeys-lru` (evict the least-recently-used key) is the usual right answer — you would rather drop a cold key than reject a write. If some keys matter more than others, `volatile-lru` only evicts keys that have a TTL, so hot non-expiring keys survive. If you genuinely cannot drop *anything*, you are back to wanting persistence, a bigger box, or a database.

## The short version

Redis earns its place when the data is rebuildable or transient. Use `SET ... EX` for caches and always set a TTL; guard hot keys with a `SET NX EX` stampede lock; rate limit with `INCR` plus `EXPIRE ... NX`, and reach for a sorted set when a fixed window's boundary is too loose. Queues (`LPUSH`/`BRPOP`) are for work you can lose; streams (`XADD`/`XREADGROUP` plus `XACK`) are for work you cannot. Locks are coordination, not correctness. And be deliberate about persistence and `maxmemory` — "we'll deal with it later" is how a cache turns into an outage.
