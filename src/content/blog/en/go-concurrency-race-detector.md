---
title: "Go race detector: the data races, deadlocks, and goroutine leaks it finds (and the ones it can't)"
description: "A hands-on tour of Go concurrency bugs with real race-detector output: a data race reproduced with go run -race and go test -race, a deadlock that trips the runtime, and a goroutine leak — plus the sync.Mutex, channel-ownership, and context cancellation fixes that pass -race clean."
pubDate: 2027-01-01
lang: en
translationKey: go-concurrency-race-detector
tags: [devops, linux]
featured: false
keywords:
  - Go race detector
  - data race
  - goroutine leak
  - go test -race
  - deadlock
  - context cancellation
  - sync.Mutex
---

Most of the production Go bugs I have chased were not in the algorithm. They were in the seams between goroutines: a counter two handlers incremented at once, a request path that never returned, a worker waiting on a signal nobody was going to send. The **Go race detector** finds one of those three cold — `go test -race` turns "it passed on my machine" into a report that names the exact line and blames both goroutines — and the other two bug classes it does not see at all. What follows is every **data race**, deadlock, and **goroutine leak** I keep meeting, reproduced on purpose with the detector's real output, and the fixes that hold.

The shape of Go concurrency is small, and worth stating once. A goroutine is a function running independently: you start one with `go f()`, it costs kilobytes of stack instead of a megabyte of thread, and the runtime multiplexes thousands of them onto a handful of OS threads. A channel is a typed pipe — `ch := make(chan int)` — and every channel operation is a synchronization point: a send on an unbuffered channel blocks until another goroutine receives, and that happens-before relationship is what makes the value safe to touch afterwards. Everything else is style. Goroutines that share memory must agree on who may touch it when, and there are exactly two ways to agree: a lock (many goroutines may touch the value, one at a time) or a handoff (exactly one goroutine owns the value, and passing it down a channel moves the ownership). The three bugs below are the three ways that agreement fails.

## The three classic concurrency bugs in Go

Three bug classes cover almost everything I have seen. Every report below is copy-pasted from a real run on Go 1.27, `linux/amd64`.

### Bug 1: a data race on shared memory

The cheapest bug to write in Go: eight workers, one shared counter, no lock.

```go
type counter struct {
	n int
}

func (c *counter) inc() {
	c.n++ // unsynchronized read-modify-write of shared memory
}

func main() {
	c := &counter{}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				c.inc()
			}
		}()
	}
	wg.Wait()

	fmt.Println("final count:", c.count())
}
```

Run it under the detector and it names the line twice — once for the read, once for the write — plus where both goroutines were born:

```text
$ GORACE="halt_on_error=1" go run -race ./racebug
==================
WARNING: DATA RACE
Read at 0x00c000112028 by goroutine 11:
  main.(*counter).inc()
      /tmp/opencode/work/go-race/racebug/main.go:15 +0x9c
  main.main.func1()
      /tmp/opencode/work/go-race/racebug/main.go:31 +0x97

Previous write at 0x00c000112028 by goroutine 14:
  main.(*counter).inc()
      /tmp/opencode/work/go-race/racebug/main.go:15 +0xae
  main.main.func1()
      /tmp/opencode/work/go-race/racebug/main.go:31 +0x97

Goroutine 11 (running) created at:
  main.main()
      /tmp/opencode/work/go-race/racebug/main.go:28 +0x7b

Goroutine 14 (running) created at:
  main.main()
      /tmp/opencode/work/go-race/racebug/main.go:28 +0x7b
==================

Exited with code 66
```

`Read at ... by goroutine 11` is the access the detector just observed; `Previous write ... by goroutine 14` is the other half of the pair; there is no happens-before edge between them, so the order is undefined. The `created at` stacks are the `go` statements that spawned the pair. Exit code 66 means "a race was found, this run is not trustworthy". `c.n++` is the bug itself: it reads, adds, and writes back, and between the read and the write another goroutine can do the same — so the final count silently loses updates.

Maps have their own built-in detector, which you can see with no flags at all:

```text
$ go run ./mapbug
fatal error: concurrent map writes

goroutine 11 [running]:
internal/runtime/maps.fatal({0x49ffe1?, 0x5717c0?})
	/usr/lib/go/src/runtime/panic.go:1195 +0x18
main.(*hitCounter).record(...)
	/tmp/opencode/work/go-race/mapbug/main.go:13
main.main.func1()
	/tmp/opencode/work/go-race/mapbug/main.go:25 +0xba
created by main.main in goroutine 1
	/tmp/opencode/work/go-race/mapbug/main.go:22 +0x85
```

A map crashes loudly; a plain `int` just loses counts forever, which is worse.

### Bug 2: a deadlock in Go

A data race is two goroutines touching one thing. A deadlock is the opposite failure: nobody can move. The classic shape is an off-by-one on the receive side — two workers, three receives:

```go
func main() {
	results := make(chan int) // unbuffered: every send needs a matching receive

	for i := 1; i <= 2; i++ {
		go func(id int) {
			fmt.Printf("worker %d: sending result\n", id)
			results <- id * 10
		}(i)
	}

	total := 0
	// BUG: waits for a third result that no worker will ever send.
	for i := 0; i < 3; i++ {
		total += <-results
	}
	fmt.Println("total:", total)
}
```

Both workers send, both values are collected, and then the third receive blocks forever:

```text
$ go run ./deadlockbug
worker 2: sending result
worker 1: sending result
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan receive]:
main.main()
	/tmp/opencode/work/go-race/deadlockbug/main.go:18 +0x10f

Exited with code 2
```

`fatal error: all goroutines are asleep - deadlock!` is not a recoverable panic; it is the runtime noticing that *every* goroutine is blocked, which is terminal by definition. Note the fine print: it fires only when all goroutines are asleep. The dangerous deadlocks leave one goroutine runnable — a `select` loop that never picks the case that would unblock the others — and those hang in silence while `-race` says nothing.

### Bug 3: a goroutine leak

The quiet one. A goroutine blocked on a receive that never happens does not crash, does not log, and is not garbage: the scheduler references the goroutine, the goroutine references the channel, and nothing reaps it. A GC does not help. The only symptom is `runtime.NumGoroutine()` that never comes back down:

```go
// job starts a worker that exits when done is closed.
// BUG: every call passes a fresh channel nobody can close, so the
// goroutine blocks on <-done forever.
func job(done chan struct{}) {
	go func() {
		<-done // waits for a shutdown signal that never arrives
	}()
}

func main() {
	fmt.Printf("%-6s %s\n", "round", "runtime.NumGoroutine()")
	for round := 1; round <= 4; round++ {
		for i := 0; i < 1000; i++ {
			job(make(chan struct{})) // nobody holds (or can close) this channel
		}
		time.Sleep(50 * time.Millisecond)
		runtime.GC()
		fmt.Printf("%-6d %d\n", round, runtime.NumGoroutine())
	}
}
```

```text
$ go run ./leakbug
round  runtime.NumGoroutine()
1      1001
2      2001
3      3001
4      4001
```

Four rounds, four thousand parked goroutines, each costing kilobytes of stack plus its channel. A service that leaks one goroutine per request dies slowly — slowly enough that nobody connects the outage to the code that caused it.

## What the Go race detector catches — and what it can't

Put it in CI and keep it there:

```text
$ go test -race ./...
?   	godemo/deadlockbug	[no test files]
?   	godemo/deadlockfixed	[no test files]
?   	godemo/leakbug	[no test files]
?   	godemo/leakfixed	[no test files]
?   	godemo/mapbug	[no test files]
?   	godemo/racebug	[no test files]
ok  	godemo/racefixed	1.014s
```

But buy it with your eyes open. The detector instruments every memory access and watches for read/write and write/write pairs with no synchronization between them; it tracks the actual happens-before graph, which is why reports carry both goroutines' full stacks. What that buys — and what it does not:

- **It only sees races your tests execute.** A racing path no test hits is invisible. Race coverage and test coverage are separate axes.
- **It does not find goroutine leaks.** A blocked goroutine is not a race. My leak demo above runs `-race` clean.
- **It does not find logic deadlocks.** The `all goroutines are asleep` check fires only when every goroutine is blocked. Starve one case in a `select`, or forget to unlock a mutex on an early return, and you hang with a runnable goroutine in sight.
- **Protocol violations are not races.** Sending on a closed channel or receiving one value too few panics or hangs with no unsynchronized memory access involved.
- **It has a real cost.** Same benchmark, same code, one flag apart:

```text
$ go test -run XXX -bench . -benchmem ./racefixed
BenchmarkInc-8   	15870174	        73.55 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	godemo/racefixed	1.250s

$ go test -race -run XXX -bench . -benchmem ./racefixed
BenchmarkInc-8   	   810561	      1260 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	godemo/racefixed	2.059s
```

About **17× slower**, plus a multiple of the memory footprint. It is a test-time tool, not a production mode, and the first cold `-race` build recompiles the runtime and standard library instrumented.

The deepest limit: **race-free is not correct.** A mutex around the wrong thing produces a beautifully synchronized wrong answer.

## The fixes that actually hold

### sync.Mutex, and when RWMutex or atomic is better

The mutex version of the same counter — one added field, three changed lines:

```go
type counter struct {
	mu sync.Mutex
	n  int
}

func (c *counter) inc() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
}

func (c *counter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}
```

```text
$ go run -race ./racefixed
final count: 8000

$ go test -race -v ./racefixed
=== RUN   TestConcurrentInc
--- PASS: TestConcurrentInc (0.01s)
PASS
ok  	godemo/racefixed	1.031s
```

The rule I hold myself to: a mutex guards **data**, not code paths. Every access to the shared field takes the lock, including the reader in `count()` — a locked writer with an unlocked reader is still a race, and a common one. `sync.RWMutex` earns its keep when reads dominate and writes are rare (a cache, a config reload), but readers still touch shared state, and a waiting writer blocks new readers — under load that is its own outage. For a lone counter, `atomic.Int64` is simpler and faster than either:

```go
var n atomic.Int64
n.Add(1) // no lock, no lost updates — for one value
```

But atomics compose badly: two atomics updated together are not atomic *together*. My default is `sync.Mutex` for anything past one value, because the day the invariant becomes "these two fields move as a unit", the atomic version has to be rewritten anyway.

### Channels for ownership

The alternative to locking is never sharing. Pass the value down a channel and you have transferred ownership: only the receiver touches it, no lock needed, and the send/receive pair *is* the happens-before edge the detector was asking for.

<figure>
<svg viewBox="0 0 680 292" width="100%" role="img" aria-label="Two ways to share data between goroutines. Left: three goroutines each read and write one shared counter with no lock, an unsynchronized data race. Right: one goroutine sends the value over a channel and the other receives it, transferring ownership so exactly one goroutine touches the value at a time.">
  <defs>
    <marker id="own-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <text x="20" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="700">shared memory — data race without a lock</text>
  <g fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.6">
    <rect x="34" y="44" width="86" height="34" rx="8"/>
    <rect x="132" y="44" width="86" height="34" rx="8"/>
    <rect x="230" y="44" width="86" height="34" rx="8"/>
  </g>
  <text x="77" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine A</text>
  <text x="175" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine B</text>
  <text x="273" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine C</text>

  <g stroke="#0f766e" stroke-width="1.6" opacity="0.85">
    <line x1="77" y1="78" x2="148" y2="140" marker-end="url(#own-arrow)"/>
    <line x1="175" y1="78" x2="175" y2="140" marker-end="url(#own-arrow)"/>
    <line x1="273" y1="78" x2="202" y2="140" marker-end="url(#own-arrow)"/>
  </g>

  <rect x="92" y="144" width="166" height="58" rx="10" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="6 5"/>
  <text x="175" y="168" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12.5" font-weight="600">counter { n int }</text>
  <text x="175" y="188" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">no happens-before edge</text>

  <text x="20" y="234" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">WARNING: DATA RACE — the fix is a lock, or a handoff</text>

  <line x1="340" y1="18" x2="340" y2="250" stroke="currentColor" stroke-width="1" opacity="0.25"/>

  <text x="366" y="24" fill="#0f766e" font-family="system-ui, sans-serif" font-size="13" font-weight="700">channel — ownership transfer</text>

  <rect x="360" y="60" width="88" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.6"/>
  <text x="404" y="82" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine A</text>
  <text x="404" y="99" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.75">the owner</text>

  <rect x="464" y="50" width="72" height="72" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="500" y="82" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" font-weight="600">chan</text>
  <text x="500" y="97" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" font-weight="600">int</text>

  <rect x="552" y="60" width="88" height="52" rx="8" fill="none" stroke="#0f766e" stroke-width="1.4"/>
  <text x="596" y="82" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5">goroutine B</text>
  <text x="596" y="99" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.8">new owner</text>

  <g stroke="#0f766e" stroke-width="2">
    <line x1="448" y1="86" x2="460" y2="86" marker-end="url(#own-arrow)"/>
    <line x1="536" y1="86" x2="548" y2="86" marker-end="url(#own-arrow)"/>
  </g>

  <text x="366" y="152" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">send → receive is the happens-before edge</text>
  <text x="366" y="170" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">exactly one goroutine touches the value</text>

  <text x="366" y="234" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">go test -race: clean — no shared memory at all</text>
</svg>
<figcaption>Left: every goroutine writes the shared counter directly, so all accesses race unless a lock serializes them. Right: goroutine A sends the value over a channel and goroutine B receives it — the handoff moves ownership, and the send/receive pair itself creates the happens-before relationship the race detector wants.</figcaption>
</figure>

Channels fixed my deadlock too. The worker-pool pattern is a results channel that the **sender side** closes once every worker is done: `close` means "no more values, ever", and `range` then terminates exactly when it should — no counting, no off-by-one.

```go
func main() {
	results := make(chan int)

	var wg sync.WaitGroup
	for i := 1; i <= 2; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			results <- id * 10
		}(i)
	}

	// One closer goroutine owns the close. Senders never close.
	go func() {
		wg.Wait()
		close(results)
	}()

	total := 0
	for n := range results { // terminates exactly when results is closed
		total += n
	}
	fmt.Println("total:", total)
}
```

```text
$ go run ./deadlockfixed
total: 30
```

Two invariants make it safe: exactly one goroutine closes each channel, and it is the sender side; and the receiver never needs the worker count, because the close carries that information.

### context cancellation for goroutine lifetimes

The leak fix is the same idea applied to time. A goroutine's exit condition must be a value the *creating* code can fire: a `context.Context` cancelled by the function that created the scope, with `defer cancel()` so it fires on every path, including the error returns where forgotten cleanup lives.

```go
// job starts a worker that exits when ctx is done.
// FIX: the function that creates the cancellation scope is the
// one that calls cancel(), so every worker's <-ctx.Done() is
// guaranteed to fire exactly once.
func job(ctx context.Context) {
	go func() {
		<-ctx.Done()
		// ... cleanup work that runs once, on cancellation
	}()
}

func main() {
	for round := 1; round <= 4; round++ {
		ctx, cancel := context.WithCancel(context.Background())
		for i := 0; i < 1000; i++ {
			job(ctx)
		}
		cancel() // wake all 1000 workers at once
		time.Sleep(50 * time.Millisecond)
		runtime.GC()
		fmt.Printf("round %d: %d goroutines\n", round, runtime.NumGoroutine())
	}
}
```

```text
$ go run ./leakfixed
round 1: 1 goroutines
round 2: 1 goroutines
round 3: 1 goroutines
round 4: 1 goroutines
```

The leak is gone: the same 4000 short-lived goroutines, all exited by the time the count is printed. Context beats a hand-rolled `done` channel three ways — it cancels once, idempotently; it propagates down a call tree without changing signatures; and every `net`, `http`, and database call already accepts one, so a top-level `context.WithTimeout` cancels the whole subtree at once.

### errgroup, briefly

For N goroutines doing one kind of work, where you want the first error to propagate and a single join point, `golang.org/x/sync/errgroup` is what you would otherwise hand-write badly:

```go
g := new(errgroup.Group)
g.SetLimit(8) // bound fan-out; unbounded is how leaks start
for _, t := range targets {
	t := t
	g.Go(func() error {
		return probe(ctx, t) // ctx cancellation ends stragglers
	})
}
if err := g.Wait(); err != nil { // the first error, after all goroutines join
	return err
}
```

`SetLimit` caps concurrency, `errgroup.WithContext` cancels the group's context when the first goroutine fails, and `Wait` is the single place you rejoin. It replaces the WaitGroup-plus-error-channel dance, not the thinking.

## A checklist for concurrency-safe Go

What I run before shipping concurrent code:

- **Every shared value has exactly one owner** — a goroutine or a mutex — written down in a comment next to the type.
- **`go test -race ./...` on every push.** A race report is a failed build, not a flake to re-run.
- **Assert on results too**, like the `want 8000` check in the fixed test: the detector catches races, not lost updates you failed to notice.
- **Locks guard data, not code paths.** Readers take the lock too.
- **Publish before you share.** Build the value fully, then hand it over — by channel, or before the `go` statement — and never mutate it after.
- **Every goroutine has a written exit condition:** a closed channel, a cancelled context, or a WaitGroup its creator waits on.
- **`defer cancel()` the moment the cancel function exists**; `go vet`'s `lostcancel` check catches forgotten ones.
- **Watch `runtime.NumGoroutine()`** in long-running services, or add a leak test (`go.uber.org/goleak`) so leaks fail CI instead of production.
- **Timeouts on every blocking operation.** A bare channel receive is a deadlock you have not met yet.
- **Bound the fan-out** in scans and fetches — the same trap as in my [Go network tools](/posts/go-for-network-tools/) post.

The honest summary: `go test -race` is a detector, not a proof, and it covers only the first of the three bug families. When a Go service misbehaves under load, the concurrency bugs are rarely where the logs point — which is another argument for the outside-in method in [reading a codebase you didn't write](/posts/reading-a-codebase/). Race detector first, then goroutine counts, then read the locks. In that order, every time.
