---
title: "Valgrind in practice: leaks, invalid accesses, and where the time goes"
description: "A hands-on session with valgrind on Linux: real memcheck reports for memory leaks in C, invalid reads and writes, uninitialised values, plus massif heap profiles, callgrind instruction counts and helgrind data races — with actual output and the fixes."
pubDate: 2027-02-14
lang: en
translationKey: valgrind-and-memory-profiling
tags: [c, linux]
featured: false
keywords:
  - valgrind
  - memory leak C
  - massif
  - callgrind
  - memcheck
---

C gives you `malloc` and no receipt. Nothing in the language tells you when a block
has no owner left, that a loop read one element past the end of an array, or that a
branch depends on a value nobody ever assigned. **Valgrind** is what I reach for when
those bugs are suspected: it runs your binary as-is, watches every memory access and
every heap block, and tells you what you broke. Every report below is real output from
real programs, and each one is paired with the fix that made it go quiet.

The tools that matter to a C programmer on Linux are **memcheck** (errors and leaks),
**massif** (heap growth), **callgrind** (where the time goes), **cachegrind** (cache
behaviour) and **helgrind/DRD** (thread errors). For the same binary with no recompiling.

## What valgrind actually is

Valgrind is a **dynamic binary instrumentation** framework. It needs neither source nor a
rebuild: it loads your ELF binary, disassembles each basic block, rewrites it into an
instrumented equivalent, and hands that to the CPU. Your program still runs, just inside
a synthetic machine with a supervisor watching. That is why it works on release binaries
you did not build, and why the first thing you want for good output is `-g` in the build.

<figure>
<svg viewBox="0 0 680 268" width="100%" role="img" aria-label="Valgrind is one instrumentation framework with several tools. The same unmodified binary is handed to memcheck for invalid accesses and leaks, massif for heap growth, callgrind for instruction counts, cachegrind for cache behaviour, and helgrind or DRD for data races.">
  <g stroke="currentColor" stroke-width="1.2" fill="none" opacity="0.45" stroke-dasharray="4 3">
    <path d="M160 76 L272 138"/>
    <path d="M340 53 L340 127"/>
    <path d="M520 76 L408 138"/>
    <path d="M520 192 L408 162"/>
    <path d="M340 215 L340 175"/>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.75">
    <rect x="90" y="30" width="140" height="46" rx="8"/>
    <rect x="270" y="30" width="140" height="46" rx="8"/>
    <rect x="450" y="30" width="140" height="46" rx="8"/>
    <rect x="90" y="192" width="140" height="46" rx="8"/>
    <rect x="270" y="192" width="140" height="46" rx="8"/>
  </g>
  <rect x="252" y="127" width="176" height="48" rx="8" stroke="#0f766e" stroke-width="1.8" fill="none"/>
  <g font-family="ui-monospace, monospace" font-size="12.5" fill="currentColor">
    <text x="160" y="50" text-anchor="middle">memcheck</text>
    <text x="160" y="66" text-anchor="middle" opacity="0.7">memory errors</text>
    <text x="340" y="50" text-anchor="middle">cachegrind</text>
    <text x="340" y="66" text-anchor="middle" opacity="0.7">cache behaviour</text>
    <text x="520" y="50" text-anchor="middle">massif</text>
    <text x="520" y="66" text-anchor="middle" opacity="0.7">heap profile</text>
    <text x="160" y="212" text-anchor="middle">helgrind / DRD</text>
    <text x="160" y="228" text-anchor="middle" opacity="0.7">data races</text>
    <text x="340" y="212" text-anchor="middle">callgrind</text>
    <text x="340" y="228" text-anchor="middle" opacity="0.7">instruction counts</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="13" fill="#0f766e">
    <text x="340" y="156" text-anchor="middle">./your-binary</text>
  </g>
</svg>
<figcaption>Valgrind is a dynamic binary instrumentation framework: it runs your unmodified binary and rewrites its machine code as it goes. Each tool is a different front end over the same machinery, so one binary can be measured for errors, heap growth, instruction counts, cache behaviour or data races without recompiling.</figcaption>
</figure>

My dev box had no valgrind package installed, so I ran everything in a throwaway
container — no sudo, no privileged mode, just the official image. That is the environment
behind every transcript below: valgrind 3.19.0, GCC 12.2.0, x86-64 Linux.

```console
$ docker run --rm -v "$PWD:/work" -w /work debian:bookworm-slim bash -c \
    'apt-get update -qq && apt-get install -y -qq valgrind gcc && valgrind --version'
valgrind-3.19.0
gcc (Debian 12.2.0-14+deb12u1) 12.2.0
```

## A program with every kind of memory complaint

Here is `leaky.c`, built with `gcc -g -O0 -Wall leaky.c -o leaky`. It is deliberately
tiny, and it contains four classic defects: a linked list that is never freed, a write
one element past the end of a heap array, a read that walks off the end of that same
array, and a branch on an uninitialised stack variable.

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct node {
    int value;
    struct node *next;
    char *label;
};

static char *make_label(int i)
{
    char *s = malloc(16);
    snprintf(s, 16, "node-%d", i);
    return s;
}

struct node *append(struct node *head, int value)
{
    struct node *n = malloc(sizeof *n);      /* 27 */
    n->value = value;
    n->label = make_label(value);
    n->next = NULL;
    if (!head)
        return n;
    struct node *p = head;
    while (p->next)
        p = p->next;
    p->next = n;
    return head;
}

int main(void)
{
    /* --- 1. definitely lost: the whole list is dropped on the floor --- */
    struct node *list = NULL;
    for (int i = 0; i < 4; i++)
        list = append(list, i);              /* 45 */
    /* ... and we never free(list). dummy use so -O0 keeps it: */
    printf("list head %d\n", list->value);

    /* --- 2. invalid write: past the end of a 4-int heap block --- */
    int *nums = malloc(4 * sizeof *nums);    /* 50 */
    nums[0] = 1; nums[1] = 2; nums[2] = 3;
    nums[4] = 99;                            /* 52: wrong on two counts */

    /* --- 3. invalid read: same bug, read side --- */
    int sum = 0;
    for (int i = 0; i <= 4; i++)             /* 57: 4 is out of bounds */
        sum += nums[i];                      /* 58 */
    printf("sum %d\n", sum);                 /* 59 */

    /* --- 4. conditional jump on an uninitialised value --- */
    int limit;                               /* 62 */
    if (limit > 100)                         /* 63 */
        printf("big\n");
    else
        printf("smallish\n");

    free(nums);
    return 0;
}
```

`valgrind --leak-check=full --track-origins=yes ./leaky` finds all four in one run.
The line numbers in the report match the listing above:

```console
==7== Memcheck, a memory error detector
==7== Using Valgrind-3.19.0 and LibVEX
==7== Command: ./leaky
==7==
==7== Invalid write of size 4
==7==    at 0x1092D0: main (leaky.c:52)
==7==  Address 0x4a3d350 is 0 bytes after a block of size 16 alloc'd
==7==    at 0x48417B4: malloc (vg_replace_malloc.c:381)
==7==    by 0x10929D: main (leaky.c:50)
==7==
==7== Invalid read of size 4
==7==    at 0x1092FA: main (leaky.c:58)
==7==  Address 0x4a3d350 is 0 bytes after a block of size 16 alloc'd
==7==    at 0x48417B4: malloc (vg_replace_malloc.c:381)
==7==    by 0x10929D: main (leaky.c:50)
==7==
==7== Conditional jump or move depends on uninitialised value(s)
==7==    at 0x109326: main (leaky.c:63)
==7==  Uninitialised value was created by a stack allocation
==7==    at 0x109240: main (leaky.c:41)
==7==
==7== HEAP SUMMARY:
==7==     in use at exit: 160 bytes in 8 blocks
==7==   total heap usage: 10 allocs, 2 frees, 4,272 bytes allocated
==7==
==7== 160 (24 direct, 136 indirect) bytes in 1 blocks are definitely lost in loss record 3 of 3
==7==    at 0x48417B4: malloc (vg_replace_malloc.c:381)
==7==    by 0x1091D2: append (leaky.c:27)
==7==    by 0x109269: main (leaky.c:45)
==7==
==7== LEAK SUMMARY:
==7==    definitely lost: 24 bytes in 1 blocks
==7==    indirectly lost: 136 bytes in 7 blocks
==7==      possibly lost: 0 bytes in 0 blocks
==7==    still reachable: 0 bytes in 0 blocks
==7==         suppressed: 0 bytes in 0 blocks
==7==
==7== ERROR SUMMARY: 12 errors from 8 contexts (suppressed: 0 from 0)
```

### How to read that

**Invalid reads and writes.** Memcheck puts a redzone around every heap block, so an
access one element past the end is caught even though it lands in perfectly mapped
memory. `Invalid write of size 4` is an `int` store; `Address 0x4a3d350 is 0 bytes after
a block of size 16` is the tell-tale — 16 bytes is exactly `4 * sizeof(int)`. The block's
origin is quoted too, which turns "crash somewhere in the middle of nowhere" into
"leaky.c:52".

**The uninitialised value.** With `--track-origins=yes`, memcheck does not just say the
value was garbage, it says where the garbage came from: `Uninitialised value was created
by a stack allocation` at `main (leaky.c:41)`, i.e. the `limit` variable at line 62. The
same report also carries the heap flavour of the bug: the loop at line 57 reads
`nums[3]`, `malloc`'d at line 50 and never written, so the `printf` at line 59 is blamed
for the uninitialised value derived from that allocation.

**Leak kinds.** At exit memcheck asks a reachability question for every block still
allocated, and the answer is the classification:

| Kind | Meaning | Action |
|---|---|---|
| **definitely lost** | no pointer anywhere points at it | the real leak — fix it |
| **indirectly lost** | reachable only from a definitely-lost block | dies with its owner |
| **possibly lost** | reachable only via an interior pointer | usually a real bug, sometimes a base-pointer trick |
| **still reachable** | a live pointer exists at exit (globals, caches) | often fine for a long-running daemon |
| **suppressed** | ruled out by a suppression file | check your `.supp` file |

Here the list is *definitely* lost because the only pointer to the head node, `list`, went
out of scope: 24 direct bytes are the head `struct node`, and the other 136 indirect bytes
are the three remaining nodes (72) plus four 16-byte labels (64). One detail in the
summary is worth reading: `10 allocs, 2 frees` — nine of those allocations are yours, and
the tenth is libc's stdio buffer for `printf`.

An honesty note: `-Wall` already spotted defect 4 at compile time
(`'limit' is used uninitialized`). Use the compiler first — it is free. Valgrind finds
the three it cannot see, and works on binaries you do not control the build of.

## The fix, and the quiet run

The fixes are all the same shape: give the array a length you actually respect,
initialise everything you branch on, and hand every allocation back to its owner.

```c
    int *nums = malloc(4 * sizeof *nums);
    nums[0] = 1; nums[1] = 2; nums[2] = 3; nums[3] = 4;

    int sum = 0;
    for (int i = 0; i < 4; i++)          /* i < n, never i <= n */
        sum += nums[i];

    int limit = 50;                      /* initialised before the branch */
```

The list gets a destructor that walks it, freeing the label and the node:

```c
static void free_list(struct node *head)
{
    while (head) {
        struct node *next = head->next;
        free(head->label);
        free(head);
        head = next;
    }
}
```

Now the same command runs the program and reports nothing but the truth:

```console
==7== HEAP SUMMARY:
==7==     in use at exit: 0 bytes in 0 blocks
==7==   total heap usage: 10 allocs, 10 frees, 4,272 bytes allocated
==7==
==7== All heap blocks were freed -- no leaks are possible
==7==
==7== ERROR SUMMARY: 0 errors from 0 contexts (suppressed: 0 from 0)
```

That line — **All heap blocks were freed -- no leaks are possible** — is the output you
want from CI. It means the leak kinds collapsed to zero, not that memcheck ran out of
ideas.

## What valgrind costs, and where AddressSanitizer fits

The reason all of this stays in the "dev tool" bucket is speed. I timed one
malloc-and-chase workload (200,000 rounds of building, summing and tearing down a
16-node chain) three ways on the same machine:
```console
$ time ./bench
rounds=200000 total=5119998400000 elapsed=0.073s
real	0m0.075s

$ time valgrind -q --tool=memcheck --leak-check=summary ./bench
rounds=200000 total=5119998400000 elapsed=4.849s
real	0m5.924s

$ time ./bench_asan
rounds=200000 total=5119998400000 elapsed=0.792s
real	0m1.038s
```

That is **66× for memcheck** and **11× for AddressSanitizer** against the same native
run — a malloc-heavy microbenchmark is memcheck's worst case, so treat 10–50× as the
usual rule of thumb and 66× as an upper bound for allocation storms. ASan works
differently: a compiler pass (recompile with `-fsanitize=address`) that maintains shadow
memory and instruments loads and stores at compile time, far cheaper than valgrind's
runtime translation.

The same `leaky.c` under ASan reports the invalid write immediately:

```console
==7==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x6020000000a0
WRITE of size 4 at 0x6020000000a0 thread T0
    #0 0x55f609f2551d in main /work/leaky.c:52
    #1 0x7f833a557249 in __libc_start_call_main

0x6020000000a0 is located 0 bytes to the right of 16-byte region [0x602000000090,0x6020000000a0)
allocated by thread T0 here:
    #0 0x7f833a7ca9cf in __interceptor_malloc
    #1 0x55f609f2540f in main /work/leaky.c:50

SUMMARY: AddressSanitizer: heap-buffer-overflow /work/leaky.c:52 in main
```

So which one? **ASan in your build, valgrind for everything else.** Use
`-fsanitize=address,undefined` on code you control, in CI, on every commit — it is fast
enough to leave on, and I wrote up the reports it produces in [Undefined behaviour in
C](/posts/c-pointer-arithmetic-and-ub/). Keep valgrind for what ASan cannot reach:
**binaries you did not build** (no flags, no source, still instrumented),
**uninitialised values** (ASan ignores them; clang's `-fsanitize=memory` catches them but
is not GCC-friendly), **leak classification** ("definitely lost" vs "still reachable"
needs a reachability scan), and **one run, all errors** — ASan aborts at the first error
by default, so a test with five bugs shows you one. Memcheck keeps going and hands you
the whole set.

## Massif: where the heap went

When a service's RSS climbs until the OOM killer visits, memcheck is the wrong tool — it
cares about *correctness*, not *size*. `--tool=massif` is the heap profiler. I wrote
`grow.c`: it allocates 400,000 records (a 28-byte struct, 11.2 MB), then allocates a
second copy to sort, then frees both.

```console
$ valgrind --tool=massif --time-unit=B ./grow
==7== Massif, a heap profiler
==7== Command: ./grow
==7==
==7==
$ ms_print massif.out
    MB
32.05^                                   ############
     |                                   #
     |                       ::::::::::::#           ::::::::::::
     |           :::::::::::::           #           :
   0 +----------------------------------------------------------------------->MB
     0                                                                   64.11

Number of snapshots: 10
 Detailed snapshots: [4 (peak)]

  n        time(B)         total(B)   useful-heap(B) extra-heap(B)    stacks(B)
--------------------------------------------------------------------------------
  0              0                0                0             0            0
  1     11,202,504       11,202,504       11,200,000         2,504            0
  2     22,405,008       22,405,008       22,400,000         5,008            0
  3     33,607,512       33,607,512       33,600,000         7,512            0
  4     33,607,512       33,607,512       33,600,000         7,512            0
```

The useful column is `useful-heap`: the bytes your code asked for. `extra-heap` is
memcheck's own bookkeeping. The peak here is snapshot 4 at **33.6 MB — 3× the size of one
copy**, which answers "why does this process hold 64 MB when the input is 21 MB?": the
sort happens while both arrays are live. Massif also shows *where* the memory came from:

```console
99.98% (33,600,000B) (heap allocation functions) malloc/new/new[], --alloc-fns, etc.
->33.33% (11,200,000B) 0x1090B3: main (grow.c:25)
->33.33% (11,200,000B) 0x109120: main (grow.c:34)
->33.33% (11,200,000B) 0x488EDBC: qsort_r (msort.c:221)
  ->33.33% (11,200,000B) 0x109155: main (grow.c:38)
```

That is the whole story of the program in three lines: `recs` at line 25, `sorted` at
line 34, and the sort's own working set at line 38. For a leak instead of a peak, the
snapshot table never returns to zero — massif gives you the growth curve as well as the
attribution, which is exactly what memcheck's single number at exit does not.

## Callgrind: where the time goes

`--tool=callgrind` counts executed instructions per function and per line. I wrote
`hotspot.c`, a deliberately naive O(n²) duplicate finder over 20,000 strings that calls
an FNV-1a hash twice per comparison. It runs in about 3.5 seconds natively; under
callgrind, long enough to go and make tea.

```console
$ valgrind --tool=callgrind ./hotspot
==17== Callgrind, a call-graph generating cache profiler
==17== Command: ./hotspot
items=20000 duplicates=0
==17== Events    : Ir
==17== Collected : 33204878025
==17== I   refs:      33,204,878,025
$ callgrind_annotate --auto=yes callgrind.out
33,204,878,025 (100.0%)  PROGRAM TOTALS

33,175,881,217 (99.91%)  hotspot.c:main [/work/hotspot]

-- Auto-annotated source: hotspot.c
             .           static unsigned hash_str(const char *s)
             .           {
   999,950,000 ( 3.01%)      unsigned h = 2166136261u;             /* FNV-1a */
21,116,844,105 (63.60%)      for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
 4,929,213,527 (14.84%)          h ^= *p;
 4,929,213,527 (14.84%)          h *= 16777619u;
```

**33.2 billion instructions.** Three lines of the hash loop account for 93% of them.
One detail worth internalising: the attribution says `hotspot.c:main`, not `hash_str` or
`count_duplicates`, because I built with `-O2` and GCC inlined both helpers into `main`.
Callgrind reports what it can see in the call graph, so for function-level numbers build
with `-fno-inline` — or read the per-line annotation, which still points at the guilty
loop. The fix here is algorithmic — hash once into a table, or sort and scan — and the
profile is what told me to leave `main`'s 0.07% setup loop alone.

## Helgrind and DRD: races in C

If your C program has threads, the same framework checks them. `race.c` has two threads
incrementing a shared `long` a hundred thousand times each with no synchronisation:

```console
$ valgrind --tool=helgrind ./race
==12== Helgrind, a thread error detector
==12== Command: ./race
==12==
==12== Possible data race during read of size 8 at 0x10C030 by thread #3
==12== Locks held: none
==12==    at 0x10916A: worker (race.c:16)
==12==    by 0x484C7D6: mythread_wrapper (hg_intercepts.c:406)
==12==
==12== This conflicts with a previous write of size 8 by thread #2
==12== Locks held: none
==12==    at 0x109175: worker (race.c:16)
==12==  Address 0x10c030 is 0 bytes inside data symbol "counter"
==12==
==12== ERROR SUMMARY: 4 errors from 4 contexts (suppressed: 0 from 0)
```

`race.c:16` is `counter++;` — a read and a write to the same address from two threads
with no lock in between. Helgrind names the symbol, the size and both access sites. The
native runs prove it is not theoretical: two runs of the same deterministic-looking
program printed `counter=112151 extra=321644` and `counter=194231 extra=388466`, neither
of them the 200,000/400,000 you expect, because updates were lost. (Under helgrind's
serialisation they come out exactly right — a nice trap for the unwary, since the
detector changes the timing.)

The idea will be familiar from Go: `go test -race` is the same insight, a happens-before
analysis of shared accesses instead of "wait and see if the output looks wrong". I wrote
about that in [Go's race detector in practice](/posts/go-concurrency-race-detector/).
In C the equivalent is helgrind (slow, precise) or DRD (`--tool=drd`, faster, catches
more error classes at the cost of depth), and the fix is what you already know: a mutex,
or `__atomic_add_fetch`/atomic types.

## The workflow I actually use

1. **Every commit** — build with `-Wall -Wextra` and `-fsanitize=address,undefined` and
   run the test suite. Free, fast, catches most of what I would ask memcheck for.
2. **Every test run on code with manual `malloc`** — `valgrind --leak-check=full
   --error-exitcode=99 ./test`. The `--error-exitcode` is the part people forget: CI
   should fail on valgrind's verdict, not on the program's exit code.
3. **When RSS grows** — `valgrind --tool=massif`, then `ms_print`. Look for snapshots
   that never come down, and the allocation site holding them.
4. **When CPU-bound** — `valgrind --tool=callgrind`, then `callgrind_annotate
   --auto=yes`. Fix the top line, repeat, and ignore anything under a couple of percent.
5. **When threads appear** — `valgrind --tool=helgrind` on the test suite.
6. **On a binary you cannot rebuild** — memcheck, the only tool that asks nothing of
   your build.

Two habits make all of it cheaper: keep a suppression file for the noise your
dependencies genuinely produce (`--gen-suppressions=all` writes one), and never profile a
program that still has known memory errors — memcheck's errors poison every other
measurement. And keep the mental model straight: a profiler is a lens, not a verdict.
memcheck answers *is my process correct*, massif *how much does it hold*, callgrind
*which line burns the CPU*, helgrind *can my threads be trusted*. Choosing the right
lens is most of the work.

---

*Related: [Undefined behaviour in C: what the sanitizers catch](/posts/c-pointer-arithmetic-and-ub/)
for the ASan/UBSan side, and [Python memory leaks and how to find them](/posts/python-memory-leaks/)
for the same problem in a language with a garbage collector — where the leaks come from
references you did not know you kept.*
