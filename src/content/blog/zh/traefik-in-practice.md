---
title: "Traefik 实战：配置来自 Docker labels"
description: "一次动手实践的 Traefik 走查：动态反向代理与 nginx 静态配置的区别，provider 如何喂给 routers、middlewares 和 services，用真实的 Traefik Docker labels 把容器接上路由，新容器上线时的 auto-discovery，实时 /api 输出，以及什么时候朴素的 nginx 更简单。"
pubDate: 2026-12-18
lang: zh
translationKey: traefik-in-practice
tags: [devops, nginx]
featured: false
keywords:
  - Traefik
  - Traefik Docker labels
  - 反向代理
  - auto-discovery
  - 中间件
---

大多数反向代理是“改文件、重载”配置出来的。**Traefik** 建立在相反的前提上：代理时刻盯着你的服务本来就在的地方——Docker、Kubernetes、服务注册中心——并从中推导出自己的路由配置。这意味着一个 **Traefik Docker labels** 部署里最重要的东西不是 `traefik.yml`，而是你已经在跑的容器身上的 label。为了把这件事讲实，我在一个一次性环境里手工搭了一套真实的**反向代理**：两个极小服务、一个监听 `127.0.0.1:18080` 的入口点，以及能在不重启的情况下发现全新容器的 **auto-discovery**。下面每一段输出都复制自我机器上一个 `traefik:v3.7.14` 容器，随后即被拆除。

如果你想先补齐静态代理的基础，我写在 [nginx 配置手册](/zh/posts/nginx-cookbook/)里了；自动 HTTPS 的对比则在 [Caddy vs nginx](/zh/posts/caddy-vs-nginx/)。

## Traefik 是动态反向代理，不是静态配置文件

nginx 是*静态*反向代理：你写 `server` 和 `location` 块，决定哪条路径去哪个上游，然后重载。配置描述的是你在编辑那一刻所理解的世界。Traefik 是*动态*的。你声明 **provider**（Docker、Kubernetes Ingress、Consul、file 等），Traefik 通过持续监听这些 provider 来维护一份实时世界模型。只要加一个带正确 label 的容器，一条路由一秒内就出现；删掉容器，路由随之消失。没有重载步骤，也没有每个服务一份配置文件。

这就是它的全部卖点，也是它的全部取舍。你拿“一份能从头读到尾的文件”换来了“一张由多方实时拼出的图”。Traefik 的任务就是让这张图可读——这正是 dashboard 和 API 之所以重要的原因。

## provider、routers、middlewares、services：词汇表

Traefik 的模型很小，其余一切都挂在它上面：

- **provider** —— 配置从哪来。本文用的是 `docker`，它从 Docker socket 上读取 label。
- **entrypoint** —— Traefik 监听的端口（例如 `web` 在 `:80`，`websecure` 在 `:443`）。
- **router** —— 一条规则（`Host(api.localhost)`、`PathPrefix(/api)`），在某个入口点上匹配请求并把它指向某个 service。
- **middleware** —— 在 router 与 service 之间施加的变换：去掉前缀、加响应头、限流、basic auth、重定向。
- **service** —— 流量真正去的地方：在若干容器之上的负载均衡。

<figure>
<svg viewBox="0 0 900 280" width="100%" role="img" aria-label="一个请求从客户端进入 Traefik 监听 web 80 端口的入口点，进入匹配 Host 规则的路由，经过一串中间件（stripPrefix、headers、ratelimit），最终到达由容器支撑的负载均衡服务。">
  <g font-family="system-ui, sans-serif" font-size="12.5" fill="currentColor">
    <text x="14" y="24">一个请求，五个对象</text>
  </g>

  <!-- clients -->
  <rect x="14" y="100" width="120" height="80" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="74" y="132">客户端</text>
    <text x="74" y="154" font-size="11.5" opacity="0.75">curl · 浏览器</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="134" y1="140" x2="176" y2="140"/>
    <path d="M170 135 L178 140 L170 145" fill="none"/>
  </g>

  <!-- entrypoint -->
  <rect x="176" y="90" width="150" height="100" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="#0f766e" text-anchor="middle">
    <text x="251" y="128">入口点</text>
    <text x="251" y="150" font-size="11.5">web :80</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="326" y1="140" x2="368" y2="140"/>
    <path d="M362 135 L370 140 L362 145" fill="none"/>
  </g>

  <!-- routers -->
  <rect x="368" y="30" width="180" height="220" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="458" y="54" text-anchor="middle">路由 routers</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9">
    <text x="382" y="88">Host whoami.localhost</text>
    <text x="382" y="116">Host api.localhost</text>
    <text x="394" y="134" opacity="0.7">+ PathPrefix /api</text>
    <text x="382" y="162">Host limited.localhost</text>
  </g>

  <!-- dashed link -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5" stroke-dasharray="4 4">
    <line x1="548" y1="140" x2="580" y2="140"/>
  </g>

  <!-- middlewares -->
  <rect x="580" y="30" width="160" height="220" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="660" y="54" text-anchor="middle">中间件 middlewares</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9">
    <text x="594" y="88">stripPrefix /api</text>
    <text x="594" y="116">headers + ratelimit</text>
    <text x="594" y="144">basicAuth · redirect</text>
  </g>

  <!-- arrow -->
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.8">
    <line x1="740" y1="140" x2="778" y2="140"/>
    <path d="M772 135 L780 140 L772 145" fill="none"/>
  </g>

  <!-- services -->
  <rect x="778" y="70" width="112" height="140" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="834" y="102">服务 services</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="11" fill="currentColor" opacity="0.9" text-anchor="middle">
    <text x="834" y="136">whoami</text>
    <text x="834" y="160">api</text>
  </g>
</svg>
<figcaption>Traefik 的请求路径：客户端打到**入口点**，**路由**匹配规则，路由上的**中间件**变换请求，最后由**服务**负载均衡到你的容器。在 Docker 里，这些对象每一个都可以来自一条容器 label。</figcaption>
</figure>

## Traefik Docker labels：实战中的 auto-discovery

这段跑在 `traefik:v3.7.14` 上，后端是 `traefik/whoami:v1.10.4`。先说一句实话：面对 Docker Engine 29，3.6 之前的 Traefik 会报 `client version 1.24 is too old`——它自带的 Docker 客户端不会协商新版 API。3.7 协商正常，所以这个实验用的是它。

### 静态的那一半：Traefik 自己的启动

Traefik 自身有一小段静态配置，写在命令行上。它说的是“用 Docker provider，入口点在这里”：

```bash
$ docker network create traefik-lab
$ docker run -d --name traefik-lab --network traefik-lab \
    -p 127.0.0.1:18080:80 -p 127.0.0.1:18090:8080 \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    traefik:v3.7 \
    --providers.docker=true \
    --providers.docker.exposedbydefault=false \
    --providers.docker.network=traefik-lab \
    --entrypoints.web.address=:80 \
    --api.insecure=true
```

两个 flag 承担了大部分分量。`--providers.docker.exposedbydefault=false` 意味着容器在被 `traefik.enable=true` 显式开启之前，对 Traefik 是*不可见*的——否则主机上每个容器都会变成一条路由。`--providers.docker.network` 把路由固定到某一个网络，这样 Traefik 才知道该连哪个容器 IP。注意这静态的一半**没有**提到我的任何服务。

### 动态的那一半：应用上的 label

通往第一个服务的路由完全住在容器身上。没有任何东西注册到 Traefik；这组 label *就是*注册：

```bash
$ docker run -d --name whoami --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.whoami.rule=Host(`whoami.localhost`)' \
    --label traefik.http.routers.whoami.entrypoints=web \
    --label traefik.http.services.whoami.loadbalancer.server.port=80 \
    traefik/whoami:v1.10
```

把 label 的键当成一条路径来读：`traefik.http.routers.<name>.<field>` 定义一个名为 `whoami` 的 router；`traefik.http.services.<name>.<field>` 定义一个 service。router 在 `web` 入口点上匹配 `Host(whoami.localhost)` 并转发给 service，后者的负载均衡指向本容器的 80 端口。Traefik 从 Docker socket 上发现它——没有重载命令，也没有 `-H UPSTREAM`。

### 一个真实请求，由 label 完成路由

请求这个 host，请求就落到了 whoami 容器上：

```bash
$ curl -s -H 'Host: whoami.localhost' http://127.0.0.1:18080/
Hostname: a57184410c76
RemoteAddr: 172.19.0.2:60162
GET / HTTP/1.1
Host: whoami.localhost
X-Forwarded-For: 172.19.0.1
X-Forwarded-Host: whoami.localhost
X-Forwarded-Port: 80
X-Forwarded-Proto: http
X-Real-Ip: 172.19.0.1
```

这些 `X-Forwarded-*` 头是 Traefik 的默认行为——它自动转发客户端 IP 和原始 host。在 nginx 里这四行要你自己写，忘了 `X-Forwarded-For` 就会悄无声息地破坏下游日志和限流。

### auto-discovery：不碰 Traefik 就加一个服务

回报出现在新容器冒出来的那一刻。我启动了第二个 whoami，只是换了个 host label，三秒后问 API 现在有几条 router：

```bash
$ docker run -d --name whoami2 --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.whoami2.rule=Host(`hello.localhost`)' \
    --label traefik.http.routers.whoami2.entrypoints=web \
    --label traefik.http.services.whoami2.loadbalancer.server.port=80 \
    traefik/whoami:v1.10

$ curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: hello.localhost' http://127.0.0.1:18080/
200
```

在 debug 日志里，这个容器的到来表现为现场构建出一个负载均衡器：

```text
Creating load-balancer entryPointName=web routerName=whoami2@docker serviceName=whoami2@docker
```

没有编辑任何东西，Traefik 也从未重启。这就是让 Traefik 在容器集群上讨人喜欢的 **auto-discovery**——也是它的配置散落在几十条 `docker run` 里、而非一个文件中的原因。

## 实际生效的中间件：stripPrefix、headers、ratelimit

中间件正是取代你原本要手写的那堆重复 `location` 块的东西。我只通过 label 就往上文第二个服务挂了三个：

```bash
$ docker run -d --name apisrv --network traefik-lab \
    --label traefik.enable=true \
    --label 'traefik.http.routers.api.rule=Host(`api.localhost`) && PathPrefix(`/api`)' \
    --label 'traefik.http.routers.api.middlewares=api-strip,secure-headers' \
    --label 'traefik.http.middlewares.api-strip.stripprefix.prefixes=/api' \
    --label traefik.http.middlewares.secure-headers.headers.framedeny=true \
    --label traefik.http.middlewares.secure-headers.headers.referrerpolicy=no-referrer \
    --label traefik.http.services.api.loadbalancer.server.port=80 \
    traefik/whoami:v1.10
```

`middlewares=api-strip,secure-headers` 这条 label 就是全部接线：具名中间件会按顺序施加到这条 router 匹配到的任何请求上。`stripPrefix` 在请求到达后端之前去掉 `/api`——容器看到的路径和客户端发出的不一样：

```bash
$ curl -s -H 'Host: api.localhost' http://127.0.0.1:18080/api/orders/42 | sed -n '4p'
GET /orders/42 HTTP/1.1
```

`headers` 中间件添加响应头。在纯 HTTP 上，HSTS 会被有意省略（它只在 TLS 上生效），但其余响应头确实落下：

```bash
$ curl -s -D - -o /dev/null -H 'Host: api.localhost' http://127.0.0.1:18080/api/ | grep -Ei 'referrer|x-frame'
Referrer-Policy: no-referrer
X-Frame-Options: DENY
```

`ratelimit` 同样只是一条 label。我把第三条 router 指向同一个 service，设 `average=1`、`burst=1`，然后连发五个请求：

```bash
$ for i in 1 2 3 4 5; do \
    curl -s -o /dev/null -w "request $i -> HTTP %{http_code}\n" \
      -H 'Host: limited.localhost' http://127.0.0.1:18080/; done
request 1 -> HTTP 200
request 2 -> HTTP 429
request 3 -> HTTP 429
request 4 -> HTTP 429
request 5 -> HTTP 429
```

一个请求通过，其余在令牌回填之前都被拒绝。同一家族里还有 `basicAuth`（接受 `htpasswd` 风格的用户列表）、用于 HTTP→HTTPS 和 `/old → /new` 的 `redirectScheme`/`redirectRegex`，以及 `compress`。它们声明方式都一样：`traefik.http.middlewares.<name>.<type>.<option>`。

## dashboard 与 API

因为配置是在运行时拼出来的，“现在到底配了什么？”需要一个实时答案。Traefik 同时提供 dashboard 和 JSON API。加上 `--api.insecure=true`，它们就在我发布出来的 API 端口上：

```bash
$ curl -s http://127.0.0.1:18090/api/http/routers | ... # 格式化后
api@docker       rule=Host(`api.localhost`) && PathPrefix(`/api`)  ep=web  mw=api-strip@docker,secure-headers@docker  svc=api
limited@docker   rule=Host(`limited.localhost`)                     ep=web  mw=api-ratelimit@docker  svc=api
whoami@docker    rule=Host(`whoami.localhost`)                     ep=web  mw=  svc=whoami
```

中间件和 service 来自同一个事实来源：

```bash
$ curl -s http://127.0.0.1:18090/api/http/middlewares
api-ratelimit@docker   type=ratelimit    {"rateLimit": {"average": 1, "burst": 1, "period": "1s"}}
api-strip@docker       type=stripprefix  {"stripPrefix": {"prefixes": ["/api"]}}
secure-headers@docker  type=headers      {"headers": {"frameDeny": true, "referrerPolicy": "no-referrer"}}

$ curl -s http://127.0.0.1:18090/api/entrypoints
traefik  address=:8080
web      address=:80
```

`@docker` 后缀告诉你一个对象来自哪个 provider——当 file provider 和 Docker 同时在线时很有用。在生产里你不会把 API 暴露在公网端口上；你会把 `dashboard@internal` 那条 router 放到 `basicAuth` 中间件和 TLS 后面。但在迁移期间，这个 API 是回答“这个 host 为什么 404”以及“到底哪条 router 管它”的最快方式。

## TLS 与 ACME，以及为什么 localhost 拿不到公网证书

Traefik 内置 **ACME**——无需 certbot、无需 cron，就能申请和续期 Let's Encrypt 证书。静态配置加上一个入口点、一个 resolver 和一个存储：

```bash
--entrypoints.websecure.address=:443
--certificatesresolvers.le.acme.email=you@example.com
--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
--certificatesresolvers.le.acme.httpchallenge.entrypoint=web
```

然后一条 router 用 `traefik.http.routers.<name>.tls.certresolver=le` 选择加入。有一个绕不过去的坑，值得直说：ACME 验证的是**你控制这个域名**，对 HTTP-01 挑战来说，它会去 `http://yourdomain/.well-known/acme-challenge/...` 取一个 token。没有任何公共 CA 会为 `localhost`、`*.localhost` 或私有 IP 签发证书，因为没人能证明自己拥有这些名字。这就是上文实验跑在纯 HTTP 上的原因——在那里做任何证书演示都是演戏。要真正跑通 ACME，你需要一个真实域名、有公共 DNS 记录指向一台在 80/443 上可达的主机；TLS-ALPN（443 端口）同理，仍然需要域名。对于一个并不公开的自托管名字，诚实的做法是私有 CA 或自家内部 PKI 签发的通配证书，而不是 Let's Encrypt。

## Traefik 出彩之处，以及 nginx 更简单的场景

当集群在动的时候我会伸手去拿 Traefik：几十个容器来来回回，路由应当跟随部署走，并且需要一个地方读到整张图。label 模型意味着服务是自描述的——删掉容器，它的路由和中间件一并消失，没有需要清理的孤儿配置。这确实比手工维护一份 nginx 上游列表要好。

但当集群小而稳定时，我依然会用朴素的 nginx。如果你只有一两个站点、一个静态文件服务器、复杂的 `try_files`/SPA 重写，或者一份同事已经烂熟于心的配置，Traefik 会多出一层间接——配置现在散落在容器 label 和一个实时 API 里，而不是一份你能 `grep` 的文件。[nginx 配置手册](/zh/posts/nginx-cookbook/)依然是我查 location 匹配细节的地方；而当你想要自动 HTTPS 又不想引入动态 provider 时，[Caddy vs nginx](/zh/posts/caddy-vs-nginx/) 是更友好的选项。

我用的一条简单规则是：**容器集群在动，用 Traefik；该稳稳躺着的配置，用 nginx。** 让前一种情况成立的正是 label——而当你亲眼看到 `Content-Type` 和 `X-Forwarded-For` 这些行来自一条 `docker run` 之后，“配置来自 label”就不再是宣传语，而是你能调试的东西了。
