---
title: "真正能在凌晨三点帮你排障的结构化日志"
description: "为什么 print 和非结构化日志会在凌晨三点坑你、结构化日志与 JSON logs 到底是什么、各级别该记什么、什么永远不能记、如何传递 correlation id、journald 的真实处境（含 journalctl -o json）、采样与成本，以及 Python/Go/Node 的对比。"
pubDate: 2026-11-15
lang: zh
translationKey: structured-logging
tags: [devops, linux]
featured: false
keywords:
  - 结构化日志
  - JSON 日志
  - journald
  - 日志级别
  - correlation id
---

凌晨三点，告警说 API 在报错。你 SSH 上去，敲 `journalctl -u api`，然后看
到一整面这样的东西：

```
failed to charge user
retrying...
failed to charge user
cache miss
failed to charge user
```

三行一模一样，不知道哪一行属于那个失败的请求，不知道是哪个用户，也不知道
那次调用花了多久。于是你开始按时间戳去 grep，靠猜。这正是**可观测性**里没人
会写进 PPT 的那一半：不是仪表盘，而是「*那一个请求*到底发生了什么」这个问题
能在一分钟内被答出来。**结构化日志**是花最小代价就能买到这个能力的那次升级，
而且它不需要日志聚合器、不需要付费 SaaS，也不需要一份比你的应用还长的 YAML。

## 为什么 print 和非结构化日志会在凌晨三点坑你

一行 `print()` 是写给此刻就坐在你旁边的人的。它把一切都编码成散文，而这段
散文只有在拥有完整上下文时才讲得通——可你在几小时后、在另一台机器上、在凌晨
三点，早就没有那份上下文了：

- **你没法按一个「不是字段」的东西过滤。** `grep "charge"` 会同时命中那行日志、
  重试信息，以及一行恰好提到这个词的 debug。
- **你没法回答「有多少」。** 想数失败次数，就得用正则去抠时间戳，还得祈祷格式
  从没变过。
- **你没法关联。** 触发失败的那个 Web 请求在一处，DB 超时在另一处，中间没有
  任何东西把它们连起来。
- **你没法稳定解析。** 有人加了个 emoji，一段堆栈落在某行中间，你的 `awk` 就
  崩了。

解药不是「多记点」，而是**把同样的事记成数据**：固定的键、稳定的类型、一个事件
一行。这就是**结构化日志**的全部含义。剩下的——采集器、仪表盘、告警——都叠在
它上面，是可选的。

## 结构化日志到底是什么

只有两个想法：

1. **键/值对。** 每个事件是一组有名字的字段，而不是一句话。
2. **一个事件一行、机器可解析。** 最常见的编码就是 **JSON logs**——一行一个
   JSON 对象（「JSON Lines」），外面不套数组，也不做 pretty-print。

就这么多了。你不需要 schema registry、不需要自定义二进制格式，也不需要那个能
吐十七种协议的日志库。一个好的起点契约是：

- `ts`——ISO 8601、UTC、毫秒精度。
- `level`——小写，取自一个固定的小集合。
- `msg`——描述事件的、简短的**常量**字符串，不做插值。
- **所有可变的东西各占一个字段**——`request_id`、`route`、`status`、
  `duration_ms`、`err`。

「msg 是常量」这条是大家最先破坏的，也是最重要的一条。`msg: "charge failed for
user 42"` 又变成了一句话；`msg: "charge failed", user_id: 42` 才是可查询的。

<figure>
<svg viewBox="0 0 620 150" width="100%" role="img" aria-label="一个请求 id 在代理处生成，写入请求头，被应用记录，并传给数据库，于是三层共享同一个标识符。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="48" width="120" height="54" rx="8"/>
    <rect x="250" y="48" width="120" height="54" rx="8"/>
    <rect x="484" y="48" width="120" height="54" rx="8"/>
    <path d="M136 75 h108" marker-end="url(#a)"/>
    <path d="M370 75 h108" marker-end="url(#a)"/>
  </g>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="76" y="72">代理</text>
    <text x="76" y="90" opacity="0.75">生成 id</text>
    <text x="310" y="72">应用</text>
    <text x="310" y="90" opacity="0.75">记录并转发</text>
    <text x="544" y="72">数据库</text>
    <text x="544" y="90" opacity="0.75">application_name</text>
    <text x="190" y="66" opacity="0.9">X-Request-ID</text>
    <text x="424" y="66" opacity="0.9">同一个 id</text>
  </g>
</svg>
<figcaption>一个 correlation id，在边缘处生成一次，每一层复用。</figcaption>
</figure>

## 一条具体的日志

下面这条是我真的会去 grep 的事件，错误场景：

```json
{"ts":"2026-11-15T09:41:07.123Z","level":"error","msg":"charge failed","request_id":"8f3c1d2e","route":"POST /charge","user_id":1042,"status":502,"duration_ms":412,"err":"upstream timeout","upstream":"stripe","retry":2}
```

不用我解释也能读出来：一次扣款失败了，发生在 `POST /charge` 上，耗时 412ms，
原因是 Stripe 超时，这是第二次重试，用户是 1042，请求 id 是 `8f3c1d2e`。现在
我可以对它 `jq`、计数、分组，而且最关键的——把那一个请求的所有行都捞出来：

```bash
journalctl -u api.service -o cat --since "09:40" | jq -c 'select(.request_id=="8f3c1d2e")'
```

## 每个级别该记什么

**日志级别**是关于「谁需要动手」的承诺，而不是关于代码感觉有多重要。破坏这个
承诺，一切都会变成 `info`，你又回到了 grep。

| 级别 | 含义 | 例子 |
| --- | --- | --- |
| `debug` | 生产关着，排障时开 | 缓存键、SQL、走了哪个分支 |
| `info` | 正常的状态变化，值得留痕 | 启动、配置加载、部署 id、任务完成 |
| `warn` | 可恢复，有人该瞄一眼 | 重试、废弃警告、走了降级路径 |
| `error` | 某个操作失败，可能需要人处理 | 扣款失败、数据库不可达 |
| `fatal` | 进程要死了 | 绑不上端口、不变量被违反 |

我用的几条实操规则：

- **每个请求一行 `info`**，放在最后，带 `status` 和 `duration_ms`。不是开头一
  行、结尾一行，也不是每个中间件一行。
- **`debug` 关着的时候不花成本**，那就大方地写——但绝不在级别没开时就去拼那
  个昂贵的字符串或去取那个对象。
- **`error` 应该稀有到可以安全地对它告警。** 如果你的 `error` 正常情况下是每
  小时 4000 条，那你已经把一个真信号藏进噪音里了。

### 什么永远不要记

这份清单很短、很绝对、没得商量：

- **密钥**：API key、bearer token、密码、session cookie、私钥、内嵌凭据的连接串。
- **PII**：明文邮箱、姓名、电话、地址、卡号、身份证号。记内部 `user_id`，PII
  到别处去 join。
- **巨大的载荷**：完整的请求/响应体、base64 blob、整页 HTML、查询结果的每一行。
  它们会同时炸掉磁盘、成本和可读性。
- **无界的用户输入**：原始 query string、headers、`User-Agent`、文件名。

有两个习惯能让这份「永远不要」在现实中站得住：

1. **在日志器上脱敏，而不是在每个调用点。** 一个能丢弃或遮盖已知敏感键
   （`authorization`、`password`、`token`、`cookie`）的 formatter，能兜住某个犯
   困的同事刚加的那一行。
2. **记标识符，不记值。** `user_id`、`order_id`、`request_id` 既安全又小——而它们
   通常就是你真的需要的全部。

## Correlation id，以及怎么传递它

**correlation id**（也叫 `request_id`、`trace_id`）是一串随机字符串，标识一个
逻辑请求，并出现在该请求触及的*每一条*日志上。它是你能加的最高杠杆的字段。

模式就照上面那张图：

1. **在边缘生成。** 你的反向代理在客户端没带 id 时生成一个，并且永远在入站时
   带上它。在 nginx 里：

   ```nginx
   map $http_x_request_id $req_id {
       default $http_x_request_id;
       ""      $request_id;
   }
   add_header X-Request-ID $req_id always;
   proxy_set_header X-Request-ID $req_id;
   ```

2. **在应用里绑定。** 只读一次 header，把它挂到 logger 上，之后绝不手动到处传。
   这三套生态都有办法携带请求作用域的上下文，而不用把参数穿过每一个函数：
   Python 的 `contextvars`、Go 的 `context.Context`、Node 的
   `AsyncLocalStorage`。
3. **往下游转发。** 每一次出站 HTTP 调用都复制这个 header。对数据库，把
   `application_name` 设成这个 id，好让慢查询日志能对上。如果你已经在用 W3C
   **trace**，就复用 `traceparent`，别再造一套。
4. **信任，但要消毒。** 只有当客户端传来的 id 匹配一个便宜的模式（hex、长度有
   界）时才接受它。否则恶意客户端可以注入换行符或伪造关联。

回报就是前面那条查询：从用户的一条 bug 报告里你拿到一个 id，一条
`journalctl ... | jq` 就给你跨服务的完整故事。

## journald 的真实处境

在一台普通的 Linux 机器上，你的应用把 JSON 写到 stdout，**journald** 负责存下
来。它免费、已经装好、能做二分查找，而且重要的是——它不是一个日志*聚合器*。
它对你的 JSON 键一无所知。它给你的是：

- **白送的一堆元数据**：`PRIORITY`、`_PID`、`_SYSTEMD_UNIT`、`_COMM`、
  `SYSLOG_IDENTIFIER`、`__REALTIME_TIMESTAMP`，以及 boot id。
- **`-o json` 把它们掏出来**，一行一个 JSON 对象，然后你用 `jq` 塑形：

  ```bash
  journalctl -u api.service -o json --since "1 hour ago" \
    | jq -r 'select(.PRIORITY=="3") | .MESSAGE | fromjson
             | "\(.ts) \(.route) \(.status) \(.err)"'
  ```

  注意那个 `.MESSAGE | fromjson`：journald 把你的 JSON 又包进了它自己的 JSON 里，
  所以你得从 `MESSAGE` 字段里再解出自己的那一行。值得知道的其他模式：`-o cat`
  （只要消息）、`-o json-pretty`（给人调）、`-f`（follow）、`-p err`（按级别
  过滤）、`-b`（本次开机）、`--utc`。
- **保留策略得你自己设。** 默认情况下 journald 可能是易失的，或者被限制得很小，
  于是*旧日志恰好在你需要它们的时候被轮转掉*。在 `/etc/systemd/journald.conf` 里
  钉死它：

  ```ini
  [Journal]
  Storage=persistent
  SystemMaxUse=2G
  MaxRetentionSec=2week
  ```

  然后用 `journalctl --disk-usage` 看现实，用
  `journalctl --vacuum-time=2week` 回收。这和我写过的
  [小规模服务器监控](/zh/posts/monitoring-a-small-fleet/) 里那个磁盘压力问题是
  同一个——日志是其中安静的贡献者。
- **限流。** 突发时 journald 会丢弃消息（默认大致每个服务 30 秒 1 万条），而且
  只会通过一条 `Suppressed N messages` 告诉你。如果你在循环里逐行记日志，你会
  恰好丢掉你想要的那些行。调 `RateLimitIntervalSec`/`RateLimitBurst`，或者更好
  的——别在循环里记。

如果你需要一个真的作为 journald 字段存在的 correlation id（这样就能
`journalctl CORRELATION_ID=8f3c...`），那就通过原生协议发出它——Python 那边用
`systemd.journal`，C 那边用 `sd_journal_send`，或者服务里加一行
`LogExtraFields=`。否则 `-o json | jq` 就够用，而且更便宜。

## 采样与成本

日志在三处花钱：**磁盘**（因而也是保留期）、应用里的 **CPU**，以及一运出去就开始
算的**出网流量**。本能是全记下来。正确的做法是只留有用的那部分。

- **错误和警告永远保留。** 它们便宜且稀有；绝不要把它们采样掉。
- **对 `info` 和 `debug` 按速率采样，而不是逐行随机。** 逐行随机采样会把一个请求
  打散成半记录的若干状态。更偏好「凡是 `duration_ms > 500` 的请求都记」，或在
  高流量路径上固定 1/N。
- **限制基数。** 别把 `user_id` 放进 metrics label，也别为每条代码路径记一个不同
  的 `msg`——两者都会炸掉你的聚合账单。
- **能聚合就在应用里聚合。** 一个计数器加每分钟一条汇总行，胜过一百万条没人读的
  日志。

一个粗略的目标：如果你养不起留 14 天的量，那是采样还不够。

## 同一件事在 Python、Go、Node 里长什么样

你不用手写 JSON。每套生态都有一个日志器替你干这事，并帮你管好级别和上下文。

**Python**——`structlog`，给你键/值式调用和按请求的上下文：

```python
import structlog, contextvars, uuid, time

structlog.configure(processors=[
    structlog.contextvars.merge_contextvars,
    structlog.processors.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

def handle(request):
    structlog.contextvars.bind_contextvars(
        request_id=request.headers.get("X-Request-ID", uuid.uuid4().hex))
    t0 = time.perf_counter()
    log.info("request start", route=f"{request.method} {request.path}")
    try:
        result = do_work(request)
        log.info("request done", status=200,
                 duration_ms=round((time.perf_counter() - t0) * 1000))
        return result
    except UpstreamTimeout as e:
        log.error("charge failed", status=502, err=str(e), upstream="stripe")
        raise
```

**Go**——标准库的 `log/slog`（1.21+）加一个 JSON handler，零依赖：

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"time"
)

func main() {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	log := slog.New(h)

	ctx := context.WithValue(context.Background(), "request_id", "8f3c1d2e")
	t0 := time.Now()
	log.InfoContext(ctx, "request done",
		"request_id", ctx.Value("request_id"),
		"route", "POST /charge",
		"status", 200,
		"duration_ms", time.Since(t0).Milliseconds())
}
```

**Node**——`pino`，默认就快、默认就 JSON，用 child logger 携带上下文：

```js
import pino from "pino";

const base = pino({ level: process.env.LOG_LEVEL ?? "info" });

export function handle(req, res) {
  const log = base.child({ request_id: req.headers["x-request-id"] ?? crypto.randomUUID() });
  const t0 = performance.now();
  log.info({ route: `${req.method} ${req.url}` }, "request start");
  res.on("finish", () =>
    log.info({ status: res.statusCode, duration_ms: Math.round(performance.now() - t0) },
      "request done"));
}
```

三套 API，一个输出形状：一行一个 JSON 对象，字段名都一样。这份一致正是全部意义
所在——你的 `jq` 查询、你的告警、你的 grep 习惯，在三种语言之间、在机器之间都通
用。如果你想更广地逛一圈这些语言在基础设施活上长什么样，我那份
[用 Go 写网络工具](/zh/posts/go-for-network-tools/) 笔记和
[load average](/zh/posts/linux-load-average/) 那篇，都靠的是同一套「小工具、可读
输出」的直觉。

## 一句话总结

Print 给人讲故事；**结构化日志**给机器讲事实。把常量放进 `msg`，把变量放进字段，
给每个请求一个 **correlation id**，让 error 行保持稀有而诚实，永远别记密钥和载荷，
把磁盘交给 **journald**，需要时用 `-o json` 去查。做到这些，凌晨三点就不再是一场
猜谜。
