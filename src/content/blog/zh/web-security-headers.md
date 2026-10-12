---
title: "Web 安全响应头详解：CSP、HSTS 与 nginx add_header 陷阱"
description: "面向静态站点的实用安全响应头指南：HSTS 及其 includeSubDomains 陷阱、严格的 Content-Security-Policy、X-Content-Type-Options、Referrer-Policy、frame-ancestors、Permissions-Policy 与 CORS 基础，外加 nginx add_header 的继承陷阱、修复办法和测试方法。"
pubDate: 2026-11-14
lang: zh
translationKey: web-security-headers
tags: [security, nginx, networking]
featured: false
keywords:
  - 安全响应头
  - Content-Security-Policy
  - HSTS
  - nginx add_header
  - Referrer-Policy
---

**安全响应头**是你所能部署的最便宜的加固手段。它就是你 nginx 配置里的十几行，
运行时零开销，却能封掉一整类浏览器侧的漏洞：明文下的会话劫持、跨站脚本、
点击劫持、MIME 混淆、Referer 泄露，以及某个第三方脚本偷偷向你要摄像头权限。
其中干活最多的是严格的 **Content-Security-Policy**，但那些看上去无聊的响应头
也各有其价值。可现实是，大多数静态站点只上了其中一两个，或者以为 CDN 替它加上
`X-Content-Type-Options` 就算万事大吉。

下面这套，就是我这个博客实际在跑的响应头，每个防的是什么，以及那个只要你一碰
`location` 块就会悄悄失效一半响应头的 nginx 陷阱。

## 安全响应头到底防的是什么

响应头是一组交给**浏览器**执行的指令。它挡不住服务器被扫描，也保护不了一个
无视它的客户端——`curl` 读到 `Content-Security-Policy` 只会耸耸肩。响应头能做
的，是限制一个合规浏览器拿到*你的*页面和内容之后允许做什么。这就是纵深防御：
当你的应用出了 bug，浏览器会拒绝把这个 bug 变成漏洞。

在列清单之前，先记住两条规则：

- **响应头保护的是你站点的用户，不是你的站点。** 这里没有任何一项能让服务器
  更难被打。那是[服务器加固](/zh/posts/hardening-a-public-server/)、防火墙和
  打补丁的事。
- **响应头是跨层叠加的。** 如果你身处 CDN 或反向代理之后，先决定每个头在哪一
  层设置，否则你会得到两个 `Content-Security-Policy` 头，而浏览器会取它们的
  **交集**——通常那是最严格、也最出乎意料的组合。

## HSTS：Strict-Transport-Security

HSTS 告诉浏览器：在接下来的 `max-age` 秒内，永远不要再对这个主机用明文 HTTP——
把 `http://` 链接重写掉，拒绝在证书错误时点“继续访问”。它防的是 **SSL 剥离**，
即链路上的攻击者把你最初的请求降级成 HTTP，在 TLS 还没开始之前就把会话偷走。
没有 HSTS，浏览器不记得你偏好 HTTPS，所以每一次全新的访问都可以被降级。

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

这是个合理的起点：一年，仅限本主机。有两个选项能让它更强，但首次部署时两者
都是陷阱。

- **`includeSubDomains`** 会把策略应用到*每一个*子域。浏览器一看到它，任何无法
  提供有效 HTTPS 证书的子域就变得实质不可达——浏览器不会退回 HTTP。如果
  `dev.example.com` 或一个老的 `mail.example.com` 只跑 HTTP，你就把所有访问过
  主站的人的那个子域弄挂了。先审计你的子域。
- **`preload`** 会请求浏览器把你的域名写进一份硬编码列表，这样连*第一次*访问都
  强制 HTTPS。它同时要求 `includeSubDomains` 和至少一年的 `max-age`。移除不是
  即时的：你要提交申请，然后等浏览器发新列表，可能要几个月。把 preload 当成
  一扇单行道。

我的建议：先只上 `max-age`，看日志，等你能证明每个子域都提供 HTTPS 之后，再加
`includeSubDomains`。最后才刻意加上 `preload`，确认无误后在 `hstspreload.org`
提交。如果你还在跟证书错误纠缠，先把那些解决掉——参见
[TLS 错误详解](/zh/posts/tls-errors-explained/)。

## Content-Security-Policy：从严开始，用证据放宽

**CSP** 是挑大梁的那个响应头。它是一份白名单，规定浏览器可以从哪里加载脚本、
样式、字体、图片和框架，以及可以连接到哪里。重点不是信任你自己的标记，而是让
被注入的 `<script>` 执行失败。一个本该运行攻击者代码的跨站脚本漏洞，撞上
`script-src` 就死了。

错就错在起步太松，因为松散的 CSP 只是安全表演。
`script-src 'unsafe-inline' 'unsafe-eval' *` 放行一切，什么都挡不住。从一个
**无 JS 静态站点**真能满足的策略起步：

```nginx
add_header Content-Security-Policy "default-src 'none'; \
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'; \
  img-src 'self' data:; style-src 'self'; font-src 'self'; \
  manifest-src 'self'; connect-src 'none'; \
  script-src 'none'; object-src 'none'; upgrade-insecure-requests" always;
```

把它读作：默认什么都不允许；不许改写 `<base>`、不许提交表单、不许被嵌套；图片、
样式、字体和 web manifest 只许来自我自己的源（外加许多站点都需要的 `data:`
图片）；不许 `fetch`/XHR；而最关键的是**完全不许脚本**。如果你的站点确实不发布
任何 JavaScript，`script-src 'none'` 就是本文最强的一行——被注入的脚本根本无法
运行，到此为止。

如果你确实要发布 JavaScript，就把它的源加进去，别再猜：

```nginx
# Astro 自己的 island 打包产物，与页面同源
script-src 'self';
```

对任何你没法挪进文件的内联脚本，用 **nonce** 或 **hash**，而不是
`'unsafe-inline'`。现代框架可以按请求生成 nonce；如果你的框架做不到，就把内联
块做哈希并列进 `script-src`。分两步上线：先用
`Content-Security-Policy-Report-Only`（浏览器只报告不拦截），读报告，再把同一
串内容切换成强制执行的响应头。另外注意，带 **sandbox** 或 `frame-ancestors` 的
CSP 无法通过 `<meta>` 标签下发——它必须是一个真正的 HTTP 响应头。

## X-Content-Type-Options：nosniff

浏览器总想帮忙：一个响应被标成 `text/plain`，但字节看着像 HTML，有些浏览器就会
“嗅探”并照样渲染。这就把一个看似无害的用户上传 `.txt` 变成了存储型 XSS。
`nosniff` 禁止这种猜测。

```nginx
add_header X-Content-Type-Options "nosniff" always;
```

再给每个响应配上正确的 `Content-Type`——`nosniff` 会让缺失或错误的类型*大声*
失败，而不是被猜来猜去，这正是你想要的。

## Referrer-Policy

`Referer` 头会泄露访客从哪来，包括带 token 或查询串的完整 URL，发给页面触碰到的
每一个第三方。`Referrer-Policy` 决定发出去多少。

```nginx
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

这个默认值对同源请求发送完整 URL，跨域只发送裸源（`https://example.com/`），
而从 HTTPS 降级到 HTTP 时什么都不发。这是合理的现代默认。
`no-referrer` 更严格，除了依赖 referrer 做分析或防盗链的站点之外不破坏任何东西；
如果你想要零泄露，就用它。

## X-Frame-Options 与 CSP frame-ancestors

点击劫持是把你的页面隐形地嵌在攻击者的界面之下，让一次点击落在你的“删除账号”
按钮上。两个响应头能挡住它。`X-Frame-Options` 是老办法；CSP 里的
`frame-ancestors` 是更现代、表达力更强的办法。

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
# frame-ancestors 'none' 已经写在上面的 CSP 里了
```

如果你会嵌入自己的页面就用 `SAMEORIGIN`，从不嵌入就用 `DENY`。
`frame-ancestors` 在现代浏览器里取代了它，还能让你放行特定的源；
保留 `X-Frame-Options` 作为老浏览器的保险带。不要给两者设置互相冲突的值，否则
又会撞上那个意外的交集。

## Permissions-Policy

浏览器的强力功能——摄像头、麦克风、地理位置等等——默认是开着的。
`Permissions-Policy`（旧称 `Feature-Policy`）就是关掉它们的地方，对你自己的页面
和你嵌入的东西都生效。

```nginx
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
```

对一个内容博客来说，诚实的做法是把用不到的全禁掉——它是一行保证：任何脚本，
无论你的还是注入的，都碰不到这些传感器。如果你嵌入地图或视频播放器，就只放行
那个具体的源：`geolocation=(self "https://maps.example.com")`。

## CORS：它是什么，又不是什么

**CORS** 是这里被误解最多的一项，所以说直白点：它是一条**浏览器**规则，不是
服务器的访问控制机制。`Access-Control-Allow-Origin` 并不能保护你的数据。
`curl`、脚本或服务器照样能读你的接口，无论你设了什么。CORS 做的是告诉浏览器，
*另一个*源上的 JavaScript 是否可以**读取**它发出的那个响应。它是一个放宽机制，
不是一堵墙。

一个静态站点通常完全不需要 CORS——同源资源不需要任何响应头。当你跨域加载字体、
JSON API 或挂件时才涉及它。两件事要弄对：

- `Access-Control-Allow-Origin: *` 和 `credentials: include` 互斥；如果你需要
  cookie，就必须写出精确的源，并加上 `Access-Control-Allow-Credentials: true`。
  绝不要从请求里把任意源原样回显回去。
- 非简单请求会触发一次 **预检** `OPTIONS` 请求；你的服务器必须应答它
  （`Access-Control-Allow-Methods`、`Access-Control-Allow-Headers`），否则真正的
  请求根本不会发生。

如果你真想限制谁可以读数据，那是认证与授权的事，不是 CORS。

## nginx add_header 继承陷阱

这就是让人以为响应头“不生效”的那个陷阱。在 nginx 里，`add_header` 只在内层块
**自身没有任何 `add_header`** 时才从外层块继承。你一旦在某个 `location` 里加了
哪怕一条 `add_header`，它在该 location 里就会**取消掉从 `server` 继承来的所有
`add_header`**。

```nginx
server {
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    location /assets/ {
        # 就这一行，把 /assets/* 下的 HSTS 和 nosniff 全抹掉了。
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

对 `/assets/*` 的请求只会拿到 `Cache-Control`，安全响应头**一个都没有**。不会有
任何警告，它就这么静默地丢掉了。嵌套的 `location` 块再深一层也一样，这也是
`securityheaders.com` 扫描在 `/` 给 A、在某个静态资源上却给 D 的头号原因。

修复办法是别再重复自己：把安全响应头放进一个 snippet，然后在**每一个**自己定义
了 `add_header` 的块里 `include` 它。

```nginx
# /etc/nginx/snippets/security-headers.conf
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Content-Security-Policy "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; font-src 'self'; manifest-src 'self'; connect-src 'none'; script-src 'none'; object-src 'none'; upgrade-insecure-requests" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=(), usb=()" always;
```

```nginx
server {
    server_name example.com;
    server_tokens off;

    include snippets/security-headers.conf;

    location /assets/ {
        include snippets/security-headers.conf;    # 重新 include，否则就丢了
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

`always` 参数也很重要：不加它，nginx 只在 2xx、3xx、204 和 304 响应上加响应头，
于是你的安全响应头在 404 或 500 上会消失——而这恰恰是攻击者探测你的错误页面时
最希望它们消失的时刻。每一层都 `include` 加上 `always`，就是完整的修复。一个
snippet，永不漂移。

## 怎么测试

先用 `curl` 检查，因为它比浏览器更直接地告诉你真相：

```bash
curl -sI https://example.com | grep -iE \
  'strict-transport|content-security|x-content-type|referrer|x-frame|permissions'

# 也测一下 404 和嵌套的静态资源——add_header 陷阱就藏在那里
curl -sI https://example.com/assets/app.js | grep -iE 'strict-transport|x-content-type'
curl -sI https://example.com/does-not-exist | grep -iE 'strict-transport'
```

然后把扫描器当作第二意见：`securityheaders.com` 和 Mozilla Observatory 会给一个
URL 上的响应头打分，`hstspreload.org` 会告诉你你的 HSTS 是否够格上 preload。
最后，在 CSP 处于 Report-Only 模式时打开 devtools → Console，把自己的站点点一遍：
任何被拦截的内联脚本都会作为 violation 冒出来，你可以在强制执行之前修掉它。

## 常见问题

**一个静态博客需要全部这些吗？** HSTS、`nosniff`、`Referrer-Policy`、
`frame-ancestors` 和严格的 CSP，覆盖了大约 95% 的价值。`Permissions-Policy`
几乎免费。CORS 你很可能完全用不上。

**CSP 会不会把我的站点弄坏？** 只有在你测试之前就强制执行时才会。先跑
Report-Only，读 violation，再用同样的策略强制执行。

**HSTS preload 值得这份承诺吗？** 对一个每个子域都上 HTTPS 的稳定域名来说，
值得。对任何实验性的东西，不值得——移除要花好几个月。

**为什么某些路径下我的响应头会不见？** 几乎总是上面那条 `add_header` 继承规则。
用 `curl -I` 测那条确切的路径确认一下。

把 snippet 发上去，在不止一条路径上用 `curl -I` 验证，然后就收工。整件事就是
一个下午，做一次，之后它就一直管用。
