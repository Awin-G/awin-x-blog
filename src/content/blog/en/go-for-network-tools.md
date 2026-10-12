---
title: "Go network tools: static binaries, goroutines, and painless cross compile"
description: "Why Go network tools keep winning: static single-file binaries, one-command cross compile, a net package that ships a TCP proxy and DNS client, goroutines for concurrent connections, and the concurrency pitfalls — unbounded goroutines, leaked connections, missing timeouts — that bite first."
pubDate: 2026-11-13
lang: en
translationKey: go-for-network-tools
tags: [networking, devops]
featured: false
keywords:
  - Go network tools
  - golang networking
  - net package
  - cross compile
  - goroutines
---

I reach for **Go network tools** before anything else when the job is small and the network is involved: a proxy to peek at traffic, a port scanner, a DNS query tool, an HTTP health checker. **golang networking** is not the fastest language at any single microbenchmark, and I do not care. It is the shortest path from an idea to one binary I can `scp` to a box at 2 a.m. and run with no runtime, no venv, no shared library that is the wrong version. I have written these tools in Python, C, and Rust. Go won this niche, and I do not think it is close.

This is the case for it, the tools you get almost for free, one complete runnable example, the concurrency traps that actually bite in production, and the honest list of jobs where Go is the wrong answer.

## Why Go network tools keep winning

Four properties, and they compound.

**Static binaries.** `go build` produces a single executable with the runtime and the standard library statically linked. On Linux with `CGO_ENABLED=0` it has no dynamic dependencies at all — `file` says `statically linked`, `ldd` says `not a dynamic executable`. You copy one file to a router, a container, a 128 MB VPS, and it runs. That is worth more than any benchmark when the deploy target is a machine you do not control.

**Trivial cross compile.** You do not need a toolchain per target. Set `GOOS` and `GOARCH`, and the same `go build` emits a Linux arm64 binary from your amd64 laptop. No emulation, no sysroot, no `apt-get install gcc-aarch64-linux-gnu`. I build for `linux/amd64`, `linux/arm64`, and `darwin/arm64` in one shell loop and ship all three.

**A `net` package that already speaks the protocols.** The standard library ships TCP and UDP sockets, an HTTP client *and* server, a DNS resolver with a message parser, TLS, and URL parsing — all in the box. The `net` package is the reason a working TCP proxy is fifteen lines instead of fifteen hundred.

**Goroutines for concurrent connections.** Serving thousands of connections is not a framework decision in Go; it is a `go` keyword. One goroutine per connection is a normal, readable design, and the scheduler multiplexes them onto a handful of OS threads.

**Fast builds.** `go build` on a small tool takes a second or two. The edit-compile-run loop stays tight, which matters more than people admit for throwaway ops tooling you write under time pressure.

## What the net package gives you for free

The `net` package is a toolkit disguised as a stdlib module. These are not exercises; they are tools I have actually deployed.

### A TCP proxy

Bidirectional copy between two sockets is `io.Copy` in each direction. That is the whole idea:

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
	<-done // either direction closing ends the session
}
```

Add logging on the `io.Copy` return values and you have a debugging proxy that shows byte counts per direction.

### A port scanner

`net.DialTimeout` against each `host:port` in a bounded worker pool. That is the concurrent example below.

### A DNS query tool

You do not need a library to see what a name resolves to or to query a specific resolver:

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

`net.Resolver` reaches into `net`'s own DNS client; `PreferGo: true` makes it use the pure-Go resolver so behavior is identical on every OS.

### An HTTP health checker

`http.Client` with an explicit `Timeout`, plus a `HEAD` request, tells you a service is answering in three lines. A `GET` that reads and validates the body tells you it is answering *correctly* — a distinction that matters, and one I keep relearning.

If you want to see what these tools are actually seeing on the wire, the companion skill is reading captures, not writing more Go — see [reading your first packet capture](/posts/reading-a-packet-capture/).

## A complete example: a concurrent TCP port checker

Here is a real one, with the timeouts and cancellation that the naive version always omits. Bounded concurrency, a context deadline, and per-dial timeout:

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
		sem   = make(chan struct{}, *workers) // bound the goroutines
		wg    sync.WaitGroup
	)

	for p := *from; p <= *to; p++ {
		port := p
		sem <- struct{}{}        // acquire a slot (backpressure)
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }() // release the slot
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

Run it against a host you own — never scan a network you lack permission for. The two useful knobs are `-workers` (bounds memory and file descriptors) and the per-dial `Timeout` (a firewalled port hangs, and without a timeout it hangs your goroutine forever).

## Concurrency pitfalls in golang networking

Goroutines make concurrency easy to write and easy to get wrong. These are the four that have cost me the most.

**Unbounded goroutines.** The moment you write `for _, t := range targets { go probe(t) }` you have lost control of your resource usage. Ten targets is fine; ten thousand is a `too many open files` error and a machine that thrashes. Always bound with a buffered channel used as a semaphore, or a `errgroup.Group` with `SetLimit`.

**Connection leaks.** Every `net.Dial` that succeeds must be closed, and "I return early on error" is where the `Close` goes missing. Use `defer conn.Close()` immediately after the error check, and remember that a response body from `http.Client` must also be closed — an unclosed body keeps the connection out of the pool and leaks it.

**Missing context and cancellation.** A dial with no deadline waits for the OS TCP timeout, which can be over two minutes. Thread a `context.Context` from `main` all the way down and use `DialContext`; a `context.WithTimeout` at the top cancels everything at once. This is also how you make a tool respond to Ctrl-C instead of ignoring it.

**Timeouts on every dial, every read, every write.** There is no safe default in the stdlib: `net.Dial` with no timeout blocks indefinitely, and `http.Client{}` with no `Timeout` can hang forever on a stalled server. Set a `Timeout` on the `http.Client`, a `ReadTimeout`/`WriteTimeout` on a `http.Server`, and a per-dial `net.Dialer.Timeout`. A network tool without timeouts is a denial-of-service tool pointed at yourself.

```go
// The one-line version of the whole section:
d := net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
conn, err := d.DialContext(ctx, "tcp", addr)
```

If you are building something that parses the traffic afterwards rather than just counting open ports, [writing a pcap parser](/posts/writing-a-pcap-parser/) is a better use of your Go than another port scanner.

## Cross compile Go network tools in one command

No Makefile archaeology. `GOOS` and `GOARCH` are environment variables, and CGO off keeps the binary static:

```bash
# linux/amd64, linux/arm64, macOS apple silicon — one loop
for osarch in linux/amd64 linux/arm64 darwin/arm64; do
	GOOS=${osarch%/*} GOARCH=${osarch#*/} CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w" -o "netcheck-${osarch%/*}-${osarch#*/}" .
done

# Inspect what you built
file netcheck-linux-arm64
# netcheck-linux-arm64: ELF 64-bit LSB executable, ARM aarch64, statically linked
```

`-trimpath` strips local paths from the binary, `-s -w` drops the symbol table and debug info and cuts the size roughly in half. Add `GOARM=7` for 32-bit ARM routers and `-buildvcs=false` if the build is not inside a git checkout.

## Where Go is the wrong tool

Go is my default, not my religion. Three cases where I reach elsewhere:

- **Latency-critical packet processing.** Per-packet work in userspace needs a zero-copy, no-GC framework — eBPF, DPDK, or plain C. The Go runtime's scheduler and garbage collector are fine for connections that last milliseconds to hours, not for millions of packets per second.
- **Tiny embedded targets.** If you are shipping to an ESP32 or a microcontroller with 320 KB of RAM and sometimes no MMU, Go's runtime floor is far too high. That is C, or MicroPython at best — I have written about [debugging TCP on embedded](/posts/debugging-tcp-on-embedded/) precisely because the constraints there are nothing like a Linux box.
- **The throwaway one-liner.** If the whole task is `nc -zv host 1-1024`, use `nc`. If it is a jq pipeline over a JSON API, `curl | jq` beats a compile. Reach for Go when the tool has to be shipped, reused, or kept correct — not when a shell pipeline finishes in one line.

Everything in between — proxies, scanners, health checkers, DNS tools, log shippers, the small daemons that hold a homelab together — Go remains the tool I reach for first, and the one whose binaries are still running on my boxes years later.
