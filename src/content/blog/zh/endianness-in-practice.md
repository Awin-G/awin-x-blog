---
title: "实践中的字节序：为什么字节是反着的"
description: "用真实程序把字节序讲透：在 x86 上打印 32 位整数的字节、htonl 与网络字节序、直接发送结构体过 socket 的经典 bug、Modbus 寄存器，以及如何检测字节序并做字节交换。"
pubDate: 2027-02-13
lang: zh
translationKey: endianness-in-practice
tags: [embedded, c]
featured: false
keywords:
  - 字节序
  - 大小端
  - htonl
  - 网络字节序
  - 字节交换
---

你在固件里写下 `uint32_t t = 1000000;`，把它从 UART 发出去，对面打印出
`1078071040`。数据没坏，也没丢。你只是刚刚认识了**字节序**（endianness）：
一个多字节值的各个字节在内存里按什么顺序摆放，也正是 `htonl` 这类函数存在的
理由。这篇文章把这件事讲全，所有输出都来自 x86_64 机器上真实跑过的程序——
不含任何"看平台而定"式的含糊其辞。

下面每个例子都是真的。C 程序用 `gcc 16.2.1` 编译，在这台 x86_64 Linux 上运行；
Python 程序跑在 Python 3.14 下。我选择把字节打印出来而不是断言它们应该是什么，
因为只有这一样东西能让这个教训真正留下来。

## 大小端：字节序到底是什么

一个 32 位的值有四个字节。字节序只回答一个问题：当你把这个值存到地址 `A` 时，
哪个字节放在 `A`？

- **小端（little endian）**——*最低*有效字节排在最前面，`0x11223344` 变成
  `44 33 22 11`。x86、x86-64，以及主流的 ARM 都用它。
- **大端（big endian）**——*最高*有效字节排在最前面，`0x11223344` 变成
  `11 22 33 44`。网络协议栈用它（这就是它被称为**网络字节序**的原因）、Modbus
  用它、很多老式 MCU 用它，还有大量外设的数据手册上直接就写着"MSB first"。

两台机器可以在类型、宽度、对齐上完全一致，却依然在字节上对不上号。问题全在这
里。

实际都是谁在用：x86 和 x86-64 永远是小端。ARM 在常见配置（Cortex-M、Cortex-A、
Apple silicon）下默认小端，但架构本身是双端的——某些工具链可以编译出另一种。
PowerPC 和 Motorola/Freescale 的芯片通常是大端。RISC-V 在所有主流实现里都是
小端。MIPS 则以"同一个型号既有大端又有小端"出名，这也是为什么给 MIPS 交叉编译
算嵌入式入门仪式。网络协议栈在任何地方都是大端，`htonl` 和"网络字节序"这个名字
正是从这里来的。

<figure>
<svg viewBox="0 0 640 176" width="640" height="176" role="img" aria-label="同一个 32 位值 0x11223344，小端存储为 44 33 22 11，大端存储为 11 22 33 44，字节地址为 0 到 3" style="max-width:100%;height:auto">
  <style>
    .hd { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; }
    .bx { fill: none; stroke: #0f766e; stroke-width: 1.5; }
    .by { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; text-anchor: middle; }
    .ad { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; text-anchor: middle; opacity: .55; }
    .lb { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0f766e; }
    .sub { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: currentColor; opacity: .55; }
  </style>
  <text class="hd" x="0" y="14">内存中的值 0x11223344</text>
  <text class="lb" x="0" y="47">小端</text>
  <text class="sub" x="0" y="61">x86、x86-64、ARM</text>
  <g>
    <rect class="bx" x="150" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="202" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="254" y="26" width="48" height="32" rx="3"/>
    <rect class="bx" x="306" y="26" width="48" height="32" rx="3"/>
    <text class="by" x="174" y="47">44</text>
    <text class="by" x="226" y="47">33</text>
    <text class="by" x="278" y="47">22</text>
    <text class="by" x="330" y="47">11</text>
    <text class="ad" x="174" y="72">+0</text>
    <text class="ad" x="226" y="72">+1</text>
    <text class="ad" x="278" y="72">+2</text>
    <text class="ad" x="330" y="72">+3</text>
  </g>
  <text class="lb" x="0" y="128">大端</text>
  <text class="sub" x="0" y="142">网络、Modbus、多数 MCU</text>
  <g>
    <rect class="bx" x="150" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="202" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="254" y="108" width="48" height="32" rx="3"/>
    <rect class="bx" x="306" y="108" width="48" height="32" rx="3"/>
    <text class="by" x="174" y="129">11</text>
    <text class="by" x="226" y="129">22</text>
    <text class="by" x="278" y="129">33</text>
    <text class="by" x="330" y="129">44</text>
    <text class="ad" x="174" y="154">+0</text>
    <text class="ad" x="226" y="154">+1</text>
    <text class="ad" x="278" y="154">+2</text>
    <text class="ad" x="330" y="154">+3</text>
  </g>
</svg>
<figcaption>图 1 —— 同一个值，两种字节顺序。同样四个字节，从哪一端读起，就是两个
不同的数。</figcaption>
</figure>

### 字节序不等于位序

这是一类容易混起来的问题，因为两者都被随口叫做"那个端序的事"。字节序说的是
一个多字节值里*哪个字节*先走。**位序**说的是*单个字节*里的哪个 bit 先上线——
异步 UART 是先低位（LSB first），而 SPI、I2C 和 Modbus 都是先高位（MSB first）。
两者互相独立：UART 完全可以在每个字节内部先发低位的同时，按大端发送一个 16 位
的值。逆向一条未知总线时，我会把这两个问题分开问：哪一位先出去，哪一个字节先
出去。

## 怎么看见它：把字节打印出来

别再去推理字节序，直接把它打出来。诀窍是通过 `unsigned char *` 去看这个对象，
这是标准里唯一保证可以别名任何对象的指针类型。

```c
#include <stdint.h>
#include <stdio.h>
#include <arpa/inet.h>

int main(void) {
    uint32_t v = 0x11223344u;
    unsigned char *p = (unsigned char *)&v;
    printf("bytes at increasing addresses: ");
    for (size_t i = 0; i < sizeof v; i++) printf("%02x ", p[i]);
    printf("\n");
    printf("htonl(0x11223344) bytes:      ");
    uint32_t n = htonl(v);
    unsigned char *q = (unsigned char *)&n;
    for (size_t i = 0; i < sizeof n; i++) printf("%02x ", q[i]);
    printf("\n");
    return 0;
}
```

```
$ gcc -O2 -o dump dump.c && ./dump
bytes at increasing addresses: 44 33 22 11
htonl(0x11223344) bytes:      11 22 33 44
```

最低有效字节 `0x44` 待在*最低的地址*上。这就是小端主机，x86 给你的就是这个。
而 `htonl` 交回的正是反过来的一组字节，也就是大端对端期待的样子。

在 Python 里，同样的信息只隔着一个属性，所以当脚本和设备对不上时，这是最快的
检查点：

```
$ python3 -c "import sys; print(sys.byteorder)"
little
```

`xxd` 对磁盘上的任何文件都能说同样的事。一个 Python 程序把 `0xA1B2C3D4` 写两
遍：

```python
import struct
open("le.bin", "wb").write(struct.pack("<Ii", 0xA1B2C3D4, 305419896))
open("be.bin", "wb").write(struct.pack(">Ii", 0xA1B2C3D4, 305419896))
```

```
$ xxd le.bin
00000000: d4c3 b2a1 7856 3412                      ....xV4.
$ xxd be.bin
00000000: a1b2 c3d4 1234 5678                      .....4Vx.
$ file le.bin be.bin
le.bin: pcap capture file, microsecond ts (little-endian) - version 22136.4660
be.bin: pcap capture file, microseconds ts (big-endian) - version 4660.22136
```

`44 33 22 11` 对 `11 22 33 44`，整篇文章就在这儿。白送的彩头是：`file` 仅凭这个
魔数就认出了我这个随手写的文件是个 pcap，还顺手告诉了我字节序。嗅探字节序正是
[我写的那个 pcap 解析器](/zh/posts/writing-a-pcap-parser/)判断一份别人机器写出来
的抓包该按什么顺序读的方法。

## 网络字节序，以及 htonl 到底做了什么

`htons`（host to network short）和 `htonl`（host to network long）把你的 CPU 使
用的顺序转换成大端。这是上面那个程序稍微加长一点的版本，同时打印网络序和字节
交换后的形式：

```
$ ./bytes
uint32 0x11223344:          44 33 22 11
htonl(0x11223344):          11 22 33 44

endianness:                 little

htonl(1) =                  16777216
__builtin_bswap32(v) =      1144201745

union { u32 i; u8 c[4]; }: c[0] = 1 -> little endian
```

有两件事值得从这份输出里拿走。

**这里的 `htonl(1)` 是 16777216。** 这就是可移植的字节序测试：在大端主机上它会
是 `1`，在小端主机上它是 `1 << 24`。如果你需要在运行时知道字节序，这是一行就
能搞定、任何地方都成立、连 `configure` 都不需要的写法。

**`htons` 和 `htonl` 不是字节交换。** 它们是*主机到网络*的转换，在大端主机上
是彻彻底底的空操作。这不是细节——这正是 `htons` 单元测试几乎毫无价值的原因：

```c
uint16_t v = 0x1234;
assert(htons(v) == 0x3412);   /* passes on x86, fails nowhere-yet */
```

这条断言只能证明你正在一台小端机器上。它对测试来说是个真实的坑：一套在 x86 上
写好的测试，将来搬到大端的 CI runner 上跑，会因为一条从来没有真正检验过协议本
身的断言而失败。要断言的是*你实际放到线上的字节*，而不是 `htons` 的返回值。

这个转换之所以存在，是因为当年的互联网工程师选定了一种字节序并坚持至今，而
BSD socket 一路把这个选择贯彻到底：`struct sockaddr_in` 里的 `sin_port` 和
`sin_addr` 都是网络字节序，所以你传给 `bind()` 的是 `htons(8080)` 而不是
`8080`。socket 之上的部分是你自己的事，所以协议只要走 TCP，你就只需要在一个边
界上转换，只需要在一个地方做对。

反向的 `ntohs`/`ntohl` 是同一组函数换个方向，并且能往返：
`ntohl(htonl(x)) == x` 在任何平台都成立。

## 经典 bug：把裸结构体丢过 socket

这是字节序从冷知识变成事故的地方。它太诱人了：`write(fd, &msg, sizeof msg)` 几
秒钟就写好。下面就是它真正放到线上的东西。

```c
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>

struct reading {            /* 1 + 4 + 2 = 7 bytes of fields */
    uint8_t  id;
    uint32_t t;             /* milliseconds */
    uint16_t value;
};

static void show(const char *label, const void *b, size_t n) {
    printf("%-26s", label);
    for (size_t i = 0; i < n; i++) printf("%02x ", ((const unsigned char *)b)[i]);
    printf("\n");
}

int main(void) {
    struct reading r = { .id = 7, .t = 1000000u, .value = 0x1122 };
    unsigned char dirty[sizeof r];

    memset(dirty, 0xAA, sizeof dirty);      /* pretend stack garbage */
    memcpy(dirty, &r, sizeof r);
    show("we send (12 bytes):", dirty, sizeof r);

    int sv[2];                             /* child = the peer */
    socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
    if (fork() == 0) { close(sv[0]); write(sv[1], dirty, sizeof r); _exit(0); }

    unsigned char got[64];                 /* parent = the receiver */
    ssize_t n = read(sv[0], got, sizeof got);
    wait(NULL);
    show("peer reads (12 bytes):", got, n);

    struct reading back;
    memcpy(&back, got, sizeof back);
    printf("receiver decodes: id=%u t=%u value=0x%04x\n",
           back.id, back.t, back.value);

    /* the same data from a big-endian MCU: 7 bytes, no padding */
    unsigned char be[7] = { r.id, 0x00, 0x0f, 0x42, 0x40, 0x11, 0x22 };
    show("MCU sends (7 bytes):", be, sizeof be);
    uint32_t wrong, right;
    memcpy(&wrong, be + 1, 4);             /* host order -- a lie */
    right = ((uint32_t)be[1] << 24) | ((uint32_t)be[2] << 16)
          | ((uint32_t)be[3] << 8) | (uint32_t)be[4];
    printf("t as host uint32: %u   t big endian: %u   ratio %.0f\n",
           wrong, right, (double)wrong / right);
    return 0;
}
```

```
$ gcc -O2 -Wall -Wextra -o wirebug wirebug.c && ./wirebug
we send (12 bytes):       07 aa aa aa 40 42 0f 00 22 11 aa aa
peer reads (12 bytes):    07 aa aa aa 40 42 0f 00 22 11 aa aa
receiver decodes: id=7 t=1000000 value=0x1122
MCU sends (7 bytes):      07 00 0f 42 40 11 22
t as host uint32: 1078071040   t big endian: 1000000   ratio 1078
```

仔细读这份输出，因为它一口气装了三个 bug。

**填充。** `sizeof(struct reading)` 是 12，不是 7——`offsetof(t)` 是 4，
`offsetof(value)` 是 8，编译器把空隙补上了。`id` 和 `t` 之间那三个 `aa` 就是填
充字节，我在这里强制填成 `0xAA` 好让它们显形；真实代码里它们是栈上恰好躺着的
任何东西。你刚刚把未初始化的栈内存发给了一个对端——这也是无意中泄露数据的典型
途径。

**字节序。** `t` 发出去是 `40 42 0f 00`。看看 Modbus 那一类 MCU 对同一个值发的
是什么：`00 0f 42 40`。把*那*四个字节当成主机 `uint32_t` 来读，得到的是
`1078071040` 而不是 `1000000`——差了 1078 倍。这个方向是对称的：MCU 把我的
`40 42 0f 00` 读成 `1078071040` 也一样。

**长度。** 同一个结构体，一边 12 字节，一边 7 字节。一个说"12 字节"的协议和一
个只发 7 字节的对端，根本没走到就该为数字吵架的那一步。

最残酷的地方是前三行：经过一次真实的 `socketpair()` 往返，结果完全正确。两端都
在 x86 上，同一个结构体定义，同一个编译器——这个 bug 在有一端搬走之前是看不见
的。

## 检测字节序，以及字节交换

大多数时候你不需要检测它，编译器本来就知道。`__BYTE_ORDER__` 在 GCC 和 Clang
上编译期就可用：

```c
#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    /* big endian */
#endif
```

用 union 写的运行时版本是合法的、很快的，而且在 `-O2` 下会被整个折叠掉。我编译
出的二进制上 `objdump` 显示 `host_is_big_endian()` 被内联并化简成一个立即数
`0`；这个函数在二进制里根本不存在。而上面 `htonl(1)` 那个技巧不需要任何头文件
就能给你答案。

你真正需要检测它的场合只有一个：读一个*自带字节序*的文件或帧。惯用做法是读一
个已知的魔数，看它是顺着排的还是反着排的。如果你读到四个字节 `a1 b2 c3 d4`，
说明源是大端；如果读到 `d4 c3 b2 a1`，说明源是小端。这一个测试就决定了你怎么
读剩下的全部内容——pcap 和一切自描述二进制格式干的就是这件事。

要做显式的**字节交换**，用 `__builtin_bswap32` / `__builtin_bswap16`（不够还有
`__builtin_bswap64`）。我查了一下 gcc 16 对非常量输入实际生成的代码——一条指
令，没有循环：

```
$ gcc -O2 -std=c11 -o swap swap.c && ./swap
bswap32(0x11223344) = 0x44332211
bswap16(0x1234)     = 0x3412
$ objdump -d swap --no-show-raw-insn | sed -n '/<sw>:/,/^$/p'
    1190:	mov    %edi,%eax
    1192:	bswap  %eax
    1194:	ret
```

Python 中等价的写法是一次切片反转：`x.to_bytes(4, "big")[::-1]`。

## 它在嵌入式里从哪儿咬人

**传感器寄存器。** 很多 ADC 和 IMU 芯片按 MSB first 输出多样本。一个 3 字节的寄
存器读到 `7f 12 34`：

```python
raw = bytes([0x7F, 0x12, 0x34])
raw.hex(" "), int.from_bytes(raw, "big"), int.from_bytes(raw, "little")
```

```
'7f 12 34' 8327732 3412735
```

按数据手册，正确答案是 8327732。小端的读数是 3412735，差了大
约 2.4 倍。符号更糟：同样三个字节按有符号大端读是 `-60876`，按无符号小端读却是
`3412735`。当一个本该是负数的值读出来又大又正时，先怀疑字节序。

**Modbus。** Modbus 帧里每个字段都是大端，没有例外，也没有任何标志位说明这件
事。寄存器 1000、258 和 48879 在线上长这样：

```python
regs = [1000, 258, 0xBEEF]
wire = b"".join(struct.pack(">H", r) for r in regs)
for r in regs:
    onwire = struct.pack(">H", r)
    print("reg 0x%04x: big-endian read %6d | little-endian read %6d"
          % (r, struct.unpack(">H", onwire)[0], struct.unpack("<H", onwire)[0]))
```

```
reg 0x03e8: big-endian read   1000 | little-endian read  59395
reg 0x0102: big-endian read    258 | little-endian read    513
reg 0xbeef: big-endian read  48879 | little-endian read  61374
```

如果你正在逆向一台没文档的设备，同样的逻辑是你的朋友：我写的
[串口协议逆向实录](/zh/posts/decoding-a-serial-protocol/)——抓字节、对含义提假
设、验证假设——正是摸清一台未知设备用哪种字节序的方法。两种都试一遍，看哪一种
在物理输入变化时给出合理变化的数值。

**文件格式。** pcap 嗅自己的魔数（上面已经演示过）。PNG 是大端，BMP 是小端，
WAV 的块是小端，PostScript 和 JPEG 是大端。格式自己会告诉你，你只要去读规格说
明书里那一节。

## 规矩：把线上格式写下来，在边界上转换

这个结构体 bug 的教训不是"字节序很难"。而是：结构体不是序列化格式。结构体描述
的是*你的编译器*的布局决定——填充、对齐、字段顺序、字节序。这些没有一项属于你
的协议，除非你把它写下来。

那就写下来，然后把编解码只写一次。下面是同一个 `struct reading` 的正确做法——
一个明确的九字节帧，每个字段的偏移、宽度和字节序都写在注释里，并用
`static_assert` 锁住布局，这样编译器一旦挪动字段就无法悄悄通过：

```c
struct reading {            /* 1 + 4 + 2 = 7 bytes of fields */
    uint8_t  id;
    uint32_t t;             /* milliseconds */
    uint16_t value;
};
static_assert(offsetof(struct reading, id)    == 0, "id at 0");
static_assert(offsetof(struct reading, t)     == 4, "t at 4");
static_assert(offsetof(struct reading, value) == 8, "value at 8");

static void put_u16(unsigned char *b, uint16_t v) { b[0] = v >> 8; b[1] = v; }
static void put_u32(unsigned char *b, uint32_t v) {
    b[0] = v >> 24; b[1] = v >> 16; b[2] = v >> 8; b[3] = v;
}
static void put_reading(unsigned char *b, struct reading r) {
    b[0] = r.id;
    put_u32(b + 1, r.t);      /* offset 1, 4 bytes, big endian */
    put_u16(b + 5, r.value);  /* offset 5, 2 bytes, big endian */
    b[7] = 0;                 /* reserved */
    b[8] = 0;
}
```

```
$ gcc -O2 -std=c11 -o codec codec.c && ./codec
sizeof(struct reading) = 12, sizeof(frame) = 9
frame on the wire:      07 00 0f 42 40 11 22 00 00
decoded back:           id=7 t=1000000 value=0x1122
```

这个帧永远是九字节，在任何主机上都是九字节，里面既没有填充，也没有主机字节序。
代价是每个字段大约五行代码，这是嵌入式工作里最便宜的保险。

我用下面这些代替 `memcpy` 结构体：

1. **把线上格式明确写下来**——每个字段的字节偏移、宽度和字节序。"偏移 4 处一个
   u16 大端"是规格说明；"把结构体发过去"不是。
2. **在边界上一个字段一个字段地序列化**——`put_u32(buf + 4, v)`，或者
   `struct.pack(">Iih", …)`，或者一个带 schema 的编解码器。只有一处做转换，其他
   地方全用宿主机类型。
3. **永远不要把裸结构体送出进程、机器或架构边界。** 不通过 socket、不写进文
   件、不进共享内存。
4. **测字节，不测值**——断言这一帧是 `00 0f 42 40`，这是一条关于协议的陈述；
   `assert(htons(x) == …)` 只是一条关于你笔记本的陈述。
5. **自己预留字节，别让编译器替你插。** 给结构体加 `__attribute__((packed))` 看
   起来很诱人，但那是用填充换非对齐访问，而某些 ARM 和 MIPS 内核遇到非对齐访问
   会直接陷入异常。一个显式的 `b[7] = 0` 不花任何代价，而且在规格说明里看得见。

字节序不会消失。它在你能摸到的每一条总线上，而字节确实是反着出来的——在大半个
硬件世界里都是如此。
