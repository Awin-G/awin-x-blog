---
title: "Go context 包：取消、截止日期与避免 goroutine 泄漏"
description: "Go context 包的实战梳理——WithTimeout、WithCancel、WithValue、errgroup，以及忽略 ctx.Done() 时悄悄发生的 goroutine 泄漏。"
pubDate: 2027-01-27
lang: zh
translationKey: go-context-and-cancellation
tags: [devops]
featured: false
keywords:
  - Go context
  - context 取消
  - context.WithTimeout
  - goroutine 泄漏
  - errgroup
---

写过几百行 Go 代码的人，都会遇到 `context.Context`。它出现在每个 HTTP handler、每次数据库调用、每个下游 API client 的第一个参数位置。大多数开发者只是机械地使用它——把 `ctx` 传进去，偶尔检查一下 `ctx.Done()`。这篇文章讲的是你真正需要*理解*它背后的机制的时刻——因为对 context 的细微误解，正是生产环境 goroutine 泄漏、请求挂死、已取消操作停不下来的根本原因。

我会梳理构造函数、唯一重要的规则、取消信号如何传播到 HTTP 和数据库调用、出错时的 goroutine 泄漏模式，以及上线前可以跑的一份 checklist。

以下所有代码都在 `go1.27.2` 上实际运行过，输出是从终端直接粘贴的真实结果。

## `context.Context` 是什么？

`context.Context` 是一个小型接口，携带四样东西：

- **取消信号**——一个 `Done()` 通道，当 context 被取消或截止日期到达时关闭。
- **截止日期**——`Deadline()` 方法告诉你 context 何时（如果会的话）过期。
- **错误**——`Err()` 在 context 完成后返回 `context.Canceled` 或 `context.DeadlineExceeded`。
- **值**——`Value(key)` 方法用于请求作用域的数据，比如 trace ID 或 auth token。

关键词是*树*。一个 context 从父级派生。父级被取消时，所有子级都被取消。子级被取消时，不影响父级。这种单向流动使 context 成为一棵取消*树*，而非网状结构。

```go
type Context interface {
    Done() <-chan struct{}
    Err() error
    Deadline() (deadline time.Time, ok bool)
    Value(key any) any
}
```

接口故意设计得很小。没有*设置*值或*触发*取消的方法——这些能力只存在于构造函数返回的具体实现内部。

## 构造函数

### `context.Background()` 和 `context.TODO()`

`Background()` 返回根 context。它永远不会被取消，没有截止日期，不承载任何值。在 `main` 函数顶部、测试中、以及传入请求的边界处使用它。

`TODO()` 是占位符。当你知道需要一个 context 但周围代码还没有传递时使用它。它是一个稍后修复的承诺。

```go
ctx := context.Background()  // 根，永远不会被取消
```

### `context.WithCancel`

`WithCancel` 返回一个新的 context 和一个 `CancelFunc`。调用取消函数会关闭 `Done()` 并将 `Err()` 设为 `context.Canceled`。取消函数是幂等的，可以安全地多次调用——你应该配合 `defer cancel()` 来避免泄漏内部的计时器或互斥锁。

### `context.WithTimeout` 和 `context.WithDeadline`

`WithTimeout(parent, d)` 本质上是 `WithDeadline(parent, time.Now().Add(d))` 的语法糖。两者都返回一个 context，其 `Done()` 通道在指定时间后关闭，`Err()` 返回 `context.DeadlineExceeded`。底层计时器由 context 拥有；当你调用返回的 `CancelFunc` 时，计时器被停止。

### `context.WithValue`

`WithValue(parent, key, val)` 附加一个键值对。键应该是私有类型以避免冲突：

```go
type ctxKey string
const requestIDKey ctxKey = "requestID"
```

后面我们会讨论 `WithValue` 的使用规范——这是 API 中最容易被滥用的部分。

## 唯一规则：在每个阻塞路径上尊重 `ctx.Done()`

本文其余所有内容都遵循一条规则：

> 如果你的函数可能阻塞，它必须在 `ctx.Done()` 以及其他等待的 channel 或计时器之间做 select。

一个不监听 `ctx.Done()` 的阻塞操作，是一个可能比活得更久的 goroutine。如果父级是一个返回的 HTTP 请求 handler，那么被阻塞的 goroutine 就泄漏了——它会永远坐在那里（直到进程退出），消耗内存、文件描述符，有时还占用连接池中的连接。

修复方式永远是相同的模式：

```go
select {
case <-ctx.Done():
    return ctx.Err()
case result := <-someChannel:
    // 继续执行
}
```

让我用真实代码来展示。

### `context.WithTimeout` 实战

这是一个最小例子：我们启动一个需要两秒的操作，但给它 500 毫秒的超时。

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

真实输出：

```
  ctx.Done() after 501ms
  ctx.Err() = context deadline exceeded
  errors.Is(ctx.Err(), context.DeadlineExceeded) = true
```

操作在 501 毫秒后被取消——不是 2 秒。`errors.Is` 检查确认 `DeadlineExceeded` 是你可以在生产代码中匹配的特定错误。

### `context.WithCancel` 通过调用链传播

取消通过调用链自动传播，只要每个函数都把 context 传递给下一个。下面是一个 worker，它定时执行直到 context 被取消：

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

两个 worker 共享同一个父 context。350 毫秒后父级调用 `cancel()`：

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

两个 worker 在父级调用 `cancel()` 后的微秒级时间内就看到了 `ctx.Err() == context.Canceled`。没有轮询、没有睡眠、没有共享布尔变量——`Done()` 通道完成所有工作。

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
  <text x="320" y="290" text-anchor="middle" class="small">每个子级在微秒级时间内通过各自的 Done() 通道观察到取消</text>
</svg>
<figcaption>图 1 — 在父级 context 上调用 cancel() 会传播到所有子级。每个子级通过自己的 Done() 通道独立观察 context.Canceled。</figcaption>
</figure>

## 真实世界中的取消

上面的例子是真实代码的简化版本。在生产环境中，需要尊重 context 的操作是 HTTP 请求、数据库查询和下游 gRPC 调用。好消息是标准库和大多数流行的第三方库已经接好了 context。你只需要使用正确的构造函数。

### `http.NewRequestWithContext`

`net/http` 包有专用构造函数：

```go
req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
```

一旦请求绑定了 context，当 context 被取消或截止日期到达时，HTTP 客户端会中止进行中的请求。这是对一个睡眠两秒的本地服务器的真实测试，使用 400 毫秒超时：

```go
ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
defer cancel()

req, _ := http.NewRequestWithContext(ctx, "GET", slowServer.URL, nil)
start := time.Now()
resp, err := http.DefaultClient.Do(req)
```

真实输出：

```
  request failed after 401ms: Get "http://127.0.0.1:40809": context deadline exceeded
  errors.Is(err, context.DeadlineExceeded) = true
```

请求在 401 毫秒后被中止。错误是 `*url.Error` 包装的 `context.DeadlineExceeded`，这就是为什么 `errors.Is` 是检查它的正确工具——直接 `==` 比较会因为包装层而失败。

### 数据库调用

每个主流 Go 数据库驱动都支持 context。模式始终相同：将 context 作为第一个参数传给 `Query`、`Exec` 或 `BeginTx`。驱动会在 context 完成时取消底层连接操作。

```go
rows, err := db.QueryContext(ctx, "SELECT id FROM users WHERE active = ?", true)
```

如果 context 在查询进行中被取消，驱动返回 `ctx.Err()` 并将连接归还给连接池。如果不支持 context，你只能等待数据库自身的超时——这可能长得多，或者根本没有设置。

### `errgroup` 和共享取消

`golang.org/x/sync/errgroup` 包是运行一组 goroutine 并等待它们全部完成的标准方式。`WithContext` 变体返回一个 context，当组中任何 goroutine 返回非 nil 错误时它就被取消：

```go
func WithContext(ctx context.Context) (*Group, context.Context)
```

这给了你一个强大的模式：一个兄弟失败时取消所有其他兄弟，这样你不必在结果已经确定后还等待落后者。

```go
g, ctx := errgroup.WithContext(context.Background())

g.Go(func() error {
    return callServiceA(ctx)
})
g.Go(func() error {
    return callServiceB(ctx)
})

if err := g.Wait(); err != nil {
    // 至少一个 goroutine 失败了；ctx 已经被取消
}
```

当 `callServiceA` 返回错误时，派生的 `ctx` 被取消，`callServiceB` 会看到 `ctx.Done()` 关闭，即使它正在处理请求。这是实现"一个失败就取消其余"的最简洁方式，不需要手写互斥锁和布尔标志。

我还手写了一个简化版本来展示 `errgroup` 在底层做了什么——三个 worker 共享一个 context，父级在 250 毫秒后取消：

```go
ctx, cancel := context.WithCancel(context.Background())
// ... 三个 goroutine 在 ctx.Done() 和 time.After 之间 select ...
cancel()
```

真实输出：

```
  cancelling shared context...
  task 3 cancelled: context canceled
  task 1 cancelled: context canceled
  task 2 cancelled: context canceled
```

所有三个任务都观察到 `context.Canceled` 并退出。这就是 `errgroup.WithContext` 为你自动完成的模式。

## `WithValue` 的使用规范

`context.WithValue` 是 API 中最容易被误用的部分。Go 文档说得很明确：

> 仅将 context Values 用于跨进程和 API 传递的请求作用域数据，不要用于向函数传递可选参数。

问题在于 `WithValue` 在调用点是不可见的。如果函数签名是 `ProcessRequest(ctx context.Context, body string)`，你无法从签名看出函数需要 context 中的 `requestID`。编译器不会捕获缺失的值。失败模式是运行时静默返回 `nil`。

正确的规则是：

- **可以 `WithValue`** 用于真正跨越进程边界的数据——通过 HTTP header 传播的 trace ID、中间件提取的 auth token、在边缘解析的 tenant ID。
- **不要 `WithValue`** 用于可选参数、feature flag 或依赖注入。如果函数需要数据库句柄，把数据库句柄作为参数传入。
- **始终使用私有键类型**（`type ctxKey string`）以避免包之间的冲突。
- **在边界处提取值，显式向内传递。** handler 应该从 context 中提取 trace ID 并作为字符串参数传给业务逻辑。业务逻辑永远不应该从 context 中反查它。

```go
// 好：值在边界设置，立即提取
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    requestID, _ := ctx.Value(requestIDKey).(string)
    doWork(ctx, requestID)  // 显式参数
}

// 坏：值在 main 中设置，在调用栈深处依赖
func doWork(ctx context.Context, ...) {
    requestID, _ := ctx.Value(requestIDKey).(string)  // 谁设置的？不知道。
}
```

## 咬人的 goroutine 泄漏

最常见的 context 相关生产 bug 就是忽略 `ctx.Done()` 导致的 goroutine 泄漏。下面是这个模式：

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    resultCh := make(chan int)
    go func() {
        result := slowComputation()  // 3 秒
        resultCh <- result
    }()

    select {
    case result := <-resultCh:
        fmt.Fprint(w, result)
    case <-r.Context().Done():
        return  // 客户端断开连接
    }
}
```

当客户端断开连接时，`r.Context()` 被取消。handler 返回。但运行 `slowComputation` 的 goroutine 还在执行，它阻塞在 `resultCh` 的发送上——一个已经没有人读取的 channel。goroutine 泄漏了。每个泄漏的 goroutine 持有自己的栈（几 KB）、它引用的任何对象（可能是大对象），有时还有一个连接或文件描述符。

让我用真实数字来演示：

```go
// 忽略 context——goroutine 在计时器上阻塞，没有逃逸路径
var wg sync.WaitGroup
for i := 0; i < 5; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        time.Sleep(3 * time.Second)  // 没有 ctx.Done() 检查
    }()
}
```

`runtime.NumGoroutine()` 的真实输出：

```
  goroutines before: 1
  goroutines while sleeping: 6
  goroutines after sleep: 6
  goroutines after Wait: 1
```

计数从 1 升到 6 并保持。在这个玩具程序中，goroutine 最终会完成，因为 `time.Sleep` 有固定持续时间。但在真实代码中，被阻塞的操作通常是 channel 发送、数据库查询或没有超时的锁获取——这些永远不会自行完成。

修复方法是在每个阻塞路径上添加 `ctx.Done()`：

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

真实输出：

```
  goroutines before: 1
  goroutines while running: 6
  calling cancel()...
  goroutines after cancel+Wait: 1
  All goroutines exited cleanly - no leak.
```

计数在 `cancel()` 后立即回到 1。这就是全部要点。

## Context 正确的 Go 代码 checklist

在你发布涉及 context 的代码之前，过一遍这个列表：

1. **函数是否将 `context.Context` 作为第一个参数？** 如果它可能阻塞，就应该。
2. **每个阻塞操作是否在 `ctx.Done()` 上做 select？** channel 发送、channel 接收、`time.Sleep`、`Lock`、`Wait`——全都需要 `ctx.Done()` 逃生舱。
3. **在 `WithCancel`、`WithTimeout` 或 `WithDeadline` 之后是否立即 `defer cancel()`？** 忘记这个会泄漏内部计时器。
4. **是否将 context 传递给下游调用？** HTTP 请求、数据库查询和 gRPC 调用都应该接收 context，而不是 `context.Background()`。
5. **是否使用 `errors.Is(err, context.DeadlineExceeded)` 或 `errors.Is(err, context.Canceled)` 检查 context 错误？** 直接 `==` 比较在错误被包装时会失败。
6. **扇出工作时是否使用 `errgroup.WithContext`？** 它在任何兄弟失败时提供共享取消。
7. **是否仅将 `WithValue` 用于跨进程边界的请求作用域数据？** 可选参数应该是函数参数。
8. **能否证明请求完成后 goroutine 计数回到基线？** 如果 `runtime.NumGoroutine()` 持续攀升，就是有泄漏。

## 总结

`context.Context` 不是魔法——它是一个带有树形取消协议和基于通道的通知机制的小接口。复杂性不来自 API，而是来自它要求的纪律：每个阻塞路径必须监听 `ctx.Done()`，你启动的每个 goroutine 必须有办法停止。把这两件事做对，其余的就会各就各位。

关于 Go 并发工具链中 race detector 的部分，参见 [Go 并发与 race detector](/zh/posts/go-concurrency-race-detector/)。关于实用的 Go 命令行工具，参见 [Go 网络工具实战](/zh/posts/go-for-network-tools/)。
