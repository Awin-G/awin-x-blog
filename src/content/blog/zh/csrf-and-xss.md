---
title: "写给后端工程师的 XSS 与 CSRF：输出编码、SameSite cookie 与 CSP"
description: "面向写后端的人的 XSS 与 CSRF 指南：XSS 的三种类型、为什么按上下文做输出编码胜过一把通用 escape()、作为纵深防御的 Content-Security-Policy、cookie 为什么让你易受 CSRF、SameSite cookie 的行为、CSRF token、为什么「我们用 JSON API」并不自动安全，以及为什么一个 XSS 就能击穿你的 CSRF token。"
pubDate: 2026-11-20
lang: zh
translationKey: csrf-and-xss
tags: [security, devops, python]
featured: false
keywords:
  - CSRF
  - XSS
  - 输出编码
  - SameSite cookie
  - Content-Security-Policy
---

每个后端工程师迟早都会收到那份「两大攻击」简报，通常是一串用来在合规表上打勾的缩写。下面是我希望早点看到的那一版。**XSS**（跨站脚本）说的是*你*往页面里放了什么：它把你自己的源变成了攻击者的执行环境。**CSRF**（跨站请求伪造）说的是*浏览器*往一个你本无意发出的请求上附带了什么：它把你的会话变成了攻击者的凭证。两者有关联，也常被混为一谈，而它们的修复方式差异很大——把其中一个做好，并不能替另一个兜底。**输出编码**干掉 XSS；**SameSite cookie** 加 **CSRF token** 干掉 CSRF。而你仍然得两个都上心的原因是：一个 XSS 会悄无声息地废掉你整套 CSRF 防御。

## XSS 的三种类型

所有 XSS 都是同一个 bug——浏览器把不受信任的数据当成了代码——但数据*落在哪里*，决定了谁会中招、以及你要在哪里修。

### 反射型 XSS

载荷随请求而来、又随响应弹回：一个搜索结果页把 `?q=<script>…</script>` 原样回显到页面里，就是经典例子。攻击者得先诱导受害者点一个精心构造的链接（钓鱼、短链、广告），所以利用它需要「投递」。修复点在 sink——按它落地的上下文来编码。

### 存储型 XSS

载荷被存了下来——一条评论、一个昵称、一个文件名——然后被之后每一个加载页面的人看到。它不需要针对某个受害者发链接，所以这才是危险的那种：一条被下毒的记录就是埋在每位读者脚下的地雷，包括管理员。要在*出口*修，也就是渲染时编码。

### DOM 型 XSS

服务器根本看不到载荷。客户端 JavaScript 从一个攻击者可控的 source（`location.hash`、`postMessage`、`document.referrer`）读数据，再交给危险的 sink（`innerHTML`、`eval`、`document.write`）。因为 bug 完全活在浏览器里，服务端转义碰不到它。办法是让 source 远离 sink：用 `textContent` 和 `URL` API，而不是 `innerHTML`。

## 真正的修复：按上下文做输出编码

「对输出做编码」就是全部规则，而其中真正吃重的词是**上下文（context）**。HTML 有好几种解析上下文，每种对应不同的转义，所以一个值只有相对于它被插入的位置才是安全的：

- **HTML 文本** —— `<h1>{{ name }}</h1>` —— 编码 `&`、`<`、`>`。
- **HTML 属性** —— `<a title="{{ t }}">` —— 编码 `&`、`<`、`>`、`"`，并且永远给属性加引号。
- **URL** —— `<a href="{{ url }}">` —— 百分号编码，并对*协议（scheme）*做允许列表。
- **JavaScript** —— 在 `<script>` 或 `on*` 处理器里 —— 用 JSON 编码器，而不是 HTML 转义。
- **CSS** —— 少见，但也是独立上下文；干脆别把用户数据往里面插。

落到实践上：让一个真正的模板引擎来做。

```python
# 有漏洞 —— 一个字符串，四种上下文，没有哪一个编码器能同时适配。
from flask import Flask, request
app = Flask(__name__)

@app.get("/hi")
def hi():
    name = request.args.get("name", "")
    return (
        f'<h1>Hi {name}</h1>'
        f'<div class={name}>profile</div>'
        f'<a href="/u?name={name}">me</a>'
        f'<script>var user = "{name}";</script>'
    )
```

```python
# 已修复 —— 让模板引擎接管 HTML 与 JavaScript 两个上下文。
from flask import Flask, render_template
app = Flask(__name__)

@app.get("/hi")
def hi():
    return render_template("hi.html", name=request.args.get("name", ""))
```

```html
<!-- templates/hi.html —— autoescape 已开启；{{ }} 会对文本和属性编码 -->
<h1>Hi {{ name }}</h1>
<div class="{{ name }}">profile</div>
<a href="{{ url_for('me', name=name) }}">me</a>
<script>var user = {{ name | tojson }};</script>
```

同一个页面上用了两个不同的编码器：`{{ name }}` 做 HTML 编码，`{{ name | tojson }}` 序列化成 JavaScript。这两者的区别*本身*就是这堂课的核心。

### 为什么「转义错了上下文」会失败

人们常常抓一个辅助函数——通常是 HTML 转义——就以为它能通吃一切。它不能：

- **URL。** `href="{{ url }}"`，其中 `url = javascript:alert(document.cookie)`，它被完整地 HTML 转义了，点击时照样执行；冒号和字母都只是普通字符。只有对协议做允许列表才有用。
- **未加引号的属性。** `<div class={{ name }}>`，其中 `name = x onmouseover=alert(1)`，会注入一个全新的属性，因为 HTML 转义永远不会去掉那个空格。
- **JavaScript 字符串。** 把一个值 HTML 转义后塞进 `<script>var x = "{{ name }}";</script>`，实体在 script 块里并不会被解码——浏览器看到的是字面量 `&quot;`，字符串就错了，于是你很想去 `|safe` 它，而那会把转义整个拿掉。

`escape()` 不是咒语；它只是针对某一个上下文的某一个编码器。让编码器对上 sink，当框架已经给这个 sink 提供了辅助函数，就用它，别自己手搓。

## Content-Security-Policy 是安全带，不是刹车

就算编码做到完美，漏掉一个 sink、或者新加一个模板，就又是一个 bug。**Content-Security-Policy** 是纵深防御：一个告诉浏览器它只能从哪些来源执行脚本的响应头，于是即便你的转义失了手，被注入的 `<script>` 也会失败。它不能替代编码——一个需要 `unsafe-inline` 才能跑的 CSP 什么都保护不了——但它把「一个 XSS 就是在浏览器里执行脚本」变成「一个被拦截的请求和一份违规报告」。

```nginx
# 上严格策略；先用 report-only，再把同一个字符串改成强制模式。
add_header Content-Security-Policy "default-src 'none';
    script-src 'self';
    style-src 'self';
    img-src 'self' data:;
    connect-src 'self';
    base-uri 'none';
    form-action 'self';
    frame-ancestors 'none';
    object-src 'none';
    upgrade-insecure-requests" always;
```

真正干活的是那一行 `script-src 'self'`，不带 `unsafe-inline`、不带 `unsafe-eval`：攻击者的内联脚本会被拒。如果应用必须输出内联脚本，就给每段一个每次请求生成的 **nonce** 并列出来——别用 `unsafe-inline` 把门打开。关于周边那些响应头、nginx `add_header` 的继承陷阱，以及怎么测，我在[Web 安全响应头](/zh/posts/web-security-headers/)里讲得更细。

## CSRF：你的 cookie 就是漏洞所在

Web 的认证模型是「浏览器会把你的 cookie 自动附带到发往某个站点的每一个请求上，不管这个请求是谁发起的」。这正是会话能工作的原因——也正是 CSRF 钻的空子。攻击者不需要*读*你的 cookie，他们需要你的*浏览器*把它发出去。`evil.example` 上一个表单自动提交 `POST https://bank.example/transfer`，浏览器因为这是一次普通的跨站请求，会很配合地附上会话 cookie，于是转账就成了。

有两点要内化：

- **它针对的是状态变更。** 跨站*读取*数据会撞上同源策略；提交一个表单则不会。所以破坏力集中在动作上：转账、删除、改邮箱、改密码。
- **`SameSite` 如今是浏览器的默认答案。** 现代浏览器默认把 cookie 设为 `SameSite=Lax`，这会拦下跨站 `POST` 上的 cookie——也就是最常见的 CSRF 形态。这个默认值省了很多代码；但你还是不该盲目依赖它。

### SameSite cookie：一行就能修，但有前提

一个 **SameSite cookie** 声明了浏览器在什么时候可以把该 cookie 附带到跨站请求上：

- `Lax` —— 在顶层导航（点击链接）时发送，但在跨站 `POST` 或子资源请求上不发送。这是会话 cookie 合适的默认值。
- `Strict` —— 任何跨站场景下一律不发送。最强，但它会打断那些从外部链接进来、却已经需要会话的流程（一个 OAuth 重定向会让用户处于登出状态）。
- `None` —— 处处发送，所以必须搭配 `Secure`；当某个第三方确实需要你的 cookie 时才用。

```python
# 会话 cookie：这些属性的重要性和它的值一样。
response.set_cookie(
    "session",
    token,
    httponly=True,          # JavaScript 读不到——限制 XSS 造成的损害
    secure=True,            # 绝不走明文 HTTP 发送
    samesite="Lax",         # 不附带在跨站 POST 上
    max_age=60 * 60 * 24 * 7,
)
```

对多数应用来说，光靠 `SameSite=Lax` 就能覆盖经典的表单和 `fetch` 伪造。但它覆盖不了老浏览器、你不得不设成 `None` 的 cookie，也覆盖不了*兄弟子域*的情形——`evil.yourdomain.example` 可以发出同站请求。想要真正的保证，你还需要 token。

### CSRF token：证明「意图」的那张牌

一个 **CSRF token** 是绑定到会话的随机值，被嵌入到攻击者读不到的页面里，并在每个状态变更请求上被要求携带。伪造请求带不上它，因为同源策略让攻击者读不到你的 HTML。登录时生成它、随会话存储、渲染进每个表单、XHR 时通过响应头发送、并用恒定时间比较。

```python
import secrets
from hmac import compare_digest

def check_csrf(request, session):
    sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    expected = session.get("csrf_token")
    # compare_digest 避免比较本身产生计时侧信道。
    if not sent or not expected or not compare_digest(sent, expected):
        return False
    return True
```

人们常忽略的一点：**把 token 绑定到会话**——一个对谁都有效的 token 不比没有更好——并且让它不可预测（`secrets.token_urlsafe(32)`，而不是用户 ID 的哈希）。

### 为什么「我们用 JSON API」并不自动安全

这是个值得戳破的迷思。把请求改成 `Content-Type: application/json`，按 CORS 的说法确实会把它从「简单请求」变成「需要预检」，而带自定义内容类型的跨站 `fetch` 会触发一个你可以拒绝的 `OPTIONS`。但是：

- **表单照样能 POST。** HTML 表单只能发 `application/x-www-form-urlencoded`、`multipart/form-data` 或 `text/plain`——永远发不了 JSON。所以只要你的端点接受表单编码的请求体，或者你根本没真正强制要求 JSON 内容类型，预检这道墙就压根不在场。
- **`text/plain` 是一条绕过路径。** 一个 `enctype="text/plain"` 的表单能在不触发预检的情况下发出 JSON 形状的字节；一个宽松的解析器会照单全收。
- **CORS 是浏览器侧的读取规则**，不是服务端的 CSRF 防护。`curl` 和其他服务器完全无视它。

真正能断言用户意图的只有 token，而且它很便宜。

## 一个 XSS 就能击穿 CSRF token，所以 XSS 是更大的那条鱼

下面这个相互作用，决定了你的优先级顺序。

<figure>
<svg viewBox="0 0 660 150" width="100%" role="img" aria-label="一个 XSS 载荷变成以你的源身份运行的脚本，它从页面里读出 CSRF token，并发出一个服务器会接受的有效伪造请求。">
  <defs>
    <marker id="xss-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8"   y="52" width="120" height="52" rx="8"/>
    <rect x="166" y="52" width="150" height="52" rx="8"/>
    <rect x="354" y="52" width="130" height="52" rx="8"/>
    <rect x="522" y="52" width="130" height="52" rx="8"/>
    <path d="M128 78 H166" marker-end="url(#xss-arrow)"/>
    <path d="M316 78 H354" marker-end="url(#xss-arrow)"/>
    <path d="M484 78 H522" marker-end="url(#xss-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="68"  y="74" text-anchor="middle">XSS sink</text>
    <text x="68"  y="92" text-anchor="middle">在你的源上</text>
    <text x="241" y="74" text-anchor="middle">脚本以你的</text>
    <text x="241" y="92" text-anchor="middle">源身份运行</text>
    <text x="419" y="74" text-anchor="middle">从页面读出</text>
    <text x="419" y="92" text-anchor="middle">CSRF token</text>
    <text x="587" y="74" text-anchor="middle">有效的伪造</text>
    <text x="587" y="92" text-anchor="middle">请求被接受</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.7">
    <text x="68" y="34" text-anchor="middle">攻击者载荷</text>
  </g>
</svg>
<figcaption>一个 XSS 在受害者的浏览器里<em>以你的源身份</em>运行，于是它可以从页面本身读出 CSRF token，并发出一条服务器没有理由拒绝的请求。`httpOnly` cookie 救不了你——脚本从来就不需要那个 cookie，它只需要同源上下文。</figcaption>
</figure>

走一遍：攻击者在你的源上找到一个 XSS sink。他们不需要偷 cookie——它是 `httpOnly`，很好——因为他们的脚本现在正*以你的源身份*在受害者浏览器里执行。它从页面里读出 CSRF token，如果你把 double-submit cookie 留成了可读就这么读，然后带上一枚有效 token 发出同源 `fetch`。你建的每一层 CSRF 防御，前提都是攻击者读不到你的页面。XSS 恰恰就是让他们读到页面的那个 bug。这就是为什么 XSS 要排在第一位、为什么 CSP 不可商量：一个 XSS 不是一个 bug，它是一把能卸掉你其余所有防御的万能钥匙——而且它还能直接外带数据，这是 CSRF 永远做不到的。

## 加固清单

- **Cookie：** 会话 cookie 上 `httpOnly` + `Secure` + `SameSite=Lax`（或 `Strict`）。
- **Content-Security-Policy：** 严格、不带 `unsafe-inline`/`unsafe-eval`，确实需要的内联脚本用 nonce，报告干净之前一直用 Report-Only。
- **按上下文做输出编码：** HTML、属性、URL、JS、CSS 各自用对编码器；保持模板自动转义开启。
- **校验输入**是为了正确性，但别把它和输出编码混为一谈；发文件时带上 `X-Content-Type-Options: nosniff`。
- **CSRF token** 覆盖每个状态变更请求，绑定到会话，恒定时间比较，外加对 `Content-Type` 的显式检查。
- **别自己手搓：** 用框架的模板引擎、会话 cookie、CSRF 中间件和密码哈希。

XSS 和 CSRF 看起来像是一对，但它们是有排序的：先修 XSS，因为能一击废掉 CSRF 防护、并独自外带数据的就是它。用按上下文的输出编码、一个严格的 CSP，再加上 `SameSite` 配合 token 的 CSRF 防御，那两个最常把一个小应用变成事故的 bug 就被堵上了。它和我已经在跑的[安全响应头](/zh/posts/web-security-headers/)以及[服务器加固](/zh/posts/hardening-a-public-server/)叠在一起，正好收口。
