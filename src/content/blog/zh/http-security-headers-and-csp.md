---
title: "Content-Security-Policy 与真正管用的安全响应头"
description: "深入 Content-Security-Policy（CSP）：在一次性 nginx 容器中跑真实的响应头前后对比、CSP nonce 与哈希如何取代 'unsafe-inline'、frame-ancestors 如何阻止点击劫持、Report-Only 模式如何让你在不弄坏站点的前提下测试，以及一份静态站点的可直接复制起步配置。"
pubDate: 2027-02-04
lang: zh
translationKey: http-security-headers-and-csp
tags: [security, nginx]
featured: false
keywords:
  - Content-Security-Policy
  - 安全响应头
  - CSP nonce
  - HSTS
  - Report-Only
---

安全响应头是你所能部署的最便宜的加固手段——nginx 里十几行，运行时零开销，
却能封掉一整类浏览器侧的漏洞。我已经在
[Web 安全响应头详解](/zh/posts/web-security-headers/) 里覆盖了基础部分
（HSTS、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、
`frame-ancestors`）。本文是更深入的 **Content-Security-Policy（CSP）** 篇：
那个真正干活的响应头、那个真正难以搞对的响应头、以及大多数站点要么不做、
要么配了一个松散到只是安全表演的响应头。

下面的每一个例子，我都在 `127.0.0.1` 上用 `nginx:1.27-alpine` 的一次性
Docker 容器里跑过。没有 sudo，没有特权模式，没有主机安装。每一个
`curl -i` 代码块都是那些容器的真实输出。

## 安全响应头是什么（30 秒版）

安全响应头是**浏览器强制执行的响应头**。你的服务器发出它；浏览器——而不是
你的应用——决定怎么处理它。`curl` 读到 `Content-Security-Policy` 只会耸耸肩；
Chrome 读到它会拒绝执行被注入的 `<script>`。这就是全部的价值主张：当你的
应用出了 bug（它一定会出），浏览器会拒绝把这个 bug 变成漏洞。

静态站点值得设置的响应头：

- **`Strict-Transport-Security`**（HSTS）——强制 HTTPS，阻止 SSL 剥离。
- **`X-Content-Type-Options: nosniff`**——阻止 MIME 嗅探型 XSS。
- **`Referrer-Policy`**——控制 Referer 泄露。
- **`Permissions-Policy`**——默认收回摄像头/麦克风/地理位置权限。
- **`Content-Security-Policy`**——重头戏；CSP nonce、哈希和 `frame-ancestors`。
- **`X-Frame-Options`** / CSP `frame-ancestors`——阻止点击劫持。

所有这些在 nginx 里都是一行配置。难的是 CSP。

## 响应头前后对比（真实输出）

一个裸 nginx 服务器、没有配置任何安全响应头时，返回的只有标准的传输元数据：

```bash
$ curl -si http://127.0.0.1:18099/ | head -12
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Wed, 14 Oct 2026 04:32:31 GMT
Content-Type: text/html
Content-Length: 615
Last-Modified: Wed, 16 Apr 2025 12:55:34 GMT
Connection: keep-alive
ETag: "67ffa8c6-267"
Accept-Ranges: bytes
```

同一个服务器加上六条 `add_header` 指令后。`Accept-Ranges` 以下每一行都是
新增的——这就是全部加固成本：

```bash
$ curl -si http://127.0.0.1:18099/ | head -20
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Wed, 14 Oct 2026 04:33:42 GMT
Content-Type: text/html
Content-Length: 472
Last-Modified: Wed, 14 Oct 2026 04:32:45 GMT
Connection: keep-alive
ETag: "6acf05ed-1d8"
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
X-Frame-Options: SAMEORIGIN
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
Accept-Ranges: bytes
```

就这些。一次配置重载，浏览器此后在每次页面加载时强制执行每一行。本文余下
部分讲的就是 CSP 这一行——它意味着什么、如何在不弄坏站点的前提下测试它、
以及如何处理痛点（内联脚本、第三方挂件、`'unsafe-inline'` 蔓延）。

## CSP 深入：`default-src`、`script-src` 与内联脚本问题

CSP 是一份白名单。`default-src 'self'` 表示"默认只从我自己的源加载一切"。
`script-src 'self'` 表示"只执行来自我自己源的 JavaScript"。不匹配
`script-src` 的 `<script>` 标签会被**浏览器拦截**——不是你的服务器拦的，
不是你的框架拦的，是浏览器自己拦的。

每个站点立刻就会撞上的问题就是：**内联脚本**。如果你的 HTML 里有
`<script>alert('x')</script>`，`script-src 'self'` 的 CSP 会拦截它。浏览器
控制台会显示：

```
Refused to execute inline script because it violates the following Content
Security Policy directive: "script-src 'self'". Either the 'unsafe-inline'
keyword, a hash, or a nonce is required to enable inline execution.
```

这个错误是 CSP 在正常工作。它意味着：一个设法往你页面里注入 `<script>`
的攻击者——通过评论字段、通过存储后渲染的 URL 参数、通过第三方挂件——
会得到同样的拒绝。

下面是一个真实演示。测试页面有一个内联脚本：

```html
<script>
    document.addEventListener('DOMContentLoaded', function() {
        document.getElementById('msg').textContent = 'Inline script executed successfully!';
    });
</script>
```

用 `script-src 'self'`（不带 `'unsafe-inline'`）时，浏览器拦截内联脚本。
用 `script-src 'self' 'unsafe-inline'` 时，它正常执行。响应头差异：

```bash
# 拦截内联脚本——CSP 行：
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'

# 放行内联脚本——CSP 行：
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

### CSP nonce：放行内联脚本的正确方式

**nonce** 是一个每请求生成的随机值。你的服务器生成它，放进 CSP 响应头，
并作为属性加到脚本标签上：

```
Content-Security-Policy: script-src 'nonce-r4nd0m123'
```

```html
<script nonce="r4nd0m123">console.log('this runs');</script>
```

攻击者无法猜到 nonce，所以即使他们注入了一个 `<script>` 标签，它没有 nonce
属性，浏览器一样拦截。这就是放行内联脚本的正确方式。

### CSP 哈希：静态内联脚本的方案

如果你的内联脚本是静态的（每次字节都一样），你可以把它做哈希，把哈希值列进
`script-src`。浏览器把内联脚本内容做哈希，对照白名单检查：

```
Content-Security-Policy: script-src 'sha256-base64hash=='
```

这比 `'unsafe-inline'` 更安全（攻击者不能注入任意代码），但比 nonce 更脆弱
——内联脚本字节的任何变化都会改变哈希并导致失败。nonce 是现代默认选择；
哈希是没有服务端 nonce 能力的静态站点的备选方案。

## `frame-ancestors`：不是 `X-Frame-Options` 的点击劫持防御

`X-Frame-Options: SAMEORIGIN` 是阻止点击劫持的老办法。CSP 的
`frame-ancestors` 指令是现代替代品，而且严格更好：

- `X-Frame-Options` 只能说 `DENY`、`SAMEORIGIN` 或一个源。
- `frame-ancestors` 可以列多个源、使用通配符、并且和其余 CSP 策略写在
  同一条策略里。

```
# 老办法：一个响应头，三个可能的值
X-Frame-Options: SAMEORIGIN

# 现代办法：写在你的 CSP 里
frame-ancestors 'none';           # 永不被嵌套（等同于 DENY）
frame-ancestors 'self';          # 只被同源嵌套
frame-ancestors https://app.example.com;  # 只被该源嵌套
```

如果你同时设了 `X-Frame-Options` 和 `frame-ancestors`，现代浏览器用
`frame-ancestors` 并忽略 `X-Frame-Options`。为不支持 `frame-ancestors` 的
老浏览器保留两者，但不要给它们设成互相冲突的值。

## Report-Only 模式：测试 CSP 而不弄坏站点

在一个在线站点上强制执行新 CSP，就是搞坏东西的答案。解决办法是
`Content-Security-Policy-Report-Only`——同样的语法、同样的指令，但浏览器
**只报告违规而不拦截**：

```bash
$ curl -si http://127.0.0.1:18099/report.html | grep -i 'content-security'
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; report-uri /csp-report
```

页面正常加载，内联脚本正常运行，但每次违规都会报告到 `report-uri` 端点。
你读报告、修真实问题、然后才把响应头从
`Content-Security-Policy-Report-Only` 翻成 `Content-Security-Policy`。
这就是上线流程：

1. 以 Report-Only 模式部署。
2. 浏览自己的站点，点遍每个页面，检查报告。
3. 修掉每个违规（把脚本挪进文件、加 nonce、调整 `script-src`）。
4. 翻成强制执行模式。

## CSP 的诚实痛点

CSP 是真正管用的安全响应头，这也正是它痛苦的原因：

- **内联脚本**——每个 CMS 插件、每个分析片段、每个第三方挂件都想注入
  内联 JavaScript。你要么重构为外部文件、要么用 nonce、要么用
  `'unsafe-inline'` 把策略放松。
- **第三方挂件**——一个聊天挂件或地图嵌入需要在 `frame-src`、`script-src`、
  `style-src`、`img-src`、`connect-src` 里放行它的源。每条指令都是你可能
  不小心放行太多的地方。
- **`'unsafe-inline'` 蔓延**——一个开发者加它来让某个脚本工作，下一个开发者
  照抄这个模式，六个月后你的 CSP 变成了
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https:`——那就是安全表演。
  修复办法是永远不在 `script-src` 里用 `'unsafe-inline'`，并对 CSP 变更
  执行代码审查。
- **响应头修不好有漏洞的应用**——CSP 是纵深防御。如果你的应用有 SQL 注入，
  CSP 救不了你。如果你的应用有存储型 XSS，CSP 会让攻击者显著更难利用，
  但它不修补 bug。先修应用；CSP 是安全带，不是安全气囊。

## 静态站点的可直接复制起步配置

下面是一个合理的 CSP，适用于服务自己资产、不嵌入第三方挂件的静态站点。
如果你用外部字体或图片，调整 `img-src` 和 `font-src`：

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
```

如果你在过渡期需要放行内联脚本，加 nonce（不是 `'unsafe-inline'`）：

```nginx
# 在你的应用里按请求生成 nonce；这是模式，不是字面值
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'nonce-{PER_REQUEST}'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
```

先以 Report-Only 模式部署。读报告。然后强制执行。

## 用 curl 验证，再用浏览器验证

```bash
# 检查响应头是否存在
curl -si https://example.com/ | grep -iE \
  'strict-transport|content-security|x-content-type|referrer|x-frame|permissions'

# 检查 CSP-Report-Only 不拦截（应显示 Report-Only 头，不是强制执行）
curl -si https://example.com/ | grep -i 'content-security-policy-report-only'

# 检查 CSP 正在强制执行（应显示强制执行的头）
curl -si https://example.com/ | grep -i '^content-security-policy:'
```

然后打开浏览器控制台，把自己的站点点一遍。任何被拦截的内联脚本都会作为
CSP 违规显示出来，你可以在强制执行之前修掉。

## 底线

CSP 是真正管用的安全响应头。它也是最需要小心对待的那个。先跑 Report-Only，
用 nonce 而不是 `'unsafe-inline'`，优先用 `frame-ancestors` 而不是
`X-Frame-Options`，把控制台里的每个 CSP 违规当成真正的 bug。上面那个前后
对比就是全部成本：nginx 里六行，浏览器从此在每次请求时强制执行。

完整的安全响应头清单和 `add_header` 继承陷阱，参见
[Web 安全响应头详解](/zh/posts/web-security-headers/) 和
[nginx  cookbook](/zh/posts/nginx-cookbook/)。
