---
title: "Undefined behaviour in C: what the sanitizers catch, and why it matters"
description: "A hands-on tour of undefined behaviour in C: real AddressSanitizer and UBSan reports for out-of-bounds reads, use-after-free, signed overflow, bad shifts, null derefs and strict aliasing, each paired with a fix."
pubDate: 2027-02-12
lang: en
translationKey: c-pointer-arithmetic-and-ub
tags: [c]
featured: false
keywords:
  - undefined behaviour C
  - AddressSanitizer
  - UBSan
  - out-of-bounds
  - use-after-free
  - strict aliasing
  - gcc warnings
---

Every C bug I have spent more than a day on had the same shape: the code compiled,
linked, and produced the right answer on my machine — and was still wrong. **Undefined
behaviour in C** is not an error you get. It is a licence the standard hands the
compiler: *assume this never happens, and optimise accordingly*. Cross that line and the
standard stops describing your program; what you observe next is an accident.

This is a working session, not a lecture. I wrote small C programs on x86-64 Linux with
GCC 16.2.1, built each with `-fsanitize=address,undefined` and with
`-Wall -Wextra -Wpedantic`, and pasted the real reports. If you are trying to understand
an unfamiliar C codebase, the outside-in method in
[How to read a codebase you didn't write](/posts/reading-a-codebase/) makes these bugs
much easier to spot than skimming does.

## What "undefined" buys the compiler

Three categories matter, and only one of them is a crash:

- **Implementation-defined** — the implementation must pick a behaviour and document it.
- **Unspecified** — several are allowed, but the program is still well behaved.
- **Undefined** — the standard imposes *no requirements at all*. `int i = INT_MAX; i + 1;`

The third is where damage happens. Because UB is assumed impossible, the optimizer
reasons backwards: *if `i + 1` is computed and overflow is UB, then `i` is not `INT_MAX`*,
so this branch is dead. That is why `-O0` and `-O2` can disagree — `-O0` is not a
reference implementation, just a less aggressive exploiter of the licence.

| Family | Typical cause | Caught by |
|---|---|---|
| Out-of-bounds access | off-by-one, `<=` instead of `<`, trusting a wire length | ASan, `-Warray-bounds` |
| Use-after-free / double-free | owner hands out a pointer, forgets to invalidate it | ASan, `-Wuse-after-free` |
| Signed integer overflow | deadline arithmetic, `a + b > c` checks | UBSan |
| Invalid shift | shift count from a protocol field, negative shift | UBSan, `-Wshift-count-negative` |
| Null-pointer dereference | error path logs and continues | ASan (SEGV) |
| Strict-aliasing violation | `(int *)&some_long` | `-Wstrict-aliasing=2` |
| Uninitialised read | the "fill it in later" buffer | valgrind, clang `-fsanitize=memory` |
| Misaligned access | cast a `char *` to a wide pointer | UBSan |

## How to catch them

Two flags do most of the work:

```sh
gcc -O2 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -g -o prog prog.c
```

**AddressSanitizer** (ASan) checks every access against a shadow map and puts redzones
around stack, heap and global objects, so it catches out-of-bounds access in either
direction, use-after-free, double-free, and — because it installs a SEGV handler — null
dereferences. **UBSan** checks the arithmetic and alignment rules at runtime. They
combine in one binary, which is what I use for development.

`-Wall -Wextra -Wpedantic` runs before the program does and catches the statically
provable subset: `-Warray-bounds`, `-Waggressive-loop-optimizations` (the off-by-one
loop), `-Wstringop-overflow`, `-Wuse-after-free`, `-Wshift-count-negative`. Worth
enabling beyond the defaults: `-Wstrict-aliasing=2` and `-fanalyzer`.

**valgrind** is the third leg: no recompilation, and it catches what ASan and UBSan do
not — above all uninitialised reads, because GCC has no `-fsanitize=memory`. It was not
installed in my container, so every report below comes from GCC's own sanitizers. A
fabricated valgrind log would be worse than no log.

### The static pass, all in one file

Warnings need no execution at all. Three lines of sloppy C, and what
`-Wall -Wextra -Wpedantic` says about them:

```c
/* warn_all.c — abridged */
int a[10];
for (int i = 0; i <= 10; i++)     /* classic off-by-one */
    a[i] = i;

char *p = malloc(8);
strcpy(p, "this string is far too long");   /* 28 bytes into an 8-byte block */
```

```text
warn_all.c: In function 'main':
warn_all.c:20:42: warning: right shift count is negative [-Wshift-count-negative]
   20 |     printf("%d %ld %d\n", a[0], *ip, reg >> -1);
      |                                          ^~~
warn_all.c:10:14: warning: iteration 10 invokes undefined behavior [-Waggressive-loop-optimizations]
   10 |         a[i] = i;
      |         ~~~~~^~~
warn_all.c:9:23: note: within this loop
     9 |     for (int i = 0; i <= 10; i++)     /* classic off-by-one: writes a[10] */
      |                         ~~~^~~~~
```

Run the `strcpy` on its own and GCC names the exact region:

```text
warn2.c: In function 'main':
warn2.c:7:5: warning: '__builtin_memcpy' writing 28 bytes into a region of size 8 [-Wstringop-overflow=]
    7 |     strcpy(p, "this string is far too long");   /* overflow the 8-byte block */
      |     ^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
warn2.c:6:15: note: destination object of size 8 allocated by 'malloc'
    6 |     char *p = malloc(8);
      |               ^~~~~~~
```

And `-fanalyzer`, which is off by default, draws you the picture of what it thinks you
did — including the CWE:

```text
warn2.c:7:5: warning: heap-based buffer overflow [CWE-122] [-Wanalyzer-out-of-bounds]
  'main': events 1-2
    6 |     char *p = malloc(8);
      |               |
      |               (1) capacity: 8 bytes
    7 |     strcpy(p, "this string is far too long");
      |     |
      |     (2) out-of-bounds write from byte 8 till byte 27 but region ends at byte 8
```

None of that ran the program. Warnings are the cheapest layer of the three and the one
you should turn on first.

## Demo 1 — the out-of-bounds read

```c
/* oob.c */
#include <stdio.h>

int main(void) {
    unsigned char buf[4] = {0x10, 0x20, 0x30, 0x40};
    printf("buf[3] = %u\n", buf[3]);
    printf("buf[4] = %u\n", buf[4]);   /* <-- one past the end */
    return 0;
}
```

All three layers flag it. Build output, trimmed only in the shadow-byte dump:

```text
oob.c: In function 'main':
oob.c:9:32: warning: array subscript 4 is above array bounds of 'unsigned char[4]' [-Warray-bounds=]
    9 |     printf("buf[4] = %u\n", buf[4]);   /* <-- one past the end */
      |                             ~~~^~~

oob.c:9:32: runtime error: index 4 out of bounds for type 'unsigned char [4]'
oob.c:9:32: runtime error: load of address 0x7b5781ef0024 with insufficient space for an object of type 'unsigned char'
=================================================================
==1462321==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7b5781ef0024
READ of size 1 at 0x7b5781ef0024 thread T0
    #0 0x56545f9d22dc in main /tmp/opencode/work/c-ub/oob.c:9

Address 0x7b5781ef0024 is located in stack of thread T0 at offset 36 in frame
    #0 0x56545f9d211f in main /tmp/opencode/work/c-ub/oob.c:5

  This frame has 1 object(s):
    [32, 36) 'buf' (line 6) <== Memory access at offset 36 overflows this variable
SUMMARY: AddressSanitizer: stack-buffer-overflow /tmp/opencode/work/c-ub/oob.c:9 in main
```

The line `[32, 36) 'buf'` with the arrow is the point: ASan knows which object you ran
off the end of, and in which direction.

<figure>
<svg viewBox="0 0 480 168" role="img" aria-labelledby="oobsvg" style="max-width:100%;height:auto;font-family:ui-monospace,monospace;font-size:12px">
  <title id="oobsvg">A four-byte stack buffer with an out-of-bounds read one byte past the end</title>
  <g fill="none" stroke="currentColor" stroke-width="1">
    <rect x="40" y="52" width="48" height="44"/>
    <rect x="88" y="52" width="48" height="44"/>
    <rect x="136" y="52" width="48" height="44"/>
    <rect x="184" y="52" width="48" height="44"/>
    <rect x="232" y="52" width="120" height="44" stroke="#0f766e" stroke-dasharray="4 3"/>
  </g>
  <g fill="currentColor" text-anchor="middle">
    <text x="64" y="34">buf[0]</text>
    <text x="112" y="34">buf[1]</text>
    <text x="160" y="34">buf[2]</text>
    <text x="208" y="34">buf[3]</text>
    <text x="292" y="34" fill="#0f766e">buf[4]  ← UB</text>
    <text x="64" y="80">0x10</text>
    <text x="112" y="80">0x20</text>
    <text x="160" y="80">0x30</text>
    <text x="208" y="80">0x40</text>
    <text x="292" y="80" fill="#0f766e">?</text>
  </g>
  <path d="M 292 96 L 292 118" stroke="#0f766e" stroke-width="1.5" fill="none"/>
  <path d="M 287 112 L 292 122 L 297 112" stroke="#0f766e" stroke-width="1.5" fill="none"/>
  <text x="292" y="138" fill="#0f766e" text-anchor="middle">redzone — not your memory</text>
  <text x="40" y="160" fill="currentColor" opacity="0.7">sizeof buf == 4 bytes · object lives at [32, 36) on the stack</text>
</svg>
<figcaption>The object and its redzone. Reading `buf[4]` does not read the next variable — it
reads a byte the runtime put there on purpose, which is exactly why it can be detected.
</figcaption>
</figure>

The fix is to derive the bound instead of typing it:

```c
/* oob_fixed.c */
for (size_t i = 0; i < sizeof buf / sizeof buf[0]; i++)
    printf("buf[%zu] = %u\n", i, buf[i]);
```

```text
buf[0] = 16
buf[1] = 32
buf[2] = 48
buf[3] = 64
sizeof buf = 4 bytes
exit=0  sanitizer-output=0
```

## Demo 2 — the out-of-bounds write that gets exploited

A one-byte read is a curiosity. A heap *write* driven by a length you trusted is the
whole vulnerability class:

```c
/* oob_heap.c — a "relay" routine */
static void relay(struct frame *f) {
    unsigned char copy[64];
    memcpy(copy, f->body, f->len);       /* trusts f->len from the wire */
    printf("relayed %zu bytes, first=%02x\n", f->len, copy[0]);
}

struct frame f = { pkt, 128 };           /* sender claims 128, we only have 64 */
relay(&f);
```

```text
==1440210==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7b0746af0080
WRITE of size 128 at 0x7b0746af0080 thread T0
    #1 0x555fd3df0279 in relay /tmp/opencode/work/c-ub/oob_heap.c:10
Address 0x7b0746af0080 is located in stack of thread T0 at offset 128 in frame
  This frame has 2 object(s):
    [64, 128) 'copy' (line 9) <== Memory access at offset 128 overflows this variable
SUMMARY: AddressSanitizer: stack-buffer-overflow /tmp/opencode/work/c-ub/oob_heap.c:10 in relay
```

Note what the static compiler did *not* say: `memcpy` with a runtime length is invisible
to `-Warray-bounds`, and only the sanitizer caught it. That asymmetry is the argument for
sanitizers in CI, not just warnings in the build. The fix is an explicit minimum plus a
reported truncation:

```c
/* oob_heap_fixed.c */
#define STAGE 64u

static int relay(struct frame *f) {
    unsigned char copy[STAGE];
    size_t n = f->len < STAGE ? f->len : STAGE;   /* explicit min */
    memcpy(copy, f->body, n);
    printf("relayed %zu of %zu bytes, first=%02x\n", n, f->len, copy[0]);
    return n == f->len ? 0 : -1;                   /* report the truncation */
}
```

```text
relayed 64 of 128 bytes, first=ab
rc=-1
exit=0  sanitizer-output=0
```

Returning a status for the truncated case matters. Silently clamping turns an attack
into a data-loss bug.

## Demo 3 — use-after-free and double-free

Free on reload, forget to clear the cached pointer, and the next read hits freed memory:

```c
/* uaf2.c */
char *cache = malloc(32);
strcpy(cache, "v1");
free(cache);                       /* config reload, old value dropped */
char *fresh = malloc(32);          /* allocator hands the same block back */
strcpy(fresh, "v2-longer-payload");
printf("cache after reload = %s\n", cache);   /* reads freed memory */
```

GCC caught that statically and ASan caught it dynamically — both real:

```text
uaf2.c: In function 'main':
uaf2.c:15:5: warning: pointer 'cache' used after 'free' [-Wuse-after-free=]
   15 |     printf("cache after reload = %s\n", cache);   /* reads freed memory */
      |     ^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

==1440353==ERROR: AddressSanitizer: heap-use-after-free on address 0x7c2463be0040
READ of size 2 at 0x7c2463be0040 thread T0
    #1 0x7ff465b2c0c1 in malloc (/usr/lib/libasan.so.8+0x12c0c1)   <- the new malloc
previously allocated by thread T0 here:
freed by thread T0 here:
    #1 0x55c18f53a143 in main /tmp/opencode/work/c-ub/uaf2.c:11
```

The double-free variant is worse: it corrupts the allocator itself. A teardown function
that frees without clearing, plus an error path that calls it twice:

```c
/* uaf_real.c */
static void conn_close(struct conn *c) {
    free(c->rx);               /* BUG: no NULL, no ownership flag */
}
...
conn_close(&c);
conn_close(&c);                /* error path fires after the normal teardown */
```

```text
==1440282==ERROR: AddressSanitizer: attempting double-free on 0x7be7fb7e0010 in thread T0:
    #1 0x5654adaad23f in conn_close /tmp/opencode/work/c-ub/uaf_real.c:8
0x7be7fb7e0010 is located 0 bytes inside of 16-byte region [0x7be7fb7e0010,0x7be7fb7e0020)
freed by thread T0 here:
SUMMARY: AddressSanitizer: double-free /tmp/opencode/work/c-ub/uaf_real.c:8 in conn_close
```

The fix is one line of discipline — `free(p); p = NULL;` — or one owner and a single
teardown path:

```text
cache = v1
fresh = v2-longer-payload
exit=0  sanitizer-output=0
```

## Demo 4 — signed integer overflow

Deadline arithmetic is the usual culprit: `now + delay`, where `now` is a clock value that
is not supposed to get that large, until it does.

```c
/* ovf.c */
static int deadline_after(int now, int delay_ms) {
    return now + delay_ms;
}
int now = INT_MAX - 10;
printf("deadline = %d\n", deadline_after(now, 20));
printf("now > deadline ? %s\n", now > deadline_after(now, 20) ? "yes" : "no");
```

```text
ovf.c:6:16: runtime error: signed integer overflow: 2147483637 + 20 cannot be represented in type 'int'
now          = 2147483637
deadline     = -2147483639
now > deadline ? yes
exit=0
```

UBSan printed the report and then *carried on with the wrapped value*, because
`-fsanitize=undefined` recovers by default. Add `-fno-sanitize-recover=all` in a test
suite to make it abort instead. The plain `-O2` build printed the same numbers, so
overflow appears to "work". It does not — take the comparison out of constant-folding's
reach by making the value runtime input:

```c
/* ovf_rt.c */
int i = (int)in;                       /* in parsed from argv */
printf("i = %d, i+1 = %d, i+1 < i ? %s\n", i, i + 1, (i + 1 < i) ? "yes" : "no");
```

```text
$ ./ovf_rt_O0 2147483647
i = 2147483647, i+1 = -2147483648, i+1 < i ? no
$ ./ovf_rt_O2 2147483647
i = 2147483647, i+1 = -2147483648, i+1 < i ? no
$ ./ovf_rt_fwrapv 2147483647
i = 2147483647, i+1 = -2147483648, i+1 < i ? yes
```

Read that carefully. `i + 1` computed the wrapped value `-2147483648`, and yet
`i + 1 < i` answered **no**. The compiler folded the comparison under the assumption that
overflow cannot happen, so it is false no matter what the hardware did. Same input, same
source, one flag apart, opposite answers — and it happens at `-O0` too, because the
folder lives in the front end. The fix is either to do the arithmetic in `unsigned`,
where wraparound is *defined*, or to check before you add:

```c
static int deadline_after(int now, int delay_ms, int *ok) {
    if (delay_ms > INT_MAX - now) { *ok = 0; return now; }   /* would overflow */
    *ok = 1;
    return now + delay_ms;
}
```

```text
now      = 2147483637
deadline = 2147483637 (ok=0)
exit=0  sanitizer-output=0
```

## Demo 5 — a shift count you did not validate

A count lifted straight out of a protocol field, on a 32-bit `int`:

```c
/* shift.c */
int count = atoi(argv[2]);
printf("reg << count = 0x%08x\n", reg << count);
printf("reg >> -1    = 0x%08x\n", reg >> -1);
```

```text
shift.c:13:45: warning: right shift count is negative [-Wshift-count-negative]
   13 |     printf("reg >> -1      = 0x%08x\n", reg >> -1);
      |                                             ^~~
shift.c:11:45: runtime error: shift exponent 40 is too large for 32-bit type 'int'
shift.c:12:44: runtime error: shift exponent 40 is too large for 32-bit type 'unsigned int'
shift.c:13:45: runtime error: shift exponent -1 is negative
reg = 0xdeadbeef, count = 40
reg << count   = 0xadbeef00
```

On x86-64 the hardware masks the count to five bits, so `<< 40` silently became `<< 8`
(`0xdeadbeef << 8 == 0xadbeef00`): a reproducible, wrong answer with no crash and no
runtime warning. The fix clamps the count against an explicit width and rejects
negatives:

```text
reg=0xdeadbeef count=40
reg << count = 0x00000000
reg >> count = 0x00000000
exit=0  sanitizer-output=0
```

## Demo 6 — the null dereference

An error path that logs and forgets to return:

```c
/* nullp.c */
const char *tag = NULL;
if (argc > 1) tag = argv[1];
if (!tag) {
    fprintf(stderr, "no tag, skipping\n");
    /* BUG: no return/exit here */
}
emit(tag);                       /* emit does strcpy(buf, tag) */
```

```text
nullp.c:8:5: runtime error: null pointer passed as argument 2, which is declared to never be null
==1453848==ERROR: AddressSanitizer: SEGV on unknown address 0x000000000000 (pc 0x7f3f15f4d1e6)
==1453848==The signal is caused by a READ memory access.
==1453848==Hint: address points to the zero page.
    #2 0x562dc98ca214 in emit /tmp/opencode/work/c-ub/nullp.c:8
    #3 0x562dc98ca214 in main /tmp/opencode/work/c-ub/nullp.c:19
SUMMARY: AddressSanitizer: SEGV /tmp/opencode/work/c-ub/nullp.c:8 in emit
```

The fix is the missing `return`, plus a defensive check in the callee. The fixed build
runs clean.

## Demo 7 — strict aliasing, where -O0 and -O2 disagree

This is the one I would put on a poster. `f` takes a `long *` and an `int *`; the caller
makes the `int *` point *inside* the `long`. Believing a `long` object and an `int`
object can never share storage, the compiler may keep `*l` in a register across the
`int` store:

```c
/* alias3.c */
static long f(long *lp, int *ip) {
    *lp = 0;
    *ip = 0x11223344;      /* an int store the compiler believes cannot touch *lp */
    return *lp;
}

int main(void) {
    long l = 0;
    int *ip = (int *)&l;   /* but it does */
    printf("f() = %ld (expect 0x11223344 = %ld)\n", f(&l, ip), 0x11223344L);
    return 0;
}
```

```text
-O0 default                -> f() = 287454020 (expect 0x11223344 = 287454020)
-O0 -fno-strict-aliasing   -> f() = 287454020 (expect 0x11223344 = 287454020)
-O2 default                -> f() = 0 (expect 0x11223344 = 287454020)
-O2 -fno-strict-aliasing   -> f() = 287454020 (expect 0x11223344 = 287454020)
```

One flag — `-O2` instead of `-O0` — turns the correct answer into zero. And the static
compiler sees it coming:
```text
$ gcc -O2 -fstrict-aliasing -Wstrict-aliasing=2 -c alias3.c
alias3.c: In function 'main':
alias3.c:11:22: warning: dereferencing type-punned pointer will break strict-aliasing rules [-Wstrict-aliasing]
   11 |     int *ip = (int *)&l;   /* but it does */
      |                      ^~
```

Neither ASan nor UBSan caught this — there is no runtime check for aliasing rules in
either. The only tools are `-Wstrict-aliasing=2` and code review. The fix is to move
bytes with `memcpy` (always legal) or a `union`:
```c
union pun { long l; int i[2]; };
memcpy(&l, iparts, sizeof l);
printf("l = 0x%016lx\n", (unsigned long)l);
```

```text
l = 0x0000000011223344
widen(0x11223344) = 0x0000000011223344
exit=0  sanitizer-output=0
```

## Misaligned access

UBSan does check alignment, but the demo needs a cast rather than a `packed` struct:

```c
/* align.c */
unsigned char wire[8] = {0x01, 0x00, 0x00, 0x00, 0x80, 0, 0, 0};
unsigned int *p = (unsigned int *)(wire + 1);   /* odd address */
unsigned int v = *p;                             /* misaligned load */
```

```text
align.c:13:18: runtime error: load of misaligned address 0x7ffe01779db1 for type 'unsigned int', which requires 4 byte alignment
wire+1 as uint = 0x80000000
exit=0
```

Two details worth keeping. A `struct __attribute__((packed))` member did *not* trigger
the check — GCC emits a byte-wise sequence for packed members, so the compiler already
protects you there. And x86 tolerates the unaligned load and returns the right answer,
while the same code on an ARM Cortex-M is a hardware fault. The portable fix is
`memcpy` into a properly typed destination.

## Why this is worse on a microcontroller

On Linux with an MMU, a bad pointer usually maps to nothing and you get a `SEGV` with an
address. On a bare-metal target — the ESP32-C3 node in
[Turning an ESP32-C3 into a real EasyTier node](/posts/esp32-easytier-node-in-c/) — none
of that safety net exists. Every address in the flat map is readable and writable, so an
out-of-bounds write from a radio receive buffer lands in *somebody's* memory: another
buffer, a control block, or the ISR vector table. The program does not crash; it
corrupts something, and you find out three days later when an unrelated subsystem behaves
oddly. `-O2` with strict aliasing is worse for the same reason: it can decide a store
through a `uint32_t *` cannot affect a flag your ISR reads through another type, cache
that flag in a register, and turn a polling loop into an infinite loop.

## The rules I actually follow

1. **Warnings and sanitizers on in every dev build.** Keep them out of the shipping
   build if the target needs the speed — but never ship a target that has not been run
   under them once.
2. **Never type a literal array bound.** `sizeof a / sizeof a[0]`, `ARRAY_SIZE(a)`, or
   `sizeof buf` — anything except a `10` you must keep in sync by hand.
3. **Clamp, don't trust, anything with a length.** Take the minimum of the claimed
   length and the buffer you own, and report when they differ.
4. **Do overflow-prone arithmetic in `unsigned`, or check first.** `if (b > T_MAX - a)
   reject;` is barely longer than `a + b` and is defined.
5. **Validate shift counts against the type width** — x86 masks them, so you get a wrong
   answer instead of a crash.
6. **One owner per allocation, and `free` clears the pointer.**
7. **Reinterpret bytes with `memcpy` or a `union`**, never with a cast. Review every
   `(T *)` cast in a diff as if it were a bug that has not fired yet.
8. **Read sanitizer output as a to-do list, not noise.** ASan and UBSan are almost never
   wrong.

## What I could not reproduce

Three honest gaps, because pretending otherwise would be the exact sin this article is
about. **Leaks**: LeakSanitizer produced no report in this container for either of two
deliberate leaks, and GCC's `-fanalyzer` stayed silent on a simple leak too, so there is
no leak report to show. **Uninitialised reads**: GCC has no MemorySanitizer; two patterns
meant to provoke `-Wmaybe-uninitialized` produced no warning, and the run read harmless
zeroed stack. valgrind is the tool here and it was not installed. **An aliasing break I
could not find**: several candidate casts compiled to identical code at `-O0` and `-O2`,
so I only report the case above that genuinely differs.

Undefined behaviour is not a theory that affects other people's code. Every crash you
have debugged for two hours was probably one of these eight families. Turn the sanitizers
on, read the reports, and treat a "works at -O0, broken at -O2" bug report as a gift: it
is telling you exactly which assumption the compiler is willing to make about your
program.
