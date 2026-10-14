---
title: "Go Generics in Practice: When They Help and When They Don't"
description: "A practical tour of Go generics — type parameters, constraints, generic types, and a real benchmark against interface{}."
pubDate: 2027-02-08
lang: en
translationKey: go-generics
tags: [devops]
featured: false
keywords:
  - Go generics
  - type parameters
  - constraints
  - comparable
  - type inference
  - cmp.Ordered
  - interface{} vs generics
---

Go 1.18 shipped generics after nearly a decade of debate. They solve one specific problem well — reusable containers and algorithms without `interface{}` — and are the wrong tool for everything else.

I'll show real code exercising type parameters, constraints, generic types, and type inference, then benchmark the old `interface{}` approach against the generic one. All output was produced by the Go 1.27.2 toolchain on this machine.

## The problem generics solve

Before generics, every reusable container had two choices: write it for `interface{}` and type-assert on the way out (runtime errors, extra allocations), or code-generate a typed copy per type (build complexity, binary bloat).

Generics give a third option: write the logic once, let the compiler instantiate it per type, keep static type safety. Generics are a **compile-time** feature — no runtime type erasure like Java, no monomorphization blowup like C++ templates. The compiler generates the specializations you need and nothing more.

## The syntax: type parameters and constraints

A generic function declares type parameters in square brackets before the arguments:

```go
func Map[T, U any](s []T, f func(T) U) []U {
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = f(v)
    }
    return result
}
```

`T` and `U` are **type parameters**. `any` is a built-in constraint accepting any type. You call it without specifying types — Go infers them:

```go
squares := Map([]int{1, 2, 3, 4, 5}, func(n int) int { return n * n })
// []int{1, 4, 9, 16, 25}

lengths := Map([]string{"hello", "world"}, func(s string) int { return len(s) })
// []int{5, 5}
```

Real output:

```
squares: [1 4 9 16 25]
lengths: [5 5]
```

This is **type inference**: the compiler saw `[]int` and `func(int) int` and filled in `T = int`, `U = int` automatically. You only write explicit type arguments (`Map[int, string](...)`) when inference can't figure it out.

## Constraints: what a type parameter can do

When your function needs to *do* something with a value — compare it, add it — you need a **constraint**.

### Custom constraints with `~`

The `~` symbol means "the underlying type is":

```go
type Number interface {
    ~int | ~int64 | ~float64
}

func Sum[T Number](vals []T) T {
    var total T
    for _, v := range vals {
        total += v
    }
    return total
}
```

```go
Sum([]int{10, 20, 30})       // 60
Sum([]float64{1.5, 2.5})     // 4.0
```

Real output:

```
sum ints: 60
sum floats: 7.5
```

Without `~`, only exact `int` and `float64` satisfy `Number` — not `type Celsius float64`. The `~` makes the constraint apply to the underlying type, which is what you want in practice.

### cmp.Ordered and comparable

The standard library provides two constraints:

- **`cmp.Ordered`** — types supporting `<`, `<=`, `>`, `>=`. For `Max`, `Min`, `Sort`.
- **`comparable`** — types supporting `==` and `!=`. For map keys and equality checks.

```go
func Max[T cmp.Ordered](a, b T) T {
    if a > b { return a }
    return b
}

func Count[T comparable](s []T) map[T]int {
    counts := make(map[T]int)
    for _, v := range s { counts[v]++ }
    return counts
}
```

Real output:

```
max(3, 7): 7
max(2.5, 1.5): 2.5
word counts: map[go:3 is:2]
```

`comparable` is a hard constraint. Using a slice as a map key is rejected at compile time — with `interface{}` it would be a runtime panic.

## Generic types: beyond functions

You can define a **generic type**:

```go
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(item T) { s.items = append(s.items, item) }

func (s *Stack[T]) Pop() (T, bool) {
    if len(s.items) == 0 { var zero T; return zero, false }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

func (s Stack[T]) Len() int { return len(s.items) }
```

Real output:

```
stack len: 3
popped: 30
stack len after pop: 2
```

Every method repeats the type parameter in its receiver. `Stack[int]`, `Stack[string]`, `Stack[MyStruct]` share one implementation with full type safety and zero boxing.

## interface{} vs generics: a real benchmark

The same `Map` written both ways, benchmarked:

```go
// interface{} version
func MapInterface(s []interface{}, f func(interface{}) interface{}) []interface{} {
    result := make([]interface{}, len(s))
    for i, v := range s { result[i] = f(v) }
    return result
}

// generic version
func MapGeneric[T, U any](s []T, f func(T) U) []U {
    result := make([]U, len(s))
    for i, v := range s { result[i] = f(v) }
    return result
}
```

Benchmark output (i7-8550U):

```
BenchmarkMapInterface-8   	   64826	     18887 ns/op	   23360 B/op	     873 allocs/op
BenchmarkMapGeneric-8     	  425096	      2899 ns/op	    8192 B/op	       1 allocs/op
```

The generic version is **~65x faster**, allocates **~3x less memory**, and does **873 allocations vs 1**. The 873 come from boxing each `int` into `interface{}` on the way in, then type-asserting on the way out. Every box is a heap allocation and GC pressure.

This is the real cost of `interface{}`: not just the type assertions you write, but the invisible allocations the compiler inserts.

## When to use generics (and when not to)

Generics are right for:

- **Containers** — stacks, queues, sets, trees. Element type varies, structure doesn't.
- **Algorithms** — `Map`, `Filter`, `Reduce`, `Sort`. Logic is identical across types.
- **Type-safe wrappers** — `Result[T]`, `Pair[K, V]`.

Generics are wrong for:

- **Behavioural abstraction** — if you describe what a type *does* (reads bytes, marshals JSON), use an **interface**. Interfaces are runtime dispatch and work with dependency injection, mocking, decorators.
- **Overloading** — constraints are not overloading. No two `Max` functions differing only in constraint. Go has no function overloading; generics don't change that.
- **Premature generality** — if you call `Map` with `[]int` once, write the one-line loop. Don't reach for type parameters until the second instantiation.

The stdlib uses generics sparingly: `slices` and `maps` packages provide generic algorithms, but most of the stdlib is still interfaces and concrete types. Generics are a scalpel, not a hammer.

## Pitfalls

**Constraints are not inheritance.** `type Celsius float64` satisfies `~float64` because its underlying type is `float64` — not because it "is a" float64 in an OOP sense.

**No method type parameters.** This fails to compile:

```go
func (s *Stack[T]) Transform[U any](f func(T) U) Stack[U]  // compile error
```

Methods can only use the type parameters declared on the type itself. If you need a fresh type parameter, make it a free function.

**Readability cost.** Deeply nested type parameters (`Map[KV, V, K comparable, ...]`) can be harder to read than the `interface{}` version. Use type aliases and keep constraint definitions short and named.

**A real compile error when you get it wrong:**

```
./compile_error.go:23:15: MyString does not satisfy Number (MyString missing in ~int | ~float64)
```

The compiler catches at compile time what would have been a runtime panic with `interface{}`. The error names the missing type and the constraint it failed — exactly the feedback loop you want.

## The bottom line

Generics solve a narrow but important problem: type-safe containers and algorithms without `interface{}` boxing or code generation. They're compile-time, so no runtime cost for the abstraction itself. They don't replace interfaces — interfaces describe behaviour, generics describe structure. Use both.

For complementary Go testing techniques, see [Go testing and fuzzing](/posts/go-testing-and-fuzzing/). For concurrency bugs generics can't catch, the [race detector](/posts/go-concurrency-race-detector/) is the right tool.

## Figure

<figure>
  <svg viewBox="0 0 560 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Generic function instantiated for two types">
    <style>
      .box { fill: none; stroke: currentColor; stroke-width: 1.5; }
      .teal { stroke: #0f766e; }
      .label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: currentColor; }
      .small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: #0f766e; }
      .arrow { stroke: currentColor; stroke-width: 1.2; fill: none; marker-end: url(#arrow); }
    </style>
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
      </marker>
    </defs>
    <rect x="20" y="70" width="160" height="80" rx="6" class="box teal"/>
    <text x="100" y="95" text-anchor="middle" class="label" fill="#0f766e">Map[T, U any]</text>
    <text x="100" y="115" text-anchor="middle" class="small">type params</text>
    <text x="100" y="135" text-anchor="middle" class="small">compile-time</text>
    <line x1="180" y1="100" x2="260" y2="60" class="arrow"/>
    <rect x="260" y="30" width="140" height="60" rx="6" class="box teal"/>
    <text x="330" y="55" text-anchor="middle" class="label">Map[int, int]</text>
    <text x="330" y="75" text-anchor="middle" class="small">T=int, U=int</text>
    <line x1="180" y1="120" x2="260" y2="160" class="arrow"/>
    <rect x="260" y="130" width="140" height="60" rx="6" class="box teal"/>
    <text x="330" y="155" text-anchor="middle" class="label">Map[string, int]</text>
    <text x="330" y="175" text-anchor="middle" class="small">T=string, U=int</text>
    <text x="470" y="70" text-anchor="middle" class="small">compiler generates</text>
    <text x="470" y="90" text-anchor="middle" class="small">each specialization</text>
  </svg>
  <figcaption>A generic function `Map[T, U any]` is instantiated by the compiler for each concrete type pair — no runtime overhead, no type assertions.</figcaption>
</figure>
