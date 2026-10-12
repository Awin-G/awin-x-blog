---
title: "Writing a TCP proxy in Go: 80 lines that teach the whole model"
description: "Build a real bidirectional TCP proxy in Go with io.Copy, graceful shutdown, timeouts, and connection counting — and learn the whole proxy model in 80 lines."
pubDate: 2026-12-30
lang: en
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

A TCP proxy is the "hello world" of network programming that actually teaches you something. It's small enough to hold in your head, but it forces you to confront the real problems: bidirectional flow, half-close, goroutine leaks, backpressure, and graceful shutdown. In this post I'll build a Go TCP proxy in about 80 lines, run it against a local echo server, and show you exactly what happens.

## The minimum that works

The core of a TCP proxy is almost embarrassingly simple:

1. `net.Listen` on a local address
2. Accept connections in a loop
3. For each connection, `net.Dial` the upstream
4. Copy data in both directions with `io.Copy`
5. Close both sides when done

That's it. Here's the minimum viable version:

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

One goroutine per direction, one `io.Copy` in the foreground. When the upstream->client copy finishes, `handle` returns, both connections close, and everything cleans up.

But this minimum has real problems. Let's fix them one by one.

## Half-close: the detail everyone gets wrong

TCP connections are full-duplex: each side can close its write direction independently. When the client sends EOF (via `CloseWrite`), the proxy should propagate that to the upstream — but the upstream might still have data to send back. If you just `Close()` both connections, you truncate the response.

The fix is `CloseWrite()` on the upstream when the client->upstream copy finishes, and `CloseWrite()` on the client when the upstream->client copy finishes:

```go
go func() {
    io.Copy(upstream, client)
    if tc, ok := upstream.(*net.TCPConn); ok {
        tc.CloseWrite() // propagate client EOF to upstream
    }
}()

go func() {
    io.Copy(client, upstream)
    if tc, ok := client.(*net.TCPConn); ok {
        tc.CloseWrite() // propagate upstream EOF to client
    }
}()
```

This is **half-close**, and it's the single most important concept in proxy programming. Without it, you'll hang connections or truncate responses in ways that are incredibly hard to debug.

## Goroutine leaks: the silent killer

Every `go` statement is a promise to clean up. The minimum version has a subtle leak: if the upstream->client copy finishes first, `handle` returns and closes both connections — but the client->upstream goroutine is still blocked in `io.Copy`. On a real server, this leaks goroutines and file descriptors until you run out.

The fix: wait for both copies to finish before returning. Use a `sync.WaitGroup`:

```go
var wg sync.WaitGroup
wg.Add(2)
go func() { defer wg.Done(); io.Copy(upstream, client); /* half-close */ }()
go func() { defer wg.Done(); io.Copy(client, upstream); /* half-close */ }()
wg.Wait()
```

Now `handle` only returns when both directions are truly done. No leaked goroutines.

## Timeouts and deadlines

A proxy without timeouts is a proxy that hangs forever. You need:

- **Dial timeout**: don't block forever connecting to upstream
- **Idle timeout**: kill connections that go quiet
- **Overall timeout**: cap how long a connection can live

```go
dialer := &net.Dialer{Timeout: 5 * time.Second}
upstream, err := dialer.DialContext(ctx, "tcp", upstreamAddr)
```

For idle timeouts, you can set read deadlines and reset them on activity, or use a simpler approach: a context with timeout that cancels the connection when it fires:

```go
select {
case <-done:
case <-time.After(30 * time.Second):
    // force close both connections
}
```

## Graceful shutdown

When your proxy gets SIGTERM, you want to:
1. Stop accepting new connections
2. Let in-flight connections finish
3. Exit cleanly

```go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

go func() {
    <-sigCh
    ln.Close() // stop accepting
    // wait for active handlers via WaitGroup
}()
```

Closing the listener causes `Accept()` to return an error, which breaks the accept loop. A `sync.WaitGroup` tracks active handlers so you can wait for them to drain.

## Counting and limiting connections

You need to know how many connections are active, and you probably want to cap them:

```go
var activeConn, totalConn atomic.Int64
var sem chan struct{} // optional: max concurrent connections

func handle(ctx context.Context, client net.Conn) {
    activeConn.Add(1)
    totalConn.Add(1)
    defer activeConn.Add(-1)
    defer client.Close()
    // ... proxy logic ...
}
```

If you set a semaphore (buffered channel), you can limit concurrent connections and reject new ones when full — a basic form of backpressure.

## The complete 80-line proxy

Here's the full version with all the fixes:

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

## Running it against an echo server

Here's the test setup: a simple echo server on port 8000, the proxy on port 9000, and a client connecting through the proxy.

**Echo server** (`echo.go`):

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

**Running the proxy and sending a test message:**

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

# the proxy logs each accepted connection as it arrives
[conn] active=1 total=1 remote=127.0.0.1:53802
[conn] active=2 total=2 remote=127.0.0.1:53816

$ kill -TERM <proxy pid>

Received signal, shutting down gracefully...
Total connections: 2
Shutdown complete.
```

The `-race` detector reports no data races. The connection counter shows 2 total connections. Graceful shutdown prints the final count and exits cleanly.

## What this proxy is useful for

- **Debugging**: put a proxy between your client and a remote service to log or inspect traffic
- **Port mapping**: forward a local port to a remote service (the poor man's SSH tunnel)
- **TLS termination**: wrap the listener with `tls.Listen` and you have a TLS-terminating proxy
- **Protocol inspection**: add a `io.TeeReader` to log bytes as they pass through
- **Rate limiting**: add a token bucket on the copy goroutines

## What this proxy does NOT do (use a real tool)

This is a learning exercise, not production infrastructure. It lacks:

- **UDP support**: TCP only. UDP is a completely different model.
- **Load balancing**: one upstream address, no health checking.
- **Health checks**: if upstream is down, connections fail immediately.
- **Connection pooling**: every client connection dials a new upstream connection.
- **Metrics**: no Prometheus, no statsd, no pprof.
- **Hot reload**: changing config requires a restart.

For production use, look at [Envoy](https://www.envoyproxy.io/), [HAProxy](http://www.haproxy.org/), [nginx stream module](https://nginx.org/en/docs/stream/udp_stream_proxy_module.html), or [Go's own `httputil.ReverseProxy`](https://pkg.go.dev/net/http/httputil#ReverseProxy) for HTTP-specific workloads.

## The mental model

A TCP proxy is a **demultiplexer with direction**. You accept N connections, dial N upstreams, and shuttle bytes between them. The hard parts aren't the mechanics — they're the lifecycle questions: Who closes what? When do goroutines stop? What happens when one side vanishes? If you can answer those for this 80-line proxy, you can reason about any proxy, from a sidecar to a service mesh.

The next time you encounter a network tool, ask: where are its goroutines, where are its `io.Copy`s, and who calls `CloseWrite`? That's the whole model.

---

*Related: [NAT traversal explained](/posts/nat-traversal-explained/) · [Go for network tools](/posts/go-for-network-tools/)*