---
title: "Redis vs Memcached: which cache do you actually want?"
description: "Both are in-memory key-value caches, so the real question is scope, not speed. Real output from throwaway Redis 7.4 and Memcached 1.6 containers: storing the same value, INFO and stats, TTL expiry, LRU/LFU eviction, the 1 MB item limit versus persistence, and the data types Memcached lacks."
pubDate: 2026-12-22
lang: en
translationKey: redis-vs-memcached
tags: [devops, self-hosting]
featured: false
keywords:
  - Redis vs Memcached
  - Redis
  - Memcached
  - in-memory cache
  - eviction
---

**Redis vs Memcached** is nearly always framed as a race, and the race is the wrong question. Both are **in-memory cache** servers that answer a `GET` in microseconds; on hardware you would actually deploy, neither wins a "speed" contest that changes your day, and a bare gets-per-second number is a benchmark with your workload left out. The real difference is scope. **Memcached** does exactly one thing very well; **Redis** is a small data-structure server that also happens to be an excellent cache. This is the honest version, built from real output: I ran throwaway Redis 7.4.11 and Memcached 1.6.45 containers side by side, asked both the same questions, and pasted what came back.

## Both are in-memory caches — the difference is scope, not speed

Every **Redis vs Memcached** argument I have watched collapses into two people defending the server already running in their stack. That is not useful. Both sit in RAM, both scale reads by client-side sharding, both speak a trivial protocol over TCP, and both are extremely fast. If all you ever do is `SET key value` and `GET key`, they are interchangeable at the level you can perceive, and you should pick the one you can operate.

The differences only appear the moment you ask the cache to do *more*: hold a hash, survive a restart, fan out a message, run a script, evict by frequency. That is the whole decision, and it fits in a table.

| | Memcached | Redis |
|---|---|---|
| Data model | strings only (`set`/`get`/`incr`/`append`/`cas`) | strings, hashes, lists, sets, sorted sets, streams, bitmaps, HyperLogLog |
| Command surface | ~15 commands | ~250 commands |
| Threading | multi-threaded (4 worker threads by default) | commands run on one thread by default |
| Item size | 1 MiB default, hard cap | 512 MB per string |
| Persistence | none — RAM only | RDB snapshots, AOF, replication |
| Eviction | LRU across slab classes | LRU, LFU, `volatile-*`, `allkeys-*`, `noeviction` |
| Pub/Sub, Lua, transactions | no | yes |
| Cluster / HA | client-side sharding only | Redis Cluster, Sentinel, modules |
| Sweet spot | a huge, simple, string-only cache across many cores | almost everything else |

## How I got these outputs

Two containers, deleted afterwards, no benchmark claims:

```bash
docker run -d --name rvc-redis     -p 127.0.0.1:16379:6379 redis:7-alpine
docker run -d --name rvc-memcached -p 127.0.0.1:11211:11211 memcached:1.6-alpine
```

That is `Redis server v=7.4.11` and `memcached 1.6.45`. The image sizes already tell the story of the trade-off — `memcached:1.6-alpine` is 6 MB compressed, `redis:7-alpine` is 16.7 MB — and that gap is the topic of my companion post on [why container image size matters](/posts/container-image-size/). Every line below is reproducible; row counts are small on purpose, because a benchmark without your key sizes, hit rate, and query mix is folklore.

## The same value, stored and fetched by each

Redis first, with its native client:

```bash
$ docker exec rvc-redis redis-cli SET greeting "hello from redis"
OK
$ docker exec rvc-redis redis-cli GET greeting
hello from redis
```

Memcached's text protocol does the same job, and the shape of the command is worth reading carefully: `set <key> <flags> <exptime> <bytes>`. The client has to know the payload length *before* it sends it.

```text
set greeting 0 0 16
hello from redis
STORED

get greeting
VALUE greeting 0 16
hello from redis
END
```

Now ask each one what it has been doing. Redis reports cumulative hit/miss counters in `INFO`:

```bash
$ docker exec rvc-redis redis-cli INFO stats | grep keyspace
keyspace_hits:6
keyspace_misses:3
$ docker exec rvc-redis redis-cli INFO memory | grep -E 'used_memory_human|maxmemory'
used_memory_human:1.01M
maxmemory_human:0B
```

Memcached reports the same idea through `stats`:

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

Both tracked 6 hits and 3 misses correctly, so neither is hiding its behaviour. But look at memory: Memcached accounts the whole dataset as `bytes` (83), while Redis's `used_memory_human` is already 1.01 MB for a single key — the baseline cost of the richer engine. It is not wasteful; it is carrying a much larger feature surface in RAM. Budget for it.

## Memcached's personality: multithreaded, LRU, and nothing else

Ask Memcached for its configuration and it tells you its entire worldview:

```text
STAT maxconns 1024
STAT evictions on
STAT num_threads 4
STAT item_size_max 1048576
STAT slab_reassign yes
```

Four worker threads, a 1 MB item cap, LRU, and nothing else. That simplicity is the feature. Because it only stores opaque byte-strings, Memcached can hand each connection to any thread and let the kernel's schedulers spread work across every core; there is no shared data structure that requires a global lock. On a 32-core box, that is Memcached's genuine superpower.

Redis goes the other way on purpose. Its command execution is single-threaded — this is the design that makes its atomic data-structure operations possible — and the threading knobs confirm it:

```bash
$ docker exec rvc-redis redis-cli CONFIG GET io-threads
1
$ docker exec rvc-redis redis-cli INFO server | grep io_threads_active
io_threads_active:0
```

Concretely, Memcached exposes around fifteen commands while Redis reports this:

```bash
$ docker exec rvc-redis redis-cli COMMAND COUNT
250
```

That number is the whole trade-off in one line. Redis's one command thread is fast enough for most workloads (network and memory, not CPU, are usually the ceiling), but it is the reason "add more cores" does not automatically mean "more Redis throughput" the way it does for Memcached.

## Redis's richness — and what it costs you

Here is what those 250 commands buy. Redis stores real server-side data structures, so the round trip to your app shrinks:

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

Memcached cannot even parse those commands — they come back as errors, not because anything is broken but because the vocabulary does not exist:

```text
hset user:1 name alice   -> ERROR
rpush queue a            -> ERROR
sadd tags redis          -> ERROR
zadd board 10 alice      -> ERROR
```

What Memcached *does* have fits on one hand: `incr`/`decr` for counters, `append`/`prepend` for strings, and `cas` for optimistic concurrency.

```text
incr counter 5           -> 15
decr counter 3           -> 12
gets counter             -> VALUE counter 0 2 4  12  END   # the "4" is the CAS token
append word bar          -> STORED
get word                 -> VALUE word 0 6  foobar  END
```

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="Two panels. Memcached: four worker threads each reach one flat string store in RAM, with no disk. Redis: a single command thread reaches typed data structures, an RDB/AOF file on disk, a replica, and a pub/sub channel.">
  <g fill="currentColor" font-family="system-ui, sans-serif">
    <text x="20" y="24" font-weight="600" font-size="14">Where the work happens</text>

    <text x="20" y="58" font-size="12" font-weight="600">Memcached · many threads, one shape</text>
    <rect x="20" y="70" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="104" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="138" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="20" y="172" width="60" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="50" y="87" font-size="10" text-anchor="middle">thread</text>
    <text x="50" y="121" font-size="10" text-anchor="middle">thread</text>
    <text x="50" y="155" font-size="10" text-anchor="middle">thread</text>
    <text x="50" y="189" font-size="10" text-anchor="middle">thread</text>
    <line x1="80" y1="84" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="117" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="151" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <line x1="80" y1="185" x2="180" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
    <rect x="180" y="105" width="120" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="240" y="125" font-size="11" text-anchor="middle">flat string store</text>
    <text x="240" y="141" font-size="10" text-anchor="middle" opacity="0.75">RAM only · LRU</text>

    <text x="380" y="58" font-size="12" font-weight="600">Redis · one command thread, many shapes</text>
    <rect x="380" y="105" width="80" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
    <text x="420" y="125" font-size="11" text-anchor="middle">command</text>
    <text x="420" y="141" font-size="11" text-anchor="middle">thread</text>
    <line x1="460" y1="118" x2="540" y2="88" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <line x1="460" y1="128" x2="540" y2="128" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <line x1="460" y1="138" x2="540" y2="168" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <rect x="540" y="72" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="92" font-size="10" text-anchor="middle">sorted sets · streams · Lua</text>
    <rect x="540" y="112" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="132" font-size="10" text-anchor="middle">RDB / AOF on disk</text>
    <rect x="540" y="152" width="140" height="32" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="610" y="172" font-size="10" text-anchor="middle">replica · pub/sub</text>
    <text x="380" y="220" font-size="10" opacity="0.75">the richness costs a global command lock — and more knobs to get wrong</text>
  </g>
</svg>
<figcaption>Memcached spends its parallelism on throughput; Redis spends its single thread on guarantees and types. Neither choice is free, and both are deliberate.</figcaption>
</figure>

The cost is real. Redis's single command thread means a slow `KEYS *` or a heavy Lua script stalls *every* client; Memcached has no such global stall. Redis also has more knobs, and one classic misuse: treating it as a primary database. If you want the patterns that keep it honest (cache-aside, rate limits, streams, locks), my companion post on [Redis patterns that actually earn their place](/posts/redis-patterns/) covers each with the same kind of real output.

## TTL and eviction: LRU is table stakes, LFU is a Redis extra

Both expire keys. Redis draws the TTL down and tells you exactly where it stands; Memcached just makes the key disappear.

```bash
$ docker exec rvc-redis redis-cli SET session:abc "token-xyz" EX 3
OK
$ docker exec rvc-redis redis-cli TTL session:abc
3
$ docker exec rvc-redis redis-cli GET session:abc      # after 4s — key is gone
                      (empty output)
$ docker exec rvc-redis redis-cli TTL session:abc
-2
```

```text
set session:abc 0 3 9
token-xyz
STORED
get session:abc        # immediately
VALUE session:abc 0 9
token-xyz
END
get session:abc        # after 4s
END
```

Eviction is where the two part ways. I capped Redis at 2 MB with `allkeys-lru` and wrote forty 100 KB values into it:

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

I did the same to Memcached with `-m 2` (2 MB) and the same forty 100 KB items:

```text
attempted 40 items of 100000 bytes -> STORED 40
STAT limit_maxbytes 2097152
STAT bytes 2001480
STAT curr_items 20
STAT total_items 40
STAT evictions 20
STAT items:32:evicted 20
```

Read those side by side and the interfaces differ in an important way: Redis *told me* it evicted (35 keys gone), while Memcached cheerfully replied `STORED` to all forty writes and silently made room — `total_items 40` written, `curr_items 20` surviving, `evictions 20`. Memcached never refuses a write; it evicts to accept it. Know that before you wonder where a key went.

The other difference is the *replacement policy*. Memcached is LRU (per slab class). Redis lets you choose, and adds LFU — evict the least *frequently* used, not the least recently:

```bash
$ docker exec rvc-redis redis-cli CONFIG SET maxmemory-policy allkeys-lfu
OK
$ docker exec rvc-redis redis-cli GET hot   # 40 times
$ docker exec rvc-redis redis-cli OBJECT FREQ hot
7
$ docker exec rvc-redis redis-cli OBJECT FREQ cold
4
```

For a classic cache, LRU is fine and both do it. LFU earns its keep when a burst of cold keys would otherwise push out the warm set — a scan, a crawler, a batch job — which Memcached has no built-in answer for.

## Memcached's two hard limits: 1 MB items and no persistence

First limit: the item size. Ask the default server to hold anything over a megabyte and it refuses at the protocol level, before you even finish sending:

```text
   under declared size   1000000: STORED
exact_1MiB declared size  1048576: SERVER_ERROR object too large for cache
    over declared size   1048577: SERVER_ERROR object too large for cache
STAT item_size_max 1048576
```

Even exactly 1 MiB fails, because the cap includes item overhead. You *can* raise it with `-I`, but Memcached's whole memory model is built around a slab allocator assuming small objects. Redis has no such ceiling — a single string can be up to 512 MB:

```bash
$ head -c 2097152 /dev/zero | tr '\0' 'x' | docker exec -i rvc-redis redis-cli -x SET bigvalue
OK
$ docker exec rvc-redis redis-cli STRLEN bigvalue
2097152
$ docker exec rvc-redis redis-cli CONFIG GET proto-max-bulk-len
536870912
```

(Which is not a licence to store blobs in Redis — big values mean big replication traffic and OOM pressure. Both servers prefer small objects.)

Second limit: persistence. Memcached is RAM, full stop. I stored a key, restarted the container, and asked again:

```text
get persist:key     # before restart
VALUE persist:key 0 18
survives a restart
END
get persist:key     # after restart
END
```

Redis, given a `SAVE`, survives the same restart:

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

Note the honest caveat: Redis persistence is *optional* and *tunable*, and it is not the same durability as a database. RDB snapshots lose anything written since the last save; AOF (`appendfsync everysec`) can lose up to a second. But "can be made to survive a restart" versus "cannot, by design" is a categorical difference, and it is why Memcached is a cache and Redis can (cautiously) be a small store.

## When Memcached is genuinely the better pick

I want to be fair, because the honest answer is that Memcached has a real niche and it is not nostalgia:

- **A colossal, simple, string-only cache.** If your access pattern is `GET`/`SET` on blobs of JSON or rendered fragments, Memcached is the whole product with none of the knobs.
- **Many cores, one flat keyspace.** Because it is multi-threaded and lock-free per request, Memcached scales its throughput almost linearly with worker threads — `-t` is the dial. Redis's single command thread does not, and `io-threads` only offloads the network, not command execution.
- **You do not want the temptation.** No persistence and no data structures means nobody can quietly turn your cache into an accidental database.
- **Tiny footprint.** `memcached:1.6-alpine` is 6 MB compressed against Redis's 16.7 MB.

Everything outside that list — sessions you want to survive a deploy, counters and leaderboards, queues and streams, pub/sub fan-out, Lua, cluster mode, modules — is Redis, and usually not close.

## So which one? A decision list

Stop asking which is faster and ask these, in order:

1. **Do you need anything other than get/set on strings?** Hashes, lists, sets, sorted sets, streams, pub/sub, Lua → Redis. String-only → keep reading.
2. **Do you need the data to outlive a restart?** Then Redis, or a real database. Memcached will lose it, correctly and quietly.
3. **Is this a huge, simple cache across many cores with no data-structure needs?** Memcached is a legitimate, excellent answer — and often the most boring one.
4. **Do you need eviction that survives a cold-key blast?** Redis's LFU; Memcached only has LRU.
5. **Do you want one server for cache, counters, locks, and queues?** Redis. Fewer moving parts beats a two-system stack you have to feed.
6. **Still undecided?** Pick Redis. It is a superset of Memcached's job, and the extra capability costs you memory and operational care, not a rewrite.

The punchline is the boring one: **Redis vs Memcached** is not about speed. Memcached is one sharp tool for one job; Redis is a toolbox that happens to include that tool. Choose the scope you need, then budget the memory and the discipline the richer one asks for.
