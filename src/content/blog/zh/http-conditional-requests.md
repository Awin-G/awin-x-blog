---
title: "HTTP 条件请求：ETag、304 Not Modified 与省带宽的正确姿势"
description: "条件请求让客户端在下载正文之前先问一句「变了吗」。用一次性 nginx 跑真实 curl 输出：ETag + If-None-Match 返回 304 Not Modified、正文 0 字节，If-Modified-Since 与 ETag 的对比，If-Match 返回 412 做乐观并发，以及 Range 返回 206 支持断点续传。"
pubDate: 2027-01-22
lang: zh
translationKey: http-conditional-requests
tags: [networking, nginx]
featured: false
keywords:
  - HTTP 条件请求
  - ETag
  - 304 Not Modified
  - If-None-Match
  - Last-Modified
---

你用过的每个浏览器，在下载文件之前都问过同一个问题：「我上次拿到之后，它变了吗？」这个问题正是 **HTTP 条件请求**的核心——客户端把自己已经持有的验证器发过去，服务器要么返回完整表示，要么返回一个极小的 `304 Not Modified`，意思是「没变，继续用你那份」。验证器有两对：`ETag` / `If-None-Match`（基于内容，强验证）和 `Last-Modified` / `If-Modified-Since`（基于时间，较弱）。我在 `127.0.0.1` 上跑了一个一次性的 nginx，为每种情况都抓了真实的 `curl -i` 输出——首个 `200`、条件请求的 `304`、`If-Match` 的 `412 Precondition Failed`、`Range request` 的 `206`——并在网线上实测了省下的字节数。理论部分见 [HTTP 缓存](/zh/posts/http-caching/)；这里我们只看网线上发生了什么。

## HTTP 条件请求到底是什么

普通的 `GET` 是无条件的：即使客户端十秒之前刚拿到过一份一模一样的副本，服务器也会把完整正文再发一遍。条件请求把问题反过来——「只有在这个条件成立时才把正文给我」。读操作用 `If-None-Match: <etag>`（「除非当前 ETag 匹配，否则发给我」）和 `If-Modified-Since: <date>`（「除非在这个日期之后变过，否则发给我」）；写操作用 `If-Match: <etag>` 和 `If-Unmodified-Since: <date>`（「只有当它仍然是我读到的那个版本时才执行我的写入」）。服务器的回答只有三种：完整的 `200 OK` 正文、没有正文的 `304 Not Modified`，或者——对写操作——条件不成立时的 `412 Precondition Failed`。

## ETag 与 If-None-Match：省下正文的验证器对

`ETag` 是服务器给某个表示附上的一个不透明令牌；客户端把它回显在 `If-None-Match` 里。先看我的一次性 nginx 上的首个请求，文件 180,000 字节：

```console
$ curl -s -D - -o /dev/null http://127.0.0.1:8080/payload.txt
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:13 GMT
Content-Type: text/plain
Content-Length: 180000
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
Accept-Ranges: bytes
```

注意默认的 ETag 格式 `"<hex mtime>-<hex size>"`（`2bf20` 就是 180000 的十六进制），以及响应同时带上了两个验证器。现在发条件请求，把 ETag 回显回去：

```console
$ curl -s -D - -o /dev/null -H 'If-None-Match: "6acd98cd-2bf20"' http://127.0.0.1:8080/payload.txt
HTTP/1.1 304 Not Modified
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:47 GMT
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
```

没有 `Content-Length`，没有正文——响应在头部之后就结束了。

## 304 Not Modified：几乎不花成本的响应

`304 Not Modified` 就是这一切的意义所在：服务器确认「你那份还是好的」，却一个字节都不用重发。它可以带上更新的验证器和新鲜度头部，让客户端刷新缓存元数据，但没有正文，也没有 `Content-Length`。用 `curl -w` 实测：

```console
$ curl -s -o /dev/null -w 'body=%{size_download} header=%{size_header}\n' http://127.0.0.1:8080/payload.txt
body=180000 header=244
$ curl -s -o /dev/null -w 'body=%{size_download} header=%{size_header}\n' -H 'If-None-Match: "6acd98cd-2bf20"' http://127.0.0.1:8080/payload.txt
body=0 header=182
```

每次轮询，正文从 180,000 字节降到零。对一个每五秒轮询一次 API 的仪表盘，或者一个回源校验热门资源的 CDN 边缘节点来说，这就是带宽账单和噪音的区别。

<figure>
<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="First request downloads 180000 bytes; a conditional request with If-None-Match downloads 0 bytes">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="8" y="8" width="296" height="224" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="156" y="34" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="currentColor">1. First request</text>
  <text x="40" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">GET /payload.txt</text>
  <line x1="40" y1="94" x2="272" y2="94" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="40" y="132" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">200 OK</text>
  <text x="40" y="152" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">body: 180,000 B</text>
  <line x1="272" y1="164" x2="40" y2="164" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <rect x="336" y="8" width="296" height="224" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <text x="484" y="34" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" fill="currentColor">2. Conditional request</text>
  <text x="368" y="80" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">GET + If-None-Match</text>
  <line x1="368" y1="94" x2="600" y2="94" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="368" y="132" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">304 Not Modified</text>
  <text x="368" y="152" font-family="ui-monospace,monospace" font-size="12" fill="currentColor">body: 0 B</text>
  <line x1="600" y1="164" x2="368" y2="164" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="484" y="212" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="#0f766e">180,000 B saved per poll</text>
</svg>
<figcaption>首个请求为完整正文买单；条件请求只为头部买单。</figcaption>
</figure>

## Last-Modified 与 If-Modified-Since：更老、更弱的兄弟

基于时间的那一对工作方式一样：把存下的 `Last-Modified` 回显在 `If-Modified-Since` 里，没变的资源同样得到没有正文的 `304`：

```console
$ curl -s -D - -o /dev/null -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:53 GMT' http://127.0.0.1:8080/payload.txt
HTTP/1.1 304 Not Modified
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:36:47 GMT
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
```

那为什么 `ETag` 更强？三个原因：

1. **一秒的分辨率。** HTTP 日期只有秒级粒度；一个文件在一秒内被保存两次，对 `If-Modified-Since` 来说是「没变」，对任何基于内容的 `ETag` 来说却是「变了」。
2. **mtime 很脆弱。** `rsync`、`git checkout`、一次重新部署，都可能在内容不变的情况下改动 mtime——也可能在内容变化时保留 mtime。基于内容的 ETag 两种情况都扛得住。
3. **不依赖时钟。** `If-Modified-Since` 比较的是两个时钟；ETag 比较的是令牌。

nginx 还可以调节日期比较的严格程度。默认的 `if_modified_since exact` 要求日期与 `Last-Modified` 精确到秒匹配；而 `before` 时，任何等于或晚于 mtime 的日期也会返回 `304`。同一个文件、同一个请求，只是日期加了一秒：

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:54 GMT' http://127.0.0.1:8080/payload.txt
200
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'If-Modified-Since: Tue, 13 Oct 2026 02:34:54 GMT' http://127.0.0.1:8080/lenient/payload.txt
304
```

第二个 location 设置了 `if_modified_since before;`。当客户端会对时间戳做取整或补齐时可以用它——但它比 RFC 要求的更宽松，可能把这一秒内发生的真实变化掩盖掉。

## If-Match 与 412：写操作的乐观并发

条件请求不只是读。更新资源时你可以说「只有当它仍然是我读到的那个版本时才执行」——这就是 `If-Match`，它让两个编辑者不会互相静默覆盖。服务器把 `If-Match` 与当前 ETag 比较：匹配，写入继续；不匹配，你会得到 `412 Precondition Failed`，什么都不会被写入。

nginx 的 WebDAV 模块并不计算 `If-Match`（我查了 1.27.5 的源码），所以这个演示用了一个跑在 `127.0.0.1:8081` 上的微型一次性参考服务器：

```console
$ curl -s -i -X PUT -d 'x' -H 'If-Match: "wrong-etag"' http://127.0.0.1:8081/payload.txt
HTTP/1.1 412 Precondition Failed
Server: BaseHTTP/0.6 Python/3.13.16
Date: Tue, 13 Oct 2026 02:41:08 GMT
Content-Type: text/plain
Content-Length: 67

Precondition Failed: If-Match ETag does not match current resource
```

匹配的情况符合预期——`If-Match: *` 和正确的 ETag 都成功；缺少 `If-Match` 会得到 `428`：

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' -H 'If-Match: *' http://127.0.0.1:8081/payload.txt
204
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' -H 'If-Match: "6acd98cd-2bf20"' http://127.0.0.1:8081/payload.txt
204
$ curl -s -o /dev/null -w '%{http_code}\n' -X PUT -d 'x' http://127.0.0.1:8081/payload.txt
428
```

这个检查是强比较：按逗号拆分、去掉空白、接受 `*` 或完全匹配。在生产环境里，这套逻辑住在你的框架里（Rails、Django、Spring 都有）；直接接进 nginx 的话，`if ($http_if_match != '"..."') { return 412; }` 可以覆盖单个已知 ETag 的场景。`If-Unmodified-Since` 是基于时间的兄弟，同样有一秒分辨率的坑。

## Range 请求与 206：断点续传

`Range request` 问的是另一个问题——不是「变了吗」，而是「只给我这些字节」。nginx 用 `206 Partial Content` 和一个 `Content-Range` 头部回答，明确说明来的是哪一片：

```console
$ curl -s -D - -o /dev/null -H 'Range: bytes=0-99' http://127.0.0.1:8080/payload.txt
HTTP/1.1 206 Partial Content
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:37:37 GMT
Content-Type: text/plain
Content-Length: 100
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
ETag: "6acd98cd-2bf20"
Content-Range: bytes 0-99/180000
```

100 字节而不是 180,000——实测 `body=100 header=266`。这就是下载可以断点续传（curl `-C -`）的原因，也是视频播放器不用缓冲整个文件就能拖动进度条的原因。两种机制可以组合：`If-Range` 让客户端用 ETag 来条件化 Range 请求，这样一个落在已变更文件上的续传会拿到完整的 `200`，而不是一片静默错误的数据。完整的 nginx 调优见 [nginx cookbook](/zh/posts/nginx-cookbook/)。

## nginx（和 CDN）如何处理条件请求

nginx 开箱即用就几乎全对：它为静态文件发出 `ETag` 和 `Last-Modified`，识别 `If-None-Match` 和 `If-Modified-Since`，并声明 `Accept-Ranges: bytes`。你真正会碰的两个旋钮：

```nginx
server {
    listen 8080;
    root /srv/www;

    location /noetag/ {
        etag off;                  # drop ETag, keep Last-Modified
    }

    location /lenient/ {
        if_modified_since before;  # 304 even when mtime < given date
    }
}
```

`etag off` 更值得说。加上它之后，同一个文件返回时完全没有 `ETag`——只剩 `Last-Modified` 当验证器：

```console
$ curl -s -D - -o /dev/null http://127.0.0.1:8080/noetag/noetag.txt
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Tue, 13 Oct 2026 02:40:51 GMT
Content-Type: text/plain
Content-Length: 180000
Last-Modified: Tue, 13 Oct 2026 02:34:53 GMT
Connection: keep-alive
Accept-Ranges: bytes
```

在会改写响应的负载均衡器后面，这是个合理选择，但它会静默地把所有客户端降级到更弱的验证器。CDN 缓存的是*验证器*，不只是正文：边缘节点可以用从源站缓存下来的 `304` 回答 `If-None-Match`，于是连头部字节都不用跨骨干网；只有当边缘副本真的过期时，源站才会被问到。

## 我在实战中见过的常见错误

**只用 mtime 生成 ETag。** nginx 默认的 `"<hex mtime>-<hex size>"` 本来就基于 mtime；自己再撸一个只看 mtime 的 ETag 更糟。两台后端提供相同内容却产生不同 ETag，负载均衡的客户端就会缓存命中失败、多收一堆 `200`。对内容做哈希，或者至少把 size 和 inode 也带上。

**该用强 ETag 的地方用了弱 ETag。** 弱 ETag（`W/"..."`）表示「语义等价」，不是「字节一致」。用在 `GET` 的 `If-None-Match` 上没问题，但绝不能用在写操作的 `If-Match` 或 `If-Range` 上——续传一个「语义等价」的文件可能是损坏的。写操作要用强比较。

**缓存发去过期的 304。** `304` 的可信度取决于它背后的验证器。如果你的源站用 mtime 算 ETag，而部署流程会 touch 文件却不改内容，客户端就永远收到 `304`，永远看不到新内容。把你实际发出去的验证器记下来，在金丝雀检查里和内容哈希做 diff。

**在健康检查里把 304 当成「请求成功了」。** `304` 的意思是「你缓存的那份是好的」，这对一个*全新*客户端会拿到什么正确字节只字未提。需要真相时，用不带条件头部的冷请求去探测。

## 结语

条件请求是「永远全量下载」和「先证明它变了」之间的差别。把存下的 `ETag` 放进 `If-None-Match` 发出去，你就能得到一个没有正文的 `304 Not Modified`——按我的实测，每次轮询省下 180,000 字节，在 CDN 规模下是同样的数学。`Last-Modified`/`If-Modified-Since` 留作兜底，写操作用 `If-Match`，只需要文件一部分时用 `Range`。验证器很小，它们省下的带宽不小。
