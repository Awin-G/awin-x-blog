---
title: "Go race detector 实战：它能抓到的 data race、deadlock 与 goroutine 泄漏（以及抓不到的）"
description: "一次带着真实 race detector 输出看的 Go 并发 bug 巡礼：用 go run -race 和 go test -race 复现 data race，一个让运行时崩溃的 deadlock，一个 goroutine 泄漏——外加能干净通过 -race 的 sync.Mutex、channel 所有权与 context 取消修复。"
pubDate: 2027-01-01
lang: zh
translationKey: go-concurrency-race-detector
tags: [devops, linux]
featured: false
keywords:
  - Go race detector
  - data race
  - goroutine 泄漏
  - go test -race
  - deadlock
  - context 取消
  - sync.Mutex
---

我在生产环境里追过的大多数 Go bug，都不在算法里。它们在 goroutine 之间的接缝上：一个被两个 handler 同时自增的计数器、一条永远不返回的请求路径、一个在等永远不会到来的信号的 worker。**Go race detector** 能一眼看穿其中第一类——`go test -race` 把"我机器上是通过的"变成一份报告，指明确切的行，并同时归责于两个 goroutine——而另外两类它根本看不见。接下来是我反复遇到的每一种 **data race**、deadlock 和 **goroutine 泄漏**，全部故意复现，附上 race detector 的真实输出，以及那些在生产里扛得住的修复。

Go 并发的形状很小，值得说一次。goroutine 就是一个独立运行的函数：用 `go f()` 启动，栈只要几千字节而不是线程的一兆字节，运行时把成千上万个 goroutine 多路复用到少数几个操作系统线程上。channel 是一条有类型的管道——`ch := make(chan int)`——每次 channel 操作都是一个同步点：无缓冲 channel 上的发送会阻塞，直到另一个 goroutine 接收，而这个 happens-before 关系，正是让那个值之后可以被安全触碰的东西。其余一切都是风格。共享内存的 goroutine 必须就"谁什么时候可以碰它"达成一致，而达成一致的方式只有两种：加锁（多个 goroutine 都能碰这个值，但一次只有一个），或者交接（同一时刻只有一个 goroutine 拥有这个值，把它顺 channel 传下去就转移了所有权）。下面三种 bug，就是这种一致失败的三种方式。

## Go 的三种经典并发 bug

三类 bug 几乎覆盖了我见过的一切。下面每一份报告都是从 Go 1.27、`linux/amd64` 上的真实运行原样复制来的。

### Bug 1：共享内存上的 data race

这是 Go 里最容易写出来的 bug：八个 worker，一个共享计数器，没有锁。

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

用 race detector 跑它，它会把这一行点名两次——一次是读，一次是写——再加上两个 goroutine 分别是在哪里出生的：

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

`Read at ... by goroutine 11` 是检测器刚刚观察到的访问；`Previous write ... by goroutine 14` 是这对访问的另一半；两者之间没有 happens-before 边，所以顺序是未定义的。两个 `created at` 栈就是催生这一对的 `go` 语句。退出码 66 的含义是"发现 data race，这次运行不可信"。`c.n++` 本身就是 bug：它读、加、写回，而在读和写之间另一个 goroutine 可以做同样的事——所以最终计数会悄悄丢失更新。

map 有它自己的内置检测器，不加任何 flag 你也能看到：

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

map 会大声崩溃；而一个 plain `int` 只会永远丢失计数，那更糟。

### Bug 2：Go 里的 deadlock

data race 是两个 goroutine 碰同一个东西；deadlock 是相反的失败：谁也动不了。经典形态是接收端的 off-by-one——两个 worker，三次接收：

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

两个 worker 都发送，两个值都被收走，然后第三次接收永远阻塞：

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

`fatal error: all goroutines are asleep - deadlock!` 不是可以 recover 的 panic；它是运行时发现*每一个* goroutine 都阻塞了，而这在定义上就是致命的。注意那行小字：只有当所有 goroutine 都睡着时它才触发。危险的 deadlock 是那种留着一个 goroutine 还在运行的——一个永远不挑中那个能解开别人的 case 的 `select` 循环——那种挂死悄无声息，而 `-race` 一言不发。

### Bug 3：goroutine 泄漏

安静的那个。一个阻塞在永远不会发生的接收上的 goroutine，不会崩溃、不打日志、也不会被回收：调度器引用着 goroutine，goroutine 引用着 channel，没有任何东西回收它。GC 也帮不上忙。唯一的症状是 `runtime.NumGoroutine()` 再也不往下走：

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

四轮，四千个停泊的 goroutine，每个都要占几千字节的栈外加它的 channel。一个每个请求泄漏一个 goroutine 的服务会慢慢死——慢到没人把故障和肇事的代码联系起来。

## Go race detector 能抓到什么——以及抓不到什么

把它放进 CI，并且留在那里：

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

但要睁着眼睛买它。检测器给每一次内存访问插桩，监视中间没有同步的读/写、写/写配对；它跟踪的是真实的 happens-before 图，所以报告里带着两个 goroutine 的完整栈。这些它给你——以及它不给的：

- **它只能看到你的测试真正执行到的 race。** 没有测试覆盖到的竞争路径是隐形的。race 覆盖率和测试覆盖率是两根轴。
- **它找不到 goroutine 泄漏。** 阻塞的 goroutine 不是 race。上面我的泄漏演示跑 `-race` 是干净的。
- **它找不到逻辑死锁。** `all goroutines are asleep` 检查只在所有 goroutine 都阻塞时触发。饿死 `select` 里的一个 case，或者在提前 return 时忘了给 mutex 解锁，你就会挂死，而旁边还有一个可运行的 goroutine 在看着。
- **协议违规不是 race。** 往已关闭的 channel 发送、或者少收一个值，会 panic 或挂起，但其中没有任何未同步的内存访问。
- **它有真实成本。** 同一个 benchmark、同一份代码，只差一个 flag：

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

慢大约 **17 倍**，内存 footprint 也是数倍。它是测试期工具，不是生产模式；而且第一次冷启的 `-race` 构建会用插桩后的运行时和标准库重新编译一遍。

最深的限制：**无 race 不等于正确。** 在错误的东西上加锁，只会得到一个同步得很漂亮的错误答案。

## 真正扛得住的修复

### sync.Mutex，以及什么时候 RWMutex 或 atomic 更好

mutex 版的同一个计数器——多一个字段，改三行：

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

我给自己定的规矩：mutex 保护的是**数据**，不是代码路径。对共享字段的每一次访问都要拿锁，包括 `count()` 里的那个读——加锁的写配未加锁的读仍然是 race，而且这是最常见的一种。当读远多于写、写很少时（缓存、配置重载），`sync.RWMutex` 有它的位置，但读者仍然要碰共享状态，而等待中的写者会挡住新读者——在高负载下这本身就是一场故障。对于孤零零一个计数器，`atomic.Int64` 比两者都更简单更快：

```go
var n atomic.Int64
n.Add(1) // no lock, no lost updates — for one value
```

但 atomic 的组合性很差：两个 atomic 一起更新，并不等于原子地一起更新。我的默认选择是：只要超过一个值就用 `sync.Mutex`，因为等到"这两个字段必须作为一个整体移动"成为不变式那天，atomic 版本无论如何都得重写。

### 用 channel 做所有权交接

加锁的替代方案是根本不共享。把值顺 channel 传下去，你就完成了所有权转移：只有接收方碰它，不需要锁，而发送/接收这一对*本身就是* race detector 想要的那条 happens-before 边。

<figure>
<svg viewBox="0 0 680 292" width="100%" role="img" aria-label="goroutine 之间共享数据的两种方式。左：三个 goroutine 都不加锁地读写同一个共享计数器，构成未同步的 data race。右：一个 goroutine 把值通过 channel 发送、另一个接收，完成所有权转移，同一时刻只有一个 goroutine 触碰这个值。">
  <defs>
    <marker id="own-arrow-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <text x="20" y="24" fill="currentColor" font-family="system-ui, sans-serif" font-size="13" font-weight="700">共享内存——不加锁就是 data race</text>
  <g fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.6">
    <rect x="34" y="44" width="86" height="34" rx="8"/>
    <rect x="132" y="44" width="86" height="34" rx="8"/>
    <rect x="230" y="44" width="86" height="34" rx="8"/>
  </g>
  <text x="77" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine A</text>
  <text x="175" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine B</text>
  <text x="273" y="65" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine C</text>

  <g stroke="#0f766e" stroke-width="1.6" opacity="0.85">
    <line x1="77" y1="78" x2="148" y2="140" marker-end="url(#own-arrow-zh)"/>
    <line x1="175" y1="78" x2="175" y2="140" marker-end="url(#own-arrow-zh)"/>
    <line x1="273" y1="78" x2="202" y2="140" marker-end="url(#own-arrow-zh)"/>
  </g>

  <rect x="92" y="144" width="166" height="58" rx="10" fill="none" stroke="#0f766e" stroke-width="2" stroke-dasharray="6 5"/>
  <text x="175" y="168" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12.5" font-weight="600">counter { n int }</text>
  <text x="175" y="188" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">没有 happens-before 边</text>

  <text x="20" y="234" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">WARNING: DATA RACE——修复是加锁，或者交接</text>

  <line x1="340" y1="18" x2="340" y2="250" stroke="currentColor" stroke-width="1" opacity="0.25"/>

  <text x="366" y="24" fill="#0f766e" font-family="system-ui, sans-serif" font-size="13" font-weight="700">channel——所有权转移</text>

  <rect x="360" y="60" width="88" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.6"/>
  <text x="404" y="82" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5">goroutine A</text>
  <text x="404" y="99" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.75">当前所有者</text>

  <rect x="464" y="50" width="72" height="72" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="500" y="82" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" font-weight="600">chan</text>
  <text x="500" y="97" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5" font-weight="600">int</text>

  <rect x="552" y="60" width="88" height="52" rx="8" fill="none" stroke="#0f766e" stroke-width="1.4"/>
  <text x="596" y="82" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11.5">goroutine B</text>
  <text x="596" y="99" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.8">新所有者</text>

  <g stroke="#0f766e" stroke-width="2">
    <line x1="448" y1="86" x2="460" y2="86" marker-end="url(#own-arrow-zh)"/>
    <line x1="536" y1="86" x2="548" y2="86" marker-end="url(#own-arrow-zh)"/>
  </g>

  <text x="366" y="152" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">发送 → 接收就是 happens-before 边</text>
  <text x="366" y="170" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">同一时刻只有一个 goroutine 触碰这个值</text>

  <text x="366" y="234" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">go test -race：干净——根本没有共享内存</text>
</svg>
<figcaption>左：每个 goroutine 都直接写同一个共享计数器，所以除非加锁串行化，所有访问都在竞争。右：goroutine A 通过 channel 发送这个值，goroutine B 接收它——交接转移了所有权，而发送/接收这一对本身就创造了 race detector 想要的那条 happens-before 关系。</figcaption>
</figure>

channel 也修好了我的 deadlock。worker pool 的模式是：一个由**发送方**在所有 worker 完成后关闭的 results channel——`close` 的意思是"再也不会有值了"，于是 `range` 恰好在应该结束的时候结束，不需要数数，没有 off-by-one。

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

有两条不变式让它安全：每个 channel 恰好由一个 goroutine 关闭，且它在发送方；接收方永远不需要知道 worker 的数量，因为关闭本身携带了这个信息。

### 用 context 取消管理 goroutine 生命周期

泄漏的修复是把同样的想法用到时间上。goroutine 的退出条件必须是一个*创建*它的代码能够点燃的值：一个由创建该作用域的函数取消的 `context.Context`，并且 `defer cancel()`，这样它在每条路径上都会触发——包括那些藏着"忘记清理"的提前返回错误路径。

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

泄漏消失了：同样 4000 个短命 goroutine，计数打印时它们全都已退出。context 比手搓的 `done` channel 强在三处——它取消一次，且幂等；它沿着调用树传播，不用改任何函数签名；而且每个 `net`、`http`、数据库调用本来就接受它，所以顶层一个 `context.WithTimeout` 就能一次取消整棵子树。

### errgroup，简单说

当 N 个 goroutine 做同一类活、你想让第一个错误传播出去并且只有一个汇合点时，`golang.org/x/sync/errgroup` 就是那个你否则会手写坏的东西：

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

`SetLimit` 封顶并发度，`errgroup.WithContext` 在第一个 goroutine 失败时取消组的 context，`Wait` 是你重新汇合的唯一地点。它替代的是 WaitGroup 加错误 channel 的那套舞蹈，不是思考。

## 并发安全 Go 的检查清单

我发布并发代码前会跑的一套：

- **每个共享的值恰好有一个所有者**——一个 goroutine 或一把 mutex——并且写在类型旁边的注释里。
- **每次推送都跑 `go test -race ./...`。** race 报告是构建失败，不是可以重跑的 flake。
- **同时断言结果**，就像修复版测试里 `want 8000` 那个检查：检测器抓 race，不负责抓你没注意到的丢失更新。
- **锁保护数据，不保护代码路径。** 读者也要拿锁。
- **先发布，再共享。** 把值构造完整，再交出去——通过 channel，或者在 `go` 语句之前——之后永远不要改它。
- **每个 goroutine 都有写下来的退出条件：** 一个关闭的 channel、一个取消的 context，或者一个创建者会等的 WaitGroup。
- **cancel 函数一拿到手就 `defer cancel()`**；`go vet` 的 `lostcancel` 检查能抓住忘记的那些。
- **长时间运行的服务盯住 `runtime.NumGoroutine()`**，或者加一个泄漏测试（`go.uber.org/goleak`），让泄漏在 CI 挂而不是在生产挂。
- **每个阻塞操作都有超时。** 裸 channel 接收是一个你还没遇上的 deadlock。
- **给 fan-out 设上限**——扫描、抓取都一样，和我在[用 Go 写网络工具](/zh/posts/go-for-network-tools/)里说的坑是同一个。

诚实的总结：`go test -race` 是检测器，不是证明，而且它只覆盖三类 bug 里的第一类。当一个 Go 服务在负载下行为诡异时，并发 bug 很少在日志指着的地方——这又是我那篇[读一个你没写过的代码库](/zh/posts/reading-a-codebase/)里由外向内的那个论据。先 race detector，再数 goroutine，最后读锁。这个顺序，每次如此。
