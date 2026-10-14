---
title: "Go context: cancellation, deadlines, and not leaking goroutines"
description: "A practical tour of Go's context package — WithTimeout, WithCancel, WithValue, errgroup, and the goroutine-leak pattern that bites when you ignore ctx.Done()."
pubDate: 2027-01-27
lang: en
translationKey: go-context-and-cancellation
tags: [devops]
featured: false
keywords:
  - Go context
  - context cancellation
  - context.WithTimeout
  - goroutine leak
  - errgroup
---

If you have written more than a few hundred lines of Go, you have met `context.Context`. It is that first parameter that shows up on every HTTP handler, every database call, every downstream API client. Most Go developers use it mechanically — pass `ctx` in, check `ctx.Done()` once in a while. This article is for the moment you need to actually *understand* what is happening, because a subtle misunderstanding of context is the root cause of production goroutine leaks, hung requests, and cancelled operations that refuse to stop.

I will walk through the constructors, the one rule that matters, how cancellation propagates through HTTP and database calls, the goroutine-leak pattern that appears when you get it wrong, and a checklist you can run through before shipping context-aware code.

Everything below was run on `go1.27.2`. The output is real, pasted directly from the terminal.

## What is a `context.Context`?

A `context.Context` is a small interface that carries four things:

- **Cancellation signal** — a `Done()` channel that closes when the context is cancelled or its deadline passes.
- **Deadline** — a `Deadline()` method that tells you when (if ever) the context expires.
- **Error** — `Err()` returns `context.Canceled` or `context.DeadlineExceeded` once the context is done.
- **Values** — a `Value(key)` method for request-scoped data like trace IDs or auth tokens.

The key word is *tree*. A context is derived from a parent. When the parent is cancelled, every child is cancelled. When a child is cancelled, the parent is not affected. This one-way flow is what makes context a cancellation *tree*, not a mesh.

```go
type Context interface {
    Done() <-chan struct{}
    Err() error
    Deadline() (deadline time.Time, ok bool)
    Value(key any) any
}
```

The interface is deliberately tiny. There are no methods to *set* a value or to *trigger* cancellation — those capabilities live only inside the concrete implementations returned by the constructor functions.

## The constructors

### `context.Background()` and `context.TODO()`

`Background()` returns the root context. It is never cancelled, has no deadline, and carries no values. You get it at the top of `main`, in tests, and at the boundary of incoming requests.

`TODO()` is a placeholder. Use it when you know you will need a context but the surrounding code has not threaded one through yet. It is a promise to fix it later.

```go
ctx := context.Background()  // root, never cancelled
```

### `context.WithCancel`

`WithCancel` returns a new context and a `CancelFunc`. Calling the cancel function closes `Done()` and sets `Err()` to `context.Canceled`. The cancel function is idempotent and safe to call multiple times — you should pair it with `defer cancel()` to avoid leaking the internal timer or mutex.

### `context.WithTimeout` and `context.WithDeadline`

`WithTimeout(parent, d)` is sugar for `WithDeadline(parent, time.Now().Add(d))`. Both return a context whose `Done()` channel closes after the duration elapses, and `Err()` returns `context.DeadlineExceeded`. The underlying timer is owned by the context; when you call the returned `CancelFunc`, the timer is stopped.

### `context.WithValue`

`WithValue(parent, key, val)` attaches a single key-value pair. The key should be of a private type to avoid collisions:

```go
type ctxKey string
const requestIDKey ctxKey = "requestID"
```

We will come back to the discipline around `WithValue` in a later section — it is the most abused part of the API.

## The one rule: respect `ctx.Done()` in every blocking path

Everything else in this article follows from a single rule:

> If your function can block, it must select on `ctx.Done()` alongside whatever other channel or timer it is waiting on.

A blocking operation that does not watch `ctx.Done()` is a goroutine that can outlive its parent. If the parent is an HTTP request handler that returns, the blocked goroutine is now leaked — it will sit there forever (or until the process exits), consuming memory, file descriptors, and sometimes a connection from a pool.

The fix is always the same shape:

```go
select {
case <-ctx.Done():
    return ctx.Err()
case result := <-someChannel:
    // proceed
}
```

Let me show this with real code.

### `context.WithTimeout` in action

Here is a minimal example: we start an operation that would take two seconds, but give it a 500 ms timeout.

```go
ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
defer cancel()

start := time.Now()
select {
case <-time.After(2 * time.Second):
    fmt.Println("  operation completed")
case <-ctx.Done():
    elapsed := time.Since(start)
    fmt.Printf("  ctx.Done() after %v\n", elapsed.Round(time.Millisecond))
    fmt.Printf("  ctx.Err() = %v\n", ctx.Err())
}
```

Real output:

```
  ctx.Done() after 501ms
  ctx.Err() = context deadline exceeded
  errors.Is(ctx.Err(), context.DeadlineExceeded) = true
```

The operation was cancelled after 501 ms — not 2 s. The `errors.Is` check confirms that `DeadlineExceeded` is the specific error you can match against in production code.

### `context.WithCancel` propagated through a call chain

Cancellation propagates automatically through the call chain, as long as every function passes the context through to the next. Here is a worker that ticks until the context is cancelled:

```go
func worker(ctx context.Context, name string, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            fmt.Printf("  %s: stopped (%v)\n", name, ctx.Err())
            return
        case <-ticker.C:
            fmt.Printf("  %s: tick\n", name)
        }
    }
}
```

Two workers share the same parent context. After 350 ms the parent calls `cancel()`:

```
  worker-A: tick
  worker-B: tick
  worker-A: tick
  worker-A: tick
  worker-B: tick
  main: calling cancel()
  worker-A: stopped (context canceled)
  worker-B: stopped (context canceled)
  main: all workers stopped
```

Both workers see `ctx.Err() == context.Canceled` within microseconds of the parent calling `cancel()`. There is no polling, no sleeping, no shared boolean — the `Done()` channel does the work.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
  <defs>
    <style>
      .node { fill: none; stroke: #0f766e; stroke-width: 2; }
      .cancel { fill: none; stroke: #dc2626; stroke-width: 2; stroke-dasharray: 5 3; }
      .label { font-size: 13px; fill: currentColor; }
      .small { font-size: 11px; fill: #6b7280; }
    </style>
  </defs>
  <rect x="270" y="16" width="100" height="36" rx="6" class="node"/>
  <text x="320" y="39" text-anchor="middle" class="label">Background</text>
  <line x1="320" y1="52" x2="320" y2="80" stroke="#0f766e" stroke-width="1.5"/>
  <rect x="250" y="84" width="140" height="36" rx="6" class="node"/>
  <text x="320" y="107" text-anchor="middle" class="label">WithCancel</text>
  <text x="396" y="107" class="small" fill="#dc2626">cancel()</text>
  <line x1="320" y1="120" x2="120" y2="150" stroke="#0f766e" stroke-width="1.5"/>
  <line x1="320" y1="120" x2="320" y2="150" stroke="#0f766e" stroke-width="1.5"/>
  <line x1="320" y1="120" x2="520" y2="150" stroke="#0f766e" stroke-width="1.5"/>
  <rect x="50" y="154" width="140" height="36" rx="6" class="cancel"/>
  <text x="120" y="177" text-anchor="middle" class="label">HTTP client</text>
  <rect x="250" y="154" width="140" height="36" rx="6" class="cancel"/>
  <text x="320" y="177" text-anchor="middle" class="label">DB query</text>
  <rect x="450" y="154" width="140" height="36" rx="6" class="cancel"/>
  <text x="520" y="177" text-anchor="middle" class="label">Worker pool</text>
  <line x1="120" y1="190" x2="120" y2="230" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3"/>
  <line x1="320" y1="190" x2="320" y2="230" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3"/>
  <line x1="520" y1="190" x2="520" y2="230" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="120" y="254" text-anchor="middle" class="small" fill="#dc2626">context.Canceled</text>
  <text x="320" y="254" text-anchor="middle" class="small" fill="#dc2626">context.Canceled</text>
  <text x="520" y="254" text-anchor="middle" class="small" fill="#dc2626">context.Canceled</text>
  <text x="320" y="290" text-anchor="middle" class="small">every child observes ctx.Done() within microseconds</text>
</svg>
<figcaption>FIG. 1 — Calling cancel() on a parent context propagates to every child. Each child independently observes context.Canceled via its own Done() channel.</figcaption>
</figure>

## Cancellation in the real world

The examples above are toy versions of real code. In production, the operations that need to respect context are HTTP requests, database queries, and calls to downstream gRPC services. The good news is that the standard library and most popular third-party libraries already wire context in. You just have to use the right constructor.

### `http.NewRequestWithContext`

The `net/http` package has a dedicated constructor:

```go
req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
```

Once the request is bound to the context, the HTTP client will abort the in-flight request when the context is cancelled or its deadline passes. Here is a real test against a local server that sleeps for two seconds, with a 400 ms timeout:

```go
ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
defer cancel()

req, _ := http.NewRequestWithContext(ctx, "GET", slowServer.URL, nil)
start := time.Now()
resp, err := http.DefaultClient.Do(req)
```

Real output:

```
  request failed after 401ms: Get "http://127.0.0.1:40809": context deadline exceeded
  errors.Is(err, context.DeadlineExceeded) = true
```

The request was aborted after 401 ms. The error is a `*url.Error` wrapping `context.DeadlineExceeded`, which is why `errors.Is` is the right tool for checking it — a direct `==` comparison will fail because of the wrapping.

### Database calls

Every major Go database driver supports context. The pattern is always the same: pass the context as the first argument to `Query`, `Exec`, or `BeginTx`. The driver will cancel the underlying connection operation when the context is done.

```go
rows, err := db.QueryContext(ctx, "SELECT id FROM users WHERE active = ?", true)
```

If the context is cancelled while the query is in flight, the driver returns `ctx.Err()` and the connection is returned to the pool. Without context support, you would have to wait for the database's own timeout — which might be much longer, or not set at all.

### `errgroup` and shared cancellation

The `golang.org/x/sync/errgroup` package is the standard way to run a group of goroutines and wait for all of them. The `WithContext` variant returns a context that is cancelled as soon as any goroutine in the group returns a non-nil error:

```go
func WithContext(ctx context.Context) (*Group, context.Context)
```

This gives you a powerful pattern: one failing sibling cancels all the others, so you do not wait for stragglers after the result is already determined.

```go
g, ctx := errgroup.WithContext(context.Background())

g.Go(func() error {
    return callServiceA(ctx)
})
g.Go(func() error {
    return callServiceB(ctx)
})

if err := g.Wait(); err != nil {
    // at least one goroutine failed; ctx is already cancelled
}
```

When `callServiceA` returns an error, the derived `ctx` is cancelled, and `callServiceB` sees `ctx.Done()` close even if it is mid-request. This is the cleanest way to implement "cancel the rest when one fails" without hand-rolled mutexes and boolean flags.

I also hand-rolled a simplified version to show what `errgroup` is doing under the hood — three workers share a context, the parent cancels after 250 ms:

```go
ctx, cancel := context.WithCancel(context.Background())
// ... three goroutines select on ctx.Done() vs. time.After ...
cancel()
```

Real output:

```
  cancelling shared context...
  task 3 cancelled: context canceled
  task 1 cancelled: context canceled
  task 2 cancelled: context canceled
```

All three tasks observed `context.Canceled` and exited. That is the pattern `errgroup.WithContext` automates for you.

## `WithValue` discipline

`context.WithValue` is the most misused part of the API. The Go documentation is explicit:

> Use context Values only for request-scoped data that transits processes and APIs, not for passing optional parameters to functions.

The problem is that `WithValue` is invisible at the call site. If a function signature is `ProcessRequest(ctx context.Context, body string)`, you cannot tell from the signature that the function requires a `requestID` in the context. The compiler will not catch a missing value. The failure mode is a silent `nil` at runtime.

The right rule is:

- **Do use `WithValue`** for data that truly transits the process boundary — trace IDs propagated through HTTP headers, auth tokens extracted by middleware, tenant IDs resolved at the edge.
- **Do not use `WithValue`** for optional parameters, feature flags, or dependency injection. If a function needs a database handle, pass the database handle as an argument.
- **Always use a private key type** (`type ctxKey string`) to avoid collisions between packages.
- **Extract values at the boundary, pass them explicitly inward.** A handler should pull the trace ID out of the context and pass it as a string argument to the business logic. The business logic should never reach back into the context for it.

```go
// Good: value set at the boundary, extracted immediately
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    requestID, _ := ctx.Value(requestIDKey).(string)
    doWork(ctx, requestID)  // explicit argument
}

// Bad: value set in main, relied upon deep in the call stack
func doWork(ctx context.Context, ...) {
    requestID, _ := ctx.Value(requestIDKey).(string)  // who set this? unknown.
}
```

## The goroutine leak that bites

The single most common context-related production bug is the goroutine leak caused by ignoring `ctx.Done()`. Here is the pattern:

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    resultCh := make(chan int)
    go func() {
        result := slowComputation()  // 3 seconds
        resultCh <- result
    }()

    select {
    case result := <-resultCh:
        fmt.Fprint(w, result)
    case <-r.Context().Done():
        return  // client disconnected
    }
}
```

When the client disconnects, `r.Context()` is cancelled. The handler returns. But the goroutine running `slowComputation` is still running, and it is blocked sending on `resultCh` — a channel nobody is reading anymore. The goroutine is leaked. Every leaked goroutine holds its stack (a few KB), any references it holds (potentially large objects), and sometimes a connection or file descriptor.

Let me demonstrate this with real numbers:

```go
// Ignored context — goroutines block on a timer with no escape
var wg sync.WaitGroup
for i := 0; i < 5; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        time.Sleep(3 * time.Second)  // no ctx.Done() check
    }()
}
```

Real output from `runtime.NumGoroutine()`:

```
  goroutines before: 1
  goroutines while sleeping: 6
  goroutines after sleep: 6
  goroutines after Wait: 1
```

The count went from 1 to 6 and stayed there. In this toy program the goroutines eventually finish because `time.Sleep` has a fixed duration. But in real code the blocked operation is often a channel send, a database query, or a lock acquisition with no timeout — those never finish on their own.

The fix is to add `ctx.Done()` to every blocking path:

```go
go func() {
    defer wg.Done()
    select {
    case <-ctx.Done():
        return
    case <-time.After(3 * time.Second):
        return
    }
}()
```

Real output:

```
  goroutines before: 1
  goroutines while running: 6
  calling cancel()...
  goroutines after cancel+Wait: 1
  All goroutines exited cleanly - no leak.
```

The count returns to 1 immediately after `cancel()`. That is the whole game.

## A checklist for context-correct Go

Before you ship code that touches context, run through this list:

1. **Does the function accept a `context.Context` as its first parameter?** If it can block, it should.
2. **Does every blocking operation select on `ctx.Done()`?** Channel sends, channel receives, `time.Sleep`, `Lock`, `Wait` — all of them need a `ctx.Done()` escape hatch.
3. **Do you call `defer cancel()` immediately after `WithCancel`, `WithTimeout`, or `WithDeadline`?** Forgetting this leaks the internal timer.
4. **Do you pass the context to downstream calls?** HTTP requests, database queries, and gRPC calls should all receive the context, not `context.Background()`.
5. **Do you use `errors.Is(err, context.DeadlineExceeded)` or `errors.Is(err, context.Canceled)` to check context errors?** Direct `==` comparisons fail when the error is wrapped.
6. **Are you using `errgroup.WithContext` for fan-out work?** It gives you shared cancellation when any sibling fails.
7. **Are you using `WithValue` only for request-scoped data that crosses a process boundary?** Optional parameters should be function arguments.
8. **Can you show that goroutine count returns to baseline after a request completes?** If `runtime.NumGoroutine()` keeps climbing, you have a leak.

## Wrapping up

`context.Context` is not magic — it is a small interface with a tree-shaped cancellation protocol and a channel-based notification mechanism. The complexity comes not from the API but from the discipline it demands: every blocking path must watch `ctx.Done()`, and every goroutine you spawn must have a way to stop. Get those two things right and the rest falls into place.

For the race-detector side of Go's concurrency tooling, see [Go concurrency and the race detector](/posts/go-concurrency-race-detector/). For practical Go command-line tools, see [Go for network tools](/posts/go-for-network-tools/).
