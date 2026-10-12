---
title: "nginx stream 模块：L4 层的 TCP/UDP 代理"
description: "如何使用 nginx stream 模块作为 TCP/UDP 代理。通过真实配置讲解 L4 与 L7 的区别、ssl_preread SNI 路由、UDP 代理、负载均衡和 proxy_protocol。"
pubDate: 2027-01-05
lang: zh
translationKey: nginx-stream-module
tags: [nginx, networking]
featured: false
keywords:
  - nginx stream 模块
  - nginx TCP 代理
  - UDP 代理
  - ssl_preread
  - L4 代理
---

大多数人对 nginx 的认知是 HTTP 反向代理。但 nginx 也能在四层（L4）代理原始 TCP 和 UDP 流量——数据库、DNS、SSH、MQTT、游戏服务器，以及任何非 HTTP 协议。这正是 **nginx stream 模块** 的用途。

本文将详细讲解 L4 代理与 L7 代理的区别、何时需要使用 L4，并通过真实可运行的配置示例展示：TCP 代理、UDP 代理、`ssl_preread` 基于 SNI 的路由、`least_conn` 负载均衡，以及 `proxy_protocol`。所有配置均已通过 `nginx -t` 验证，基于 Docker 中的 `nginx:alpine`。

## http{} 与 stream{} —— L7 与 L4 的区别

nginx 有两个完全独立的配置世界：

- **`http {}`** —— 七层（L7）。解析 HTTP 头部，按 Host 和 URI 路由，终止 TLS，按请求限速，重写 Cookie。
- **`stream {}`** —— 四层（L4）。在客户端和上游之间搬运原始字节。不解析头部，不感知 HTTP。只是一个快速、有状态的管道。

核心心智模型如下：

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280" role="img" aria-label="http 与 stream 代理路径对比">
  <defs>
    <style>
      .box { fill: none; stroke-width: 2; rx: 8; }
      .http { stroke: #0f766e; }
      .stream { stroke: #b45309; }
      .lbl { font-family: system-ui, sans-serif; font-size: 13px; fill: currentColor; }
      .small { font-size: 11px; }
      .arrow { stroke-width: 2; fill: none; marker-end: url(#ah); }
    </style>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="currentColor"/>
    </marker>
  </defs>

  <!-- HTTP path -->
  <text x="20" y="30" class="lbl" fill="#0f766e" font-weight="bold">http {} — L7（解析 HTTP）</text>
  <rect x="20" y="45" width="120" height="50" class="box http"/>
  <text x="80" y="68" class="lbl" text-anchor="middle" fill="#0f766e">客户端</text>
  <text x="80" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">:80/:443</text>
  <line x1="140" y1="70" x2="200" y2="70" class="arrow" stroke="#0f766e"/>
  <rect x="200" y="45" width="120" height="50" class="box http"/>
  <text x="260" y="68" class="lbl" text-anchor="middle" fill="#0f766e">nginx</text>
  <text x="260" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">解析头部</text>
  <line x1="320" y1="70" x2="380" y2="70" class="arrow" stroke="#0f766e"/>
  <rect x="380" y="45" width="120" height="50" class="box http"/>
  <text x="440" y="68" class="lbl" text-anchor="middle" fill="#0f766e">上游</text>
  <text x="440" y="84" class="lbl small" text-anchor="middle" fill="#0f766e">按 Host/URI</text>

  <!-- Stream path -->
  <text x="20" y="140" class="lbl" fill="#b45309" font-weight="bold">stream {} — L4（原始字节）</text>
  <rect x="20" y="155" width="120" height="50" class="box stream"/>
  <text x="80" y="178" class="lbl" text-anchor="middle" fill="#b45309">客户端</text>
  <text x="80" y="194" class="lbl small" text-anchor="middle" fill="#b45309">:3306/:5432</text>
  <line x1="140" y1="180" x2="200" y2="180" class="arrow" stroke="#b45309"/>
  <rect x="200" y="155" width="120" height="50" class="box stream"/>
  <text x="260" y="178" class="lbl" text-anchor="middle" fill="#b45309">nginx</text>
  <text x="260" y="194" class="lbl small" text-anchor="middle" fill="#b45309">盲管道</text>
  <line x1="320" y1="180" x2="380" y2="180" class="arrow" stroke="#b45309"/>
  <rect x="380" y="155" width="120" height="50" class="box stream"/>
  <text x="440" y="178" class="lbl" text-anchor="middle" fill="#b45309">上游</text>
  <text x="440" y="194" class="lbl small" text-anchor="middle" fill="#b45309">DB/DNS/SSH</text>

  <!-- Key difference -->
  <text x="20" y="260" class="lbl small" fill="#0f766e">http：按 Host、URI、Cookie 路由 —— 终止 TLS</text>
  <text x="20" y="275" class="lbl small" fill="#b45309">stream：转发字节 —— 不解析协议，TLS 透传</text>
</svg>
<figcaption><code>http {}</code> 块终止并解析 HTTP。<code>stream {}</code> 块是原始字节管道——它不关心也不感知你运行的协议是什么。</figcaption>
</figure>

**何时需要 L4？** 当流量不是 HTTP 时：

- **数据库** — MySQL（`:3306`）、PostgreSQL（`:5432`）、Redis（`:6379`）、MongoDB（`:27017`）
- **DNS** — bind `:53` UDP/TCP，或 DoH 前端
- **SSH** — 跳板机整合
- **MQTT** — IoT 代理 `:1883`/`:8883`
- **游戏服务器** — UDP 密集型协议
- **TLS 透传** — 后端自行终止 TLS，你只需要按 SNI 路由
- **任何自定义 TCP 协议** — 内部 RPC、遗留系统等

如果你的流量是 HTTP，请继续使用 `http {}`。如果是其他协议，`stream {}` 才是正确的工具。

## 最小 stream 配置

一个最小的 L4 代理只需要 `listen` 和 `proxy_pass`：

```nginx
stream {
    server {
        listen 18080;
        proxy_pass 172.17.0.1:19090;
    }
}
```

就这样。nginx 监听 `18080`，接受原始 TCP 连接，打开到上游的连接，然后双向搬运字节。不解析 HTTP，不处理头部，不修改内容。

> **实际遇到的 Docker 陷阱：** 如果你在 Docker 中运行 nginx 并代理到宿主机上的服务，容器内的 `127.0.0.1` 是容器本身——不是宿主机。需要使用网桥网关 IP（默认 `127.0.0.1` → `172.17.0.1`），或者将上游放在同一网络的另一个容器中。以下是我实际测试时的真实错误：
> ```
> connect() failed (111: Connection refused) while connecting to upstream,
> client: 172.17.0.1, upstream: "127.0.0.1:19090"
> ```

通过 L4 代理的真实 TCP 往返——客户端发送 `hello-stream`，echo 服务器回复：

```bash
$ python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(('127.0.0.1', 18080))
s.sendall(b'hello-stream')
print('Response:', s.recv(1024).decode())
"
Response: ECHO:hello-stream
```

## 使用 ssl_preread 进行 SNI 路由

最强大的 L4 模式之一：**在不终止 TLS 的情况下按 SNI 路由**。客户端发送的 TLS ClientHello 中包含 `server_name` 扩展——nginx 通过 `ssl_preread on` 读取它，映射到后端，然后原封不动地转发加密字节。上游看到的仍然是原始的 TLS 流。

```nginx
stream {
    map $ssl_preread_server_name $name_backend {
        app.example.com 172.17.0.1:19090;
        api.example.com 172.17.0.1:19092;
        default         172.17.0.1:19090;
    }

    server {
        listen 18443;
        ssl_preread on;
        proxy_pass $name_backend;
    }
}
```

`ssl_preread` 是一个在不解密任何内容的情况下从 ClientHello 中提取 SNI 的模块。你的上游仍然使用自己的证书终止 TLS。这就是如何在一个 IP:端口 组合上托管多个 TLS 服务而无需在 nginx 中管理证书的方法。

用 `openssl s_client` 验证：

```bash
echo | openssl s_client -connect 127.0.0.1:18443 -servername app.example.com
# → 路由到 19090

echo | openssl s_client -connect 127.0.0.1:18443 -servername api.example.com
# → 路由到 19092
```

## UDP 代理

UDP 代理的工作方式相同——在 `listen` 指令中添加 `udp`：

```nginx
stream {
    server {
        listen 18081 udp;
        proxy_pass 172.17.0.1:19091;
    }
}
```

nginx 为每个客户端地址:端口对维护一个伪连接。当来自已知客户端的数据报到达时，nginx 将其转发到上游；当上游回复时，nginx 将其发送回正确的客户端。你也可以代理到一个 `upstream` 组来实现 UDP 负载均衡：

```nginx
stream {
    upstream dns_servers {
        server 172.17.0.1:19090;
        server 172.17.0.1:19092;
    }
    server {
        listen 53 udp;
        proxy_pass dns_servers;
    }
}
```

通过代理的真实 UDP 往返——客户端发送 `hello-udp`，echo 服务器回复：

```bash
$ python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
s.sendto(b'hello-udp', ('127.0.0.1', 18081))
print('Response:', s.recvfrom(1024)[0].decode())
"
Response: ECHO:hello-udp
```

## stream 中的负载均衡

`upstream` 块在 `stream {}` 中的工作方式与 `http {}` 中类似——但支持的负载均衡算法更少。支持 `least_conn`：

```nginx
stream {
    upstream backend {
        least_conn;
        server 172.17.0.1:19090;
        server 172.17.0.1:19092;
    }

    server {
        listen 18082;
        proxy_pass backend;
    }
}
```

`least_conn` 将每个新连接路由到当前活跃连接数最少的上游。当连接生命周期差异很大时（有些快速断开，有些保持数分钟），它比轮询更合适。

**健康检查** 比 HTTP 简单——开源版 stream 模块没有主动健康检查。取而代之的是使用 `max_fails` 和 `fail_timeout` 进行被动健康检查：

```nginx
upstream backend {
    least_conn;
    server 172.17.0.1:19090 max_fails=3 fail_timeout=30s;
    server 172.17.0.1:19092 max_fails=3 fail_timeout=30s;
}
```

如果某个上游在 30 秒内失败 3 次，nginx 会在 30 秒内停止向其发送新连接。这就是你的基础熔断器。

真实负载均衡输出——六个请求分布在两个上游上：

```bash
for i in 1 2 3 4 5 6; do
  python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect(('127.0.0.1', 18082))
s.sendall(b'req-$i')
print('Response:', s.recv(1024).decode())
"
done
```

真实负载均衡输出——六个请求分布在两个上游上：

```bash
$ for i in 1 2 3 4 5 6; do
    python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(('127.0.0.1', 18082))
s.sendall(b'req-$i')
print('Response:', s.recv(1024).decode())
"
  done
Response: ECHO:req-1
Response: ECHO:req-2
Response: ECHO:req-3
Response: ECHO:req-4
Response: ECHO:req-5
Response: ECHO:req-6
```

两个上游都能收到连接。使用 `least_conn` 时，在请求速率相近的情况下分布是均匀的。

## proxy_protocol

当 nginx 代理 TCP 时，上游看到的源地址是 nginx 的 IP——原始客户端 IP 丢失了。**PROXY 协议**（v1 文本格式或 v2 二进制格式）会在数据前添加一个包含真实客户端地址的头部：

```nginx
stream {
    server {
        listen 18083;
        proxy_pass 172.17.0.1:19090;
        proxy_protocol on;
    }
}
```

上游现在会收到类似这样的内容：

```
PROXY TCP4 203.0.113.1 172.17.0.1 51234 18083\r\n
<payload>
```

你的上游必须支持 PROXY 协议才能解析这个头部。大多数数据库和许多服务器通过库或内置标志支持它（PostgreSQL 的 `proxy_protocol_networks`、MySQL 的 `proxy_protocol`、Envoy 原生支持）。如果上游不支持，不要启用 `proxy_protocol on`——它只会在数据流开头看到乱码。

## 真实 nginx -t 输出

本文所有配置均已通过 `nginx:alpine` 验证：

```bash
$ docker run --rm -d --name nginx-stream-test \
    -p 18080:18080 -p 18081:18081/udp -p 18082:18082 \
    -p 18443:18443 -p 18083:18083 \
    -v $PWD/nginx.conf:/etc/nginx/nginx.conf:ro \
    -v $PWD/stream-conf.d:/etc/nginx/stream-conf.d:ro \
    nginx:alpine

$ docker exec nginx-stream-test nginx -t
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

我使用的 `nginx.conf` 将 `stream {}` 放在顶层（`http {}` 之外），这是必须的：

```nginx
events {
    worker_connections  1024;
}

stream {
    include /etc/nginx/stream-conf.d/*.conf;
}

http {
    include /etc/nginx/conf.d/*.conf;
}
```

## 局限性与替代方案选择

stream 模块的设计哲学是极简。以下是你**无法获得**的功能：

- **无 HTTP 特性** — 不能重写头部、不能缓存、不能按 URL 限速、不能 WAF、不能 gzip
- **无主动健康检查** — 只有被动的 `max_fails`/`fail_timeout`
- **模块生态小** — 大多数 nginx 第三方模块面向 `http {}`；stream 生态系统非常小
- **无七层负载均衡** — 不能按内容路由，只能按连接数（或轮询）
- **不支持 HTTP/2 或 HTTP/3** — 显然，它不是 HTTP
- **日志能力有限** — 只有连接级别日志，没有逐请求日志

**何时选择 HAProxy：** 你需要主动健康检查、更多负载均衡算法（round-robin、leastconn、source、URI hash）、原始 TCP 内容切换，或一个具有完整控制平面的全功能 L4 负载均衡器。

**何时选择 Envoy：** 你在构建服务网格、需要 gRPC 感知的 L4、xDS 动态配置、可观测性（分布式追踪、指标、L4 访问日志），或需要一个不需要重新加载配置的现代代理。

**nginx stream 就够用的场景：** 你需要一个简单的 TCP/UDP 代理、基于 SNI 的路由、基础负载均衡或 proxy_protocol 透传——而且你已经在运行 nginx。它轻量、快速，而且不需要引入另一个二进制文件。

## 总结

**nginx stream 模块** 将 nginx 变成一个快速、可靠的四层代理，适用于任何 TCP 或 UDP 协议。你放弃了 HTTP 特性，但获得了用你可能已经在运行的工具来代理数据库、DNS、SSH、MQTT 和任何非 HTTP 服务的能力。

核心要点：

- 非 HTTP 协议使用 `stream {}`；HTTP 使用 `http {}`
- 最小配置：`listen` + `proxy_pass`
- `ssl_preread` 在不终止 TLS 的情况下按 SNI 路由——完美适用于多租户 TLS 前端
- UDP 代理通过 `listen ... udp` 实现
- `upstream` + `least_conn` + `max_fails` 提供基础负载均衡和被动健康检查
- `proxy_protocol on` 将真实客户端 IP 传递给上游——但上游必须支持
- 如果你需要主动健康检查、内容切换或控制平面，请选择 HAProxy 或 Envoy

更多关于 HTTP 层代理的内容，请参阅我的 [nginx  cookbook](/zh/posts/nginx-cookbook/)。如果你用 Go 构建自己的代理，可以查看 [Go 语言 TCP 代理](/zh/posts/tcp-proxy-in-go/)。
