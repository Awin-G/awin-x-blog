---
title: "幂等键：用真实的翻车案例讲清楚（API 重试安全指南）"
description: "从双扣款、重复记录讲起：为什么网络必然带来重试、客户端永远无法确定请求是否成功、至少一次投递让端到端精确一次成为幻觉，以及一套能扛住并发、会重放已存结果的幂等键服务端实现和常见错误。"
pubDate: 2026-11-10
lang: zh
translationKey: idempotency-keys
tags: [devops, self-hosting, python]
featured: false
keywords:
  - 幂等键
  - 幂等 API
  - 重试安全
  - 至少一次
  - 精确一次
---

我第一次因为这个 bug 亏钱的时候，其实没搞懂发生了什么。一个支付请求超时了，我的代码重试了它，于是客户被扣了两次款。日志里没有任何异常：两个请求都成功了。服务器老老实实照着指令做了两遍——因为我从来没告诉它，这两个请求本来就是同一个。这就是**幂等键**存在的全部意义：一个**幂等 API** 把「我可能会发两次」变成「发两次和发一次的效果相同」。没有它，**重试安全**就是幻觉，而**至少一次**投递会悄无声息地变成重复写入。

## 这一类 bug：重试的请求被扣两次款

- 支付超时，客户端重试，客户被扣两次。
- 注册表单重复提交，同一个邮箱留下了两条用户记录。
- 任务队列重新投递了一条消息，于是同一个订单发了两遍货。

每一次，请求本身格式正确，服务器逻辑也没错，结果却仍然是错的。问题不在任何一个请求里，而在两个请求之间的那段空隙——系统忘了「两个一模一样的请求本该是一次操作」。而且它只在网络打嗝 **之后** 才浮现，那恰恰是你最承受不起重复的时候。

## 为什么网络必然带来重试——以及为什么重试安全必须落在服务端

让这个问题无法回避的真相有点扎心：**客户端无法可靠地知道一个请求到底成功了没有。**

从调用方的角度看，结果有三种，其中两种长得完全一样：

1. 服务器收到了请求、处理完，你拿到了 `200`。
2. 服务器收到了请求、处理完了，但响应在回来的路上丢了。
3. 服务器压根没收到请求。

第 2 种和第 3 种无法区分：你发了字节，没收到任何响应。面对「没有响应」，唯一合理的反应就是重试——如果是第 3 种，重试是对的；如果是第 2 种，重试恰好就是双重扣款。你分辨不出来，所以你重试，于是第 2 种变成了重复。

这不是 HTTP 的 bug，而是一个随时可能丢包的网络必然导致的后果。TCP 会替你重传*报文段*，但 TCP 完全不理解你的应用语义：它能告诉你一串字节到了，却没法告诉你「扣款」这件事只发生了一次。超时、连接重置、负载均衡器掐掉空闲连接，都会制造出同样的客户端歧义。

重试不是可选项。客户端会重试，队列会重投，负载均衡会重放——而且正如我在[逆向一个私有 API](/zh/posts/reverse-engineering-a-private-api/) 时发现的，快速重放请求很快就能教你认出：哪些接口已经把你正要创建的东西创建出来了。

## 幂等键模式：如何做一个幂等 API

解法是一份约定：客户端给一次操作贴上标签，服务器记住它。

### 客户端生成键

在客户端发出一条不能被重复的请求之前，它生成一个唯一键——通常是 UUIDv4——放进请求头：

```
POST /v1/charges
Idempotency-Key: 8f14e45f-ea0b-4c1d-9a2e-2f3b6c7d8e9f
Content-Type: application/json

{"amount": 4200, "currency": "usd", "customer": "cus_123"}
```

这个键标识的是*这一次尝试*，而不是这个请求。重试时发的是**同一个**键；想要一笔真正的新扣款，就发一个新键。整个接口就这么点东西：客户端改一个请求头，不用动重试逻辑。但键必须在第一次尝试之前生成一次，并在所有重试中保持不变——每次尝试都重新生成一个键，看着像一道防线，其实什么都保护不了。

### 服务器存下 键 → 结果 并重放它

在服务器端：

1. 从请求头读出键。
2. 到存储里查它。
3. 如果已存在**且操作已经结束**，原样返回存下来的响应——同样的状态码，同样的响应体。不要再跑一遍操作。
4. 如果已存在**且操作还在进行中**，返回 `409 Conflict`（或者等待），让调用方不要往上堆任务。
5. 如果不存在，把键记成 `in_progress`，执行操作，存下最终状态码和响应体，再返回。

第 3 步是核心：这次重试不是被*处理*了，而是被*回答了*。

### 给键划定作用域

一个键孤立地看没有意义。把它限定在**账户或商户**（这样一个租户不会和另一个撞车，也不会把结果泄露到别的租户）、**接口**（`POST /charges` 和 `POST /refunds` 即使拿到同一个键，也不该共用一个命名空间），以及一个**时间窗口**。我用的是 `(account_id, endpoint, key)`。如果只用键本身做作用域，两个不同的客户就会撞车，第二个被重放了一个属于第一个的结果——一个伪装成特性的数据泄露。

### 处理并发重复

人们最容易忘的情况是：两个请求带着同一个键同时到达——重复提交，或者客户端在第一个请求还在飞行途中就重试了。如果逻辑是「先查、再插」，两个请求都没查到、都执行了，于是你又回到了双扣款。让插入本身成为那把锁：用唯一约束（或者 `INSERT ... ON CONFLICT DO NOTHING`，或者 Redis 的 `SET NX`），保证只有一个请求能*占住*这个键。输的那个发现键已存在、状态是 `in_progress`，就返回冲突，而不是去干活。这里的**并发**是正确性问题，不是性能问题——一个「先检查再执行」的幂等实现，就是一个多绕了几步的竞态条件。

## 幂等既不是重试，也不是至少一次

这三个词经常被混着用，但它们不是一回事。

- **重试**是客户端行为，被不可靠的网络逼出来的。它本身恰好*制造*了重复问题。
- **至少一次**是投递保证。队列和 webhook 承诺每条消息*至少*到达一次——也就是说，它们可能投递不止一次。它们对网络是诚实的，但没承诺没有重复。
- **幂等**是服务器属性：同一个操作应用两次，效果等于应用一次。正是它让至少一次投递变得*可用*。

那**精确一次**呢？作为一个跨越不可靠网络的端到端保证，它不存在。你可以通过「至少一次投递 + 幂等消费者」构造出精确一次的*效果*——也就是至多一次的副作用。这才是诚实的版本：不是一种传输保证，而是叠加在至少一次之上的去重层。谁要是卖给你一个真正的网络端到端精确一次投递，他卖的其实是「至少一次加幂等」的另一个名字。别再想着阻止重试了，把操作本身变得可以安全重复。

## 键存在哪，存多久

存储必须在所有实例之间共享、在重启之后仍然存在，并且能强制上一节提到的唯一性。

- **关系型数据库表**是默认选项：它顺带给了你唯一约束，还能和业务写入放进同一个事务。
- **Redis**适合用 `SET key value NX EX ttl` 做占位，再加一份存下来的结果——它快，但它是缓存，所以要假设数据可能丢。
- **进程内内存**是错的：跑两个实例它就崩，部署一次它就没了。

保留时长是一个权衡。太短，迟到的重试——队列过了一个小时又重投、手机客户端一夜之后重连——会在键已经消失之后到达，于是把活儿重复做一遍。太长，表会无限增长。一个合理的默认值是 **24 小时**，和任何客户端被允许的最长重试窗口对齐。Stripe 的公开行为在这里是常被引用的参考点：键只在一个有界窗口内被记住，而且用**不同的请求体**复用同一个键是错误，不是静默重放。这条规则逮住客户端 bug，而不是把 bug 藏起来。同一个请求得到同一个答案；同一个键下面是不同的请求，就值得被拒绝。

## 让我真正浪费过时间的几个错误

下面每一个，我都上线过。

- **键不唯一。** 用请求体推导键（`hash(payload)`）看着挺聪明，直到两笔合法的、完全相同的请求——两杯咖啡，同样的金额，同一秒——被压成了一次扣款。键必须标识*这次尝试*，而不是*内容*。
- **什么都没存。** 发送键只是简单的那一半。如果服务器从不持久化它，这个键就是装饰品——我见过有的客户端往一个完全忽略它的接口上发了几个月的 `Idempotency-Key` 头。
- **把 GET 当成不安全的。** `GET` 和 `HEAD` 按定义就是安全且幂等的，不该有副作用。如果你的 `GET /orders/42` 会创建东西，那这个方法本身在撒谎，什么键也救不了你。反过来，也别硬给读请求塞键——那是徒增仪式感。
- **忘了在响应里带上键。** 如果存下的响应不回显这个键（或者资源 ID），客户端就没法把一次重试和原始结果对应起来。把它回显出去——这能让调试一次重复提交变得轻而易举，而不是像做取证。

## 一份小小的服务端实现

下面是我用的形式，Python。存储是一张带唯一约束的表；占位就是那把锁。

```python
import json, uuid, hashlib
from datetime import datetime, timedelta

class IdempotencyStore:
    """One row per (account, endpoint, key). Unique constraint = the lock."""

    def claim(self, account_id, endpoint, key, request_fingerprint):
        # INSERT ... ON CONFLICT DO NOTHING RETURNING id
        # Returns a row only if WE won the race; None if someone else holds it.
        row = self.db.execute(
            """
            INSERT INTO idempotency_keys
                (account_id, endpoint, key, fingerprint, state, created_at)
            VALUES (%s, %s, %s, %s, 'in_progress', now())
            ON CONFLICT (account_id, endpoint, key) DO NOTHING
            RETURNING id
            """,
            (account_id, endpoint, key, request_fingerprint),
        ).fetchone()
        return row is not None  # True = we own the operation

    def load(self, account_id, endpoint, key):
        return self.db.execute(
            """SELECT state, fingerprint, status_code, body
               FROM idempotency_keys
               WHERE account_id=%s AND endpoint=%s AND key=%s""",
            (account_id, endpoint, key),
        ).fetchone()

    def finish(self, account_id, endpoint, key, status_code, body):
        self.db.execute(
            """UPDATE idempotency_keys
               SET state='done', status_code=%s, body=%s, finished_at=now()
               WHERE account_id=%s AND endpoint=%s AND key=%s""",
            (status_code, json.dumps(body), account_id, endpoint, key),
        )
```

以及使用它的请求处理器：

```python
def create_charge(req):
    key = req.headers.get("Idempotency-Key")
    if not key:
        return error(400, "Idempotency-Key required")

    account_id = req.account.id
    endpoint = "POST /v1/charges"
    fingerprint = hashlib.sha256(req.raw_body).hexdigest()

    # 1. Is this key already known?
    existing = store.load(account_id, endpoint, key)
    if existing:
        if existing.fingerprint != fingerprint:
            return error(422, "Idempotency-Key reused with different body")
        if existing.state == "in_progress":
            return error(409, "Request with this key is still in progress")
        # Replay the original result. Do NOT run the charge again.
        return Response(existing.status_code, existing.body)

    # 2. Try to claim it. If we lose the race, someone else is doing the work.
    if not store.claim(account_id, endpoint, key, fingerprint):
        return error(409, "Request with this key is already being processed")

    # 3. We own it. Run the operation exactly once, inside the same
    #    transaction as the business write where possible.
    try:
        result = charge_card(req.json)          # the side effect
        store.finish(account_id, endpoint, key, 201, result)
        return Response(201, result)
    except Exception:
        # A failure that did not commit should free the key so a retry
        # can make progress. A failure *after* commit must not.
        store.release(account_id, endpoint, key)
        raise
```

安全性主要靠两个细节。`ON CONFLICT DO NOTHING` 让并发的重复收敛成一个赢家，而不是两次扣款。而指纹检查把「同一个键、不同请求」这种客户端 bug 变成一个响亮的 `422`，而不是一次静默的错误重放。

## 我现在实际会做的事

- 在客户端生成键，一次，在第一次尝试之前，并在所有重试中保持不变。
- 在服务器上存下 `键 → (状态码, 响应体)`，按账户和接口划定作用域，用唯一约束当锁。
- 遇到重复时重放已存的结果，而不是重跑操作。
- 对还在进行中的键返回 `409`；绝不在同一个键上堆任务。
- 键只保留一个有界的窗口——我用 24 小时——并且拒绝用不同请求体复用同一个键。
- 接受**至少一次**才是投递模型，在此之上构建幂等消费者，而不是去追逐一个网络层并不存在的**精确一次**。

这些都不聪明——它只是一点点纪律，把「被扣了两次款」这一整类事故从「可能发生」挪到「不可能发生」。无论那个接口是一笔支付还是一个自托管的服务，道理都一样，而后者我是这样维持的，见[2026 年自建了哪些服务](/zh/posts/what-i-self-host-2026/)。网络一定会把你的请求复制一遍。就按你知道这一点来设计。
