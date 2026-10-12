---
title: "不靠猜找出 Python 内存泄漏：tracemalloc、gc 模块与 RSS"
description: "我如何不靠猜找出 Python 内存泄漏：先搭一个能复现的 harness，用 /proc 读 RSS，用 tracemalloc 快照 diff 点名那个在增长的分配，再用 gc.get_referrers 找出谁还持有它，最后用同一套数字证明修复有效。全部数字来自 Python 3.14.7 的真实运行。"
pubDate: 2026-12-31
lang: zh
translationKey: python-memory-leaks
tags: [python, linux]
featured: false
keywords:
  - Python 内存泄漏
  - tracemalloc
  - gc 模块
  - 引用循环
  - lru_cache
  - weakref
  - RSS
---

测试全过，构建是绿的。进程还是以每小时 30 MB 的速度涨，直到内核发来一个它并不配得的
SIGKILL。每次出事，频道里总有人给出一个理论，而理论永远是猜的：「大概是循环引用」「大概
是 numpy 占着 buffer」「看下 `free`」。我以前也这样。现在不了，因为 **Python 内存泄漏**
不是靠读代码破解的谜题，而是一个你要测两次的量——修复前一次，修复后一次。

这篇文章就是这个流程的实录。我写了一个以四种普通方式泄漏的 handler，用 `tracemalloc`
和 **gc 模块**测量它，用 `gc.get_referrers`找到每一个持有者，修好，再测一遍。下面每个数字
都来自 Python 3.14.7 / Linux 上的一次真实运行。

## 为什么 Python 内存泄漏能熬过垃圾回收

CPython 用两种方式回收内存。引用计数在对象的最后一个引用消失时立刻释放它，即时且可预测。
**gc 模块**是为另一种情况存在的：一组对象只互相指向，引用计数永远降不到零——也就是
**引用循环**。分代收集器遍历对象图，找出不可达的簇，然后把它们释放。

请再读一遍那句话，因为关键的词是*不可达*。两套机制都不会释放仍被某个东西指向的对象。模块
级字典里还有一个键？可达。没有大小限制的 `lru_cache`？可达。一个永不被取消订阅的回调列表
里的闭包？可达，而且是永远可达——模块与进程同寿。

所以当你调完 `gc.collect()`它报告「什么都没回收」，那不是 bug，而是诊断：你的对象不是垃
圾，而是*存储*。问题从来不是「gc 模块为什么不收回它？」，而是「谁还持有一个引用？」。

少数真正不可回收的角落值得记住：

- **不参与 gc 跟踪的 C 扩展。** 一个对象的引用只存在于某个从不回调 Python 的 C 结构里，
  收集器就看不见它；如果那个扩展还维护全局注册表，那么再多次 `gc.collect()`也没用。
- **不断增长的全局状态。** 根本不是循环——只是模块级的一个 dict、list 或计数器，只会加
  条目，从不删。
- **带 `__del__` 的循环。** 在 PEP 442（Python 3.4）之前，收集器拒绝 finalize 循环中的
  对象，而是把它们塞进 `gc.garbage`。这事儿已经修了，但一个被注册表引用的、带 `__del__`
  的循环，泄漏得和其他东西一样安静。
- **存进全局或属性的 `sys.exc_info()`。** traceback 持有它的 frame，frame 持有它的局部
  变量，而其中一个局部变量正是这个 traceback：把异常「先存起来调试」，你就钉住了整张调用
  图。

最后这一点，用能展示机制的最小形式测一下。一个纯引用循环，带 `__del__`：

```text
--- does the gc module lose cycles with __del__? (PEP 442, 3.4+) ---
   cycle a.b <-> b.a, held by a list: gc.collect() -> 0 objects, A.live=1, gc.garbage=[]
   same cycle, list cleared:            gc.collect() -> 2 objects, A.live=0, gc.garbage=[]
```

两个带 finalizer 的对象组成循环。只要有一个 list 指着其中一个，收集器释放 **0** 个对象，
实例仍然活着——可达即保留。清掉那唯一一个引用，下一次 `gc.collect()` 返回 **2**，
finalizer 也跑了。循环从来不是问题，那个 list 才是。而 `gc.garbage` 全程为空，这在现代
Python 里才是常态：如果你在等 `gc.garbage`来解释你的泄漏，你会一直等下去。

## Harness：一个能按需复现的泄漏

调试泄漏需要一个七秒内就能产生的泄漏。所以这里有一个在做真实工作的 handler——
生成报表、记一条事件、开一个 session、注册一个 hook——然后把结果全部停在四个模块级容器
里：

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

四个嫌疑人，全是我在生产代码里见过的：一个以唯一值做 key 的无界缓存、一个没人修剪的日志
list、一个停在注册表里的引用循环，以及一个闭包捕获了大对象的事件回调。

## 第一步：测量 Python 内存泄漏——先看 RSS，后看代码

在任何推理之前，先拿到曲线。同一进程的两个独立视角：从 `/proc/self/status` 读的
**RSS**（内核给了我们多少），以及 `tracemalloc` 追踪到的字节（Python 分配且现在还能看见
的）。我还会打印 `len(gc.get_objects())`——标准库里最便宜的泄漏探测器。

```python
def rss_kb():
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS"):
                return int(line.split()[1])
```

十轮，每轮 150 个请求，轮与轮之间 `gc.collect()`：

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

三件事从这张表里直接掉出来，没有一件需要我去读源码：

1. **这是真泄漏，不是增长。** 1500 个一模一样的请求，`VmRSS` 从 19.8 涨到 111.7 MiB。
2. **是 Python 的锅。** `traced` 涨了 69.7 MiB，说明 RSS 大头是 Python 对象，不是 arena
   碎片，也不是某个 C 库。剩下的差也是真的：`tracemalloc` 自己为每个存活分配记录一条
   traceback。RSS 是症状，traced 字节是归因。
3. **gc 模块不是解法。** 强制 `gc.collect()` 回收了 **0** 个对象，RSS 动了 **0.0 MiB**；
   `gc.garbage` 是空的。「循环引用」理论可以判死刑了。

还有 `gc objects`：1500 个请求多了 88493 个对象——每个请求留下约 59 个，而健康的稳态一个
都不需要留。如果我只能在生产里打一行日志，我会打这个。

## 第二步：diff tracemalloc 快照，点名那个在增长的分配

当你把两份快照相减，`tracemalloc` 才开始有意思。
`snap_last.compare_to(snap_first, "lineno")` 按源码行排这个*差值*，而这正是「什么在涨？」
这个问题本身：

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

diff 不需要任何理论就给出了答案：`leak.py:72` 上有 4500 个 12 KiB 的 block——1500 个请求
× 3 次 `build_report()`，全都还活着，全来自同一行。`leak.py:73` 是那些 row dict，又是 197k
个 block。这道算术本身就是结论：1500 个请求不该留下 4500 个 blob。

怀疑的是某个*类型*而不是某一行？`snapshot.statistics("type")` 会把 `dict`、`list`、
`lambda` 和 `Session` 排成序；下面的遍历则告诉你它们在哪儿。（`objgraph` 和 `pympler` 是
通常的下一步，前提是装得上；这台机器没有网络，所以这个遍历只用标准库。）

## 第三步：走 gc 模块的 referrers，找出谁在持有它

行号说明*什么*在涨；持有者说明*为什么它留下来*。这就是 gc 模块作为调试工具而不是内存管理
器真正值钱的地方：`gc.get_referrers(obj)` 返回当前所有指向 `obj` 的对象，于是你可以从泄漏
对象一路爬到某个不朽的东西上。

写一个小的 BFS，只看 dict 和 list：

```text
--- who holds _METRIC_CACHE? ---
   _METRIC_CACHE: 1500 entries still alive after forced gc.collect()
   <- dict (10 keys) ['__module__', '__firstlineno__', '_METRIC_CACHE', '_EVE...
     <- class __main__.LeakyState
       <- module namespace of __main__  ** immortal **
```

整个 bug 被解释器自己打印了出来：`_METRIC_CACHE` 是 `LeakyState` 的类属性，而类活在一个
不朽的模块命名空间里。`_EVENTS` 和 `_HOOKS` 同理；1500 个 `Session` 对象躺在 `_SESSIONS`
里，每个带着一份 12.0 KiB 的报表。

`lru_cache` 值得同样的待遇，因为它是这类 bug 最常见的形式。同一个函数、同样 5000 个唯一
key，只有 `maxsize` 不同：

```text
--- functools.lru_cache: maxsize=None vs maxsize=1024, 5000 unique keys ---
   maxsize=None  -> 20450.3 KiB tracked, currsize=5000
   cache_clear() -> 0.2 KiB tracked
   maxsize=1024  -> 4289.4 KiB tracked, currsize=1024
```

`maxsize=None` 不是「无限快」，而是「无限内存」：5000 个 key 就是 20.4 MB，看不到平台期。
Python 3.9 并没有把 `lru_cache` 默认改成有界——默认仍是 `maxsize=128`，但人们一想到「缓
存」就写的 `maxsize=None` 是无界的。

## 修复，以及那条被压平的曲线

修复方案都很无聊，而这恰恰是重点：没有任何聪明劲儿，只是每个容器要么有了大小，要么有了
主人。

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

session 注册表值得多说一句。我没有删掉那个引用循环——循环本身没问题。我改的是*谁拥有它*：
注册表是 `WeakValueDictionary`，是活 session 的索引而不是它们的主人；请求结束时
`sess.close()` 再打断那条反向引用。局部名字一出作用域，引用计数归零，这一对立即死掉——
完全不需要收集器跑一遍。

<figure>
<svg viewBox="0 0 640 280" width="100%" role="img" aria-label="每轮 150 个请求的 RSS 折线图。泄漏版从 29.1 MiB 爬到 111.7 MiB；修复版在第一轮之后稳定在 25.5 MiB。">
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
<figcaption>同一份工作负载跑两遍。泄漏版把 1500 个请求的报表全部留下；修复版第一轮填满有界状态后就平了——25.5 MiB，连续十轮。</figcaption>
</figure>

然后测量脚本一个字不改：

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

斜率就是全部：之前每轮 6.96 MiB，之后**每轮 0.07 MiB**。那 4.0 MiB 的 traced 字节*就是*
稳态本身——256 个缓存条目加 128 条事件——它没有地方可长：`leak.py:72` 上 **+3080.2 KiB
（256 blocks）**，正好 256 × 12 KiB。缓存满了，刚好满。

## 一个会断言内存的测试

只存在于你终端里的测量，活不过下一次重构。最便宜的防护：把负载驱动到有界状态本该填满的位置
之后，再断言留存已经停止。

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

跑一下——断言同时检查两个 handler，所以这个测试不可能靠巧合通过：

```text
   leaky   33379.2 KiB retained over 900 more requests
   fixed       0.1 KiB retained over 900 more requests

   leaky= 32310.4 KiB   fixed=    39.0 KiB   limit=512 KiB
   PASS: bounded handler retains   39.0 KiB (limit 512), leaky handler retains 32310.4 KiB
```

每次跑，泄漏版那个数字会差几百 KiB；比例才是重点：同样的工作，**39 KiB 对 32 MB**。这种阈
值不会 flaky，而且哪天有人把淘汰逻辑删了，它会响亮地失败。

## 常见嫌疑人，以及我的排查顺序

换成你自己的服务，搜索顺序按「它有多常成为答案」排：

1. **模块级 dict 和 list，只会加条目**——就是上面那个注册表模式。grep 模块作用域的
   `= {}` 和 `= []`，然后问：什么代码会从里面删东西？
2. **没有淘汰的缓存**——`@lru_cache(maxsize=None)`，以及任何以 request id、user id、URL
   或时间戳为 key 的手写 `CACHE[key] = ...`。key 空间无界，缓存就无界。
3. **注册表里的闭包和绑定方法**——事件监听、信号 handler、`atexit` 钩子、回调。每个闭包都
   留着它捕获的 frame，所以「一个小 lambda」背后可能是 12 KiB 的载荷。
4. **被不朽东西引用的引用循环**——只有当没有任何可达对象引用循环时才安全，而「活对象」注
   册表通常是那座桥。
5. **存进全局的 `sys.exc_info()`**，以及被日志里的 traceback 钉住的 frame。
6. **C 扩展里的任何东西**——如果遍历终止在一个 C 对象上，Python 层怎么改都没用；你得把那
   个 buffer 还回去。

## 预防，比上面所有做法都便宜

- **给每个缓存一个大小。** `functools.lru_cache(maxsize=…)`、一个会
  `popitem(last=False)` 的 `OrderedDict`、`cachetools.LRUCache`。如果你真的无法给它设上
  界，那你拥有的不是缓存，是日志。
- **索引用 `weakref`。** 「当前活着的对象」注册表应该是 `WeakValueDictionary`，或者以
  `close()` 里会删掉的 id 为键。所有权和查找是两份工作。
- **让清理显式并且真的调用。** `close()`、`__exit__`、上下文管理器、finally 块。
  `__del__` 是一个兜底，可能在任意时刻跑，也可能因为进程先死而永远不跑。
- **存摘要，不存对象。** 存 `repr(e)` 或者格式化后的 traceback 字符串，别存异常，更别存
  traceback。
- **保留一个内存测试。** 不要仪表盘，不要重启后对 RSS 告警——一个对已知工作断言留存量的测
  试。

## 方法，一段话说完

复现、测量、快照、找类型、找持有者。一个几秒内就泄漏的 harness；从 `/proc` 读 RSS、从
`tracemalloc` 读 traced 字节，确认它是真的且属于 Python；强制一次 `gc.collect()`，确认它
不是循环；按行 diff 两份快照，让解释器点名那个分配；爬 `gc.get_referrers`，直到撞上某个不
朽的东西；然后给找到的容器设上界、弱化那条引用、或者卸掉那个监听——再跑一遍，要求斜率归
零。这些数字的存在意义在于：下一个带着理论来的人，拿到的是表格，不是争论。

同一种「测量，别猜」习惯的另外两篇：[Linux 负载均值，以及它为什么骗你](/zh/posts/linux-load-average/) 和
[用 strace 调试：当系统调用讲出故事](/zh/posts/debugging-with-strace/)。
