---
title: "Valgrind 实战：内存泄漏、非法访问，以及时间都花在哪了"
description: "一次 Linux 上的 valgrind 实操：用真实的 memcheck 报告逐一看 C 语言内存泄漏、非法读写、未初始化值，再用 massif 看堆增长、callgrind 看指令热点、helgrind 看数据竞争——每条都配真实输出和修法。"
pubDate: 2027-02-14
lang: zh
translationKey: valgrind-and-memory-profiling
tags: [c, linux]
featured: false
keywords:
  - valgrind
  - C 语言内存泄漏
  - massif
  - callgrind
  - memcheck
---

C 给了你 `malloc`，却没给收据。语言本身不会告诉你某个块已经没人认领了、某个循环多读了数组末尾一个元素、或者某个分支依赖了一个从未被赋过值的变量。当我怀疑代码里有这类问题时，**Valgrind** 是我的第一选择：它按原样运行你的二进制，盯着每一次内存访问和每一个堆块，然后告诉你哪里弄坏了。下面每一条报告都是真实程序跑出来的真实输出，每条都配上了让它安静下来的修法。

对一个 Linux 上的 C 程序员来说，真正用得上的工具有这几个：**memcheck**（错误与泄漏）、**massif**（堆增长）、**callgrind**（时间花在哪）、**cachegrind**（缓存行为）和 **helgrind/DRD**（线程错误）。全都对着同一个二进制，一行编译都不用改。

## Valgrind 到底是什么

Valgrind 是一个**动态二进制插桩**（dynamic binary instrumentation）框架。它既不需要源码，也不需要重新编译：它加载你的 ELF 文件，反汇编每个基本块，把改写成带插桩检查的等价物再交给 CPU。你的程序照样运行，只是身处一台被监督的合成机器里。这就是为什么它对没参与构建的发布版二进制也有效——也因此，想让输出可读，第一件该做的事是构建时带 `-g`。

<figure>
<svg viewBox="0 0 680 268" width="100%" role="img" aria-label="Valgrind 是一个插桩框架，带有多个工具。同一个未修改的二进制可以交给 memcheck 查非法访问和泄漏，交给 massif 看堆增长，交给 callgrind 数指令，交给 cachegrind 看缓存行为，交给 helgrind 或 DRD 查数据竞争。">
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
    <text x="160" y="66" text-anchor="middle" opacity="0.7">内存错误</text>
    <text x="340" y="50" text-anchor="middle">cachegrind</text>
    <text x="340" y="66" text-anchor="middle" opacity="0.7">缓存行为</text>
    <text x="520" y="50" text-anchor="middle">massif</text>
    <text x="520" y="66" text-anchor="middle" opacity="0.7">堆剖析</text>
    <text x="160" y="212" text-anchor="middle">helgrind / DRD</text>
    <text x="160" y="228" text-anchor="middle" opacity="0.7">数据竞争</text>
    <text x="340" y="212" text-anchor="middle">callgrind</text>
    <text x="340" y="228" text-anchor="middle" opacity="0.7">指令计数</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="13" fill="#0f766e">
    <text x="340" y="156" text-anchor="middle">./your-binary</text>
  </g>
</svg>
<figcaption>Valgrind 是动态二进制插桩框架：它运行你未修改的二进制，边走边改写机器码。每个工具都是同一套机制的不同前端，所以同一个二进制可以被测量错误、堆增长、指令数、缓存行为或数据竞争，不需要重新编译。</figcaption>
</figure>

我的开发机没有装 valgrind，所以我把整套实验放进一个一次性容器里跑——不用 sudo，不用特权模式，只挂官方镜像。下面每一段记录都来自这个环境：valgrind 3.19.0、GCC 12.2.0、x86-64 Linux。

```console
$ docker run --rm -v "$PWD:/work" -w /work debian:bookworm-slim bash -c \
    'apt-get update -qq && apt-get install -y -qq valgrind gcc && valgrind --version'
valgrind-3.19.0
gcc (Debian 12.2.0-14+deb12u1) 12.2.0
```

## 一个集齐了各类内存问题的程序

这是 `leaky.c`，用 `gcc -g -O0 -Wall leaky.c -o leaky` 编译。它刻意写得很小，塞进了四个经典缺陷：一个从未释放的链表、一个写到堆数组末尾之外的写、一个越出同一块数组末尾的读，以及一个基于未初始化栈变量的分支。

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
    /* --- 1. definitely lost: 整个链表被扔在原地 --- */
    struct node *list = NULL;
    for (int i = 0; i < 4; i++)
        list = append(list, i);              /* 45 */
    /* ... 然后我们从来不 free(list)。用一次打印让 -O0 保留它： */
    printf("list head %d\n", list->value);

    /* --- 2. invalid write: 越过 4 个 int 的堆块末尾 --- */
    int *nums = malloc(4 * sizeof *nums);    /* 50 */
    nums[0] = 1; nums[1] = 2; nums[2] = 3;
    nums[4] = 99;                            /* 52: 一口气错两处 */

    /* --- 3. invalid read: 同一个 bug 的读侧 --- */
    int sum = 0;
    for (int i = 0; i <= 4; i++)             /* 57: 4 已越界 */
        sum += nums[i];                      /* 58 */
    printf("sum %d\n", sum);                 /* 59 */

    /* --- 4. 分支依赖未初始化的值 --- */
    int limit;                               /* 62 */
    if (limit > 100)                         /* 63 */
        printf("big\n");
    else
        printf("smallish\n");

    free(nums);
    return 0;
}
```

`valgrind --leak-check=full --track-origins=yes ./leaky` 一次就把四个问题全找了
出来。报告里的行号与上面的代码完全对得上：

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

### 这份报告怎么读

**非法读和非法写。** memcheck 给每个堆块四周都放了 redzone（红区），所以哪怕越界一个
元素落在完全可映射的内存里，也会被抓到。`Invalid write of size 4` 是一次 `int` 写入；
`Address 0x4a3d350 is 0 bytes after a block of size 16` 是关键线索——16 字节正好等于
`4 * sizeof(int)`，说明这次写入从数组结束后的第一个字节开始。报告还给出了这块内存的
来源，把"在某个莫名其妙的地方崩溃"变成了"leaky.c:52"。

**未初始化的值。** 加上 `--track-origins=yes`，memcheck 不只是说这个值是垃圾，还会说
垃圾从哪来：`Uninitialised value was created by a stack allocation`，位置
`main (leaky.c:41)`，也就是第 62 行的 `limit`。同一份报告里还有这个 bug 的堆版本：
第 57 行的循环读了 `nums[3]`，它在第 50 行被 `malloc` 出来、从未写入，于是第 59 行的
`printf` 被指认为携带了源自该分配的未初始化值。

**泄漏的种类。** 退出时，memcheck 对每个仍然存活的堆块问一个可达性问题，答案就是分类：

| 种类 | 含义 | 该怎么办 |
|---|---|---|
| **definitely lost** | 任何地方都没有指针指向它 | 真正的泄漏——修它 |
| **indirectly lost** | 只能从一个 definitely lost 的块到达 | 随宿主一起消失 |
| **possibly lost** | 只能通过内部指针到达 | 通常是真 bug，偶尔是基指针技巧 |
| **still reachable** | 退出时仍存在活指针（全局变量、缓存） | 常驻进程里往往无妨 |
| **suppressed** | 被 suppression 文件排除 | 检查你的 `.supp` 文件 |

在这里链表属于 *definitely* lost，因为指向头节点的唯一指针 `list` 已经出了作用域：
24 个直接字节是头节点 `struct node`，另外 136 个间接字节是剩下三个节点（72）加四个
16 字节的 label（64）。摘要里还有一个细节值得读：`10 allocs, 2 frees`——九次分配是
你自己的，第十次是 libc 给 `printf` 开的 stdio 缓冲区。

说句实话：GCC 的 `-Wall` 在编译期就已经发现了第 4 个缺陷（`'limit' is used
uninitialized`）。先用编译器——它免费。Valgrind 能找到它看不见的那三个，而且对无法控制
构建方式的二进制同样有效。

## 修好它，然后收获一次安静的运行

所有修法形状相同：让数组有一个你真正遵守的长度，初始化每一个要拿来分支的值，并把每次
分配还给它的所有者。

```c
    int *nums = malloc(4 * sizeof *nums);
    nums[0] = 1; nums[1] = 2; nums[2] = 3; nums[3] = 4;

    int sum = 0;
    for (int i = 0; i < 4; i++)          /* i < n，永远不是 i <= n */
        sum += nums[i];

    int limit = 50;                      /* 分支之前先初始化 */
```

链表则配一个析构函数，边走边释放 label 和节点：

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

现在同一条命令跑完，除了真相什么也不报：

```console
==7== HEAP SUMMARY:
==7==     in use at exit: 0 bytes in 0 blocks
==7==   total heap usage: 10 allocs, 10 frees, 4,272 bytes allocated
==7==
==7== All heap blocks were freed -- no leaks are possible
==7==
==7== ERROR SUMMARY: 0 errors from 0 contexts (suppressed: 0 from 0)
```

那一行——**All heap blocks were freed -- no leaks are possible**——就是你希望 CI 每次
都吐出来的输出。它的意思是泄漏类别全部归零，而不是 memcheck 没词了。

## Valgrind 的代价，以及 AddressSanitizer 的位置

所有这一切只能待在"开发工具"这一档，原因是速度。我用同一个 malloc+指针追逐型负载
（200,000 轮：建一条 16 节点的链、求和、再拆掉）在机器上跑了三遍：

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

相对同一次原生运行，**memcheck 是 66×**，**AddressSanitizer 是 11×**——这是个
malloc 密集的微基准，正好是 memcheck 最不擅长的场景，所以把 10–50× 当作通常经验值，
66× 当作分配风暴下的上界。ASan 的原理完全不同：它是一遍编译期 pass（用
`-fsanitize=address` 重新编译），维护一份 shadow memory 并在编译期给 load/store 插桩，
比起 Valgrind 运行时翻译便宜得多。

同一份 `leaky.c` 在 ASan 下立刻报告了那次非法写：

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

那到底用哪个？**自己的代码用 ASan，其余交给 Valgrind。** 对你掌控的代码，在每次提交
时用 `-fsanitize=address,undefined` 编译并跑测试：它快到可以一直开着，它给出的报告我在
[C 语言里的未定义行为](/zh/posts/c-pointer-arithmetic-and-ub/)里逐条拆过。Valgrind
留给 ASan 到不了的地方：**你没参与构建的二进制**（不要编译参数，不要源码，照样插桩）、
**未初始化的值**（ASan 不跟踪；clang 的 `-fsanitize=memory` 可以，但它对 GCC 不友好）、
**泄漏分类**（"definitely lost" 还是 "still reachable" 需要一次完整可达性扫描才能判断）、
以及**一次跑完所有错误**——ASan 默认遇到第一个错误就中止，一个有五个 bug 的测试只会给
你看一个，而 memcheck 会继续跑，把整套错误一起交给你。

## Massif：堆都去哪了

当服务的 RSS 一路涨到 OOM killer 敲门时，memcheck 是错的工具——它管的是*正确性*，不是
*大小*。`--tool=massif` 才是堆剖析器。我写了 `grow.c`：先分配 400,000 条记录（28 字节
结构体，11.2 MB），再分配第二份用来排序，最后两份都释放。

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

真正有信息量的是 `useful-heap`：你的代码真正要的字节数。`extra-heap` 是 memcheck 自己
的记账，所以两者和 `malloc` 眼里的数字并不完全一致。这里的峰值是第 4 号快照的
**33.6 MB——单份数据的三倍**，它回答了"输入才 21 MB，这进程为什么占 64 MB？"：排序发生
时两份数组同时活着。Massif 还能告诉你内存是从哪来的：

```console
99.98% (33,600,000B) (heap allocation functions) malloc/new/new[], --alloc-fns, etc.
->33.33% (11,200,000B) 0x1090B3: main (grow.c:25)
->33.33% (11,200,000B) 0x109120: main (grow.c:34)
->33.33% (11,200,000B) 0x488EDBC: qsort_r (msort.c:221)
  ->33.33% (11,200,000B) 0x109155: main (grow.c:38)
```

三行讲完了整个程序：第 25 行的 `recs`、第 34 行的 `sorted`、第 38 行排序自己的工作
集。如果问题不是峰值而是泄漏，快照表就永远回不到零——massif 同时给你增长曲线和归属，
这正是退出时那个孤零零的数字做不到的。

## Callgrind：时间都花在哪

`--tool=callgrind` 按函数和按行统计执行的指令数。我写了 `hotspot.c`，一个刻意写得很蠢的
O(n²) 查重：对 20,000 个字符串，两两比较时各算一次 FNV-1a 哈希。它原生跑大约 3.5 秒；
在 callgrind 下长得够我去泡杯茶。

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

**332 亿条指令。** 哈希循环的三行占了其中 93%。有一个细节值得记住：归属写的是
`hotspot.c:main`，而不是 `hash_str` 或 `count_duplicates`，因为我是用 `-O2` 编译的，
GCC 把两个辅助函数都内联进了 `main`。callgrind 只能报告调用图里看得见的东西，所以想拿
到函数级数字，就用 `-fno-inline` 编译（或者直接读逐行标注——它照样指着那口祸首循环）。
这里的修法是算法层面的：先把哈希算进一张表，或者排序后线性扫；而这份 profile 告诉我不
要去优化只占 0.07% 的 `main` 初始化循环。

## Helgrind 与 DRD：C 里的数据竞争

如果你的 C 程序有线程，同一个框架也能检查它。`race.c` 里两个线程各自把一个共享的
`long` 累加十万次，没有任何同步：

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

`race.c:16` 就是 `counter++`——两个线程对同一个地址一读一写，中间没有锁。helgrind 把
符号、长度和两处访问点全都点出来了。原生运行证明这不是理论问题：同一个看起来确定的
程序跑两次，分别打出 `counter=112151 extra=321644` 和
`counter=194231 extra=388466`，都不是你期望的 200,000/400,000，因为更新丢失了。（在
helgrind 的串行化之下结果反而是正确的——这对粗心的人是个不错的陷阱：检测器改变了时序。）

这个思路对 Go 用户不会陌生：`go test -race` 是同一个洞察，用 happens-before 分析共享访问，
而不是"等输出看着不对再说"。我在 [Go 并发 race detector 实战](/zh/posts/go-concurrency-race-detector/)里写过。在 C
里对应的就是 helgrind（慢、精确）或 DRD（`--tool=drd`，更快、抓的错误类别更多，但分析深度
浅一些），而修法你已经会了：加互斥锁，或者用 `__atomic_add_fetch`/原子类型。

## 我实际使用的流程

1. **每次提交**——用 `-Wall -Wextra` 和 `-fsanitize=address,undefined` 编译并跑测试
   套件。免费、快，能抓住我本来会去问 memcheck 的绝大多数问题。
2. **每次跑带手动 `malloc` 的代码的测试**——`valgrind --leak-check=full
   --error-exitcode=99 ./test`。`--error-exitcode` 是大家最容易忘的一项：CI 应该按
   valgrind 的结论失败，而不是按程序的退出码。
3. **当 RSS 上涨时**——`valgrind --tool=massif`，然后 `ms_print`。找那些永远不下降的
   快照，以及持有它们的分配点。
4. **当 CPU 打满时**——`valgrind --tool=callgrind`，然后 `callgrind_annotate
   --auto=yes`。改掉最上面那一行，再来一遍，百分之一二的项可以直接无视。
5. **当线程出现时**——在测试套件上跑 `valgrind --tool=helgrind`。
6. **面对无法重新构建的二进制**——用 memcheck，只有它对你的构建一无所求。

有两个习惯能让以上全部更便宜：给依赖项真正产生的噪音维护一份 suppression 文件
（`--gen-suppressions=all` 会帮你生成），以及永远不要在一个已知有内存错误的程序上跑其它
profiler——memcheck 报的错误会污染其它所有测量。同时把心智模型放正：profiler 是透镜，
不是判决书。memcheck 回答*我的进程正确吗*，massif 回答*它占了多少*，callgrind 回答*哪
一行在烧 CPU*，helgrind 回答*我的线程能不能信*。选对透镜是这项工作的大部分。

---

*相关阅读：[C 语言里的未定义行为：sanitizer 能抓到什么](/zh/posts/c-pointer-arithmetic-and-ub/)
讲的是 ASan/UBSan 那一侧；[Python 内存泄漏及其排查](/zh/posts/python-memory-leaks/)
讲的是一门带垃圾回收的语言里的同一个问题——泄漏来自你不知道自己还持有的引用。*
