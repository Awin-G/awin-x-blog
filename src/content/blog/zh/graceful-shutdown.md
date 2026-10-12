---
title: "优雅关闭与连接排空：一次真机复现"
description: "我用一个一次性的 nginx 挡在一个每请求约 1 秒的小应用前面，在请求进行中发送 SIGTERM，眼看着请求变成 502 Bad Gateway——然后用真正的连接排空把它修好：为什么部署会造成 502、nginx reload 与 restart 的区别、Kubernetes 的 preStop 与 terminationGracePeriodSeconds，以及各技术栈的优雅关闭清单。"
pubDate: 2026-12-19
lang: zh
translationKey: graceful-shutdown
tags: [devops, nginx]
featured: false
keywords:
  - 优雅关闭
  - SIGTERM
  - 连接排空
  - 零停机部署
  - 502 Bad Gateway
---

**优雅关闭**本该很无聊：收到 **SIGTERM** 后，进程停止接受新工作，把已经在途的请求做完，然后才退出。但大多数进程做的恰好相反——信号一到就立刻死掉，手上正处理的请求也一起陪葬。这个缺口，就是一次例行部署变成满屏 **502 Bad Gateway** 的地方。我用一个一次性的 nginx 挡在一个每请求耗时约 1 秒的小应用前面复现了整件事：在请求进行中发送 **SIGTERM**，看着**连接排空**发生——或者根本没发生。这正是真正的**零停机部署**所依赖的机制。

实验环境是一次性的：`nginx:1.27.5` 反向代理 `python:3.14`，跑在 Docker 网桥上，全在 `127.0.0.1`，不需要任何特权。下面全部是真实输出。

## SIGTERM 应该做什么——以及它通常做什么

`SIGTERM` 是“礼貌信号”：和 `SIGKILL` 不同，它可以被捕获，而它约定的契约是三步：

1. 停止接受新连接（停止读取监听套接字），
2. 把已经在途的请求做完，
3. 退出。

大多数程序只做了第 3 步。`SIGTERM` 的默认行为是“立即终止”，所以除非应用自己装了处理器，进程死的时候请求还开着——客户端看到的是连接被重置，如果前面有代理，就是 **502**。

一次优雅关闭大致长这样：

<figure>
<svg viewBox="0 0 760 330" width="100%" role="img" aria-label="优雅关闭的时间线。SIGTERM 让进程停止接受新连接；在途请求在排空窗口内完成；SIGTERM 之后到达的请求被拒绝；窗口结束进程退出。">
  <rect x="60" y="70" width="230" height="185" fill="currentColor" opacity="0.05"/>
  <rect x="290" y="70" width="350" height="185" fill="#0f766e" opacity="0.10"/>
  <text x="175" y="60" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">接受新连接</text>
  <text x="465" y="60" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" font-weight="600">排空窗口：跑完在途请求，拒绝新连接</text>
  <line x1="290" y1="70" x2="290" y2="285" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="290" y="302" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">SIGTERM</text>
  <line x1="640" y1="70" x2="640" y2="285" stroke="currentColor" stroke-width="1.5"/>
  <text x="640" y="302" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">退出 0</text>
  <line x1="60" y1="285" x2="706" y2="285" stroke="currentColor" stroke-width="1.5"/>
  <path d="M706 285 l-10 -5 v10 z" fill="currentColor"/>
  <text x="712" y="290" fill="currentColor" font-family="system-ui, sans-serif" font-size="10">t</text>
  <rect x="180" y="110" width="200" height="16" rx="3" fill="#0f766e"/>
  <text x="390" y="123" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">在途请求 &#8594; 200</text>
  <rect x="220" y="145" width="180" height="16" rx="3" fill="#0f766e" opacity="0.8"/>
  <text x="410" y="158" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">在途请求 &#8594; 200</text>
  <rect x="320" y="185" width="60" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3"/>
  <line x1="334" y1="188" x2="366" y2="198" stroke="currentColor" stroke-width="2"/>
  <line x1="366" y1="188" x2="334" y2="198" stroke="currentColor" stroke-width="2"/>
  <text x="392" y="198" fill="currentColor" font-family="system-ui, sans-serif" font-size="11">新请求 &#8594; 502</text>
</svg>
<figcaption>优雅关闭是一场带截止时间的赛跑。左边已经被接下的请求在排空窗口内跑完；SIGTERM 之后才到达的请求，得靠负载均衡器停发流量来避免。</figcaption>
</figure>

先说一个容易踩的坑：**PID 1 会忽略它没有处理器的信号。** 我第一次把 `SIGTERM` 发给容器，什么都没发生——应用照旧服务，因为那个 Python 进程就是 PID 1。这也是容器要带一个迷你 init 的原因（`docker run --init`、Compose 里的 `init: true`），它会把信号转发给一个能真正处理它的子进程。

## 为什么一次部署会造成 502

故障源于两个独立决定之间的赛跑：

- **负载均衡器 / 反向代理**决定何时停止往某个实例路由，以及
- **应用**决定何时停止接受连接。

如果应用先停止接受，代理却还在发请求，代理就会一直去拨一个已经没人监听的套接字。这个窗口里的每个请求都会失败。应用其实没做错什么，只是两边对顺序的看法不一致。**连接排空**的全部手艺，就是让代理先走，再给应用一段宽限期把活干完。

负载一上来，那个极小的窗口恰好就是你最慢的那些请求所在的地方。

## 失败复现：没有处理器的 SIGTERM

应用每个请求睡 1 秒，而“不排空”这一版不装任何信号处理器。我通过 nginx 并发打 6 个请求，并在 0.4 秒时发送 `SIGTERM`：

```text
$ ./run-case.sh 6 0.4
>>> sending SIGTERM to app container
HTTP 502  0.597s  req=4
HTTP 502  0.601s  req=3
HTTP 502  0.601s  req=2
HTTP 502  0.604s  req=6
HTTP 502  0.604s  req=5
HTTP 502  0.611s  req=1
```

6 个全挂，而且是**提前**挂的——大约 0.6 秒，而不是完整的 1.0 秒。这些请求还剩 1 秒的活，进程却直接从底下消失了。应用日志从内部讲了同一个故事：6 行 `START`，一行 `FINISH` 都没有。

```text
START  req=1 active=1
START  req=5 active=2
START  req=6 active=3
START  req=2 active=4
START  req=3 active=5
START  req=4 active=6
# process terminated — no FINISH lines ever print
```

nginx 在错误日志里把原因说得一清二楚：

```text
[error] upstream prematurely closed connection while reading response
        header from upstream, upstream: "http://172.22.0.2:8080/"
```

“prematurely closed”（过早关闭）就是 nginx 在说：响应头还没到，上游的 TCP 连接就没了。客户端拿到 **502**。

## 修复：先把在途请求排空，再退出

现在让应用处理信号。收到 `SIGTERM` 时它停止接受新连接，等在途计数器归零，然后退出：

```python
def on_term(signum, frame):
    log("signal received: stop accepting, drain in-flight")
    threading.Thread(target=server.shutdown, daemon=True).start()

signal.signal(signal.SIGTERM, on_term)   # only installed when draining is on

server.serve_forever()                   # returns once shutdown() stops the accept loop
while active_requests > 0:               # work already accepted keeps running
    time.sleep(0.05)
sys.exit(0)
```

同样 6 个请求、同样在途发信号，行为只差一处：

```text
$ DRAIN=1 ./run-case.sh 6 0.4
>>> sending SIGTERM to app container
HTTP 200  1.001s  req=5
HTTP 200  1.001s  req=1
HTTP 200  1.001s  req=6
HTTP 200  1.001s  req=3
HTTP 200  1.001s  req=4
HTTP 200  1.001s  req=2
```

日志里这次能看见关闭过程了：

```text
signal 15 received: stop accepting, drain in-flight
accept loop stopped; waiting for in-flight requests
FINISH req=1 elapsed=1.00s
FINISH req=4 elapsed=1.00s
...
all in-flight done; exiting cleanly
```

6 个 200 换掉 6 个 502——所谓“正确处理 SIGTERM”，大半就是这个。

## 排空期间进来的新请求仍然会失败

排空并不能让实例刀枪不入，这也是最常被忽略的一点：它在跑完旧活的同时，是**不接受新连接**的。代理此刻发来的任何东西都会失败：

```text
IN-FLIGHT req=A  200  3.00s     # accepted before SIGTERM, finishes
IN-FLIGHT req=B  200  3.04s
NEW       req=C  502  1.96s     # proxy sent a new connection into a closed listener
```

所以光排空还不够——必须配合同步地让代理**停止**发流量。正确顺序是：先告诉负载均衡器停止发送 → 等一下 → 再发 `SIGTERM` → 让应用排空。Kubernetes 把这个“等一下”建模出来了，你也应该。

## 上游消失时 nginx 做了什么

nginx 把这件事表现得很直白。设成 `max_fails=0` 后，它永远不会把后端标记成“down”，于是你看到的是真相，而不是一份被缓存的失败。几个关键旋钮：

- `proxy_next_upstream off;`——不要悄悄重试**另一个**后端，那会把一次坏掉的部署藏在一次缓慢的 200 后面。
- `proxy_connect_timeout 1s;`——给“拨一个已经没人监听的套接字”设个上限（我在端口是拒绝而非重置时，看到的是 **504**）。
- `keepalive N;` 配合 `proxy_http_version 1.1;` 和 `proxy_set_header Connection "";`——复用上游连接更快，但也意味着上游离开时，代理同样要回收这些 keepalive 连接。

nginx 自己下线也有两种截然不同的方式：

```text
nginx -s reload   →  HTTP 200 ×4   workers replaced, in-flight requests never interrupted
nginx -s quit     →  HTTP 200 ×4   graceful shutdown: drain, then exit
nginx -s stop     →  HTTP 000 ×4   fast shutdown: connections cut mid-response
```

`reload` 就是零停机的那个原语：master 读到新配置，起一批新 worker，让老 worker 把活干完。`quit` 是优雅关闭。`stop` 是直接拔线——客户端什么都拿不到（`000` 是 curl 在报告一个没有任何 HTTP 响应就断掉的连接）。大多数人以为自己要的是“重启”，其实要的是 `reload`；配置层面的细节我写在 [nginx 配置手册](/zh/posts/nginx-cookbook/) 里。

## Kubernetes：preStop 与 terminationGracePeriodSeconds

编排器没法替你修好一个坏掉的关闭，但它给了你两个把手。Pod 被删除时，Kubernetes 会同时把它从 Service endpoints 摘掉，**并且**开始终止倒计时——所以用 **`preStop`** 钩子把应用推迟一下，让“摘除”这件事先传到 kube-proxy 和负载均衡器。`terminationGracePeriodSeconds` 则给整件事兜底，时间一到就上 `SIGKILL`。

```yaml
terminationGracePeriodSeconds: 30   # budget: must exceed longest in-flight request + queue
lifecycle:
  preStop:
    exec: { command: ["sh", "-c", "sleep 5"] }   # let deregistration reach the proxies
```

容易让人搞混的区分：**readiness 探针**管的是要不要给你**新**流量；**liveness 探针**决定一个卡住的进程要不要被**重启**。一个正在排空的应用应该让 readiness 失败（不再接流量），同时保持存活（继续把手上的活干完）——关闭期间绝不能把 liveness 弄失败，否则 kubelet 会杀掉你正想救的那些请求。“先宣告未就绪，再排空”这套握手，正是我那篇 [零停机部署](/zh/posts/zero-downtime-deploys/) 的核心。

## 各技术栈的优雅关闭清单

上面讲的，换个写法都是同样三步。把超时设成比最慢请求还长，并且在每个栈上都要确保进程真的收到了 `SIGTERM`：

```ini
# systemd
[Service]
KillSignal=SIGTERM      # the polite signal
KillMode=mixed          # signal the main process, then the whole cgroup
TimeoutStopSec=30       # then SIGKILL; must exceed longest request + queue
```

```dockerfile
# Dockerfile
STOPSIGNAL SIGTERM      # what `docker stop` sends; default is already SIGTERM, be explicit
```

```yaml
# compose.yaml
services:
  app:
    init: true                    # PID 1 signal forwarding + zombie reaping
    stop_grace_period: 30s        # docker stop's patience before SIGKILL
```

清单，压缩版：（1）装一个 `SIGTERM` 处理器，停止接受新连接但把在途的活做完；（2）确保信号真的到达进程——entrypoint 里用 `exec`，PID 1 用 `init: true`；（3）先停路由、再停接受（nginx upstream 权重、Kubernetes `preStop`，或者一段注销延迟）；（4）把停止超时设得比最慢请求还长；（5）优先 reload 而非 restart，两者都不如排空。

这些都不稀奇：一个处理器、一个计数器、一次和代理之间诚实的手势。那些 502 从来不是应用在失败，只是应用和负载均衡器对“谁先离开房间”的看法不一致。把顺序摆对，部署就是隐形的——而这正是你想要的。
