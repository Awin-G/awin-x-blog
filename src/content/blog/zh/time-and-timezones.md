---
title: "时间、时区与 UTC：如何不再把它搞错"
description: "时区、UTC，以及两者之间那些 bug：为什么要以 UTC 存储、只在边界处转换，instant、本地日期时间与 duration 的区别，墙上时钟为什么不是单调的，DST bug 里的空档与歧义，tz 数据库，跨 DST 的 cron，以及 Python/JS 的陷阱——附一份清单。"
pubDate: 2026-11-21
lang: zh
translationKey: time-and-timezones
tags: [linux, devops]
featured: false
keywords:
  - 时区
  - 以 UTC 存储
  - DST bug
  - 单调时钟
  - tz 数据库
---

我上线过的每一个涉及**时区**的 bug，根因都一样：一个时间戳同时代表了两件事。
解药不是什么聪明的库，而是一条纪律——**以 UTC 存储**（或另一个绝对瞬间），只在
边界处转换。做到这一点，大多数 **DST bug** 根本不会被写出来；你也会明白，有那
么一件事上墙上时钟是错的工具，而**单调时钟**才是对的。

## 人们口中的「时间」，其实是三种东西

在写任何代码之前，先把被压成一团的三个概念拆开：

| 概念 | 例子 | 用途 |
| --- | --- | --- |
| **Instant（瞬间）** | `2026-11-21T15:00:00Z` | 全局时间轴上的一个点；存储、排序、比较 |
| **本地日期时间** | `2026-11-21 10:00 America/New_York` | 人类墙上时钟的读数；不带时区就没有意义 |
| **Duration（时长）** | `90m`、`P1D` | 一段流逝的时间；算术、超时 |

Instant 是真正发生了的那件事。本地日期时间是它的一次*投影*，而这次投影取决于你
站在哪里，也取决于一部政府随时能改的法律。Duration 根本不是一个点。错误就在于
把这三者当成可以互换的：一场写在 `2026-11-21 10:00`、却不带时区的会议，不是一个
时间，而是一道谜题。

<figure>
<svg viewBox="0 0 640 240" width="100%" role="img" aria-label="两条时间轴。上面一条是等间距的绝对瞬间，以 UTC 标注；下面一条是同样的瞬间落在本地墙上时钟上的样子，春季前跳跳过了 02:00 这一小时，于是一小时的真实时间变成了两小时的钟表读数。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="20" y="28" opacity="0.85">绝对瞬间（UTC）</text>
    <line x1="60" y1="80" x2="580" y2="80" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
    <g stroke="currentColor" stroke-width="1.5" opacity="0.55">
      <line x1="60" y1="74" x2="60" y2="86"/>
      <line x1="190" y1="74" x2="190" y2="86"/>
      <line x1="320" y1="74" x2="320" y2="86"/>
      <line x1="450" y1="74" x2="450" y2="86"/>
      <line x1="580" y1="74" x2="580" y2="86"/>
    </g>
    <g text-anchor="middle" opacity="0.95">
      <text x="60" y="66">00:00</text>
      <text x="190" y="66">01:00</text>
      <text x="320" y="66">02:00</text>
      <text x="450" y="66">03:00</text>
      <text x="580" y="66">04:00</text>
    </g>
    <g stroke="currentColor" stroke-width="1" stroke-dasharray="3 4" opacity="0.35">
      <line x1="60" y1="90" x2="60" y2="180"/>
      <line x1="190" y1="90" x2="190" y2="180"/>
      <line x1="320" y1="90" x2="320" y2="180"/>
      <line x1="450" y1="90" x2="450" y2="180"/>
      <line x1="580" y1="90" x2="580" y2="180"/>
    </g>
    <text x="20" y="160" opacity="0.85">本地墙上时钟（春季前跳当天）</text>
    <line x1="60" y1="200" x2="580" y2="200" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
    <g stroke="currentColor" stroke-width="1.5" opacity="0.55">
      <line x1="60" y1="194" x2="60" y2="206"/>
      <line x1="190" y1="194" x2="190" y2="206"/>
      <line x1="320" y1="194" x2="320" y2="206"/>
      <line x1="450" y1="194" x2="450" y2="206"/>
      <line x1="580" y1="194" x2="580" y2="206"/>
    </g>
    <g text-anchor="middle" opacity="0.95">
      <text x="60" y="224">01:00</text>
      <text x="190" y="224">03:00</text>
      <text x="320" y="224">04:00</text>
      <text x="450" y="224">05:00</text>
      <text x="580" y="224">06:00</text>
    </g>
    <path d="M60 184 H190" stroke="currentColor" stroke-width="2" opacity="0.9"/>
    <text x="125" y="176" text-anchor="middle" font-size="11" opacity="0.9">1 小时真实时间</text>
    <text x="125" y="188" text-anchor="middle" font-size="11" opacity="0.9">= 2 小时钟表读数</text>
  </g>
</svg>
<figcaption>Instant 均匀地向前走；本地墙上时钟则会跳。存上面那条，渲染下面那条。</figcaption>
</figure>

## 以 UTC 存储，只在边界处转换

规则是：**持久化和传输用 instant，给人类看的时候才在边界处转换。**

- **数据库：** 存 instant。在 Postgres 里就是 `timestamptz`（本质是「一个 UTC
  瞬间」），绝不要不带时区的 `timestamp`。在 SQLite 或 MySQL 里，存 UTC 或整数
  epoch。
- **传输格式：** 带明确偏移的 ISO 8601（`...Z` 或 `+02:00`），或者 epoch 秒。
  绝不要裸的 `2026-11-21 10:00`。
- **日志：** 永远 UTC。这样 [结构化日志](/zh/posts/structured-logging/) 的查询才能
  在不同地区的机器之间对齐。
- **输入：** 解析用户给的任何东西——包括时区——然后立刻归一化成一个 instant。
- **输出：** 在最后一刻才转换成读它的人所在的时区。

把它当成钱来对待：你绝不会把价格存成「12.99，至于什么货币，读者自己猜」。时间也
一样——存绝对量，在边界处格式化。

```python
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# 一个 instant。这才是你要存、要记日志、要发出去的东西。
now = datetime.now(timezone.utc)          # 2026-11-21 15:00:00+00:00
db_value = now.isoformat()                # "2026-11-21T15:00:00.123456+00:00"

# 只有要给某人看的时候才转换。
ny = now.astimezone(ZoneInfo("America/New_York"))
print(ny.strftime("%Y-%m-%d %H:%M %Z"))   # 2026-11-21 10:00 EST
```

进来转换一行，出去转换一行，中间是一个 instant。这就是全部要点。

## 为什么墙上时钟不是单调的（以及何时该用单调时钟）

`datetime.now()` 和 `time.time()` 读的是**墙上时钟**——用来命名一个瞬间是对的，用
来测量流逝的时间则是错的工具，因为它不是**单调**的：它会跳。

它会在这些情况下跳：**NTP** 步进时钟（首次同步或手动 `ntpdate` 能一次性把时间挪
几秒）；在某些把偏移量直接施加到 `time.time()` 的系统上遇到 **DST 切换**；或者
运维和 hypervisor 手动改了钟。

一次 500ms 的请求如果跨了一次向后的步进，你的代码就会报出负的耗时，或者超时提
前触发。任何测量*多久*的东西——延迟、超时、重试退避、限流器、「这个租约过期了
吗」——都必须用**单调时钟**：一个只会前进的钟。

```python
import time

# 错：用墙上时钟测耗时，它可能会跳。
t0 = time.time()
do_work()
elapsed_wall = time.time() - t0     # 可能是负数！

# 对：单调时钟永远不会倒退。
t0 = time.monotonic()
do_work()
elapsed = time.monotonic() - t0     # 用于延迟、超时、退避是安全的
```

各语言给你的东西：Python 的 `time.monotonic()`（要最高分辨率就用
`time.perf_counter()`）；Go 的 `time.Since()` 和 `time.Now()` 自带一个单调读数；
Node 和浏览器有 `performance.now()`。代价是：单调时钟和日历日期没有任何关系——
你不能存它，只能在一个进程的生命周期内比较它。所以：*何时*用墙上时钟，*多久*
用单调时钟。

## DST bug：春季前跳的空档与秋季回拨的歧义

在一个遵守 DST 的时区里，一年中有两个本地时间是有病的。

**春季前跳——空档。** 钟表从 02:00 直接跳到 03:00，所以 02:30 在本地*并不存在*：

```python
from datetime import datetime
from zoneinfo import ZoneInfo

ny = ZoneInfo("America/New_York")

# 2026-03-08 是美国的春季前跳：02:00 -> 03:00。
gap = datetime(2026, 3, 8, 2, 30, tzinfo=ny)
print(gap)                 # 2026-03-08 02:30:00-05:00（被悄悄挪动了！）
print(gap.utcoffset())     # -5:00 —— 被「就近取整」到了切换前的偏移
```

`zoneinfo` 不会抛异常；它会挑一个偏移量把这个不存在的时间解析掉——而不同的库挑得
*不一样*。这恰恰说明你根本不该问这个问题：存 instant，空档就永远不存在。

**秋季回拨——歧义。** 钟表从 02:00 退回 01:00，于是 01:30 会发生*两次*：一次在夏
令时，一次在标准时。用户说的到底是哪一次？

```python
# 2026-11-01 是秋季回拨：02:00 -> 01:00，于是 01:30 出现两次。
ambiguous = datetime(2026, 11, 1, 1, 30, tzinfo=ny)
print(ambiguous.utcoffset())                    # -4:00（第一遍，EDT）
print(ambiguous.replace(fold=1).utcoffset())    # -5:00（第二遍，EST）
```

`fold`（PEP 495）是 Python 表达「第二次出现」的方式。大多数代码从不设置它，于是
大多数代码悄悄选择了第一次。两次的教训是同一条：**一个本地墙上时钟时间加上一个
时区，并不总能确定一个 instant。** 当它必须确定时——未来的预约、开盘时间——存下
本地时间*和时区名*，到最后一刻再解析，绝不存预先算好的偏移量。其余情况：以 UTC
存储，这两个 bug 都不会发生。

## tz 数据库：为什么硬编码偏移量在跨时区时会失败

`America/New_York` 不是「UTC-5」。它是「冬天 UTC-5、夏天 UTC-4，依据一部政府可以
修改的规则」。这些规则住在 **tz 数据库**（IANA tzdata）里，几乎每台 Unix 都会把它
编译进 `/usr/share/zoneinfo`。

硬编码偏移量会在两个地方失败：

1. **一年两次。** `UTC-5` 每个夏天都错；`UTC-4` 每个冬天都错。
2. **毫无预警。** 当某个国家废除 DST、改动标准偏移或挪动切换日期时，你的 `UTC-5`
   照常工作——而且从此永远悄悄错了。tz 数据库拿到了更新，你的常量没有。

```bash
$ timedatectl status                        # 这台机器认为「现在」是几点
$ TZ=America/New_York date                   # 用某个时区渲染，不改系统钟
$ TZ=UTC date -d '2026-11-21 15:00'          # 同一个 instant，换个视角
$ zdump -v America/New_York | head           # 直接从数据库里看切换点
```

实操规则：**存时区名，不存偏移量。** 保持 `tzdata` 更新（`apt upgrade tzdata` 不是
玩笑——过期的规则就是这样被修好的），让库去做那一次投影。

## 跨 DST 的 cron 与定时器

`cron` 按墙上时钟触发，于是在切换日会产生两个经典 bug：

- **春季前跳：** 定在 `02:30` 的任务那天没有 02:30，有些 cron 实现会直接跳过它。
- **秋季回拨：** `01:30` 出现两次；有的实现跑两次，有的跑一次。如果任务不幂等，你
  刚把备份跑了两遍。

我更喜欢用来干正经事的 [systemd 定时器](/zh/posts/systemd-timers-vs-cron/) 也按本地
时间定义，但 systemd 会刻意处理切换：跳过不存在的时刻，对歧义时刻只跑一次。尽管
如此，那条最无聊的建议依然成立：

- **别把任务定在 01:00–03:00 这个窗口里。** 把任务放在任何 DST 规则都碰不到的小时
  上。`03:30` 是安全的；`02:30` 是在自找麻烦。
- **让任务幂等。** 在重复触发下安全，就在任何调度器的怪癖下都安全。
- **要严格按 UTC 调度**，cron 接受 `CRON_TZ=UTC`。

调度器是和时间戳不同的问题，但两者恰好在同一个地方相撞：三月某个星期天的 02:30。

## 常见的语言陷阱：naive datetime 与 JS 的 Date

**Python——naive 与 aware。** **naive datetime** 不带时区；aware 的则携带一个
`tzinfo`。几乎每一个时间 bug，都是一个 naive 值跨过了 DST 边界，或者被拿去和一个
aware 值比较。

```python
from datetime import datetime, timezone, timedelta

x = datetime.now()              # naive 的本地时间——名字虽如此，却是陷阱
y = datetime.utcnow()           # naive 的 UTC——3.12 起因此被废弃
z = datetime.now(timezone.utc)  # aware。用这个。

# 跨 DST 切换时，「+1 天」不等于 +24 小时——日历运算需要时区。
datetime(2026, 3, 8, 23, 0) + timedelta(days=1)
```

两个习惯：在服务端代码里绝不裸调用 `datetime.now()`；当你想表达「明天的同一墙上
时间」时，别用 `timedelta`——那是日历运算，需要时区感知的库。

**JavaScript——一种类型，两种语境。** `Date` 存的是一个绝对量（自 epoch 起的毫
秒），却*又*坚持按本地时区渲染：

```js
Date.parse("2026-01-01")        // 只有日期 => 解析为 UTC 午夜
Date.parse("2026-01-01T00:00")  // 日期+时间  => 解析为本地时间
new Date().toISOString()        // 永远 UTC —— 适合存储
new Date().getHours()           // 本地 —— 显示可以，做逻辑不行
```

前两行的不一致，烧过每一个 JS 开发者至少一次。`Date` 根本无法表示「纽约的 10:00」
——它只有一个 instant，加上你这台机器的本地视角。真要处理，用 `Temporal`（如今已
广泛可用）或某个库，并让应用的其余部分在内部一律用 `toISOString()` 和 epoch。

## 一份简短的清单

- **存 instant，不存墙上时间。** 数据库里用 UTC（`timestamptz`），传输用带偏移的
  ISO 8601 或 epoch。
- **只在边界处转换。** 进来时带时区解析，出去时在某个时区里格式化。
- **写时区名，绝不写偏移量。** 是 `America/New_York`，不是 `-05:00`。让 `tzdata`
  保持最新。
- **何时用墙上时钟，多久用单调时钟。** 延迟、超时、退避用 `time.monotonic()` /
  `performance.now()`。
- **绝不混用 naive 和 aware。** Python：`datetime.now(timezone.utc)`；JS：内部用
  `toISOString()`。
- **尊重空档和歧义。** 切换日别把任务定进本地的 01:00–03:00；未来的本地时间要连
  时区一起存，到最后一刻再解析。
- **让定时任务幂等。** 这样重复触发只是耸耸肩，而不是事故。
- **日志用 UTC。** 这是三台机器的[日志行](/zh/posts/structured-logging/)能正确排序
  的唯一办法。

## 一句话总结

instant 是事实，本地日期时间是观点，duration 是算术。**以 UTC 存储**，在边界处投
影，用**单调时钟**测量流逝的时间，**时区**留名字不留偏移量——于是大多数 **DST bug**
压根不会被写出来。
