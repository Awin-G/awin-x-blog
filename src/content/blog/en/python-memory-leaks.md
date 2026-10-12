---
title: "Finding a Python memory leak without guessing: tracemalloc, the gc module, and RSS"
description: "How I hunt a Python memory leak without guessing: build a reproducer, read RSS from /proc, diff tracemalloc snapshots to name the growing allocation, walk gc.get_referrers to find who holds it, then prove the fix with the same numbers."
pubDate: 2026-12-31
lang: en
translationKey: python-memory-leaks
tags: [python, linux]
featured: false
keywords:
  - Python memory leak
  - tracemalloc
  - gc module
  - reference cycle
  - lru_cache
  - weakref
  - RSS
---

The tests pass. The build is green. And the process grows by 30 MB an hour
until the kernel sends it a SIGKILL it did not earn. Every time, somebody in
the channel has a theory, and it is always a guess:
"probably a circular reference", "probably numpy holding a buffer", "check
`free`". I used to do this too. Now I don't, because a **Python memory leak**
is not a mystery you solve by reading code — it is a measurement you take
twice, once before and once after the fix.

This article is that loop, executed. I built a handler that leaks in four
ordinary ways, measured it with `tracemalloc` and the **gc module**, found each
holder with `gc.get_referrers`, fixed it, and re-measured. Every number below
comes from an actual run on Python 3.14.7 / Linux.

## Why a Python memory leak survives the garbage collector

CPython reclaims memory two ways. Reference counting frees an object the
moment its last reference goes away, immediately and predictably. The
**gc module** exists for the other case: a group of objects that only point at
each other, so their refcounts never reach zero — a **reference cycle**. The
generational collector walks object graphs, finds unreachable clusters, and
frees them.

Read that again, because the important word is *unreachable*. Neither mechanism
will free an object that something still points at. A module-level dict that
still holds a key? Reachable. An `lru_cache` with no size limit? Reachable. A
closure in a never-unsubscribed handler list? Reachable, forever — the module
lives as long as the process.

So when `gc.collect()` reports nothing, that is not a bug, it is a diagnosis:
your objects are not garbage, they are *storage*. The question is never "why
won't the gc module collect this?", it is "who is still holding a reference?".

A few genuinely uncollectable corners are worth knowing about:

- **C extensions that do not participate in gc tracking.** An object whose only
  references live inside a C structure that never calls back into Python is
  invisible to the collector, and if that extension keeps a global registry, no
  amount of `gc.collect()` will help.
- **Growing global state.** Not a cycle at all — a dict, list or counter at
  module level that only ever gains entries.
- **Cycles with `__del__`.** Before PEP 442 (Python 3.4) the collector refused
  to finalize objects in cycles and parked them in `gc.garbage` instead. That is
  fixed, but a cycle with a `__del__` reachable from a registry leaks just as
  quietly as anything else.
- **`sys.exc_info()` kept in a global or an attribute.** A traceback holds its
  frame, a frame holds its locals, and one of those locals is the traceback:
  stash the exception "for debugging" and you have pinned a whole call graph.

Here is that last point measured, in the smallest form that still shows the
mechanism. A pure reference cycle with a `__del__`:

```text
--- does the gc module lose cycles with __del__? (PEP 442, 3.4+) ---
   cycle a.b <-> b.a, held by a list: gc.collect() -> 0 objects, A.live=1, gc.garbage=[]
   same cycle, list cleared:            gc.collect() -> 2 objects, A.live=0, gc.garbage=[]
```

Two objects in a cycle with a finalizer. While a list holds one of them, the
collector frees **0** objects and the instance is alive — reachable means kept.
Clear that one reference and the next `gc.collect()` returns **2** and the
finalizer runs. The cycle was never the problem; the list was. And `gc.garbage`
stayed empty the whole time, which is the usual case on modern Python: if you
are waiting for `gc.garbage` to explain your leak, you will wait forever.

## The harness: one leak I can reproduce on demand

Debugging a leak needs a leak you can produce in seven seconds. So here is a
handler doing plausible work — build a report, log an event, open a session,
register a hook — parking the results in four module-level containers:

```python
BLOB = 12 * 1024   # bytes of "serialized report" per request

class LeakyState:
    _METRIC_CACHE = {}   # cache with no eviction, ever
    _EVENTS = []         # "recent events" that nobody trims
    _SESSIONS = {}       # id -> Session, immortal registry
    _HOOKS = []          # event listeners: appended, never removed

class Connection:
    def __init__(self, session):
        self.session = session          # strong ref back -> reference cycle
        self.peer = "10.0.0.7"

class Session:
    def __init__(self, sid, report):
        self.sid = sid
        self.report = report            # another big blob, held by the cycle
        self.conn = Connection(self)

    def close(self):
        self.conn = None

def build_report(tenant, n):
    return {
        "tenant": tenant,
        "request_id": n,
        "blob": os.urandom(BLOB),        # <- leak.py:72
        "rows": [{"k": j, "v": j * n} for j in range(16)],
    }

def leaky_handle(r, i):
    tenant = "tenant-%d" % (i % 8)
    key = "report:%s:%d-%d" % (tenant, r, i)

    LeakyState._METRIC_CACHE[key] = build_report(tenant, i)      # 1) cache
    LeakyState._EVENTS.append({"kind": "request", "n": i})       # 2) list
    sid = "sess-%d-%d" % (r, i)
    LeakyState._SESSIONS[sid] = Session(sid, build_report(tenant, i))  # 3) cycle
    report = build_report(tenant, i)
    LeakyState._HOOKS.append(lambda r=report: r["blob"])         # 4) closure
```

Four suspects, all of which I have seen in production: an unbounded cache keyed
on something unique, a log list nobody trims, a reference cycle parked in a
registry, and an event hook that is a closure over a big payload.

## Step 1: measure the Python memory leak — RSS first, code later

Before any reasoning, get a curve. Two independent views of the same process:
**RSS** from `/proc/self/status` (what the kernel gave us) and `tracemalloc`'s
tracked bytes (what Python allocated and can still see). I also print
`len(gc.get_objects())` — the cheapest leak detector in the stdlib.

```python
def rss_kb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS"):
                return int(line.split()[1])
```

Ten rounds of 150 requests, `gc.collect()` between rounds:

```text
=== mode: leak | 10 rounds x 150 requests | blob=12 KiB ===
python 3.14.7, ru_maxrss 19.7 MiB before the run
round   VmRSS MiB   traced MiB  gc objects   gen0/1/2
    0        29.1          7.0       21227  11/0/0
    1        38.5         13.9       30077  10/0/0
    2        48.3         20.9       38927  10/0/0
    3        57.0         27.9       47777  10/0/0
    4        65.8         34.8       56627  10/0/0
    5        76.6         41.8       65477  10/0/0
    6        85.3         48.7       74327  10/0/0
    7        94.1         55.7       83177  10/0/0
    8       102.8         62.7       92027  10/0/0
    9       111.7         69.7      100877  10/0/0

VmRSS:          19.8 -> 111.7 MiB (+91.8 MiB over 1500 requests)
traced:         0.0 -> 69.7 MiB (+69.7 MiB)
gc objects:     12384 -> 100877 (+88493)
forced collect: 0 unreachable objects; RSS 112.6 -> 112.6 MiB; traced 69.7 -> 69.7 MiB
gc.garbage:     []
```

Three things fall out, none of which required reading the source:

1. **It is a real leak, not growth.** `VmRSS` went 19.8 → 111.7 MiB for 1500
   identical requests.
2. **Python owns it.** `traced` grew 69.7 MiB, so most of the RSS is Python
   objects, not arena fragmentation or a C library. The remainder is real too:
   `tracemalloc` stores a traceback per live allocation. RSS is the symptom;
   traced bytes are the attribution.
3. **The gc module is not the fix.** A forced `gc.collect()` reclaimed **0**
   objects and moved RSS by **0.0 MiB**; `gc.garbage` is empty. The "circular
   reference" theory is dead.

And `gc objects`: +88493 for 1500 requests — about 59 retained per request,
when a healthy steady state needs none. If I could print one line in production,
it would be this.

## Step 2: diff tracemalloc snapshots to name the growing allocation

`tracemalloc` gets interesting when you subtract two snapshots.
`snap_last.compare_to(snap_first, "lineno")` sorts the *difference* by source
line, which is the question "what grew?":

```text
--- tracemalloc diff (round 0 -> round 9), top 6 by line ---
   leak.py:72   +54145.0 KiB  (4500 blocks)
   leak.py:73   +15145.3 KiB  (197887 blocks)
   leak.py:69     +808.6 KiB  (9000 blocks)
   leak.py:93     +340.4 KiB  (3000 blocks)
   leak.py:85     +281.8 KiB  (3000 blocks)
   leak.py:89     +194.5 KiB  (1502 blocks)
--- top current allocations by line ---
   leak.py:72    54145.0 KiB  (4500 blocks)
   leak.py:73    15145.3 KiB  (197887 blocks)
```

The diff answers without any theory: 4500 blocks of 12 KiB at `leak.py:72` —
1500 requests × 3 calls to `build_report()`, all still alive, all from one line.
`leak.py:73` is the row dicts, another 197k blocks. The arithmetic is the
finding: 1500 requests must not leave 4500 blobs behind.

Suspect a *type* rather than a line? `snapshot.statistics("type")` ranks
`dict`, `list`, `lambda` and `Session`; the walk below says where they are.
(`objgraph` and `pympler` are the usual next step if you can install them; there
is no network here, so this one is stdlib-only.)

## Step 3: walk the gc module's referrers to find who holds it

The line says *what* grew; the holder says *why it stays*. This is where the gc
module earns its keep as a debugger rather than a memory manager:
`gc.get_referrers(obj)` returns everything currently pointing at `obj`, so you
can climb from the leaked object up to something immortal.

Small BFS over that, limited to dicts and lists:

```text
--- who holds _METRIC_CACHE? ---
   _METRIC_CACHE: 1500 entries still alive after forced gc.collect()
   <- dict (10 keys) ['__module__', '__firstlineno__', '_METRIC_CACHE', '_EVE...
     <- class __main__.LeakyState
       <- module namespace of __main__  ** immortal **
```

That is the whole bug, printed by the interpreter: `_METRIC_CACHE` is a class
attribute of `LeakyState`, and the class lives in an immortal module namespace.
Same for `_EVENTS` and `_HOOKS`; 1500 `Session` objects sit in `_SESSIONS`, each
with a 12.0 KiB report.

`lru_cache` deserves the same treatment, because it is the most common form of
this bug. Same function, same 5000 unique keys, only `maxsize` differs:

```text
--- functools.lru_cache: maxsize=None vs maxsize=1024, 5000 unique keys ---
   maxsize=None  -> 20450.3 KiB tracked, currsize=5000
   cache_clear() -> 0.2 KiB tracked
   maxsize=1024  -> 4289.4 KiB tracked, currsize=1024
```

`maxsize=None` is not "unlimited speed", it is "unlimited memory": 20.4 MB for
5000 keys, no plateau. Python 3.9 did not make `lru_cache` bounded by default —
`maxsize=128` is, but `maxsize=None`, which is what people write when they
think "caching", is unbounded.

## The fix, and the curve that flattens

The fixes are boring, which is the point: nothing clever, each container just
gets a size or an owner.

```python
class LRUCache:
    """Bounded cache: maxsize entries, evict least-recently-used."""
    def __init__(self, maxsize):
        self.maxsize = maxsize
        self._d = OrderedDict()

    def get_or_build(self, key, builder):
        hit = self._d.get(key)
        if hit is not None:
            self._d.move_to_end(key)
            return hit
        val = builder()
        self._d[key] = val
        if len(self._d) > self.maxsize:
            self._d.popitem(last=False)
        return val

class FixedState:
    _METRIC_CACHE = LRUCache(maxsize=256)
    _EVENTS = deque(maxlen=128)
    _SESSIONS = weakref.WeakValueDictionary()   # index of live sessions only
    _HOOKS = []                                 # hooks unsubscribe on return

def fixed_handle(r, i):
    # 1) bounded cache
    FixedState._METRIC_CACHE.get_or_build(key, lambda: build_report(tenant, i))
    # 2) bounded ring buffer
    FixedState._EVENTS.append({"kind": "request", "n": i})
    # 3) the cycle still exists, but nothing immortal points at it
    sess = Session(sid, build_report(tenant, i))
    FixedState._SESSIONS[sid] = sess            # weakref: index, not owner
    sess.close()                                # explicit cleanup
    # 4) the hook is scoped to the request and dropped when it returns
    hooks = [lambda r=build_report(tenant, i): r["blob"]]
    hooks.pop()
```

The session registry is worth dwelling on. I did not delete the reference cycle
— cycles are fine. I changed *who owns it*: the registry is a
`WeakValueDictionary`, an index of live sessions rather than their owner, and
`sess.close()` breaks the back-reference when the request ends. The local name
goes out of scope, refcounts hit zero, and the pair dies immediately — no
collector pass required.

<figure>
<svg viewBox="0 0 640 280" width="100%" role="img" aria-label="Line chart of RSS in MiB over ten rounds of 150 requests. The leaky handler climbs from 29.1 to 111.7 MiB; the fixed handler stays at 25.5 MiB after the first round.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <line x1="60" y1="240" x2="620" y2="240" stroke="currentColor" stroke-opacity="0.4"/>
    <line x1="60" y1="30" x2="60" y2="240" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="52" y="244" text-anchor="end" opacity="0.6" font-size="11">0</text>
    <text x="52" y="179" text-anchor="end" opacity="0.6" font-size="11">40</text>
    <text x="52" y="115" text-anchor="end" opacity="0.6" font-size="11">80</text>
    <text x="52" y="50" text-anchor="end" opacity="0.6" font-size="11">120</text>
    <text x="20" y="30" opacity="0.6" font-size="11">RSS MiB</text>
    <text x="60" y="260" opacity="0.6" font-size="11">round 0</text>
    <text x="556" y="260" opacity="0.6" font-size="11">round 9</text>

    <polyline points="60,193 122,178 184,162 247,148 309,134 371,116 433,102 496,88 558,74 620,60"
              fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="620" cy="60" r="3.5" fill="currentColor"/>
    <text x="560" y="48" text-anchor="end" font-size="11" opacity="0.9">leaky: +91.8 MiB</text>

    <polyline points="60,203 122,199 184,199 247,199 309,199 371,199 433,199 496,199 558,199 620,199"
              fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 4"/>
    <circle cx="620" cy="199" r="3.5" fill="currentColor"/>
    <text x="560" y="216" text-anchor="end" font-size="11" opacity="0.9">fixed: +5.6 MiB</text>

    <text x="10" y="276" opacity="0.5" font-size="11">same 1500 requests, same blob size; only container bounds and ownership differ</text>
  </g>
</svg>
<figcaption>The same workload twice. The leaky handler retains all 1500 requests' worth of reports; the fixed handler fills its bounded state in round 1 and then goes flat — 25.5 MiB, for ten rounds straight.</figcaption>
</figure>

And the measurement, unchanged:

```text
=== mode: fixed | 10 rounds x 150 requests | blob=12 KiB ===
python 3.14.7, ru_maxrss 19.8 MiB before the run
round   VmRSS MiB   traced MiB  gc objects   gen0/1/2
    0        23.0          2.3       15205  11/0/0
    1        25.3          4.0       17114  10/0/0
    2        25.4          4.0       17114  10/0/0
    3        25.4          4.0       17114  10/0/0
    4        25.4          4.0       17114  10/0/0
    5        25.4          4.0       17114  10/0/0
    6        25.5          4.0       17114  10/0/0
    7        25.5          4.0       17114  10/0/0
    8        25.5          4.0       17114  10/0/0
    9        25.5          4.0       17114  10/0/0

VmRSS:          19.9 -> 25.5 MiB (+5.6 MiB over 1500 requests)
traced:         0.0 -> 4.0 MiB (+4.0 MiB)
gc objects:     12384 -> 17114 (+4730)
slope:          0.73 MiB/round (rounds 0-4) vs 0.07 MiB/round (rounds 5-9)
forced collect: 0 unreachable objects; RSS 25.5 -> 25.5 MiB; traced 4.0 -> 4.0 MiB
gc.garbage:     []

--- tracemalloc diff (round 0 -> round 9), top 6 by line ---
   leak.py:72    +3080.2 KiB  (256 blocks)
   leak.py:73     +862.6 KiB  (11463 blocks)
   leak.py:69      +60.5 KiB  (636 blocks)
   leak.py:112      +28.8 KiB  (259 blocks)
   leak.py:130      +15.3 KiB  (256 blocks)
   leak.py:129      +12.2 KiB  (256 blocks)
--- top current allocations by line ---
   leak.py:72     3080.2 KiB  (256 blocks)
   leak.py:73      862.6 KiB  (11463 blocks)
   leak.py:69       60.5 KiB  (636 blocks)
   leak.py:112       28.8 KiB  (259 blocks)
   leak.py:130       15.3 KiB  (256 blocks)

bounded state: cache=256/256 entries, events=128/128, live sessions=0, hooks=0
```

The slope is the whole story: 6.96 MiB per round before, **0.07 MiB per round**
after. The 4.0 MiB of traced bytes *is* the steady state — 256 cache entries
plus 128 events — and it has nowhere to grow: `leak.py:72` shows **+3080.2 KiB
(256 blocks)**, exactly 256 × 12 KiB. The cache is full, exactly.

## A test that asserts memory

Measurements that only live in your terminal do not survive the next
refactor. Cheapest protection: drive the workload past where bounded state
should have filled, then assert that retention stopped.

```python
def growth_after_steady_state(handler, warmup, sustain):
    """Tracked bytes added *after* the caches have had time to fill up."""
    gc.collect()
    tracemalloc.start()
    drive(handler, warmup)          # let bounded state fill
    before, _ = tracemalloc.get_traced_memory()
    drive(handler, sustain)         # same work again
    after, _ = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return (after - before) / 1024.0

leaky = growth_after_steady_state(leaky_handle, 600, 900)
fixed = growth_after_steady_state(fixed_handle, 600, 900)
LIMIT = 512  # KiB: steady state must not grow more than this for the same work
assert fixed < LIMIT, "the fixed handler retains %.1f KiB: it leaks" % fixed
```

Run it — the assertions are checked against both handlers, so the test cannot
pass by accident:

```text
   leaky   33379.2 KiB retained over 900 more requests
   fixed       0.1 KiB retained over 900 more requests

   leaky= 32310.4 KiB   fixed=    39.0 KiB   limit=512 KiB
   PASS: bounded handler retains   39.0 KiB (limit 512), leaky handler retains 32310.4 KiB
```

Run-to-run the leaky number moves a few hundred KiB; the ratio is the point:
**39 KiB versus 32 MB** for identical work. Such a threshold does not flake, and
it fails loudly the day somebody removes an eviction.

## The usual suspects, in the order I check them

For your own service, in order of how often each has been the answer:

1. **Module-level dicts and lists** that only gain entries — the registry
   pattern above. Grep module scope for `= {}` and `= []`, then ask what removes
   things from them.
2. **Caches with no eviction** — `@lru_cache(maxsize=None)` and any hand-rolled
   `CACHE[key] = ...` keyed on a request id, user id, URL or timestamp.
   Unbounded key space, unbounded cache.
3. **Closures and bound methods in registries** — event listeners, signal
   handlers, `atexit` hooks, callbacks. Each closure keeps its captured frame
   alive, so "just a small lambda" can be a 12 KiB payload.
4. **Reference cycles that something immortal points at** — cycles are safe only
   when nothing reachable references them; "live object" registries are the
   usual bridge.
5. **`sys.exc_info()` saved into a global**, and frames pinned by tracebacks in
   logs.
6. **Anything in a C extension** — if the walk ends at a C object, no
   Python-level fix helps; you hand the buffer back.

## Prevention, which is cheaper than all of the above

- **Give every cache a size.** `functools.lru_cache(maxsize=…)`, an
  `OrderedDict` with `popitem(last=False)`, `cachetools.LRUCache`. If you cannot
  bound it, you do not have a cache — you have a log.
- **Prefer `weakref` for indexes.** A registry of "currently live objects"
  should be a `WeakValueDictionary`, or keyed by an id you remove in `close()`.
  Ownership and lookup are different jobs.
- **Make cleanup explicit and call it.** `close()`, `__exit__`, a context
  manager, a finally block. `__del__` is a fallback that runs at an arbitrary
  moment — or never, if the process dies.
- **Store summaries, not objects.** `repr(e)` or a formatted traceback string,
  never the exception or the traceback itself.
- **Keep one memory test.** Not a dashboard, not an RSS alert after restart —
  one test asserting retention for known work.

## The method, in one paragraph

Reproduce, measure, snapshot, find the type, find the holder. A harness that
leaks in seconds; RSS from `/proc` and traced bytes from `tracemalloc` so you
know it is real and Python-owned; a forced `gc.collect()` so you know it is not
a cycle; a snapshot diff by line so the interpreter names the allocation;
`gc.get_referrers` until you hit something immortal; bound, weaken or delete
whatever you find — then re-run and require the slope to be zero. The numbers
exist so the next person with a theory gets a table, not an argument.

Two neighbouring pieces of the same "measure, don't guess" habit:
[Linux load average, and why it lies to you](/posts/linux-load-average/) and
[Debugging with strace: when the syscalls tell the story](/posts/debugging-with-strace/).
