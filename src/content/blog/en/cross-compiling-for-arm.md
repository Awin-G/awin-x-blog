---
title: "Cross-compiling for ARM: building on x86 for another machine"
description: "A cross toolchain whose target triple differs from the host lets you build ARM binaries on an x86 box. I compile for armhf and aarch64, verify with file and readelf, hit the real Exec format error, and run it under qemu-user."
pubDate: 2027-02-16
lang: en
translationKey: cross-compiling-for-arm
tags: [embedded, c]
featured: false
keywords:
  - cross-compiling
  - ARM toolchain
  - aarch64 gcc
  - sysroot
  - target triple
---

I have a small x86 box, a pile of ARM boards, and a chronic intolerance for
compiling on the slow machine. This is a field report on **cross-compiling**:
building ARM binaries on an x86-64 host with a real **ARM toolchain**, verifying
what came out, watching it refuse to run locally, and running it anyway under
emulation. Everything below actually ran — no invented output.

This blog has already wandered into embedded land with the
[ESP32-C3 EasyTier node in C](/posts/esp32-easytier-node-in-c/) and
[getting started with the ESP32-C3](/posts/esp32-c3-getting-started/). Those
projects cross-compile too, but through a vendor SDK that hides the machinery.
This post is about the machinery: bare `gcc`, an `aarch64 gcc` target, and a
**sysroot**.

## What cross-compiling actually is

Cross-compiling means one thing: **the toolchain's target triple differs from
the host's architecture**. A triple like `arm-linux-gnueabihf` reads as
`machine-vendor-os-abi`:

- `arm` / `aarch64` — the target CPU (32-bit ARMv7 vs 64-bit ARMv8)
- `linux` — the target OS
- `gnueabihf` — the ABI: GNU libc, Embedded ABI, hard-float

If the triple's machine part matches your kernel's `uname -m`, you are
compiling natively. If it doesn't, you are cross-compiling. My host is
`x86_64`, so everything with a non-`x86_64` machine is a cross build:

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

Why bother? The board that runs the binary is slow and usually busy being a
router or a sensor node; an x86 build machine compiles 5–20× faster, and the
toolchain installs in one `apt-get`. The cost is that you no longer get to
*run* anything you build — more on that below.

<figure>
<svg viewBox="0 0 720 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Host x86-64 machine runs a cross compiler that emits an ARM ELF binary for the target board">
  <rect x="20" y="80" width="150" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="95" y="115" text-anchor="middle" font-size="15" fill="currentColor">x86-64 host</text>
  <text x="95" y="138" text-anchor="middle" font-size="12" fill="#0f766e">build machine</text>
  <text x="95" y="156" text-anchor="middle" font-size="11" fill="currentColor">where gcc runs</text>

  <line x1="180" y1="125" x2="290" y2="125" stroke="#0f766e" stroke-width="2" marker-end="url(#ar)"/>
  <text x="235" y="110" text-anchor="middle" font-size="11" fill="#0f766e">hello.c</text>

  <rect x="290" y="70" width="190" height="110" rx="8" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="385" y="105" text-anchor="middle" font-size="15" fill="currentColor">cross compiler</text>
  <text x="385" y="127" text-anchor="middle" font-size="12" fill="#0f766e">arm-linux-gnueabihf-gcc</text>
  <text x="385" y="145" text-anchor="middle" font-size="12" fill="#0f766e">aarch64-linux-gnu-gcc</text>
  <text x="385" y="167" text-anchor="middle" font-size="11" fill="currentColor">target triple = target, not host</text>

  <line x1="490" y1="125" x2="600" y2="125" stroke="#0f766e" stroke-width="2" marker-end="url(#ar)"/>
  <text x="545" y="110" text-anchor="middle" font-size="11" fill="#0f766e">ARM ELF</text>

  <rect x="600" y="80" width="100" height="90" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="650" y="115" text-anchor="middle" font-size="15" fill="currentColor">ARM</text>
  <text x="650" y="138" text-anchor="middle" font-size="12" fill="#0f766e">board</text>
  <text x="650" y="156" text-anchor="middle" font-size="11" fill="currentColor">Pi / router / MCU</text>

  <text x="360" y="230" text-anchor="middle" font-size="11" fill="currentColor">the host never runs the output — that is the whole trade</text>
  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>Cross-compiling: the compiler runs on x86-64, but every byte it emits targets ARM.</figcaption>
</figure>

## The ARM toolchain: installing it and what you get

On Debian and Ubuntu the cross toolchains are packaged — no downloading
tarballs, no building bootstrap compilers. In a throwaway Debian trixie
container:

```text
# apt-get install -y gcc-arm-linux-gnueabihf gcc-aarch64-linux-gnu
```

That pulls the full triplet of packages: `gcc-14-arm-linux-gnueabihf` (the
compiler), `binutils-arm-linux-gnueabihf` (assembler and linker), and
`libc6-dev-armhf-cross` (the target's headers and libc for linking). Each tool
carries its triple as a prefix, so `arm-linux-gnueabihf-gcc`,
`arm-linux-gnueabihf-objdump`, and `aarch64-linux-gnu-gcc` all sit side by side
in `/usr/bin`.

One question comes up immediately: **glibc or musl?** The packaged cross
toolchains are glibc — here, `libc6-armhf-cross` is version `2.41-11cross1`,
i.e. glibc 2.41. Debian ships no musl cross variant; a musl cross toolchain is
a separate install (the `musl.cc` prebuilts, or Alpine's packages). Which one
you need is dictated by the *target's* userland, not by your taste — see the
linking section.

## Verifying the target: file, readelf, objdump

I built the same trivial program for all three architectures. The source is a
`main` plus one small hash function, with a preprocessor test so it names its
own architecture:

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

Three invocations, three different machines:

```text
$ gcc               -O2 -o hello-native       hello.c
$ arm-linux-gnueabihf-gcc -O2 -o hello-armhf hello.c
$ aarch64-linux-gnu-gcc   -O2 -o hello-aarch64 hello.c

$ file hello-native hello-armhf hello-aarch64
hello-native:   ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, ...
hello-armhf:    ELF 32-bit LSB pie executable, ARM, EABI5 version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-armhf.so.3, ..., for GNU/Linux 3.2.0, not stripped
hello-aarch64:  ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, ..., for GNU/Linux 3.7.0, not stripped
```

Same source, same host, same day — and `file` reports three separate worlds:
`x86-64`, `ARM EABI5`, `ARM aarch64`, each with its own dynamic loader
(`ld-linux-armhf.so.3` vs `ld-linux-aarch64.so.1`). The `EABI5` and
`hard-float ABI` tokens on the armhf build *are* the `eabihf` part of the
triple showing through, and the `for GNU/Linux 3.2.0` note is the minimum
kernel ABI the toolchain stamps in.

For the machine-level facts, `readelf -h` is the tool that never lies about a
target:

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

And the ARM-specific attributes — what a bare architecture string will not tell
you — live in `readelf -A`:

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

`v7` + `VFPv3-D16` + `VFP registers` is the toolchain announcing that it emits
hard-float code for an ARMv7-A class CPU. What actually lands on the board is
still worth checking, though — the disassembly of `main` mixes Thumb-2 and
32-bit instruction encodings, with no floating point in this integer program:

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

This is the step people skip, and it is the cheapest verification you have:
before the binary ever leaves the build machine, `file` and `readelf` confirm
the target.

## Static vs dynamic, and the libc that has to match

By default the cross compiler produces a dynamically linked binary that needs
two things from the *target*: the dynamic loader (`/lib/ld-linux-armhf.so.3`,
visible in `readelf -l`) and a matching libc:

```text
$ arm-linux-gnueabihf-readelf -d hello-armhf | grep NEEDED
 0x00000001 (NEEDED)                     Shared library: [libc.so.6]
```

`-static` removes both dependencies by linking the (static) libc into the
binary. Sizes, same source, same flags apart from `-static`:

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

A 7× size increase is the honest price of not shipping libc with your program.
In exchange, a static binary runs on any board with a matching kernel ABI and
no loader in sight — which is exactly why routers and initramfs images tend to
be static.

The trap that catches everyone is the **libc mismatch**. The cross toolchain
here links against glibc 2.41. If the target is a Raspberry Pi OS two releases
old (glibc 2.31), your binary can demand symbols the target's libc does not
export, and the failure appears only on the board, at runtime:
`version 'GLIBC_2.34' not found`. Two rules follow:

1. The cross toolchain's libc must be **no newer** than the target's.
2. If the target runs musl (Alpine, OpenWrt), a glibc cross compiler cannot
   produce a working binary at all — you need a musl cross toolchain, because
   the ABI and the dynamic loader name are different.

## --sysroot: pointing the compiler at the target's filesystem

`--sysroot` says "when you go looking for headers and libraries, look under
this directory as if it were `/`". The default sysroot of the Debian cross
compilers is `/` — the target libs simply live in `/usr/arm-linux-gnueabihf`:

```text
$ arm-linux-gnueabihf-gcc -print-sysroot
/
$ arm-linux-gnueabihf-gcc -print-file-name=libc.so
/usr/lib/gcc-cross/arm-linux-gnueabihf/14/../../../../arm-linux-gnueabihf/lib/libc.so
```

Which produces the classic beginner trap — "I'll just point `--sysroot` at
that directory":

```text
$ arm-linux-gnueabihf-gcc --sysroot=/usr/arm-linux-gnueabihf -O2 -o hello-sysroot hello.c
/usr/lib/gcc-cross/arm-linux-gnueabihf/14/../../../../arm-linux-gnueabihf/bin/ld: cannot find /usr/arm-linux-gnueabihf/lib/libc.so.6 inside /usr/arm-linux-gnueabihf
collect2: error: ld returned 1 exit status
```

A sysroot is a *root*: a tree with `lib/`, `usr/include/` at its top, not the
name of a prefix directory. The realistic use is a sysroot captured from the
target itself (`rsync` the board's `/lib` and `/usr/include` into a directory)
or shipped by a vendor SDK. Given a proper tree, it links straight through —
and the same tree doubles as the runtime root for emulation:

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

The `sizeof(void*)=4` in the output is the quiet proof of the whole exercise:
32-bit ARM, on an x86 host.

## The moment you try to run it on x86

The kernel checks the ELF header's machine field against its own architecture
and refuses anything else. No compatibility mode, no warning — just the raw
answer:

```text
$ ./hello-armhf
sh: 1: ./hello-armhf: Exec format error

$ echo $?
126
```

That is not a mistake in your build; it is the build working as intended.
`Exec format error` on execution, every time, is the sound of a real cross
compile. The loop that remains is: build on x86, ship, test on the board —
which is slow, and why the next trick exists.

## qemu-user: running the ARM binary on x86

`qemu-arm-static` (from `qemu-user-static`) is user-mode emulation: it loads
the ARM ELF, translates the instructions, and forwards syscalls to the host
kernel. A dynamically linked binary still needs the target's dynamic loader,
which is what `-L <sysroot>` provides:

```text
$ qemu-arm-static ./hello-armhf
qemu-arm-static: Could not open '/lib/ld-linux-armhf.so.3': No such file or directory

$ qemu-arm-static -L /usr/arm-linux-gnueabihf ./hello-armhf
hello from armhf
acc=705963138 sizeof(void*)=4
```

A static ARM binary needs no loader at all and runs with no `-L`:

```text
$ qemu-arm-static ./hello-armhf-static
hello from armhf
acc=705963138 sizeof(void*)=4
```

Same program, aarch64, same drill:

```text
$ qemu-aarch64-static -L /usr/aarch64-linux-gnu ./hello-aarch64
hello from aarch64
acc=4246834716217250274 sizeof(void*)=8
```

`sizeof(void*)=8` — 64-bit ARM this time. One wrinkle worth knowing about this
particular dev box: it has qemu registered in the kernel's `binfmt_misc`, so
executing an aarch64 ELF *directly* silently goes through emulation:

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

Note that only `qemu-aarch64` is registered here, which is exactly why the
armhf binary above failed with the raw `Exec format error`. `binfmt`
emulation is a convenience, not a guarantee: your build machine cannot be
trusted to reproduce the board's failures if emulation intercepts them
differently. Use qemu as a fast smoke test; keep the real board as the judge.

## The build-system angle: CROSS_COMPILE and toolchain files

Hand-typed compiler invocations do not survive contact with a project. The
Makefile convention is that the cross prefix is an overridable variable:

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

`CROSS_COMPILE` lets one Makefile serve native debug builds (`make`) and
release cross builds (`make CROSS_COMPILE=aarch64-linux-gnu-`), which is the
pattern the Linux kernel and U-Boot use everywhere.

For CMake, the equivalent is a **toolchain file** passed at configure time:

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

I learned the sysroot lesson twice on the way here: setting
`CMAKE_SYSROOT /usr/aarch64-linux-gnu` in that file (which *looks* right —
that is where the target libs are) makes CMake pass
`--sysroot=/usr/aarch64-linux-gnu` to the compiler, the linker then looks for
`libc.so.6` *inside* that path, and the failure is the same triple
`cannot find ... inside ...` error as before. On Debian and Ubuntu, leave
`CMAKE_SYSROOT` unset and use `CMAKE_FIND_ROOT_PATH` for *CMake's own* find_
commands only. `CMAKE_SYSTEM_NAME` plus the compiler prefix is all that is
needed to switch everything else.

## When you should NOT cross-compile

Honest advice, because cross-compiling is a trade, not religion:

- **Just build on the target when the target can.** A Raspberry Pi 5 compiles
  small C projects in seconds, and you get the target's exact kernel, libc, and
  headers for free. No sysroot traps, no libc version archaeology, and what you
  test is what you ship.
- **Or build in a container for the target architecture** — e.g.
  `docker run --platform linux/arm64` (with qemu `binfmt` registered on the
  host) gives you a full, native-feeling arm64 userland: `apt install gcc`
  inside, and the build is indistinguishable from running on the real board.
- **Cross-compile when the target is constrained** — a router with 64 MB of
  RAM and 8 MB of flash, a board with no OS, or a CI pipeline that must
  produce many architectures without many runners. That is where the
  5–20× compile speed pays for itself, and `qemu-user` covers the quick
  smoke tests.

What never changes, whichever way you build: verify the artifact (`file`,
`readelf`), know which libc it holds, and never assume — check.
