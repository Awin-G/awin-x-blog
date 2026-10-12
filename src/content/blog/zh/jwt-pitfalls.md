---
title: "后端开发者的 JWT pitfalls：签名、algorithm confusion 与吊销"
description: "一份务实的 JWT pitfalls 清单：签名不等于加密、为什么 JWT 不是 session 存储、algorithm confusion（RS256 被降级成 HS256）、alg none、盲信 exp/aud/iss、缺失的吊销方案、过期时间过长、localStorage 与 httpOnly cookie 的取舍，以及一套足够简单的 refresh token 设计。"
pubDate: 2026-11-18
lang: zh
translationKey: jwt-pitfalls
tags: [security, devops]
featured: false
keywords:
  - JWT 陷阱（JWT pitfalls）
  - JWT vs session
  - 算法混淆（algorithm confusion）
  - JWT 安全
  - refresh token
---

我调过足够多的认证系统，可以直说：真正咬人的 **JWT 安全**问题，很少是密码学本身坏了，而是有人对一个 token 的信任超过了它应得的程度。JWT 看起来很有权威感——三段整整齐齐的 base64url 加一个签名——而这份观感正是陷阱所在。它是一组被签名的声明，不是一包已被核实的事实，更绝对不是 session。大多数 **JWT pitfalls** 归根结底，就是把这三件事混为一谈，再加上在第一枚 token 铸出来之前谁都没做过的那个 **JWT vs session** 决策。下面这份清单，是我想递给每个后端团队的 code review：JWT 到底是什么、我反复看到的错误、一套简单的 refresh token 设计，以及什么时候最诚实的答案是干脆别用 JWT。

## JWT 到底是什么——以及它不是什么

JWT 是用点号连接起来的三段 base64url 字符串：`header.payload.signature`。

- **Header（头部）**——JSON，通常是 `{"alg":"RS256","typ":"JWT"}`。它只是*声称*用了哪个算法，并不能证明。
- **Payload（载荷）**——各种 claim：`sub`、`exp`、`aud`、`iss`，以及你塞进去的任何东西。
- **Signature（签名）**——用只有签发方持有的密钥，对前两段计算出来。

<figure>
<svg viewBox="0 0 660 200" width="100%" role="img" aria-label="JWT 是由点号分隔的三段 base64url：header、payload 与 signature。header 和 payload 任何人都能读；只有 signature 会用签发方的公钥去校验。">
  <defs>
    <marker id="jwt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="24" width="148" height="96" rx="8"/>
    <rect x="170" y="24" width="160" height="96" rx="8"/>
    <rect x="344" y="24" width="150" height="96" rx="8"/>
    <rect x="420" y="150" width="220" height="42" rx="8"/>
    <path d="M419 120 V150" marker-end="url(#jwt-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="82"  y="48"  text-anchor="middle">header 头部</text>
    <text x="82"  y="70"  text-anchor="middle" font-size="12" opacity="0.8">alg, typ</text>
    <text x="82"  y="98"  text-anchor="middle" font-size="11" opacity="0.7">任何人都能读</text>
    <text x="250" y="48"  text-anchor="middle">payload 载荷</text>
    <text x="250" y="70"  text-anchor="middle" font-size="12" opacity="0.8">sub, exp, aud, iss</text>
    <text x="250" y="98"  text-anchor="middle" font-size="11" opacity="0.7">任何人都能读</text>
    <text x="419" y="48"  text-anchor="middle">signature 签名</text>
    <text x="419" y="70"  text-anchor="middle" font-size="12" opacity="0.8">HMAC 或 RSA</text>
    <text x="419" y="98"  text-anchor="middle" font-size="11" opacity="0.7">唯一保密的部分</text>
    <text x="160" y="80"  text-anchor="middle" font-size="22" opacity="0.6">.</text>
    <text x="334" y="80"  text-anchor="middle" font-size="22" opacity="0.6">.</text>
    <text x="530" y="176" text-anchor="middle">用签发方公钥校验</text>
  </g>
</svg>
<figcaption>三段 base64url。谁拿到 token，谁就能读到 header 与 payload——唯有签名能防止它们被篡改。</figcaption>
</figure>

两个性质几乎决定了下游的一切：

1. **签名 ≠ 加密。** 签名证明的是*这些声明由谁写下、且没有被改动*，它跟保密毫无关系。任何拿到 token 的人——浏览器扩展、日志行、代理——都能读到里面每一条 claim。Base64 不是一把锁。
2. **JWT 不是 session 存储。** 服务端 session 删掉一行记录就能失效；JWT 却无法「撤回」：只要不过期，它在任何被出示的地方都有效。这正是 **JWT vs session** 取舍的核心——JWT 换来无状态校验，代价就是吊销。

接受这两点之后，那些经典错误就不再像边角情况，而像是它们的必然结果。

## Algorithm confusion 与其他经典 JWT pitfalls

### `alg: none`

有些库历史上会接受 `{"alg":"none"}` 这个头部，意思是「没有签名——直接信 payload」。这个 bug 的任何版本，都允许攻击者改一改 payload、删掉签名，凭空铸造任意身份。这就是为什么你**永远**不要让 *token* 自己决定用什么算法来校验。

### Algorithm confusion：RS256 → HS256

这是那个总往 CVE 列表里钻的家伙。服务端用 **RS256** 签名，并在 `/.well-known/jwks.json` 公布自己的 RSA 公钥。天真的校验方从 token 里读出 `alg`，然后把那个公钥交给库——可攻击者已经把头部改成了 `{"alg":"HS256"}`（HMAC）。HMAC 会把这个 key 当作共享密钥，而 RSA 的*公钥*是公开的，于是攻击者就能用它算出一个合法的 HMAC 签名。校验方照着 token 自己的指示办事，接受了这枚伪造 token。

修法在每个语言里都是一行：**在 verify 调用处把算法钉死，绝不从头部读它。**

```python
# 错——算法由 token 决定，也就等于由攻击者决定。
jwt.decode(token, PUBLIC_KEY, algorithms=["HS256", "RS256"])

# 对——只有一个算法，由服务端选定，再和头部比对。
jwt.decode(token, PUBLIC_KEY, algorithms=["RS256"])
```

### 根本不去校验签名

这是 `alg: none` 更隐蔽的兄弟：只解码，不校验。`jwt.decode(token, options={"verify_signature": False})` 只在测试或纯检查工具里才正当。放在请求处理路径上，它的意思就是「来什么 JSON 我都信」，等同于没有认证。在你的代码库里 grep 一下这个字符串；我在生产环境里不止一次找到过。

### 盲信 `exp`、`aud`、`iss`

校验了签名却忽略 claim，*几乎*安全，但仍然是错的：

- **`exp`** 必须被要求（require）并检查。一个只校验签名、不强制 `exp` 存在的库，会欣然接受一枚永不过期的 token。
- **`aud`**（受众）阻止一枚为你的计费服务签发的 token 被重放到管理 API 上。只要你跑的不止一个服务，就检查它。
- **`iss`**（签发方）阻止*别人家*的身份提供方签发的 token，仅因为碰巧共用一把 key 就被接受。
- **`nbf`**（生效时间）与时钟偏移：留几秒容差，不是几分钟。

```python
import jwt

PUBLIC_KEY = open("/etc/jwt/public.pem").read()

def verify(token: str) -> dict:
    return jwt.decode(
        token,
        PUBLIC_KEY,
        algorithms=["RS256"],              # 由服务端钉死
        audience="https://api.awin-x.top",  # 必填：拒绝其他服务
        issuer="https://auth.awin-x.top",   # 必填：拒绝其他签发方
        options={"require": ["exp", "iat", "aud", "iss"]},
        leeway=30,                          # 只容忍很小的时钟偏移
    )
```

### 把密钥和 PII 塞进 payload

因为 payload 可读，token 一泄露，里面的一切就跟着泄露——经由 Referer 头、被误记的请求、一张随手截的图。不要把 API key、你不愿公开的内部 ID、个人数据放进去。一个你不想在日志行里看到的东西，一定会出现在日志行里。

### 没有吊销方案

只有签名的 JWT 无法被吊销。一个只删掉本地 token 的「登出」，对攻击者早就抓到的那份拷贝毫无作用。如果你需要吊销——只要涉及钱、管理员权限，或者用户对「登出所有设备」有真实预期，你就需要——那就得引入服务端状态。最省事的版本是维护一份 `jti` 的拒绝名单直到其 `exp` 过期，而这恰恰就是你本想避开的 session 表，只是更糟。

### 过期时间过长

长 `exp` 是团队用来糊弄吊销之痛的最常见手段。一枚 30 天的 access token 就是 30 天的负债。把 access token 控制在 5 到 15 分钟，用 refresh token 去解决重新登录，而不是靠一个长命的 bearer 凭据。

### localStorage 还是 httpOnly cookie

token 存在哪里，决定了 XSS 漏洞会让你损失多少。

- **`localStorage`** 可被页面上的任何 JavaScript 读取。一个注入脚本、一个恶意依赖、一个坏掉的 `npm` 传递依赖——token 就出去了。对 SPA 很方便；等于长期押注「我永远不会有 XSS」。
- **`httpOnly` + `Secure` + `SameSite` cookie** 对 JavaScript 不可见，所以 XSS 没法直接读它。代价是 CSRF：cookie 会被自动发送，所以你要加上 `SameSite=Lax/Strict`，并对会改变状态的接口再加一个 CSRF token。那是一个边界清晰、已被吃透的问题；而「永远别有 XSS」不是。

如果把 access token 放在内存里、把 refresh token 放进 `httpOnly` cookie，你就能拿到两边的大部分好处——这也正是下一节要落地的方案。

## 先解码、先检查，再谈信任

检查和校验是两件不同的事，把它们混为一谈，正是坏 token 混进来的方式。解码是免费的、安全的，任何人都能做。

```bash
# 仅供检查。任何人都能跑，它证明不了任何真实性。
TOKEN="$1"
hdr=$(echo "$TOKEN" | cut -d. -f1 | tr '_-' '/+' )
pay=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' )
printf '%s' "$hdr" | base64 -d 2>/dev/null | jq .
printf '%s' "$pay" | base64 -d 2>/dev/null | jq '{sub, exp, aud, iss, scope}'
```

```python
import base64, json

def decode_part(part: str) -> dict:
    # base64url 没有 padding；解码前先补回来。
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))

header, payload, _sig = token.split(".")
print(decode_part(header))   # -> {"alg": "RS256", "typ": "JWT"}
print(decode_part(payload))  # 任何人都能读——所以什么都别放秘密
```

用它来调试、用肉眼核对 `exp`、`aud`、`iss`。不要用它来给任何东西授权。只有走签名的校验路径，才能为一个请求授权。

## Refresh token，做得简单一点

refresh token 的意义，是让 access token 保持短命，又不至于让用户每十分钟登录一次。refresh token **不是**一枚塞进同样地方的 JWT——它是一个不透明的、随机的、一次性的凭据，由服务端去查表，这恰好白送你吊销能力。

- **不透明且随机**——用 CSPRNG 生成 32 字节，不要任何自包含的 token。
- **落库前先哈希**——像对待密码一样只存哈希（见 [password hashing](/zh/posts/password-hashing/)）；数据库泄露不该等于交出所有活跃会话。
- **每次使用都轮换**——客户端每次都拿到一枚新的 refresh token，旧的作废。
- **复用检测**——如果一枚*已用过*的 token 又被出示，说明它被偷了；把整个轮换家族全部杀掉。

```sql
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  token_hash bytea NOT NULL,          -- 不透明 token 的 sha256，绝不存 token 本身
  family_id  uuid NOT NULL,           -- 每次登录一个家族，用于复用检测
  expires_at timestamptz NOT NULL,
  used_at    timestamptz              -- 已用过的行被第二次使用 = 被偷
);
```

流程：登录时返回一枚短命的 access token，外加一枚放在 `httpOnly` cookie 里的 refresh token。过期时，客户端调用 `POST /auth/refresh`；服务端把收到的 token 哈希后，找到一条有效且未使用的记录，标记为已用，再签出一对同一家族的新 token。access token 保持无状态；只有 refresh 这条路径碰数据库，每个用户每十五分钟一次——很便宜。而因为它会改变状态，当客户端抽风重试时，refresh 接口正是适合上 [idempotency key](/zh/posts/idempotency-keys/) 的地方。

## 什么时候该跳过 JWT，改用不透明 session

**JWT vs session** 不是信仰问题，而是「无状态」与「可吊销」之间的一次取舍；如果你并不需要无状态，那么 session 直接胜出。

在下面这些情况下，选**服务端的不透明 session**：

- 你只有一个后端，每个请求本来就要碰数据库。一个随机 cookie 加一张 `sessions` 表，比 JWT 更简单，而且能瞬间吊销。
- 「登出所有设备」、管理员封禁、改密后使旧会话失效，都是硬需求。session 用一条 `DELETE` 就搞定；JWT 得靠拒绝名单，把你想避开的那个状态又请回来。
- 你只想要最安全又最简单的东西。不透明 session 的锋利边缘更少，坑也更少。

在下面这些情况下，选 **JWT**，因为它独有的长处是真的：

- 许多独立服务要在不共享 session 查询的情况下校验 token；交给第三方的短命凭据；或者一个够不着数据库的无状态边缘节点。
- 即便如此，也要让它们短命，并搭配不透明、可吊销的 refresh token。

## 如果你非用 JWT 不可：一张清单

- 在**服务端**钉死算法，只留一个值，绝不从头部读 `alg`。
- 拒绝 `alg: none`，并拒绝任何头部算法与你预期不符的 token。
- 要求（require）`exp`、`aud`、`iss`，并逐一校验。时钟容差给几秒，不是几分钟。
- 绝不放秘密或 PII 进 payload。它是可读的；review 时把这句话念出来。
- access token 以分钟计。把 refresh token 放进 `httpOnly`、`Secure`、`SameSite` cookie，轮换它，并检测复用。
- 必须有一条吊销路径——最低限度是一份 `jti` 拒绝名单，实际做法是落库的不透明 refresh 行。
- 如果你的「登出」只是删掉客户端状态，那你并没有吊销。
- 如果你只有一个服务加一个数据库，认真问一句：不透明 session 是不是本来就更好。

这些都不稀奇。它们就是同一小撮决策，被人一次性、有意地做对。把 JWT 用对的团队，靠的不是聪明的密码学；而是他们从不让 token 自己决定该信什么。
