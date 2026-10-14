---
title: "C 语言结构体填充与对齐：实测"
description: "为什么 C 结构体里存在空洞：真实的 sizeof/offsetof 数字、_Alignof、带 UBSan 未对齐加载报告的 packed 结构体、memcpy 序列化垃圾字节，以及在 x86-64 上实测的伪共享加速。"
pubDate: 2027-02-13
lang: zh
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

C 中的结构体不仅仅是字段的容器。编译器会悄悄插入空字节——**填充**——放在成员之间和成员之后，让每个字段都落在 CPU 能高效访问的地址上。这在你的源码里是不可见的，但只要你问 `sizeof`、序列化一个结构体、或跑多线程代码，它立刻就会现身。本文用真实程序在 x86-64 上把这些全部测一遍：体积、偏移、对齐要求、一个会坑你的 packed 结构体、序列化垃圾字节，以及带真实计时的伪共享演示。

假设你能自如地阅读 C。如果你想先大致了解一下如何阅读陌生代码，请看[阅读代码库](/zh/posts/reading-a-codebase/)；ESP32 C 节点那篇讲的是[嵌入式 C 实战](/zh/posts/esp32-easytier-node-in-c/)。

## 为什么存在填充

CPU 以固定宽度的块读取内存。在 x86_64 上，8 字节的 `double` 在地址是 8 的倍数时最快；4 字节的 `int` 希望是 4 的倍数。如果一个 `char`（1 字节）后面紧跟着一个 `double`，这个 `double` 就会落在不是 8 倍数的地址上。编译器会插入 7 字节填充，把它推到下一个 8 字节边界。结构体变大了，但每次访问都保持快速——在对齐有要求的架构上——保持对齐。

规则很简单：**每个成员被放在它自身对齐要求的下一个倍数地址上**，而整个结构体的体积会向上取整到最大成员对齐值的倍数。结构体中最大的对齐值就成为结构体的对齐值。

## 用 sizeof 和 offsetof 观察填充

下面是同样的三个字段，两种排列顺序：

```c
struct good {
    double d;   // 8
    int    i;   // 4
    char   c;   // 1
              // 自然：8 + 4 + 1，向上取整到 8 => 16
};

struct bad {
    char   c;   // 1
    double d;   // 8 （c 之后需要 7 字节填充）
    int    i;   // 4
};              // 1 + 7pad + 8 + 4，向上取整到 8 => 24
```

编译并运行（gcc 16.2.1，x86-64）：

```text
sizeof(char)=1  sizeof(int)=4  sizeof(double)=8
offsetof(struct good, d)=0 i=8 c=12  size=16
offsetof(struct bad,  c)=0 d=8 i=16  size=24
```

同样的字段，同一个程序：**16 字节 vs 24 字节**——纯粹由声明顺序造成的 50% 差异。`offsetof`（来自 `<stddef.h>`）精确告诉你每个成员的落点，`sizeof` 告诉你填充后的总体积。

## _Alignof：每个类型的对齐要求

`_Alignof`（来自 `<stdalign.h>`）给出一个类型的对齐要求，而结构体的对齐是其成员对齐的最大值：

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

`struct mixed` 对齐到 8（因为有 `double`），所以它的体积是 8 的倍数。尽管成员加起来只有 14 字节，这个结构体却占 24 字节。

## pahole：布局观察工具

`sizeof` 和 `offsetof` 是手动的。工具 `pahole` 读取调试信息，画出布局并标出空洞。在上面 `bad` 结构体上：

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

`XXX 7 bytes hole, try to pack` 这一行正是 `c` 之后的填充。重新排列过的 `good` 结构体完全没有空洞行：

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

当你接手一个结构体、需要在重新排列之前知道浪费在哪儿时，`pahole` 非常有用。

## 经验法则：按从大到小的顺序排列成员

实用的启发式方法是**按成员体积降序声明**。这不是保证——对齐要求比体积更重要——但它能消除大多数内部填充。在上面的例子中，`good`（从大到小）是 16 字节；`bad`（从小到大）是 24 字节。对于有很多字段的结构体，节省会累积：重新排列几个成员就能把结构体缩小 30–50%，当你有几百万个这样的结构体组成数组时，这很重要。

尾部填充通常不可避免：结构体的体积必须是其对齐值的倍数，这样结构体数组的每个元素才能保持对齐。但成员之间的内部空洞是你可以消除的。

## packed：对线格式正确，对性能是陷阱

`__attribute__((packed)))` 告诉编译器完全不插入填充：

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
};                    // 1 + 2 + 4 = 7，无填充
```

```text
sizeof(struct normal)=8  offsetof(s)=2 offsetof(i)=4
sizeof(struct packed_p)=7 offsetof(s)=1 offsetof(i)=3
```

packed 结构体是 7 字节——对于需要精确字节布局的**线格式**来说很完美。但同样的 packed 结构体是**性能和可移植性的陷阱**：

- **未对齐访问。** 在 x86-64 上 CPU 容忍未对齐加载（有小幅惩罚），但在 ARM、RISC-V 或 SPARC 上，未对齐加载可能以 `SIGBUS` 崩溃。packed 结构体正好招来这个。
- **未定义行为。** 通过指针读取未对齐的成员在 C 中是 UB，即使在 x86 上也是。用 `-fsanitize=undefined` 编译，真实的未对齐加载会被报告：

```text
packed.c:33:5: runtime error: load of misaligned address 0x7ffe1a365145 for type 'unsigned int', which requires 4 byte alignment
0x7ffe1a365145: note: pointer points here
 00 41 34 12 ef be ad  de 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00  00
             ^
```

- **编译器不会帮你修正。** 编译器无法为你重新排列 packed 结构体；它按字面接受布局，空洞照留。

当你必须匹配外部字节布局（协议头、硬件寄存器映射）时使用 `packed`，即便如此，也最好用显式移位逐字段序列化，而不是把 packed 结构体转成字节缓冲区。

## 序列化教训：永远不要把 memcpy 的结构体发到线上

这是最坑人的错误：把一个结构体 `memcpy` 到发送缓冲区，然后假设这些字节是有意义的。并非如此——填充字节是未初始化的垃圾，而且布局不可移植。

```c
struct sensor {
    char  tag;      // 1 字节
    double value;   // 8 字节（tag 之后 7 字节填充）
    short  seq;     // 2 字节
};                  // 共 24
```

我把每个字节先用 `0xAA` 下毒，然后只赋那三个真实字段。填充保持 `0xAA`：

```text
sizeof(struct sensor)=24
wire bytes: 54 aa aa aa aa aa aa aa 6e 86 1b f0 f9 21 09 40 07 00 aa aa aa aa aa aa
offsetof(tag)=0 value=8 seq=16
padding bytes at offsets 1..7 (uninitialized 0xAA): aa aa aa aa aa aa aa
```

那 7 个 `aa` 字节不是数据——它们就是栈上原来的东西。把这些发到另一台机器，你就是在泄漏内存内容（安全问题），并且发送的字节会被不同的编译器、架构或打包设置解释成不同的东西（正确性问题）。结构体的布局是**实现细节**，不是契约。

正确的做法是显式序列化：按定义的顺序、定义的宽度把每个字段写入缓冲区，或者用替你做这件事的库。永远不要把结构体转成 `unsigned char *` 发出去。

## 伪共享：缓存行的代价

填充不只是为了节省字节——它还关乎**缓存行**。CPU 以 64 字节的行缓存内存（x86-64 上）。当两个线程写入碰巧落在同一缓存行上的两个变量时，缓存一致性协议会强制该行在各核之间来回弹跳：每次写入都让另一个核的副本失效，行就来回乒乓。两个线程并不共享数据，但它们共享一条**缓存行**——因此叫*伪共享*。

这是一个真实基准：两个线程各递增一个计数器 2000 万次。第一次计数器相邻（同一缓存行），然后填充隔开，让各自独占一条 64 字节行：

```text
N iterations per thread: 20000000, cache line: 64 bytes
false sharing  (adjacent):  0.048 s
padded apart   (own line):  0.035 s
speedup from padding:        1.37x
```

三次运行中加速分别是 **1.37x、1.40x 和 1.41x**——插入 56 字节填充带来一致的约 40% 提升。递增完全相同；唯一的区别是缓存行位置。在真实负载中、或更多核的机器上，差距会进一步拉大。

模式是把每线程的热点变量填充到一整条缓存行：

```c
typedef struct {
    volatile unsigned long a;      // 热点
    char pad[64 - sizeof(unsigned long)];
    volatile unsigned long b;      // 热点，独占一条缓存行
} padded_t;
```

这和 `struct bad` 正好相反：那里你删掉填充来省空间；这里你填充来换速度。两者都是工具；区别在于结构体是受内存限制还是受竞争限制。

## 实用建议

- **先测量。** 在改动之前用 `sizeof`、`offsetof` 和 `pahole` 看真实布局。不要猜。
- **按从大到小排列成员**以消除内部填充。这是免费的、可移植的，还能缩小结构体数组。
- **少用 `packed`**——只用于线格式和寄存器映射。注意未对齐访问、UB 和可移植性。
- **永远不要把结构体 memcpy 序列化。** 显式写字段，或者用序列化库。填充是垃圾，布局不可移植。
- **当两个线程写入相近变量时，把每线程热点数据填充到一条缓存行。** 上面 1.4x 的加速是真实且可复现的。
- **不要依赖跨编译器或跨架构的结构体布局。** 它是实现细节。如果它是契约，就显式写出来。

填充是那种直到付出代价才显形的 C 细节——线上多出的字节、ARM 上的崩溃、或缓存行来回弹跳造成的 40% 吞吐损失。现在你有了观察它、缩小它、以及刻意使用它的工具。
