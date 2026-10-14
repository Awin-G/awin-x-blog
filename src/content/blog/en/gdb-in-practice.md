---
title: "gdb in practice: debugging a C crash instead of guessing with printf"
description: "A hands-on guide to gdb for debugging C crashes: backtraces, core dumps, conditional breakpoints, watchpoints, threads, and the -O0 vs -O2 story — with real output from real programs."
pubDate: 2027-02-14
lang: en
translationKey: gdb-in-practice
tags: [c, linux]
featured: false
keywords:
  - gdb
  - debug C crash
  - backtrace
  - core dump
  - breakpoint
---

When a C program crashes, the instinct is to sprinkle `printf` everywhere and rebuild. That works for trivial bugs, but it fails the moment you need to inspect state *after* a crash, debug a core dump, or understand a race in a multi-threaded program. That's where **gdb** (the GNU Debugger) earns its keep.

I've covered [debugging with strace](/posts/debugging-with-strace/) and [C pointer arithmetic and undefined behaviour](/posts/c-pointer-arithmetic-and-ub/) before. This article is about the tool that ties it all together: gdb. Every command and output block below comes from a real program I compiled and ran.

## Why gdb beats printf

`printf` debugging has three fundamental limitations:

1. **You must rebuild** every time you want to inspect a new variable.
2. **You can't inspect state after a crash** — the process is gone.
3. **You can't pause execution** to examine memory, registers, or the call stack at a specific point.

gdb solves all three. It attaches to a running process (or a dead one, via a core dump), lets you set breakpoints, and inspects the entire program state — all without recompiling.

## Setup: compile with `-g`

The `-g` flag tells the compiler to embed debug information (symbol table, line numbers, variable types) into the binary. Without it, gdb shows you assembly instead of your C code.

```bash
gcc -g -O0 -o segfault_O0 segfault.c
gcc -g -O2 -o segfault_O2 segfault.c
```

I'll use `-O0` (no optimization) for most examples and show why `-O2` is different later.

## The basic workflow: break, run, inspect

Here's the program I'll debug — a recursive function that dereferences a NULL pointer:

```c
#include <stdio.h>
#include <string.h>

struct config {
    char name[32];
    int  count;
    char *label;
};

void inner(struct config *cfg, int depth) {
    if (depth > 0) {
        inner(cfg, depth - 1);
    }
    cfg->label[0] = 'X';   // boom: cfg->label is NULL
}

void outer(struct config *cfg) {
    inner(cfg, 3);
}

int main(void) {
    struct config c;
    memset(&c, 0, sizeof c);
    strcpy(c.name, "worker-7");
    c.count = 42;
    /* forgot: c.label stays NULL */
    outer(&c);
    return 0;
}
```

The classic gdb session — set a breakpoint, run, step, inspect:

```gdb
$ gdb -batch -ex 'break main' -ex 'run' -ex 'next' -ex 'next' \
       -ex 'print c' -ex 'print c.name' -ex 'print c.count' \
       -ex 'continue' ./segfault_O0
Breakpoint 1 at 0x11a8: file segfault.c, line 22.
Breakpoint 1, main () at segfault.c:22
22  int main(void) {
24      memset(&c, 0, sizeof c);
$1 = {name = '\000' <repeats 31 times>, count = 0, label = 0x0}
$2 = '\000' <repeats 31 times>
$3 = 0
Program received signal SIGSEGV, Segmentation fault.
inner (cfg=0x7fffffffcf80, depth=0) at segfault.c:15
15      cfg->label[0] = 'X';
```

Notice what happened: I set a breakpoint at `main`, ran the program, stepped twice with `next`, printed the struct `c` (all zeros — `label` is NULL), then continued. The program crashed and gdb caught the SIGSEGV, showing me exactly where.

## Reading a segfault backtrace

The most important command after a crash is `bt` (backtrace). It shows the call stack — the chain of function calls that led to the crash:

```gdb
$ gdb -batch -ex 'run' -ex 'bt full' ./segfault_O0
Program received signal SIGSEGV, Segmentation fault.
inner (cfg=0x7fffffffcf80, depth=0) at segfault.c:15
15      cfg->label[0] = 'X';
#0  inner (cfg=0x7fffffffcf80, depth=0) at segfault.c:15
No locals.
#1  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=1) at segfault.c:12
No locals.
#2  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=2) at segfault.c:12
No locals.
#3  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:12
No locals.
#4  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
No locals.
#5  0x00005555555551f5 in main () at segfault.c:28
        c = {name = "worker-7", '\000' <repeats 23 times>, count = 42, label = 0x0}
```

`bt full` shows each frame's local variables. Frame #0 is the crash site (`inner` at depth=0). Frame #5 is `main`, and you can see `c.label = 0x0` — the NULL pointer that caused the crash. The recursion is visible: `inner` called itself three times (depth 3→2→1→0).

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 340" role="img" aria-label="Stack frame walk from main to the crash site in inner">
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#0f766e"/>
    </marker>
  </defs>
  <style>
    .frame { fill: none; stroke: currentColor; stroke-width: 1.5; }
    .frame-crash { fill: rgba(15,118,110,0.08); stroke: #0f766e; stroke-width: 2; }
    .label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: currentColor; }
    .small { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; fill: currentColor; opacity: 0.7; }
    .crash-label { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; fill: #0f766e; font-weight: bold; }
    .arrow { stroke: #0f766e; stroke-width: 1.5; fill: none; marker-end: url(#arr); }
  </style>
  <!-- Frame boxes -->
  <rect class="frame" x="40" y="10" width="260" height="44" rx="4"/>
  <rect class="frame" x="40" y="62" width="260" height="44" rx="4"/>
  <rect class="frame" x="40" y="114" width="260" height="44" rx="4"/>
  <rect class="frame" x="40" y="166" width="260" height="44" rx="4"/>
  <rect class="frame" x="40" y="218" width="260" height="44" rx="4"/>
  <rect class="frame-crash" x="40" y="270" width="260" height="44" rx="4"/>
  <!-- Frame labels -->
  <text class="label" x="55" y="30">#5 main()</text>
  <text class="small" x="55" y="47">c.label = 0x0</text>
  <text class="label" x="55" y="82">#4 outer(cfg)</text>
  <text class="small" x="55" y="99">cfg = 0x7fffffffcf80</text>
  <text class="label" x="55" y="134">#3 inner(cfg, depth=3)</text>
  <text class="small" x="55" y="151">cfg = 0x7fffffffcf80</text>
  <text class="label" x="55" y="186">#2 inner(cfg, depth=2)</text>
  <text class="small" x="55" y="203">cfg = 0x7fffffffcf80</text>
  <text class="label" x="55" y="238">#1 inner(cfg, depth=1)</text>
  <text class="small" x="55" y="255">cfg = 0x7fffffffcf80</text>
  <text class="label" x="55" y="290">#0 inner(cfg, depth=0)</text>
  <text class="crash-label" x="320" y="298">SIGSEGV</text>
  <!-- Arrows -->
  <path class="arrow" d="M300,32 L320,32 L320,72 L305,72"/>
  <path class="arrow" d="M300,84 L320,84 L320,124 L305,124"/>
  <path class="arrow" d="M300,136 L320,136 L320,176 L305,176"/>
  <path class="arrow" d="M300,188 L320,188 L320,228 L305,228"/>
  <path class="arrow" d="M300,240 L320,240 L320,280 L305,280"/>
  <!-- Crash indicator -->
  <circle cx="312" cy="293" r="4" fill="#0f766e"/>
</svg>
<figcaption>Stack frame walk: the call chain from <code>main</code> → <code>outer</code> → <code>inner</code> (depth 3→2→1→0), ending at the SIGSEGV in frame #0. Each frame holds its own copy of <code>cfg</code> and <code>depth</code>.</figcaption>
</figure>

## Navigating frames and inspecting state

Use `frame N` to move up and down the call stack, then inspect variables in that frame's scope:

```gdb
$ gdb -batch -ex 'break inner' -ex 'run' -ex 'bt' \
       -ex 'frame 1' -ex 'print cfg' -ex 'info locals' \
       -ex 'up' -ex 'print c' -ex 'info locals' \
       -ex 'down' -ex 'print depth' ./segfault_O0
Breakpoint 1, inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:11
#0  inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:11
#1  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
#2  0x00005555555551f5 in main () at segfault.c:28
#1  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
19      inner(cfg, 3);
$1 = (struct config *) 0x7fffffffcf80
No locals.
#2  0x00005555555551f5 in main () at segfault.c:28
28      outer(&c);
$2 = {name = "worker-7", '\000' <repeats 23 times>, count = 42, label = 0x0}
c = {name = "worker-7", '\000' <repeats 23 times>, count = 42, label = 0x0}
#1  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
19      inner(cfg, 3);
No symbol "depth" in current context.
```

`frame 1` moved to `outer` (which has `cfg` but not `depth`). `up` moved to `main` (which has `c`). `down` went back to `outer`. Each frame sees only its own variables.

## Examining memory with `x`

The `x` command examines raw memory. The syntax is `x/NFS addr` where N=count, F=format (x=hex, d=decimal, s=string), S=size (b=byte, h=halfword, w=word, g=giant):

```gdb
$ gdb -batch -ex 'break watch_demo.c:10' -ex 'run' \
       -ex 'x/5dw arr' -ex 'x/4x &arr' -ex 'x/1xw &sum' \
       -ex 'print &arr[0]' -ex 'print sizeof(arr)' ./watch_demo
Breakpoint 1, main () at watch_demo.c:10
10      return 0;
0x7fffffffcfa0: 10      20      30      40
0x7fffffffcfb0: 50
0x7fffffffcfa0: 0x0000000a     0x00000014     0x0000001e     0x00000028
0x7fffffffcf98: 0x00000096
$1 = (int *) 0x7fffffffcfa0
$2 = 20
```

`x/5dw arr` shows 5 decimal words starting at `arr` — the array contents `{10, 20, 30, 40, 50}`. `x/4x &arr` shows the same memory in hex. `x/1xw &sum` shows the value `0x96` (150 in decimal) stored at `sum`.

## Watching variables change

A **watchpoint** pauses execution whenever a variable's value changes:

```gdb
$ gdb -batch -ex 'break watch_demo.c:7' -ex 'run' \
       -ex 'watch sum' -ex 'continue' -ex 'print sum' \
       -ex 'continue' -ex 'print sum' -ex 'continue' -ex 'print sum' \
       ./watch_demo
Breakpoint 1, main () at watch_demo.c:7
7       sum += arr[i];
Hardware watchpoint 2: sum
Old value = 0
New value = 10
main () at watch_demo.c:6
$1 = 10
Old value = 10
New value = 30
main () at watch_demo.c:6
$2 = 30
```

The watchpoint fired every time `sum` changed, showing the old and new values. This is invaluable for tracking down where a variable gets corrupted.

## Step vs next vs finish

- `step` (or `s`) — executes one line, **entering** function calls
- `next` (or `n`) — executes one line, **skipping over** function calls
- `finish` — runs until the current function returns

```gdb
$ gdb -batch -ex 'break opt_story2.c:13' -ex 'run' \
       -ex 'step' -ex 'step' -ex 'print total' \
       -ex 'next' -ex 'print total' -ex 'next' -ex 'print total' ./opt2_O0
Breakpoint 1, main () at opt_story2.c:13
13      for (int i = 1; i <= 5; i++) {
14          total += compute(i);
compute (x=1) at opt_story2.c:5
5       int a = x * 3;
No symbol "total" in current context.
6       int b = a + 7;
No symbol "total" in current context.
```

The first `step` entered `compute` (now `total` is out of scope). The second `step` moved to line 6 inside `compute`. `next` would have skipped over the function call entirely.

## Conditional breakpoints and catch

A **conditional breakpoint** only pauses when a condition is true. Here's a program that processes an array with some negative values:

```c
int process(int n) {
    if (n < 0) return -1;
    return n * 2;
}
```

```gdb
$ gdb -batch -ex 'break cond_demo.c:6 if n < 0' -ex 'run' \
       -ex 'print n' -ex 'bt' -ex 'continue' -ex 'print n' -ex 'bt' \
       ./cond_demo
Breakpoint 1, process (n=-2) at cond_demo.c:6
6   }
$1 = -2
#0  process (n=-2) at cond_demo.c:6
#1  0x00005555555551ce in main () at cond_demo.c:12
Breakpoint 1, process (n=-5) at cond_demo.c:6
6   }
$2 = -5
#0  process (n=-5) at cond_demo.c:6
#1  0x00005555555551ce in main () at cond_demo.c:12
```

The breakpoint only fired for `n=-2` and `n=-5` — the two negative values. Without the condition, it would have stopped six times.

`catch` is even more powerful — it pauses when a specific event occurs, like a signal:

```gdb
$ gdb -batch -ex 'catch signal SIGSEGV' -ex 'run' -ex 'bt' ./segfault_O0
Catchpoint 1 (signal SIGSEGV)
Catchpoint 1 (signal SIGSEGV), inner (cfg=0x7fffffffcf80, depth=0) at segfault.c:15
15      cfg->label[0] = 'X';
#0  inner (cfg=0x7fffffffcf80, depth=0) at segfault.c:15
#1  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=1) at segfault.c:12
#2  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=2) at segfault.c:12
#3  0x0000555555555172 in inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:12
#4  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
#5  0x00005555555551f5 in main () at segfault.c:28
```

`catch signal SIGSEGV` caught the segfault the moment it happened, without needing a breakpoint at the crash site.

## Core dumps: debugging after the fact

A **core dump** is a snapshot of a process's memory at the moment it crashed. You can debug it later — even on a different machine — without the original program running.

On modern Linux with systemd, core dumps are managed by `coredumpctl`:

```bash
$ coredumpctl list | grep segfault_O0
Wed 2026-10-14 17:39:47 CST 1489116 1000 1000 SIGSEGV present  /tmp/opencode/work/gdb/segfault_O0  21.2K

$ coredumpctl dump -o core.segfault_O0
$ gdb -batch -ex 'bt' -ex 'print cfg' -ex 'print depth' ./segfault_O0 core.segfault_O0
Core was generated by `./segfault_O0'.
Program terminated with signal SIGSEGV, Segmentation fault.
#0  inner (cfg=0x7ffdcada4870, depth=0) at segfault.c:15
15      cfg->label[0] = 'X';
#0  inner (cfg=0x7ffdcada4870, depth=0) at segfault.c:15
#1  0x000056008f7b5172 in inner (cfg=0x7ffdcada4870, depth=1) at segfault.c:12
#2  0x000056008f7b5172 in inner (cfg=0x7ffdcada4870, depth=2) at segfault.c:12
#3  0x000056008f7b5172 in inner (cfg=0x7ffdcada4870, depth=3) at segfault.c:12
#4  0x000056008f7b519d in outer (cfg=0x7ffdcada4870) at segfault.c:19
#5  0x000056008f7b51f5 in main () at segfault.c:28
$1 = (struct config *) 0x7ffdcada4870
$2 = 0
```

The backtrace is identical to the live session. You can inspect variables, examine memory, and navigate frames — all from a core file, after the process has exited.

## Debugging multi-threaded crashes

When a multi-threaded program crashes, you need to see what *every* thread was doing. `thread apply all bt` does exactly that:

```gdb
$ gdb -batch -ex 'run' -ex 'bt' -ex 'thread apply all bt 4' -ex 'info threads' ./threads
Thread 4 "threads" received signal SIGSEGV, Segmentation fault.
0x00005555555551b1 in worker (arg=0x2) at threads.c:15
15      *p = 42;
#0  0x00005555555551b1 in worker (arg=0x2) at threads.c:15
#1  0x00007ffff7c98042 in ?? () from /usr/lib/libc.so.6
#2  0x00007ffff7d2072c in ?? () from /usr/lib/libc.so.6

Thread 4 (Thread 0x7ffff6bfd6c0 (LWP 1489984) "threads"):
#0  0x00005555555551b1 in worker (arg=0x2) at threads.c:15
#1  0x00007ffff7c98042 in ?? () from /usr/lib/libc.so.6
#2  0x00007ffff7d2072c in ?? () from /usr/lib/libc.so.6

Thread 1 (Thread 0x7ffff7f82740 (LWP 1489977) "threads"):
#0  0x00007ffff7d2071d in ?? () from /usr/lib/libc.so.6
#1  0x00007ffff7d205d1 in ?? () from /usr/lib/libc.so.6
#2  0x00007ffff7d20648 in ?? () from /usr/lib/libc.so.6
#3  0x00007ffff7c97bc6 in ?? () from /usr/lib/libc.so.6
  Id   Target Id                                     Frame
  1    Thread 0x7ffff7f82740 (LWP 1489977) "threads" 0x00007ffff7d2071d in ?? () from /usr/lib/libc.so.6
* 4    Thread 0x7ffff6bfd6c0 (LWP 1489984) "threads" 0x00005555555551b1 in worker (arg=0x2) at threads.c:15
```

Thread 4 crashed (it's the one that dereferences NULL). Thread 1 (main) was waiting in `pthread_join`. The `*` marks the current thread. `info threads` shows all threads and their current state.

## The -O0 vs -O2 story

This is the classic "works in debug, breaks in release" scenario. At `-O2`, the compiler inlines functions, reorders instructions, and eliminates variables. gdb can't show you what doesn't exist:

```gdb
$ gdb -batch -ex 'break compute' -ex 'run' -ex 'next' -ex 'print a' \
       -ex 'next' -ex 'print b' -ex 'next' -ex 'print c' ./opt2_O0
Breakpoint 1, compute (x=1) at opt_story2.c:5
5       int a = x * 3;
6       int b = a + 7;
$1 = 3
7       int c = b ^ 0x55;
$2 = 10
8       return c;
$3 = 95
```

At `-O0`, stepping through `compute` shows `a=3`, `b=10`, `c=95` — every intermediate value. Now the same script at `-O2`:

```gdb
$ gdb -batch -ex 'break compute' -ex 'run' -ex 'next' -ex 'print a' \
       -ex 'next' -ex 'print b' -ex 'next' -ex 'print c' ./opt2_O2
Breakpoint 1, compute (x=x@entry=1) at opt_story2.c:8
8       return c;
main () at opt_story2.c:13
13      for (int i = 1; i <= 5; i++) {
No symbol "a" in current context.
14          total += compute(i);
No symbol "b" in current context.
```

At `-O2`, the breakpoint resolved to line 8 (the `return` statement) because the compiler inlined the function body. Variables `a` and `b` were optimized out — they never existed in the final binary. The `x=x@entry=1` notation shows the entry value of `x` before optimization.

**The rule**: debug at `-O0` first. If the bug only appears at `-O2`, use `-O2 -g` and accept that some variables will be missing. You can also use `-Og` (optimize for debugging) as a middle ground.

## gdb TUI and front-ends

gdb has a built-in terminal UI that shows source, assembly, and registers in split panes:

```bash
gdb -tui ./segfault_O0
```

Inside the TUI, `Ctrl-X A` toggles the TUI layout, `Ctrl-X 1` shows source + command, `Ctrl-X 2` shows source + assembly. The layout updates automatically as you step.

Popular front-ends include **gdb-dashboard** (a Python plugin that shows a rich status panel), **cgdb** (a curses-based wrapper), and IDE integrations (VS Code, CLion, Eclipse). They all drive the same gdb underneath — the commands in this article work everywhere.

## A practical gdb checklist

When a C crash lands on your desk:

1. **Compile with `-g`** — always. Even in production, you can strip symbols later and keep a separate debug binary.
2. **Reproduce under gdb** — `gdb ./prog`, then `run`. If it crashes, `bt full` immediately.
3. **Read the backtrace** — find the crash frame, then `frame N` to move up the stack and inspect variables at each level.
4. **Use `print` and `x`** — `print` for variables, `x` for raw memory. `x/16x $rsp` shows the stack.
5. **Set conditional breakpoints** — `break file.c:42 if ptr != NULL` to catch the exact iteration that goes wrong.
6. **Watch variables** — `watch my_var` pauses every time it changes, showing old → new.
7. **Catch signals** — `catch signal SIGSEGV` catches crashes without knowing where they'll happen.
8. **Check all threads** — `thread apply all bt` in multi-threaded programs.
9. **Get a core dump** — `coredumpctl dump` on systemd, or `ulimit -c unlimited` + configure `core_pattern`. Debug the core later.
10. **Debug at -O0 first** — if the bug is optimization-dependent, use `-O2 -g` and expect missing variables.

gdb has a steep learning curve, but the core workflow — break, run, backtrace, print — covers 90% of debugging sessions. Master those four commands and you'll spend less time guessing and more time fixing.
