---
title: "Linux 页缓存与 mmap：你的文件读取到底发生在哪里"
description: "文件读取到底发生在哪里？我用 /proc/meminfo 实测 Linux 页缓存，展示冷读与热读 25 倍差距，用 strace 统计 read() 与 mmap() 的系统调用，并演示 msync、fadvise，以及为什么 drop_caches 是错的办法。"
pubDate: 2027-01-25
lang: zh
translationKey: linux-page-cache-and-mmap
tags: [linux]
featured: false
keywords:
  - Linux 页缓存
  - mmap 与 read 对比
  - drop_caches
  - 缺页错误
  - /proc/meminfo
---

几乎每次进程「读取文件」，它都根本没碰磁盘。Linux 的**页缓存**把文件页留在内存里，
所以 `read()` 只是从内存里拷一份出来，只有缓存未命中时才真的去访问设备。这一个事实
解释了「第二次运行为什么快」，解释了为什么 `free` 显示几乎没空闲而机器却毫无异样，
也解释了真正的磁盘 I/O 究竟发生在哪。我想让这套机制可见，而不是当传说，所以下面每个
数字都是在一台真实机器上测的，输出都是我实际抓下来的。

先说我是怎么测的，因为它影响一切。我的测试机是一台 8 核 Arch 机器，12 GB 内存但
只有约 3 GB *可用*——它跑着别的东西，而且在用 swap，所以确实有内存压力。测试文件放在
`/var/tmp` 下的 ext4 上，**不是** `/tmp`，因为这里的 `/tmp` 是 tmpfs（内存后端），从它
读永远走不到我想展示的磁盘路径。又因为我不是 root，跑不了
`echo 3 > /proc/sys/vm/drop_caches`。所以我不靠 `drop_caches`，而是用
`posix_fadvise(POSIX_FADV_DONTNEED)` 来产生可重复的*冷*读，它不需要任何权限就能驱逐
一个文件的页。事实证明这正是整个故事的关键。

## 页缓存到底是什么

进程调用 `read(fd, buf, n)` 时，内核给你的并不是磁盘上的某个扇区。它先在页缓存里找那
一页；在，就把页**拷**进你的缓冲区然后返回。只有未命中时，它才调度真正的 I/O，等设备，
填上缓存页，然后才拷出来。所以 `read()` 是两件事粘在一起：**查缓存（一次内存拷贝）**和
**读盘（仅未命中时）**。`mmap()` 把这两者拆开，这正是本文余下部分的意义。

缓存在两个地方可见。`/proc/meminfo` 直接计数，`free` 做汇总。下面是这台机器在有轻量
文件 I/O 时抓的 `/proc/meminfo` 头部：

```console
$ sed -n '1,6p' /proc/meminfo
MemTotal:       12117272 kB
MemFree:          375512 kB
MemAvailable:    2882180 kB
Buffers:           83908 kB
Cached:          4103072 kB
```

`Cached` 是约 4 GB 的文件页驻留在内存；`MemFree` 只有约 367 MB。机器并不需要 `MemFree`
很大——缓存页是可回收的，所以诚实的数字 `MemAvailable` 是约 2.8 GB。我们稍后会回来看
为什么这个区别重要，因为它恰恰是互联网上被误读最多的一个字段。

## 看缓存填满又被放空

下面让缓存抓住一个文件再放走。我分配一个 256 MiB 的文件（写入时它就进了缓存），用
`fadvise(DONTNEED)` 驱逐它，再从磁盘冷读回来。在每一步附近紧凑采样 `Cached` 与 `free`
各列：

```console
$ LC_ALL=C free -w && grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
               total        used        free      shared     buffers       cache   available
Mem:        12117272     9031124     1271868     1180368      159956     3222520     3086148
Cached:          2922404 kB      # 文件刚写入 -> 常驻
Dirty:                 0 kB
MemAvailable:    3094452 kB

$ ./evict testfile.grow      # posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)
$ LC_ALL=C free -w && grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
               total        used        free      shared     buffers       cache   available
Mem:        12117272     9030224     1509212     1180368      159956     2986072     3087048
Cached:          2685956 kB      # -231 MiB，约等于文件，已从缓存消失
Dirty:                 0 kB
MemAvailable:    3086788 kB      # <-- 几乎没动

$ ./cread testfile.grow      # 冷 read()，从磁盘把它拉回来
[read] bytes=268435456 read_calls=2048 minflt=153 majflt=0 elapsed=0.6081s
$ grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
Cached:          2945800 kB      # +254 MiB，从磁盘重新填回
Dirty:               932 kB
```

两点要注意。`fadvise(DONTNEED)` 让 `Cached` 掉了 231 MiB，几乎正好是文件大小，证明那些
页*确实*就是缓存。而冷 `read()` 又放回 254 MiB。但看这一切发生时 `free` 和 `available`
两列：裸 `free` 在 1.2 到 1.5 GB 之间跳，而 `MemAvailable` 全程钉在约 3.08 GB。这就是教
训：**缓存内存本来就是「空闲」的；`free` 不是该去最大化的东西。**当内核需要这块内存时，
几微秒内就能把缓存丢掉。

## 为什么第二次运行快

同一个 512 MiB 文件，同一个 `read()` 循环，唯一差别：冷跑那次我先驱逐，热跑不驱逐。这
就是全部要点：

```console
$ ./evict testfile.512M && ./cread testfile.512M          # 冷（来自磁盘）
[read] bytes=536870912 read_calls=4096 minflt=153 majflt=0 elapsed=1.6509s
$ for i in 1 2 3; do ./cread testfile.512M; done           # 热（来自缓存）
[read] bytes=536870912 read_calls=4096 minflt=150 majflt=0 elapsed=0.0688s
[read] bytes=536870912 read_calls=4096 minflt=151 majflt=0 elapsed=0.0675s
[read] bytes=536870912 read_calls=4096 minflt=150 majflt=0 elapsed=0.0643s
```

冷 1.65 s 对热 0.066 s——约 **25 倍**，即磁盘约 325 MiB/s 对内存约 7.8 GiB/s。两次都发出
同样 4096 次 `read()`；唯一变的是这些调用是否命中已常驻的页。这就是「页缓存在干活」的两
个数字。如果你曾靠把工具跑两次再取第二次来「跑分」，你多半量的是缓存。（当工作集超出内
存，每次都是冷的，你就回到了我在[磁盘 I/O 延迟排障](/zh/posts/io-latency/)里写的那片
磁盘瓶颈地带。）

## mmap 与 read()：系统调用、拷贝、缺页

`read()` 把缓存页拷进你的缓冲区，每块一次系统调用。`mmap()` 把文件映射进你的地址空间，
让内核用*同一批*缓存页来支撑这些虚拟地址——然后首次触碰时一次**缺页错误**把页就地取入，
没有拷贝。系统调用和拷贝都更少，代价是缺页，以及几处尖锐的边角。

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="read() 把每个块从页缓存拷进用户缓冲区，每块一次系统调用加一次拷贝。mmap() 把文件页直接映射进进程地址空间，用缺页错误把它们取入，零拷贝。">
  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="0" y="14" fill="#0f766e" font-weight="700">read(path)</text>
    <rect x="0" y="26" width="176" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <text x="12" y="46" opacity="0.9">page cache</text>
    <text x="12" y="62" font-size="10" opacity="0.6">file pages in RAM</text>
    <line x1="180" y1="50" x2="256" y2="50" stroke="currentColor" stroke-width="1.4"/>
    <polygon points="256,50 248,46 248,54" fill="currentColor"/>
    <text x="188" y="42" font-size="10" fill="#0f766e">read()</text>
    <text x="188" y="94" font-size="10" opacity="0.6">1 syscall/chunk + a copy</text>
    <rect x="260" y="26" width="176" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <text x="272" y="46" opacity="0.9">your buffer</text>
    <text x="272" y="62" font-size="10" opacity="0.6">userspace RAM</text>
    <line x1="440" y1="50" x2="470" y2="50" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
    <text x="470" y="46" font-size="10" opacity="0.6">milk each page</text>
    <text x="470" y="62" font-size="10" opacity="0.6">into the cpu cache</text>
  </g>
  <g font-family="ui-monospace, monospace" font-size="12" fill="currentColor">
    <text x="0" y="150" fill="#0f766e" font-weight="700">mmap(path)</text>
    <rect x="0" y="164" width="150" height="92" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
    <text x="12" y="184" opacity="0.9">page cache</text>
    <line x1="150" y1="182" x2="470" y2="176" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>
    <line x1="150" y1="204" x2="470" y2="212" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>
    <line x1="150" y1="226" x2="470" y2="248" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>
    <text x="196" y="164" font-size="10" fill="#0f766e">page table entries point here</text>
    <rect x="470" y="164" width="170" height="92" rx="4" fill="none" stroke="#0f766e" stroke-width="1.4"/>
    <text x="482" y="184" fill="#0f766e">your address space</text>
    <text x="482" y="204" font-size="10" opacity="0.75">PTEs alias the cache</text>
    <text x="482" y="218" font-size="10" opacity="0.75">pages directly</text>
    <text x="482" y="242" font-size="10" opacity="0.6">minor fault / page</text>
    <text x="0" y="278" font-size="10" opacity="0.6">1 mmap() syscall, then page faults pull pages straight in — no copy</text>
  </g>
</svg>
<figcaption><code>read()</code> 为每个块付一次系统调用加一次 <code>memcpy</code>，把文件页搬进你的缓冲区。<code>mmap()</code> 付一次系统调用，然后每页一次缺页错误，把缓存页直接接进你的地址空间——同样的字节，没有中间拷贝。缺页路径才是 mmap 这一侧诚实的代价：它不免费，只是把工作从系统调用挪进了 MMU。</figcaption>
</figure>

数系统调用把这个取舍落到实处。同一个 512 MiB 文件，用
`strace -c -e trace=read,mmap,pread64` 追踪（在一个一次性的 `debian` 容器里跑，因为这
台机器没有 `strace`，而我不想在系统里装一个）：

```console
########## read() path ##########
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
100.00    0.056065          13      4098           read
  0.00    0.000000           0         8           mmap
  0.00    0.000000           0         2           pread64
------ ----------- ----------- --------- --------- ----------------
100.00    0.056065          13      4108           total

########## mmap() path ##########
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
  0.00    0.000000           0         1           read
  0.00    0.000000           0         9           mmap
  0.00    0.000000           0         2           pread64
------ ----------- ----------- --------- --------- ----------------
100.00    0.000000           0        12           total
```

`read()` 那个程序发出 **4098 次 `read()`** 来搬完文件。`mmap()` 那个程序一共**12 次系
统调用**（1 次是真映射，其余是加载器自己的 `mmap`）。数据搬移去哪了？搬进了**缺页错误**
里，而它*不是*系统调用，所以 `strace -c` 不计数。我的程序从 `getrusage` 读它们：
`read()` 路径缺页 103 次（只是它那个 128 KiB 缓冲区和 libc），`mmap()` 路径缺页 5572
次。这个数低于文件里 131072 页，是因为 Linux 的**fault-around** 会在每次文件缺页时映射
约 64 KiB 一整片邻域，所以一次缺页大约服务 16 页。同样的字节，`read()` 用 4098 次系统
调用加一次拷贝搬完，`mmap()` 用寥寥几次系统调用加几千次缺页搬完。

在大的顺序文件上，`mmap()` 也赢在计时器上，因为它省掉了那次拷贝。冷 64 MiB 文件，触碰
同样字节：

```console
$ ./evict testfile.64M; python3 -c "...os.read loop..."   # read()
  read() : 0.1705s  (64 MiB)
$ ./evict testfile.64M; python3 -c "...mmap, touch..."    # mmap()
  mmap  : 0.1390s  (64 MiB)
```

## mmap 不适合小读

`mmap()` 有单次 `read()` 没有的固定开销：`mmap`、那次缺页，以及 `munmap`（它会强制一次
TLB shootdown）。对单页文件这点占据主导。在一个热的 4 KiB 文件上各测 20 万次：

```console
$ python3 tiny.py tiny.bin
N=200000 iterations on a 4096-byte file (warm cache):
  read()+close :     4588 ns/op
  mmap()+close :    12568 ns/op
  mmap is 2.7x the fixed cost of a single read()
```

映射一次、读很多页，`mmap()` 就划得来；为几个字节反复 open-map-touch-munmap 就纯是开
销。`mmap()` 在**对大文件的随机访问**上闪光——数据库、搜索索引——否则你得每页发一次
`pread()` 系统调用，只为看一眼就把它拷出来。要顺序流式读完整个文件，`read()` 就挺好。

## 写：脏页、回写与 msync

通过 `mmap()` 的写也不落到磁盘——它们在缓存里弄脏页然后立即返回。`msync(MS_SYNC)` 才是
把它们逼出去的东西（`mmap` 版的 `fsync`）。下面是一次真实的 256 MiB 文件 `mmap` 写，
在每个阶段采样 `/proc/meminfo` 的 `Dirty`，并校验这些字节在往返到磁盘后完好：

```console
$ ./mmapwrite mmapdemo.bin 256
file=mmapdemo.bin len=256MiB
  Dirty before      : 228 kB
  write into mmap   : 1.3165 s (pages now dirty in cache)
  Dirty after write : 157664 kB
  msync(MS_SYNC)    : 1.0177 s (writeback to disk)
  Dirty after msync : 1196 kB
  verify mismatch   : 0
```

写进映射弄脏了约 154 MiB 页（耗时 1.3 s——首次触碰新文件上的 `MAP_SHARED` 映射会为每页分
配并清零，所以不是纯 `memcpy`），`Dirty` 随之上升。然后 `msync(MS_SYNC)` 实打实花了一秒
把这些页写回磁盘，`Dirty` 塌回约 1 MiB。数据随后逐位校验一致。这就是页缓存的写一侧：存
在内存里很快，直到你要持久性；而 `vm.dirty_background_ratio` / `vm.dirty_ratio`（这里
是 `10` 和 `20`）决定内核何时自己开始刷。太低就老是刷，太高就一口气砸下一个大失速。调这
几个值是我早期[io-延迟那篇](/zh/posts/io-latency/)的主题，这里不重复。

有一个尖锐的边角值得点名：如果映射比磁盘上的文件活得更久，或者磁盘满了，那一页根本不在
那里，触碰映射就会抛 `SIGBUS`。用 `read()` 时缺页是干净的错误返回；用 `mmap()` 它是一个
能杀死进程的信号。如果文件可能在脚下缩水或消失，映射它之前先处理好这件事。

## drop_caches：陷阱，以及该换用什么

网上爱把 `sync; echo 3 > /proc/sys/vm/drop_caches` 当「修复」。在这台机器上我连用都用不
了：

```console
$ ls -l /proc/sys/vm/drop_caches && echo 3 > /proc/sys/vm/drop_caches
--w------- 1 root root 0 ... /proc/sys/vm/drop_caches
zsh:1: 权限不够: /proc/sys/vm/drop_caches
```

只有 root 能写，这本就是对的默认。`drop_caches` 丢掉的是*好*缓存；下一次读再把它填回来
——更慢，且毫无收益。它是用来测冷缓存行为的调试工具，不是性能旋钮。要驱逐单个文件的页，
无权限的工具是 `posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)`，上面每一个「冷读」正是
这么造出来的。

另一些建议型提示也值得知道。`POSIX_FADV_SEQUENTIAL` 让预读翻倍并在后方丢弃；
`POSIX_FADV_RANDOM` 关掉预读；`POSIX_FADV_WILLNEED` 请求内核预取。我在这里实测了
`WILLNEED`，结果是个哑炮——在这台有内存压力的机器上，`fadvise(WILLNEED)` 只让 `Cached`
动了约 5 MiB，随后那次读依然走了磁盘（0.76 s）：

```console
$ ./evict testfile.grow; grep Cached /proc/meminfo      # DONTNEED 之后
  after DONTNEED : Cached=3732 MiB
$ python3 -c "os.posix_fadvise(fd,0,0,POSIX_FADV_WILLNEED)"; sleep 2
$ grep Cached /proc/meminfo
  after WILLNEED : Cached=3737 MiB      # +5 MiB：几乎没被理会
$ ./cread testfile.grow
[read] ... elapsed=0.7649s ...          # 仍然命中磁盘
```

`madvise()` 是 `mmap()` 地址空间版的对应物（`MADV_WILLNEED`、`MADV_SEQUENTIAL`、
`MADV_RANDOM`、`MADV_DONTNEED`），语义相同。把它们每一个都当成*提示*：内核可以无视，而
这里它确实无视了。别设计出依赖某个提示被兑现的方案。

## 诚实的规则

从数字里退一步看：

- **让缓存干活。**一台读了文件然后看起来很「满」的机器，工作得*完全正确*。盯
  `MemAvailable`，别盯 `MemFree`。
- **别在生产用 `drop_caches`。**它是调试工具，在这里只有 root 能用是有道理的，它只会让
  下一次读更慢。
- **大文件的随机访问、以及大文件顺序读时省掉一次拷贝，用 `mmap()`。别用于小读**——4 KiB
  文件上是 2.7 倍开销。
- **一次大 `read()` 胜过大把小 `read()`**，对大文件的随机跳转用 `mmap()` / `pread()`，
  而不是 `read()`。
- **只在需要持久性的地方 `msync`/`fsync`。**否则你是在花钱让磁盘去证明一件缓存里已经
  有的事。

贯穿始终的一点：**`read()` 是一次系统调用加一次拷贝；`mmap()` 是一次映射加一次缺页；页
缓存垫在两者底下，几乎总是在真正给你送字节的那个东西。**一旦你能在 `/proc/meminfo` 里
看见它、能用 `strace -c` 数出它的系统调用，「第二次更快」就不再是谜，而是算术。而当工作
集真的超过内存，每次读都是冷的，你就回到磁盘延迟的世界——那本身就是另一整篇
[关于负载平均值为什么骗人](/zh/posts/linux-load-average/)的文章。
