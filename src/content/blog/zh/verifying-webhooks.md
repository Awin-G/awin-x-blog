---
title: "验证 webhook：HMAC 签名、replay attack 与所有人都会犯的错误"
description: "如何正确地 verify webhooks：用 HMAC-SHA256 对原始 body 加时间戳签名、设置重放窗口、恒定时间比较、密钥轮换、快速回 2xx，以及幂等处理——附真实签名、真实拒绝，和那个能说明为什么不能用 == 的计时侧信道。"
pubDate: 2026-12-23
lang: zh
translationKey: verifying-webhooks
tags: [security, devops]
featured: false
keywords:
  - verify webhooks
  - HMAC 签名（HMAC signature）
  - webhook 安全（webhook security）
  - 重放攻击（replay attack）
  - 恒定时间比较（constant-time comparison）
---

Webhook 是那种你既必须信任、又无法信任的请求：它**从公网到达，没有任何 session**。没有 cookie，没有 bearer token，没有已登录的用户——只有一个 POST 打到一个按定义就是公开可达的 URL 上。挡在你这个端点和任何知道这个 URL 的人之间的，只有对 payload 计算的 **HMAC 签名**。如果你不 **verify webhooks**，那么每一条伪造的 `invoice.paid` 都和真的无从区分。这不是某类假设性的 **webhook 安全**问题，它就是未签名端点的默认状态，而且距离一次 **replay attack** 只差一行代码。下面是我在用的规范方案、我在 code review 里反复看到的错误，以及一段能真实拒绝被篡改、被伪造、被重放的投递的代码。

<figure>
<svg viewBox="0 0 780 300" width="100%" role="img" aria-label="发送方对时间戳和原始 body 计算 HMAC-SHA256 签名，并把它作为请求头附上。payload 穿过不可信的网络，攻击者可能篡改它。接收方重新计算 HMAC 并做恒定时间比较：有效且新鲜的签名被接受，被篡改的被拒绝。">
  <defs>
    <marker id="wh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" opacity="0.5" stroke-width="1.5">
    <rect x="10" y="70" width="216" height="150" rx="10"/>
    <rect x="556" y="46" width="214" height="206" rx="10"/>
    <path d="M226 122 H300" marker-end="url(#wh-arrow)"/>
    <path d="M432 122 H556" marker-end="url(#wh-arrow)"/>
    <path d="M366 34 V96" marker-end="url(#wh-arrow)" stroke-dasharray="5 4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="118" y="94"  text-anchor="middle" font-weight="600">发送方</text>
    <text x="118" y="118" text-anchor="middle" font-size="12">持有密钥 K</text>
    <text x="118" y="142" text-anchor="middle" font-size="11" opacity="0.8">HMAC-SHA256(K, ts + "." + body)</text>
    <text x="118" y="168" text-anchor="middle" font-size="11" opacity="0.8">X-Timestamp: 1791801138</text>
    <text x="118" y="188" text-anchor="middle" font-size="11" opacity="0.8">X-Signature-256: sha256=…</text>

    <text x="366" y="26" text-anchor="middle" font-size="11" opacity="0.85">攻击者：4200 → 420000</text>
    <text x="366" y="122" text-anchor="middle" font-size="12" opacity="0.85">网络</text>
    <text x="366" y="140" text-anchor="middle" font-size="11" opacity="0.65">（不可信）</text>

    <text x="663" y="70"  text-anchor="middle" font-weight="600">接收方</text>
    <text x="663" y="94"  text-anchor="middle" font-size="11" opacity="0.8">对 ts + "." + 原始 body 重算</text>
    <text x="663" y="114" text-anchor="middle" font-size="11" opacity="0.8">hmac.compare_digest(…)</text>
    <text x="663" y="134" text-anchor="middle" font-size="11" opacity="0.8">abs(now - ts) ≤ 300s</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <rect x="576" y="150" width="174" height="34" rx="6" stroke="#0f766e" fill="none"/>
    <text x="663" y="172" text-anchor="middle" fill="#0f766e" font-weight="600">202 接受，入队</text>
    <rect x="576" y="196" width="174" height="34" rx="6" stroke="currentColor" fill="none" opacity="0.6"/>
    <text x="663" y="218" text-anchor="middle" fill="currentColor" opacity="0.8">401 被篡改 / 过期</text>
  </g>
</svg>
<figcaption>整套方案一张图：对时间戳和原始 body 签名，把签名作为请求头发出；另一端用恒定时间重算，并检查时钟。没有密钥的攻击者无法构造出能通过重算的签名。</figcaption>
</figure>

## 为什么 webhook 需要签名——没有 session 可以依靠

系统里其它每一个已认证的请求都有上下文：session cookie、`Authorization` 头、mTLS、IP 白名单。webhook 这些一个都没有。服务提供方不是你的用户，它无法登录。端点必须能从公网访问，所以"谁在调用"从构造上就是未知的。

如果你跳过验证，攻击就简单到不需要任何技巧：从日志或配置不当的面板里读到那个 URL，然后 POST 一条 `{"event":"invoice.paid","amount":999999,"id":"evt_forged"}`。你的处理程序根本分辨不出它和真的有什么区别。签名把"信任调用方"换成了"信任一个只有提供方和我持有的密钥"——这就是安全模型的全部。当年我在[逆向一个私有 API](/zh/posts/reverse-engineering-a-private-api/) 时，理解任何一个集成最快的路径就是看它信任什么；未签名的 webhook 端点就是最响亮的例子。

## 如何用对原始 body 的 HMAC 签名来 verify webhooks

我在所有地方用的方案就是一行 HMAC-SHA256：

```
signed_payload = str(timestamp) + "." + raw_body
signature      = HMAC_SHA256(secret, signed_payload)      # 32 字节，以 hex 发送
X-Timestamp:    1791801138
X-Signature-256: sha256=4c52fba9b7349d46f88d63a27636f4b7ba3feb70e1effb9b8339dceea0a358d7
```

接收方精确地重算这一行然后比较。只做这一步的接收方，就已经能防住伪造和篡改。下面是发送方签名、验证方校验的真实输出：

```python
import hmac, hashlib, json, time

SECRET = b"whsec_local_demo_9f2c4a1e"

def sign(secret, timestamp, body):
    return hmac.new(secret, str(timestamp).encode() + b"." + body,
                    hashlib.sha256).hexdigest()

body = json.dumps({"event": "invoice.paid", "id": "evt_7Qa2",
                   "amount": 4200, "currency": "usd"},
                  separators=(",", ":")).encode()
ts = int(time.time())

print("body           :", body.decode())
print("X-Timestamp    :", ts)
print("X-Signature-256: sha256=" + sign(SECRET, ts, body))
```

```text
body           : {"event":"invoice.paid","id":"evt_7Qa2","amount":4200,"currency":"usd"}
X-Timestamp    : 1791801126
X-Signature-256: sha256=12a461c94d2e77437f16c90561d3e1ac3a757043b668069bb92b3687eed8c5c0
```

### 要对原始字节做 HMAC，不要对重新序列化的 JSON

这是所有人都会犯的错误，而且在生产之前它一直隐形。你的框架把 JSON 解析成 dict，然后验证方在哈希之前做了 `json.dumps(parsed)`。但 `json.dumps` 并不是发送方序列化器的逆运算：它会重排或去掉空白、改变数字格式、对 `/` 的转义方式也可能不同。同一个 JSON *值*变成了不同的*字节*，于是 HMAC 不一致，你拒绝了合法流量——更糟的是，你可能为了"修好它"而干脆关掉验证。

```python
raw = b'{"amount": 4200, "currency": "usd", "id": "evt_7Qa2"}'   # 到达时的原样字节
sent_sig = sign(SECRET, ts, raw)

reserialized = json.dumps(json.loads(raw), separators=(",", ":")).encode()
print("raw wire bytes   :", raw)
print("re-serialized    :", reserialized)
print("match re-serialized?", hmac.compare_digest(sent_sig, sign(SECRET, ts, reserialized)))
print("match raw?          ", hmac.compare_digest(sent_sig, sign(SECRET, ts, raw)))
```

```text
raw wire bytes   : b'{"amount": 4200, "currency": "usd", "id": "evt_7Qa2"}'
re-serialized    : b'{"amount":4200,"currency":"usd","id":"evt_7Qa2"}'
match re-serialized? False
match raw?           True
```

规则是绝对的：在任何解析器碰它之前，先拿到**原始 body**。在 Express 里，把 raw-body 中间件挂到 webhook 路由上，并且要排在 `express.json()` *之前*。在 FastAPI/Starlette 里读 `await request.body()`。如果某个框架只给你解析后的对象，就确认原始字节是否仍然暴露——如果没有暴露，那是换框架的理由，而不是放松校验的理由。

## 只对 body 签名挡不住的 replay attack

只对 body 签名是确定性的：同一个 body 永远产生同一个签名。这对完整性没问题，对新鲜度毫无用处。捕获到一个有效请求的攻击者——从共享日志、代理、或者有 bug 的客户端——可以把那串字节重发一千次，每一次都能通过只校验 body 的检查。这就是 **replay attack**，缓解办法是把时间戳放进被签名的 payload 里，并强制一个窗口：

```
if abs(now - timestamp) > 300: return 401      # 5 分钟重放窗口
```

因为时间戳是签名的一部分，攻击者无法在不使 HMAC 失效的情况下把它改到未来。真实的拒绝结果，其中包括一个签名完全正确但已过十分钟的请求：

```text
verify(secret, ts, body, sig)                 -> True   # accepted: signature valid, timestamp fresh
verify(secret, ts, tampered, sig)             -> False  # rejected: signature mismatch
verify(attacker_secret, ts, body, sig)        -> False  # rejected: signature mismatch
verify(secret, old_ts, body, old_sig)         -> False  # rejected: timestamp 1791800526 outside 300s window
```

窗口要收紧——5 分钟已经很宽裕了，Stripe 的默认值也是 5 分钟。窗口是一条*边界*，不是保证：在窗口内，被捕获的请求仍然可以被重放，这恰恰是处理程序也必须幂等的原因（见下文）。如果你想要严格的新鲜度，就往被签名的 payload 里加一个 `nonce`，并拒绝见过的值，但共享缓存增长很快——有了事件 id 去重，通常就不必要了。

## 恒定时间比较，否则你的比较会泄露密钥

`expected_signature == received_signature` 看起来无害，但它是一条侧信道。字符串相等会在第一个不同的字节处短路，所以匹配了 64 个 hex 字符中 60 个的比较，会明显比第一个字节就不同的比较更慢。采样足够多，攻击者就能在不持有密钥的情况下，一个字节一个字节地还原出有效签名。我在这台机器上用一个朴素逐字节循环对比 `hmac.compare_digest` 做了实测：

```text
naive  ==  differs at byte 0 :   496.9 ns/op
naive  ==  differs at byte 63:  4169.5 ns/op   (early-exit leaks the match length)
compare_digest byte 0       :   173.5 ns/op
compare_digest byte 63      :   174.4 ns/op   (flat: no timing signal)
```

8 倍的差距不是舍入误差，它是一个信号。`hmac.compare_digest` 的比较耗时只与长度成正比，所以同一次比较的代价始终一样。用它——或者 Node 里等价的 `crypto.timingSafeEqual`、Go 里的 `subtle.ConstantTimeCompare`——在每一个比较 MAC、token 或密码哈希的地方都用。绝不要用 `==`，绝不要用 `strcmp`，绝不要在密钥上用 `.equals()`。

## 密钥管理与轮换

密钥就是整个安全模型，所以要像对待安全模型一样对待它：

- **每个端点一个密钥（并区分 provider 环境）。** 跨集成共用密钥，意味着一个地方泄露就在所有地方获得伪造能力。
- **来自 CSPRNG 的 32 字节**，hex 或 base64。绝不用口令，绝不从 URL 派生。
- **绝不写进代码或 git。** 启动时从环境或密钥管理器加载。日志才是常见的泄露点：绝不要记录 `Authorization`、`X-Signature-256` 的值或密钥本身。
- **带重叠期地轮换。** 瞬间换钥匙的轮换会丢掉正在途中的投递。同时支持*两个*有效密钥：对两个都验证，对外用新的签名，在提供方的重试窗口过去之后（一天很安全）再退役旧的。Stripe 之所以让你同时看到新密钥和旧密钥，正是为了这个。

## 快速响应：验证、入队、ack

webhook 发送方超时很短，任何慢的或非 2xx 的响应都会触发重试。如果你的处理程序在回复前要调三个 API、写两个数据库，那么一个慢依赖就会把一次投递变成一场重试风暴——而重试就是重复。在请求路径上只做最少的几件事：

1. **验证**签名和时间戳。
2. 按事件 id **去重**（幂等）。
3. 把 payload **入队**到一个队列或任务表。
4. 立刻用 `2xx` **ack**；真正的工作异步去做。

如果验证失败，返回 `401` 并且*不要*处理——但要刻意为之：`4xx` 会告诉发送方这次投递注定失败、从而停止重试，这正是你对伪造或过期请求想要的结果。下面是对一个本地验证器的真实往返：

```text
valid request                      -> 202 accepted evt_7Qa2, queued
tampered body                      -> 401 bad signature
replay (10 min old)                -> 401 stale timestamp
duplicate delivery (same id)       -> 200 duplicate evt_7Qa2 ignored

queue after all four: ['evt_7Qa2']
```

注意四次投递之后队列里只有一个事件：强制校验发生在边缘，而昂贵的工作只跑了一次。

## 幂等性：webhook 会被投递不止一次

webhook 投递按设计就是 **at-least-once**。提供方在超时、非 2xx，有时甚至它自己内部抖动时会重试，所以同一个事件会到你这里两次。你的处理程序必须让第二次投递变成 no-op。最简单可靠的键就是提供方的 event id：维护一张已处理 id 的表，见过就跳过。把它按端点划分作用域，TTL 设得比重试窗口更长（24 小时是个不错的默认值），并且让插入本身成为锁，这样两个同时到达的投递不可能都往下走。这与 [idempotency keys](/zh/posts/idempotency-keys/) 是同一套推理，只是应用在一条你不掌管其入向的流上。

## 一份清单和一个参考 verify 函数

在上线一个 webhook 端点之前：

- 用 HMAC-SHA256 对 `timestamp + "." + raw_body` 签名；以 `X-Signature-256: sha256=<hex>` 加上 `X-Timestamp` 发出。
- 对**原始字节**做 HMAC；验证前绝不重新序列化 JSON。
- 对被签名的时间戳强制一个**重放窗口**（≤ 300 秒），只容忍几秒的时钟偏差。
- 用**恒定时间**的比较函数；绝不用 `==`。
- 把密钥挡在代码和日志之外；为轮换支持**两个有效密钥**。
- 按顺序 **验证 → 去重 → 入队 → ack 2xx**；真正的工作放到请求路径之外。
- 让处理程序按事件 id **幂等**；带 TTL 地存储它。
- 响亮地拒绝坏签名（`401`）并统计它们——出现尖峰是攻击，不是噪声。

我脑子里常备的参考实现，Python：

```python
import hmac, hashlib, time

def verify_webhook(secret: bytes, raw_body: bytes, headers,
                   window: int = 300, now: int | None = None) -> bool:
    now = int(time.time()) if now is None else now
    ts_header = headers.get("X-Timestamp")
    sig_header = headers.get("X-Signature-256", "")
    if not ts_header or not sig_header:
        return False
    try:
        ts = int(ts_header)
    except ValueError:
        return False
    if abs(now - ts) > window:                       # 重放窗口
        return False
    expected = hmac.new(secret, str(ts).encode() + b"." + raw_body,
                        hashlib.sha256).hexdigest()
    received = sig_header.removeprefix("sha256=")    # 容忍或强制这个前缀
    return hmac.compare_digest(expected, received)   # 恒定时间
```

同一件事的伪代码，与框架无关：

```
verify(secret, request):
    ts  = request.header["X-Timestamp"]
    sig = request.header["X-Signature-256"] strip "sha256="
    if ts is missing or sig is missing: return REJECT(400)
    if abs(now() - int(ts)) > 300:        return REJECT(401)   # 重放
    body = request.raw_body                                    # 不是解析后的
    expected = hex(HMAC_SHA256(secret, str(ts) + "." + body))
    if not constant_time_equal(expected, sig): return REJECT(401)
    if event_id_already_seen(body):  return ACK(200, "duplicate")
    remember(event_id_of(body), ttl=24h)
    enqueue(body)
    return ACK(202, "accepted")
```

## 我现在怎么做

- 每个 webhook 端点都对 `timestamp + "." + raw_body` 验证 HMAC 签名，原始字节在任何解析器运行之前抓取。
- 对被签名的时间戳设 5 分钟重放窗口，只容忍几秒的时钟偏差。
- 在每一个 MAC、token 或哈希与值相遇的地方都用恒定时间比较——没有例外。
- 每个端点一个 32 字节密钥，从密钥管理器加载，可用两个有效密钥轮换。
- 验证、按事件 id 去重、入队、几毫秒内 ack `2xx`；重活放在别处跑。
- 处理程序写成幂等的，因为投递是 at-least-once，而且永远都会是。

这些都不稀奇。一个未签名的 webhook 就是一次对你系统的无认证写入，而修复它只需要几行大多数团队都会跳过的代码——因为在 happy path 上它"能跑"。对原始字节签名、检查时钟、恒定时间比较、快速 ack——于是伪造和重放 webhook 这一整类问题就不再可能了。
