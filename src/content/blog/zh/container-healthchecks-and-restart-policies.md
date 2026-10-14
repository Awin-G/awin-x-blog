---
title: "Docker 健康检查：健康状态不等于在运行"
description: "Docker healthcheck 到底在检查什么——全程真实运行：从 docker inspect 读出 starting → healthy → unhealthy 的状态迁移，为什么不健康的容器不会自己重启，各重启策略在崩溃和 docker stop 之后的真实表现，崩溃循环的退避，以及 compose 的 service_healthy。"
pubDate: 2027-02-10
lang: zh
translationKey: container-healthchecks-and-restart-policies
tags: [devops]
featured: false
keywords:
  - Docker 健康检查
  - healthcheck
  - 容器健康
  - 重启策略 restart policy
  - service_healthy
  - start-period
---

一个容器完全可以 `Up 40 seconds`，同时毫无用处。进程活着，端口绑着，`docker ps` 看着一切正常——而每个请求都返回 503。我排查过太多次这种形态的故障，现在已经不再把“在运行”当作健康信号。Docker 为运维唯一真正该问的问题提供了另一套机制：这个容器在干正事吗？这套机制就是 **Docker healthcheck（健康检查）**，而“在运行”和“健康”之间的缝隙，就是整个下午被耗掉的地方。这篇不是文档摘要，而是一次真实运行：我造了一个容器，它先健康、再腐坏、再自愈、再崩溃、最后崩溃循环，并把 Docker 每一步的真实说法原样贴上。Docker 29.9.0，全程不用 `sudo`，端口只绑 `127.0.0.1`。compose 本身的搭建——网络、卷、`.env`——见[Docker Compose 实战手册](/zh/posts/docker-compose-cookbook/)，这篇只讲健康信号。

## HEALTHCHECK 到底检查什么

Docker 按一个间隔在容器**内部**运行**你指定的**命令。退出码 0 → 一次健康探测。非零退出，或探测超过超时时间 → 一次失败探测。全部机制就这么简单：一条来自容器内部的可活性判断，由你选的命令产生。

没有它，容器健康只意味着一件事：“PID 1 存在”。这个测试抓不到任何东西。挂死的 HTTP 服务、写满的磁盘、断掉的数据库连接、指向已下线后端的配置——它们全都是 `running`。健康检查之所以存在，正因为 `running` 和 `useful` 是两个不同的命题。

## 演示：一个不死进程，一个能弄坏的后端依赖

为了把差别摆到台面上，我要一个进程永远不死、但后端依赖可以随时候弄坏的容器。一个很小的 Python 应用就够——`/healthz` 只在它的依赖可达时返回 200：

```python
# app.py — 进程一直活着；依赖可以在运行期被弄坏
import http.server, pathlib, time

DOWN = pathlib.Path("/tmp/backend-down")   # POST /break 创建，/heal 删除
WARMUP = 6.0                               # 假装启动很慢
STARTED = time.time()

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def _reply(self, code, body):
        self.send_response(code); self.send_header("Content-Type", "text/plain")
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/healthz":
            if DOWN.exists() or time.time() - STARTED < WARMUP:
                self._reply(503, b'dependency "payments" not ready\n')
            else:
                self._reply(200, b"ok\n")
        elif self.path == "/":
            self._reply(200, b"app process alive\n")
        else:
            self._reply(404, b"nope\n")
    def do_POST(self):
        if self.path == "/break": DOWN.touch(); self._reply(200, b"broken\n")
        elif self.path == "/heal": DOWN.exists() and DOWN.unlink(); self._reply(200, b"healed\n")
        else: self._reply(404, b"nope\n")
    def log_message(self, *a): pass

http.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()
```

再看健康检查命令本身——注意它**不**做什么。它不检查进程是否存在，它也不是 `CMD ["true"]`：

```sh
# health.sh — 退出 0 = 健康，其它 = 不健康
wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz
```

三个性质让它成为一个*好*检查：它打的是一个真实依赖端点；它很便宜（走 loopback，几毫秒——它要永远按间隔跑下去）；它失败得很响——503 会让 `wget` 非零退出，健康日志里还会记下服务器的错误原文。`CMD ["true"]` 是一个永远不会被识破的谎言；`pgrep python` 只是把 Docker 已经知道的事再测一遍。这个检查说到底也是按计划在容器里运行的任意代码——对它要和对镜像里任何代码一样的警惕（这个信任边界我写在[《容器安全基础》](/zh/posts/container-security/)里）。

写进镜像，并给一套合理的默认值：

```dockerfile
FROM python:3.13-alpine
WORKDIR /srv
COPY app.py health.sh ./
RUN chmod +x health.sh
EXPOSE 8080
CMD ["python", "app.py"]

# interval: 每 3s 探测一次 | timeout: 探测超过 2s 算失败
# retries: 连续失败 3 次 -> unhealthy | start-period: 慢启动宽限期
HEALTHCHECK --interval=3s --timeout=2s --retries=3 --start-period=5s CMD ["./health.sh"]
```

这四个值都有对应的 CLI 参数，且会覆盖镜像默认值——下面就是我实际跑的：

```console
$ docker run -d --name hc1 -p 127.0.0.1:8080:8080 \
    --health-interval=2s --health-retries=3 --health-start-period=5s \
    hc-demo:local
```

## 状态机：starting、healthy、unhealthy

容器一启动，探测就开始。在 `start-period` 期间，失败是被**原谅**的——它们不计入 `retries`，这正是慢启动应用不被误伤的原因。启动一秒时，探测已经在失败（应用有 6 秒预热），但状态还是 `starting`：

```console
$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 1 second (health: starting)
```

预热结束、某个探测返回 0 之后，状态翻转为 `healthy`——`docker inspect` 会给出完整历史，包括那些被原谅的失败：

```console
$ docker inspect --format '{{json .State.Health}}' hc1
{
    "Status": "healthy",
    "FailingStreak": 0,
    "Log": [
        {
            "Start": "2026-10-14T14:29:47.929109373+08:00",
            "End": "2026-10-14T14:29:48.000139024+08:00",
            "ExitCode": 1,
            "Output": "wget: server returned error: HTTP/1.0 503 Service Unavailable\n"
        },
        {
            "Start": "2026-10-14T14:29:50.000982508+08:00",
            "End": "2026-10-14T14:29:50.053917693+08:00",
            "ExitCode": 0,
            "Output": ""
        },
        {
            "Start": "2026-10-14T14:29:52.054474173+08:00",
            "End": "2026-10-14T14:29:52.11014442+08:00",
            "ExitCode": 0,
            "Output": ""
        }
    ]
}
```

这段日志——最近几次探测，每次带 `ExitCode` 和 `Output`——就是全部的排障界面。半夜被叫起来的时候，你要读的就是它。

<figure>
<svg viewBox="0 0 720 330" role="img" aria-label="状态机：探测退出 0 时 starting 变为 healthy；连续失败 N 次 healthy 变为 unhealthy；依赖恢复时 unhealthy 回到 healthy；进程退出时 healthy 变为 exited。exited 交给重启策略：策略触发则经过退避后启动一个新容器，没有策略则一直停着。unhealthy 没有任何指向重启的箭头：它永远不会自己触发重启。">
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="none" stroke="currentColor" stroke-width="1.4" marker-end="url(#arw)">
    <rect x="40" y="56" width="150" height="44" rx="8"/>
    <rect x="265" y="56" width="150" height="44" rx="8" stroke="#0f766e" stroke-width="2.4"/>
    <rect x="490" y="56" width="150" height="44" rx="8"/>
    <rect x="265" y="196" width="150" height="44" rx="8"/>
    <rect x="560" y="196" width="150" height="44" rx="8" stroke-dasharray="5 4"/>
    <line x1="190" y1="78" x2="263" y2="78"/>
    <line x1="415" y1="78" x2="488" y2="78"/>
    <path d="M565 100 V190 H310 V106"/>
    <line x1="340" y1="100" x2="340" y2="194"/>
    <path d="M265 218 H152 V106"/>
    <line x1="415" y1="218" x2="558" y2="218"/>
    <line x1="565" y1="100" x2="565" y2="140" stroke-dasharray="3 3"/>
  </g>
  <g fill="#0f766e" font-family="ui-monospace, monospace" font-size="14" text-anchor="middle">
    <text x="340" y="83">healthy</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="14" text-anchor="middle">
    <text x="115" y="83">starting</text>
    <text x="565" y="83">unhealthy</text>
    <text x="340" y="223">exited</text>
    <text x="635" y="216">stays down</text>
  </g>
  <g fill="currentColor" font-size="11" text-anchor="middle">
    <text x="226" y="66">probe exits 0</text>
    <text x="451" y="66">N fails in a row</text>
    <text x="207" y="207">restart policy fires</text>
    <text x="207" y="241">backoff grows</text>
    <text x="487" y="207">policy: no</text>
    <text x="440" y="180">dependency recovers</text>
    <text x="356" y="152">process exits</text>
    <text x="565" y="158" font-size="14">✗</text>
    <text x="565" y="174">unhealthy never restarts anything</text>
    <text x="635" y="236" opacity="0.75">no new container</text>
  </g>
</svg>
<figcaption>三个健康状态，以及唯一能产生新容器的路径。start-period 期间的失败被原谅；宽限期之后的 <code>retries</code> 数的是<em>连续</em>失败次数。缺掉的那条箭头就是全部教训：<code>unhealthy</code> 不是退出，所以没有任何重启策略会对它反应——而 <code>exited</code> 的容器只有在策略真的触发时才会回来。</figcaption>
</figure>

## 最大的坑：unhealthy 不会重启任何东西

现在是所有人都搞错过的地方——包括第一次踩坑的我。我把依赖弄坏，先确认进程还在服务，然后等着：

```console
$ curl -s -X POST http://127.0.0.1:8080/break
backend broken
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/
200
```

两件事同时为真：根路径返回 200（进程活着），`/healthz` 返回 503（它存在的理由已经坏了）。二十秒后——十个探测间隔——状态翻了：

```console
$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 20 seconds (unhealthy)
```

陷阱在这里。我给这个*不健康*的容器挂上重启策略，再等二十秒：

```console
$ docker update --restart=always hc1
hc1

$ docker ps --filter name=hc1 --format '{{.Names}}: {{.Status}}'
hc1: Up 57 seconds (unhealthy)

$ docker inspect -f 'status={{.State.Status}} exitCode={{.State.ExitCode}} restartCount={{.RestartCount}}' hc1
status=running exitCode=0 restartCount=0

$ docker top hc1 | tail -1
root    1263786    1263760    1    14:29    ?    00:00:00    python app.py
```

什么都没发生，而且*永远*不会发生。`restartCount=0`，PID 1 还是最初那个 `python app.py`。重启策略只对**容器退出**做出反应——这个信号只在进程死亡时出现。不健康的容器是一个*在运行*的容器；Docker 会放任它永远返回 503。健康状态是*给别的系统读*的信号：compose 的启动门禁、负载均衡器、监控面板，还有你。它不是守护进程的触发器。（Kubernetes 是这个规则的反例：那边的 liveness 探测直接接在 kubelet 的重启动作上，而那正是原生 Docker 缺的一块。）

还有个不错的性质：健康是个实时信号，不是锁存器。把依赖修好，下一个通过的探测就把它翻回去，完全不重启：

```console
$ curl -s -X POST http://127.0.0.1:8080/heal
backend healed
$ docker inspect -f 'status={{.State.Status}} failingStreak={{.State.Health.FailingStreak}}' hc1
status=running failingStreak=0
```

## 重启策略：什么会重启，什么时候重启

那么*究竟*什么会重启容器？一次退出，加一条策略。我用一个爱崩溃的镜像（`echo boot $(date -u +%T); exit 1`）在每条策略下都跑了一遍。用默认值时，崩溃即终局：

```console
$ docker run -d --name no1 hc-crash:local
# 8 秒后：
$ docker inspect -f 'no1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' no1
no1: status=exited exit=1 restarts=0
```

`on-failure` 把它变成崩溃循环——看着重启计数往上爬，而退避把间隔越拉越长：

```console
$ for t in 3 9 9 9; do sleep $t; docker inspect -f 'restarts={{.RestartCount}} status={{.State.Status}}' on2; done
restarts=3 status=running
restarts=7 status=restarting
restarts=8 status=restarting
restarts=8 status=restarting
```

`always` 和 `unless-stopped` 根本不在乎退出码——同样是 `exit=1` 的崩溃循环：

```console
$ docker inspect -f 'always1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' always1
always1: status=restarting exit=1 restarts=6
$ docker inspect -f 'unless1: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' unless1
unless1: status=restarting exit=1 restarts=6
```

以及生产里真正要紧的两个边角情况。第一，`on-failure` 指的是*失败*——干净地退出 0 永远不会重启：

```console
$ docker run -d --name ok0 --restart=on-failure alpine:3.21 sh -c "echo clean exit 0; exit 0"
# 6 秒后：
$ docker inspect -f 'ok0 (exit 0, on-failure): status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' ok0
ok0 (exit 0, on-failure): status=exited exit=0 restarts=0
```

第二，主动 `docker stop` 永远被尊重——没有哪条策略会跟你对着干：

```console
$ docker ps -a --filter name=always1 --format 'always1 after stop: {{.Status}}'
always1 after stop: Exited (1) 4 seconds ago
$ docker ps -a --filter name=unless1 --format 'unless1 after stop: {{.Status}}'
unless1 after stop: Exited (1) 2 seconds ago
```

`always` 和 `unless-stopped` 唯一的区别在**守护进程**重启时：`always` 会把停掉的容器拉起来，`unless-stopped` 则不动你亲手停掉的那些。这个区别我在不重启守护进程的前提下没法演示，所以请把它当规格看，别当输出。汇总表：

| 策略 | 退出 ≠ 0 | 退出 0 | `docker stop` 之后 | 守护进程重启之后 |
|---|---|---|---|---|
| `no` | 一直死着 | 一直死着 | 保持停止 | 保持停止 |
| `on-failure` | 重启（退避） | **保持停止** | 保持停止 | 仅当它死时在运行 |
| `always` | 重启 | 重启 | 保持停止 | 重启 |
| `unless-stopped` | 重启 | 重启 | 保持停止 | 保持停止 |

## 崩溃循环与重启退避

`on-failure` 的崩溃循环值得仔细看一眼，因为守护进程会给它踩刹车。一个秒退容器的 `docker logs --timestamps` 启动行，一遍又一遍：

```console
$ docker logs --timestamps on1 | head -12
2026-10-14T06:32:25.685838187Z boot 06:32:25
2026-10-14T06:32:26.056640038Z boot 06:32:26
2026-10-14T06:32:27.015917963Z boot 06:32:27
2026-10-14T06:32:28.145552094Z boot 06:32:28
2026-10-14T06:32:29.320655496Z boot 06:32:29
2026-10-14T06:32:31.561327287Z boot 06:32:31
2026-10-14T06:32:35.011422004Z boot 06:32:35
2026-10-14T06:32:41.809518027Z boot 06:32:41
2026-10-14T06:32:54.833300872Z boot 06:32:54
```

把相邻时间戳两两相减，退避一目了然：0.4、1.0、1.1、1.2、2.2、3.5、6.8、13.0 秒——大约每轮翻一倍。循环自己会节流，这对宿主机是好事（机器不会烧起来），对你不是好事（所谓“重启过”的服务，其实每十几秒只活几秒）。监控里 `RestartCount` 一路爬升就是信号。Compose 和 Swarm 行为相同。崩溃循环的解药从来不是更紧的重启间隔——是那个导致退出的原因。而且会崩溃循环的容器通常在告诉你：镜像的入口命令期待某个环境里没有的东西，这个 healthcheck 可替不了你。

## Compose：等的是 healthy，不只是 started

健康检查在 compose 里立刻回本。老的 `depends_on: [api]` 只等“容器已启动”，而那恰好就是本文开头那个没用的状态。带 condition 的写法等的是健康：

```yaml
services:
  api:
    image: hc-demo:local
    ports: ["127.0.0.1:8080:8080"]
    healthcheck:                       # 对，也可以定义在这里
      test: ["CMD", "/srv/health.sh"]
      interval: 3s
      timeout: 2s
      retries: 2
      start_period: 8s

  waiter:                              # 等的是 "healthy"，不是 "started"
    image: alpine:3.21
    depends_on:
      api:
        condition: service_healthy
    command: ["sh", "-c", "echo WAITER_STARTED_AT=$(date -u +%T.%N)"]

  impolite:                            # 老的列表写法：完全不等待
    image: alpine:3.21
    depends_on: [api]
    command: ["sh", "-c", "echo IMPOLITE_STARTED_AT=$(date -u +%T.%N)"]
```

Compose 把门禁生效的过程明明白白打了出来（网络行已修剪）：

```console
$ docker compose -p hcdemo -f compose.health.yaml up -d
 Container hcdemo-api-1 Creating
 Container hcdemo-api-1 Created
 Container hcdemo-impolite-1 Creating
 Container hcdemo-waiter-1 Creating
 Container hcdemo-impolite-1 Created
 Container hcdemo-waiter-1 Created
 Container hcdemo-api-1 Starting
 Container hcdemo-api-1 Started
 Container hcdemo-impolite-1 Starting
 Container hcdemo-api-1 Waiting
 Container hcdemo-impolite-1 Started
 Container hcdemo-api-1 Healthy
 Container hcdemo-waiter-1 Starting
 Container hcdemo-waiter-1 Started
```

`impolite` 在 `api` 还在预热时就启动了；`waiter` 直到 `Healthy` 之后才启动。服务日志里的时间戳让差距更具体：

```console
$ docker compose -p hcdemo -f compose.health.yaml logs -t --no-log-prefix
2026-10-14T06:36:15.569603460Z IMPOLITE_STARTED_AT=06:36:15.
2026-10-14T06:36:23.568650727Z WAITER_STARTED_AT=06:36:23.
```

晚了整整八秒——正好是 api 自己的探测开始通过的时刻。（Busybox 的 `date` 丢掉了 `%N` 纳秒，所以有个突兀的句点；每行后半截的时间戳是守护进程补的。）那套栈里其它东西——网络、密钥、卷布局——都在[Compose 实战手册](/zh/posts/docker-compose-cookbook/)里；健康门禁是让 `depends_on` 从谎言变成顺序保证的那一块。

## 坏的健康检查比没有更糟

健康检查是便宜的保险——每隔几秒在 loopback 上花几毫秒——但保险只在检查诚实时才赔付。这次运行我带走的东西：

- **检查依赖，别检查进程。** `true`、`pgrep`、`test -f /tmp/ok` 会为一个什么都不服务的容器报绿色。检查应该在容器的*正事*失败时失败。
- **慢启动要给 `start-period`。** 没有它，一次数据库恢复或 JVM 预热就会吃掉你的 retries，容器生下来就不健康。有了它，宽限期内的失败被原谅。
- **保持便宜和本地。** 它会永远、按间隔、在每个副本里跑。loopback 端点、两秒超时，够了。
- **`retries` 吸收抖动，不制造故障。** 连续两三次失败才是真信号；一次失败不该叫醒任何人。
- **想清楚什么*不会*对健康做出反应：**重启策略。不健康的容器是运行中的容器——如果你想让它退出，得有别的角色当守护者：一个巡检 unhealthy 状态的看门狗容器、一个编排器，或者一个把实例摘掉的负载均衡器。
- **让策略匹配失败模式。** 会因坏输入而退出的 worker 用 `on-failure`；必须回来的守护进程用 `always`/`unless-stopped`。一个退避越来越长的崩溃循环是故障报告，不是策略。

Running 是关于一个 PID 的事实，healthy 是关于一个服务的判断。Docker 会很乐意给你前者、永远不检查后者——除非你把检查写出来，也除非你记得：一个没有角色对它做出反应的检查，只是一块死仪表盘上的绿灯。
