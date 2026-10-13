---
title: "Go pprof: a real Go profiling run, from cpuprofile to heap profile"
description: "A hands-on Go profiling walkthrough with real pprof output: import net/http/pprof, capture a cpuprofile and a memory profile, read -top and -list, and tell alloc_space from inuse_space — then fix a 5.6 GB-per-request allocation hotspot using only the profiles."
pubDate: 2027-01-22
lang: en
translationKey: go-pprof-profiling
tags: [devops]
featured: false
keywords:
  - Go pprof
  - Go profiling
  - cpuprofile
  - memory profile
  - heap profile
---

For years I "optimized" Go code by reading it, spotting something that looked slow, and rewriting it. It worked about as well as you would expect. **Go pprof** is what replaced that habit, and the reason this post exists is that last month a "slow" endpoint in a log-analysis service turned out to be spending nearly half its CPU inside the garbage collector. I would never have found that by reading the source, because the source looked fine. **Go profiling** with pprof is the difference between an opinion and a measurement, so everything below is a real profile from a real program I wrote for this article — an actual **cpuprofile**, an actual **memory profile**, a goroutine dump, and the before/after numbers of the fix that the profile pointed at. Nothing here is illustrative. If a number appears, I ran the command.

## What Go pprof is, and how to get a profile

pprof is three things wearing one name: a profile *format* (protobuf), a sampling profiler, and an HTTP debug endpoint. The profiler works by stopping the program ~100 times a second on a timer, walking each thread's stack, and counting which functions are there. It is statistical, which means it adds almost nothing to the runtime, which means you can leave it on in production — and you should, because a profile from the actual slow request is worth more than any local benchmark.

For a long-running service, the whole thing is one blank import:

```go
package main

import (
	"log"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/* on http.DefaultServeMux
)

func main() {
	log.Fatal(http.ListenAndServe("127.0.0.1:6060", nil))
}
```

Because that's the default mux, everything below works immediately — the index, the CPU profiler, the heap profiler, the goroutine dump, and more:

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
# save a 15-second CPU profile to disk
$ curl -so cpu.prof 'http://127.0.0.1:6060/debug/pprof/profile?seconds=15'

# heap profile (default view is -inuse_space)
$ curl -so heap.prof 'http://127.0.0.1:6060/debug/pprof/heap'

# every goroutine's stack, as text, right now
$ curl -s 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2' > goroutines.txt

# then read any of them
$ go tool pprof -top cpu.prof
```

That blank import is not free of risk: it is the debug endpoint of your whole process, and it has no authentication of its own. Bind it to loopback, or a separate listener, and never expose it on the public internet. For batch jobs, tests, and benchmarks, `runtime/pprof` writes the same format to a file, which is how you profile code that has no HTTP surface:

```go
// in a test or benchmark
f, _ := os.Create("cpu.prof")
pprof.StartCPUProfile(f)
defer pprof.StopCPUProfile()
```

## The profile types, and what each one answers

Six profiles cover almost everything I need:

- **CPU** (`/profile`): where the program is burning wall-clock time. Sampled by the runtime timer. This is the one you reach for first.
- **Heap** (`/heap`): allocations and live objects. Reported in four flavours — see the next section.
- **Goroutine** (`/goroutine`): the current stacks of every goroutine, plus counts. The fastest way to find a goroutine leak.
- **Block** (`/block`, type `delay`): time goroutines spend blocked on channel ops, `time.Sleep`, and select. Off by default — call `runtime.SetBlockProfileRate(1)` first.
- **Mutex** (`/mutex`, also type `delay`): time spent waiting to acquire a `sync.Mutex`. Also off by default — `runtime.SetMutexProfileFraction(1)`.
- **Threadcreate** (`/threadcreate`): who spawns OS threads; occasionally useful when `GOMAXPROCS` and thread counts are fine but the process spawns thousands of threads.

An empty profile is a result, not a failure. The first time I brought this service up, the mutex endpoint gave me `Showing nodes accounting for 0, 0% of 0 total` — which correctly told me there was no lock contention to hunt. I built a tiny second program with a contended channel and a contended mutex to see what the real output looks like:

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

Note the units: on a CPU profile `3.81s` is CPU time; on block and mutex profiles it is *time spent waiting*. The two are not interchangeable.

## Reading a profile: -top, -list, and the flame graph

Three commands do all the work. `-top` sorts functions by cost and shows the percentage column. `flat` is time in the function itself; `cum` is time in that function *and everything it called*. A function with high `cum` and low `flat` is a middle manager — it is not slow, it is calling something slow. `-list <fn>` reprints the function's source with the samples attributed per line, which is how you find the specific line to change. And `go tool pprof -http=:8080 cpu.prof` serves the interactive UI, whose Flame Graph tab is where I look when the call structure is deep: width is cost, height is depth, and the thing that looks like a wide brick wall is your problem.

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

97.21% flat. Then line-level:

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

Line 104 — a single byte comparison — owns 42 seconds of a 66-second profile. That is the whole value of pprof in one screen: I did not have to guess which part of the loop was expensive, and my guess would have been the outer loop.

## alloc_space vs inuse_space: why you need both heap profile views

The heap profile is the one people misread, because `/debug/pprof/heap` has four sample indices and `pprof` displays two pairs:

- **alloc_space** / **alloc_objects** — *cumulative*, since the process started. Every byte ever allocated, whether or not it was freed. This is a churn rate: it answers "who is making the garbage collector work?"
- **inuse_space** / **inuse_objects** — what is *live right now*, at the moment the profile was taken. This answers "what is actually using my memory?" and it is where a leak shows up.

These two answers are different questions, and a profile that looks alarming on one can look healthy on the other. High `alloc_space` with low `inuse_space` means you are allocating and immediately discarding — you have GC pressure and latency, not a leak. High `inuse_space` from the same line means something is *retaining* it, and that is the bug you want.

<figure>
<p align="center">
<svg viewBox="0 0 780 336" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flame-graph-style call stacks, before and after. Before: main.buildReportV1, runtime.concatstrings, runtime.concatstring2, runtime.memmove, plus runtime.gcBgMarkWorker. After: main.runWorkload, main.scanCorpus, strings.Count, indexbytebody, with main.buildReportV2 and runtime.gcBgMarkWorker almost empty.">
  <style>
    .lbl { font: 500 10px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .sub { font: 400 9.5px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .62; }
    .hd  { font: 600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .tiny{ font: 400 9px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .7; }
  </style>
  <text class="hd" x="6" y="14">BEFORE — v1 · 15 s window, 54.34 s samples (362% CPU)</text>
  <text class="hd" x="404" y="14">AFTER — v2 · same window, 13.60 s samples (91% CPU)</text>

  <!-- ================= BEFORE ================= -->
  <g>
    <rect x="6" y="26" width="169" height="26" rx="3" fill="#0f766e" opacity="0.9"/>
    <text class="lbl" x="13" y="42">main.buildReportV1</text>
    <text class="sub" x="13" y="50">25.19s · 46.4% of profile</text>

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
    <text class="sub" x="13" y="182">24.28s · 44.7% — the GC, not the code</text>

    <text class="sub" x="6" y="206">the same 15-second window also burned 16.19 s in memmove,</text>
    <text class="sub" x="6" y="218">2.73 s in runtime.sweepone, and only 0.91 s in main</text>
    <text class="sub" x="6" y="230">code. the allocation was the hotspot.</text>
  </g>

  <!-- ================= AFTER ================= -->
  <g>
    <rect x="404" y="26" width="352" height="26" rx="3" fill="#0f766e" opacity="0.30"/>
    <rect x="404" y="26" width="352" height="26" rx="3" fill="none" stroke="#0f766e" stroke-opacity="0.55"/>
    <text class="lbl" x="411" y="42">main.runWorkload</text>
    <text class="sub" x="411" y="50">13.15s · 96.7% of profile</text>

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
    <text class="sub" x="453" y="146">4.73s · 34.8% — hand-written asm</text>

    <rect x="404" y="158" width="6" height="26" rx="3" fill="#0f766e" opacity="0.75"/>
    <text class="tiny" x="414" y="174">main.buildReportV2 — 0.08s · 0.6%</text>

    <rect x="404" y="190" width="6" height="26" rx="3" fill="#0f766e" opacity="0.75"/>
    <text class="tiny" x="414" y="206">runtime.gcBgMarkWorker — 0.20s · 1.5% (was 24.28s)</text>

    <text class="sub" x="404" y="234">the allocation path is gone from the top of the</text>
    <text class="sub" x="404" y="246">profile. what is left is the corpus scan, and it is</text>
    <text class="sub" x="404" y="258">now inside the standard library's SIMD search.</text>
  </g>

  <line x1="392" y1="20" x2="392" y2="300" stroke="currentColor" stroke-opacity="0.15" stroke-dasharray="3 3"/>
  <text class="sub" x="6" y="322">bar width ∝ share of that profile's total samples · from the real cpu.prof, go tool pprof</text>
</svg>
</p>
<figcaption>A flame-graph-style call stack for both sides of the fix, drawn from the actual CPU profiles above. The "before" window is 15 s of wall clock but 54.34 s of sampled CPU: the process spent its time copying strings and running the garbage collector, not scanning logs. The same 15-second window after the fix is 13.60 s of samples, 97% of it inside request handling, with the GC worker down from 24.28 s to 0.20 s — while serving 66× more requests.</figcaption>
</figure>

The fix, as always, was small once the profile had named the line.

## The program: a hotspot and an allocation path on purpose

I wrote a service with two deliberate defects, so the profiles would have something real to find. It holds a synthetic corpus of 20,000 log lines and exposes a workload endpoint over the same `net/http/pprof` handler, driven by `IMPL=v1` for the naive code and `IMPL=v2` for the fixed code.

The first defect is a hand-rolled substring counter — the kind of thing I have written in real code and so have you:

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
			if line[i+j] != token[j] { // 42.42s  <-- the whole profile
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

The second is the report builder. Rows go into a `[]map[string]any`, formatting goes through `fmt.Sprintf`, and the output string is grown with `+=` inside the loop:

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
			out += fmt.Sprintf("%s\t%s\thits=%d\tbytes=%d\n",   // line 150
				r["svc"], r["lvl"], r["hits"], len(r["raw"].(string)))
		}
	}
	return out
}
```

`out += s` in Go is not append: it allocates a new string of the new length and copies every byte of the old contents across, every iteration. For a 20,000-row report that is quadratic in the number of rows, and it is invisible in the source.

## The profile, and the fix

`go test -benchmem` is where I start, because it gives exact per-operation numbers with no sampling noise:

```text
$ go test -run XXX -bench . -benchmem -benchtime=10x
BenchmarkCountTokenV1-8   	      10	   3943165 ns/op	       0 B/op	       0 allocs/op
BenchmarkCountTokenV2-8   	      10	   1351353 ns/op	       0 B/op	       0 allocs/op
BenchmarkReportV1-8       	      10	2547645088 ns/op	5633174053 B/op	  142390 allocs/op
BenchmarkReportV2-8       	      10	   8320106 ns/op	4323385 B/op	    4923 allocs/op
PASS
ok  	profiling-demo	28.018s
```

Read that bottom row again: **5.6 GB and 142,390 allocations to produce one 555 KB report.** A test that also asserts `buildReportV1(2) == buildReportV2(2)` byte-for-byte is what makes the comparison honest — same output, so the only thing that changed is the cost.

The heap profile named the line without my help:

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

Line 150 again: 57.62 GB of a 57.70 GB total. Same profile, `inuse_space` view instead:

```text
$ go tool pprof -top -inuse_space heap_v1.prof
Showing nodes accounting for 41637.70kB, 100% of 41637.70kB total
       flat  flat%   sum%        cum   cum%
 34570.14kB 83.03% 83.03% 34570.14kB 83.03%  main.buildReportV1
  2560.27kB  6.15% 89.17%  2560.27kB  6.15%  fmt.Sprintf
   688.56kB  1.65% 94.52%  3248.82kB  7.80%  main.buildCorpus
```

34 MB live out of a process that allocated 285 GB. That ratio is the signature of churn, not a leak: GC pressure and latency rather than a memory bomb. And here is `alloc_objects` versus `inuse_objects` on the same file, which is the same story in counts:

```text
$ go tool pprof -top -sample_index=alloc_objects heap_v1.prof
       flat  flat%   sum%        cum   cum%
    5952341 81.70% 81.70%    7129556 97.86%  main.buildReportV1

$ go tool pprof -top -sample_index=inuse_objects heap_v1.prof
       flat  flat%   sum%        cum   cum%
     109375 81.37% 81.37%     109375 81.37%  main.buildReportV1
```

5.95 million objects allocated, 109,375 live. The profiles also showed the real cost was not in `buildReport` at all — it was what all that garbage did to the CPU:

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

24.28 s of the 54.34 s — 44.68% of total CPU — is `gcBgMarkWorker`, a thread that exists only to find your garbage. And `main.countTokenNaive`, the thing I would have guessed was the problem, is 0.91 s, 1.69%. The CPU profile redirected me completely.

The goroutine dump confirmed the same story from a different angle, and this is the profile I use most when a service is stuck rather than slow:

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

Every application goroutine is parked at `main.go:151`, and `[runnable]` on all of them means they want the CPU and cannot get it — exactly what `-top` took three commands to tell me. So: `+=` becomes `strings.Builder` with a `Grow` sized up front, `fmt.Sprintf` becomes `strconv.Itoa` into the builder, `[]map[string]any` becomes a `[]reportRow` struct slice, and the hand-rolled search becomes `strings.Count`:

```go
type reportRow struct {
	svc, lvl string
	hits, n  int
}

func buildReportV2(passes int) string {
	rows := make([]reportRow, len(corpus)) // struct slice, no boxing, no string keys
	for i, line := range corpus {
		rows[i] = reportRow{svc: extractField(line, "service="), lvl: extractField(line, "level="),
			hits: strings.Count(line, token), n: len(line)}
	}
	var b strings.Builder
	b.Grow(len(corpus) * 40) // one allocation, not 200,000
	for p := 0; p < passes; p++ {
		b.Reset() // reuse the buffer
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

And the profile after, on the identical load:

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

And `runtime/metrics`, straight off the running process, which is how I check this in production without fetching a profile at all:

```text
# v1, same 25-second load window
$ /gc/heap/allocs:bytes            = 3337384300960
  /gc/cycles/total:gc-cycles       = 129583
  /memory/classes/heap/objects:bytes = 46895440
  /sched/goroutines:goroutines     = 19

# v2, same window, 66x more requests served
$ /gc/heap/allocs:bytes            = 2350214608
  /gc/cycles/total:gc-cycles       = 231
  /memory/classes/heap/objects:bytes = 11171648
```

The headline numbers, all measured:

| | v1 | v2 | change |
|---|---|---|---|
| report build | 2,547,645,088 ns | 8,320,106 ns | **306× faster** |
| bytes per report | 5,633,174,053 B | 4,323,385 B | **1303× fewer** |
| allocs per report | 142,390 | 4,923 | **29× fewer** |
| token count | 3,943,165 ns | 1,351,353 ns | **2.9× faster** |
| requests in 25 s | 5 | 328 | **66× throughput** |
| CPU samples / 15 s | 54.34 s | 13.60 s | — |
| `gcBgMarkWorker` | 24.28 s | 0.20 s | **121× less** |

Two things in that table are worth more than the multipliers. First, the fix was not clever: it was a standard-library call, a struct instead of a map, and one preallocated buffer. Cleverness is rarely what a profile asks for. Second, `strings.Count` did not make the hotspot disappear — it moved it into `indexbytebody`, hand-optimized assembly I did not write and do not have to maintain. That is what a good outcome looks like in pprof: your own code gets out of the way.

## What I actually do now

The loop I follow, in order, every time a service is slow: turn on `net/http/pprof`; take a 15–30 s CPU profile *while the slow thing is happening*, not before; run `-top` and read `cum%` before `flat%` to find the owning call chain; `-list` the hot function to get the line; and only then open an editor. If `-top` is dominated by `runtime.*`, it is a memory story, so pull a heap profile and decide between `alloc_space` and `inuse_space` on whether you care about churn or retention. If nothing is slow but something is stuck, it is `-goroutine?debug=2` before anything else. I keep `go test -benchmem` in CI so that a change in `B/op` shows up in a diff instead of in a 3 a.m. page.

Guessing feels cheaper. It is not: I have spent more afternoons hunting a hotspot I had *reasoned* about than any profile has ever cost me to run. For the concurrency bugs pprof cannot see, my companion piece on the [Go race detector](/posts/go-concurrency-race-detector/) picks up here, and for the network-shaped predecessors of all this, see [writing network tools in Go](/posts/go-for-network-tools/).
