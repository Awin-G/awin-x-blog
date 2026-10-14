---
title: "交叉编译 ARM：在 x86 上为另一台机器构建"
description: "交叉编译就是用目标三元组与主机不同的工具链，在 x86 机器上构建 ARM 二进制。我用 armhf 和 aarch64 gcc 实际编译，用 file 和 readelf 验证目标格式，撞上一次真实的 Exec format error，再用 qemu-user 把 ARM 程序跑起来。"
pubDate: 2027-02-16
lang: zh
translationKey: cross-compiling-for-arm
tags: [embedded, c]
featured: false
keywords:
  - 交叉编译
  - ARM 工具链
  - aarch64 gcc
  - sysroot
  - 目标三元组
---

我手里有一台 x86 小机器、一堆 ARM 板子，以及一种根深蒂固的执念：绝不在慢
机器上编译。这篇是实战记录——**交叉编译**：在一台 x86-64 主机上用真实的
**ARM 工具链**构建 ARM 二进制，验证产物，看着它在本地拒绝运行，然后靠仿真
把它跑起来。下面每一条输出都真的跑过，没有任何编造。

这个博客已经涉足过嵌入式：用 C 写的
[ESP32-C3 EasyTier 节点](/zh/posts/esp32-easytier-node-in-c/)和
[ESP32-C3 入门](/zh/posts/esp32-c3-getting-started/)。那两个项目也在交叉
编译，但厂商 SDK 把底层机制藏得严严实实。这篇讲的就是机制本身：裸 `gcc`、
一个 `aarch64 gcc` 目标、一个 **sysroot**。

## 交叉编译到底是什么

交叉编译只有一句话：**工具链的目标三元组与主机的架构不同**。像
`arm-linux-gnueabihf` 这样的三元组读作 `机器-厂商-系统-ABI`：

- `arm` / `aarch64` —— 目标 CPU（32 位 ARMv7 对 64 位 ARMv8）
- `linux` —— 目标操作系统
- `gnueabihf` —— ABI：GNU libc、嵌入式 ABI、硬浮点

如果三元组的机器部分和内核的 `uname -m` 一致，那就是本地编译；不一致，就是
交叉编译。我的主机是 `x86_64`，所以一切机器不是 `x86_64` 的构建都是交叉
构建：

```text
$ uname -m
x86_64

$ gcc -dumpmachine
x86_64-linux-gnu          # native

$ arm-linux-gnueabihf-gcc -dumpmachine
arm-linux-gnueabihf       # cross: 32-bit ARM, hard-float

$ aarch64-linux-gnu-gcc -dumpmachine
aarch64-linux-gnu         # cross: 64-bit ARM
```

为什么要费这个事？跑程序的那块板子又慢，通常还忙着当路由器或者传感器节点；
而 x86 编译机的编译速度要快 5–20 倍，工具链一条 `apt-get` 就能装好。代价
是你再也无法在本机*运行*自己构建出来的东西——下面会细说。

<figure>
<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="x86-64 宿主机运行交叉编译器，产出供目标板运行的 ARM ELF 二进制">
  <rect x="20" y="80" width="150" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="95" y="115" text-anchor="middle" font-size="15" fill="currentColor">x86-64 宿主机</text>
  <text x="95" y="138" text-anchor="middle" font-size="12" fill="#0f766e">编译机</text>
  <text x="95" y="156" text-anchor="middle" font-size="11" fill="currentColor">gcc 运行的地方</text>

  <line x1="180" y1="125" x2="290" y2="125" stroke="#0f766e" stroke-width="2" marker-end="url(#ar)"/>
  <text x="235" y="110" text-anchor="middle" font-size="11" fill="#0f766e">hello.c</text>

  <rect x="290" y="70" width="190" height="110" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="385" y="105" text-anchor="middle" font-size="15" fill="currentColor">交叉编译器</text>
  <text x="385" y="127" text-anchor="middle" font-size="12" fill="#0f766e">arm-linux-gnueabihf-gcc</text>
  <text x="385" y="145" text-anchor="middle" font-size="12" fill="#0f766e">aarch64-linux-gnu-gcc</text>
  <text x="385" y="167" text-anchor="middle" font-size="11" fill="currentColor">目标三元组属于目标机，不是主机</text>

  <line x1="490" y1="125" x2="600" y2="125" stroke="#0f766e" stroke-width="2" marker-end="url(#ar)"/>
  <text x="545" y="110" text-anchor="middle" font-size="11" fill="#0f766e">ARM ELF</text>

  <rect x="600" y="80" width="100" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="650" y="115" text-anchor="middle" font-size="15" fill="currentColor">ARM</text>
  <text x="650" y="138" text-anchor="middle" font-size="12" fill="#0f766e">目标板</text>
  <text x="650" y="156" text-anchor="middle" font-size="11" fill="currentColor">树莓派 / 路由器 / MCU</text>

  <text x="360" y="230" text-anchor="middle" font-size="11" fill="currentColor">宿主机永远不运行产物——这就是全部的取舍</text>
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>交叉编译：编译器跑在 x86-64 上，但它吐出的每一个字节都指向 ARM。</figcaption>
</figure>

## ARM 工具链：装上之后有什么

在 Debian 和 Ubuntu 上，交叉工具链都是现成的软件包——不用下载压缩包、不用
自己构建引导编译器。一个一次性的 Debian trixie 容器里：

```text
# apt-get install -y gcc-arm-linux-gnueabihf gcc-aarch64-linux-gnu
```

它会拉来一整套三件套：`gcc-14-arm-linux-gnueabihf`（编译器）、
`binutils-arm-linux-gnueabihf`（汇编器和链接器）、`libc6-dev-armhf-cross`
（目标机的头文件和用于链接的 libc）。每个工具都以三元组为前缀，所以
`arm-linux-gnueabihf-gcc`、`arm-linux-gnueabihf-objdump` 和
`aarch64-linux-gnu-gcc` 并排躺在 `/usr/bin` 里。

一个马上要回答的问题：**glibc 还是 musl？** 打包的交叉工具链都是 glibc——
这里 `libc6-armhf-cross` 的版本是 `2.41-11cross1`，也就是 glibc 2.41。
Debian 不提供 musl 的交叉变体；musl 交叉工具链要单独装（`musl.cc` 的预编译
包，或 Alpine 自己的软件包）。用哪个不看你喜好，而由*目标机*的用户态决定
——见后面链接那一节。

## 验证目标格式：file、readelf、objdump

我用三个编译器构建同一个微不足道的程序。源码是一个 `main` 加一个小哈希
函数，用预处理判断自己运行在什么架构上：

```c
/* hello.c */
#include <stdio.h>

static unsigned long mix(unsigned long x) {
    unsigned long h = x ^ 0x9e3779b97f4a7c15UL;
    h *= 0xbf58476d1ce4e5b9UL;
    h ^= h >> 27;
    return h;
}

int main(void) {
    unsigned long acc = mix(42);
    printf("hello from %s\n",
#if defined(__aarch64__)
           "aarch64"
#elif defined(__arm__)
           "armhf"
#else
           "something else"
#endif
    );
    printf("acc=%lu sizeof(void*)=%d\n", acc, (int)sizeof(void *));
    return 0;
}
```

三条命令，三个不同的机器：

```text
$ gcc               -O2 -o hello-native       hello.c
$ arm-linux-gnueabihf-gcc -O2 -o hello-armhf hello.c
$ aarch64-linux-gnu-gcc   -O2 -o hello-aarch64 hello.c

$ file hello-native hello-armhf hello-aarch64
hello-native:   ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, ...
hello-armhf:    ELF 32-bit LSB pie executable, ARM, EABI5 version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-armhf.so.3, ..., for GNU/Linux 3.2.0, not stripped
hello-aarch64:  ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, ..., for GNU/Linux 3.7.0, not stripped
```

同一份源码、同一台主机、同一天，`file` 报出来的是三个世界：`x86-64`、
`ARM EABI5`、`ARM aarch64`，各自配着自己的动态加载器
（`ld-linux-armhf.so.3` 对 `ld-linux-aarch64.so.1`）。armhf 版本上的
`EABI5` 和 `hard-float ABI` 字样，正是三元组里 `eabihf` 那一半的显形，而
`for GNU/Linux 3.2.0` 是工具链打进去的最低内核 ABI 版本。

机器层面的真相要看 `readelf -h`，它从不对目标格式撒谎：

```text
$ arm-linux-gnueabihf-readelf -h hello-armhf
ELF Header:
  Magic:   7f 45 4c 46 01 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF32
  Data:                              2's complement, little endian
  Type:                              DYN (Position-Independent Executable file)
  Machine:                           ARM
  ...
  Flags:                             0x5000400, Version5 EABI, hard-float ABI
  ...
```

而 ARM 专属的属性——一个光秃秃的架构字符串不会告诉你的东西——在
`readelf -A` 里：

```text
$ arm-linux-gnueabihf-readelf -A hello-armhf
Attribute Section: aeabi
File Attributes
  Tag_CPU_name: "7-A"
  Tag_CPU_arch: v7
  Tag_CPU_arch_profile: Application
  Tag_FP_arch: VFPv3-D16
  Tag_ABI_VFP_args: VFP registers
  Tag_THUMB_ISA_use: Thumb-2
  ...
```

`v7` + `VFPv3-D16` + `VFP registers`，这是工具链在宣布：我将为 ARMv7-A 级别
的 CPU 生成硬浮点代码。真正落到板子上的东西仍然值得看一眼——`main` 的反汇编
混合了 Thumb-2 和 32 位两种指令编码，这个整数程序里当然没有浮点指令：

```text
$ arm-linux-gnueabihf-objdump -d hello-armhf | sed -n "/^00000408 <main>:/,/^$/p"
00000408 <main>:
 408:	4908      	ldr	r1, [pc, #32]	@ (42c <main+0x24>)
 40c:	b508      	push	{r3, lr}
 412:	f7ff efe8 	blx	3e4 <printf@plt>
 416:	4807      	ldr	r0, [pc, #28]	@ (434 <main+0x2c>)
 41e:	f6c2 2114 	movt	r1, #10772	@ 0x2a14
 424:	f7ff efde 	blx	3e4 <printf@plt>
 428:	2000      	movs	r0, #0
 42a:	bd08      	pop	{r3, pc}
 ...
```

这是最容易被跳过、也最便宜的一步验证：在二进制离开编译机之前，
`file` 和 `readelf` 就能确认目标架构对不对。

## 静态链接与动态链接，以及必须匹配的 libc

默认情况下，交叉编译器产出的是动态链接二进制，它向*目标机*索取两样东西：
动态加载器（`/lib/ld-linux-armhf.so.3`，`readelf -l` 里能看到）和一个匹配
的 libc：

```text
$ arm-linux-gnueabihf-readelf -d hello-armhf | grep NEEDED
 0x00000001 (NEEDED)                     Shared library: [libc.so.6]
```

`-static` 把（静态）libc 直接链进二进制，两个依赖都不复存在。同样的源码、
同样的参数，只差 `-static`，体积如下：

```text
$ arm-linux-gnueabihf-gcc -O2 -static -o hello-armhf-static hello.c
$ aarch64-linux-gnu-gcc -O2 -static -o hello-aarch64-static hello.c

$ ls -l
-rwxr-xr-x 1 root root  69380 hello-armhf
-rwxr-xr-x 1 root root 486416 hello-armhf-static
-rwxr-xr-x 1 root root  70536 hello-aarch64
-rwxr-xr-x 1 root root 704592 hello-aarch64-static

$ file hello-armhf-static
hello-armhf-static: ELF 32-bit LSB executable, ARM, EABI5 version 1 (GNU/Linux), statically linked, ...
```

体积涨到 7 倍，这就是不让程序自带 libc 的代价。作为交换，静态二进制只要
内核 ABI 对得上，在没有加载器的板子上也能跑——路由器和 initramfs 镜像之所
以普遍静态链接，原因正在于此。

人人都会踩的坑是 **libc 版本错配**。这里的交叉工具链链接的是 glibc 2.41。
如果目标是落后两个版本的 Raspberry Pi OS（glibc 2.31），你的二进制就可能
需要目标机的 libc 并不导出的符号，而且故障只在板子上、只在运行时才出现：
`version 'GLIBC_2.34' not found`。由此有两条规矩：

1. 交叉工具链的 libc 必须**不新于**目标机的 libc。
2. 如果目标机跑 musl（Alpine、OpenWrt），glibc 交叉编译器根本产出不了能
   跑的二进制——你需要 musl 交叉工具链，因为 ABI 和动态加载器的名字都不
   一样。

## --sysroot：把编译器指向目标机的文件系统

`--sysroot` 的意思是："找头文件和库的时候，都从这个目录往下看，就当它是
`/`"。Debian 交叉编译器的默认 sysroot 是 `/`——目标库就住在
`/usr/arm-linux-gnueabihf`：

```text
$ arm-linux-gnueabihf-gcc -print-sysroot
/
$ arm-linux-gnueabihf-gcc -print-file-name=libc.so
/usr/lib/gcc-cross/arm-linux-gnueabihf/14/../../../../arm-linux-gnueabihf/lib/libc.so
```

于是就有了经典的新手陷阱——"那我把 `--sysroot` 直接指过去不就行了"：

```text
$ arm-linux-gnueabihf-gcc --sysroot=/usr/arm-linux-gnueabihf -O2 -o hello-sysroot hello.c
/usr/lib/gcc-cross/arm-linux-gnueabihf/14/../../../../arm-linux-gnueabihf/bin/ld: cannot find /usr/arm-linux-gnueabihf/lib/libc.so.6 inside /usr/arm-linux-gnueabihf
collect2: error: ld returned 1 exit status
```

sysroot 是一个*根*：顶层得有 `lib/`、`usr/include/` 的目录树，而不是某个
前缀目录的名字。现实的用法是从目标机抓一个 sysroot 下来（把板子的 `/lib`
和 `/usr/include` `rsync` 进一个目录），或者用厂商 SDK 带的。给一棵正经的
树，链接一步到位——同一棵树还能直接当仿真的运行时根目录：

```text
$ mkdir -p sysroot/lib sysroot/usr/include
$ cp -a /usr/arm-linux-gnueabihf/lib/. sysroot/lib/

$ arm-linux-gnueabihf-gcc --sysroot=sysroot -O2 -o hello-sysroot hello.c
$ file hello-sysroot | cut -d, -f1-3
hello-sysroot: ELF 32-bit LSB pie executable, ARM, EABI5 version 1 (SYSV)

$ qemu-arm-static -L sysroot ./hello-sysroot
hello from armhf
acc=705963138 sizeof(void*)=4
```

输出里的 `sizeof(void*)=4` 是整件事最安静的证明：这是 32 位 ARM，而宿主机
是 x86。

## 试图在 x86 上运行的那一刻

内核会检查 ELF 头里的机器字段，和自身架构不符就直接拒绝。没有兼容模式、
没有警告，只有最朴素的答案：

```text
$ ./hello-armhf
sh: 1: ./hello-armhf: Exec format error

$ echo $?
126
```

这不是你构建出了错，而是构建在按设计工作。每次执行都换来一句
`Exec format error`，这就是真正的交叉编译的声音。剩下的开发循环是：在
x86 上构建、交付、在板子上测——很慢，这正是下一个技巧存在的理由。

## qemu-user：在 x86 上运行 ARM 二进制

`qemu-arm-static`（来自 `qemu-user-static`）是用户态仿真：它加载 ARM
ELF、翻译指令、把系统调用转交宿主机内核。动态链接的二进制仍然需要目标机
的动态加载器，这就是 `-L <sysroot>` 的用处：

```text
$ qemu-arm-static ./hello-armhf
qemu-arm-static: Could not open '/lib/ld-linux-armhf.so.3': No such file or directory

$ qemu-arm-static -L /usr/arm-linux-gnueabihf ./hello-armhf
hello from armhf
acc=705963138 sizeof(void*)=4
```

静态 ARM 二进制根本不需要加载器，不加 `-L` 也能跑：

```text
$ qemu-arm-static ./hello-armhf-static
hello from armhf
acc=705963138 sizeof(void*)=4
```

同一个程序换 aarch64，一样的流程：

```text
$ qemu-aarch64-static -L /usr/aarch64-linux-gnu ./hello-aarch64
hello from aarch64
acc=4246834716217250274 sizeof(void*)=8
```

`sizeof(void*)=8`——这次是 64 位 ARM。这台开发机上有个值得知道的小插曲：
内核的 `binfmt_misc` 里注册了 qemu，所以*直接*执行 aarch64 ELF 会静默地
走仿真：

```text
$ cat /proc/sys/fs/binfmt_misc/qemu-aarch64
enabled
interpreter /usr/bin/qemu-aarch64
flags: POCF
offset 0
magic 7f454c460201010000000000000000000200b700
mask ffffffffffffff00fffffffffffffffffeffffff

$ ./hello-aarch64-static
hello from aarch64
acc=4246834716217250274 sizeof(void*)=8
```

注意这里只注册了 `qemu-aarch64`——这正是上面 armhf 二进制得到裸的
`Exec format error` 的原因。`binfmt` 仿真是便利，不是保证：如果仿真拦截
故障的方式不同，你的编译机就不足以复现板子上的问题。把 qemu 当作快速的
冒烟测试；真正的法官永远是那块板子。

## 构建系统这一侧：CROSS_COMPILE 与工具链文件

手敲编译器命令是撑不过一个正经项目的。Makefile 的惯例是把交叉前缀做成可
覆盖的变量：

```make
# Cross build: the toolchain is selected purely by CROSS_COMPILE.
CROSS_COMPILE ?=
CC := $(CROSS_COMPILE)gcc

all: hello

hello: hello.c
	$(CC) -O2 -o $@ $<

clean:
	rm -f hello
```

```text
$ make CROSS_COMPILE=arm-linux-gnueabihf-
arm-linux-gnueabihf-gcc -O2 -o hello hello.c

$ file hello | cut -d, -f1-3
hello: ELF 32-bit LSB pie executable, ARM, EABI5 version 1 (SYSV)
```

`CROSS_COMPILE` 让一个 Makefile 同时服务本地调试构建（`make`）和交叉发布
构建（`make CROSS_COMPILE=aarch64-linux-gnu-`）——Linux 内核和 U-Boot 到处
都是这个模式。

CMake 的对应物是配置时传入的**工具链文件**：

```cmake
# aarch64-toolchain.cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_C_COMPILER   aarch64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER aarch64-linux-gnu-g++)

set(CMAKE_FIND_ROOT_PATH /usr/aarch64-linux-gnu)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
```

```text
$ cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=aarch64-toolchain.cmake
-- The C compiler identification is GNU 14.2.0
-- Configuring done (0.3s)

$ cmake --build build
[100%] Linking C executable hello
[100%] Built target hello

$ file build/hello | cut -d, -f1-3
build/hello: ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV)

$ qemu-aarch64-static -L /usr/aarch64-linux-gnu ./build/hello
hello from aarch64
acc=4246834716217250274 sizeof(void*)=8
```

我在这一课上学了两次：在这个文件里写
`CMAKE_SYSROOT /usr/aarch64-linux-gnu`（看着可太对了——目标库就在那儿）
会让 CMake 给编译器传 `--sysroot=/usr/aarch64-linux-gnu`，链接器于是到
那个路径*里面*找 `libc.so.6`，报错就是前面那个三连的
`cannot find ... inside ...`。在 Debian 和 Ubuntu 上，`CMAKE_SYSROOT` 留
空，`CMAKE_FIND_ROOT_PATH` 只用于 CMake 自己的 find_ 系列命令。
`CMAKE_SYSTEM_NAME` 加编译器前缀，就足够切换其他一切。

## 什么时候不该交叉编译

说点实话，因为交叉编译是取舍，不是信仰：

- **目标机能编译，就在目标机上编译。** 一块树莓派 5 编译小型 C 项目只要
  几秒，而且你免费获得目标机精确的内核、libc 和头文件。没有 sysroot 陷
  阱，没有 libc 版本考古，测到就是发到的。
- **或者在面向目标架构的容器里构建**——比如 `docker run --platform
  linux/arm64`（宿主机注册了 qemu `binfmt` 时可用），你得到一个完整、感
  觉和原生无异的 arm64 用户态：进去 `apt install gcc`，构建过程与在真板
  子上毫无区别。
- **目标机吃紧时才交叉编译**——64 MB 内存、8 MB 闪存的路由器，没有操作系
  统的板子，或者必须产出多种架构又不想养多个 runner 的 CI。那里才是 5–20
  倍编译速度值回票价的地方，`qemu-user` 负责快速冒烟测试。

无论走哪条路，不变的只有：验证产物（`file`、`readelf`）、弄清它带的是哪个
libc，以及别猜，去查。
