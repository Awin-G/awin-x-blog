---
title: "Go 写小型网络工具：静态二进制、goroutine 与一键交叉编译"
description: "为什么 Go 网络工具总能胜出：单文件静态二进制、一条命令交叉编译、自带 TCP 代理与 DNS 客户端的 net 包、用 goroutine 处理并发连接，以及最先咬到你的并发陷阱——无上限的 goroutine、连接泄漏、缺失的超时。"
pubDate: 2026-11-13
lang: zh
translationKey: go-for-network-tools
tags: [networking, devops]
featured: false
keywords:
  - Go 网络工具
  - Go 网络编程
  - net 包
  - 交叉编译
  - goroutine
---

只要任务不大、又跟网络有关——一个看流量的代理、一个端口扫描器、一个 DNS 查询工具、一个 HTTP 健康检查器——我第一个想到的就是 **Go 网络工具**。**Go 网络编程**不是在某个微基准上最快的方案，我也不在乎。它是从"有个想法"到"一个二进制、凌晨两点 `scp` 到机器上直接跑、不需要运行时、不需要 venv、不会撞上某个版本不对的共享库"之间最短的路径。这些工具我用 Python、C、Rust 都写过。Go 赢下了这个生态位，而且我认为它甩开第二名很远。

这篇文章讲的就是这件事：为什么它合适、几乎免费就能拿到的几样工具、一个完整可运行的例子、生产里真正会咬人的并发陷阱，以及一份诚实的清单——哪些活不该用 Go 干。

## 为什么 Go 网络工具总是胜出

四个特性，而且它们会互相放大。

**静态二进制。** `go build` 产出一个可执行文件，运行时和标准库都静态链接进去。在 Linux 上用 `CGO_ENABLED=0` 编译出的文件没有任何动态依赖——`file` 会说 `statically linked`，`ldd` 会说 `not a dynamic executable`。你把这一个文件拷到路由器、容器、128 MB 的 VPS 上，它就能跑。当部署目标是一台你管不着的机器时，这比任何基准测试都值钱。

**轻松的交叉编译。** 你不需要为每个目标平台配一套工具链。设好 `GOOS` 和 `GOARCH`，同一条 `go build` 就能在 amd64 笔记本上产出 Linux arm64 的二进制。不需要模拟、不需要 sysroot、不需要 `apt-get install gcc-aarch64-linux-gnu`。我用一个 shell 循环就能构建 `linux/amd64`、`linux/arm64` 和 `darwin/arm64`，一次全发出去。

**自带协议的 `net` 包。** 标准库直接给了 TCP/UDP socket、HTTP 客户端*和*服务端、带消息解析的 DNS 解析器、TLS 以及 URL 解析——全都在盒子里。**net 包**就是一个能用的 TCP 代理只有十五行、而不是一千五百行的原因。

**用 goroutine 处理并发连接。** 在 Go 里，扛住成千上万条连接不是一个框架选型问题，而是一个 `go` 关键字。一条连接一个 goroutine 是正常且可读的设计，调度器会把它们多路复用到少量操作系统线程上。

**构建飞快。** 小型工具 `go build` 只要一两秒。改-编-跑的循环一直很紧，对你在时间压力下临时写的运维工具来说，这一点比人们愿意承认的更重要。

## net 包几乎免费给你的东西

`net` 包是一个伪装成标准库模块的工具箱。下面这些不是练习题，是我真部署过的工具。

### 一个 TCP 代理

两个 socket 之间双向拷贝，就是两个方向各一个 `io.Copy`。核心就这么多：

```go
func proxy(client net.Conn, upstream string) {
	defer client.Close()
	server, err := net.DialTimeout("tcp", upstream, 5*time.Second)
	if err != nil {
		return
	}
	defer server.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(server, client); done <- struct{}{} }()
	go func() { io.Copy(client, server); done <- struct{}{} }()
	<-done // 任一方向关闭即结束会话
}
```

把 `io.Copy` 的返回值加上日志，你就得到一个有按方向字节计数的调试代理。

### 一个端口扫描器

对列表里每个 `host:port` 调一次 `net.DialTimeout`，放进有上限的 worker 池。就是下面的并发例子。

### 一个 DNS 查询工具

想看到某个域名解析成什么、或指定用某个解析器，都不需要第三方库：

```go
r := &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		d := net.Dialer{Timeout: 2 * time.Second}
		return d.DialContext(ctx, "udp", "1.1.1.1:53")
	},
}
addrs, err := r.LookupHost(ctx, "example.com")
```

`net.Resolver` 深入 `net` 自带的 DNS 客户端；`PreferGo: true` 让它使用纯 Go 解析器，这样各个操作系统上的行为完全一致。

### 一个 HTTP 健康检查器

带显式 `Timeout` 的 `http.Client` 加一个 `HEAD` 请求，三行就能判断服务有没有响应。而一个会读取并校验 body 的 `GET`，判断的是它响应得*对不对*——这个区别很重要，而且我反复重新体会到它。

如果你想看清这些工具在线路上到底看到了什么，配套的技能是读抓包，而不是再写更多 Go——参见[读懂你的第一次抓包](/zh/posts/reading-a-packet-capture/)。

## 一个完整例子：并发的 TCP 端口检查器

下面这个是真能用的，带上了那些"天真版本"总会遗漏的超时和取消。并发有上限、有 context deadline、还有每次拨号的超时：

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"
)

func main() {
	host := flag.String("host", "127.0.0.1", "target host")
	from := flag.Int("from", 1, "first port")
	to := flag.Int("to", 1024, "last port")
	workers := flag.Int("workers", 128, "max concurrent dials")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var (
		mu    sync.Mutex
		open  []int
		sem   = make(chan struct{}, *workers) // 给 goroutine 设上限
		wg    sync.WaitGroup
	)

	for p := *from; p <= *to; p++ {
		port := p
		sem <- struct{}{}        // 占用一个槽位（背压）
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }() // 释放槽位
			addr := net.JoinHostPort(*host, fmt.Sprint(port))
			d := net.Dialer{Timeout: 500 * time.Millisecond}
			conn, err := d.DialContext(ctx, "tcp", addr)
			if err != nil {
				return
			}
			conn.Close()
			mu.Lock()
			open = append(open, port)
			mu.Unlock()
		}()
	}

	wg.Wait()
	sort.Ints(open)
	for _, p := range open {
		fmt.Printf("%s:%d open\n", *host, p)
	}
}
```

只对你拥有的主机跑它——绝不要扫描你没有获得授权的网络。两个有用的旋钮是 `-workers`（限制内存和文件描述符）和每次拨号的 `Timeout`（被防火墙挡住的端口会挂着，没有超时就会把你的 goroutine 永远挂住）。

## Go 网络编程里的并发陷阱

goroutine 让并发很容易写，也很容易写错。下面四个是让我付出代价最多的。

**无上限的 goroutine。** 你写下 `for _, t := range targets { go probe(t) }` 的那一刻，就已经失去了对资源用量的控制。十个目标没事；一万个就是 `too many open files`，加上一台疯狂换页的机器。永远用一个带缓冲的 channel 当信号量来限流，或者用带 `SetLimit` 的 `errgroup.Group`。

**连接泄漏。** 每一次成功的 `net.Dial` 都必须被关闭，而"出错我就提前返回"正是 `Close` 被漏掉的地方。在错误检查之后立刻 `defer conn.Close()`，并且记住 `http.Client` 返回的响应 body 也必须关——没关的 body 会让连接回不了池子，从而泄漏。

**缺失的 context 和取消。** 没有 deadline 的拨号会一直等操作系统的 TCP 超时，可能超过两分钟。把 `context.Context` 从 `main` 一路传下去，并用 `DialContext`；在最上层放一个 `context.WithTimeout`，就能一次性取消所有东西。这也是让工具响应 Ctrl-C、而不是无视它的办法。

**每次拨号、每次读、每次写都要有超时。** 标准库里没有安全的默认值：无超时的 `net.Dial` 会无限阻塞，无 `Timeout` 的 `http.Client{}` 会在服务器卡住时一直挂下去。给 `http.Client` 设 `Timeout`，给 `http.Server` 设 `ReadTimeout`/`WriteTimeout`，给每次拨号设 `net.Dialer.Timeout`。一个没有超时的网络工具，就是一个对准你自己的拒绝服务工具。

```go
// 上面这一整节的一行版：
d := net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
conn, err := d.DialContext(ctx, "tcp", addr)
```

如果你要做的是把流量解析出来看，而不只是数哪些端口开着，那么[写一个 pcap 解析器](/zh/posts/writing-a-pcap-parser/)比再写一个端口扫描器更值得花你的 Go 时间。

## 一条命令交叉编译 Go 网络工具

不需要考古 Makefile。`GOOS` 和 `GOARCH` 是环境变量，关掉 CGO 就能保持二进制静态：

```bash
# linux/amd64、linux/arm64、macOS 苹果芯片——一个循环搞定
for osarch in linux/amd64 linux/arm64 darwin/arm64; do
	GOOS=${osarch%/*} GOARCH=${osarch#*/} CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w" -o "netcheck-${osarch%/*}-${osarch#*/}" .
done

# 检查你构建出来的东西
file netcheck-linux-arm64
# netcheck-linux-arm64: ELF 64-bit LSB executable, ARM aarch64, statically linked
```

`-trimpath` 会把本地路径从二进制里剥掉，`-s -w` 去掉符号表和调试信息，体积大致减半。给 32 位 ARM 路由器加 `GOARM=7`；如果构建不在 git 检出目录里，就加上 `-buildvcs=false`。

## 什么时候 Go 是错的工具

Go 是我的默认选择，不是我的信仰。有三种情况我会另找工具：

- **对延迟极度敏感的包处理。** 用户态的逐包处理需要零拷贝、无 GC 的框架——eBPF、DPDK，或者纯 C。Go 运行时的调度器和垃圾回收，对持续几毫秒到几小时的连接完全没问题，但对每秒数百万个包就不行。
- **超小型嵌入式目标。** 如果你的目标是 ESP32 或一块 320 KB RAM、有时连 MMU 都没有的单片机，Go 运行时的最低开销实在太高。那是 C 的地盘，顶多是 MicroPython——我写过[调试嵌入式上的 TCP](/zh/posts/debugging-tcp-on-embedded/)，正是因为那里的约束和一台 Linux 机器完全不是一回事。
- **用完就扔的一行命令。** 如果整个任务就是 `nc -zv host 1-1024`，那就用 `nc`。如果是针对 JSON API 的 jq 管道，`curl | jq` 比编译一个程序强。当工具需要被发布、被复用、被长期维护正确，才值得上 Go——而不是当一条 shell 管道一行就搞定的时候。

而中间的一切——代理、扫描器、健康检查、DNS 工具、日志搬运工、支撑起整个家庭实验室的那些小守护进程——Go 仍是我第一个伸手去拿的工具，也是多年之后那些二进制还在我机器上跑着的工具。
