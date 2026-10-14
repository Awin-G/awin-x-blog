---
title: "gdb 实战：调试 C 程序崩溃，而不是用 printf 猜"
description: "gdb 实战指南：backtrace、core dump、条件断点、watchpoint、多线程调试，以及 -O0 与 -O2 的故事——全部来自真实程序的真实输出。"
pubDate: 2027-02-14
lang: zh
translationKey: gdb-in-practice
tags: [c, linux]
featured: false
keywords:
  - gdb
  - 调试 C 崩溃
  - backtrace
  - core dump
  - 断点
---

当 C 程序崩溃时，本能反应是到处撒 `printf` 然后重新编译。这对简单 bug 有用，但一旦你需要在崩溃*之后*检查状态、调试 core dump，或者理解多线程程序中的竞态，它就无能为力了。这时候 **gdb**（GNU 调试器）就派上用场了。

我之前已经写过 [用 strace 调试](/zh/posts/debugging-with-strace/) 和 [C 指针算术与未定义行为](/zh/posts/c-pointer-arithmetic-and-ub/)。这篇文章讲的是把这一切串联起来的工具：gdb。下面每一条命令和输出块都来自我编译并运行的真实程序。

## 为什么 gdb 胜过 printf

`printf` 调试有三个根本局限：

1. **每次想检查新变量都必须重新编译。**
2. **崩溃后无法检查状态**——进程已经消失了。
3. **无法暂停执行**来在特定点检查内存、寄存器或调用栈。

gdb 解决了这三个问题。它可以附加到运行中的进程（或通过 core dump 附加到已死亡的进程），让你设置断点，检查完整的程序状态——全程无需重新编译。

## 准备工作：用 `-g` 编译

`-g` 标志告诉编译器将调试信息（符号表、行号、变量类型）嵌入二进制文件。没有它，gdb 只会给你看汇编代码而不是 C 代码。

```bash
gcc -g -O0 -o segfault_O0 segfault.c
gcc -g -O2 -o segfault_O2 segfault.c
```

大部分示例我会用 `-O0`（无优化），后面会展示 `-O2` 有什么不同。

## 基本工作流：断点、运行、检查

下面是我要调试的程序——一个递归函数解引用空指针：

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
    cfg->label[0] = 'X';   // 崩溃：cfg->label 是 NULL
}

void outer(struct config *cfg) {
    inner(cfg, 3);
}

int main(void) {
    struct config c;
    memset(&c, 0, sizeof c);
    strcpy(c.name, "worker-7");
    c.count = 42;
    /* 忘了：c.label 保持为 NULL */
    outer(&c);
    return 0;
}
```

经典的 gdb 会话——设置断点、运行、单步、检查：

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

注意发生了什么：我在 `main` 设了断点，运行程序，用 `next` 单步两步，打印了结构体 `c`（全是零——`label` 是 NULL），然后继续。程序崩溃了，gdb 捕获了 SIGSEGV，准确告诉我崩溃位置。

## 读 segfault 的 backtrace

崩溃后最重要的命令是 `bt`（backtrace）。它显示调用栈——导致崩溃的函数调用链：

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

`bt full` 显示每一帧的局部变量。帧 #0 是崩溃点（`inner` 在 depth=0）。帧 #5 是 `main`，你能看到 `c.label = 0x0`——导致崩溃的空指针。递归清晰可见：`inner` 调用了自己三次（depth 3→2→1→0）。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 340" role="img" aria-label="从 main 到 inner 崩溃点的栈帧走查">
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
<figcaption>栈帧走查：从 <code>main</code> → <code>outer</code> → <code>inner</code>（depth 3→2→1→0）的调用链，终止于帧 #0 的 SIGSEGV。每帧持有自己的 <code>cfg</code> 和 <code>depth</code> 副本。</figcaption>
</figure>

## 导航帧和检查状态

用 `frame N` 在调用栈中上下移动，然后检查该帧作用域内的变量：

```gdb
$ gdb -batch -ex 'break inner' -ex 'run' -ex 'bt' \
       -ex 'frame 1' -ex 'print cfg' -ex 'info locals' \
       -ex 'up' -ex 'print c' -ex 'info locals' \
       -ex 'down' -ex 'print depth' ./segfault_O0
Breakpoint 1, inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:11
#0  inner (cfg=0x7fffffffcf80, depth=3) at segfault.c:11
#1  0x000055555555519d in outer (cfg=0x7fffffffcf80) at segfault.c:19
#2  0x000055555555511f5 in main () at segfault.c:28
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

`frame 1` 移到了 `outer`（有 `cfg` 但没有 `depth`）。`up` 移到了 `main`（有 `c`）。`down` 回到了 `outer`。每个帧只能看到自己的变量。

## 用 `x` 检查内存

`x` 命令检查原始内存。语法是 `x/NFS addr`，其中 N=数量，F=格式（x=十六进制，d=十进制，s=字符串），S=大小（b=字节，h=半字，w=字，g=巨字）：

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

`x/5dw arr` 显示从 `arr` 开始的 5 个十进制字——数组内容 `{10, 20, 30, 40, 50}`。`x/4x &arr` 以十六进制显示相同内存。`x/1xw &sum` 显示 `sum` 地址存放的值 `0x96`（十进制 150）。

## 观察变量变化

**watchpoint**（观察点）在变量值改变时暂停执行：

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

watchpoint 在 `sum` 每次变化时触发，显示旧值和新值。这对追踪变量在哪里被破坏非常有用。

## step vs next vs finish

- `step`（或 `s`）——执行一行，**进入**函数调用
- `next`（或 `n`）——执行一行，**跳过**函数调用
- `finish`——运行直到当前函数返回

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

第一个 `step` 进入了 `compute`（现在 `total` 超出作用域了）。第二个 `step` 移到了 `compute` 内的第 6 行。`next` 会完全跳过函数调用。

## 条件断点与 catch

**条件断点**只在条件为真时才暂停。下面是一个处理包含负值的数组的程序：

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

断点只在 `n=-2` 和 `n=-5` 时触发——两个负值。如果没有条件，它会停六次。

`catch` 更强大——它在特定事件发生时暂停，比如信号：

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

`catch signal SIGSEGV` 在 segfault 发生的那一刻就捕获了它，不需要在崩溃点设断点。

## Core dump：事后调试

**Core dump** 是进程崩溃时刻的内存快照。你可以稍后调试它——甚至在另一台机器上——不需要原始程序在运行。

在带 systemd 的现代 Linux 上，core dump 由 `coredumpctl` 管理：

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

backtrace 与会话中完全一致。你可以检查变量、检查内存、导航帧——全部来自 core 文件，在进程退出之后。

## 调试多线程崩溃

当多线程程序崩溃时，你需要看到*每个*线程在做什么。`thread apply all bt` 正是做这件事的：

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

线程 4 崩溃了（就是解引用 NULL 的那个）。线程 1（main）在 `pthread_join` 中等待。`*` 标记当前线程。`info threads` 显示所有线程及其当前状态。

## -O0 vs -O2 的故事

这是经典的"调试版本正常，发布版本崩溃"的场景。在 `-O2` 下，编译器内联函数、重排指令、消除变量。gdb 无法显示不存在的东西：

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

在 `-O0` 下，单步执行 `compute` 显示 `a=3`、`b=10`、`c=95`——每个中间值。现在同样的脚本在 `-O2` 下：

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

在 `-O2` 下，断点解析到第 8 行（`return` 语句），因为编译器内联了函数体。变量 `a` 和 `b` 被优化掉了——它们在最终二进制中从未存在。`x=x@entry=1` 表示法显示 `x` 在优化前的入口值。

**规则**：先在 `-O0` 下调试。如果 bug 只在 `-O2` 下出现，使用 `-O2 -g` 并接受某些变量会缺失。你也可以用 `-Og`（为调试优化）作为折中。

## gdb TUI 和前端

gdb 内置终端 UI，在分屏窗格中显示源代码、汇编和寄存器：

```bash
gdb -tui ./segfault_O0
```

在 TUI 中，`Ctrl-X A` 切换 TUI 布局，`Ctrl-X 1` 显示源代码 + 命令，`Ctrl-X 2` 显示源代码 + 汇编。布局在你单步执行时自动更新。

流行的前端包括 **gdb-dashboard**（Python 插件，显示丰富的状态面板）、**cgdb**（基于 curses 的封装）和 IDE 集成（VS Code、CLion、Eclipse）。它们底层都驱动同一个 gdb——本文中的所有命令在任何地方都能用。

## 实用 gdb 清单

当 C 崩溃落到你桌上时：

1. **用 `-g` 编译**——永远如此。即使在生产环境，你也可以之后 strip 符号，保留单独的调试二进制。
2. **在 gdb 下复现**——`gdb ./prog`，然后 `run`。如果崩溃，立即 `bt full`。
3. **读 backtrace**——找到崩溃帧，然后 `frame N` 沿栈上移，在每一层检查变量。
4. **用 `print` 和 `x`**——`print` 检查变量，`x` 检查原始内存。`x/16x $rsp` 显示栈。
5. **设条件断点**——`break file.c:42 if ptr != NULL` 捕获出错的确切迭代。
6. **观察变量**——`watch my_var` 在它每次变化时暂停，显示旧值 → 新值。
7. **捕获信号**——`catch signal SIGSEGV` 无需知道崩溃位置就能捕获崩溃。
8. **检查所有线程**——多线程程序中用 `thread apply all bt`。
9. **获取 core dump**——systemd 上用 `coredumpctl dump`，或 `ulimit -c unlimited` + 配置 `core_pattern`。稍后调试 core。
10. **先在 -O0 下调试**——如果 bug 与优化相关，使用 `-O2 -g` 并预期变量缺失。

gdb 学习曲线陡峭，但核心工作流——断点、运行、backtrace、print——覆盖了 90% 的调试场景。掌握这四个命令，你会花更少时间猜测，更多时间修复。
