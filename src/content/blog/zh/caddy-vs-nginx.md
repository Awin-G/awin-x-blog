---
title: "反向代理选 Caddy 还是 nginx：我到底会用哪个？"
description: "一份动手验证的 Caddy vs nginx 反向代理对比：同一个任务分别用两边写，真实的 curl -I 输出，HTTP/3 与压缩，TLS 证书处理（automatic HTTPS 对比 certbot），配置体量与易用性，以及一份决策清单。"
pubDate: 2026-12-11
lang: zh
translationKey: caddy-vs-nginx
tags: [nginx, devops, networking]
featured: false
keywords:
  - Caddy vs nginx
  - Caddy 反向代理
  - nginx 反向代理
  - automatic HTTPS
  - ACME
---

每隔几个月就有人问，是不是该把 **nginx** 换成 **Caddy**，而网上的答案大多是站队。两个我都用。nginx 是我配了十年的老将；Caddy 是我在“一个服务、一张证书、别折腾”时伸手去拿的新人。为了让 **Caddy vs nginx** 这个问题落到实处，我把**完全同一个**反向代理任务分别放到两边——一个极小的源站应用，两个代理各挡在前面，两边配置都从零写起——所有响应都真实保留。我对比了同样流量下 **nginx 反向代理**和 **Caddy 反向代理**的表现，让 **automatic HTTPS** 在一侧自动干活，另一侧的证书则由我手动接好。下面没有一条是我编的基准测试，全都是 `localhost` 上一次性容器里跑出来的 `curl` 输出。

如果你想看更深的 nginx 机制，我写在 [nginx 配置手册](/zh/posts/nginx-cookbook/)里了；这两个代理发出的缓存头，则是[HTTP 缓存详解](/zh/posts/http-caching/)的主题。

## Caddy vs nginx：老牌在位者 vs 好用新人

nginx 就是默认答案。它出现在每个发行版、每个 Kubernetes ingress controller、每篇教程，以及每个同事的记忆里。这不是小事——它意味着凌晨两点来调试你代理的那个人，多半本来就懂它。Caddy 的赌注不同：它认为难点从来不是吞吐，而是*配置和证书*。它自带 **automatic HTTPS**（内置 ACME，默认开启）、HTTP/3、合理的安全默认值，以及一套能把单服务部署写在餐巾纸上的配置语言。

所以真正的问题不是“谁更快”——一个应用挡在代理后面，两者都比你的应用快得多。真正的问题是“我想承担哪种失败模式”：是 TLS 续期和模块漂移，还是更小的生态。

## 同一个任务：nginx 反向代理

任务：为 `localhost` 终结 TLS，把所有请求代理到 `app:5678`，转发客户端 IP，压缩响应。这是 nginx 一侧，跑在 `nginx/1.27.5` 上：

```bash
$ docker run -d --name ngx --network rpnet \
    -p 127.0.0.1:18080:80 \
    -v "$PWD/nginx.conf":/etc/nginx/conf.d/default.conf:ro \
    nginx:1.27-alpine
$ docker exec ngx nginx -v
nginx version: nginx/1.27.5
```

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://app:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
```

HTTP 版本就是 13 行、344 字节。注意其中有多少是在*你*替代理交代它本可以合理假设的事：转发哪些头、上游用哪个 HTTP 版本。这里没有哪一行是错的——但每一行都是你要负责的决定，而漏掉 `X-Forwarded-For` 会悄悄搞坏下游的限流和日志。

## 同一个任务：Caddy 反向代理

Caddyfile，跑在 `caddy:2-alpine` 上，表达的是同一个意图：

```bash
$ docker run -d --name cdy --network rpnet \
    -p 127.0.0.1:18443:443 -p 127.0.0.1:18480:80 \
    -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro \
    caddy:2-alpine
$ docker exec cdy caddy version
v2.11.7 h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUTI=
```

```caddyfile
{
	admin 127.0.0.1:2019
}

https://localhost {
	tls internal
	encode gzip zstd
	reverse_proxy app:5678 {
		header_up X-Real-IP {remote_host}
	}
}
```

十一行、146 字节——而*真正的反向代理动作*只有一行。Caddy 从 `https://` 推断协议、打开压缩、设置标准的转发头，还在同一个监听上提供 HTTP/3。`tls internal` 是这里唯一让它没有在公网域名上自动抓取免费 Let's Encrypt 证书的原因。`admin` 块只是为了让我后面能戳它的 JSON API。

## 真实响应：两边各发回什么

这是客户端真正看到的东西。先看明文 HTTP 上的 nginx：

```console
$ curl -sS -I http://127.0.0.1:18080/
HTTP/1.1 200 OK
Server: nginx/1.27.5
Date: Mon, 12 Oct 2026 09:09:01 GMT
Content-Type: application/json
Content-Length: 186
Connection: keep-alive
```

再看 Caddy 用它自己签发的 TLS，后端相同：

```console
$ curl -sS -k -I https://localhost:18443/
HTTP/2 200
alt-svc: h3=":443"; ma=2592000
content-type: application/json
date: Mon, 12 Oct 2026 09:09:01 GMT
server: BaseHTTP/0.6 Python/3.12.14
via: 1.0 Caddy
content-length: 186
```

有两点很显眼。Caddy 直接用 **HTTP/2** 应答，并用 `alt-svc: h3=":443"` 宣告 **HTTP/3**——开箱即用，无需配置。明文 HTTP 上的 nginx 回的是 HTTP/1.1，因为 `http2` 是要显式开启的：在 server 块里加上 `http2 on;` 才能拿到 `HTTP/2 200`，但前提是你得知道要加。nginx 上的 HTTP/3 还需要一个带 QUIC 的构建，外加一个单独的 `listen ... quic reuseport;` UDP 块；Caddy 自带。

HTTP/3 在这里不是营销词。直接向 curl 要，它返回的就是 HTTP/3，而不是回退：

```console
$ curl -sS --http3-only -k -o /dev/null \
    -w 'http_version=%{http_version} code=%{response_code}\n' \
    https://localhost:18443/
http_version=3 code=200
```

压缩同理——一个指令，真实的字节：

```console
$ curl -sS -k -D - -o /dev/null -H 'Accept-Encoding: gzip' \
    'https://localhost:18443/big'
HTTP/2 200
content-encoding: gzip
vary: Accept-Encoding
content-length: 173
```

源站也能确认各自加了哪些转发头。nginx（由我配置）：

```console
$ curl -sS http://127.0.0.1:18080/demo
{
  "host": "127.0.0.1",
  "x_forwarded_for": "172.24.0.1",
  "x_forwarded_proto": "http",
  "x_real_ip": "172.24.0.1"
}
```

Caddy（默认头加上我那一行 `header_up`）：

```console
$ curl -sS -k https://localhost:18443/demo
{
  "host": "localhost:18443",
  "x_forwarded_for": "172.24.0.1",
  "x_forwarded_proto": "https",
  "x_real_ip": "172.24.0.1"
}
```

两组都是对的。区别在于：nginx 对，是因为我列了出来；Caddy 对，是因为那本来就是默认。

## TLS 证书处理：automatic HTTPS 对比 certbot

这是分歧最清楚的地方。Caddy 在首次启动时自己签发了证书，没有跑任何命令，还告诉了我它在哪：

```console
$ docker exec cdy find /data/caddy/certificates -type f
/data/caddy/certificates/local/localhost/localhost.crt
/data/caddy/certificates/local/localhost/localhost.key
/data/caddy/certificates/local/localhost/localhost.json
$ echo | openssl s_client -connect 127.0.0.1:18443 \
    -servername localhost 2>/dev/null | openssl x509 -noout -issuer
issuer=CN=Caddy Local Authority - ECC Intermediate
```

在公网域名上，`tls internal` 这一行是*唯一*要改的东西：Caddy 会跟 Let's Encrypt 走 **ACME**、完成挑战、存储并续期证书，并把 HTTP 重定向到 HTTPS——这个重定向它现在就已经在做（内网证书的情形也一样）：

```console
$ curl -sS -I http://127.0.0.1:18480/
HTTP/1.1 308 Permanent Redirect
Location: https://127.0.0.1/
Server: Caddy
```

nginx 自己不做这些。要提供 TLS，它需要显式的密钥材料和多几行指令；对外，它还需要一个 ACME 客户端（certbot、acme.sh、lego）外加一个续期定时器。我把 Caddy 刚生成的证书喂给了 nginx，以此公平地代替“磁盘上有证书文件”这件事：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name localhost;

    ssl_certificate     /etc/nginx/certs/localhost.crt;
    ssl_certificate_key /etc/nginx/certs/localhost.key;

    location / {
        proxy_pass http://app:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```console
$ curl -sS -k -I https://localhost:18444/
HTTP/2 200
server: nginx/1.27.5
content-type: application/json
content-length: 186
```

现在变成十六行，而且仍然没有证书签发、续期或 HTTP→HTTPS 重定向——那些都住在你 certbot 的 deploy hook 和日历里。这不是贬低，而是一种刻意的关注点分离。它同时也是真实的运维面：手工接线的续期有太多方式悄悄失败，这正是我写[规模化自动 TLS](/zh/posts/automated-tls-at-scale/)的原因。

## 配置语言易用性：Caddy vs nginx

nginx 的语言是一棵带作用域和继承规则的指令树，你得把它们记在脑子里——我 [nginx 手册](/zh/posts/nginx-cookbook/)里那个 `add_header` 继承陷阱，就是一条连老手都会踩的规则。它表达力强、速度快，但它是一门要学的语言。

Caddy 的更接近一句话：`reverse_proxy app:5678` 就是它字面的意思。需要看它编译成了什么时，JSON 就摆在眼前，能直接读：

```console
$ docker exec cdy wget -qO- http://127.0.0.1:2019/config/ | head -c 200
{"admin":{"listen":"127.0.0.1:2019"},"apps":{"http":{"servers":{"srv0":{
"listen":[":443"],"routes":[{"handle":[{"handler":"subroute",...
```

同一份 JSON 就是一套活的 **API**：`caddy reload` 在不重启的情况下换掉了配置，而 `caddy validate` / `nginx -t` 都能给你飞行前检查。

```console
$ docker exec ngxh2 nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
$ docker exec cdy caddy validate --config /etc/caddy/Caddyfile | tail -1
Valid configuration
```

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="柱状图对比表达同一个反向代理任务所需的配置行数：nginx 明文 HTTP 为 13 行，nginx 手动配 TLS 证书为 16 行，Caddy 配 TLS 与反向代理为 11 行，其中反向代理本身只占一行。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="16" y="26">同一个任务，三份配置（行数）</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <g fill="currentColor" opacity="0.9">
      <text x="16" y="66">nginx · HTTP</text>
      <text x="16" y="108">nginx · HTTPS</text>
      <text x="16" y="150">Caddy · HTTPS</text>
    </g>
  </g>
  <g fill="currentColor" opacity="0.28">
    <rect x="150" y="52" width="190" height="18" rx="4"/>
    <rect x="150" y="94" width="234" height="18" rx="4"/>
    <rect x="150" y="136" width="161" height="18" rx="4"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.9">
    <rect x="150" y="52" width="122" height="18" rx="4"/>
    <rect x="150" y="94" width="150" height="18" rx="4"/>
    <rect x="150" y="136" width="103" height="18" rx="4"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12">
    <text x="282" y="66">13 行 / 344 B</text>
    <text x="310" y="108">16 行</text>
    <text x="263" y="150">11 行 / 146 B</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">
    <text x="150" y="176">实心柱 = 整份文件 · 浅色柱 = 仅作比例参考</text>
    <text x="150" y="196">Caddy 的 reverse_proxy 本身只有一行；nginx 光转发头就花了五行。</text>
  </g>
</svg>
<figcaption>完全相同的反向代理任务下的配置体量，数据来自上面的文件（`wc -c -l`）。行数不等于质量——它代表你拥有、并且可能写错的那部分面积。</figcaption>
</figure>

## Caddy 赢在哪

- **automatic HTTPS。** ACME 的签发、续期和 HTTP→HTTPS 重定向都是默认，不是附加件。“90 天续期一直没触发”那一类事故基本消失。
- **配置又小又可读。** 常见场景一行搞定；抽象通常第一次就对上你的意图。
- **现代默认值。** HTTP/3 且自动用 `alt-svc` 宣告、HTTP/2、gzip/zstd，以及无需对照清单的安全响应头。
- **一套真正的 JSON API。** 配置热加载、可编程配置、机器可读的状态——当有别的系统来管理代理时，这确实好用。
- **单个二进制。** 没有一套模块要跟你发行版的构建去对齐。

## nginx 赢在哪

- **无处不在。** 到处都是它，所以帮助也到处都是，包括你旁边的同事，以及过去十年里每一个 Stack Overflow 答案。
- **原始性能与调优。** nginx 的 worker/事件模型、缓冲、缓存和上游控制更深、也更被反复研究。如果你要把很重的负载压过一台机器，那份深度就是产品本身。
- **模块与生态。** Stream（TCP/UDP）代理、Lua、njs、第三方模块，以及建立在它之上的各种 ingress controller。
- **成熟。** 二十年的边界情况早已被调过。Caddy 很稳，但更年轻，生态也更小。
- **规模化下的可预测性。** 团队已经统一在 nginx 上；引入第二个代理是有成本的。

## 我到底会用哪个？一份决策清单

- **一台机器、几个服务、只想让 TLS 直接能用？** Caddy。这就是它为它设计的场景。
- **你要在很多域名上自动拿证书，又不想接外部工具？** Caddy；比 certbot 加 deploy hook 少很多接线。
- **你现在就要 HTTP/3，且不想额外构建步骤？** Caddy。
- **你需要 Lua/njs、stream 代理或某个特定模块？** nginx。
- **你为最后百分之几的吞吐量调优，或者要扛很高的并发？** nginx。
- **你的团队、runbook、监控全都假设是 nginx？** 留在 nginx。一致性胜过优雅。
- **你已经对 certbot 加续期定时器很满意？** 没有理由迁移。“Caddy 更好看”本身不是重写一份能用配置的理由。
- **第一次学其中某一个？** 学 nginx，因为你一定会遇到它；也学 Caddy，因为它会让你知道好的默认值长什么样。

这就是实话：当我需要它的深度、或者团队本来就讲它时，我仍然伸手去拿 nginx；而对于一切又新又小的东西，我会伸手去拿 Caddy，让 **automatic HTTPS** 去干那件我以前要亲手自动化的事。
