---
title: "nginx worker 调优：worker_processes、worker_connections，以及真正会咬人的那些上限"
description: "在真实的一次性容器里实测 nginx worker 调优：为什么 worker_processes auto 等于每核一个 worker、worker_connections 的并发上限怎么算，以及真正先撞上的 ulimit -n / worker_rlimit_nofile 文件描述符天花板。我真实地触发了 worker_connections are not enough 警告和 152 行 accept4() No file descriptors available，然后修好了它。"
pubDate: 2027-02-07
lang: zh
translationKey: nginx-worker-tuning
tags: [nginx, devops]
featured: false
keywords:
  - nginx worker_processes
  - worker_connections
  - nginx 调优
  - worker_rlimit_nofile
  - keepalive
---

时不时就有人贴出一份"生产级 nginx.conf"，抄回去就能用：`worker_processes 100000;` 加上一堆魔法数字。我的做法相反：我先在一次性容器里跑默认配置，压上真实负载，然后一次只改一个东西，记录到底什么真的有用——包括两次我故意引发的真实故障。下面这些指令就是 nginx worker 调优在实践中的全部：`worker_processes`、`worker_connections`、`worker_rlimit_nofile`，以及 keepalive。所有数字都来自真实测量：`nginx/1.27.5`（`nginx:1.27-alpine`）、八核机器、一个 30 字节的静态文件、私有 Docker 网络上的 `hey` 压测。没有任何编造的输出——下面的两条错误日志是我真跑出来的。

配置写法本身不在本文范围：location 匹配、`try_files`、gzip 这些我已经写在[一份 nginx 配置手册](/zh/posts/nginx-cookbook/)里，而压测方法论——百分位延迟、曲线的膝点、和服务端 CPU 对齐——在[给你自己的服务做负载测试](/zh/posts/load-testing/)里。本文只讲 worker 层的那些上限，以及它们换来的数字。

## 进程模型：一个 master，N 个单线程 worker

nginx 由一个 master 进程加一组 worker 进程组成。master 负责监听套接字、解析配置，从不处理请求。每个 worker 是独立的**单线程**、事件驱动进程（Linux 上是 `epoll`）：它的事件循环里同时挂着成千上万条连接，对它们全部做非阻塞 I/O。这就是一个 worker 能扛住成千上万条以 keepalive 为主的空闲连接的原因——但同样因为如此，一个 worker 的 CPU 能力恰好就是一核。worker 数超过核数不会增加容量，只会带来更多的上下文切换和缓存抖动。

所以 `worker_processes auto;`——官方镜像的默认值——就是每核一个 worker。这不是我嘴上说的，是进程表里看到的：

```text
$ docker exec ngx sh -c 'ps -o pid,ppid,args | grep nginx'
    1     0 nginx: master process nginx -g daemon off;
   30     1 nginx: worker process
   31     1 nginx: worker process
   32     1 nginx: worker process
   33     1 nginx: worker process
   34     1 nginx: worker process
   35     1 nginx: worker process
   36     1 nginx: worker process
   37     1 nginx: worker process
```

八核机器上八个 worker。`auto` 几乎总是对的。例外真实存在，但都很窄：需要缓存局部性时用 `worker_cpu_affinity` 把 worker 钉到指定核上；或者机器是共享的、你刻意只把 nginx 圈在其中一小片 CPU 上时，显式写死 worker 数。还有一点：一个看得到八核的容器就算被 `--cpus=1` 限了也会拉起八个 worker——如果你给容器限 CPU，要么限额高于 worker 数，要么显式设置 `worker_processes`。

## worker_connections：每个 worker 的天花板与并发上限数学

`worker_connections` 是**单个 worker 能同时持有的连接数**上限——客户端连接、上游连接、被代理的连接，全都算，每条连接花掉一个文件描述符。默认值是 1024，直接来自生效配置：

```text
$ docker exec ngx nginx -T | sed -n '1,20p'
worker_processes  auto;
events {
    worker_connections  1024;
}
http {
    sendfile        on;
    #tcp_nopush     on;
    keepalive_timeout  65;
    #gzip  on;
}
```

所有人都会引用的 headline 数学：

```text
最大并发连接数 = worker_processes × worker_connections
              = 8 × 1024 = 8192   （默认值）
```

但在你真的摸到它之前，有三笔账要扣。每个 worker 的监听器、epoll、日志 fd，以及每一条在飞的上游连接，都吃这同一个 1024——而 nginx 做**反向代理**时，每个客户端请求要消耗**两条**连接（客户端 + 上游），直接把有效的客户端上限腰斩。对代理场景，诚实的公式更接近 `workers × (worker_connections − 2 × 并发上游数)`。

真的撞上去会发生什么？我把 `worker_connections` 设成 64，然后用 300 条并发连接压它：

```text
$ hey -z 10s -c 300 http://ngx-small/
  Requests/sec: 24876.5801        # 每个请求依然拿到 200

$ docker logs ngx-small
[warn] 32#32: 64 worker_connections are not enough, reusing connections
[warn] 34#34: 64 worker_connections are not enough, reusing connections
[warn] 31#31: 64 worker_connections are not enough, reusing connections
[warn] 35#35: 64 worker_connections are not enough, reusing connections
[warn] 33#33: 64 worker_connections are not enough, reusing connections
[warn] 37#37: 64 worker_connections are not enough, reusing connections
[warn] 30#30: 64 worker_connections are not enough, reusing connections
[warn] 36#36: 64 worker_connections are not enough, reusing connections
```

每个 worker 一行。注意其中诚实的细节：在这个 keepalive 微基准里，nginx 是**优雅退化**的——它关闭并回收了空闲的 keepalive 连接（`reusing connections`），24,876 req/s 里每个请求都照样回了 `200`。在更严酷的条件下——客户端开着连接不发请求、上游卡住、连接洪水直接砸 accept 队列——同样的耗尽就会变成拒绝连接和重置。这条警告是早期信号；别等到看得见的故障出现。

## worker_rlimit_nofile：真正先咬人的那个上限

headline 数学里的陷阱在这：`worker_connections` 是按 worker 算的，但**文件描述符上限**也是按 worker 算的，两者谁小谁赢。这个容器里的软限额恰好就是 1024：

```text
$ docker exec ngx sh -c 'ulimit -n'
1024
$ docker exec ngx sh -c 'grep "Max open files" /proc/$(pgrep nginx | sed -n 2p)/limits'
Max open files            1024                 524288               files
```

所以默认配置里 `worker_connections 1024` 悄悄等于默认的 fd 上限——8,192 的总连接数在你扣掉监听器和日志之前，**已经**是容器天花板了。只提 `worker_connections` 不提 fd 上限，nginx 会在启动时告诉你，我把 8192 设进去就复现了：

```text
$ docker run ... -v tuned-nginx.conf:/etc/nginx/nginx.conf nginx:1.27-alpine
[warn] 38#38: 8192 worker_connections exceed open file resource limit: 1024
nginx: the configuration file /etc/nginx/nginx.conf test is successful
```

它遵守这个承诺的方式很难看。我跑了一个软 fd 上限为 **256**（`--ulimit nofile=256:4096`）、`worker_connections 1024` 的容器，然后用 2000 条并发连接压上去。压测期间，worker 全被钉在墙上——每个 worker 193 到 253 个已打开 fd，对面就是 256：

```text
worker 36 limits: 256 soft, fds_open=253
worker 35 limits: 256 soft, fds_open=219
```

错误日志里全是真家伙——这样的行一共 152 条：

```text
[docker logs ngx-fdlow]
[crit] 30#30: accept4() failed (24: No file descriptors available)
[crit] 35#35: accept4() failed (24: No file descriptors available)
[crit] 37#37: accept4() failed (24: No file descriptors available)
[crit] 33#33: accept4() failed (24: No file descriptors available)
[crit] 36#36: accept4() failed (24: No file descriptors available)
... 8 秒内 152 条
```

`24` 就是 EMFILE——errno 24 是经典的 "too many open files"，现代内核把它表述成 "No file descriptors available"。每一条这样的行，都是一个 nginx 根本没能 accept 的入站连接；客户端看到的是重置或挂起，不是 502。2000 条连接 ÷ 8 个 worker ≈ 每 worker 250 个 fd——算术精准预言了这一切。

修复只要一行指令，而且因为是在硬限额内部提升，它就能成功。同样的容器、同样的负载，只加一行：

```nginx
worker_rlimit_nofile 4096;   # 把 worker 的 fd 上限提到
events { worker_connections 1024; }   # 连接数之上，且不超过硬限额
```

master 在启动时把每个 worker 的上限提到 4096（硬限额是 4096，所以成功），在完全相同的 2000 连接负载下：

```text
$ docker logs ngx-fdfix | grep -c 'No file descriptors available'
0
$ docker exec ngx-fdfix sh -c 'grep "Max open files" /proc/$(pgrep -f "nginx: worker" | head -1)/limits'
Max open files            4096                 4096                 files
$ hey -z 8s -c 2000 http://ngx-fdfix/
  Requests/sec: 29029.2874     # 吞吐一样；零拒绝
```

吞吐没有任何变化（29,029 对 29,263 req/s——噪声）。这正是重点：fd 的修法买到的是**边缘上的可靠性**，不是原始速度。nginx 调优里满是这种"只在逼近上限时才有意义"的旋钮——这就是为什么你要对着测量结果调，而不是对着民间传说调。

## keepalive：你花过最便宜的 req/s

一次 keepalive 请求，就是一次省掉 TCP 握手的请求。`keepalive_timeout` 默认 65 秒，很宽松，也没问题。我把它关掉——`keepalive_timeout 0;`——用同一份调优配置重跑同样的负载：

```text
keepalive_timeout 65   ->  Requests/sec: 39527.9401   p50 1.0 ms  p99 5.1 ms
keepalive_timeout 0    ->  Requests/sec: 12150.6553   p50 3.9 ms  p99 8.7 ms
```

一条指令，3 倍的吞吐坍塌，全花在建连上。高请求量下还有两个相关默认值：`keepalive_requests`（默认 1000）会让一条连接在服务满 1000 个请求后关闭，`keepalive_time` 是对慢客户端的头部读取兜底。在代理的另一侧，上游 keepalive 是另一个指令——你需要在 `upstream` 块里写 `keepalive N;`，并在每个 location 里加 `proxy_set_header Connection "";`——而且每一条停在那的空闲上游连接，都实打实吃掉一份 `worker_connections`。Keepalive 不是免费的；它只是比握手便宜。

## 那些便宜的 kernel 红利，说实话排名

常说的"必备清单"是 `sendfile`、`tcp_nopush`、`tcp_nodelay` 和 `open_file_cache`。我对着默认配置，在三个并发档位上跑这一套。完整的调优配置：

```nginx
worker_processes        auto;
worker_rlimit_nofile    4096;          # 只有硬限额允许时才有意义
events { worker_connections 8192; }
http {
    sendfile        on;                 # 内核态文件拷贝，零用户态往返
    tcp_nopush      on;                 # 头部和正文合并成完整段发出
    tcp_nodelay     on;                 # ...但别让最后一段残包干等
    keepalive_timeout   65;
    keepalive_requests  10000;          # 不再每 1000 个请求就回收连接
    open_file_cache          max=10000 inactive=30s;
    open_file_cache_valid    60s;
    open_file_cache_min_uses 2;
    open_file_cache_errors   on;
    # gzip 保持关闭：被测文件只有 30 字节（真正的 gzip 见配置手册）
    server { listen 80; root /usr/share/nginx/html; location / { index index.html; } }
}
```

真实数字，同一台机器，同一个 30 字节文件：

```text
        c=1              c=50             c=100
默认    5,709.58 req/s   21,927.01 req/s  21,116.02 req/s
       (p99 0.3 ms)      (p99 8.6 ms)     (p99 15.6 ms)
调优    8,246.49 req/s   39,527.94 req/s  38,403.32 req/s
       (p99 0.2 ms)      (p99 5.1 ms)     (p99 8.4 ms)
```

并发下大约 2 倍，延迟也全面更低。但我一次改了好几样，所以我把它们拆开单独验证——其中一个结果直接反杀了民间传说：

- **`access_log off` 是最大的单一贡献者。** 同一份调优配置、把日志加回来：c=50 两轮分别是 34,472 和 26,818 req/s——只有关日志的三分之一到一半，只因每个请求多一次写盘 `write()`。如果你不会逐行读日志，就把日志开缓冲（`access_log ... buffer=32k;`）或采样。
- **`multi_accept on` 让情况变糟。** 开着它时，负载期间每个 worker 的 CPU 肉眼可见地偏——一个 worker 约 40%，一个 0%，而 hey 还挂着 60 条连接：

```text
$ /proc/<pid>/stat ticks, 3 秒窗口, c=60:
worker 35  cpu_ticks=119  est_cpu=40%
worker 36  cpu_ticks=0    est_cpu=0%
worker 34  cpu_ticks=38   est_cpu=13%
```

每次 accept 唤醒，一个 worker 就抢走一批连接，其他 worker 闲着——正是文档警告过的那种失衡。去掉 `multi_accept` 后分布恢复均匀，吞吐不变（c=50 下 34,384–38,771 req/s）。我上面最终的配置里**没有**它。

<figure>
<svg viewBox="0 0 720 360" width="100%" role="img" aria-label="示意图：一个 nginx master 进程持有共享监听套接字，下面是八个 worker 进程。每个 worker 的连接数受 worker_connections 限制，而每条连接、文件和上游套接字还同时消耗该 worker 的文件描述符额度，即 ulimit -n 或 worker_rlimit_nofile。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <line x1="360" y1="64" x2="360" y2="92"/>
    <path d="M360 96 l-5 -9 h10 z" fill="currentColor" stroke="none"/>
  </g>
  <rect x="230" y="14" width="260" height="50" rx="9" fill="none" stroke="#0f766e" stroke-width="1.6"/>
  <text x="360" y="36" text-anchor="middle" fill="#0f766e" font-family="ui-monospace, monospace" font-size="13">master 进程</text>
  <text x="360" y="54" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5">解析配置，持有监听套接字</text>
  <text x="360" y="120" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.8">共享监听套接字——worker 竞相 accept()</text>
  <g fill="none" stroke="currentColor" stroke-width="1.3">
    <rect x="20"  y="140" width="160" height="74" rx="8"/>
    <rect x="200" y="140" width="160" height="74" rx="8"/>
    <rect x="380" y="140" width="160" height="74" rx="8"/>
    <rect x="560" y="140" width="140" height="74" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5">
    <text x="100" y="162" text-anchor="middle">worker 1</text>
    <text x="280" y="162" text-anchor="middle">worker 2</text>
    <text x="460" y="162" text-anchor="middle">worker 3</text>
    <text x="630" y="162" text-anchor="middle">… worker 8</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.85">
    <text x="100" y="184" text-anchor="middle">1 线程，epoll</text>
    <text x="280" y="184" text-anchor="middle">1 线程，epoll</text>
    <text x="460" y="184" text-anchor="middle">1 线程，epoll</text>
    <text x="630" y="184" text-anchor="middle">每核一个</text>
    <text x="100" y="202" text-anchor="middle">连接、文件、上游</text>
    <text x="280" y="202" text-anchor="middle">连接、文件、上游</text>
    <text x="460" y="202" text-anchor="middle">连接、文件、上游</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.4">
    <rect x="40" y="236" width="290" height="44" rx="8"/>
    <rect x="370" y="236" width="300" height="44" rx="8"/>
  </g>
  <g font-family="ui-monospace, monospace" font-size="12">
    <text x="185" y="256" text-anchor="middle" fill="#0f766e">worker_connections</text>
    <text x="185" y="273" text-anchor="middle" fill="#0f766e">按 worker 计，任何连接</text>
    <text x="520" y="256" text-anchor="middle" fill="currentColor">ulimit -n / worker_rlimit_nofile</text>
    <text x="520" y="273" text-anchor="middle" fill="currentColor">fd 额度——真正的天花板</text>
  </g>
  <text x="360" y="252" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" opacity="0.7">对</text>
  <text x="360" y="316" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.85">最大客户端数 = worker 数 × min(worker_connections, fd 上限) − 代理 − 日志</text>
</svg>
<figcaption>每个 worker 有两个天花板，不是一个。`worker_connections` 数 worker 持有的每一条连接；文件描述符上限要为这些连接加上文件和上游套接字买单。谁小谁决定墙什么时候来——八个 worker、每 worker 250 个 fd，就是一面 2,000 连接的墙，我恰好就撞在那。</figcaption>
</figure>

关于吞吐表有一点提醒：整场实验都跑在同一台机器里，客户端和服务端共享同一个内核。默认配置 c=100 那轮里，一次 `docker stats` 采样显示 nginx 自己只占八核中的 121% CPU——瓶颈*不在*服务端；客户端和回环路径本身就是天花板的一部分。这又是[负载测试那篇](/zh/posts/load-testing/)的教训：信任何 req/s 标题数字之前，先看服务端的 CPU。可迁移的是相对效果和故障形态；绝对数字是我这台笔记本的属性，不是你的。

## 值不值？

对一台一两核小机器上的静态站点，默认配置其实完全够用：`auto` 个 worker、每 worker 1024 连接、一切默认。我的基线在 c=50 下照样有 21,927 req/s——大多数博客永远看不到这个数。调优只在三种特定情况下有回报，而且每种都挂着一次测量：

1. **你在做代理。** 客户端 + 上游连接在 `worker_connections` 上双倍计费，fd 上限会先咬人。把 `worker_rlimit_nofile` 和 `worker_connections` 一起提，显著高于你的峰值 `并发 × 2`。
2. **你有成千上万条 keepalive 客户端**（聊天流、SSE 端点、一群慢速移动端）。连接空闲好几分钟；要按连接数而不是请求率去数它们，对着 `worker_connections`。
3. **你真的撞墙了。** 那时候它不会含蓄：日志里出现 `worker_connections are not enough`，或者 `accept4() failed (24: No file descriptors available)`。只要你在这里见过它们，两个都是一搜就有答案的问题。

我现在的实际做法：保留 `worker_processes auto;`，把 `worker_rlimit_nofile` 设成硬限额允许的一个值（32k 是个安全默认；它只是天花板，不是预分配），`worker_connections` 只跟着它同步提高，`sendfile`/`tcp_nopush`/`tcp_nodelay` 开着，静态根目录加 `open_file_cache`，盯错误日志等上面两条警告，至于 `multi_accept` 和夸张的连接数——留给那些真的测过的人。手里握着一次压测结果去调，一次只改一样，等数字不再动了，就停手。
