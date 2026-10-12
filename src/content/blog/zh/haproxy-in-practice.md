---
title: "HAProxy 实战：从不让你意外的负载均衡器"
description: "一次动手实践的 HAProxy 走查：HAProxy 配置模型（defaults、frontend、backend）、mode http 与 mode tcp、roundrobin 与 leastconn、真正把死掉的后端实时踢出集群的健康检查、timeout 与 retry，以及 stats 页面——全部在 haproxy 3.0 上复现，输出真实可验。"
pubDate: 2027-01-05
lang: zh
translationKey: haproxy-in-practice
tags: [devops, nginx]
featured: false
keywords:
  - HAProxy
  - HAProxy 配置
  - 健康检查
  - 负载均衡
  - mode tcp
---

**HAProxy** 是我在“把这些 TCP 或 HTTP 后端做负载均衡，并且别让我意外”时会伸手去拿的代理。它不是 nginx 或 Envoy 那种功能全家桶，也无意如此。它是什么：一个很快的 L4/L7 **负载均衡**器，而按我的经验，它拥有我运维过的所有代理里最好的**健康检查**故事。本文是一次实战走查——下面每条命令、每一行输出，都来自一个临时拉起的 `haproxy:3.0-alpine` 容器，挡在两个极小后端前面，用完即拆。如果你想深入 nginx 的机制，我写在 [nginx 配置手册](/zh/posts/nginx-cookbook/)；想看反向代理在另一个方向的对比，有 [Caddy vs nginx](/zh/posts/caddy-vs-nginx/)。

```
$ docker exec hap haproxy -v
HAProxy version 3.0.29-de0ed89 2026/09/28 - https://haproxy.org/
Status: long-term supported branch - will stop receiving fixes around Q2 2029.
```

## 环境：两个极小后端，一个代理

为了让演示落到实处，后端必须诚实作答：能自报身份、能被命令“生病”、能被变慢或噤声。一个极小的 Python origin 三样都能做到，所以我就把它放在 HAProxy 后面。每个响应都带 `X-Backend`，慢请求会 sleep，`/healthz` 会一直返回 `503` 直到我把它“治好”——最后这一点正是让我不杀进程也能演示健康检查的关键。

```python
# server.py —— 临时后端（每个宿主机跑一个）
NAME = os.environ["NAME"]; SLEEP_MS = int(os.environ.get("SLEEP_MS", "400"))
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Backend", NAME)          # 我是谁
        self.send_header("Connection", "close")       # 每请求一条新连接
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?")[0]
        if   p == "/healthz": self._send(200 if HEALTHY else 503, b"ok\n")
        elif p == "/slow":   time.sleep(SLEEP_MS/1000); self._send(200, b"slow\n")
        elif p == "/hang":   time.sleep(15)          ; self._send(200, b"hang\n")  # > timeout server
        elif p == "/down":   HEALTHY=False; self._send(200, b"healthz -> 503\n")
        elif p == "/up":     HEALTHY=True ; self._send(200, b"healthz -> 200\n")
        else:                self._send(200, ("hello from "+NAME+"\n").encode())
ThreadingHTTPServer(("0.0.0.0", 80), H).serve_forever()
```

`be1` 以 `SLEEP_MS=4000`（`/slow` 故意慢）运行，`be2` 以 `SLEEP_MS=400` 运行——正是这点不对称，让后面的算法对比看得见。在一个用户自定义网络里用静态 IP，免得任何名字要在关键时刻被重新解析：

```bash
$ docker network create --subnet 172.31.0.0/24 hbnet
$ docker run -d --name be1 --network hbnet --ip 172.31.0.11 \
      -e NAME=be1 -e SLEEP_MS=4000 -v "$PWD/server.py":/srv/server.py:ro \
      python:3.12-alpine python3 /srv/server.py
$ docker run -d --name be2 --network hbnet --ip 172.31.0.12 \
      -e NAME=be2 -e SLEEP_MS=400  -v "$PWD/server.py":/srv/server.py:ro \
      python:3.12-alpine python3 /srv/server.py
```

## HAProxy 配置模型：defaults、frontend、backend、listen

整个 **HAProxy 配置**就是四种块，而这种“小”正是要点。`defaults` 放共享项——timeout、日志、`mode`、`retries`。`frontend` 绑定端口并决定流量去向；`backend` 装着 `server` 池和均衡策略；`listen` 则是把两者熔在一起的自包含写法，比如 stats 页面。下面是驱动下文所有演示的完整配置：

```haproxy
global
    log stdout format raw local0
    stats socket /run/haproxy.sock mode 660 level admin   # CLI admin: show stat 等

defaults
    mode http
    log global
    option httplog
    timeout connect 2s
    timeout client  30s
    timeout server  30s
    retries 2
    option redispatch

listen stats                       # /stats 页面 + admin socket
    bind 0.0.0.0:9000
    stats enable
    stats uri /stats
    stats auth DemoUser:DemoPass

frontend rr_in
    bind 0.0.0.0:8080
    default_backend be_rr

backend be_rr
    balance roundrobin
    option httpchk GET /healthz          # 主动 L7 检查
    http-check expect status 200
    timeout server 3s                    # 故意调小，用来演示 504
    server be1 172.31.0.11:80 check fall 3 rise 2 inter 2s
    server be2 172.31.0.12:80 check fall 3 rise 2 inter 2s
```

有两个习惯立刻见效。把 `server` 指向稳定 IP（或固定 `init-addr`），后端重启时 HAProxy 就不必在半空中赌一个 DNS 答案；另外，reload 前先校验——`haproxy -c -f haproxy.cfg` 解析干净时静默返回 `0`，而一次实时 `docker kill -HUP hap` 会打印 `Loading success.` 且连接零中断。

## 用 roundrobin 做负载均衡：最朴素的基线

`balance roundrobin` 是默认：发一条连接、移一下指针、再来一遍。两个 origin 都在线时，六个请求干净轮换，每个响应都报出是哪个节点服务的：

```text
$ for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:8080/; done
hello from be2
hello from be1
hello from be2
hello from be1
hello from be2
hello from be1
```

轮询均衡的是*连接数*，不是负载。它根本不知道一个请求会花 4 ms 还是 4 s。这一句话，就解释了其他那些算法为什么存在。

## 健康检查故事：看一个后端死掉又复活

这就是我一直回来的原因。每条 `server` 行都有 `check ... inter 2s`——那是从 HAProxy 侧每 2 秒发出的*主动*检查。因为我用了 `option httpchk GET /healthz`，它是一个真正的 HTTP 探测，必须返回 `200`；而下面那个 `mode tcp` 池没配，于是它只检查 TCP 能连上。现在我停掉 `be2`，随即打八个请求：

```text
$ docker stop be2 && for i in $(seq 8); do curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:8080/fast; done; echo
200 200 200 200 200 200 200 200
$ for i in $(seq 8); do curl -s http://127.0.0.1:8080/fast; done | sort | uniq -c
      8 hello from be1
```

没有一个请求失败，且全部落在 `be1`。在检查尚未失败的这几秒里，`be2` 仍是*候选*：轮询指向它，连接被拒，`retries 2` + `option redispatch` 把请求悄悄重发到 `be1`。等三次检查都 miss（`fall 3`），它才被彻底踢出。这里真正超时的正是连接本身——注意代价恰好是我们设的 `timeout connect 2s`：

```text
$ printf 'show stat' | socat - UNIX-CONNECT:/run/haproxy.sock      # 踢出后的 be2
pxname srv   status check_st code desc
be_rr  be1   UP     L7OK      200  Layer7 check passed
be_rr  be2   DOWN   L4TOUT         Layer4 timeout
```

```
$ docker logs hap | grep -i down
Server be_rr/be2 is DOWN, reason: Layer4 timeout, check duration: 2001ms. 1 active and 0 backup servers left.
```

`2001ms` 就是 `timeout connect 2s` 在起作用：HAProxy 尝试向一个死 IP 开 TCP 连接，两秒后放弃，把节点标 down。再把它拉起来，检查一通过就立刻被迎回：

```text
$ docker start be2   # （它会固定回到 172.31.0.12）
Server be_rr/be2 is UP, reason: Layer7 check passed, code: 200. 2 active and 0 backup servers online.
```

<figure>
<svg viewBox="0 0 880 330" width="100%" role="img" aria-label="客户端把请求发进 HAProxy 前端，监听 8080、8081、9443。前端做负载均衡并健康检查两个后端：be1 位于 172.31.0.11:80 为 UP，Layer7 检查返回 200；be2 位于 172.31.0.12:80 为 DOWN，Layer4 超时，被画成虚线并弱化，表示已被踢出轮换。">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.8">
    <rect x="18" y="128" width="140" height="72" rx="10"/>
    <line x1="158" y1="164" x2="232" y2="164"/>
    <path d="M226 159 L236 164 L226 169" fill="currentColor" stroke="none"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="88" y="158" text-anchor="middle">客户端</text>
    <text x="88" y="176" text-anchor="middle" font-size="11" opacity="0.7">curl · 浏览器</text>
  </g>
  <rect x="248" y="104" width="196" height="120" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="13.5" text-anchor="middle">
    <text x="346" y="132">HAProxy 前端</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11" text-anchor="middle">
    <text x="346" y="156">:8080 :8081 :9443</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.8">
    <text x="346" y="176">负载均衡 + 健康检查</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.4" fill="none">
    <line x1="444" y1="146" x2="516" y2="118"/>
    <path d="M510 113 L522 116 L513 124" fill="#0f766e" stroke="none"/>
  </g>
  <g stroke="currentColor" stroke-width="1.3" fill="none" opacity="0.45">
    <line x1="444" y1="182" x2="516" y2="232" stroke-dasharray="5 4"/>
    <path d="M510 223 L522 233 L510 238" fill="currentColor" stroke="none"/>
  </g>
  <rect x="526" y="52" width="336" height="86" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5">
    <text x="546" y="78">后端 be1   172.31.0.11:80</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">
    <text x="546" y="100">UP · L7OK 200 · 检查 2s（fall 3 / rise 2）</text>
    <text x="546" y="120" opacity="0.75">/slow = 4s（故意慢）</text>
  </g>
  <rect x="526" y="198" width="336" height="86" rx="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="6 5" opacity="0.5"/>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5" opacity="0.7">
    <text x="546" y="224">后端 be2   172.31.0.12:80</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.65">
    <text x="546" y="246">DOWN · L4TOUT（timeout connect 2s = 2001ms）</text>
    <text x="546" y="266">已被踢出轮换 · 请求重发到 be1</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.6">
    <text x="18" y="312">实线=健康在服务 · 虚线=被健康检查移除 · 箭头为主动探测</text>
  </g>
</svg>
<figcaption>一个前端，两个后端。HAProxy 的路由不是“我改到哪里”，而是“按观测到的健康状态”。当探测失败够多次（<code>fall 3</code>），节点退出轮换，负载均衡器无需人工继续对外服务。</figcaption>
</figure>

这件事在运维上的意义：它正是[零停机部署](/zh/posts/zero-downtime-deploys/)得以成立的原因。把一个节点下线、让检查注意到、重启它、让检查重新接纳——池子扛得住，因为追踪状态的是负载均衡器，而不是人。

## roundrobin vs leastconn：算法真正起作用的场合

如果轮询无视负载，那谁来补？`balance leastconn` 选*活跃会话数*最少的节点。只有在负载不均时差别才显形，所以最干净的测法是：用一条长 `/slow` 把某个节点占住，再打十个瞬时 `/fast`。每次跑之前我都用 `show stat` 核对了线上的算法（`be_lc` 在 `leastconn` 与 `roundrobin` 之间做完整 reload 切换）。

```text
# leastconn，实测线上算法 = leastconn
/slow 占用 be1 期间 /fast x10 ->   10  be2        # 全部给空闲的那个

# roundrobin，实测线上算法 = roundrobin
/slow 占用 be1 期间 /fast x10 ->    5 be1   5 be2  # 照样转给忙的那个
```

整个道理就这样复现了。当 `be1` 被一个 4 s 请求缠住时，leastconn 把每条新连接都发给 `be2`；而轮询不管三七二十一，仍把一半发回 `be1`。当后端相同且都快时，两者无法区分——我不会睁眼说瞎话——可一旦请求耗时各异，leastconn 能把长尾延迟压住。（第三种常见选择 `balance source` 把客户端哈希到固定后端，用于会话粘性。）

## Timeout 与 retry：把故障影响控制在最小

HAProxy 不会让一个慢后端把客户端当人质。上面 `defaults` 设了 `timeout connect 2s`、`timeout client 30s`、`timeout server 30s`、`retries 2`、`option redispatch`。`be_rr` 池把 `timeout server` 压到 `3s`，于是 `/hang`——它在上游睡 15 s——触发了它：

```text
$ curl -s -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' http://127.0.0.1:8080/hang
HTTP 504 in 3.002041s
$ docker logs hap | tail -1
172.31.0.1:41316 [...] rr_in be_rr/be2 0/0/0/-1/3001 504 198 - - sH-- 1/1/0/0/0 0/0 "GET /hang HTTP/1.1"
```

`3.002s` 处返回 `504`，日志也印证：那个 `3001` 是 server 时间撞上 `timeout server 3s` 的墙，`sH--` 表示后端卡住。`timeout connect` 管 TCP 握手（之前那个 `2001ms` 正是它），`timeout server` 管后端响应，`timeout client` 管那些不想让它霸占槽位的慢客户端。按你真实的后端画像调这三个值，就是“一个端点慢”和“铺天盖地 504”的分界。

## Stats 页面：一个 URL，全部真相

单个 `listen stats` 同时给你一个网页*和* CLI admin socket——上面所有状态都是从这里取的。网页：

```text
$ curl -s -u DemoUser:DemoPass http://127.0.0.1:9000/stats | grep -i -m1 title
<html><head><title>Statistics Report for HAProxy on <worker-id></title>
```

以及 socket，整理成我关心的几列：

```text
$ printf 'show stat' | socat - UNIX-CONNECT:/run/haproxy.sock
pxname srv    status check_st code desc
be_rr  be1    UP     L7OK      200  Layer7 check passed
be_rr  be2    UP     L7OK      200  Layer7 check passed
be_lc  be1    UP     L7OK      200  Layer7 check passed
be_lc  be2    UP     L7OK      200  Layer7 check passed
be_tcp be1    UP     L4OK            Layer4 check passed
be_tcp be2    UP     L4OK            Layer4 check passed
```

`show stat`、`show info`、`show servers state` 把“为什么慢”这种谜团变成两次 grep。把 `/stats;csv` 抓进 Prometheus，同一个 socket 还能 `set server be_rr/be2 state maint`，主动把某台机器排水下线。

## mode http 与 mode tcp：HAProxy 能看什么、不能看什么

`mode http` 会解析请求：它能匹配路径和头部（ACL）、注入 `X-Forwarded-For`、跑真正读到 `200` 的 L7 健康检查。`mode tcp` 只转发字节，这些一概不知——而这正是 MySQL、Redis 或 websocket 隧道想要的。两种健康检查的对比，是本节最有用的东西。HTTP 通过 tcp 隧道照常工作（我的后端对此毫无察觉）：

```text
$ curl -s -D - http://127.0.0.1:9443/fast | grep -iE '^HTTP|^X-Backend'   # :9443 是 mode tcp
HTTP/1.1 200 OK
X-Backend: be1
```

现在让 `be1` 的应用报告不健康——`/healthz` 开始返回 `503`——看指向*同一个* origin 的两个后端如何分歧：

```text
be_rr  be1    DOWN   L7STS   503  Layer7 wrong status
be_lc  be1    DOWN   L7STS   503  Layer7 wrong status
be_tcp be1    UP     L4OK          Layer4 check passed      # 对 503 视而不见
```

日志说得很直白：`Server be_rr/be1 is DOWN, reason: Layer7 wrong status, code: 503, info: "Service Unavailable"`。`mode tcp` 检查只确认端口能开，于是它报 `L4OK`，继续把流量导向一个已经着火的应用。应用层的健康重要就选 `mode http`；只有连接本身算数就选 `mode tcp`——若真选了 `mode tcp`，不妨考虑 `option tcp-check`，至少能说上一小段协议握手。

ACL 是最后一个值得知道的 L7 工具。几行代码就能按内容而非按端口路由：

```haproxy
frontend web
    bind :80
    acl is_api path_beg /api
    acl is_static path_end .css .js .png
    use_backend api    if is_api
    use_backend assets if is_static
    default_backend web
```

## HAProxy vs nginx vs Envoy：一个公允的比较

三个我都在用，而诚实的划分是按形态、不是按跑分。**nginx** 是全能 Web 服务器兼反向代理——生态巨大、文档天下第一；它的[手册](/zh/posts/nginx-cookbook/)深不见底。**Envoy** 是动态、可编程的 L7 代理：xDS 驱动、服务网格原生，重试、超时、故障注入、丰富可观测性一应俱全。**HAProxy** 的赛道，是那最快、最无趣的 L4/L7 负载均衡器：基于连接的算法、一流的主动健康检查、以及一个逐行行为都可预测的单体二进制。要终止带缓存控制的普通 HTTP，我选 nginx；要能自我改配置的网格，选 Envoy；要在数据库、Redis、或一群必须在数秒内被踢出替换的应用 worker 前面，我始终选 HAProxy。

## 结论

HAProxy “从不让你意外”，靠的是好工具那种朴素：四块组成的 **HAProxy 配置**、会就“服务器真实状态”做判断的**健康检查**、以及遏制而非放大故障的**timeout**。这就是我愿意交给生产、好让我睡觉的**负载均衡**。轮询、`leastconn`、`mode tcp`、`retries`、admin socket——没有一样是为炫技而存在，而如上所示，它们的表现都与你写下的文件一字不差。
