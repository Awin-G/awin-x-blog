---
title: "用 tc netem 做流量整形：可量化的延迟、丢包与限速"
description: "用 tc netem 和 tbf 在 Linux 上模拟广域网延迟、丢包和限速。所有数据来自一次性 Docker 容器的真实测量：ping RTT、限速前后吞吐量、tc -s 计数器。"
pubDate: 2027-01-04
lang: zh
translationKey: traffic-shaping-with-tc
tags: [networking, linux]
featured: false
keywords:
  - tc netem
  - 流量整形
  - 网络模拟
  - tc qdisc
  - tbf
---

当我需要知道一个服务在真实广域网链路上表现如何——高延迟、少量丢包、上行带宽受限——我不会去租一间卫星办公室。我会用 `tc netem` 和一个 `tbf` qdisc 挂在空闲接口上，然后盯着计数器看。用 `tc`（traffic control，流量控制）做流量整形，看起来像内核魔法，直到你意识到一条 `tc qdisc` 命令就能加上 100 ms 延迟、丢掉 5 % 的包、或者把备份任务限制在 2 Mbit/s——而且全部可复现、可测量。

这篇文章里，所有实验都在一个一次性 Docker 容器里用 `NET_ADMIN` 权限运行，输出全部是真实抓下来的。没有实测数据支撑的理论我不写。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="Linux 接口上 qdisc 队列对数据包做 netem 和 tbf 整形的示意图">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-auto">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Interface box -->
  <rect x="200" y="60" width="240" height="120" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="320" y="85" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="14">eth0（接口）</text>
  <!-- Queue slots -->
  <g fill="#0f766e">
    <rect x="220" y="100" width="30" height="30" rx="3"/>
    <rect x="260" y="100" width="30" height="30" rx="3"/>
    <rect x="300" y="100" width="30" height="30" rx="3"/>
    <rect x="340" y="100" width="30" height="30" rx="3" opacity="0.5"/>
    <rect x="380" y="100" width="30" height="30" rx="3" opacity="0.25"/>
  </g>
  <text x="320" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="12">qdisc（netem + tbf）</text>
  <!-- Incoming packet -->
  <rect x="60" y="105" width="40" height="24" rx="4" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="4 2"/>
  <text x="80" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">应用</text>
  <line x1="100" y1="117" x2="215" y2="117" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <!-- Outgoing packet -->
  <rect x="540" y="105" width="40" height="24" rx="4" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="560" y="150" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11">网络</text>
  <line x1="425" y1="117" x2="535" y2="117" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <!-- Labels -->
  <text x="320" y="40" text-anchor="middle" fill="#0f766e" font-family="monospace" font-size="12">delay 100ms ±10ms · loss 5% · rate 2mbit</text>
  <text x="320" y="210" text-anchor="middle" fill="currentColor" font-family="monospace" font-size="11" opacity="0.6">出向路径：应用 → qdisc → 网线</text>
</svg>
<figcaption><code>tc qdisc</code> 位于应用程序与网卡之间。<code>netem</code> 负责加延迟、抖动和丢包；<code>tbf</code> 负责限速。一切都可以用 <code>tc -s</code> 量化验证。</figcaption>
</figure>

## tc qdisc 是什么（以及它在哪里）

每个 Linux 网卡都挂着一个**队列规则**（qdisc，queueing discipline）。qdisc 决定内核把包交给驱动之后会发生什么：立即发送、暂存、丢弃还是延迟。现代内核上大多数虚拟接口（如 `lo`）的默认值是 `noqueue`，真实网卡通常是 `fq_codel` 或 `pfifo_fast`。查看当前 qdisc：

```bash
$ tc qdisc show dev lo
qdisc noqueue 0: root refcnt 2
```

这是 loopback，没有任何整形——包立刻发出。`tc` 允许你把默认 qdisc 替换成主动整形流量的规则。它来自 `iproute2` 工具集，直接操作宿主内核；在容器里需要 `--cap-add=NET_ADMIN`（不需要 `--privileged`）才能操作 qdisc。

## tc netem：可量化的网络模拟

`netem`（network emulator，网络模拟器）是一个模拟广域网条件的 qdisc：延迟、抖动、丢包、重复、乱序和损坏。它是测试软件在劣质网络上表现的标准工具，而且已经内置在 Linux 内核里，不需要额外安装任何包。

我先在 `lo` 上做了基线测量：

```bash
$ ping -c 5 -i 0.2 127.0.0.1 | tail -2
rtt min/avg/max/mdev = 0.020/0.024/0.031/0.003 ms
```

零整形：亚毫秒级 RTT。现在加上 100 ms 延迟和 ±10 ms 抖动：

```bash
$ tc qdisc add dev lo root netem delay 100ms 10ms
$ tc qdisc show dev lo
qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms  10ms

$ ping -c 5 -i 0.2 127.0.0.1 | tail -2
rtt min/avg/max/mdev = 191.343/197.231/206.342/5.917 ms
```

RTT 从 0.024 ms 跳到 197 ms——几乎正好 200 ms，因为包在 `lo` 上走两趟（去和回），`netem` 在每个方向各加 100 ms。`mdev` 为 5.9 ms 说明抖动是真实的，不是固定偏移。

接下来叠加 5 % 丢包：

```bash
$ tc qdisc change dev lo root netem delay 100ms 10ms loss 5%
$ ping -c 20 -i 0.2 127.0.0.1 | tail -3
20 packets transmitted, 17 received, 15% packet loss, time 3824ms
rtt min/avg/max/mdev = 189.739/200.373/211.389/5.438 ms, pipe 2

$ tc -s qdisc show dev lo
qdisc netem 8001: root refcnt 2 limit 1000 delay 100ms  10ms loss 5%
 Sent 4410 bytes 45 pkt (dropped 3, overlimits 0 requeues 0)
```

我配了 5 % 丢包，实测 15 %——这就是随机性（20 个样本太少了）。`tc -s` 的计数器才是 ground truth：**3 个包被 qdisc 丢弃**，白纸黑字写在输出里。这就是 `tc -s` 的意义：ping 统计是采样，内核计数器是精确的。

## 用 tbf 限速（用 htb 做公平共享）

`netem` 负责损坏和延迟；`tbf`（token bucket filter，令牌桶过滤器）负责**限速**。想让备份任务别把上行带宽占满，就用它。我用 HTTP 提供了一个 4 MB 的文件，测量限速前后的下载速度：

```bash
# 基线，无整形
$ curl -o /dev/null -s -w "speed_download=%{speed_download} B/s  time_total=%{time_total}s\n" http://127.0.0.1:8080/bigfile
speed_download=755730450 B/s  time_total=0.005550s

# 添加 tbf：2 Mbit/s，128 KB burst，400 ms latency
$ tc qdisc add dev lo root tbf rate 2mbit burst 1mbit latency 400ms
$ tc qdisc show dev lo
qdisc tbf 8008: root refcnt 2 rate 2Mbit burst 128Kb lat 400ms

$ curl -o /dev/null -s --max-time 30 -w "speed_download=%{speed_download} B/s  time_total=%{time_total}s\n" http://127.0.0.1:8080/bigfile
speed_download=251565 B/s  time_total=16.672842s
```

下载速度从 **755 MB/s 降到 251 KB/s**——慢了 3000 倍，正好卡在配置的 2 Mbit/s（250 KB/s）。4 MB 文件从 5 ms 变成 16.7 s。计数器如下：

```bash
$ tc -s qdisc show dev lo
qdisc tbf 8008: root refcnt 2 rate 2Mbit burst 128Kb lat 400ms
 Sent 4299539 bytes 161 pkt (dropped 4, overlimits 268 requeues 0)
```

`overlimits 268` 表示内核想发但令牌桶不允许的包有 268 个。`dropped 4` 表示队列满了被丢弃的包有 4 个。这就是整形生效的证据——内核把每一次违规都记下来了。

**关于 burst 和 TCP 崩溃：** 我第一次用 `burst 32kbit`（4 KB）做 tbf 实验时，下载卡了 61 s、一个字节都没传过去——TCP 崩溃了，因为令牌桶太小，根本填不满拥塞窗口。`burst` 控制令牌耗尽前能瞬间发出多少包：太小会杀死 TCP，太大就失去整形精度。对 2 Mbit/s 的限速来说，`1mbit`（128 KB）是合理默认值。

如果需要在多条流之间**公平共享**带宽，用 `htb`（hierarchical token bucket，分层令牌桶）。你定义带保证速率和可选上限的类，然后用过滤器把包导入对应的类：

```bash
$ tc qdisc add dev lo root handle 1: htb default 12
$ tc class add dev lo parent 1: classid 1:11 htb rate 2mbit burst 15k
$ tc class add dev lo parent 1: classid 1:12 htb rate 5mbit burst 15k
$ tc filter add dev lo protocol ip parent 1:0 prio 1 u32 match ip dport 8080 0xffff flowid 1:11

$ tc -s filter show dev lo parent 1:
filter protocol ip pref 1 u32 chain 0 fh 800::800 order 2048 key ht 800 bkt 0 *flowid 1:11 not_in_hw (rule hit 111 success 68)
  match 00001f90/0000ffff at 20 (success 68)
```

过滤器把 68 个包匹配到类 `1:11`（2 Mbit/s），其余全部走默认类 `1:12`（5 Mbit/s）。在 loopback 上两个方向共享同一个接口，所以请求包被整形、响应包走了默认类——这提醒我们 `tc` 是**分方向**的。

## 用 tc -s 读计数器

`-s` 参数把 `tc` 从配置工具变成测量仪器。每个 qdisc 都维护内核级计数器：发送的包数、字节数、丢弃数、超限数和积压数。模式永远一样：

```bash
$ tc -s qdisc show dev lo
 Sent 4299539 bytes 161 pkt (dropped 4, overlimits 268 requeues 0)
 backlog 0b 0p requeues 0
```

- **Sent** — 成功发出的包和字节
- **dropped** — 被丢弃的包（队列满或配置了丢包）
- **overlimits** — 想超速率发送但被拦下的包
- **backlog** — 当前队列中等待的包

我用这些计数器做两件事：证明整形规则生效（前后对比），以及检测队列是否饱和（backlog 增长 + drops 上升）。这和我分析[平均负载](/zh/posts/linux-load-average/)和[IO 延迟](/zh/posts/io-latency/)的思路一样：读内核自己的计数器，不读代理指标。

## 实际应用场景

- **复现慢网络。** 客户报告在 50 Mbit/s、丢包 2 % 的链路上超时。与其猜，不如在测试接口上跑 `netem delay 30ms loss 2%`，精确复现他们的环境。
- **测试超时和重试。** 我的 HTTP 客户端在 30 s 超时后真的会重试吗？加 `netem delay 35s` 看看。重试逻辑会不会造成惊群？加 `loss 10%` 验证。
- **限制备份任务。** `rsync` 跑满上行会让 SSH 没法用。在备份接口上 `tbf rate 20mbit` 限速，不用动应用。
- **多租户公平共享。** `htb` 配每类速率，让某个租户的大流量传输不会饿死另一个租户的延迟敏感流量。

## tc 的诚实边界

流量整形很强大，但不是没有代价。限制是真实的：

- **出向容易，入向难。** 整形出向流量（`dev eth0 root`）开箱即用。整形**入向**流量需要一个 IFB（Intermediate Functional Block）设备和过滤器把入向包重定向过去：

  ```bash
  $ ip link add ifb0 type ifb
  $ ip link set dev ifb0 up
  $ tc qdisc add dev lo handle ffff: ingress
  $ tc filter add dev lo parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
  $ tc qdisc add dev ifb0 root netem delay 50ms

  $ ping -c 5 -i 0.2 127.0.0.1 | tail -2
  rtt min/avg/max/mdev = 100.053/100.112/100.143/0.031 ms
  ```

  RTT 翻倍到 100 ms——IFB（入向）50 ms 加 `lo`（出向）50 ms。能用，但是三条命令加一个额外设备。

- **每接口、每方向。** 一个 qdisc 只管一个接口的一个方向。想整形"所有流量"，就得配置每个接口，或者在网桥/IFB 上集中处理。
- **过滤器很折腾。** `u32` 过滤器语法强大但晦涩——`match ip dport 8080 0xffff at 20` 是在匹配第 20 字节，偏移写错了会静默失败。我在 htb 过滤器上迭代了三轮，计数器才显示包真的匹配上了。
- **没有应用感知。** `tc` 看到的是包，不是进程。"把 Chrome 限制到 1 Mbit/s"需要 `cgroup` + `tc` 或 `iptables` mark——那是另一篇文章了。

## 总结

`tc` 是 Linux 内核内置的网络实验室。`tc netem` 给你可量化的延迟、抖动和丢包；`tbf` 给你硬限速；`htb` 给你公平共享。这篇文章里每一个结论都来自一次性容器的真实计数器——我踩过的坑（burst 太小导致 TCP 崩溃、过滤器匹配错偏移、veth 对完全绕过 qdisc）你不用再踩。

下次有人问"我们的应用在慢网络上能用吗？"你可以一行命令回答：`tc qdisc add dev eth0 root netem delay 100ms loss 5%`。他们要证据时，`tc -s` 就是你的答案。
