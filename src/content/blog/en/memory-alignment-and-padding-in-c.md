---
title: "Struct Padding and Alignment in C, Measured"
description: "Why C structs have holes: real sizeof/offsetof numbers, _Alignof, packed structs with a UBSan misaligned-load report, memcpy serialization garbage, and a false-sharing speedup measured on x86-64."
pubDate: 2027-02-13
lang: en
translationKey: memory-alignment-and-padding-in-c
tags: [c]
featured: false
keywords:
  - struct padding
  - memory alignment C
  - sizeof offsetof
  - false sharing
  - packed struct
  - cache line
  - serialization
---

Structs in C are not just bags of fields. The compiler silently inserts empty
bytes — **padding** — between and after members so that every field sits at an
address the CPU can access efficiently. This is invisible in your source, but it
shows up the moment you ask `sizeof`, serialize a struct, or run multithreaded
code. In this article I measure all of it on x86-64 with real programs: sizes,
offsets, alignment requirements, a packed struct that traps you, serialization
garbage, and a false-sharing demo with real timings.

If you want a broader first pass at reading unfamiliar code, see [Reading a
Codebase](/posts/reading-a-codebase/); the ESP32 C node post covers [embedded C
in practice](/posts/esp32-easytier-node-in-c/).

## Why padding exists

A CPU reads memory in fixed-width chunks. On x86-64, an 8-byte `double` is
fastest when its address is a multiple of 8; a 4-byte `int` wants a multiple of
4. If a `char` (1 byte) is immediately followed by a `double`, the `double` would
land at an address that is not a multiple of 8. The compiler inserts 7 bytes of
padding to push it to the next 8-byte boundary. The struct grows, but every
access stays fast and — on architectures that require it — aligned.

The rule is simple: **each member is placed at the next address that is a
multiple of its own alignment**, and the whole struct's size is rounded up to a
multiple of the largest member's alignment. The largest alignment in the struct
becomes the struct's alignment.

## Seeing it with sizeof and offsetof

Here is the same three fields in two orders:

```c
struct good {
    double d;   // 8
    int    i;   // 4
    char   c;   // 1
};              // natural: 8 + 4 + 1, round up to 8 => 16

struct bad {
    char   c;   // 1
    double d;   // 8  (needs 7 bytes of padding after c)
    int    i;   // 4
};              // 1 + 7pad + 8 + 4, round up to 8 => 24
```

Compiled and run (gcc 16.2.1, x86-64):

```text
sizeof(char)=1  sizeof(int)=4  sizeof(double)=8
offsetof(struct good, d)=0 i=8 c=12  size=16
offsetof(struct bad,  c)=0 d=8 i=16  size=24
```

Same fields, same program: **16 bytes vs 24 bytes** — a 50% difference purely
from declaration order. `offsetof` (from `<stddef.h>`) tells you exactly where
each member lands, and `sizeof` tells you the padded total.

## _Alignof: the alignment of each type

`_Alignof` (from `<stdalign.h>`) gives the alignment requirement of a type, and
a struct's alignment is the maximum alignment of its members:

```c
struct mixed {
    char   a;
    double b;
    char   c;
    int    d;
};
```

```text
_Alignof(char)=1  _Alignof(int)=4  _Alignof(double)=8
_Alignof(struct mixed)=8  sizeof(struct mixed)=24
```

`struct mixed` is aligned to 8 (because of the `double`), so its size is a
multiple of 8. Even though the members sum to 14 bytes, the struct occupies 24.

## pahole: the layout tool

`sizeof` and `offsetof` are manual. The tool `pahole` reads debug info and draws
the layout with the holes marked. On the `bad` struct above:

```text
struct bad {
	char                       c;                    /*     0     1 */

	/* XXX 7 bytes hole, try to pack */

	double                     d;                    /*     8     8 */
	int                        i;                    /*    16     4 */

	/* size: 24, cachelines: 1, members: 3 */
	/* sum members: 13, holes: 1, sum holes: 7 */
	/* padding: 4 */
	/* last cacheline: 24 bytes */
};
```

The `XXX 7 bytes hole, try to pack` comment is exactly the padding after `c`.
The reordered `good` struct has no hole line at all:

```text
struct good {
	double                     d;                    /*     0     8 */
	int                        i;                    /*     8     4 */
	char                       c;                    /*    12     1 */

	/* size: 16, cachelines: 1, members: 3 */
	/* padding: 3 */
	/* last cacheline: 16 bytes */
};
```

`pahole` is invaluable when you inherit a struct and need to know where the
waste is before you reorder anything.

## The rule: order members largest-first

The practical heuristic is to **declare members in descending order of size**.
This is not a guarantee — alignment requirements matter, not just size — but it
eliminates most interior padding. In the example above, `good` (largest-first)
is 16 bytes; `bad` (smallest-first) is 24. For structs with many fields, the
savings compound: a handful of reordered members can shrink a struct by 30–50%,
which matters when you have millions of them in an array.

The trailing padding is unavoidable in general: the struct's size must be a
multiple of its alignment, so that arrays of the struct keep every element
aligned. But interior holes between members are yours to eliminate.

## packed: right for the wire, wrong for performance

`__attribute__((packed))` tells the compiler to insert no padding at all:

```c
struct normal {
    char  c;
    short s;
    int   i;
};                    // 1 + 1pad + 2 + 4 = 8

struct __attribute__((packed)) packed_p {
    char  c;
    short s;
    int   i;
};                    // 1 + 2 + 4 = 7, no padding
```

```text
sizeof(struct normal)=8  offsetof(s)=2 offsetof(i)=4
sizeof(struct packed_p)=7 offsetof(s)=1 offsetof(i)=3
```

The packed struct is 7 bytes — perfect for a **wire format** where you need an
exact byte layout. But the same packed struct is a **trap for performance and
portability**:

- **Misaligned access.** On x86-64 the CPU tolerates misaligned loads (with a
  small penalty), but on ARM, RISC-V, or SPARC a misaligned load can crash with
  `SIGBUS`. Packed structs invite exactly this.
- **Undefined behavior.** Reading a misaligned member through a pointer is UB in
  C, even on x86. Compile with `-fsanitize=undefined` and a real misaligned
  load is reported:

```text
packed.c:33:5: runtime error: load of misaligned address 0x7ffe1a365145 for type 'unsigned int', which requires 4 byte alignment
0x7ffe1a365145: note: pointer points here
 00 41 34 12 ef be ad  de 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00
             ^
```

- **No compiler fix-up.** The compiler cannot reorder a packed struct for you;
  it takes the layout literally, holes and all.

Use `packed` when you must match an external byte layout (a protocol header, a
hardware register map), and even then, prefer to serialize field-by-field with
explicit shifts rather than casting a packed struct to a byte buffer.

## The serialization lesson: never memcpy a struct to the wire

This is the mistake that bites people: `memcpy` a struct into a send buffer and
assume the bytes are meaningful. They are not — the padding bytes are
uninitialized garbage, and the layout is not portable.

```c
struct sensor {
    char  tag;      // 1 byte
    double value;   // 8 bytes  (7 pad bytes after tag)
    short  seq;     // 2 bytes
};                  // total 24
```

I poison every byte with `0xAA`, then assign only the three real fields. The
padding stays `0xAA`:

```text
sizeof(struct sensor)=24
wire bytes: 54 aa aa aa aa aa aa aa 6e 86 1b f0 f9 21 09 40 07 00 aa aa aa aa aa aa
offsetof(tag)=0 value=8 seq=16
padding bytes at offsets 1..7 (uninitialized 0xAA): aa aa aa aa aa aa aa
```

Those 7 `aa` bytes are not data — they are whatever was on the stack. Send that
to another machine and you are leaking memory contents (a security problem) and
sending bytes that a different compiler, architecture, or packing setting will
interpret differently (a correctness problem). The layout of a struct is an
**implementation detail**, not a contract.

The fix is explicit serialization: write each field to the buffer in a defined
order with defined widths, or use a library that does it for you. Never cast a
struct to `unsigned char *` and ship it.

## False sharing: the cache-line tax

Padding is not just about saving bytes — it is about **cache lines**. A CPU
caches memory in 64-byte lines (on x86-64). When two threads write to two
variables that happen to sit on the same cache line, the cache coherency protocol
forces the line to bounce between cores: each write invalidates the other core's
copy, and the line ping-pongs. The two threads are not sharing data, but they
are sharing a **cache line** — hence *false sharing*.

Here is a real benchmark: two threads each increment a counter 20 million times.
First the counters are adjacent (same cache line), then padded apart so each
lives on its own 64-byte line:

```text
N iterations per thread: 20000000, cache line: 64 bytes
false sharing  (adjacent):  0.048 s
padded apart   (own line):  0.035 s
speedup from padding:        1.37x
```

Across three runs the speedup was **1.37x, 1.40x, and 1.41x** — a consistent
~40% improvement from inserting 56 bytes of padding. The increments are
identical; the only difference is cache-line placement. On a real workload with
more contention or on a many-core machine, the gap widens further.

The pattern is to pad hot per-thread variables to a full cache line:

```c
typedef struct {
    volatile unsigned long a;      // hot
    char pad[64 - sizeof(unsigned long)];
    volatile unsigned long b;      // hot, on its own cache line
} padded_t;
```

This is the same idea as `struct bad` in reverse: there you remove padding to
save space; here you add padding to buy speed. Both are tools; the difference is
whether the struct is memory-bound or contention-bound.

## Practical advice

- **Measure first.** Use `sizeof`, `offsetof`, and `pahole` to see the real
  layout before you change anything. Do not guess.
- **Order members largest-first** to eliminate interior padding. It is free,
  portable, and shrinks arrays of structs.
- **Use `packed` sparingly** — for wire formats and register maps only. Be aware
  of misaligned access, UB, and portability.
- **Never serialize a struct by `memcpy`.** Write fields explicitly or use a
  serialization library. The padding is garbage and the layout is not portable.
- **Pad hot per-thread data to a cache line** when two threads write nearby
  variables. The 1.4x speedup above is real and reproducible.

Padding is one of those C details that is invisible until it costs you — bytes
on the wire, a crash on ARM, or a 40% throughput loss to cache-line bouncing.
Now you have the tools to see it, shrink it, and spend it deliberately.
