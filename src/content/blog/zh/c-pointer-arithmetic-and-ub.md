---
title: "C 语言里的未定义行为：sanitizer 能抓到什么，以及它为什么重要"
description: "一次关于 C 语言未定义行为的实操：用真实的 AddressSanitizer 与 UBSan 报告逐一看越界读、use-after-free、有符号溢出、非法移位、空指针解引用和严格别名，并给出对应的修法。"
pubDate: 2027-02-12
lang: zh
translationKey: c-pointer-arithmetic-and-ub
tags: [c]
featured: false
keywords:
  - 未定义行为 C
  - AddressSanitizer
  - UBSan
  - 数组越界
  - use-after-free
  - 严格别名
  - gcc 警告
---

我在 C 上耗过超过一天的 bug，形状全都一样：代码能编译、能链接、在我的机器上还跑出了正确结果——但它依然是错的。**C 语言的未定义行为**（undefined behaviour）不是一种"你会收到的报错"。它是标准颁发给编译器的一张许可证：*你可以假定这永远不会发生，并据此优化*。跨过这条线之后，C 标准就不再描述你的程序了；你接下来观察到的任何现象都是巧合。

这是一次实操记录，不是讲课。我在 x86-64 Linux 上用 GCC 16.2.1 写了一组小程序，分别用 `-fsanitize=address,undefined` 和 `-Wall -Wextra -Wpedantic` 编译，把真实报告原样贴出来。如果你正在试图读懂一份不熟悉的 C 代码库，[如何读一份别人写的代码库](/zh/posts/reading-a-codebase/)里那套由外向内的办法，比一行行硬啃更容易发现这类问题。

## "未定义"到底给编译器买了什么

需要关心的只有三类，而其中只有一类会崩：

- **实现定义（implementation-defined）**——实现必须选定一种行为并写明，比如 `sizeof(int)`。
- **未指明（unspecified）**——允许多种行为，但程序本身依然是良定义的。
- **未定义（undefined）**——标准*不施加任何要求*。`int i = INT_MAX; i + 1;`

危害来自第三类。因为 UB 被假定为不可能发生，优化器可以反向推理：*如果 `i + 1` 被算出来，而溢出是 UB，那么 `i` 就不是 `INT_MAX`*，于是这个分支就是死代码。这就是 `-O0` 和 `-O2` 可能给出不同答案的原因——`-O0` 并不是什么"参考实现"，它只是没那么积极地利用这张许可证。

| 家族 | 常见成因 | 能被谁抓到 |
|---|---|---|
| 数组越界访问 | off-by-one、`<=` 写成了 `<`、信了线上报来的长度 | ASan、`-Warray-bounds` |
| use-after-free / double-free | 所有者交出指针后忘了失效 | ASan、`-Wuse-after-free` |
| 有符号整数溢出 | 超时时间累加、`a + b > c` 式检查 | UBSan |
| 非法移位 | 移位次数取自协议字段、负数移位 | UBSan、`-Wshift-count-negative` |
| 空指针解引用 | 错误分支打印日志后忘了返回 | ASan（SEGV） |
| 严格别名违规 | `(int *)&some_long` | `-Wstrict-aliasing=2` |
| 未初始化读 | "回头再填"的缓冲区 | valgrind、clang `-fsanitize=memory` |
| 未对齐访问 | 把 `char *` 转成宽类型指针 | UBSan |

## 怎么抓住它们

主力就是两个编译选项：

```sh
gcc -O2 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -g -o prog prog.c
```

**AddressSanitizer**（ASan）把每次内存访问都拿去和一张影子内存比对，并在栈、堆、全局对象周围插入 redzone，所以两个方向的越界、use-after-free、double-free 都能抓到；又因为它装了 SEGV 处理器，空指针解引用也会给出报告，而不是干巴巴一句 `Segmentation fault`。**UBSan** 在运行时检查算术与对齐规则。两者可以编进同一个二进制，我在开发阶段就是这么用的。

`-Wall -Wextra -Wpedantic` 在程序运行之前就起作用，负责静态可证的那一部分：`-Warray-bounds`、`-Waggressive-loop-optimizations`（off-by-one 循环）、`-Wstringop-overflow`、`-Wuse-after-free`、`-Wshift-count-negative`。默认关掉但值得打开的还有两个：`-Wstrict-aliasing=2` 和 `-fanalyzer`。

**valgrind** 是第三条腿：不需要重新编译，而且能抓到 ASan 和 UBSan 抓不到的东西——尤其是未初始化读，因为 GCC 没有 `-fsanitize=memory`。我的容器里没装它，所以下面所有报告都来自 GCC 自带的 sanitizer。伪造的 valgrind 日志比没有日志更糟。

### 静态那一趟，一个文件全看见

告警根本不需要运行程序。三行马虎的 C，加上 `-Wall -Wextra -Wpedantic` 对它们的评价：

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

把 `strcpy` 单独拿出来跑一遍，GCC 会把区域大小直接点出来：

```text
warn2.c: In function 'main':
warn2.c:7:5: warning: '__builtin_memcpy' writing 28 bytes into a region of size 8 [-Wstringop-overflow=]
    7 |     strcpy(p, "this string is far too long");   /* overflow the 8-byte block */
      |     ^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
warn2.c:6:15: note: destination object of size 8 allocated by 'malloc'
    6 |     char *p = malloc(8);
      |               ^~~~~~~
```

而默认关闭的 `-fanalyzer` 会把"它认为你干了什么"画出来给你看，连 CWE 编号都有：

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

以上全程没有运行程序。告警是三层里最便宜的一层，也是最该最先打开的一层。

## Demo 1 —— 越界读

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

三层防线全都报了。编译输出如下（只裁掉了影子字节转储）：

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

`[32, 36) 'buf'` 这一行加上那个箭头就是全部要点：ASan 清楚地知道你冲出了哪个对象，以及朝哪个方向冲。

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
<figcaption>对象与它的 redzone。读 `buf[4]` 读到的不是"下一个变量"，而是运行时刻意放在那里的字节——正是因此它才能被发现。
</figcaption>
</figure>

修法是让边界由编译器推导，而不是由你手打：

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

## Demo 2 —— 真正会被利用的越界写

读出一个字节只是新鲜事。由"你信了的"长度驱动的堆**写**才是整个漏洞类别：

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

注意静态编译器*没*说什么：带运行时长度的 `memcpy` 对 `-Warray-bounds` 完全隐形，只有 sanitizer 抓到了。这种不对称正是把 sanitizer 放进 CI、而不是只在构建里开警告的理由。修法是显式取下界，并把截断上报：

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

截断时要返回状态很重要。默默截断会把一次攻击降级成一个数据丢失 bug。

## Demo 3 —— use-after-free 与 double-free

reload 时 free 掉、忘了清缓存指针，下一次读就落到了已释放内存上：

```c
/* uaf2.c */
char *cache = malloc(32);
strcpy(cache, "v1");
free(cache);                       /* config reload, old value dropped */
char *fresh = malloc(32);          /* allocator hands the same block back */
strcpy(fresh, "v2-longer-payload");
printf("cache after reload = %s\n", cache);   /* reads freed memory */
```

这次静态和动态都抓到了，两段都是真的：

```text
uaf2.c: In function 'main':
uaf2.c:15:5: warning: pointer 'cache' used after 'free' [-Wuse-after-free=]
   15 |     printf("cache after reload = %s\n", cache);   /* reads freed memory */
      |     ^~~~~~~~~~~~~~~~~^^^^^^^^~~~~~~~~~

==1440353==ERROR: AddressSanitizer: heap-use-after-free on address 0x7c2463be0040
READ of size 2 at 0x7c2463be0040 thread T0
    #1 0x7ff465b2c0c1 in malloc (/usr/lib/libasan.so.8+0x12c0c1)   <- the new malloc
previously allocated by thread T0 here:
freed by thread T0 here:
    #1 0x55c18f53a143 in main /tmp/opencode/work/c-ub/uaf2.c:11
```

double-free 变体更糟：它会破坏分配器本身。一个 free 之后不清指针的 teardown 函数，加一条走了两遍的错误路径：

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

修法是一行纪律——`free(p); p = NULL;`——或者干脆一个 owner、一条 teardown 路径：

```text
cache = v1
fresh = v2-longer-payload
exit=0  sanitizer-output=0
```

## Demo 4 —— 有符号整数溢出

最常见的是超时累加：`now + delay`，其中 `now` 是个"按理不该那么大"的时钟值，直到它真的变大了。

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

UBSan 打完报告后*继续用回绕后的值跑了下去*，因为 `-fsanitize=undefined` 默认是可恢复的。测试套件里可以加 `-fno-sanitize-recover=all` 让它直接中止。不带 sanitizer 的 `-O2` 构建打出了同样的数字，于是溢出看起来"能正常工作"——它并不能。把比较从常量折叠的射程里挪出去，让值来自运行时输入：

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

仔细读。`i + 1` 算出了回绕值 `-2147483648`，而 `i + 1 < i` 的回答是**no**。编译器在"溢出不可能发生"的假设下折叠了这个比较，所以无论硬件做了什么它都为假。同样的输入、同样的源码，只差一个编译选项，答案相反——而且在 `-O0` 下也一样，因为折叠发生在编译器前端。修法有两种：把算术挪到 `unsigned`（那里的回绕是*有定义的*），或者在相加之前先检查：

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

## Demo 5 —— 没校验过的移位次数

次数直接从协议字段里抠出来，作用在 32 位 `int` 上：

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

x86-64 的硬件会把次数截到 5 位，于是 `<< 40` 悄悄变成了 `<< 8`
（`0xdeadbeef << 8 == 0xadbeef00`）：一个可复现的、错误的答案，不崩、也没有运行时报错。修法是把次数夹到显式声明的字宽内，并拒绝负数：

```text
reg=0xdeadbeef count=40
reg << count = 0x00000000
reg >> count = 0x00000000
exit=0  sanitizer-output=0
```

## Demo 6 —— 空指针解引用

最常见的形状是错误分支打了日志、忘了返回：

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

修法就是补上那个 `return`，再在被调函数里加一道防御。修好的构建跑得很干净。

## Demo 7 —— 严格别名，-O0 和 -O2 会打架

这是我最想贴到海报上的一例。`f` 收一个 `long *` 和一个 `int *`，调用方让那个 `int *`
指向 `long` *内部*的字节。编译器认定 `long` 对象和 `int` 对象不可能共享存储，于是理直
气壮地把 `*l` 留在寄存器里跨过那次 `int` 写：

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

只差一个选项——`-O2` 而不是 `-O0`——正确答案就变成了零。而静态编译器早就看见了：

```text
$ gcc -O2 -fstrict-aliasing -Wstrict-aliasing=2 -c alias3.c
alias3.c: In function 'main':
alias3.c:11:22: warning: dereferencing type-punned pointer will break strict-aliasing rules [-Wstrict-aliasing]
   11 |     int *ip = (int *)&l;   /* but it does */
      |                      ^~
```

ASan 和 UBSan 都没抓到这一例——两者都没有针对别名规则的运行时检查。可用的工具只有
`-Wstrict-aliasing=2` 和代码评审。修法是用 `memcpy`（永远合法）或 `union` 来搬字节：

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

## 未对齐访问

UBSan 确实会检查对齐，但这个演示要用 cast 而不是 `packed` struct：

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

两个值得记住的细节。`struct __attribute__((packed))` 的成员*没有*触发这项检查——GCC 会为
packed 成员生成逐字节的读写序列，编译器已经在那儿保护过你了。而 x86 容忍这次未对齐读并
返回了正确值，同样的代码在 ARM Cortex-M 上就是硬件异常。可移植的修法是 `memcpy` 到一个
类型正确的目标里。

## 为什么这在单片机上更危险

在带 MMU 的 Linux 上，野指针通常映射不到任何东西，于是你得到一个带地址的 `SEGV`。而在裸
机目标上——[让 ESP32-C3 成为一个真正的 EasyTier 节点](/zh/posts/esp32-easytier-node-in-c/)里那颗
ESP32-C3——这层安全网完全不存在。平坦内存映射里每个地址都可读可写，于是来自无线电接收缓
冲区的一次越界写会落到*别人*的内存里：另一个缓冲区、一个控制块，或者中断向量表。程序不会
崩；它只是悄悄破坏了什么，三天后某个不相干的子系统行为古怪，你才发现。`-O2` 加严格别名在
这里更糟：它可以判定一次经由 `uint32_t *` 的存储不可能影响到你的 ISR 通过另一类型读的那个
标志，于是把该标志缓存进寄存器，把一个轮询循环变成死循环。

## 我实际遵守的规则

1. **开发构建里 warnings 和 sanitizers 全开。** 目标机需要性能时可以把它们从发布构建里拿
   掉——但绝不能发布一个一次都没在它们下面跑过的目标。
2. **永远不要手打数组边界字面量。** 用 `sizeof a / sizeof a[0]`、`ARRAY_SIZE(a)` 或者
   `sizeof buf`——除了那个你得手工保持同步的 `10`，什么都行。
3. **凡是带长度的一律夹住，不要相信。** 长度字段就是输入：取声称长度与你拥有的缓冲区的较
   小值，两者不一致时上报。
4. **容易溢出的算术放进 `unsigned`，或者先检查。** `if (b > T_MAX - a) reject;` 只比
   `a + b` 长一点点，而且它是良定义的。
5. **按类型字宽校验移位次数**——x86 会掩码它，所以你得到的是错误答案而不是崩溃。
6. **每次分配只有一个 owner，并且 `free` 之后清空指针。**
7. **用 `memcpy` 或 `union` 重解释字节**，永远不要用 cast。评审 diff 里的每一个 `(T *)`
   都当成一颗还没炸的 bug。
8. **把 sanitizer 输出当待办清单，而不是噪声。** ASan 和 UBSan 几乎从不冤枉你。

## 我没能复现的部分

三个诚实的缺口，因为掩盖掉它们正好等于犯这篇文章所批评的罪。**内存泄漏**：这个容器里
LeakSanitizer 对我刻意构造的两个泄漏（一条提前退出、丢掉 4096 字节分配的路径）都没有产出
报告，GCC 的 `-fanalyzer` 对一个简单泄漏也保持沉默，所以这里没有泄漏报告可贴。
**未初始化读**：GCC 没有 MemorySanitizer；我用了两个想诱发 `-Wmaybe-uninitialized` 的写法，
都没有告警，而实际跑起来读到的只是一片无害的零栈。这里的正主是 valgrind，而它没装。
**没找到的别名破坏**：好几个候选 cast 在 `-O0` 和 `-O2` 下编译出的代码完全一样，所以我只贴
了上面那个真正有差异的案例。

未定义行为不是只困扰别人代码的理论。你 debug 过两小时的每一次崩溃，大概率都出自这八个家
族之一。把 sanitizer 打开，认真读那些报告，并且把"`-O0` 好使、`-O2` 就坏"当成礼物：它正在
精确地告诉你，编译器愿意对你的程序作出哪一个假设。
