---
title: "Go Testing in Practice: Table Tests, Benchmarks, and Fuzzing"
description: "A practical tour of Go's testing package: table-driven tests with subtests, benchmarks with -benchmem, coverage, go vet, and fuzzing with go test -fuzz — all with real output."
pubDate: 2027-02-06
lang: en
translationKey: go-testing-and-fuzzing
tags: [devops]
featured: false
keywords:
  - Go testing
  - table-driven tests
  - go test -fuzz
  - Go benchmark
  - subtests
---

Go's built-in `testing` package is deliberately small, but it covers almost everything you need: table-driven tests, subtests, benchmarks, coverage, and fuzzing. In this post I'll walk through each feature with real code and real `go test` output — no fabricated terminal transcripts.

We'll use a small `parser.go` package that parses host:port strings, and build tests around it. If you haven't read my post on the [Go race detector](/posts/go-concurrency-race-detector/) or [Go network tools](/posts/go-for-network-tools/), those cover different ground; this one is purely about the testing toolkit.

## Table-Driven Tests: The Idiomatic Pattern

The most common Go test pattern is the **table-driven test**: define a slice of test cases, loop over them, and run each as a subtest with `t.Run`. Here's what that looks like for a `ParsePort` function:

```go
func TestParsePort(t *testing.T) {
    cases := []struct {
        name    string
        input   string
        want    int
        wantErr bool
    }{
        {name: "valid port", input: "8080", want: 8080},
        {name: "zero port", input: "0", want: 0},
        {name: "max port", input: "65535", want: 65535},
        {name: "empty string", input: "", wantErr: true},
        {name: "negative", input: "-1", wantErr: true},
        {name: "too large", input: "65536", wantErr: true},
        {name: "not a number", input: "http", wantErr: true},
        {name: "with spaces", input: " 8080", wantErr: true},
    }

    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            got, err := ParsePort(tc.input)
            if tc.wantErr {
                if err == nil {
                    t.Errorf("ParsePort(%q) expected error, got %d", tc.input, got)
                }
                return
            }
            if err != nil {
                t.Errorf("ParsePort(%q) unexpected error: %v", tc.input, err)
                return
            }
            if got != tc.want {
                t.Errorf("ParsePort(%q) = %d, want %d", tc.input, got, tc.want)
            }
        })
    }
}
```

Why this pattern? Three reasons:

1. **Adding a case is one line** — no copy-paste of test boilerplate.
2. **Each case runs as a named subtest** — you see exactly which one fails.
3. **The failure message includes the input** — no guessing which case broke.

Run it with `go test -v` and you get a clear tree of subtests:

```
=== RUN   TestParsePort
=== RUN   TestParsePort/valid_port
=== RUN   TestParsePort/zero_port
=== RUN   TestParsePort/max_port
=== RUN   TestParsePort/empty_string
=== RUN   TestParsePort/negative
=== RUN   TestParsePort/too_large
=== RUN   TestParsePort/not_a_number
=== RUN   TestParsePort/with_spaces
--- PASS: TestParsePort (0.00s)
    --- PASS: TestParsePort/valid_port (0.00s)
    --- PASS: TestParsePort/zero_port (0.00s)
    --- PASS: TestParsePort/max_port (0.00s)
    --- PASS: TestParsePort/empty_string (0.00s)
    --- PASS: TestParsePort/negative (0.00s)
    --- PASS: TestParsePort/too_large (0.00s)
    --- PASS: TestParsePort/not_a_number (0.00s)
    --- PASS: TestParsePort/with_spaces (0.00s)
PASS
ok  	example.com/gotest	0.003s
```

Every subtest is listed with its PASS status. If one fails, you see the exact name and the `t.Errorf` message.

## Filtering with `-run`

When you're iterating on a single test, `-run` filters by name. The argument is a regular expression matched against the test name (and subtest name, separated by `/`):

```
$ go test -v -run='TestParsePort$/valid_port'
=== RUN   TestParsePort
=== RUN   TestParsePort/valid_port
--- PASS: TestParsePort (0.00s)
    --- PASS: TestParsePort/valid_port (0.00s)
PASS
ok  	example.com/gotest	0.003s
```

Only the `valid_port` subtest ran. This is invaluable in a large suite — you can zero in on the one test you're debugging without waiting for the rest.

## `t.Helper()` and `t.Cleanup()`

**`t.Helper()`** marks a function as a test helper, so when it calls `t.Errorf`, the file:line reported is the *caller's* location, not the helper's. Use it for assertion functions shared across tests:

```go
func assertEqual(t *testing.T, got, want int, label string) {
    t.Helper()
    if got != want {
        t.Errorf("%s = %d, want %d", label, got, want)
    }
}
```

**`t.Cleanup()`** registers a function to run after the test (and its subtests) complete — even if the test fails or calls `t.Fatal`. It's the right place to close files, remove temp dirs, or shut down test servers:

```go
func TestWithCleanup(t *testing.T) {
    dir := t.TempDir()
    logFile := filepath.Join(dir, "test.log")

    f, err := os.Create(logFile)
    if err != nil {
        t.Fatalf("create: %v", err)
    }
    t.Cleanup(func() {
        f.Close()
        os.Remove(logFile)
    })

    fmt.Fprintln(f, "test output")
    if _, err := os.Stat(logFile); err != nil {
        t.Errorf("log file should exist: %v", err)
    }
}
```

`t.TempDir()` already registers its own cleanup, so you rarely need to remove the directory itself — but `t.Cleanup` is still useful for files you create inside it.

## Benchmarks: `b.N` and `-benchmem`

Benchmarks measure performance. The function signature is `func BenchmarkX(b *testing.B)`, and the body runs in a loop controlled by `b.N` — the benchmark framework adjusts `N` to get a stable measurement:

```go
func BenchmarkParsePort(b *testing.B) {
    for i := 0; i < b.N; i++ {
        ParsePort("8080")
    }
}

func BenchmarkJoinHostPort(b *testing.B) {
    for i := 0; i < b.N; i++ {
        JoinHostPort("example.com", 443)
    }
}
```

Run with `-bench=.` to match all benchmarks, and `-benchmem` to see allocation counts:

```
$ go test -bench=. -benchmem -run='^$'
goos: linux
goarch: amd64
pkg: example.com/gotest
cpu: Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
BenchmarkParsePort-8       	81427113	        14.68 ns/op	       0 B/op	       0 allocs/op
BenchmarkParseHostPort-8   	46471100	        25.39 ns/op	       0 B/op	       0 allocs/op
BenchmarkJoinHostPort-8    	 3785822	       270.5 ns/op	      40 B/op	       3 allocs/op
PASS
ok  	example.com/gotest	4.684s
```

How to read this:

- **ns/op** — nanoseconds per operation. Lower is faster. `ParsePort` at 14.68 ns is ~18x faster than `JoinHostPort` at 270.5 ns.
- **B/op** — bytes allocated per operation. `JoinHostPort` allocates 40 bytes per call because `fmt.Sprintf` creates a new string.
- **allocs/op** — number of heap allocations per operation. Zero allocs means no GC pressure.

The `-8` suffix is the CPU count (`GOMAXPROCS`). Benchmarks are the right tool when you suspect a hotspot — not for micro-optimizing every function, but for catching regressions in hot paths.

## Coverage: `-cover` and `-coverprofile`

`go test -cover` adds a coverage percentage to the output:

```
$ go test -cover -run='TestParsePort$|TestParseHostPort$|TestJoinHostPort$|TestWithHelper$|TestWithCleanup$'
PASS
coverage: 93.9% of statements
ok  	example.com/gotest	0.005s
```

93.9% of statements were exercised by the tests. For a detailed breakdown, use `-coverprofile` to write a coverage file, then `go tool cover -html=cover.out` to see exactly which lines are covered:

```
$ go test -coverprofile=cover.out
$ go tool cover -html=cover.out -o cover.html
```

**100% coverage is not the goal.** The last few percent often require testing impossible conditions (e.g., a disk-full error) or trivial getters. Aiming for 100% leads to brittle tests that break on every refactor. A solid 80–95% on business logic, plus fuzzing on parsers, is a better use of time.

## `go vet` and `-race`

`go vet` runs static analysis checks on your code — it catches things like unreachable code, incorrect `Printf` format strings, and lock-copy bugs:

```
$ go vet ./...
```

Clean output means no issues. It's fast, so run it in CI on every push.

The `-race` flag enables Go's race detector, which instruments memory accesses to find data races at runtime. It's a different tool from the testing patterns above — see my dedicated post on the [Go race detector](/posts/go-concurrency-race-detector/) for a deep dive.

## Fuzzing: `go test -fuzz`

Fuzzing automatically generates random inputs to find panics, infinite loops, or invariant violations. Go's built-in fuzzing uses **coverage-guided** generation: it mutates inputs and keeps the ones that explore new code paths.

A fuzz test looks like a regular test but takes `*testing.F` instead of `*testing.T`:

```go
func FuzzParsePort(f *testing.F) {
    f.Add("8080")   // seed corpus
    f.Add("0")
    f.Add("")

    f.Fuzz(func(t *testing.T, s string) {
        port, err := ParsePort(s)
        if err != nil {
            return
        }
        if port < 0 || port > 65535 {
            t.Errorf("ParsePort(%q) = %d, out of valid range", s, port)
        }
        if fmt.Sprintf("%d", port) != s {
            t.Errorf("ParsePort(%q) = %d, round-trip mismatch", s, port)
        }
    })
}
```

Run it with `-fuzz` and a time limit:

```
$ go test -fuzz=FuzzParsePort -fuzztime=5s -run='TestParsePort$|TestParseHostPort$|TestJoinHostPort$|TestWithHelper$|TestWithCleanup$'
fuzz: elapsed: 0s, gathering baseline coverage: 0/6 completed
fuzz: elapsed: 0s, gathering baseline coverage: 6/6 completed, now fuzzing with 8 workers
fuzz: elapsed: 0s, execs: 119 (1666/sec), new interesting: 2 (total: 8)
--- FAIL: FuzzParsePort (0.07s)
    --- FAIL: FuzzParsePort (0.00s)
        parser_test.go:207: ParsePort("0000") = 0, round-trip mismatch

    Failing input written to testdata/fuzz/FuzzParsePort/81476e3145e0ed8c
    To re-run:
    go test -run=FuzzParsePort/81476e3145e0ed8c
FAIL
exit status 1
FAIL	example.com/gotest	0.077s
```

The fuzzer found a real bug in 0.07 seconds: the input `"0000"` parses to port `0`, but formatting `0` back gives `"0"`, not `"0000"` — a round-trip mismatch. The failing input was saved to `testdata/fuzz/FuzzParsePort/81476e3145e0ed8c` so it becomes a permanent regression test.

I also fuzzed `ParseHostPort` and it found another issue — the input `":00"` returns an empty host, which violates the invariant that a parsed address should have a non-empty host. The fuzzer wrote that input to `testdata/fuzz/FuzzParseHostPort/8a9033931222b4e3`.

```
$ go test -fuzz=FuzzParseHostPort -fuzztime=5s -run='TestParsePort$|TestParseHostPort$|TestJoinHostPort$|TestWithHelper$|TestWithCleanup$'
fuzz: elapsed: 0s, gathering baseline coverage: 0/5 completed
fuzz: elapsed: 0s, gathering baseline coverage: 5/5 completed, now fuzzing with 8 workers
fuzz: elapsed: 0s, execs: 261 (7515/sec), new interesting: 2 (total: 7)
--- FAIL: FuzzParseHostPort (0.04s)
    --- FAIL: FuzzParseHostPort (0.00s)
        parser_test.go:230: ParseHostPort(":00") returned empty host

    Failing input written to testdata/fuzz/FuzzParseHostPort/8a9033931222b4e3
    To re-run:
    go test -run=FuzzParseHostPort/8a9033931222b4e3
FAIL
exit status 1
FAIL	example.com/gotest	0.039s
```

Both bugs are real issues that table-driven tests missed because I never thought to write a case for `"0000"` or `":00"`. That's the value of fuzzing: it explores the input space far more thoroughly than a human writing test cases.

## A Practical Workflow

After writing Go code for a few years, here's the testing workflow I've settled on:

1. **Table-driven tests for business logic** — every branch, every error path. These are the backbone of your test suite.
2. **Fuzzing for parsers and decoders** — anything that takes untrusted input (URLs, config files, wire formats). The fuzzer will find edge cases you didn't think of.
3. **Benchmarks when you suspect a hotspot** — don't benchmark everything, but if a function is called in a tight loop, measure it. The `-benchmem` flag tells you if you're allocating unnecessarily.
4. **`go vet` in CI** — catch static analysis issues before they merge.
5. **`-race` in CI for concurrent code** — the race detector is expensive but catches bugs that are nearly impossible to reproduce manually.
6. **Coverage as a guide, not a target** — use `-cover` to find untested branches, but don't chase 100%.

Go's testing package is small, but combined with fuzzing and the race detector it covers most of what you need. The key is to write tests that actually catch bugs — table tests for the cases you can think of, fuzzing for the ones you can't.

---

*All code and output in this post are from a real Go module tested with `go test`, `go vet`, and `go test -fuzz` on Go 1.27.2. The two bugs found by fuzzing are real and were left in the code intentionally to demonstrate the fuzzer's value.*
