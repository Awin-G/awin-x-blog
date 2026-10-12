---
title: "HTTP 范围请求详解：断点续传、206 Partial Content 与视频拖动"
description: "Accept-Ranges、Range、Content-Range、206 Partial Content 与 416 到底是干什么的，下载工具和视频播放器为什么离不开它们，If-Range 如何让断点续传在文件变化时依然安全，为什么动态生成的响应往往做不了范围请求，以及在 nginx 里怎么开启它（以及什么会把它弄坏）。"
pubDate: 2026-12-23
lang: zh
translationKey: http-range-requests
tags: [networking, nginx]
featured: false
keywords:
  - HTTP 范围请求
  - 206 Partial Content
  - 断点续传
  - Accept-Ranges
  - Content-Range
---

每次我在浏览器里把一个 4 GB 的 Linux ISO 暂停、合上笔记本、第二天再继续，我信任的其实是一小块 HTTP 协议：**HTTP 范围请求**。每次我在视频里拖动进度条，它立刻从文件中段接着播放、而不是重新下载一遍，靠的也是同一个机制。这是协议里最不起眼、却又承担最多重量的部分之一——CDN、包管理器、备份工具和视频播放器全都依赖它。下面讲这些响应头各自是什么意思、一次 **断点续传** 真正发出了什么，以及为什么把 URL 贴进一个“只会流式转发”的工具里，会悄悄弄坏拖动播放。

下面所有内容都是对着一个临时 nginx 实测的，它在 `127.0.0.1:18080` 上提供一个 2120 字节的文本文件，另有一个生成式响应服务器跑在 `127.0.0.1:18081`，所以响应头和状态码都是真实的。如果你想看与它相邻的响应侧缓存故事，请读 [HTTP 缓存](/zh/posts/http-caching/)。

## 一口气讲清 Accept-Ranges、Range、Content-Range、206 与 416

干活的只有五样东西：

- **`Accept-Ranges: bytes`** —— 服务器在宣告：我能提供文件的*一部分*。
- **`Range: bytes=100-199`** —— 客户端在请求第 100 到第 199 字节。
- **`206 Partial Content`** —— 状态码，意思是“这是那一小片，不是整个文件”。
- **`Content-Range: bytes 100-199/2120`** —— 这一片在整份文件里的位置：起点、终点、总大小。
- **`416 Requested Range Not Satisfiable`** —— “你想要的字节这里不存在。”

一个普通的 `GET` 就会宣告这个能力。nginx 对静态文件默认开启字节范围，所以 `Accept-Ranges: bytes` 直接就会出现：

```text
$ curl -si http://127.0.0.1:18080/report.txt
HTTP/1.1 200 OK
Server: nginx/1.31.6
Content-Type: text/plain
Content-Length: 2120
Last-Modified: Mon, 12 Oct 2026 10:31:45 GMT
ETag: "6accb711-848"
Accept-Ranges: bytes

line 01: the quick brown fox jumps over the lazy dog
```

这一个响应头就是全部邀请。看到它的客户端如果只想要文件的一部分，就可以精确地索取那一段。

## 一个字节范围就是一个偏移量，回来的是一份 206

发出明确的 `Range`，服务器就回 `206 Partial Content`，响应体是精确的 100 字节，而不是 2120 字节：

```text
$ curl -si -H 'Range: bytes=100-199' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Server: nginx/1.31.6
Content-Type: text/plain
Content-Length: 100
Last-Modified: Mon, 12 Oct 2026 10:31:45 GMT
ETag: "6accb711-848"
Content-Range: bytes 100-199/2120

y dog
line 03: the quick brown fox jumps over the lazy dog
line 04: the quick brown fox jumps over t
```

两个细节很重要。`Content-Range` 回显了这片数据的来处和整份文件的大小——`100-199/2120`。另外偏移量是从 0 开始的，所以 `bytes=100-199` 并*不是*从你能看到的第 100 个字符开始；它从字节 100 开始，而偏移 100 上的那个字节正是 `lazy` 里的 `y`。手写下载代码时在这个地方差一位，是经典 bug。

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="把从字节 0 到字节 2120 的文件画成一条水平长条。一段高亮色块覆盖字节 100 到 199，标注为 Range: bytes=100-199。一个箭头从色块指向响应框，框内标注 206 Partial Content，以及 Content-Range: bytes 100-199/2120 和 Content-Length: 100。">
  <g font-family="ui-monospace, monospace" font-size="13" fill="currentColor">
    <text x="10" y="30" font-size="14">服务器上的文件 —— 2120 字节</text>

    <rect x="10" y="46" width="680" height="46" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="16" y="74" font-size="12" fill-opacity="0.7">字节 0</text>
    <text x="636" y="74" font-size="12" fill-opacity="0.7">字节 2120</text>

    <rect x="42" y="46" width="32" height="46" fill="#0f766e" fill-opacity="0.85"/>
    <text x="34" y="120" font-size="12" fill-opacity="0.85">100</text>
    <text x="66" y="120" font-size="12" fill-opacity="0.85">199</text>
    <text x="34" y="140" fill="#0f766e" font-weight="bold">Range: bytes=100-199</text>

    <line x1="58" y1="146" x2="58" y2="176" stroke="#0f766e" stroke-width="1.6"/>
    <path d="M52 170 L58 180 L64 170" fill="none" stroke="#0f766e" stroke-width="1.6"/>

    <rect x="120" y="184" width="470" height="56" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="134" y="206" fill="#0f766e" font-weight="bold">206 Partial Content</text>
    <text x="134" y="226" fill-opacity="0.85">Content-Range: bytes 100-199/2120   ·   Content-Length: 100</text>
  </g>
</svg>
<figcaption>一个范围把文件中的一片（绿色）映射成一次 <code>206</code> 响应。<code>Content-Range</code> 响应头让客户端知道这一片属于哪里。</figcaption>
</figure>

## 下载工具和视频播放器为什么离不开它

两个日常功能直接出自范围请求。

**断点续传。** 一个正在下载 4 GB 文件的下载工具，在连接断开时不必从头再来。它保留已经写入的部分，然后只索取剩下的。`curl -C -` 正是这么做的——它读取部分文件的大小，把它变成一个 `Range` 请求头：

```text
$ curl -s -r 0-399 -o partial.bin http://127.0.0.1:18080/report.txt
$ curl -sv -C - -o partial.bin http://127.0.0.1:18080/report.txt
> GET /report.txt HTTP/1.1
> Host: 127.0.0.1:18080
> Range: bytes=400-
> User-Agent: curl/8.22.0
> Accept: */*

< HTTP/1.1 206 Partial Content
< Content-Type: text/plain
< Content-Length: 1771
< ETag: "6accb735-87b"
```

`Range: bytes=400-` 没有结束偏移，意思是“从字节 400 一直到结尾”。两段拼回去要逐字节一致，这才是真正的检验：续传之后，`cmp partial.bin report.txt` 的结果是 `identical`。

**视频拖动。** 视频播放器不会先下完整个文件才播放。它先请求开头，开始播放；当你往前拖时，它按新的偏移量再发一次范围请求——这就是“拖动”的本质。没有 `Accept-Ranges`，播放器只能线性下载，拖进度条要么没反应，要么强制重新拉取整个文件。这也是 MP4 的 “faststart” 很重要的原因：播放器希望索引（`moov` 原子）靠近字节 0，这样它才能判断该请求*哪一段*字节范围。

## If-Range：让断点续传在文件变化时依然安全

续传有一个很恶心的失败模式。你下载了 `app.tar.gz` 的一半，服务器在同一个 URL 上发布了新构建，而你的下载工具兴高采烈地把*新文件*从 500 MB 处往后的字节下载下来，拼到*旧文件*的前半段上。于是你得到一个校验失败、也毫无意义的损坏压缩包。

`If-Range` 堵住了这个洞。你把当初开始下载时缓存下来的校验器——**`ETag`** 或 **`Last-Modified`**——随范围一起发过去。如果校验器仍然匹配，你得到 `206`。如果文件已经变了，服务器会忽略范围，直接回 `200` 加上**整份新文件**，于是你被迫干净地重来，而不是把数据拼坏。

下面是匹配的情况，用的是原始响应里的 `ETag`：

```text
$ curl -si -H 'Range: bytes=0-9' -H 'If-Range: "6accb711-848"' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-9/2120
Content-Length: 10
ETag: "6accb711-848"
```

下面是当我在文件末尾追加一行、并发送现在已经过期的 `ETag` 时的结果——注意状态码翻成了 `200`，响应体是全新的 2171 字节整份文件：

```text
$ curl -si -H 'Range: bytes=0-9' -H 'If-Range: "6accb711-848"' http://127.0.0.1:18080/report.txt
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 2171
ETag: "6accb735-87b"
```

这就是那份契约：`If-Range` 是“盲目续传”和“只有在仍是同一个文件时才续传”之间的区别。如果你要写下载器，永远把校验器和那些部分字节存在一起。

## 为什么生成的响应通常做不了范围请求

不是每个 `200` 都支持范围，通常是因为响应是即时生成的。一个用 Python 流式产出、没有存下来的长度的动态处理器：

```text
$ curl -si -H 'Range: bytes=100-199' http://127.0.0.1:18081/
HTTP/1.1 200 OK
Server: BaseHTTP/0.6 Python/3.14.7
Content-Type: text/plain
Transfer-Encoding: chunked
X-Generator: dynamic-no-ranges

line 01: the quick brown fox jumps over the lazy dog
```

没有 `Content-Length`，没有 `Accept-Ranges`，响应体是 `Transfer-Encoding: chunked`——而 `curl -r 100-199` 报告 `http=200 size_download=2120`，也就是服务器把*整个*响应体都给了你，完全无视了范围。这是合法的：服务器可以忽略 `Range` 并直接回 `200`。但这样一来，你的下载工具没法续传，视频播放器也没法拖动。

要在生成式内容上支持范围，你得事先知道总长度、能够确定性地重建任意偏移处的数据，然后自己实现切片（或者交给框架里类似 `send_file` 的辅助函数）。如果内容是真正开放式的——事件流、LLM token 流、实时日志 tail——范围请求根本不适用，**流式传输才是正确答案**，而不是退而求其次的方案。流说的是“内容产生多少就给你多少”；范围说的是“给我那个我已经知道大小的东西的某个特定窗口”。

## 在 nginx 里开启它，以及什么会悄悄把它弄坏

对静态文件，nginx 开箱即用——没什么需要开启的。`Accept-Ranges: bytes` 会出现，`Range` 会被尊重，而一个格式错误或越界的范围会得到 `416`：

```text
$ curl -si -H 'Range: bytes=5000-6000' http://127.0.0.1:18080/report.txt | head -6
HTTP/1.1 416 Requested Range Not Satisfiable
Server: nginx/1.31.6
Content-Type: text/html
Content-Length: 197
Connection: keep-alive
Content-Range: bytes */2120
```

`416` 上的 `Content-Range: bytes */2120` 才是有用的部分——它告诉一头雾水的客户端文件真正的大小，好让它正确地重试。

范围请求失效的方式几乎总是下面这几种，值得了解，因为每一种看起来都像“服务器不支持范围”，而真正的原因却在它前面的某一层：

- **压缩。** 一旦应用了 gzip，线上的字节就不再是磁盘上的字节，偏移量对不上了。在一个强制 `gzip on` 的 location 上带 `Accept-Encoding: gzip` 请求同一个文件，`206` 就蒸发了：

  ```text
  $ curl -si -H 'Accept-Encoding: gzip' -H 'Range: bytes=100-199' http://127.0.0.1:18080/report.txt.gz | head -8
  HTTP/1.1 200 OK
  Content-Type: text/plain
  Transfer-Encoding: chunked
  ETag: W/"6accb711-848"
  Content-Encoding: gzip
  ```

  你得到的是 `200`、一个分块响应体、一个弱 `ETag`，而且没有 `Accept-Ranges`——nginx 在压缩时会刻意放弃范围支持，因为压缩流上的字节范围对客户端毫无意义。实际教训：永远不要对大媒体文件或压缩包做 gzip（反正也没用），也别指望经过一个会压缩的层还能断点续传。
- **分块响应 / 长度未知。** 就像 Python 那个例子展示的，没有 `Content-Length` 就没有东西可以作为范围的基准。
- **代理和缓存。** 一个把响应缓冲后以分块方式转发、剥掉 `Accept-Ranges`、或者丢掉 `Range` 请求头的反向代理或 CDN，会让它背后所有人都无法续传。当一个下载直连时能正常续传、经过 CDN 就不行时，用 `curl -I` 检查边缘上的响应头并做对比。
- **为拍脑袋的目标选错了文件类型。** 范围续的是*字节*，不是道歉。文件变了，只有 `If-Range` 能救你。

至于一套通用的 nginx 配置，这篇 [nginx cookbook](/zh/posts/nginx-cookbook/) 里有它能嵌进去的周边配置。

## 多范围请求：一次响应里要好几片

客户端可以一次索取多个范围，用逗号分隔。这就是 `multipart/byteranges`——一个 `multipart` 响应体，其中每一部分都带着自己的 `Content-Range`：

```text
$ curl -si -H 'Range: bytes=0-9,20-29' http://127.0.0.1:18080/report.txt
HTTP/1.1 206 Partial Content
Content-Type: multipart/byteranges; boundary=00000000000000000001
Content-Length: 220

--00000000000000000001
Content-Type: text/plain
Content-Range: bytes 0-9/2120

line 01: t
--00000000000000000001
Content-Type: text/plain
Content-Range: bytes 20-29/2120

rown fox j
--00000000000000000001--
```

注意顶层已经没有 `Content-Range` 了——它移到了每一部分的内部，而 `Content-Type` 里的 `boundary` 告诉客户端怎么把它们拆开。实践中多范围请求很少见：播放器通常一次只取一个范围，浏览器则可能拒绝或忽略它。认识它，是为了当某个工具真的用到时，不至于把它当成一个损坏的响应。

## 用 curl -r 做测试

检查一台服务器是否支持续传，最快的办法是 `curl -r`，它本质上就是打起来更方便的 `Range`：

- `curl -r 100-199 URL` → 字节范围。确认你看到 `206` 和那行 `Content-Range`。
- `curl -r 100- URL` → 开放式：字节 100 到结尾。这正是续传时发出的形式。
- `curl -r -100 URL` → **最后** 100 字节。检查一个文件的尾部时很好用。
- `curl -sI URL` → 在还没下载任何东西之前，先看 `HEAD` 里有没有 `Accept-Ranges: bytes`。
- `curl -C - -o file URL` → 续传到已有的部分文件里；检查它发的是 `Range: bytes=<size>-`。

对源站做一遍，*再*对源站前面的代理/CDN 做一遍。如果源站说 `Accept-Ranges: bytes` 而边缘没有，你就找到了下载在 CDN 后面总是重头开始的原因。范围请求就是这样一组干着巨大工作量的小小响应头，而它失败的地方几乎从来不在范围本身——而在响应往外走时经过的每一层东西。
