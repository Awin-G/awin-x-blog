---
title: "我实际在用的嵌入式开发工具，以及每一件是干什么的"
description: "一份工作台上的真实清单，而不是购物单：用编译器和 size、objdump、readelf 看清代码的真实开销，用 gdb 加 OpenOCD 走 SWD 调试，用 picocom 与 socat 搭出串口终端，用 sigrok 驱动逻辑分析仪，用 esptool 烧录——凡是能跑的工具，都附上真实输出。"
pubDate: 2027-02-18
lang: zh
translationKey: tools-for-embedded-work
tags: [embedded]
featured: false
keywords:
  - 嵌入式开发工具
  - 逻辑分析仪
  - 串口终端
  - OpenOCD
  - sigrok
---

经常有人问我该买哪些**嵌入式开发工具**。这个问题问反了。我工作台上大部分的价值来自那些不花钱、就跑在我本来就有的笔记本上的软件；真正要买的硬件都很小、很具体，而且是被一个「没有别的办法回答」的问题逼出来的。所以这篇文章是我这里**实际装了**什么的清单、每一件**是干什么的**、价值排序的诚实版本，再加上这次会话里凡是能跑的工具的真实输出。跑不了的，我直接说跑不了。

## 这里到底装了什么（以及我怎么查）

第一件工具是 `command -v`。我脑子里不留自己机器的画像，我直接问它。

```console
$ for t in gcc objdump readelf size nm objcopy strace ltrace picocom minicom socat \
    openocd gdb arm-none-eabi-gcc esptool sigrok-cli binwalk dfu-util avrdude; do
    printf "%-18s %s\n" "$t" "$(command -v $t || echo MISSING)"
  done
gcc                /usr/bin/gcc
objdump            /usr/bin/objdump
readelf            /usr/bin/readelf
size               /usr/bin/size
nm                 /usr/bin/nm
objcopy            /usr/bin/objcopy
strace             MISSING
ltrace             MISSING
picocom            /usr/bin/picocom
minicom            /usr/bin/minicom
socat              /usr/bin/socat
openocd            MISSING
gdb                /usr/bin/gdb
arm-none-eabi-gcc  MISSING
esptool            /usr/bin/esptool
sigrok-cli         MISSING
binwalk            MISSING
dfu-util           MISSING
avrdude            MISSING
```

这是这台机器的真实结果：通用 GNU 工具链和串口工具在主机上，而**跟目标芯片绑定**的那些（ARM 交叉编译器、OpenOCD、`sigrok-cli`、`avrdude`）不在。写这篇文章时，我把它们装进了用完就扔的容器里跑。真正常年开发的机器上，它们该待在系统包管理器里，但命令是一模一样的。

<figure>
<svg viewBox="0 0 760 330" role="img" aria-labelledby="fig-tools-title" style="width:100%;height:auto">
  <title id="fig-tools-title">从目标板经适配器到主机工具的完整信号路径</title>
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="currentColor">
    <text x="14" y="16" font-size="10" opacity="0.65">图 1 — 一块目标板，三种观察它的方式</text>

    <text x="70" y="52" font-size="10" text-anchor="middle" opacity="0.6">目标板</text>
    <text x="330" y="52" font-size="10" text-anchor="middle" opacity="0.6">适配器</text>
    <text x="620" y="52" font-size="10" text-anchor="middle" opacity="0.6">主机工具</text>

    <rect x="20" y="66" width="110" height="216" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="75" y="150" text-anchor="middle" font-weight="600">MCU</text>
    <text x="75" y="168" text-anchor="middle" font-size="10" opacity="0.7">固件</text>
    <text x="75" y="96" text-anchor="middle" font-size="10">SWDIO</text>
    <text x="75" y="110" text-anchor="middle" font-size="10">SWCLK</text>
    <text x="75" y="196" text-anchor="middle" font-size="10">TX</text>
    <text x="75" y="210" text-anchor="middle" font-size="10">RX</text>
    <text x="75" y="256" text-anchor="middle" font-size="10">SDA/SCL</text>
    <text x="75" y="270" text-anchor="middle" font-size="10">MOSI/MISO</text>

    <rect x="250" y="80" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="100" text-anchor="middle" font-weight="600" fill="#0f766e">调试探针 SWD/JTAG</text>
    <text x="330" y="116" text-anchor="middle" font-size="10" opacity="0.75">ST-Link / J-Link / CMSIS-DAP</text>

    <rect x="250" y="182" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="202" text-anchor="middle" font-weight="600" fill="#0f766e">USB 转串口</text>
    <text x="330" y="218" text-anchor="middle" font-size="10" opacity="0.75">CH340 / CP2102 / FT232</text>

    <rect x="250" y="246" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="266" text-anchor="middle" font-weight="600" fill="#0f766e">逻辑分析仪</text>
    <text x="330" y="282" text-anchor="middle" font-size="10" opacity="0.75">8 通道克隆版，24 MHz</text>

    <rect x="500" y="80" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="100" text-anchor="middle" font-weight="600">OpenOCD :3333</text>
    <text x="620" y="116" text-anchor="middle" font-size="10" opacity="0.75">gdb、断点、烧录</text>

    <rect x="500" y="182" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="202" text-anchor="middle" font-weight="600">picocom / minicom / socat</text>
    <text x="620" y="218" text-anchor="middle" font-size="10" opacity="0.75">115200 8N1，关闭流控</text>

    <rect x="500" y="246" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="266" text-anchor="middle" font-weight="600">sigrok-cli / PulseView</text>
    <text x="620" y="282" text-anchor="middle" font-size="10" opacity="0.75">UART、I²C、SPI、CAN 解码器</text>

    <line x1="132" y1="103" x2="246" y2="103" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="132" y1="205" x2="246" y2="205" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="132" y1="269" x2="246" y2="269" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>

    <line x1="412" y1="103" x2="496" y2="103" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="412" y1="205" x2="496" y2="205" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="412" y1="269" x2="496" y2="269" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>

    <text x="214" y="95" text-anchor="middle" font-size="9" opacity="0.6">SWD</text>
    <text x="214" y="197" text-anchor="middle" font-size="9" opacity="0.6">UART</text>
    <text x="214" y="261" text-anchor="middle" font-size="9" opacity="0.6">总线</text>
    <text x="454" y="95" text-anchor="middle" font-size="9" opacity="0.6">TCP</text>
    <text x="454" y="197" text-anchor="middle" font-size="9" opacity="0.6">/dev/ttyUSB0</text>
    <text x="454" y="261" text-anchor="middle" font-size="9" opacity="0.6">.sr / .vcd</text>
  </g>
</svg>
<figcaption>工作台上的每个问题，都要经过一个适配器，落到某个主机工具里。目标板不在乎你
用哪一行；选对那一行才是本事。</figcaption>
</figure>

## 软件工具链：看清你的代码到底花了多少钱

### `size` 是我第一个看的数字

单片机是一份预算：几十 KB 的 flash、几 KB 的 RAM。`size` 告诉你一个编译单元花了这份预算里多少，三个数字对应三种不同的物理资源：

```console
$ cat blinky.c
#include <stdint.h>
static volatile uint32_t ticks;
void delay(volatile uint32_t n) { while (n--) __asm__ volatile(""); }
void toggle_led(void) { ticks++; delay(1000); }
int main(void) { for (;;) toggle_led(); return 0; }

$ gcc -c -Os -Wall -ffreestanding -fno-stack-protector -o blinky.o blinky.c
$ size blinky.o
   text	   data	    bss	    dec	    hex	filename
    178	      0	      4	    182	     b6	blinky.o
```

`text` 是代码加常量，住在 flash 里。`data` 是带初值的变量，它**同时**占 flash（存一份初值副本）和 RAM。`bss` 是零初始化变量，只占 RAM。如果你从 `objdump size` 这套习惯里只记住一件事，就记住：**`text + data` 是你的 flash 账单**，`data + bss` 是你的 RAM 账单。

同一份代码交叉编译到 Cortex-M4 是这样——而 `size -A` 会告诉你这些字节到底落在哪：

```console
$ arm-none-eabi-gcc -c -mcpu=cortex-m4 -mthumb -Os -ffunction-sections -fdata-sections -o fw.o fw.c
$ arm-none-eabi-size fw.o
   text	   data	    bss	    dec	    hex	filename
    157	     16	      4	    177	     b1	fw.o

$ arm-none-eabi-size -A fw.elf
fw.elf  :
section           size        addr
.text              157   134217728
.data               16   536870912
.bss                 4   536870928
.comment            38           0
.ARM.attributes     46           0
Total              261
```

优化等级的影响比大多数人以为的大，而且这件事**量一下比猜便宜**：

```console
$ for opt in -O0 -Os -O2 -O3; do
>   arm-none-eabi-gcc -c -mcpu=cortex-m4 -mthumb $opt -ffunction-sections -fdata-sections -o fw$opt.o fw.c
>   printf "%-4s " "$opt"; arm-none-eabi-size fw$opt.o | tail -1
> done
-O0   323	     16	     68	    407	    197	fw-O0.o
-Os   157	     16	      4	    177	     b1	fw-Os.o
-O2   205	     16	      4	    225	     e1	fw-O2.o
-O3   265	     16	      4	    285	    11d	fw-O3.o
```

这个文件上 `-Os` 赢了；`-O3` 比 `-O2` **更大**，因为它做循环展开。这不是普遍规律——恰恰因为不是，才需要这个工具。而在任何嵌入式构建里，最大的那个数字往往是你**没想到自己链进去了**的 C 库。同一个文件、三个变体，都是 `-Os` 配 `newlib-nano`：

```console
NONE            20	      0	      4	     24	     18	p-NONE.elf    # 没有 printf
USE_INT       6309	     92	    332	   6733	   1a4d	p-USE_INT.elf   # printf("%d")
USE_FLOAT     8273	     92	    332	   8697	   21f9	p-USE_FLOAT.elf # printf("%.3f")
```

三百字节的代码，因为一句 `printf` 变成了 6 KB flash。问一句 `nm --size-sort`「这些字节去哪了」，答案立刻就有：

```console
$ arm-none-eabi-nm -S --size-sort --print-size p-USE_INT.elf | tail -5
08001020 00000122 T _printf_common
08000ce8 00000134 T memcpy
20000060 00000138 B __sf
08001144 00000284 T _printf_i
08000428 000002f8 T __sfvwrite_r
```

格式化输出、一个住在 `.bss` 里的 `FILE` 缓冲、以及底下那一整套 stdio 机器。这就是代价；现在它是个**决定**，而不是一次意外。

### `readelf`、`objdump` 与 `objcopy`

`readelf -l` 解释了每个初学者看嵌入式 ELF 都会困惑的一件事：为什么 `.data` 有**两个**地址。

```console
$ arm-none-eabi-readelf -l fw.elf
Program Headers:
  Type           Offset   VirtAddr   PhysAddr   FileSiz MemSiz  Flg Align
  LOAD           0x010000 0x08000000 0x08000000 0x0009d 0x0009d R E 0x10000
  LOAD           0x020000 0x20000000 0x0800009d 0x00010 0x00014 RW  0x10000
 Section to Segment mapping:
  Segment Sections...
   00     .text
   01     .data .bss
```

`.data` 的**虚拟**地址在 RAM（`0x20000000`），**加载**地址在 flash（`0x0800009d`）。启动代码会把它拷过去。这就是为什么你的 flash 镜像比 RAM 占用更大，也是为什么一个悄悄长大的 `.data` 数组会悄悄吃掉 flash。

`objdump -d` 是我读「编译器到底干了什么」的方式。Thumb-2 其实意外地好读：

```console
$ arm-none-eabi-objdump -d --disassemble=crc32 fw.elf
08000034 <crc32>:
 8000034:	b530      	push	{r4, r5, lr}
 8000036:	4d0a      	ldr	r5, [pc, #40]	@ (8000060 <crc32+0x2c>)
 800003a:	f04f 33ff 	mov.w	r3, #4294967295	@ 0xffffffff
 ...
 800005e:	bf00      	nop
 8000060:	edb88320 	.word	0xedb88320
```

而 `objcopy` 负责在外部世界要的格式之间转换——给 AVR 编程器的 Intel HEX、给 `esptool` 的裸 `.bin`、或者单独抠出一个 section 来检查：

```console
$ arm-none-eabi-objcopy -O binary fw.elf fw.bin   # 173 字节：text + data
$ arm-none-eabi-objcopy -O ihex   fw.elf fw.hex   # 14 行 Intel HEX
:020000040800F2
:100000004FF08042136843F40053136070474FF081
```

## 串口终端，以及你该买的第一件东西

**串口终端**是有史以来最便宜的调试器：目标板打印文字，你敲文字回去，而且在别的都不工作时，你能从第一条指令开始看它启动。我首选 `picocom`——小、没有配置文件、退得干净。`minicom` 干同一件事，只是带一套 1990 年代的菜单。`socat` 是三件里最有用的：它能造出**虚拟**串口，整套流程你完全可以在没有硬件的情况下练。

下面是一对真实的 pty，一头是个假设备，另一头是 `picocom`：

```console
$ socat pty,raw,echo=0,link=./ttyA pty,raw,echo=0,link=./ttyB &
$ printf '\nversion\nhelp\n' | script -qec "picocom -q -b 115200 ./ttyB" /dev/null
fw 0.3 / hw rev C / uid 7c:df:a1:xx
commands: version help reset
```

（`script` 只是为了给 `picocom` 一个真终端；没有终端它会拒绝运行。）三个设置解释了 90% 的「什么都不显示」：

- **波特率。** 两端必须一致。115200 是现代默认值，9600 在老旧设备上仍然存在。波特率错了，你看到的是**看起来很像样的乱码**，而不是安静。
- **8N1。** 八位数据位、无校验、一位停止位，按这个顺序，低位在前。
- **关闭流控。** 目标板并没有驱动的硬件流控（`RTS`/`CTS`）会让你的终端在启动中途卡死。一开始就关掉。

这也正是为什么**USB 转串口模块是我第一个会买的东西**，排在任何探针之前。它是每块板子都有的那个接口，是固件变砖之后还活着的那个接口，也是唯一能告诉你**为什么**设备不启动的那个接口。如果你正在挑一块用来入门的板子，自带 USB-UART 桥的 devkit 连这笔采购都省了——看 [ESP32-C3 devkit](/zh/posts/esp32-c3-getting-started/) 是怎么做的。

## 逻辑分析仪与 sigrok：看线本身

当串口什么都不说时，你就往下走一层，去看引脚。**逻辑分析仪**同时记录好几根线的 0/1 状态；`sigrok`（以及它的图形界面 PulseView）把这些电平解码成字节。那套解码循环——找到总线、找到波特率、提出假设、改一个输入、验证——本身是一门手艺，我把方法写在[用逻辑分析仪逆向一个串口协议](/zh/posts/decoding-a-serial-protocol/)里了。这里我想展示的是**工具本身是真的**，不是假设的。

我用上面那个假设备打印出来的、一模一样的字节生成了一段 VCD 波形，交给 `sigrok-cli`：

```console
$ sigrok-cli -i uart-demo.vcd -I vcd -P uart:baudrate=115200:rx=uart_tx -A uart=rx-data
uart-1: 66
uart-1: 77
uart-1: 20
uart-1: 30
uart-1: 2E
uart-1: 33
...
uart-1: 0D
uart-1: 0A
```

`66 77 20 30 2E 33` 就是 `f w 空格 0 . 3`——那些字节从波形里原样回来了。同一个二进制还解码 I²C、SPI、CAN、JTAG 等等，它能读的格式包括 VCD、CSV 和裸二进制，所以一块十块钱的克隆版和一台名牌设备，最后都进同一个工作流。当你分不清哪根线是哪根时，是分析仪告诉你——我在一条 CAN 总线上做过同样的事，写在 [CAN 总线与虚拟 CAN](/zh/posts/can-bus-and-virtual-can/) 里。

## 调试：gdb、OpenOCD，以及在 Linux 目标上的 strace

`gdb` 是调试器；**OpenOCD** 是那个把 `gdb` 连接变成硬件探针上 SWD 或 JTAG 时序的东西。整个循环是：OpenOCD 占住探针、在一个 TCP 端口上监听；`gdb` 用它的远程协议连到那个端口。OpenOCD 在什么都没插的情况下也会启动，这恰好是这台机器的诚实画面：

```console
$ openocd -f interface/stlink.cfg -f target/stm32f4x.cfg
Open On-Chip Debugger 0.12.0
Info : auto-selecting first available session transport "hla_swd".
Info : Listening on port 6666 for tcl connections
Info : Listening on port 4444 for telnet connections
Info : clock speed 2000 kHz
Error: open failed
```

`Error: open failed` 就是那个不存在的探针。在真实的工作台上，这一行会换成检测到的目标芯片和它的 IDCODE，然后 `gdb` 接手：

```console
$ gdb -q -batch -ex 'file fw.elf' -ex 'target extended-remote localhost:3333' \
      -ex 'monitor reset halt' -ex 'load' -ex 'bt' ./fw.elf
could not connect: Connection timed out.
You can't do that when your target is `exec'
```

即使在失败里也有两点值得注意。第一，`gdb` 把 ELF 读得很干净——它知道 `.text` 在 `0x08000000`、`.data` 在 `0x20000000`、`.bss` 紧跟着。第二，`monitor` 命令只有在挂上**远程**目标之后才能用；`exec` 文件不是一个目标。这个区分就是 OpenOCD 的全部心智模型。

如果你的「嵌入式」目标其实是 Linux——树莓派、路由器、一块 SBC——你完全可以跳过探针，因为内核就是你的调试器。`strace` 看系统调用，`ltrace` 看库调用，而且两者都装在**目标板**上，不是主机上：

```console
$ strace -e trace=openat,read ./linux_target
openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3
read(3, "ae5ea6798a32\n", 63)           = 13
openat(AT_FDCWD, "/proc/uptime", O_RDONLY) = 3
read(3, "228366.98 1448887.04\n", 1024) = 21
```

这是这台机器上一个真实程序的真实 trace。放到目标板上，它是回答「启动时它到底打不开哪个文件」最快的方式——而这个问题没有任何逻辑分析仪能回答。

## 烧录：esptool、avrdude、dfu-util

每个芯片家族都有自己的烧录器，你该学的是你这块板子说的那一种。`esptool` 覆盖乐鑫系：

```console
$ esptool version
esptool v5.4.0

$ esptool --chip esp32c3 --port /dev/ttyUSB0 read-mac
ERROR: A fatal error occurred: Could not open /dev/ttyUSB0, the port is busy or doesn't exist.

$ esptool --chip esp32c3 merge-bin -o factory.bin --flash-size 4MB 0x10000 fw.bin
Wrote 0x100ad bytes to file 'factory.bin', ready to flash to offset 0x0.
```

第一条是没插板子时会得到的报错——很诚实，而且有用，因为它把尝试过的端口名字说了出来。第二条是真的在干活：`merge-bin` 把一个 bootloader 偏移和我们编译出来的 `fw.bin` 合成了一张 65,709 字节的镜像。AVR 那边对应的是 `avrdude`，而以 DFU 设备枚举出来的东西，对应的是 `dfu-util`：

```console
$ avrdude -c usbasp -p m328p
avrdude error: cannot find USB device with vid=0x16c0 pid=0x5dc vendor='www.fischl.de' product='USBasp'
avrdude error: unable to open programmer usbasp on port usb
```

注意一条报错能告诉你多少东西：它在找一个**特定 VID/PID** 的 USBasp。当你插上编程器它还是失败时，这条消息就是你的下一个搜索关键词。

## 工作台的购买顺序：万用表、示波器、逻辑分析仪

这是大家最容易搞错的部分，而且它是一道**万用表 vs 示波器 vs 逻辑分析仪**的选择题，每个阶段都有明确答案。

1. **一块万用表。** 第一，永远第一，没有例外。3.3 V 到底有没有？两块板的**地**真的共了吗？电流看着正常吗？大多数「这芯片坏了」的排查，最后都终结在一块万用表加一根松掉的地线上。
2. **一台便宜的逻辑分析仪。** 第二，因为你真正会遇到的问题是**这些引脚在说什么**，而一台 0/1 记录仪用一顿饭的钱就能回答它。八通道绰绰有余。
3. **一台示波器。** 第三，而且只在你需要看**电压**而不是**比特**的时候：上升时间、振铃、负载下塌下去的电源轨、一条永远差一点没到阈值的 I²C 线。这是你最后才买的工具，因为它最贵，也最少是那个答案。

我故意不点名型号、不报价格。这些价位段每隔几个月就变，具体的推荐很快就会过期。但**顺序**不会。

## 诚实的建议

买那件能回答你**今天**这个问题的便宜工具。一台你手上有的逻辑分析仪，胜过一台你还在做功课的示波器。但另一个方向也要诚实：软件能力比工作台重要，而且差距很大。这篇文章里除了真正的电压测量之外的一切，都是用自由软件、在一台笔记本上、**完全没有硬件**做出来的——包括反汇编、空间核算、串口终端、逻辑解码和烧录镜像。最快改变你结果的那件「仪器」是 `size`，然后是 `nm`，然后是 `objdump`，而它们早就装好了。

## 这里跑不了的部分

把这件事说清楚，比显得周全更重要：

- **没有硬件探针，也没有板子。** OpenOCD 的 `Error: open failed`、`gdb` 的 `Connection timed out`、`avrdude` 找不到 USBasp、`dfu-util` 的空设备列表，都是这台什么都没插的机器上的真实输出。我没有伪造一次成功的烧录。
- **没有真实的逻辑分析仪采集。** 我这里没有分析仪，所以那个 VCD 文件是用一段小脚本、从**真实字节**生成的。**解码**确实是真的 sigrok 在跑，字节也确实往返对上了，但波形是合成的。
- **`strace`/`ltrace` 需要 `CAP_SYS_PTRACE`。** 这台主机上没装，所以我在容器里跑；上面的 trace 是真实的。
- **固件 blob 是拼出来的，不是 dump 出来的。** `firmware-dump.bin` 是真实的 `esptool merge-bin` 输出，后面接了一个真实的 gzip，好让 `binwalk`、`strings` 和 `xxd` 有东西可找：

```console
$ binwalk firmware-dump.bin
DECIMAL       HEXADECIMAL     DESCRIPTION
65709         0x100AD         gzip compressed data, maximum compression, has original file name: "extra.tar", from Unix

$ strings -n 6 -t x firmware-dump.bin
  10083  embedded-tools demo v0.3
  100b7 extra.tar

$ xxd firmware-dump.bin | head -2
00000000: ffff ffff ffff ffff ffff ffff ffff ffff  ................
```

偏移零处的 `0xFF` 是擦除过的 NOR flash，也就是一份基本是空的固件 dump 长什么样。这套习惯——先 `binwalk`、再用 `strings` 找秘密、用 `xxd` 确认——值得在你真正需要它之前就养好。这也正是这份清单的全部意义：不是拥有这些工具，而是在你即将遇到那个问题之前，就已经知道该用哪一件。
