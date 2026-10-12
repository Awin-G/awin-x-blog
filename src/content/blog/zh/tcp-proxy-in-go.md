---
title: "用 Go 写一个 TCP 代理：80 行代码讲透整个模型"
description: "用 Go 构建一个真正的双向 TCP 代理——io.Copy、优雅关闭、超时、连接计数——80 行代码学会代理编程的完整模型。"
pubDate: 2026-12-30
lang: zh
translationKey: tcp-proxy-in-go
tags: [networking, devops]
featured: false
keywords:
  - TCP proxy
  - Go TCP proxy
  - io.Copy
  - goroutine leak
  - half-close
---

TCP 代理是网络编程里真正能学到东西的"hello world"。它小到可以装进脑子，但会逼你面对真实问题：双向数据流、半关闭（half-close）、goroutine 泄漏、背压（backpressure）、优雅关闭。在这篇文章里，我会用大约 80 行 Go 代码写一个完整的 TCP 代理，对本地 echo 服务器跑起来，向你展示实际发生的一切。

## 最小可用版本

TCP 代理的核心简单得几乎令人尴尬：

1. 用 `net.Listen` 监听本地地址
2. 循环 accept 连接
3. 对每个连接，`net.Dial` 上游
4. 用两个 `io.Copy` 双向拷贝数据
5. 完成后关闭两侧连接

就这些。下面是可用最小版本：

```go
func handle(client net.Conn) {
    defer client.Close()
    upstream, err := net.Dial("tcp", "127.0.0.1:8000")
    if err != nil {
        return
    }
    defer upstream.Close()

    go io.Copy(upstream, client) // client -> upstream
    io.Copy(client, upstream)     // upstream -> client
}
```

每个方向一个 goroutine，前台再跑一个 `io.Copy`。当 upstream→client 的拷贝完成时，`handle` 返回，两个连接关闭，一切清理干净。

但这个最小版本有真实的问题。我们逐个修复。

## 半关闭：每个人都搞错的细节

TCP 是全双工的：每一端都可以独立关闭自己的写方向。当客户端发送 EOF（通过 `CloseWrite`），代理应该把这个 EOF 传递给上游——但上游可能还有数据要发回来。如果你直接 `Close()` 两个连接，你会截断响应。

修复方法：当 client→upstream 的拷贝完成时，对上游调用 `CloseWrite()`；当 upstream→client 的拷贝完成时，对客户端调用 `CloseWrite()`：

```go
go func() {
    io.Copy(upstream, client)
    if tc, ok := upstream.(*net.TCPConn); ok {
        tc.CloseWrite() // 把 client 的 EOF 传给 upstream
    }
}()

go func() {
    io.Copy(client, upstream)
    if tc, ok := client.(*net.TCPConn); ok {
        tc.CloseWrite() // 把 upstream 的 EOF 传给 client
    }
}()
```

这就是**半关闭**，是代理编程中最重要的概念。没有它，你会遇到连接挂死或响应被截断——极难调试。

## Goroutine 泄漏：无声的杀手

每个 `go` 语句都是一个清理的承诺。最小版本有一个隐蔽的泄漏：如果 upstream→client 的拷贝先完成，`handle` 返回并关闭两个连接——但 client→upstream 的 goroutine 还阻塞在 `io.Copy` 里。在真实服务器上，这会泄漏 goroutine 和文件描述符，直到耗尽。

修复方法：返回之前等两个拷贝都完成。用 `sync.WaitGroup`：

```go
var wg sync.WaitGroup
wg.Add(2)
go func() { defer wg.Done(); io.Copy(upstream, client); /* 半关闭 */ }()
go func() { defer wg.Done(); io.Copy(client, upstream); /* 半关闭 */ }()
wg.Wait()
```

现在 `handle` 只会在两个方向都真正完成时才返回。没有 goroutine 泄漏。

## 超时和 deadline

没有超时的代理会永远挂起。你需要：

- **拨号超时**：不要永远阻塞在连接上游上
- **空闲超时**：杀掉安静下来的连接
- **总体超时**：限制连接最长存活时间

```go
dialer := &net.Dialer{Timeout: 5 * time.Second}
upstream, err := dialer.DialContext(ctx, "tcp", upstreamAddr)
```

空闲超时可以设置 read deadline 并在活动时重置，也可以用更简单的方案：带超时的 context，触发时取消连接：

```go
select {
case <-done:
case <-time.After(30 * time.Second):
    // 强制关闭两个连接
}
```

## 优雅关闭

当代理收到 SIGTERM 时，你想：
1. 停止接受新连接
2. 让正在处理的连接完成
3. 干净退出

```go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

go func() {
    <-sigCh
    ln.Close() // 停止 accept
    // 通过 WaitGroup 等待活跃 handler
}()
```

关闭 listener 会让 `Accept()` 返回错误，从而跳出 accept 循环。`sync.WaitGroup` 追踪活跃的 handler，让主协程等待它们排空。

## 计数和限制连接

你需要知道有多少活跃连接，可能还想设上限：

```go
var activeConn, totalConn atomic.Int64
var sem chan struct{} // 可选：最大并发连接数

func handle(ctx context.Context, client net.Conn) {
    activeConn.Add(1)
    totalConn.Add(1)
    defer activeConn.Add(-1)
    defer client.Close()
    // ... 代理逻辑 ...
}
```

如果用带缓冲的 channel 做信号量，就可以限制并发连接数，满时拒绝新连接——一种基本的背压。

## 完整的 80 行代理

以下是修复了所有问题的完整版本：

```go
package main

import (
    "context"
    "flag"
    "fmt"
    "io"
    "net"
    "os"
    "os/signal"
    "sync"
    "sync/atomic"
    "syscall"
    "time"
)

var (
    listenAddr   = flag.String("listen", "127.0.0.1:9000", "listen address")
    upstreamAddr = flag.String("upstream", "127.0.0.1:8000", "upstream address")
    idleTimeout  = flag.Duration("idle", 30*time.Second, "idle timeout")
    maxConns     = flag.Int("max-conns", 0, "max concurrent connections (0=unlimited)")
)

var (
    activeConn atomic.Int64
    totalConn  atomic.Int64
    sem        chan struct{}
)

func main() {
    flag.Parse()
    if *maxConns > 0 {
        sem = make(chan struct{}, *maxConns)
    }

    ln, err := net.Listen("tcp", *listenAddr)
    if err != nil {
        fmt.Fprintf(os.Stderr, "listen: %v\n", err)
        os.Exit(1)
    }
    fmt.Printf("TCP proxy listening on %s -> %s\n", *listenAddr, *upstreamAddr)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    var wg sync.WaitGroup

    go func() {
        <-sigCh
        fmt.Println("\nReceived signal, shutting down gracefully...")
        cancel()
        ln.Close()
    }()

    for {
        conn, err := ln.Accept()
        if err != nil {
            select {
            case <-ctx.Done():
                goto wait
            default:
                fmt.Fprintf(os.Stderr, "accept: %v\n", err)
                continue
            }
        }

        if sem != nil {
            select {
            case sem <- struct{}{}:
            case <-ctx.Done():
                conn.Close()
                goto wait
            }
        }

        wg.Add(1)
        go func(c net.Conn) {
            defer wg.Done()
            defer func() {
                if sem != nil {
                    <-sem
                }
            }()
            handle(ctx, c)
        }(conn)
    }
wait:
    wg.Wait()
    fmt.Printf("Total connections: %d\n", totalConn.Load())
    fmt.Println("Shutdown complete.")
}

func handle(ctx context.Context, client net.Conn) {
    activeConn.Add(1)
    totalConn.Add(1)
    defer activeConn.Add(-1)
    defer client.Close()

    fmt.Printf("[conn] active=%d total=%d remote=%s\n",
        activeConn.Load(), totalConn.Load(), client.RemoteAddr())

    dialer := &net.Dialer{Timeout: 5 * time.Second}
    upstream, err := dialer.DialContext(ctx, "tcp", *upstreamAddr)
    if err != nil {
        fmt.Fprintf(os.Stderr, "dial upstream: %v\n", err)
        return
    }
    defer upstream.Close()

    var copyWg sync.WaitGroup
    copyWg.Add(2)

    go func() {
        defer copyWg.Done()
        io.Copy(upstream, client)
        if tc, ok := upstream.(*net.TCPConn); ok {
            tc.CloseWrite()
        }
    }()

    go func() {
        defer copyWg.Done()
        io.Copy(client, upstream)
        if tc, ok := client.(*net.TCPConn); ok {
            tc.CloseWrite()
        }
    }()

    done := make(chan struct{})
    go func() {
        copyWg.Wait()
        close(done)
    }()

    select {
    case <-done:
    case <-time.After(*idleTimeout):
    case <-ctx.Done():
    }
}
```

## 对 echo 服务器跑起来

测试环境：8000 端口一个简单的 echo 服务器，9000 端口跑代理，客户端通过代理连接。

**Echo 服务器**（`echo.go`）：

```go
func main() {
    ln, _ := net.Listen("tcp", "127.0.0.1:8000")
    fmt.Println("Echo server on 127.0.0.1:8000")
    for {
        c, _ := ln.Accept()
        go func(c net.Conn) {
            defer c.Close()
            sc := bufio.NewScanner(c)
            for sc.Scan() {
                fmt.Fprintf(c, "ECHO: %s\n", sc.Text())
            }
        }(c)
    }
}
```

**运行代理并发送测试消息：**

```bash
$ go build -race -o proxy_bin main.go && go build -o echo_bin echo.go

$ ./echo_bin &
Echo server on 127.0.0.1:8000

$ ./proxy_bin -listen 127.0.0.1:9000 -upstream 127.0.0.1:8000 &
TCP proxy listening on 127.0.0.1:9000 -> 127.0.0.1:8000

$ go run test_client.go
Sent: "hello via proxy"
Received: "ECHO: hello via proxy\n"
Sent: "second connection"
Received: "ECHO: second connection\n"

# 代理会在每个连接接入时打一行日志
[conn] active=1 total=1 remote=127.0.0.1:53802
[conn] active=2 total=2 remote=127.0.0.1:53816

$ kill -TERM <proxy pid>

Received signal, shutting down gracefully...
Total connections: 2
Shutdown complete.
```

`-race` 检测器没有报告数据竞争。连接计数显示 2 个总连接。优雅关闭打印最终计数并干净退出。

## 这个代理的实际用途

- **调试**：在客户端和远端服务之间放一个代理，记录或检查流量
- **端口映射**：把本地端口转发到远端服务（穷人的 SSH 隧道）
- **TLS 终止**：用 `tls.Listen` 包裹 listener，就得到一个 TLS 终止代理
- **协议检查**：加一个 `io.TeeReader`，在数据流过时记录字节
- **限流**：在拷贝 goroutine 上加令牌桶

## 这个代理不做的事（用真正的工具）

这是学习练习，不是生产基础设施。它缺少：

- **UDP 支持**：仅 TCP。UDP 是完全不同的模型。
- **负载均衡**：只有一个上游地址，没有健康检查。
- **健康检查**：上游挂了，连接立即失败。
- **连接池**：每个客户端连接都拨号一个新的上游连接。
- **指标**：没有 Prometheus、statsd、pprof。
- **热重载**：改配置需要重启。

生产环境请用 [Envoy](https://www.envoyproxy.io/)、[HAProxy](http://www.haproxy.org/)、[nginx stream 模块](https://nginx.org/en/docs/stream/udp_stream_proxy_module.html)，或 HTTP 场景用 [Go 的 `httputil.ReverseProxy`](https://pkg.go.dev/net/http/httputil#ReverseProxy)。

## 心智模型

TCP 代理是一个**带方向的分路器（demultiplexer with direction）**。你 accept N 个连接，dial N 个上游，在它们之间搬运字节。难的不是机制——而是生命周期问题：谁关什么？goroutine 何时停？一端消失会怎样？如果你能对这 80 行代理回答这些问题，你就能推理任何代理——从 sidecar 到 service mesh。

下次遇到网络工具时，问：它的 goroutine 在哪里，`io.Copy` 在哪里，谁调 `CloseWrite`？这就是整个模型。

---

*相关文章：[NAT 穿透详解](/zh/posts/nat-traversal-explained/) · [Go 网络工具](/zh/posts/go-for-network-tools/)*