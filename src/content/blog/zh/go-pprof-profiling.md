---
title: "Go pprof：一次真实的 Go profiling，从 cpuprofile 到 heap profile"
description: "一份带真实 pprof 输出的 Go profiling 实操笔记：引入 net/http/pprof，采集 cpuprofile 与内存 profile，读 -top 和 -list，分清 alloc_space 与 inuse_space——然后用 profile 修掉一次 5.6 GB/请求的分配热点和一次手写字符串查找。"
pubDate: 2027-01-22
lang: zh
translationKey: go-pprof-profiling
tags: [devops]
featured: false
keywords:
  - Go pprof
  - Go profiling
  - cpuprofile
  - 内存 profile
  - heap profile
---

有很长一段时间，我「优化」Go 代码的方式是读代码、凭感觉锁定一个看起来慢的地方，然后重写它。效果和你预期的一样差。**Go pprof** 取代了这个习惯，而这篇博客存在的理由是：上个月一个「很慢」的日志分析接口，最终发现它把将近一半的 CPU 花在了垃圾回收器里。只靠读源码我永远找不到这个结论——因为那段代码看起来毫无问题。用 pprof 做 **Go profiling** 是「观点」和「度量」之间的分界线，所以下面每一样东西都是真实程序跑出来的真实 profile：一份真实的 **cpuprofile**、一份真实的内存 profile、一份 goroutine 转储，以及 profile 指向的那个修复的前后对比数字。这里没有任何示意图。只要出现了数字，我就真的跑了那条命令。

## Go pprof 是什么，以及怎么拿到一份 profile

pprof 是一个名字之下的三样东西：一种 profile *格式*（protobuf）、一个采样分析器、一组 HTTP 调试端点。分析器的工作方式是：运行时每秒用定时器把程序停下一百次左右，走一遍每个线程的栈，然后统计哪些函数在栈上出现过。它是统计学的，所以它几乎不给运行时增加开销，所以你可以把它开在生产环境——而且你应该开，因为一份来自真实慢请求的 profile，比任何本地 benchmark 都值钱。

对常驻服务来说，全部代码就是一个空导入：

```go
package main

import (
	"log"
	"net/http"
	_ "net/http/pprof" // 把 /debug/pprof/* 注册到 http.DefaultServeMux
)

func main() {
	log.Fatal(http.ListenAndServe("127.0.0.1:6060", nil))
}
```

因为注册在默认 mux 上，下面这些立刻全部可用——索引、CPU 分析器、堆分析器、goroutine 转储等等：

```bash
$ curl -s http://127.0.0.1:6060/debug/pprof/ | sed 's/<[^>]*>//g'
allocs
block
cmdline
goroutine
goroutineleak
heap
mutex
profile
symbol
threadcreate
trace
full goroutine stack dump
```

```bash
# 抓一份 15 秒的 CPU profile 存到磁盘
$ curl -so cpu.prof 'http://127.0.0.1:6060/debug/pprof/profile?seconds=15'

# 堆 profile（默认视图是 -inuse_space）
$ curl -so heap.prof 'http://127.0.0.1:6060/debug/pprof/heap'

# 此刻所有 goroutine 的栈，直接以文本输出
$ curl -s 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2' > goroutines.txt

# 然后随便读哪一份
$ go tool pprof -top cpu.prof
```

这个空导入不是没有代价的：它是你整个进程的调试入口，而它自己没有鉴权。绑 loopback，或者绑一个独立监听端口，绝不要暴露在公网上。对批处理任务、测试和 benchmark 来说，`runtime/pprof` 会把同样的格式写进文件，这就是给没有 HTTP 服务的代码做 profile 的方式：

```go
// 在测试或 benchmark 里
f, _ := os.Create("cpu.prof")
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()
```

## 六种 profile，各自回答什么问题

六种 profile 覆盖了我几乎全部需求：

- **CPU**（`/profile`）：程序在哪儿烧时间。由运行时定时器采样。这是我第一个伸手去拿的。
- **堆**（`/heap`）：分配量与存活对象。按四种口径报告——见下一节。
- **Goroutine**（`/goroutine`）：每个 goroutine 当前的栈，外加计数。找 goroutine 泄漏最快的方式。
- **Block**（`/block`，类型 `delay`）：goroutine 阻塞在 channel 操作、`time.Sleep` 和 select 上的时间。默认关闭——先调 `runtime.SetBlockProfileRate(1)`。
- **Mutex**（`/mutex`，同样是 `delay`）：等待获取 `sync.Mutex` 的时间。同样默认关闭——`runtime.SetMutexProfileFraction(1)`。
- **Threadcreate**（`/threadcreate`）：谁在创建 OS 线程。当 `GOMAXPROCS` 和线程数都正常但进程还是拉起了几千个线程时，偶尔有用。

一份空的 profile 是结果，不是故障。第一次把服务拉起来时，mutex 端点给我的就是这样——`Showing nodes accounting for 0, 0% of 0 total`——它准确地告诉我不存在需要去找的锁竞争。我另写了一个有 channel 竞争和 mutex 竞争的小程序，来看真实输出长什么样：

```text
$ go tool pprof -top block.prof
Type: delay
Time: 2026-10-13 11:08:42 CST
Showing nodes accounting for 5.07s, 100% of 5.07s total
      flat  flat%   sum%        cum   cum%
     3.81s 75.08% 75.08%      3.81s 75.08%  runtime.chansend1
     1.26s 24.92%   100%      1.26s 24.92%  runtime.chanrecv2
         0     0%   100%      2.59s 51.06%  main.main.func4
```

```text
$ go tool pprof -top mutex.prof
Type: delay
Showing nodes accounting for 192.68ms, 99.60% of 193.46ms total
      flat  flat%   sum%        cum   cum%
  192.68ms 99.60% 99.60%   192.70ms 99.61%  sync.(*Mutex).Unlock (inline)
         0     0% 99.60%   192.70ms 99.61%  main.main.func5
```

注意单位：CPU profile 上 `3.81s` 是 CPU 时间；block 和 mutex profile 上它是*等待时间*。两者不能互换。

## 读 profile：-top、-list 和火焰图

三条命令干完所有活。`-top` 按开销给函数排序，百分比那一列是结果。`flat` 是函数自身的时间；`cum` 是这个函数*加上它调用的所有东西*的时间。一个 `cum` 高、`flat` 低的函数是中层管理者——它不慢，它调用的东西慢。`-list <fn>` 会把函数源码重打一遍，并把样本按行归因，这就是找到「该改哪一行」的方式。而 `go tool pprof -http=:8080 cpu.prof` 会启动交互式 UI，它的 Flame Graph 页是我在调用层次很深时第一个看的地方：宽度即开销，高度即深度，那面看起来像宽砖墙的就是你的问题。

```text
File: bench_v1.test
Type: cpu
Time: 2026-10-13 10:40:19 CST
Duration: 66.43s, Total samples = 65.97s (99.31%)
Showing nodes accounting for 65.83s, 99.79% of 65.97s total
Dropped 27 nodes (cum <= 0.33s)
      flat  flat%   sum%        cum   cum%
    64.13s 97.21% 97.21%     64.17s 97.27%  profiling-demo.countTokenNaive (inline)
     1.70s  2.58% 99.79%     65.87s 99.85%  profiling-demo.scanCorpus (inline)
         0     0% 99.79%     65.87s 99.85%  profiling-demo.BenchmarkCountTokenV1
```

97.21% flat。然后是行级视角：

```text
ROUTINE ======================== profiling-demo.countTokenNaive in main.go
    64.13s     64.17s (flat, cum) 97.27% of Total
         .          .     99:	n := 0
      70ms       70ms    100:	limit := len(line) - len(token)
     2.78s      2.78s    101:	for i := 0; i <= limit; i++ {
         .          .    102:		j := 0
    18.86s     18.87s    103:		for ; j < len(token); j++ {
    42.42s     42.45s    104:			if line[i+j] != token[j] {
         .          .    105:				break
```

第 104 行——一个字节比较——占掉了 66 秒 profile 里的 42 秒。这就是 pprof 的全部价值，一屏说清楚：我不必猜循环里哪一部分贵，而我的猜测本来会是外层循环。

## alloc_space 与 inuse_space：为什么两种 heap 视图都要看

堆 profile 是最容易被读错的一种，因为 `/debug/pprof/heap` 有四个采样索引，而 pprof 把它们显示成两对：

- **alloc_space** / **alloc_objects**：*累计*值，从进程启动算起。分配过的每一个字节，不论有没有被释放。这是一个流失速率：它回答「谁在让垃圾回收器干活？」
- **inuse_space** / **inuse_objects**：取 profile 那一刻*此刻存活*的东西。它回答「到底是什么在吃我的内存？」，泄漏就是从这里暴露出来的。

这两个是不同的问题，一个 profile 在一种口径下看着吓人，在另一种口径下可能完全健康。`alloc_space` 高而 `inuse_space` 低，说明你在不断地分配又立刻丢弃——你有的是 GC 压力和延迟，不是泄漏。同一行给出高 `inuse_space`，说明有东西在*持有*它，那才是你想找的 bug。

<figure>
<p align="center">
<svg viewBox="0 0 780 336" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="修复前后的火焰图式调用栈。修复前：main.buildReportV1、runtime.concatstrings、runtime.concatstring2、runtime.memmove，以及 runtime.gcBgMarkWorker。修复后：main.runWorkload、main.scanCorpus、strings.Count、indexbytebody，而 main.buildReportV2 与 runtime.gcBgMarkWorker 几乎为零。">
  <style>
    .lbl { font: 500 10px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .sub { font: 400 9.5px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .62; }
    .hd  { font: 600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .tiny{ font: 400 9px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .7; }
  </style>
  <text class="hd" x="6" y="14">修复前 — v1 · 15 秒窗口，54.34 秒样本（362% CPU）</text>
  <text class="hd" x="404" y="14">修复后 — v2 · 同样窗口，13.60 秒样本（91% CPU）</text>

  <!-- ================= 修复前 ================= -->
  <g>
    <rect x="6" y="26" width="169" height="26" rx="3" fill="#0f766e" opacity="0.9"/>
    <text class="lbl" x="13" y="42">main.buildReportV1</text>
    <text class="sub" x="13" y="50">25.19s · 占 profile 46.4%</text>

    <rect x="20" y="58" width="158" height="26" rx="3" fill="#0f766e" opacity="0.72"/>
    <text class="lbl" x="27" y="74">runtime.concatstrings</text>
    <text class="sub" x="27" y="82">23.63s · 43.5%</text>

    <rect x="34" y="90" width="158" height="26" rx="3" fill="#0f766e" opacity="0.58"/>
    <text class="lbl" x="41" y="106">runtime.concatstring2</text>
    <text class="sub" x="41" y="114">23.63s · 43.5%</text>

    <rect x="48" y="122" width="108" height="26" rx="3" fill="#0f766e" opacity="0.46"/>
    <text class="lbl" x="55" y="138">runtime.memmove</text>
    <text class="sub" x="55" y="146">16.19s · 29.8%</text>

    <rect x="6" y="158" width="163" height="26" rx="3" fill="#0f766e" opacity="0.9"/>
    <text class="lbl" x="13" y="174">runtime.gcBgMarkWorker</text>
    <text class="sub" x="13" y="182">24.28s · 44.7% — 是 GC，不是代码</text>

    <text class="sub" x="6" y="206">同一个 15 秒窗口里还有 16.19 s 花在 memmove、</text>
    <text class="sub" x="6" y="218">2.73 s 花在 runtime.sweepone，而 main 里的代码</text>
    <text class="sub" x="6" y="230">只占 0.91 s。分配才是热点。</text>
  </g>

  <!-- ================= 修复后 ================= -->
  <g>
    <rect x="404" y="26" width="352" height="26" rx="3" fill="#0f766e" opacity="0.30"/>
    <rect x="404" y="26" width="352" height="26" rx="3" fill="none" stroke="#0f766e" stroke-opacity="0.55"/>
    <text class="lbl" x="411" y="42">main.runWorkload</text>
    <text class="sub" x="411" y="50">13.15s · 占 profile 96.7%</text>

    <rect x="418" y="58" width="321" height="26" rx="3" fill="#0f766e" opacity="0.26"/>
    <rect x="418" y="58" width="321" height="26" rx="3" fill="none" stroke="#0f766e" stroke-opacity="0.5"/>
    <text class="lbl" x="425" y="74">main.scanCorpus</text>
    <text class="sub" x="425" y="82">11.99s · 88.2%</text>

    <rect x="432" y="90" width="312" height="26" rx="3" fill="#0f766e" opacity="0.22"/>
    <rect x="432" y="90" width="312" height="26" rx="3" fill="none" stroke="#0f766e" stroke-opacity="0.45"/>
    <text class="lbl" x="439" y="106">strings.Count</text>
    <text class="sub" x="439" y="114">11.66s · 85.7%</text>

    <rect x="446" y="122" width="127" height="26" rx="3" fill="#0f766e" opacity="0.20"/>
    <rect x="446" y="122" width="127" height="26" rx="3" fill="none" stroke="#0f766e" stroke-opacity="0.45"/>
    <text class="lbl" x="453" y="138">indexbytebody</text>
    <text class="sub" x="453" y="146">4.73s · 34.8% — 手写汇编</text>

    <rect x="404" y="158" width="6" height="26" rx="3" fill="#0f766e" opacity="0.75"/>
    <text class="tiny" x="414" y="174">main.buildReportV2 — 0.08s · 0.6%</text>

    <rect x="404" y="190" width="6" height="26" rx="3" fill="#0f766e" opacity="0.75"/>
    <text class="tiny" x="414" y="206">runtime.gcBgMarkWorker — 0.20s · 1.5%（原为 24.28s）</text>

    <text class="sub" x="404" y="234">分配路径已经从 profile 顶部消失了。剩下的</text>
    <text class="sub" x="404" y="246">是对语料的扫描，而它现在跑在标准库的</text>
    <text class="sub" x="404" y="258">SIMD 查找里面。</text>
  </g>

  <line x1="392" y1="20" x2="392" y2="300" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="3 3"/>
  <text class="sub" x="6" y="322">条宽 ∝ 该 profile 总样本占比 · 取自真实 cpu.prof，go tool pprof</text>
</svg>
</p>
<figcaption>一张火焰图式的调用栈，左右两侧分别来自上面那份真实 CPU profile 的修复前后。「修复前」那个窗口墙上时间只有 15 秒，采到的 CPU 却是 54.34 秒：进程的时间花在拷贝字符串和跑垃圾回收上，而不是扫日志。修复后同一个 15 秒窗口是 13.60 秒样本，其中 97% 在请求处理里，GC worker 从 24.28 秒降到 0.20 秒——同时还多服务了 66 倍的请求。</figcaption>
</figure>

修复本身，一如既往，在 profile 指到那一行之后就显得很小。

## 这个程序：一个故意的热点，一条故意的分配路径

我写了一个带两个蓄意缺陷的服务，好让 profile 有真东西可找。它持有一份 20,000 行合成日志语料，通过同一个 `net/http/pprof` handler 暴露一个工作负载端点，用 `IMPL=v1` 跑原始代码，`IMPL=v2` 跑修复版代码。

第一个缺陷是一个手写的子串计数器——我在真实代码里写过这种东西，你也是：

```go
func countTokenNaive(line, token string) int {
	if token == "" || len(line) < len(token) {
		return 0
	}
	n := 0
	limit := len(line) - len(token)
	for i := 0; i <= limit; i++ {   // 2.78s
		j := 0
		for ; j < len(token); j++ { // 18.86s
			if line[i+j] != token[j] { // 42.42s  <-- 整个 profile
				break
			}
		}
		if j == len(token) {
			n++
		}
	}
	return n
}
```

第二个是报表构造。行放进 `[]map[string]any`，格式化走 `fmt.Sprintf`，输出字符串在循环里用 `+=` 增长：

```go
func buildReportV1(passes int) string {
	rows := make([]map[string]any, 0, len(corpus))
	for _, line := range corpus {
		rows = append(rows, map[string]any{
			"svc":  extractField(line, "service="),
			"lvl":  extractField(line, "level="),
			"hits": countTokenNaive(line, token),
			"raw":  line,
		})
	}
	out := ""
	for p := 0; p < passes; p++ {
		out = ""
		for _, r := range rows {
			out += fmt.Sprintf("%s\t%s\thits=%d\tbytes=%d\n",   // 第 150 行
				r["svc"], r["lvl"], r["hits"], len(r["raw"].(string)))
		}
	}
	return out
}
```

Go 里的 `out += s` 不是追加：它会按新长度分配一个新字符串，然后把旧内容的每一个字节拷贝过去，每一次迭代都是。对一个 20,000 行的报表来说，这就是对行数的平方级复杂度，而它在源码里完全看不出来。

## Profile 说它慢在哪，以及我怎么修

`go test -benchmem` 是我的起点，因为它给出精确的单次操作数字，没有采样噪声：

```text
$ go test -run XXX -bench . -benchmem -benchtime=10x
BenchmarkCountTokenV1-8   	      10	   3943165 ns/op	       0 B/op	       0 allocs/op
BenchmarkCountTokenV2-8   	      10	   1351353 ns/op	       0 B/op	       0 allocs/op
BenchmarkReportV1-8       	      10	2547645088 ns/op	5633174053 B/op	  142390 allocs/op
BenchmarkReportV2-8       	      10	   8320106 ns/op	4323385 B/op	    4923 allocs/op
PASS
ok  	profiling-demo	28.018s
```

再看一眼倒数第二行：**5.6 GB 和 142,390 次分配，只为了产出一份 555 KB 的报表。** 我还写了一个测试逐字节断言 `buildReportV1(2) == buildReportV2(2)`，这是让对比站得住脚的前提——输出相同，唯一变的是开销。

堆 profile 不用我开口就点出了那一行：

```text
$ go tool pprof -top -alloc_space heap_v1.prof
Showing nodes accounting for 285.71GB, 100% of 285.77GB total
      flat  flat%   sum%        cum   cum%
  285.71GB   100%   100%   285.76GB   100%  main.buildReportV1
         0     0%   100%    62.78GB 21.97%  main.main.func1
         0     0%   100%   222.98GB 78.03%  main.pipeline

$ go tool pprof -list buildReportV1 -alloc_space heap_v1.prof
    57.70GB    57.71GB (flat, cum)   100% of Total
  1.72MB       1.72MB    137:	rows := make([]map[string]any, 0, len(corpus))
   70.50MB     70.50MB   139:		rows = append(rows, map[string]any{
   57.62GB     57.63GB   150:			out += fmt.Sprintf("%s\t%s\thits=%d\tbytes=%d\n",
```

又是第 150 行：57.62 GB，占 57.70 GB 总量。换成同一个 profile 的 `inuse_space` 视角：

```text
$ go tool pprof -top -inuse_space heap_v1.prof
Showing nodes accounting for 41637.70kB, 100% of 41637.70kB total
       flat  flat%   sum%        cum   cum%
 34570.14kB 83.03% 83.03% 34570.14kB 83.03%  main.buildReportV1
  2560.27kB  6.15% 89.17%  2560.27kB  6.15%  fmt.Sprintf
   688.56kB  1.65% 94.52%  3248.82kB  7.80%  main.buildCorpus
```

分配了 285 GB，此刻活着 34 MB。这个比例是「流失」而不是「泄漏」的典型特征：GC 压力和延迟，而不是一颗内存炸弹。下面是同一个文件上 `alloc_objects` 与 `inuse_objects` 的对比，用对象数讲同一个故事：

```text
$ go tool pprof -top -sample_index=alloc_objects heap_v1.prof
       flat  flat%   sum%        cum   cum%
    5952341 81.70% 81.70%    7129556 97.86%  main.buildReportV1

$ go tool pprof -top -sample_index=inuse_objects heap_v1.prof
       flat  flat%   sum%        cum   cum%
     109375 81.37% 81.37%     109375 81.37%  main.buildReportV1
```

分配了 595 万个对象，存活 109,375 个。而这些 profile 还表明真正的代价根本不在 `buildReport` 本身——而在那一大堆垃圾对 CPU 做了什么：

```text
$ go tool pprof -top cpu_http_v1.prof
Duration: 15s, Total samples = 54.34s (362.20%)
Showing top 18 nodes out of 79
      flat  flat%   sum%        cum   cum%
    16.19s 29.79% 29.79%     16.19s 29.79%  runtime.memmove
    11.68s 21.49% 51.29%     25.03s 46.06%  runtime.scanObjectsSmall
     9.99s 18.38% 69.67%     13.15s 24.20%  runtime.tryDeferToSpanScan
     ...
     0.42s  0.77% 88.57%     25.65s 47.20%  runtime.scanSpan

$ go tool pprof -top -cum cpu_http_v1.prof | grep gcBgMarkWorker
         0     0% 22.41%     24.28s 44.68%  runtime.gcBgMarkWorker
```

54.34 秒里有 24.28 秒——总 CPU 的 44.68%——是 `gcBgMarkWorker`，一个只为了找出你的垃圾而存在的线程。而我本来会猜是问题所在的 `main.countTokenNaive`，只有 0.91 秒、1.69%。CPU profile 彻底改变了我的方向。

goroutine 转储从另一个角度确认了同一个故事，这也是服务「卡住」而不是「慢」时我最先看的 profile：

```text
$ curl -s 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2'

goroutine 1 [IO wait]:
	net.(*TCPListener).Accept(...)
	net/http.(*Server).Serve(...)
	main.main()
		/tmp/opencode/work/go-pprof/main.go:311 +0x270

goroutine 50 [runnable]:
main.buildReportV1(0x1)
	/tmp/opencode/work/go-pprof/main.go:151 +0x56a
main.pipeline(0x288779dd9180)
	/tmp/opencode/work/go-pprof/main.go:328 +0xde
created by main.main in goroutine 1

goroutine 44 [runnable]:
main.buildReportV1(0x2)
	/tmp/opencode/work/go-pprof/main.go:151 +0x56a
main.runWorkload(0x288779df68b7?, 0x2, 0x1)
main.main.func1(...)
```

每一个应用 goroutine 都停在 `main.go:151`，而且它们全是 `[runnable]`——想要 CPU 却拿不到，这恰恰是 `-top` 花了三条命令才告诉我的事。所以：`+=` 换成 `strings.Builder` 并且一开始就 `Grow` 够容量，`fmt.Sprintf` 换成往 builder 里写 `strconv.Itoa`，`[]map[string]any` 换成 `[]reportRow` 结构体切片，手写查找换成 `strings.Count`：

```go
type reportRow struct {
	svc, lvl string
	hits, n  int
}

func buildReportV2(passes int) string {
	rows := make([]reportRow, len(corpus)) // 结构体切片，不装箱、不用字符串 key
	for i, line := range corpus {
		rows[i] = reportRow{svc: extractField(line, "service="), lvl: extractField(line, "level="),
			hits: strings.Count(line, token), n: len(line)}
	}
	var b strings.Builder
	b.Grow(len(corpus) * 40) // 一次分配，而不是 20 万次
	for p := 0; p < passes; p++ {
		b.Reset() // 复用缓冲区
		for _, r := range rows {
			b.WriteString(r.svc)
			b.WriteByte('\t')
			b.WriteString(r.lvl)
			b.WriteByte('\t')
			b.WriteString("hits=")
			b.WriteString(strconv.Itoa(r.hits))
			b.WriteByte('\t')
			b.WriteString("bytes=")
			b.WriteString(strconv.Itoa(r.n))
			b.WriteByte('\n')
		}
	}
	return b.String()
}
```

然后是同样负载下修复之后的 profile：

```text
$ go tool pprof -top cpu_http_v2.prof
Duration: 15s, Total samples = 13.60s (90.66%)
Showing top 14 nodes out of 40
      flat  flat%   sum%        cum   cum%
     4.73s 34.78% 34.78%      4.73s 34.78%  indexbytebody
     4.11s 30.22% 65.00%     10.68s 78.53%  internal/stringslite.Index
     1.12s  8.24% 73.24%     11.66s 85.74%  strings.Count
     ...
     0.08s  0.59% 79.56%      1.20s  8.82%  main.buildReportV2

$ go tool pprof -top -alloc_space heap_v2.prof
Showing nodes accounting for 1692.93MB, 98.98% of 1710.30MB total
       flat  flat%   sum%        cum   cum%
  1016.63MB 59.44% 59.44%  1016.63MB 59.44%  strings.(*Builder).WriteString (inline)
```

还有 `runtime/metrics`，直接从运行中的进程读出来，这就是我在生产上不抓 profile 也能做这件事的方式：

```text
# v1，同一个 25 秒负载窗口
$ /gc/heap/allocs:bytes              = 3337384300960
  /gc/cycles/total:gc-cycles         = 129583
  /memory/classes/heap/objects:bytes = 46895440
  /sched/goroutines:goroutines       = 19

# v2，同一个窗口，多服务 66 倍请求
$ /gc/heap/allocs:bytes              = 2350214608
  /gc/cycles/total:gc-cycles         = 231
  /memory/classes/heap/objects:bytes = 11171648
```

核心数字，全部实测：

| | v1 | v2 | 变化 |
|---|---|---|---|
| 报表构造 | 2,547,645,088 ns | 8,320,106 ns | **快 306 倍** |
| 每份报表字节数 | 5,633,174,053 B | 4,323,385 B | **少 1303 倍** |
| 每份报表分配次数 | 142,390 | 4,923 | **少 29 倍** |
| token 计数 | 3,943,165 ns | 1,351,353 ns | **快 2.9 倍** |
| 25 秒内请求数 | 5 | 328 | **吞吐 66 倍** |
| 15 秒 CPU 样本 | 54.34 s | 13.60 s | — |
| `gcBgMarkWorker` | 24.28 s | 0.20 s | **少 121 倍** |

这张表里有两件事比倍数更值钱。第一，这个修复一点不巧妙：就是一个标准库调用、一个结构体替掉 map、一块预先分配好的缓冲区。巧妙很少是 profile 要求的东西。第二，`strings.Count` 并没有让热点消失——它把热点搬进了 `indexbytebody`，一段我没写、也不用维护的手写汇编。这才是 pprof 里一个好结局该有的样子：你自己的代码从关键路径上让开了。

## 我现在实际是怎么做的

每次服务变慢我都按这个顺序：打开 `net/http/pprof`；在*慢的事情正在发生的时候*抓一份 15–30 秒的 CPU profile，而不是之前；跑 `-top`，并且先读 `cum%` 再读 `flat%`，用 cum 找到负责的调用链；对热点函数 `-list` 拿到那一行；然后才打开编辑器。如果 `-top` 被 `runtime.*` 占满，那就是内存的故事，拉一份堆 profile，然后按你关心的是流失还是留存来决定用 `alloc_space` 还是 `inuse_space`。如果没什么东西慢、但有什么东西卡住了，那先看的一定是 `-goroutine?debug=2`。我把 `go test -benchmem` 留在 CI 里，这样 `B/op` 的变化会在一份 diff 里出现，而不是出现在凌晨三点的告警里。

猜更省事。其实不然：我花在「推理」出来的热点上的下午，比跑任何一个 profile 的代价都多。至于 pprof 看不见的那些并发 bug——藏在 goroutine 交接和未加锁 map 里的那些——我在 [Go race detector](/zh/posts/go-concurrency-race-detector/) 那篇里接着往下讲；而这所有东西的前身，见[用 Go 写网络工具](/zh/posts/go-for-network-tools/)。
