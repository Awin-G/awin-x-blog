---
title: "nginx proxy_cache 实战：真正缓存你的上游"
description: "用真实请求跑通 nginx proxy_cache：对着一个会计数的上游演示 MISS→HIT、X-Cache-Status 排查、缓存键、bypass、stale 容错，以及 OSS 版 nginx 无法 purge 的坑。"
pubDate: 2027-01-09
lang: zh
translationKey: nginx-proxy-cache
tags: [nginx, devops]
featured: false
keywords:
  - nginx 缓存
  - X-Cache-Status
  - proxy_cache_path
  - 缓存命中 MISS
  - 缓存键
---

# nginx proxy_cache 实战：真正缓存你的上游

我给小上游写 nginx 配置时，最后都会撞到同一个问题：明明是同一份 JSON、同一个页面，为什么我的应用要一遍遍地生成，而不是让 nginx 直接记住答案？`proxy_cache` 就是干这个的——一个共享的、落在磁盘上的缓存，住在 nginx 自己身体里，挡在你的客户端和上游之间。

它不是浏览器缓存。浏览器缓存（`Cache-Control`、`ETag`、`Last-Modified`）把副本留在每个客户端上；`proxy_cache` 在服务器上留一份，所有客户端共享。如果你读过 [HTTP 缓存](/zh/posts/http-caching/)，你就知道故事里"头部驱动"的那一半——这篇是 nginx 这一半，而且我会用一个真实（但极小的）上游、真实的请求来演示，而不是教程里的截图。

读完你会看到：一个货真价实的 cache HIT/MISS 循环、`X-Cache-Status` 这个头部如何帮你排查、包含查询字符串和 Cookie 的缓存键、`proxy_cache_bypass` 和 `proxy_no_cache`、`proxy_cache_use_stale`，以及关于 nginx OSS 版 purge 的残酷真相。

## 一张图讲清楚

<figure>
  <svg viewBox="0 0 680 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="cache-diagram-title-zh" style="max-width:100%;height:auto">
    <title id="cache-diagram-title-zh">客户端把请求发给 nginx；nginx 在 HIT 时直接从磁盘缓存返回，在 MISS 时才回源</title>
    <defs>
      <marker id="arrow-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <rect x="20" y="70" width="150" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="95" y="112" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">客户端</text>
    <text x="95" y="136" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">浏览器 / curl</text>
    <rect x="265" y="40" width="180" height="160" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="355" y="68" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">nginx</text>
    <rect x="285" y="82" width="140" height="56" rx="8" fill="#0f766e" fill-opacity="0.12" stroke="#0f766e" stroke-width="1.5"/>
    <text x="355" y="106" text-anchor="middle" fill="currentColor" font-size="13" font-family="system-ui, -apple-system, sans-serif">proxy_cache</text>
    <text x="355" y="124" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">磁盘存内容 + 内存存键</text>
    <text x="355" y="164" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">X-Cache-Status: MISS / HIT</text>
    <rect x="540" y="70" width="120" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
    <text x="600" y="112" text-anchor="middle" fill="currentColor" font-size="16" font-family="system-ui, -apple-system, sans-serif">上游</text>
    <text x="600" y="136" text-anchor="middle" fill="currentColor" font-size="12" font-family="system-ui, -apple-system, sans-serif" opacity="0.65">你的应用</text>
    <line x1="170" y1="105" x2="260" y2="105" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow-zh)"/>
    <text x="215" y="95" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">请求</text>
    <line x1="445" y1="105" x2="535" y2="105" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow-zh)"/>
    <text x="490" y="95" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">仅 MISS 时</text>
    <line x1="535" y1="135" x2="445" y2="135" stroke="#0f766e" stroke-width="2" marker-end="url(#arrow-zh)"/>
    <text x="490" y="156" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">响应</text>
    <path d="M 265 152 C 210 172, 190 140, 172 128" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow-zh)"/>
    <text x="150" y="196" text-anchor="middle" fill="currentColor" font-size="11" font-family="system-ui, -apple-system, sans-serif">HIT：直接从缓存返回</text>
  </svg>
  <figcaption>MISS 时 nginx 回源并把响应存下来；HIT 时直接返回存好的字节，上游完全看不到这次请求。</figcaption>
</figure>

请求到达时，nginx 先查自己的缓存区。MISS 就代理到上游、把响应存起来；HIT 直接把存好的字节返回，根本不碰上游。上游只会看到第一次请求——以及你故意 bypass 掉的那些。

## 实验环境：一个会自己计数的上游

要证明缓存真的发生了，上游得会数数。整个上游就这么多——一个 30 行的 Python HTTP 服务，每收到一个请求就自增计数器：

```python
"""Throwaway origin for the proxy_cache demo."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

count = 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        global count
        count += 1
        if self.path == "/count":
            body = f"origin has served {count} request(s)\n".encode()
        else:
            body = f"origin served request #{count} path={self.path}\n".encode()

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))

        # NOTE: nginx refuses to cache responses with
        # Cache-Control: no-cache/no-store/private unless you set
        # proxy_ignore_headers. The first demo run sent "no-cache"
        # here and every request was a MISS - so this origin sends
        # no Cache-Control at all and lets proxy_cache_valid decide.
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence per-request logging
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
```

两个一次性容器，跑在私有 Docker 网络上（不用 sudo、只绑回环地址、官方镜像）：

```bash
docker network create cachelab
docker run -d --name origin --network cachelab \
  -v $PWD/origin.py:/app/origin.py:ro \
  python:3-alpine python /app/origin.py
docker run -d --name nginx --network cachelab -p 127.0.0.1:18099:80 \
  -v $PWD/nginx.conf:/etc/nginx/nginx.conf:ro \
  nginx:1.27-alpine
```

上游在网络里监听 `origin:8000`；nginx 在宿主机上通过 `127.0.0.1:18099` 访问。下面所有输出都是这个实验环境的真实结果。

## 真正干活的配置

```nginx
worker_processes  1;

error_log  /tmp/error.log warn;
pid        /tmp/nginx.pid;

events {
    worker_connections  1024;
}

http {
    default_type  application/octet-stream;
    sendfile        on;

    # Debugging gold: log the cache decision for every request
    log_format  cache  '$remote_addr [$time_local] "$request"'
                       'status=$status cache=$upstream_cache_status';
    access_log  /tmp/access.log cache;

    # --- the shared, on-disk cache -------------------------------------
    # /tmp/nginx-cache : where response bodies are written on disk
    # levels=1:2       : two directory levels, keeps directories small
    # keys_zone        : 10 MB of shared memory holding ~80k cache keys
    # inactive=60m     : untouched entries are evicted after 60 min
    proxy_cache_path  /tmp/nginx-cache levels=1:2
                      keys_zone=my_cache:10m inactive=60m use_temp_path=off;

    # --- what makes two requests "the same" ---------------------------
    proxy_cache_key  "$scheme$request_method$host$request_uri";

    upstream origin_srv {
        server origin:8000;
    }

    server {
        listen 80;
        server_name _;

        # visible on every response, cached or not
        add_header X-Cache-Status $upstream_cache_status always;

        # the origin's hit counter - bypassed on purpose, otherwise the
        # counter itself would be cached and could never go up again
        location = /count {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_bypass 1;
            proxy_no_cache     1;
        }

        # explicit "never cache this" demo endpoint
        location /bypass {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_bypass 1;
            proxy_no_cache     1;
        }

        # per-user cache: the cookie value becomes part of the key
        location /user {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_key    "$scheme$host$cookie_user$request_uri";
            proxy_cache_valid  200 30s;
        }

        location / {
            proxy_pass         http://origin_srv;
            proxy_cache        my_cache;
            proxy_cache_valid  200 302 10s;   # demo: very short!
            proxy_cache_valid  404 1m;
            proxy_cache_lock   on;           # one upstream fetch per key
            proxy_cache_use_stale  error timeout http_502 http_503 http_504;
        }
    }
}
```

挑大梁的是这四个指令：

- `proxy_cache_path`——缓存住在哪。`/tmp/nginx-cache` 是磁盘位置，`levels=1:2` 把文件拆到两级目录（防止单目录文件过多），`keys_zone=my_cache:10m` 划出 10 MB 共享内存存缓存键（约 8 万个），`inactive=60m` 淘汰一小时没人碰的条目。
- `proxy_cache my_cache`——在这个 location 上启用这个缓存区。
- `proxy_cache_valid 200 302 10s`——200/302 响应保鲜多久。十秒，因为这是演示；生产环境你会用分钟或小时，或者干脆让上游的 `Cache-Control: s-maxage` 说了算。
- `add_header X-Cache-Status $upstream_cache_status always`——调试神器，下面细说。

## MISS → HIT：盯着上游计数器看

第一次请求——nginx 什么都没有，于是回源并把响应存下来：

```bash
$ curl -si http://127.0.0.1:18099/api
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 20:26:20 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 35
Connection: keep-alive
X-Cache-Status: MISS

origin served request #1 path=/api
```

几秒后的第二次请求——同样的字节，但上游完全没被碰：

```bash
$ curl -si http://127.0.0.1:18099/api
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 20:26:20 GMT
Content-Type: text/plain; charset=utf-8
Content-Length: 35
Connection: keep-alive
X-Cache-Status: HIT

origin served request #1 path=/api
```

上游自己的计数器证明了这一点——nginx 把这个路径服务了两次，上游只见到一次：

```bash
$ curl -s http://127.0.0.1:18099/count
origin has served 2 request(s)
```

（是 2 不是 1：那次 MISS 回源，加上 `/count` 这个请求本身——它就是故意被 bypass 的，后面会讲。）

访问日志里放了 `$upstream_cache_status` 的 `log_format`，讲的是同一个故事：

```
172.19.0.1 [12/Oct/2026:20:26:20 +0000] "GET /api HTTP/1.1" status=200 cache=MISS
172.19.0.1 [12/Oct/2026:20:26:20 +0000] "GET /api HTTP/1.1" status=200 cache=HIT
172.19.0.1 [12/Oct/2026:20:26:28 +0000] "GET /count HTTP/1.1" status=200 cache=BYPASS
```

响应体也躺在磁盘上，就在 `levels=1:2` 的目录树里：

```bash
$ docker exec nginx ls -laR /tmp/nginx-cache
/tmp/nginx-cache:
total 12
drwx------    3 nginx    root          4096 Oct 12 20:26 .
drwxrwxrwt    1 root     root          4096 Oct 12 20:25 ..
drwx------    3 nginx    nginx         4096 Oct 12 20:26 9

/tmp/nginx-cache/9:
total 12
drwx------    3 nginx    nginx         4096 Oct 12 20:26 .
drwx------    3 nginx    nginx         4096 Oct 12 20:26 ..
drwx------    2 nginx    nginx         4096 Oct 12 20:26 31

/tmp/nginx-cache/9/31:
total 12
drwx------    2 nginx    nginx         4096 Oct 12 20:26 .
drwx------    3 nginx    nginx         4096 Oct 12 20:26 ..
-rw-------    1 nginx    nginx          551 Oct 12 20:26 827f13cf5e5e6860a3c2d3537cb62319
```

一个缓存条目一个文件，文件名是缓存键的 MD5。35 字节的正文占了 551 字节——剩下的是 nginx 的元数据（键、过期时间、响应头）。

### 先咬到我一口的坑

我第一版上游发了 `Cache-Control: no-cache`（为了让浏览器别缓存），结果每一个请求都是 MISS：

```
X-Cache-Status: MISS
origin served request #1 path=/api
X-Cache-Status: MISS
origin served request #2 path=/api
```

nginx 默认拒绝缓存带 `Cache-Control: no-cache`、`no-store` 或 `private` 的响应，除非你加上 `proxy_ignore_headers Cache-Control;`。实验环境里的修法是让上游干脆不发 `Cache-Control`，把决定权交给 `proxy_cache_valid`——但在生产环境，你要认得 `proxy_ignore_headers`（或者更好的做法：让上游发 `s-maxage`）这个旋钮。

## X-Cache-Status：告诉你真相的头部

`$upstream_cache_status` 在每个代理响应上都会设置，把它回显成 `X-Cache-Status` 是我所知道的、排查 nginx 缓存最有用的一个习惯：

| 状态 | 含义 |
| --- | --- |
| `MISS` | 不在缓存里（或不可缓存）；nginx 回源了 |
| `HIT` | 从缓存返回 |
| `EXPIRED` | 缓存条目过期；nginx 重新校验或重新拉取 |
| `BYPASS` | `proxy_cache_bypass` / `proxy_no_cache` 强制放行 |
| `STALE` | 上游挂了，于是返回过期条目（`proxy_cache_use_stale`） |
| `UPDATING` | 先返回过期条目，同时后台刷新 |
| `REVALIDATED` | 上游用 304 确认过期条目仍可用 |

看它在实验环境里跑完整个生命周期——十秒保鲜期过去之后：

```bash
$ curl -si 'http://127.0.0.1:18099/api?x=1'   # 12 秒后
X-Cache-Status: EXPIRED
origin served request #7 path=/api?x=1

$ curl -si 'http://127.0.0.1:18099/api?x=1'   # 紧接着再来一次
X-Cache-Status: HIT
origin served request #7 path=/api?x=1
```

`EXPIRED` 的意思是"新鲜副本没了，我回源拉了新的并缓存起来"——所以下一个请求又变回 HIT。如果你在期望 MISS 的地方看到 HIT，或者每个请求都是 MISS，第一个该查的就是这个头部。我的 [nginx  cookbook](/zh/posts/nginx-cookbook/) 里有把它放进访问日志的 `log_format` 写法。

## 缓存键里有什么

两个请求"相同"，当且仅当它们的缓存键相同。默认键是 `$scheme$proxy_host$request_uri`——而 `$request_uri` 包含查询字符串，实验环境可以作证：

```bash
$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: MISS
origin served request #3 path=/api?x=1

$ curl -si 'http://127.0.0.1:18099/api?x=2'
X-Cache-Status: MISS
origin served request #4 path=/api?x=2

$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: HIT
origin served request #3 path=/api?x=1
```

查询字符串不同 → 键不同 → 各自独立的缓存条目。这通常正是你想要的，但它同时也是投毒风险（后面细说）。

键可以按 location 调。实验环境里的 `/user` 端点把 Cookie 编进了键：

```nginx
location /user {
    proxy_pass         http://origin_srv;
    proxy_cache        my_cache;
    proxy_cache_key    "$scheme$host$cookie_user$request_uri";
    proxy_cache_valid  200 30s;
}
```

```bash
$ curl -si -H 'Cookie: user=alice' http://127.0.0.1:18099/user
X-Cache-Status: MISS
origin served request #5 path=/user

$ curl -si -H 'Cookie: user=bob' http://127.0.0.1:18099/user
X-Cache-Status: MISS
origin served request #6 path=/user

$ curl -si -H 'Cookie: user=alice' http://127.0.0.1:18099/user
X-Cache-Status: HIT
origin served request #5 path=/user
```

Alice 和 Bob 各拿各的条目；Alice 的第二次请求是 HIT。这是按用户缓存的正确姿势——而如果你忘了把 Cookie 放进键，把所有人的仪表盘缓存进同一个键，就是灾难。

还有一个和键有关的坑：nginx OSS 的键完全由 `proxy_cache_key` 拼成，`Vary` 头部*不参与*键。于是一个按 `Accept-Encoding` 或 `Cookie` 变化的响应可能被存进同一个键、发给错误的客户端。如果你的上游发 `Vary`，要么把变化的头部编进键（`$http_accept_encoding`），要么就别缓存那个响应。

## 故意绕过缓存

有些请求就是不能从缓存出——健康检查、计数器、登录后的管理页。两个指令干这件事：

- `proxy_cache_bypass <条件>`——条件非空且非 "0" 时，不从缓存读。
- `proxy_no_cache <条件>`——条件为真时，根本不把响应写进缓存。

两个一起用就是强制放行，状态变成 `BYPASS`。实验环境把它们用在 `/count` 上（否则计数器会把自己缓存住，永远不再涨），还有一个演示用的 `/bypass` 端点：

```nginx
location = /count {
    proxy_pass         http://origin_srv;
    proxy_cache        my_cache;
    proxy_cache_bypass 1;
    proxy_no_cache     1;
}
```

```bash
$ curl -si http://127.0.0.1:18099/bypass
X-Cache-Status: BYPASS
origin served request #8 path=/bypass

$ curl -si http://127.0.0.1:18099/bypass
X-Cache-Status: BYPASS
origin served request #9 path=/bypass

$ curl -s http://127.0.0.1:18099/count
origin has served 10 request(s)
```

两次 bypass 都打到了上游；缓存目录一个文件都没多。生产环境里条件通常是某个 Cookie 或头部——`proxy_cache_bypass $cookie_nocache;` 就是经典的"我说不缓存就不缓存"开关。

## 过期但诚实：proxy_cache_use_stale

条目过期时，nginx 默认会重新回源。但如果上游挂了，`proxy_cache_use_stale` 让 nginx 继续返回过期条目，而不是直接报错：

```nginx
proxy_cache_use_stale error timeout http_502 http_503 http_504;
```

我停掉上游容器，等十秒保鲜期过去：

```bash
$ docker stop origin
$ sleep 12
$ curl -si 'http://127.0.0.1:18099/api?x=1'
X-Cache-Status: STALE
origin served request #7 path=/api?x=1

$ curl -si http://127.0.0.1:18099/api
X-Cache-Status: STALE
origin served request #1 path=/api
```

上游已经没了，nginx 依然用最后一份"已知良好"的字节回答 200。对一个博客或读多写少的 API 来说，这是相当漂亮的失败模式。在列表里加上 `updating`、再配 `proxy_cache_background_update on;`，你就得到了类 stale-while-revalidate 的模式：客户端立刻拿到过期条目，同时有一个请求在后台刷新它。

## Purge：残酷的真相

有件事没人告诉你：**nginx OSS 版没有内置的缓存 purge。** 没有 `proxy_cache_purge` 这个指令。你的选项是：

- **删文件。** 缓存条目就是 `proxy_cache_path` 底下的普通文件；`rm` 掉对的那个（在文件里 `grep` 键来定位，或者干脆清空整个区）。粗暴但有效——而且只在没有请求正在写入时才安全。
- **缓存管理器。** nginx 自己就会淘汰过期条目，超过 `inactive` 的闲置条目也会被清掉。对很多站点来说，这就"purge 够了"。
- **njs 或第三方 `ngx_cache_purge` 模块。** 真正的 purge 能力，代价是一段脚本或一个模块。
- **短保鲜期 + stale。** 接受条目只活 `proxy_cache_valid` 那么久，让 `proxy_cache_use_stale` 填补空窗。

紧急情况下我用过不止一次删文件这个土办法；但我也学会了把键设计得让坏条目自己过期。

## 我真正担心的风险

给上游加缓存很容易；加得*安全*才是手艺。我见过（或险些踩到）的失败模式：

- **把按用户的数据缓存在共享键下。** 一个用户的仪表盘发给了另一个用户。如果内容随 Cookie 或登录态变化，键就必须包含它——或者这个 location 直接 bypass。
- **缓存了不该缓存的东西。** 登录后的页面、带 `Set-Cookie` 的响应、`Cache-Control: private` 的东西（nginx 默认不缓存这些——这也是上面那个坑咬到我的原因）。
- **通过键投毒。** 查询字符串和 Cookie 都在键里，于是客户端可以凭空造出无限多个唯一键（`?x=1`、`?x=2`……）把你的磁盘塞满。盯紧缓存体积，别缓存查询空间无上限的端点。
- **键太窄。** 去掉 `$host`，`www` 和裸域名就共用一条缓存；在需要查询字符串的 API 上把它丢掉，更是灾难。键是一份契约——把它写下来。
- **缓存区太小。** `keys_zone` 启动时就定死了；10 MB 大约装 8 万个键。按真实键数量定大小，否则条目会在保鲜期结束前就被挤掉。

这些都不是跳过 `proxy_cache` 的理由——它们是让你把 `X-Cache-Status` 放进日志、把 `proxy_cache_key` 写得能用一句话解释清楚的理由。

## 收尾

`proxy_cache` 离"给吃力的上游真正减负"只差三十行配置和一个头部：一个带 `keys_zone` 的 `proxy_cache_path`，location 上的 `proxy_cache` 加 `proxy_cache_valid`，`add_header X-Cache-Status $upstream_cache_status always`，以及一个记录每次判决的 `log_format`。盯住这个头部，尊重你的键，该 bypass 就 bypass，让 `proxy_cache_use_stale` 扛过上游宕机。至于 purge——提前规划好，因为 nginx OSS 不会替你做。
