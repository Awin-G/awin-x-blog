---
title: "实测 brotli 与 gzip：真实文件上的 HTTP 压缩对比，逐压缩级别"
description: "在真实文件上实测 brotli 与 gzip：完整的 gzip 1-9 与 brotli 1-11 字节数对照表、压缩级别的 CPU 开销、nginx gzip 与 brotli 模块配置、构建期预压缩静态资源、BREACH 风险，以及哪些内容不该压缩。"
pubDate: 2027-01-27
lang: zh
translationKey: http-compression-brotli-vs-gzip
tags: [nginx, networking]
featured: false
keywords:
  - brotli 与 gzip 对比
  - HTTP 压缩
  - Content-Encoding
  - nginx gzip
  - 压缩级别
---

你发出的每一个 HTML 页面都是一堆高度重复的文本，而 **HTTP 压缩**（HTTP compression）会把网上传输的重复部分大部分扔掉。客户端在 `Accept-Encoding` 里声明自己支持哪些编解码器，服务器为每个响应挑选一个，响应则带一个 `Content-Encoding` 头说明用了什么。今天真正重要的编解码器有两个：**gzip**，快且被普遍支持；**brotli**，压缩慢但按实测在 Web 文本上通常小 10–18%。这些数字一直在人们口中流传却没人真的量过，所以我量了。下面所有数据都来自对真实文件运行真实的 `gzip` 与 `brotli`，以及一个真实的 nginx 容器——没有任何一个是"示意"数据。nginx 指令本身我不再展开，见我之前的[nginx 配置手册](/zh/posts/nginx-cookbook/)；压缩后的字节如何与缓存交互，见[HTTP 缓存](/zh/posts/http-caching/)；压缩与传输层升级是两件事，见 [HTTP/2 与 HTTP/1.1 对比](/zh/posts/http2-vs-http11/)。

<figure>
<svg viewBox="0 0 720 250" width="100%" role="img" aria-label="HTTP 压缩协商示意图：客户端发送带 Accept-Encoding 头、列出 gzip 与 br 的请求，服务器为该响应选择一种编解码器，压缩响应体后以 Content-Encoding 应答，客户端解压后由浏览器渲染原始页面。若没有匹配的编解码器，响应以 identity 原样发送，不带任何 Content-Encoding 头。">
  <defs>
    <marker id="hc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="16" y="70" width="150" height="64" rx="8"/>
    <rect x="285" y="70" width="150" height="64" rx="8"/>
    <rect x="554" y="70" width="150" height="64" rx="8"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="91" y="98">客户端</text>
    <text x="91" y="116" font-size="11" opacity="0.75">浏览器</text>
    <text x="360" y="98">服务器（nginx）</text>
    <text x="360" y="116" font-size="11" opacity="0.75">选择编解码器</text>
    <text x="629" y="98">客户端</text>
    <text x="629" y="116" font-size="11" opacity="0.75">解压</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none">
    <line x1="166" y1="88" x2="283" y2="88" marker-end="url(#hc-arrow)"/>
    <line x1="435" y1="116" x2="552" y2="116" marker-end="url(#hc-arrow)"/>
  </g>
  <g fill="#0f766e" font-family="ui-monospace, monospace" font-size="11.5" text-anchor="middle">
    <text x="224" y="74">Accept-Encoding: gzip, br</text>
    <text x="493" y="142">Content-Encoding: br</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.4" fill="none" opacity="0.85">
    <line x1="435" y1="90" x2="470" y2="90"/>
    <line x1="470" y1="90" x2="470" y2="130"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.7" text-anchor="middle">
    <text x="360" y="180">无匹配编解码器 → identity：响应体原样发送，不带 Content-Encoding</text>
    <text x="360" y="200">压缩是逐响应、逐请求协商的——从来不是连接级设置</text>
  </g>
</svg>
<figcaption>压缩的内容协商：客户端声明支持的编解码器，服务器应答实际使用的那一种。</figcaption>
</figure>

## 压缩位于哪一层，响应头到底说了什么

压缩位于 HTTP 层与网线之间：消息体是字节流，`Content-Encoding: gzip` 或 `Content-Encoding: br` 告诉接收方这些字节是怎么产生的。实践中有三个关键点：

- **它是协商出来的，不是默认的。** 客户端发 `Accept-Encoding: gzip, br`（curl 只有在你要求时才发——裸跑的 `curl` 拿到的是 `identity`）。如果没有匹配项，服务器原样发送响应体，且完全不带 `Content-Encoding` 头。我在真实 nginx 上验证过：带这个头的请求 → `Content-Encoding: gzip`；不带的请求 → 没有这个头。
- **它是逐响应的。** 同一连接上，一个响应可以走了 gzip，下一个就是 identity；nginx 按文件对照 `gzip_types` 逐个决定。
- **它不是 `Transfer-Encoding`。** `Transfer-Encoding: chunked` 管的是分帧不是内容；压缩响应上你会同时看到两者。

gzip 就是 DEFLATE（LZ77 + Huffman），32 KB 窗口，除了数据本身没有任何内置字典。Brotli 保留了 LZ77 + Huffman 内核，但换上了大得多的滑动窗口、上下文建模，还有——对 Web 最要命的一项——一个**内置静态字典**，收录常见 Web 词元（`<div`、`function`、`stylesheet`……）。这正是它在 HTML 和 CSS 上收益最大、在已压缩的 JS 上收益较小的原因。

## 真实数字：五个真实文件上的 brotli 与 gzip

我用 `gzip -n -1..-9` 和 `brotli -q 1..11` 压缩了同样的五个真实文件：从 blog.awin-x.top 抓取的一个真实博客页面（50,981 B）、一个真实压缩后的 JS bundle（jsDelivr 上的 htmx 2.0.4，50,917 B）、一个真实的 `package-lock.json`（214,466 B）、一个真实样式表（18,127 B），以及本博客真实提供的一个 PNG（246,459 B）。`-n`/`--no-name` 保证 gzip 输出确定。完整扫描结果（字节）：

| 文件 | 原始 | gzip -1 | gzip -6 | gzip -9 | brotli -1 | brotli -5 | brotli -11 |
|---|---|---|---|---|---|---|---|
| page.html | 50,981 | 12,451 | 10,819 | 10,784 | 12,247 | 10,084 | **8,880** |
| bundle.js | 50,917 | 19,259 | 16,350 | 16,314 | 18,951 | 15,933 | **14,802** |
| data.json | 214,466 | 51,908 | 45,486 | 44,799 | 47,711 | 41,849 | **39,510** |
| styles.css | 18,127 | 5,469 | 4,486 | 4,454 | 5,677 | 4,309 | **3,872** |
| moiré PNG | 246,459 | 246,213 | 246,194 | 246,194 | — | 246,467 | 246,464 |
| photo.jpg | 87,397 | 86,579 | 86,485 | 86,485 | — | 86,232 | 85,763 |

我从表里读出的结论：

- **对照 gzip 的默认级别 6，brotli 最高质量小 9.5%（JS）到 17.9%（HTML）。** 字典在 HTML 上回本明显：同一页面 8,880 对 10,819 字节。
- **gzip 的高档位几乎白费。** `gzip -9` 比 `gzip -6` 在页面上只小 0.3%，在 JSON 上小 1.5%。从 `-1` 到 `-6` 能省 13%——级别曲线前陡后平。
- **brotli -1 不是"快速 brotli"。** 在 CSS 上它甚至比 `gzip -1` *更大*（5,677 对 5,469）。要快要不用低档 gzip，要么预压缩（见后）。
- **已压缩的文件基本不为所动。** PNG 在 gzip -6 下只小 0.1%，brotli -11 反而比原文件大 5 个字节；真实照片 JPEG 在两种编解码器下都只小 1% 左右。这就是文件已被熵编码的典型特征——下面细说。

有个 caveat，实话实说比漂亮更重要：本博客的 512×512 RGBA 图标（18,507 B）确实能被 gzip 压到 15,407 B——16.7%。原因是 alpha 通道加上编码器没有把 DEFLATE 拉满，不是这个格式有什么魔力。它是例外；上面那个噪声主导的渲染图才是常态。

## 压缩级别是 CPU/体积的旋钮，而 brotli 的最高档很贵

级别就是在拿编码 CPU 换体积。我在同一批文件上给每个编解码器计时，取三次运行的最小值，单核小主机（含进程启动开销，绝对值请粗略看——比例才是重点）：

| 文件 | gzip -1 | gzip -6 | gzip -9 | brotli -4 | brotli -11 |
|---|---|---|---|---|---|
| page.html | 2.7 ms | 3.1 ms | 3.5 ms | 3.6 ms | 90.4 ms |
| data.json | 4.8 ms | 7.4 ms | 14.1 ms | 7.7 ms | 415.5 ms |
| moiré PNG | 9.7 ms | 10.5 ms | 10.5 ms | 4.0 ms | 256.9 ms |

两点突出。其一，**brotli 的质量刻度与耗时非线性**：`-q 11` 相对 gzip -6 要高出一个数量级以上的耗时，才换来上表那点体积。其二，压缩*不可压缩*的数据照样烧 CPU——PNG 那一行纯属浪费，这正是为什么永远不该在请求路径上把通用压缩器对准图片。解压则相反，两种编解码器都便宜；成本全在生产端。

## 什么不该压缩：已编码的字节，以及秘密

如果载荷已经过熵编码——JPEG、PNG、WebP、AVIF、MP4、gz、WOFF2——就没有什么可挤的了，"压缩"这一步只增加延迟和 CPU。上面的实测就是证据：噪声主导的 PNG 只小 0.1%，真实照片只小 1% 左右。这也是 nginx 的 `gzip_types` 默认只含文本类型的原因，也是我特意把 `image/png` 和 `image/jpeg` 排除在配置之外的原因——线上服务器对 `photo.png` 返回了完整的 246,459 字节，没有任何 `Content-Encoding`。

安全提示是最容易忘的一条：**CRIME 攻击的是请求压缩，BREACH 攻击的是响应压缩。** 如果服务器压缩的响应里同时含有秘密（CSRF token、会话值）和回显的用户可控输入，攻击者就能通过大量请求观察密文长度逐字节恢复秘密——压缩比暴露了猜得有多近。实践上：不要在会回显用户输入又带按用户秘密的端点上启用响应压缩，或者按请求加掩码让长度不携带信息。像本博客这样静态、无个性化的站点没有回显面，不在 BREACH 的爆炸半径里；动态 JSON API 可能就在。

## 在 nginx 里启用——实话实说

`gzip` 模块编译在 stock nginx 里，所以任何官方镜像上故事都很简单：

```bash
$ docker run -d --name ngxgz -p 127.0.0.1:8080:8080 \
    -v "$PWD/gzip.conf":/etc/nginx/conf.d/default.conf:ro \
    -v "$PWD/site":/srv/site:ro nginx:1.27-alpine
```

```nginx
server {
    listen 8080;
    root /srv/site;

    gzip on;
    gzip_comp_level 6;          # 默认值；-9 只多省约 1%，CPU 约翻倍
    gzip_min_length 256;        # 太小的响应体不值得
    gzip_vary on;               # 给代理缓存加 "Vary: Accept-Encoding"
    gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
    # text/html 始终会被压缩；图片永远不出现在这个列表里
}
```

容器里的真实抓包：

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8080/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Content-Type: text/html
Transfer-Encoding: chunked
ETag: W/"6acee911-c725"
Content-Encoding: gzip
Vary: Accept-Encoding

size_download=10799 time_total=0.002300

$ curl -s -o /dev/null -w 'size_download=%{size_download}\n' http://127.0.0.1:8080/
size_download=50981     # 未发送 Accept-Encoding：identity，无 Content-Encoding
```

51 KB 的页面以 10,799 字节过网。**nginx 的 brotli 是另一回事，下面是实话：stock nginx 无法提供 brotli。** 这个编解码器需要 Google 的 `ngx_brotli` 第三方模块（编译时 `--add-module=...`），官方镜像一概不含。为了这篇文章，我跑了一个真实的第三方构建——`fholzer/nginx-brotli` 镜像里的 `nginx/1.30.4`，编译参数含 `--add-module=/usr/src/ngx_brotli`——纯粹为了抓一个真实的 `Content-Encoding: br`：

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: br' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8082/
HTTP/1.1 200 OK
Server: nginx/1.30.4
Content-Type: text/html
Transfer-Encoding: chunked
ETag: W/"6acee911-c725"
Content-Encoding: br

size_download=8880 time_total=0.083235
```

同一页面，8,880 字节（比 gzip 的 10,799 小 17.9%）——用时 83 ms 而不是 2.3 ms。在 214 KB 的 JSON 上差距更刺眼：gzip 用 5.5 ms 送了 45,272 字节；即时 brotli -11 用 564 ms 送了 39,510 字节。两个数字就是全部取舍：更优的比例、百倍的 CPU，响应一开始动态、流量一大，这就是可用性问题。（我还验证了协商优先级：`Accept-Encoding: gzip, deflate, br` 的请求拿到 `br`。）

测试中我逮到一个值得转述的细节。那个镜像的基础配置在 `http` 级设了 `brotli_static on`，而磁盘上一个残留的 `bundle.js.br` 被以 0.55 ms 预压缩直出，当时我却以为在测即时 brotli。我发现的原因只有一个：51 KB 的 JavaScript 不可能半毫秒压完。把 `.br` 移开后，同一请求变成 88 ms。如果你的数字好得可疑，先查清是哪条代码路径产出的。

## 预压缩静态资源：我实际用的方案

对静态内容，最佳答案直接把 CPU 问题绕开：构建期压一次，服务时零成本。nginx 的 `gzip_static`（官方构建自带）和 brotli 构建的 `brotli_static` 会在原文件旁找 `file.ext.gz` / `file.ext.br`，在客户端接受时带上正确的 `Content-Encoding` 直出——不接受时回退到原文件：

```nginx
server {
    listen 8080;
    root /srv/site;
    gzip off;          # 没有按请求压缩
    gzip_static on;    # Accept-Encoding 允许时直出 bundle.js.gz
}
```

```bash
$ curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    -w 'size_download=%{size_download} time_total=%{time_total}\n' \
    http://127.0.0.1:8081/bundle.js
HTTP/1.1 200 OK
Content-Type: application/javascript
Content-Length: 16314
ETag: "6acee947-3fba"
Content-Encoding: gzip
Accept-Ranges: bytes

size_download=16314 time_total=0.000900
```

同一个文件在 brotli 构建上从 `bundle.js.br` 直出：`Content-Encoding: br`，14,802 字节，0.0008 s。用 gzip 的响应速度拿到 brotli 的比例——这就是静态站的甜点，也是我的构建流水线本该在每个已经产出 `.gz` 的资产旁再产出 `.br` 的原因。在它后面保留即时 `gzip on` 作为兜底，兜住任何漏掉预压缩的文件，并记住回退规则：两种编解码器都不接受时，原字节原样发出。

## 那么：brotli 还是 gzip——值不值？

实测之后，诚实的答案分三层：

- **默认档的 gzip：显然值。** 51 KB → 10.8 KB，约 3 ms CPU，白捡的便宜，而且支持是普适的。
- **动态内容上的即时 brotli -11：通常不值。** 少 10–18% 的字节，换每个响应多一个数量级的编码 CPU，高负载下是坏交易；何况 stock nginx 不编译第三方模块根本给不了。
- **静态资产预压缩 brotli：值，这才是真正的赢点。** 14,802 对预压缩 gzip 的 16,314，白多 9% 体积优势，服务成本同为约 0.6 ms，CPU 由构建一次性付掉。
  
一个来自回环测试的校准注记：本地链路上 gzip 响应反而比 identity *慢*（2.3 ms 对 0.7 ms），因为没有广域网可省。压缩恰好在字节昂贵的地方赢；在 40 ms RTT 的移动链路上，少 13% 的字节就是差别。

所以我实际发布的配置是：`gzip_static on` 加兜底的 `gzip on`（级别 6、`gzip_vary`），构建期同时产出 `.gz` 与 `.br`，排除图片，运行时不跑 brotli。以上全部真跑过——同样的文件、同样的容器、真实的响应头——这就是生产环境里 **brotli 与 gzip** 的全部故事。
