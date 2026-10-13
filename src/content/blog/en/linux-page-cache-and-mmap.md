---
title: "The Linux page cache and mmap: where your file reads really happen"
description: "Where do file reads really happen? I measure the Linux page cache with /proc/meminfo, show a 25x cold-vs-warm read, count read() vs mmap() syscalls with strace, and demonstrate msync, fadvise, and why drop_caches is the wrong tool."
pubDate: 2027-01-25
lang: en
translationKey: linux-page-cache-and-mmap
tags: [linux]
featured: false
keywords:
  - Linux page cache
  - mmap vs read
  - drop_caches
  - page fault
  - /proc/meminfo
---

Almost every time a process "reads a file", it never touches the disk. The Linux
**page cache** keeps file pages in RAM, so `read()` is a copy out of memory and
the device is only involved on a cache miss. That single fact explains why a
"second run" is fast, why `free` says almost nothing is free while the machine
feels fine, and where the real disk I/O actually lives. I want that machinery to
be visible rather than folklore, so every number below is measured on a real box
with output I actually captured.

First, how I measured, because it colours everything. My test box is an 8-core
Arch machine with 12 GB of RAM but only about 3 GB *available* — it runs other
things and is using swap, so it is genuinely memory-pressured. The test files
live on ext4 under `/var/tmp`, **not** `/tmp`, because `/tmp` here is tmpfs (RAM
backed) and reading from it would never exercise the disk path I'm trying to
show. And because I'm not root, I can't run `echo 3 > /proc/sys/vm/drop_caches`.
So instead of `drop_caches` I force repeatable *cold* reads with
`posix_fadvise(POSIX_FADV_DONTNEED)`, which evicts a file's pages without any
privileges. That turns out to be the crux of the whole story.

## What the page cache actually is

When a process calls `read(fd, buf, n)`, the kernel does not hand you a sector
off the disk. It looks for the page in the page cache; if it's there, the kernel
*copies* it into your buffer and returns. Only on a miss does it schedule real
I/O, wait for the device, fill the cache page, and only then copy it out. So
`read()` is two things glued together: **the cache lookup (a memory copy)** and
**the disk read (only on a miss)**. `mmap()` splits those apart, which is the
whole point of the rest of this article.

The cache is visible in two places. `/proc/meminfo` counts it directly, and
`free` summarises it. Here's a raw `/proc/meminfo` header from the box, taken
while light file I/O was in flight:

```console
$ sed -n '1,6p' /proc/meminfo
MemTotal:       12117272 kB
MemFree:          375512 kB
MemAvailable:    2882180 kB
Buffers:           83908 kB
Cached:          4103072 kB
```

`Cached` is ~4 GB of file pages sitting in RAM; `MemFree` is only ~367 MB. The
machine does not need `MemFree` to be large — cached pages are reclaimable on
demand, so `MemAvailable` (the honest number) is ~2.8 GB. We'll come back to
why that distinction matters, because it's the most misread field on the
internet.

## Watching the cache fill and drain

Here is the cache catching a file and letting it go. I allocate a 256 MiB file
(it lands in the cache as it's written), evict it with `fadvise(DONTNEED)`, then
read it back cold (from disk). `Cached` and the `free` columns, sampled tightly
around each step:

```console
$ LC_ALL=C free -w && grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
               total        used        free      shared     buffers       cache   available
Mem:        12117272     9031124     1271868     1180368      159956     3222520     3086148
Cached:          2922404 kB      # file freshly written -> resident
Dirty:                 0 kB
MemAvailable:    3094452 kB

$ ./evict testfile.grow      # posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)
$ LC_ALL=C free -w && grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
               total        used        free      shared     buffers       cache   available
Mem:        12117272     9030224     1509212     1180368      159956     2986072     3087048
Cached:          2685956 kB      # -231 MiB, ~= the file, now gone from cache
Dirty:                 0 kB
MemAvailable:    3086788 kB      # <-- barely moved

$ ./cread testfile.grow      # cold read(), pulls it back off the disk
[read] bytes=268435456 read_calls=2048 minflt=153 majflt=0 elapsed=0.6081s
$ grep -E '^(Cached|Dirty|MemAvailable):' /proc/meminfo
Cached:          2945800 kB      # +254 MiB refilled from disk
Dirty:               932 kB
```

Two things to notice. The `fadvise(DONTNEED)` dropped `Cached` by 231 MiB —
almost exactly the file — proving those pages *were* the cache. And the cold
`read()` put 254 MiB back. But look at the `free` and `available` columns while
all that happened: raw `free` bounced between 1.2 and 1.5 GB, while
`MemAvailable` stayed pinned at ~3.08 GB the entire time. That is the lesson:
**cached memory is already "free"; `free` is a bad thing to try to maximise.**
When the page needs the RAM, the kernel throws the cache away in microseconds.

## Why the second run is fast

Same 512 MiB file, same `read()` loop, one difference: I evicted first for the
"cold" run and didn't for the "warm" runs. This is the whole ballgame:

```console
$ ./evict testfile.512M && ./cread testfile.512M          # COLD (from disk)
[read] bytes=536870912 read_calls=4096 minflt=153 majflt=0 elapsed=1.6509s
$ for i in 1 2 3; do ./cread testfile.512M; done           # WARM (from cache)
[read] bytes=536870912 read_calls=4096 minflt=150 majflt=0 elapsed=0.0688s
[read] bytes=536870912 read_calls=4096 minflt=151 majflt=0 elapsed=0.0675s
[read] bytes=536870912 read_calls=4096 minflt=150 majflt=0 elapsed=0.0643s
```

1.65 s cold vs 0.066 s warm — about **25×**, or ~325 MiB/s off the disk versus
~7.8 GiB/s out of RAM. Both runs issue the same 4096 `read()` calls; the only
thing that changed is whether those calls found pages already resident. That's
"the page cache is doing its job", in two numbers. If you ever benchmark a tool
by running it twice and taking the second time, you are usually measuring the
cache. (When the working set outgrows RAM, every run is cold and you're back in
the disk-bound territory I wrote about in
[disk I/O latency troubleshooting](/posts/io-latency/).)

## mmap vs read(): syscalls, copies, and page faults

`read()` copies cache pages into your buffer, one syscall per chunk. `mmap()`
maps the file into your address space and lets the kernel back those virtual
addresses with the *same* cache pages — then a **page fault** on first touch
pulls the page in place, with no copy. Fewer syscalls and fewer copies, traded
for page faults and a few sharp edges.

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="read() copies each chunk from the page cache into a user buffer, one syscall per chunk plus a copy. mmap() maps the file pages straight into the process address space and pulls them in with page faults, no copy.">
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
<figcaption><code>read()</code> pays one syscall and one <code>memcpy</code> per chunk to walk file pages into your buffer. <code>mmap()</code> pays one syscall and then one page fault per page, wiring the cache page straight into your address space — same bytes, no intermediate copy. The fault path is the honest costs of the mmap side: it isn't free, it just moves the work from syscalls into the MMU.</figcaption>
</figure>

Counting the syscalls makes the trade concrete. Same 512 MiB file, traced with
`strace -c -e trace=read,mmap,pread64` (run inside a throwaway `debian`
container, since this box has no `strace` and I won't install one system-wide):

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

The `read()` program makes **4098 `read()` calls** to move the file. The `mmap()`
program makes **12 syscalls total** (1 for the real mapping, the rest are the
loader's own `mmap`s). Where did the data movement go? Into **page faults**,
which are *not* syscalls, so `strace -c` doesn't count them. My programs read
them from `getrusage`: the `read()` path faulted 103 times (just its 128 KiB
buffer and libc), the `mmap()` path faulted 5572 times. That number is lower
than the 131072 pages in the file because Linux **fault-around** maps a whole
~64 KiB neighbourhood on each file fault, so one fault services ~16 pages. Same
bytes moved; `read()` moves them with 4098 syscalls and a copy, `mmap()` moves
them with a handful of syscalls and a few thousand page faults.

On a large sequential file, `mmap()` also wins the stopwatch because it skips
the copy. Cold 64 MiB file, same bytes touched:

```console
$ ./evict testfile.64M; python3 -c "...os.read loop..."   # read()
  read() : 0.1705s  (64 MiB)
$ ./evict testfile.64M; python3 -c "...mmap, touch..."    # mmap()
  mmap  : 0.1390s  (64 MiB)
```

## mmap is wrong for tiny reads

`mmap()` has fixed overhead that a single `read()` doesn't: `mmap`, the fault,
and `munmap` (which forces a TLB shootdown). For a one-page file that dominates.
Measured on a warm 4 KiB file, 200 000 iterations of each:

```console
$ python3 tiny.py tiny.bin
N=200000 iterations on a 4096-byte file (warm cache):
  read()+close :     4588 ns/op
  mmap()+close :    12568 ns/op
  mmap is 2.7x the fixed cost of a single read()
```

Map once and read many pages and `mmap()` pays off; open-map-touch-munmap for a
few bytes and it's pure overhead. `mmap()` shines for **random access into a
large file** — databases, search indexes — where you'd otherwise issue a
`pread()` syscall per page and copy it just to look at it. For streaming a whole
file sequentially, `read()` is perfectly fine.

## Writes: dirty pages, writeback, and msync

Writes through `mmap()` don't reach the disk either — they dirty pages in the
cache and return immediately. `msync(MS_SYNC)` is what forces them out (the
`mmap` equivalent of `fsync`). Here's a real `mmap` write of a 256 MiB file,
sampling `/proc/meminfo` `Dirty` at each stage and verifying the bytes survived
the round-trip to disk:

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

Writing into the mapping dirtied ~154 MiB of pages (costing 1.3 s — first touch
of a `MAP_SHARED` mapping on a fresh file allocates and zero-fills each page,
so it's not a pure `memcpy`), and `Dirty` climbed. Then `msync(MS_SYNC)` spent a
real second writing those pages to disk and `Dirty` collapsed to ~1 MiB. The
data verified bit-for-bit afterwards. That's the write side of the page cache:
fast in RAM until you ask for durability, and `vm.dirty_background_ratio` /
`vm.dirty_ratio` (here `10` and `20`) decide when the kernel starts flushing on
its own. Too low and you flush constantly; too high and a big stall lands all
at once. Tuning those is the subject of my earlier [io-latency post](/posts/io-latency/),
so I won't repeat it.

The sharp edge worth naming: if the mapping outlives the file on disk, or the
disk fills, the page simply isn't there, and touching the map raises `SIGBUS`.
With `read()` a missing page is a clean error return; with `mmap()` it's a
signal that can kill the process. If the file can shrink or vanish out from
under you, handle that before you map it.

## drop_caches: the trap, and what to do instead

The internet loves `sync; echo 3 > /proc/sys/vm/drop_caches` as a "fix". On this
box it isn't even available to me:

```console
$ ls -l /proc/sys/vm/drop_caches && echo 3 > /proc/sys/vm/drop_caches
--w------- 1 root root 0 ... /proc/sys/vm/drop_caches
zsh:1: 权限不够: /proc/sys/vm/drop_caches
```

Root-only, and that's the right default. `drop_caches` throws away *good* cache;
the next read repopulates it — slower, for no benefit. It's a debugging tool for
measuring cold-cache behaviour, not a performance knob. For evicting one file's
pages, the unprivileged tool is `posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)`,
which is exactly how every "cold read" above was produced.

The other advice hints are worth knowing. `POSIX_FADV_SEQUENTIAL` doubles
readahead and drops behind you; `POSIX_FADV_RANDOM` turns readahead off;
`POSIX_FADV_WILLNEED` asks the kernel to prefetch. I measured `WILLNEED` here
and it was a dud — on this memory-pressured box, `fadvise(WILLNEED)` moved
`Cached` by ~5 MiB and the following read still went to disk (0.76 s):

```console
$ ./evict testfile.grow; grep Cached /proc/meminfo      # after DONTNEED
  after DONTNEED : Cached=3732 MiB
$ python3 -c "os.posix_fadvise(fd,0,0,POSIX_FADV_WILLNEED)"; sleep 2
$ grep Cached /proc/meminfo
  after WILLNEED : Cached=3737 MiB      # +5 MiB: barely honoured
$ ./cread testfile.grow
[read] ... elapsed=0.7649s ...          # still hit the disk
```

`madvise()` is the `mmap()`-address-space analogue (`MADV_WILLNEED`,
`MADV_SEQUENTIAL`, `MADV_RANDOM`, `MADV_DONTNEED`) with the same semantics.
Treat every one of them as a *hint*: the kernel is free to ignore it, and here
it did. Don't build a design that depends on a hint being honoured.

## The honest rules

Stepping back from the numbers:

- **Let the cache do its job.** A machine that reads a file once and looks
  "full" is working *correctly*. Watch `MemAvailable`, not `MemFree`.
- **Don't `drop_caches` in production.** It's a debugging tool, it's root-only
  here for good reason, and it only makes the next read slower.
- **`mmap()` for random access into large files, and for avoiding a copy on a
  big sequential pass. Not for tiny reads** — 2.7× the overhead on a 4 KiB file.
- **One big `read()` beats many small ones**, and jump random access to a large
  file via `mmap()`/`pread()` rather than `read()`.
- **`msync`/`fsync` only where you need durability.** Otherwise you're paying
  for the disk to prove something the cache already has.

The through-line: **`read()` is a syscall plus a copy; `mmap()` is a mapping
plus a page fault; the page cache sits under both and is almost always the thing
actually serving your bytes.** Once you can see it in `/proc/meminfo` and count
its syscalls with `strace -c`, "second run is faster" stops being a mystery and
starts being arithmetic. And when the working set genuinely exceeds RAM, every
read is cold and you're back in the disk-latency world — which is its own
[whole post about why load average lies](/posts/linux-load-average/).
