---
title: "限流不只是计数器：令牌桶、nginx limit_req 与 HTTP 429"
description: "一个 IP 一个计数器根本不算限流。本文讲清楚你到底在防什么、为什么固定窗口和滑动窗口会失手、令牌桶如何处理突发、该在哪一层拦截、小服务不用 Redis 怎么做限流，以及如何返回带 Retry-After 的、诚实的 429。"
pubDate: 2026-11-17
lang: zh
translationKey: rate-limiting
tags: [devops, networking, python]
featured: false
keywords:
  - 限流
  - 令牌桶
  - nginx limit_req
  - HTTP 429
  - 滑动窗口
---

每个教程都从同一个套路开始：一个存 IP 的 `dict`，一句 `if hits > N: reject`，然后宣称问题解决了。直到有一天，一个两百人的办公室因为其中一个人在爬站，集体登录不上，我才明白**限流**不是一道计数题。它问的是：你在保护什么、谁和你共用同一个身份、以及你做错的时候该怎么办。**令牌桶**处理的是计数器处理不了的突发，**nginx limit_req** 解决的是「用最便宜的方式拦截」，而一个诚实的 **HTTP 429** 回答的是「我是不是把真人挡在外面了」。这三样，没有一个是计数器。

## 限流到底在防什么

挑算法之前，先给敌人起个名字。这几件事根本不是同一个问题。

- **滥用。** 撞库、垃圾注册、爆破 token。特征是*大量廉价请求来自大量来源*；要按身份卡紧。
- **爬虫。** 客户端以远超人类的速度抓你的目录。信号是*单账号数小时内的总量*，按秒的计数器永远看不见。
- **昂贵接口。** 一次 `/export` 就跑 30 秒查询。正确的防护是限制并发，而不是限制请求速率。
- **意外的循环。** 没有退避的重试、`while true` 里轮询的客户端、对 500 无限重试的合作方。这里的「攻击者」就是你自己的用户，而一个硬限制反而是善意。

「每 IP 每分钟 100 次」是一个数字假装覆盖了上面四种情况。它对 `/export` 太松，对分页太严，还对一个刻意压在线下的爬虫完全瞎眼。

## 为什么「一个 IP 一个计数器」会失手

按 IP 计数之所以是默认做法，只是因为它简单，不是因为它对。它会在三个地方可预测地崩掉：

- **共享 NAT。** 一家公司、一所学校、运营商的 CGNAT——几千个真人共用一个出口 IP。你为了一个坏家伙，把所有人一起限了。
- **分布式客户端。** 有点动机的人都备着代理池；一万个 IP 各发一次请求毫不费力。按 IP 限流对攻击者毫无成本。
- **合法的突发。** 一个仪表盘加载时打出二十个 XHR，就是一个人在正常使用；按秒的计数器看到尖峰，拒掉一半。

还有第四个更隐蔽的：**IPv6**。一个用户往往掌控一整个 `/64`——几十亿个地址——在 IPv4 下很紧的按 IP 限制，一放到 IPv6 就形同虚设。

## 各种算法：固定窗口、滑动窗口、令牌桶、漏桶

### 固定窗口

把时间切成桶（比如每分钟一个），每个桶计数。便宜——一个整数、一个 TTL。毛病在边界：12:59:59 来 100 次、13:00:00 再来 100 次，就是两秒内 200 次的突发。

### 滑动窗口

两种修法，都在拿精度换内存。

- **滑动窗口日志**记录每个请求的时间戳，统计最近 N 秒内的次数。精确，但内存随上限增长——用在少数昂贵接口上还行，用在几百万个 key 上就是浪费。
- **滑动窗口计数**保留当前和上一个窗口的计数再做插值：`prev * (1 - elapsed/window) + current`。常见的折中：每个 key 几字节、没有边界悬崖、一点点你根本察觉不到的近似误差。

### 令牌桶

桶里最多装 `capacity` 个令牌，以恒定的 `rate` 补充。每个请求花掉一个令牌；没有令牌，就没有请求。一个旋钮变两个：`rate` 是你允许的长期均值，`capacity` 是你容忍的突发。这才符合现实，因为真实流量本来就是突发的。这是我默认的选择。

<figure>
<svg viewBox="0 0 604 180" width="100%" role="img" aria-label="令牌桶随时间变化：令牌以固定速率补充到容量上限，请求成批消耗令牌。">
  <g stroke="currentColor" stroke-width="1" opacity="0.25" fill="none">
    <line x1="60" y1="30" x2="584" y2="30"/>
    <line x1="60" y1="150" x2="584" y2="150"/>
    <line x1="60" y1="30" x2="60" y2="150"/>
  </g>
  <polyline fill="none" stroke="currentColor" stroke-width="2"
    points="60,150 180,30 180,78 300,30 300,90 420,30 420,126 540,30 540,54 584,30"/>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" opacity="0.85">
    <text x="636" y="34" text-anchor="end">capacity</text>
    <text x="636" y="154" text-anchor="end">0</text>
    <text x="66" y="170" font-family="system-ui, sans-serif">time →</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.7">
    <text x="200" y="20" text-anchor="middle">补充</text>
    <text x="430" y="150" text-anchor="middle">一次突发 8 个立即消耗</text>
  </g>
</svg>
<figcaption>令牌桶线性补充到上限；一次突发会瞬间花掉全部积蓄。<code>rate</code> 决定长期均值，<code>capacity</code> 决定你容忍多大的突发。</figcaption>
</figure>

### 漏桶

镜像版本：请求以固定速率滴出，超过容量的要么丢弃、要么排队。你用排队请求的延迟换来完全平滑的输出速率。当*下游*很慢、需要被削平的时候用它，而不是在你关心响应延迟的时候。

## 在哪里拦截：边缘、应用，还是按 key

你有三个地方可以限，而每一层看到的东西都不一样。

- **在边缘（nginx、CDN、负载均衡器）。** 最便宜——应用还没醒就被拒了——但它只看得到 `$binary_remote_addr` 和可能的一个 header。适合粗暴地挡按 IP 的洪峰，对「按用户的公平」无能为力，因为它不知道谁登录了。
- **在应用里。** 慢一些，但它知道账号、接口、套餐和成本。`免费版 60/分钟、付费版 6000/分钟` 就住在这里。
- **按 key、按 IP 还是按用户。** 优先用你手上最强的身份。`$binary_remote_addr` 是传输层事实，API key 或 user ID 是业务事实。按业务事实限流，你才能扛过 NAT、CGNAT 和 IPv6 轮换。只有登录这类未认证路由才退回按 IP。

分层是很正常的：边缘一道松的按 IP 限制，应用里一道严的按用户限制，再给真正烧钱的接口单独加一个并发上限。

## nginx limit_req：粗暴、便宜，能顶很多事

`limit_req` 默认就是一个按 `$binary_remote_addr` 的漏桶。两个参数承担了全部工作：`burst`（允许超出速率多少）和 `nodelay`（突发立即放行，而不是摊开处理——摊开会给真人的页面加载增加延迟）。

```nginx
# /etc/nginx/conf.d/rate-limit.conf
limit_req_zone $binary_remote_addr zone=perip:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=expensive:10m rate=1r/s;
limit_req_status 429;

server {
    location /api/ {
        limit_req zone=perip burst=20 nodelay;
        proxy_pass http://app;
    }

    # 给那个要烧 30 秒 CPU 的接口单独一个桶。
    location /api/export/ {
        limit_req zone=expensive burst=2 nodelay;
        proxy_pass http://app;
    }
}
```

`10m` 的 zone 大约能记住 16 万个 IP；满了会淘汰旧条目，而不是直接丢弃。注意 nginx *不会*做什么：它自己的 `429` 不带 `Retry-After`。你要么在应用里算一个，要么在边缘用 `add_header Retry-After 1 always;` 近似一下——诚实的猜测总好过没有。

## 小服务不用 Redis 也能限流

提到共享计数器，第一反应是 Redis；对一个集群来说这没错。但对一个单进程小服务，它就是一份依赖、一种故障模式，以及一个你可能根本不需要的延迟跳。我默认的顺序是：

1. **先用进程内。** 一个进程、一个存令牌桶的 `dict`。没有网络、没有单点。你一旦跑第二个实例它就错了——但如果你只跑一个,它就完全正确，而且只有十行。
2. **扩展时才上共享存储。** 只有确实多于一个进程才加 Redis：用它做全局上限，同时保留进程内的桶当第一层便宜过滤。只有当一个请求已经可疑时，才去查那个更贵的存储。

```python
import time

class TokenBucket:
    """惰性补充：没有后台定时器，每次调用只做算术。"""
    def __init__(self, capacity, refill_per_sec):
        self.capacity = capacity
        self.rate = refill_per_sec
        self.tokens = capacity
        self.updated = time.monotonic()

    def allow(self, cost=1.0):
        now = time.monotonic()
        # 按流逝时间补充，上限就是 capacity —— 这个上限正是突发额度。
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True, 0.0
        # 令牌不够：告诉调用方还要等多久这个请求才放得下。
        wait = (cost - self.tokens) / self.rate
        return False, wait
```

`allow()` 同时返回判定结果和一个 `Retry-After` 值——这正是偏爱令牌桶而不是计数器的理由：等待时间是从算术里推出来的，而不是编出来的。

真要加共享存储时，让它保持笨：用一个原子的固定窗口计数器当粗略的全局上限，只在本地桶放行之后才检查。它挂了就 fail open——全局限制丢一分钟，好过让整个服务跟着 Redis 一起挂。

```python
class Limiter:
    def __init__(self, shared=None):
        self.shared = shared          # redis 客户端，或 None
        self.local = {}               # key -> TokenBucket，每进程一份

    def allow(self, key, cost=1.0):
        bucket = self.local.setdefault(key, TokenBucket(20, 10))
        ok, wait = bucket.allow(cost)
        if not ok:
            return False, wait
        if self.shared is None:
            return True, 0.0
        # 只在便宜的本地检查通过之后，才碰粗略的全局上限。
        window = int(time.time()) // 60
        k = f"rl:{key}:{window}"
        count = self.shared.incr(k)
        if count == 1:
            self.shared.expire(k, 120)   # 窗口结束就忘掉它
        if count > 600:
            return False, 60 - (time.time() % 60)
        return True, 0.0
```

## 返回一个正确的 HTTP 429，带上 Retry-After

一个不带任何指示的 `429` 是个负载放大器：客户端拿到它就立刻重试，洪峰更糟。**HTTP 429** 存在的意义，就是让你能叫客户端退后。

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 3
Content-Type: application/json

{"error": "rate_limited", "retry_after": 3}
```

`Retry-After` 可以填秒数或一个 HTTP 日期；短窗口下填秒数更简单也更对。`RateLimit-*` 那组字段（IETF 草案的惯例）能让一个好客户端在被拒*之前*就主动降速。把你发出的等待时间对齐到 `allow()` 算出的等待时间，并且让边缘和应用保持一致——同一个限制给出两个不同的 `Retry-After`，比不给我还糟。

## 失败模式：限流限到自己，把真人挡在外面

危险的失败不是限得太松，而是一道悄悄拒掉你想要的那些人的限制。我确实这么干过的几种方式：

- **在 CDN 后面按 IP 限流。** 所有请求都来自 CDN 的边缘 IP，于是你把自己的代理限了。只信任 CDN 的网段，用它的真实客户端 IP header，绝不无脑信 `X-Forwarded-For`。
- **一条路由一个桶。** 登录和读取共用一个桶，会让只是开着页面的人被登出。把限制范围收敛到路由。
- **给「重试是安全的」请求限流。** 在一次失败扣款之上再叠一个 `429` 是最糟的答复——那正是[幂等键](/zh/posts/idempotency-keys/)要解决的问题。
- **忘了健康检查和内网流量。** 你自己的监控撞上限流，就把一个健康的服务变成了「宕机」告警。
- **没有可观测性。** 如果你看不到自己多频繁地返回 `429`、返回给了谁，那你就在猜。盯拒绝比例，而不是原始计数。

还有个更阴的：**限流限到你自己。** 对一个内部会扇出的服务下激进进程内限制——一个调用自己 API 的 worker——会掐死你自己的流量。把 loopback 调用方加白，并用真实的突发去压测。

## 我现在怎么做

- 先命名威胁，再定数字：滥用、爬虫、成本、循环，各自要不同的限制。
- 默认用**令牌桶**——`rate` 管均值，`capacity` 管突发——并且优先按用户或 API key，而不是按 IP。
- 只有必须按单位时间计数时才用**滑动窗口**，接受计数版比日志版省内存、但有近似。
- 用 **nginx limit_req** 在边缘挡粗暴洪峰，在应用里做按用户的公平；在只有一个实例之前，保持进程内即可。
- 永远返回带 `Retry-After` 的 **429**，那个值是拒绝这个请求的同一套算术推出来的，并把拒绝率当成一等指标盯着。

一道把真人挡住的限流，就是一场多绕了几步的宕机。如果你想知道一个受保护的接口在被顶回来之前能被打多快，那正是[逆向一个私有 API](/zh/posts/reverse-engineering-a-private-api/)教的东西——搞懂它，你就知道自己的限制是一堵墙还是一句建议。按 IP 的计数器两者都不是。去建那个真正匹配威胁的吧。
