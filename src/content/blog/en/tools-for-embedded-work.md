---
title: "The embedded development tools I actually use, and what each one is for"
description: "A working bench list, not a shopping list: the compiler with size, objdump and readelf to see what your code costs, gdb plus OpenOCD over SWD, a serial console built from picocom and socat, a logic analyzer driven by sigrok, and flashing with esptool — with real output from every tool I could run."
pubDate: 2027-02-18
lang: en
translationKey: tools-for-embedded-work
tags: [embedded]
featured: false
keywords:
  - embedded development tools
  - logic analyzer
  - serial console
  - OpenOCD
  - sigrok
---

People ask what **embedded development tools** they should buy. The question is
backwards. Most of the value on my bench comes from software that costs nothing
and runs on the laptop I already own, and the hardware purchases that follow are
small, specific, and driven by a question I could not answer any other way. So
this is a list of what is actually installed here, what each piece is *for*, and
the honest ordering of value — plus real output from every tool I could run in
this session. Where I could not run something, I say so plainly.

## What is actually installed (and how I check)

The first tool is `command -v`. I keep no mental model of my own machine; I ask it.

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

That is a real result from this machine: the generic GNU toolchain and the serial
tools live on the host, while the *target-specific* pieces (ARM cross compiler,
OpenOCD, `sigrok-cli`, `avrdude`) do not. I installed those in throwaway containers
for this article; on a machine you actually develop on they belong in the host
package manager, but the commands are identical.

<figure>
<svg viewBox="0 0 760 330" role="img" aria-labelledby="fig-tools-title" style="width:100%;height:auto">
  <title id="fig-tools-title">Signal path from a target board through adapters to host tools</title>
  <defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="currentColor">
    <text x="14" y="16" font-size="10" opacity="0.65">FIG. 1 — ONE TARGET, THREE WAYS TO WATCH IT</text>

    <rect x="14" y="30" width="760" height="0" fill="none"/>

    <!-- column labels -->
    <text x="70" y="52" font-size="10" text-anchor="middle" opacity="0.6">TARGET</text>
    <text x="330" y="52" font-size="10" text-anchor="middle" opacity="0.6">ADAPTER</text>
    <text x="620" y="52" font-size="10" text-anchor="middle" opacity="0.6">HOST TOOLS</text>

    <!-- target -->
    <rect x="20" y="66" width="110" height="216" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="75" y="150" text-anchor="middle" font-weight="600">MCU</text>
    <text x="75" y="168" text-anchor="middle" font-size="10" opacity="0.7">firmware</text>
    <text x="75" y="96" text-anchor="middle" font-size="10">SWDIO</text>
    <text x="75" y="110" text-anchor="middle" font-size="10">SWCLK</text>
    <text x="75" y="196" text-anchor="middle" font-size="10">TX</text>
    <text x="75" y="210" text-anchor="middle" font-size="10">RX</text>
    <text x="75" y="256" text-anchor="middle" font-size="10">SDA/SCL</text>
    <text x="75" y="270" text-anchor="middle" font-size="10">MOSI/MISO</text>

    <!-- adapters -->
    <rect x="250" y="80" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="100" text-anchor="middle" font-weight="600" fill="#0f766e">probe (SWD/JTAG)</text>
    <text x="330" y="116" text-anchor="middle" font-size="10" opacity="0.75">ST-Link / J-Link / CMSIS-DAP</text>

    <rect x="250" y="182" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="202" text-anchor="middle" font-weight="600" fill="#0f766e">USB-serial adapter</text>
    <text x="330" y="218" text-anchor="middle" font-size="10" opacity="0.75">CH340 / CP2102 / FT232</text>

    <rect x="250" y="246" width="160" height="46" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="330" y="266" text-anchor="middle" font-weight="600" fill="#0f766e">logic analyzer</text>
    <text x="330" y="282" text-anchor="middle" font-size="10" opacity="0.75">8-channel clone, 24 MHz</text>

    <!-- host tool boxes -->
    <rect x="500" y="80" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="100" text-anchor="middle" font-weight="600">OpenOCD :3333</text>
    <text x="620" y="116" text-anchor="middle" font-size="10" opacity="0.75">gdb, breakpoints, flash</text>

    <rect x="500" y="182" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="202" text-anchor="middle" font-weight="600">picocom / minicom / socat</text>
    <text x="620" y="218" text-anchor="middle" font-size="10" opacity="0.75">115200 8N1, no flow control</text>

    <rect x="500" y="246" width="240" height="46" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="620" y="266" text-anchor="middle" font-weight="600">sigrok-cli / PulseView</text>
    <text x="620" y="282" text-anchor="middle" font-size="10" opacity="0.75">UART, I²C, SPI, CAN decoders</text>

    <!-- arrows: target -> adapter -->
    <line x1="132" y1="103" x2="246" y2="103" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="132" y1="205" x2="246" y2="205" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="132" y1="269" x2="246" y2="269" stroke="currentColor" stroke-width="1.5" marker-end="url(#arw)"/>

    <!-- arrows: adapter -> host -->
    <line x1="412" y1="103" x2="496" y2="103" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="412" y1="205" x2="496" y2="205" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>
    <line x1="412" y1="269" x2="496" y2="269" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arw)"/>

    <text x="214" y="95" text-anchor="middle" font-size="9" opacity="0.6">SWD</text>
    <text x="214" y="197" text-anchor="middle" font-size="9" opacity="0.6">UART</text>
    <text x="214" y="261" text-anchor="middle" font-size="9" opacity="0.6">bus</text>
    <text x="454" y="95" text-anchor="middle" font-size="9" opacity="0.6">TCP</text>
    <text x="454" y="197" text-anchor="middle" font-size="9" opacity="0.6">/dev/ttyUSB0</text>
    <text x="454" y="261" text-anchor="middle" font-size="9" opacity="0.6">.sr / .vcd</text>
  </g>
</svg>
<figcaption>Every bench question routes through an adapter into a host tool. The target
does not care which one you use; picking the right row is the skill.</figcaption>
</figure>

## The software toolchain: seeing what your code costs

### `size` is the number I look at first

A microcontroller is a budget: a few tens of KB of flash, a few KB of RAM. `size`
tells you how much of that budget a translation unit spends, in three numbers that
map onto three different physical resources:

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

`text` is code plus constants and lives in flash. `data` is initialised variables
that also occupy flash (as a copy) and RAM. `bss` is zero-initialised variables
that occupy RAM only. If you remember nothing else about the `objdump size`
workflow, remember that **`text + data` is what your flash bill is** and
`data + bss` is your RAM bill.

Cross-compiled for a Cortex-M4, the same file looks like this — and here `size -A`
shows where the bytes actually land:

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

The optimisation level matters more than most people expect, and it is cheap to
measure instead of guess:

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

`-Os` wins on this file; `-O3` is *larger* than `-O2` because it unrolls. That is
not a universal rule, which is exactly why the tool exists. And the single biggest
number in any embedded build is often the C library you did not think you were
linking. Same file, three variants, all `-Os` with `newlib-nano`:

```console
NONE            20	      0	      4	     24	     18	p-NONE.elf   # no printf
USE_INT       6309	     92	    332	   6733	   1a4d	p-USE_INT.elf  # printf("%d")
USE_FLOAT     8273	     92	    332	   8697	   21f9	p-USE_FLOAT.elf # printf("%.3f")
```

Three hundred bytes of code became 6 KB of flash because of one `printf`. Asking
`nm --size-sort` where it went answers it immediately:

```console
$ arm-none-eabi-nm -S --size-sort --print-size p-USE_INT.elf | tail -5
08001020 00000122 T _printf_common
08000ce8 00000134 T memcpy
20000060 00000138 B __sf
08001144 00000284 T _printf_i
08000428 000002f8 T __sfvwrite_r
```

There it is: formatted output, a `FILE` buffer in `.bss`, and the stdio machinery
underneath it. That is the trade, and now it is a decision rather than a surprise.

### `readelf`, `objdump` and `objcopy`

`readelf -l` explains the one thing that confuses every beginner looking at an
embedded ELF: why `.data` has *two* addresses.

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

`.data` has a *virtual* address in RAM (`0x20000000`) and a *load* address in flash
(`0x0800009d`). The startup code copies it. This is why your flash image is bigger
than your RAM usage, and why a `.data` array that grows silently eats flash.

`objdump -d` is how I read what the compiler actually did. Thumb-2 is surprisingly
readable:

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

And `objcopy` converts between the formats the outside world wants — Intel HEX
for an AVR programmer, a raw `.bin` for `esptool`, or a single section extracted
for inspection:

```console
$ arm-none-eabi-objcopy -O binary fw.elf fw.bin   # 173 bytes: text + data
$ arm-none-eabi-objcopy -O ihex   fw.elf fw.hex   # 14 lines of Intel HEX
:020000040800F2
:100000004FF08042136843F40053136070474FF081
```

## The serial console, and the first thing you should buy

A **serial console** is the cheapest debugger ever invented: the target prints
text, you type text back, and you can watch a device boot from the first
instruction when nothing else works. `picocom` is what I reach for — tiny, no
config files, exits cleanly. `minicom` is the same job with a 1990s menu system.
`socat` is the most useful of the three: it creates *virtual* serial ports, so you
can practise the whole workflow with no hardware at all.

Here is a real pty pair, a fake device on one end, and `picocom` on the other:

```console
$ socat pty,raw,echo=0,link=./ttyA pty,raw,echo=0,link=./ttyB &
$ printf '\nversion\nhelp\n' | script -qec "picocom -q -b 115200 ./ttyB" /dev/null
fw 0.3 / hw rev C / uid 7c:df:a1:xx
commands: version help reset
```

(`script` is there only to give `picocom` a real terminal; `picocom` refuses to
run without one.) Three settings explain 90% of "nothing appears" problems:

- **Baud.** Both ends must agree. 115200 is the modern default; 9600 still exists
  on older gear. Wrong baud gives you plausible-looking garbage, not silence.
- **8N1.** Eight data bits, no parity, one stop bit, in that order, LSB first.
- **Flow control off.** Hardware flow control (`RTS`/`CTS`) that the target does
  not drive will hang your console mid-boot. Start with it off.

This is also why a **USB-to-serial adapter is the first thing I would buy**, ahead
of any probe. It is the one interface every board has, it is the one that survives
a bricked firmware, and it is the only one that tells you *why* the device is not
booting. If you are choosing a board to learn on, a devkit with a built-in USB-UART
bridge removes even that purchase — see how the
[ESP32-C3 devkit](/posts/esp32-c3-getting-started/) does it.

## The logic analyzer and sigrok: seeing the wire

When the console says nothing, you move down a layer and look at the pins. A
**logic analyzer** records the 0/1 state of several wires at once; `sigrok` (with
its GUI, PulseView) decodes those voltages into bytes. That decoding loop — find
the bus, find the baud rate, form a hypothesis, change one input — is its own
skill, and I wrote the method up in
[decoding a serial protocol with a logic analyzer](/posts/decoding-a-serial-protocol/).
What I want to show here is the *tool* being real, not hypothetical.

I generated a VCD waveform from the exact bytes the fake device printed above, and
handed it to `sigrok-cli`:

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

`66 77 20 30 2E 33` is `f w space 0 . 3` — the bytes came back out of the
waveform. The same binary decodes I²C, SPI, CAN, JTAG and more, and the file
formats it reads include VCD, CSV and raw binary, so a capture from a $10 clone
and one from a name-brand unit end up in the same workflow. When you are not sure
which pin is which, the analyzer is what tells you — I have done the same thing on
a CAN bus, described in [CAN bus and virtual CAN](/posts/can-bus-and-virtual-can/).

## Debugging: gdb, OpenOCD, and strace on Linux targets

`gdb` is the debugger; **OpenOCD** is the piece that turns a `gdb` connection into
SWD or JTAG traffic on a hardware probe. The loop is: OpenOCD owns the probe and
listens on a TCP port; `gdb` speaks its remote protocol to that port. OpenOCD
starts even with nothing plugged in, which is the honest picture of this machine:

```console
$ openocd -f interface/stlink.cfg -f target/stm32f4x.cfg
Open On-Chip Debugger 0.12.0
Info : auto-selecting first available session transport "hla_swd".
Info : Listening on port 6666 for tcl connections
Info : Listening on port 4444 for telnet connections
Info : clock speed 2000 kHz
Error: open failed
```

`Error: open failed` is the probe that is not there. On a real bench, that line
instead prints the detected target and its IDCODE, and then `gdb` takes over:

```console
$ gdb -q -batch -ex 'file fw.elf' -ex 'target extended-remote localhost:3333' \
      -ex 'monitor reset halt' -ex 'load' -ex 'bt' ./fw.elf
could not connect: Connection timed out.
You can't do that when your target is `exec'
```

Two things are worth noticing even in the failure. First, `gdb` read the ELF
perfectly — it knows `.text` at `0x08000000`, `.data` at `0x20000000`, `.bss`
right after. Second, `monitor` commands only work once a *remote* target is
attached; the `exec` file is not a target. That distinction is the whole mental
model of OpenOCD.

If your "embedded" target is actually Linux — a Raspberry Pi, a router, an SBC —
you can skip the probe entirely, because the kernel is your debugger. `strace`
shows syscalls, `ltrace` shows library calls, and both are *installed on the
target*, not the host:

```console
$ strace -e trace=openat,read ./linux_target
openat(AT_FDCWD, "/etc/hostname", O_RDONLY) = 3
read(3, "ae5ea6798a32\n", 63)           = 13
openat(AT_FDCWD, "/proc/uptime", O_RDONLY) = 3
read(3, "228366.98 1448887.04\n", 1024) = 21
```

That is a real trace of a real program on this box. On a target it is the fastest
way to answer "which file is it failing to open at boot?" — a question no logic
analyzer can answer.

## Flashing: esptool, avrdude, dfu-util

Each chip family has its own loader, and you should learn the one your board
speaks. `esptool` covers Espressif:

```console
$ esptool version
esptool v5.4.0

$ esptool --chip esp32c3 --port /dev/ttyUSB0 read-mac
ERROR: A fatal error occurred: Could not open /dev/ttyUSB0, the port is busy or doesn't exist.

$ esptool --chip esp32c3 merge-bin -o factory.bin --flash-size 4MB 0x10000 fw.bin
Wrote 0x100ad bytes to file 'factory.bin', ready to flash to offset 0x0.
```

The first is the error you get with no board attached — honest, and useful because
it names the port it tried. The second is real work: `merge-bin` combined a
bootloader offset and our compiled `fw.bin` into one 65,709-byte image. For AVR,
`avrdude` is the equivalent, and for anything that enumerates as a DFU device,
`dfu-util` is:

```console
$ avrdude -c usbasp -p m328p
avrdude error: cannot find USB device with vid=0x16c0 pid=0x5dc vendor='www.fischl.de' product='USBasp'
avrdude error: unable to open programmer usbasp on port usb
```

Notice how much a failure message tells you: it is looking for a USBasp with a
*specific* VID/PID. When you plug the programmer in and it still fails, that
message is your next search term.

## The bench, in order of value: multimeter, oscilloscope, logic analyzer

This is the part people get wrong, and it is a **multimeter vs oscilloscope vs
logic analyzer** question with a clear answer at each stage.

1. **A multimeter.** First, always, no exceptions. Is the rail 3.3 V? Is the
   ground actually common between the two boards? Is the current draw sane? Most
   "the chip is dead" sessions end with a multimeter and a loose ground lead.
2. **A cheap logic analyzer.** Second, because the question you will actually have
   is *what are these pins saying*, and a 0/1 recorder answers it for the price of
   a meal. Eight channels is plenty.
3. **An oscilloscope.** Third, and only when you need to see a *voltage* rather
   than a *bit*: rise times, ringing, a rail sagging under load, an I²C line that
   never quite reaches the threshold. This is the tool you buy last because it is
   the most expensive and the least often the answer.

I am deliberately not naming models or prices. The bands move every few months and
a specific recommendation ages badly. The *order* does not.

## The honest advice

Buy the cheap tool that answers the question you have **today**. A logic analyzer
you own beats an oscilloscope you are still researching. But be honest about the
other direction too: software skills matter more than the bench, and by a wide
margin. Everything in this article except the actual voltage measurement was done
with free software, on a laptop, with no hardware at all — including the
disassembly, the size accounting, the serial console, the logic decode and the
flashing image. The instrument that changes your outcomes fastest is `size`, then
`nm`, then `objdump`, and they are already installed.

## What I could not run here

Being precise about this matters more than looking thorough:

- **No hardware probe or board.** OpenOCD's `Error: open failed`, `gdb`'s
  `Connection timed out`, `avrdude`'s missing USBasp and `dfu-util`'s empty device
  list are all real output from a machine with nothing attached. I did not fake a
  successful flash.
- **No real logic-analyzer capture.** I have no analyzer here, so the VCD file was
  generated from real bytes with a small script. The *decode* is genuinely sigrok's,
  and the bytes round-tripped, but the waveform is synthesised.
- **`strace`/`ltrace` needed `CAP_SYS_PTRACE`.** They are not installed on this
  host, so I ran them in a container; the trace above is real.
- **The firmware blob is assembled, not dumped.** `firmware-dump.bin` is the real
  `esptool merge-bin` output with a real gzip appended, so that `binwalk`, `strings`
  and `xxd` have something to find:

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

The `0xFF` at offset zero is erased NOR flash, which is what a mostly-empty
firmware dump looks like. That habit — `binwalk` first, `strings` for the secrets,
`xxd` to confirm — is worth having before you ever need it. Which is the whole
point of this list: not to own the tools, but to already know which one answers
the question you are about to have.
