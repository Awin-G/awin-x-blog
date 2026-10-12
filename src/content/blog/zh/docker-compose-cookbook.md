---
title: "Docker Compose 实战手册：那些大家真正会做错的地方"
description: "一份动手写的 Docker Compose 实战手册：version 为什么是废弃字段、build 与 image 的区别、depends_on healthcheck 的启动顺序、具名卷与 bind mount、.env 与 env_file、secrets、profiles、资源限制，以及用 docker compose config 验证配置——全部配真实输出。"
pubDate: 2026-12-09
lang: zh
translationKey: docker-compose-cookbook
tags: [devops, self-hosting]
featured: false
keywords:
  - docker compose
  - compose.yaml
  - depends_on healthcheck
  - docker compose up
  - named volumes
  - 具名卷
  - 服务编排
---

我被人问到的 Docker Compose 问题，大多都不冷门。翻来覆去就是那十来个很小的误解：一个什么都做不了的 `version:` 字段、一个“不生效”的 `depends_on`、一个其实放错了地方的数据卷。所以我在本机搭了一套很小的栈——nginx 做边缘，前面是一个用 Redis 记访问次数的小 Python 应用——然后把 `docker compose up` 真正做的事记下来，输出原样贴进去。Docker 29.9.0、Compose v5.6.0，全程不用 `sudo`，所有端口只绑 `127.0.0.1`。下面这份 `compose.yaml` 就是我实跑的那份。如果你压根不想跑容器，我在[《不用 Docker 的自托管》](/zh/posts/self-hosting-without-docker/)里写了 systemd 加 nginx 那条路；这篇是另一条。

<figure>
<svg viewBox="0 0 760 330" role="img" aria-label="服务拓扑：客户端经 127.0.0.1:8080 访问 web，web 经 edge 网络代理到 app，app 经内网 backend 网络访问 redis，redis 把数据落到一个具名卷">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.4">
    <rect x="20" y="72" width="480" height="100" rx="10" stroke-dasharray="5 4" opacity="0.45"/>
    <rect x="270" y="186" width="480" height="104" rx="10" stroke-dasharray="5 4" opacity="0.45"/>
    <rect x="60" y="18" width="180" height="36" rx="8"/>
    <rect x="60" y="98" width="180" height="52" rx="8"/>
    <rect x="330" y="98" width="170" height="150" rx="8"/>
    <rect x="590" y="200" width="160" height="56" rx="8"/>
    <rect x="590" y="286" width="160" height="34" rx="8" stroke-dasharray="3 3"/>
  </g>
  <g fill="currentColor" stroke="currentColor" stroke-width="1.4" marker-end="url(#arw)">
    <line x1="150" y1="54" x2="150" y2="94"/>
    <line x1="240" y1="124" x2="326" y2="132"/>
    <line x1="500" y1="215" x2="586" y2="228"/>
    <line x1="670" y1="256" x2="670" y2="284"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" text-anchor="middle">
    <text x="150" y="41" font-size="12">curl 127.0.0.1:8080</text>
    <text x="150" y="129" font-size="15">web</text>
    <text x="415" y="178" font-size="15">app</text>
    <text x="670" y="233" font-size="15">redis</text>
    <text x="670" y="308" font-size="11">redis-data</text>
  </g>
  <g fill="currentColor" font-size="11" text-anchor="middle" opacity="0.85">
    <text x="285" y="113">proxy_pass app:8080</text>
    <text x="543" y="207">REDIS_HOST=redis</text>
  </g>
  <g fill="currentColor" font-size="12" opacity="0.7">
    <text x="32" y="90">network: edge</text>
    <text x="282" y="205">network: backend (internal: true)</text>
  </g>
</svg>
<figcaption>一套栈，两张网络。<code>app</code> 同时在两张网络上；<code>redis</code> 只看得见内网 backend。实线箭头是 TCP 调用，暴露给宿主机的只有 web 的 <code>127.0.0.1:8080</code>。</figcaption>
</figure>

## 现在的 compose.yaml 长什么样：只有 services，没有 version

Compose v1 的文件格式从 `version: "2"` 一路长到 `"3.8"`。这些字段已经死了。Compose 规范里必需的顶层字段只有 `services:` 一个，version 不在其中。验证这件事只要一条命令。先写一个带 `version:` 的文件：

```yaml
version: "3.8"

services:
  web:
    image: nginx:1.27-alpine
```

再看 Compose 拿它怎么办：

```console
$ docker compose -f compose.v1.yaml config
time="2026-10-12T17:08:33+08:00" level=warning msg=".../compose.v1.yaml: the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion"
name: compose-cookbook
services:
  web:
    image: nginx:1.27-alpine
    networks:
      default: null
networks:
  default:
    name: compose-cookbook_default
```

被忽略，附赠一条警告。取代旧顶层字段的是两样东西：项目名现在来自 `name:` 字段（或者目录名，或者 `COMPOSE_PROJECT_NAME`）；文件按惯例叫 `compose.yaml`——Compose 仍然接受 `docker-compose.yml`，但新文件直接叫 `compose.yaml` 就好。

## build 与 image：选一个真正的来源

只写 `image:` 意思是“拉镜像”。只写 `build:` 意思是“构建”，而 Compose 会自己编个名字，像 `compose-cookbook-app`。两个都写时，Compose 从 `build:` 构建，再把产物打上 `image:` 的标签——这才是生产里想要的，因为之后 `docker compose pull` 或者引用镜像仓库时，名字才真的能解析到。app 服务做的就是这件事：

```yaml
  app:
    build:
      context: ./app
    image: compose-cookbook/app:${TAG}
```

构建结束时打上了我要的标签：

```console
Successfully built f4ab273c31bf
Successfully tagged compose-cookbook/app:1.0
```

在它真正动手之前，先问 Compose 会用到哪些镜像：

```console
$ docker compose config --images
nginx:1.27-alpine
compose-cookbook/app:1.0
redis:7-alpine
```

一个环境上的提醒：这台机器缺 buildx 插件，于是 Compose 打印了 `buildx Docker CLI plugin not found: falling back to the classic builder`，然后照样构建成功。`build:` 并不是非 BuildKit 不可。

## depends_on healthcheck：有顺序不等于已就绪

这是最常见的抱怨，所以我说精确一点。光秃秃的 `depends_on` 只等依赖项的**容器**启动，不等里面的进程就绪。Redis 要花一点时间才绑上端口；nginx 或你的应用可能抢先跑，然后在第一次连接时崩掉。

`condition: service_healthy` 就是解药，而它需要一个 healthcheck 作为目标。两端都来自我的 `compose.yaml`：

```yaml
    depends_on:
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/health').read()"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s
```

现在看一次真实的 `docker compose up` 如何执行这条链。Compose 先启动 Redis，**等**，看到它健康，这才启动 app，再等一次，最后才启动 nginx：

```console
$ docker compose up -d --build
 Container compose-cookbook-redis-1 Starting
 Container compose-cookbook-redis-1 Started
 Container compose-cookbook-redis-1 Waiting
 Container compose-cookbook-redis-1 Healthy
 Container compose-cookbook-app-1 Starting
 Container compose-cookbook-app-1 Started
 Container compose-cookbook-app-1 Waiting
 Container compose-cookbook-app-1 Healthy
 Container compose-cookbook-web-1 Starting
 Container compose-cookbook-web-1 Started
```

那串 `Waiting` → `Healthy` → `Starting` 的阶梯，就是这个功能的全部。`docker compose up -d --wait` 更进一步，会阻塞到**所有**带 healthcheck 的服务都报健康为止，这是 CI 里最想要的。

两个值得知道的坑：启动慢的服务要加 `start_period`，否则最初几次失败就会消耗 `retries`；healthcheck 是按间隔轮询的，所以 `docker compose logs` 里会堆满探针请求——下面这些 `GET /health` 行是探针，不是真实流量：

```console
$ docker compose logs --tail 3
web-1  | 127.0.0.1 - - [12/Oct/2026:09:11:21 +0000] "GET /health HTTP/1.1" 200 3 "-" "Wget" "-"
web-1  | 127.0.0.1 - - [12/Oct/2026:09:11:26 +0000] "GET /health HTTP/1.1" 200 3 "-" "Wget" "-"
redis-1  | 1:M 12 Oct 2026 09:10:17.931 * Ready to accept connections tcp
```

## docker compose up：具名卷与 bind mount 的区别

两者都写在 `services.<name>.volumes` 下，但它们不是一回事，而 `docker compose config` 归一化之后会把区别摊开给你看：

```yaml
    volumes:
      - redis-data:/data
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
```

渲染成：

```console
      - type: volume
        source: redis-data
        target: /data
      - type: bind
        source: /tmp/opencode/work/compose-cookbook/nginx/default.conf
        target: /etc/nginx/conf.d/default.conf
        read_only: true
```

**具名卷（named volume）** 是 Docker 管理的存储，生命周期独立于任何容器。`docker compose down` 会把它留下，所以我的访问计数器跨过一整次拆栈还在往上走；只有 `-v` 才会删掉它：

```console
$ docker compose down            # counter survives, next request is visits=5
$ docker compose down -v
 Volume compose-cookbook_redis-data Removing
 Volume compose-cookbook_redis-data Removed
$ docker compose up -d --wait && curl -s http://127.0.0.1:8080/
visits=1
```

**bind mount** 是宿主机的路径，所以它自带宿主机的问题：文件属主是宿主机的 UID，而一个 `:ro` 挂载会让任何想改写它的程序出错。nginx 会直接告诉你：

```console
web-1 | 10-listen-on-ipv6-by-default.sh: info: can not modify /etc/nginx/conf.d/default.conf (read-only file system?)
```

在这里无害，但不知道原因就很迷惑。经验法则是：容器自己拥有的数据用具名卷，你在宿主机上编辑的配置和源码用 bind mount。

## environment、.env 与 env_file

三个不同的东西共用一个名字，于是永远有人搞混。

- 项目目录里的 `.env` 喂给的是 **Compose 自己的变量插值**（`${APP_PORT}`）。它从不进入容器。
- `environment:` 在 compose 文件里内联地给容器设变量。
- `env_file:` 把一份 `KEY=value` 文件加载进容器。

我的 `.env` 里放着 `APP_PORT=8080` 和 `TAG=1.0`，所以 `ports: ["127.0.0.1:${APP_PORT}:80"]` 解析成了真正的发布端口：

```console
    ports:
      - mode: ingress
        host_ip: 127.0.0.1
        target: 80
        published: "8080"
```

`env_file: [app.env]` 加内联的 `environment:` 会合并进容器的环境——`env_file` 提供默认值，冲突时 `environment` 赢：

```console
$ docker compose exec -T app env | grep -E 'COUNTER_KEY|REDIS_'
COUNTER_KEY=visits
REDIS_HOST=redis
REDIS_PORT=6379
```

最锋利的一处是变量未设置。Compose 警告一声、替换成空字符串，端口则悄悄丢掉了 `published` 值，而不是直接报错：

```console
$ docker compose -f bad-var.yaml config
level=warning msg="The \"NOT_SET_ANYWHERE\" variable is not set. Defaulting to a blank string."
...
      - mode: ingress
        host_ip: 127.0.0.1
        target: 80
        protocol: tcp
```

## secrets 与 environment：别再往环境变量里塞密码

环境变量不是密钥。`docker compose config` 会把每个环境变量的值明文打印出来——我那份里 `REDIS_HOST: redis` 一览无余——`docker inspect` 也一样。真正该保密的东西，Compose 有 `secrets:`。我给 Redis 配了个密码，把它作为文件挂载进去，Redis 和 app 都从 `/run/secrets/redis_password` 读：

```console
$ docker compose exec -T redis env | grep -iE 'pass|secret'
$ echo $?
1
$ docker compose exec -T redis ls -l /run/secrets/
total 4
-rw-r--r--    1 1000     redis           33 Oct 12 09:06 redis_password
```

环境里没有密码，而 `docker compose config` 只显示这个 secret 的**文件路径**，从不显示内容。老实说一句：在 Swarm 之外，Compose 的 secrets 只是从磁盘挂进来的文件——好处是结构性的，让值不进环境变量、不进 `inspect`，不是什么魔法加密。应用读这个文件后发 `AUTH`；Redis 用 `--requirepass "$(cat /run/secrets/redis_password)"` 启动。

## 网络与基于服务名的 DNS

每个项目都会拿到一张 `default` 网络，上面的容器之间可以用**服务名**互访。但所有东西挤一张网络，意味着你的前端也能直连数据库。我把它拆了：

```yaml
networks:
  edge:
  backend:
    internal: true
```

`web` 只在 `edge` 上；`redis` 只在 `backend` 上；`app` 两边都在。名字解析的规则是 `127.0.0.11` 上的内嵌 DNS，而且它只认识自己挂着的那些网络上的容器：

```console
$ docker compose exec -T web nslookup app
Name:	app
Address: 172.23.0.2
$ docker compose exec -T web nslookup redis
** server can't find redis: NXDOMAIN
```

那条 `NXDOMAIN` 正是网络隔离在起作用。至于它背后的 DNS 与 NAT 机制，见[《Docker networking 详解》](/zh/posts/docker-networking/)。

## profiles：只有在点名时才存在的服务

一个打了 `profiles: [debug]` 标签的 `debug-tools` 服务，在你点名那个 profile 之前都是隐形的。这就是把一次性工具放进同一个文件、又不让它们在线上跑起来的办法：

```console
$ docker compose config --profiles
debug
$ docker compose config --services
redis
app
web
$ docker compose up -d            # debug-tools is not created
$ docker compose --profile debug up -d
 Container compose-cookbook-debug-tools-1 Started
```

profiles 有个清理时才露头的陷阱：`docker compose down` 会忽略未激活的 profile，于是那个被 profile 包住的容器连同它的网络熬过了我第一次拆栈。要彻底删掉带 profile 的栈，得再点一次名——`docker compose --profile debug down -v`。

## 真正生效的资源限制

`deploy.resources.limits` 以前是 Swarm 专属。现在 Compose 在 `docker compose up` 时也会应用 `cpus` 和 `memory`，而 `docker stats` 会直接把上限显示出来：

```yaml
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 128M
```

```console
$ docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
NAME                             MEM USAGE / LIMIT
compose-cookbook-web-1           8.641MiB / 128MiB
compose-cookbook-redis-1         8.379MiB / 11.56GiB
```

web 容器被卡住了上限；没有 `deploy` 段的 Redis 显示的是宿主机总量。运行时也认同：

```console
$ docker inspect compose-cookbook-web-1 --format 'Memory={{.HostConfig.Memory}} NanoCpus={{.HostConfig.NanoCpus}}'
Memory=134217728 NanoCpus=500000000
```

## 上线前先用 docker compose config 验证

`docker compose config` 会把你文件完全解析、归一化后的最终版本渲染出来：插值已应用、profiles 已过滤、`depends_on` 已归一化、secrets 展开成路径。在任何东西启动之前，先在 CI 里跑它。它能抓到真实的错误。比如一张没定义的网络：

```console
$ docker compose config
service "web" refers to undefined network nope: invalid compose project
```

退出码非零，一个容器都没碰。这是整套工具链里最便宜的预检，而且当某个变量或某个 override 没按你想的生效时，答案也在这里。

## override 文件：compose.override.yaml 与 -f

Compose 会自动加载 `compose.yaml` 旁边的 `compose.override.yaml`。它就是给那些你不想提交进基础文件的本地微调准备的位置。我在里面加了一个端口和一个环境变量：

```yaml
services:
  web:
    ports:
      - "127.0.0.1:9090:80"
    environment:
      NGINX_ENTRYPOINT_QUIET_LOGS: "1"
```

列表会合并，所以两个端口都在——而陷阱在这儿：只有当你**不**自己传 `-f` 时，override 才会被加载。

```console
$ docker compose config | grep -E 'published|NGINX_ENTRYPOINT'
      NGINX_ENTRYPOINT_QUIET_LOGS: "1"
        published: "8080"
        published: "9090"
$ docker compose -f compose.yaml config | grep -E 'published|NGINX_ENTRYPOINT'
        published: "8080"
```

如果你的 `-f` 命令行和裸跑 `docker compose up` 行为不一样，原因就在这。要显式分层，就把每个文件都写出来：`docker compose -f compose.yaml -f compose.prod.yaml up -d`。

## 重启策略、运行时的 depends_on，以及 down -v

`depends_on` 编排的是**创建**顺序。那之后它什么都不做——依赖死掉时，它不会去重启被依赖方。我在自己的栈上做了两个实验来证明。把容器从 app 脚下抽走：

```console
$ docker inspect compose-cookbook-redis-1 --format '{{.HostConfig.RestartPolicy.Name}}'
unless-stopped
$ docker kill compose-cookbook-redis-1
$ docker compose ps -a --format 'table {{.Service}}\t{{.Status}}'
redis         Exited (137) 9 seconds ago
$ docker inspect compose-cookbook-redis-1 --format 'RestartCount={{.RestartCount}}'
RestartCount=0
```

没重启：`docker kill` 是一次**手动**停止，而 `unless-stopped` 和 `always` 都把手动停止当作终局。你也没法从容器内部模拟崩溃——内核会忽略发给容器命名空间里 PID 1 的 `kill -9`：

```console
$ docker exec sigtest sh -c 'kill -9 1'; docker inspect sigtest --format '{{.State.Status}}'
running
```

只有真正自行退出的进程才会触发策略。一个会失败的服务配上 `restart: on-failure`，计数如预期往上涨：

```console
$ docker inspect compose-cookbook-flaky-1 --format 'RestartCount={{.RestartCount}}'
RestartCount=6
```

所以：任何有状态的东西都用 `restart: unless-stopped`，同时记住它和 `always` 的差别只在守护进程重启那一刻——`always` 会把手动停掉的容器拉回来，`unless-stopped` 则让它保持停止。

## 一句话版本

`services:` 才是文件本体，`version:` 是噪音。`build` 与 `image` 一起写，构建才既可复现又可拉取。`depends_on` 配上 `condition: service_healthy` 才是唯一等**就绪**的编排，而且它只在创建时起作用。具名卷让数据熬过 `down`；bind mount 带来的是宿主机的权限。`.env` 是给 Compose 的，`env_file` 是给容器的，而 secrets 两者都不该进。网络免费送你服务名 DNS 和隔离。profiles 把工具挡在生产之外。在你相信以上任何一条之前，先跑 `docker compose config`，并且记住 `down -v` 会删掉具名卷而 `down` 不会。这就是整本手册——剩下的，不过是读懂 Compose 已经打印出来的输出。
