---
title: "HTTP 缓存详解：Cache-Control、ETag，以及用户为什么会看到旧页面"
description: "一篇讲透 HTTP 缓存的实用指南：浏览器、CDN 与反向代理三层缓存谁听谁的，真正重要的 Cache-Control 指令，ETag 与 Last-Modified 校验器，304 Not Modified 往返过程，no-cache 的经典误读，指纹缓存与重验证之别，Vary 与 Cookie，以及一份可用的静态站点 nginx 配置。"
pubDate: 2026-11-27
lang: zh
translationKey: http-caching
tags: [networking, nginx, devops]
featured: false
keywords:
  - HTTP 缓存
  - Cache-Control
  - ETag
  - 304 Not Modified
  - 缓存击穿
---

用户看到旧页面，无非两种原因：要么没人告诉浏览器去重新验证，要么有人告诉了，但中间某一层把它忽略了。这两种情况背后都是同一个机制——**HTTP 缓存**。同一组响应头既能让你的站点感觉飞快，配置错了也能让它感觉是坏的。让人困惑的是，缓存并不是一件事，而是一叠，每一层对“自己能留下什么”都有各自的判断。

下面是我实际使用的思维模型、真正重要的 `Cache-Control` 指令、`ETag` 如何把一次过期的缓存命中变成一次廉价的 **304 Not Modified**，以及这个博客在跑的 nginx 配置。如果你也在跟 TLS 层面的意外纠缠，同一条请求路径在[一次握手里的 TLS 1.3](/zh/posts/tls-1-3-handshake/) 里已经走过一遍；缓存就架在那次握手之上。

## HTTP 缓存的层级，以及谁听谁的

缓存不是单独一个。一个请求可能由浏览器自己的缓存、离用户最近的 CDN 边缘节点、你机器上的 nginx 反向代理，或者最终由源站来回答。每一层都是独立的，响应在回来的路上穿过它们全部，沿途收集各层的决定。

<figure>
<svg viewBox="0 0 680 200" width="100%" role="img" aria-label="一条请求路径穿过四层缓存：浏览器缓存、CDN 边缘节点、诸如 nginx 的反向代理，以及源站。每一层都可能用自己保存的副本作答；响应上的 Cache-Control 指令分别告诉每一层它是否可以存储、是否必须重新验证。">
  <defs>
    <marker id="hcz-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="10" y="52" width="130" height="56" rx="8"/>
    <rect x="180" y="52" width="130" height="56" rx="8"/>
    <rect x="350" y="52" width="130" height="56" rx="8"/>
    <rect x="520" y="52" width="150" height="56" rx="8"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <line x1="140" y1="70" x2="178" y2="70" marker-end="url(#hcz-arrow)"/>
    <line x1="310" y1="70" x2="348" y2="70" marker-end="url(#hcz-arrow)"/>
    <line x1="480" y1="70" x2="518" y2="70" marker-end="url(#hcz-arrow)"/>
    <line x1="518" y1="92" x2="482" y2="92" marker-end="url(#hcz-arrow)"/>
    <line x1="348" y1="92" x2="312" y2="92" marker-end="url(#hcz-arrow)"/>
    <line x1="178" y1="92" x2="142" y2="92" marker-end="url(#hcz-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="75" y="78" text-anchor="middle">浏览器</text>
    <text x="245" y="78" text-anchor="middle">CDN 边缘</text>
    <text x="415" y="78" text-anchor="middle">nginx</text>
    <text x="595" y="78" text-anchor="middle">源站应用</text>
    <text x="75" y="98" text-anchor="middle" opacity="0.7">私有缓存</text>
    <text x="245" y="98" text-anchor="middle" opacity="0.7">共享缓存</text>
    <text x="415" y="98" text-anchor="middle" opacity="0.7">共享缓存</text>
    <text x="595" y="98" text-anchor="middle" opacity="0.7">真相之源</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">
    <text x="340" y="140" text-anchor="middle">请求向右流，响应向左流；每一层各自决定要不要把它留下</text>
    <text x="340" y="162" text-anchor="middle"><tspan font-family="ui-monospace, monospace">no-store</tspan> 禁止存储 · <tspan font-family="ui-monospace, monospace">private</tspan> 挡下沿途所有共享缓存</text>
  </g>
</svg>
<figcaption>浏览器缓存是私有的，属于某一个用户；CDN 与反向代理缓存是共享的，服务许多用户。`Cache-Control` 分别对它们说话，这正是同一条头对 CDN 正确、对浏览器却错误的原因。</figcaption>
</figure>

解开大部分困惑的规则是：**响应头随着响应一起走**。源站制定策略，下游每一层都读它。`private` 指令告诉 CDN 和代理“别碰”；`no-store` 告诉所有人压根不要留副本。但每一层只会遵守它看得见的东西——如果一个头在传输中被丢掉或被覆盖，下面那一层就永远听不到这条指令。

## 真正重要的 Cache-Control 指令

你需要的几乎全部都集中在同一个头上的几条指令里。还有别的，但决定你是否有 bug 的就是这些。

- **`max-age=N`** —— 副本在 N 秒内是新鲜的；在此之前，缓存可以不加询问直接返回。这是浏览器的时钟。
- **`s-maxage=N`** —— 同样的意思，但只针对**共享**缓存（CDN、代理）。它对这些缓存覆盖 `max-age`，于是你可以让边缘节点把某个资源留一天，而浏览器只留一小时。
- **`no-cache`** —— 全规范里被误读最多的一条。它*并不*是“不要缓存”，而是“缓存它，但复用之前必须**重新验证**”。副本会被存下来，只是每次取用之前都得先问一声。
- **`no-store`** —— 真正的“不要缓存”。任何地方都不写入磁盘或内存。用于机密内容和绝不能再次浮现的响应。
- **`public`** —— 即使共享缓存也可以存储。多数时候是显式声明而非关键，但它允许 CDN 保留一个本来含义模糊的响应。
- **`private`** —— 响应只属于某个用户；共享缓存不得存储。这就是保护一个渲染了某人姓名的页面的东西。
- **`immutable`** —— 在新鲜期内，即使用户刷新也不重新验证。正是这条指令让浏览器不再反复询问它已经拿到的指纹化资源。
- **`must-revalidate`** —— 一旦过期，缓存不得在未向源站确认的情况下使用副本。任何对正确性敏感的内容都值得加上这层保险。

一个典型静态站基本上只用到三种组合：长期不可变资源、需要重验证的短期 HTML，以及介于两者之间的订阅源。

## 校验器：ETag、Last-Modified 与 304 Not Modified

新鲜度分两个阶段。响应处于*新鲜*状态时（在 `max-age` 内），没人去问源站。一旦*过期*，有意思的部分就来了：缓存把一次完整下载变成一个问题，源站回答“没变”——这就是 **304 Not Modified**。

校验器是源站附在响应上的指纹，让缓存能问一句“这还是你的吗？”：

- **`ETag`** —— 针对这份正文字节级版本的不可解释令牌，通常是哈希，或 inode-大小-修改时间三元组。正文一变，ETag 就该变。
- **`Last-Modified`** —— 修改时间戳。对服务器更廉价，但只有秒级精度，在同一秒内改动文件就能骗过它。

缓存把校验器和正文一起存下，过期后把它放进条件请求里发回。若匹配，源站用 `304` 回复、不带正文——省下的是下载，不是那一次往返。以下是完整的交换过程，连头一起：

```http
# 1. 第一次请求 —— 源站返回正文以及它的校验器
GET /posts/http-caching/ HTTP/1.1
Host: blog.awin-x.top

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=0, must-revalidate
ETag: "8f3a1c2e9b"
Last-Modified: Wed, 26 Nov 2026 18:04:11 GMT
```

```http
# 2. 稍后，副本已过期 —— 缓存发问，而不是重新下载
GET /posts/http-caching/ HTTP/1.1
Host: blog.awin-x.top
If-None-Match: "8f3a1c2e9b"
If-Modified-Since: Wed, 26 Nov 2026 18:04:11 GMT

HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=0, must-revalidate
ETag: "8f3a1c2e9b"
Last-Modified: Wed, 26 Nov 2026 18:04:11 GMT
# 没有正文 —— 复用你已经有的那份
```

两个细节很值钱。两者都发送时，`If-None-Match`（ETag 检查）**优先于** `If-Modified-Since`，所以要信 ETag。而且 `304` 仍然携带 `Cache-Control`，让你在不重发正文的情况下更新新鲜度窗口。这就是为什么重验证 HTML 感觉是瞬时的，尽管它技术上讲确实联系了服务器：答案是几百字节的头，而不是整页。

## no-cache 的经典误读

每隔几个月就有人靠加上 `Cache-Control: no-cache` 去“修”一个旧页面，发现还是被缓存了，于是断定缓存坏了。它没坏。`no-cache` 是一条**重验证**指令，不是清除指令。响应*确实*被存下来了——只是每次复用前都必须检查。如果你要的是“永远别留这个”，你要的是 `no-store`。

陷阱在于这两个词在中文里读起来像同义词，行为却截然不同：

```http
Cache-Control: no-cache   # 存下来，但每一次都重新验证
Cache-Control: no-store   # 别在任何地方存，永远
```

`no-cache` 对“想保持新鲜、但服务起来依旧便宜”的 HTML 恰恰好：浏览器留一份副本，带着 `If-None-Match` 来问，没变就拿回 `304`。`no-store` 适合银行流水，或绝不能停在共享缓存里的已认证响应。按意图选，而不是按“听起来更严格”选。

还有一个阅读上的坑：`max-age=0, must-revalidate` 和 `no-cache` 在实践中几乎是双胞胎——两者都强制每次使用时检查——但前者还能让理解 `must-revalidate` 的 HTTP/1.0 缓存表现正常，而后者是更清晰的现代写法。

## 资源用缓存击穿，HTML 用重验证

静态站点里的这对矛盾是真实的：你想把资源永久缓存以换取速度，可一旦改动又必须立刻生效。解法不是把缓存时长调短——那既慢又不精确。解法是**缓存击穿**：内容一变就换 *URL*。

每次构建都对文件做哈希并把哈希写进文件名（`app.4f9c2a1b.js`）。这个文件现在是内容寻址的，于是可以安全地缓存一年并标记 `immutable`——新构建产生新名字，旧的那个自然不再被引用。

```nginx
# 指纹化资源：字节变了名字就变，所以可以放心长缓存
location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

HTML 恰恰相反。它的 URL 是稳定的——`/posts/http-caching/`——所以永远没法改名，而它又正是用户需要看到最新版的东西。用零或极短的 `max-age` 加上 `must-revalidate` 去服务它，再靠 `ETag` 让重验证保持廉价：

```nginx
# HTML 保持稳定 URL，所以每次使用都重验证，而不是改名
location ~* \.html$ {
    add_header Cache-Control "public, max-age=0, must-revalidate";
}
```

订阅源居中：新鲜期短，因为读者终归想要新条目，但也不至于短到轮询客户端把源站打爆。

回报是一个系统：部署即刻生效（HTML 指向新的资源名），而用户已经下载的每一个字节都留在缓存里。正是这个性质，让[单机零停机部署](/zh/posts/zero-downtime-deploys/)里的部署对回访用户来说感觉是瞬时的。

## Vary 与 Cookie：登录用户为什么拿到缓存页面

缓存默认按 URL 作为键。直到同一个 URL 因别的东西返回不同内容——支持 gzip 客户端的 `Accept-Encoding`、`Accept-Language`，或者请求带着会话 Cookie——这就出问题了。这时共享缓存会开开心心地把一个用户的页面递给另一个。

**`Vary`** 就是你告诉缓存“哪些请求头参与了决策”的方式：

```http
Vary: Accept-Encoding
```

这样压缩客户端和未压缩客户端会得到各自的缓存条目，而不是被混成一份坏数据。在 CDN 后面漏掉 `Vary: Accept-Encoding`，你就会撞上那个传说级的“gzip 乱码”bug：纯文本客户端收到了它读不懂的压缩字节。

Cookie 是更锋利的刃。如果响应依赖某个 Cookie，共享缓存绝不能把它递给下一位访客——没有任何 `Vary` 取值能安全地做到这一点。正确的工具是 `Cache-Control: private`，它指示每一个共享缓存别碰这个响应：

```http
Set-Cookie: session=abc123
Cache-Control: private, max-age=0, no-cache
```

`private` 是唯一能可靠保护每用户内容的指令。如果 CDN 配置错误、忽略 Cookie 缓存一切，`private` 就是挡在登录页面和下一位匿名读者之间的那道墙。绝不要让共享缓存去猜身份。

## 一份可用的静态站点 nginx 配置

合起来看，这是我实际在跑的形态——指纹化资源长缓存、HTML 重验证、订阅源短缓存：

```nginx
# /etc/nginx/conf.d/blog.conf
server {
    listen 443 ssl;
    server_name blog.awin-x.top;

    root /var/www/blog/current;
    index index.html;

    # 指纹化资源：文件名里带着内容哈希，所以缓存一年并标记 immutable 是安全的
    # ——字节一改，URL 就变。
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # 订阅源：新鲜期短；读者想尽快看到新条目，但不必每秒都来。
    location ~* ^/(rss|atom|feed)\.xml$ {
        add_header Cache-Control "public, max-age=600, must-revalidate";
    }

    # HTML：URL 稳定，所以每次使用都重验证。ETag 让这次检查很便宜。
    location / {
        add_header Cache-Control "public, max-age=0, must-revalidate";
        try_files $uri $uri/index.html =404;
    }

    # 绝不让共享缓存保留每用户或机密的响应。
    location /api/ {
        add_header Cache-Control "private, no-store";
    }

    gzip on;
    gzip_types text/html text/css application/javascript application/xml;

    # nginx 默认就开着 etag；这里写出来是为了显式。
    etag on;
}
```

两个值得点名的 nginx 坑。`add_header` 只在 2xx/3xx/304 上生效，除非你追加 `always`；而只要某个 `location` 声明了自己的 `add_header`，它就会**取消所有继承来的头**——也就是[Web 安全响应头](/zh/posts/web-security-headers/)里那个同样的陷阱。另外 `etag on` 是默认值；`gzip` 影响的是字节，但 nginx 对静态文件在 gzip 开与关之间正确处理 `Vary` 与 ETag，所以两条路你都能拿到有效的 `304`。

## 手动验证它

看缓存生效不需要浏览器。`curl` 就能展示整个交换过程：

```bash
# 从第一个响应里拿到校验器
curl -sI https://blog.awin-x.top/ | grep -iE 'cache-control|etag|last-modified'

# 然后用刚看到的 ETag 发一次条件请求
curl -sI -H 'If-None-Match: "8f3a1c2e9b"' https://blog.awin-x.top/ | head -1
# HTTP/2 304
```

如果第二次调用返回 `200`，要么内容真的变了，要么你的 ETag 不稳定——有些服务器每个请求都重新生成它，这会悄悄击败整条链上的每一个缓存。

## 常见问题

**为什么我设了 `no-cache` 页面还是旧的？** 因为 `no-cache` 意味着重验证，而不是“丢弃”。浏览器完全照你说的做了；那份旧副本来自某个*共享*层，或者你的 ETag 从来没变过。先看实际响应上的 `Cache-Control`，再确认 ETag 是稳定的。

**该用 `etag` 还是 `Last-Modified`？** 两个都用，让客户端优先选 ETag。`Last-Modified` 是廉价的兜底，ETag 才是精确的那个。

**资源应该缓存多久？** 如果文件名里带着内容哈希，一年加 `immutable` 就是对的。如果没有，先把这件事修好——再保守的时长也救不了一个稳定不变名的资源 URL。

**`max-age` 会覆盖 `s-maxage` 吗？** 不会——对共享缓存是 `s-maxage` 胜出，并且它还隐含了代理侧的 `must-revalidate` 行为。正是这个旋钮让 CDN 能比浏览器留得更久。

**为什么我的 CDN 缓存了登录页面？** 几乎总是已认证响应上缺了 `private`（或 `no-store`），又叠加了一条忽略 Cookie 的 CDN 规则。修头，别指望 CDN 的默认值。

缓存奖励清晰的心智模型，胜过任何单项设置。对每一类资源决定三件事——它新鲜多久、谁可以留下它、过期的副本如何被重验证——然后把这三个答案写成响应头。那些既快又始终正确的站点，都是因为这些答案与内容相匹配，而且没有人把 `no-cache` 当作 `no-store` 来用。
