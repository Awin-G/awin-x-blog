---
title: "io_uring in practice: why batch submission beats syscall-per-I/O"
description: "io_uring trades one syscall per I/O for a shared ring between user space and the kernel. Real fio ioengine comparisons on Linux 7.2: what queue depth changes, what it doesn't, and where SQPOLL and registered buffers actually help."
pubDate: 2027-01-24
lang: en
translationKey: io-uring-in-practice
tags: [linux, devops]
featured: false
keywords:
  - io_uring
  - asynchronous I/O
  - fio ioengine
  - queue depth
  - epoll
  - libaio
  - SQPOLL
---

Every blocking `read()` is a round trip: your thread crosses into the kernel, the kernel finds your data (or parks you until it's ready), copies it into your buffer, and hands control back. When I/O is slow, that round trip is free — you were going to wait anyway. When storage is fast — page cache, NVMe, tmpfs — the syscall itself becomes the bottleneck. I hit this personally while profiling a log-shipper: the device reported 60% utilization, `iostat` looked bored, and my single-threaded reader was stuck at 1.2M IOPS on a box that could clearly do more.

**io_uring** is the Linux answer: stop asking the kernel one I/O at a time. This post is the practical version — what `io_uring` actually is, how it differs from `epoll` and `libaio`, and what real `fio ioengine` numbers on this machine (kernel 7.2.9, SATA SSD, 8 cores) show at different **queue depth** settings. I also wrote a small C program with liburing that submits reads in batches of 32, and measured it against a plain `pread()` loop. Spoiler: the same file, the same blocks, 3.5x the IOPS at depth — and one case where io_uring is honestly *slower*.

## The problem: one syscall per I/O, and epoll doesn't fix it

The classic synchronous model is easy to reason about and terrible for throughput:

```c
for (i = 0; i < N; i++)
    n = pread(fd, buf, 4096, off);   /* one syscall, one context switch, per block */
```

For 100 million blocks that's 100 million syscalls, each with register save/restore, SMAP/SMEP dances, and a full return path. You can hide latency with threads, but now you're paying scheduler wakeups and 8 MB stacks for parking lots.

`epoll` is often proposed as the fix, but it only solves *waiting*: it tells you a file descriptor is *readable*. You still call `read()` — one syscall and one copy per operation. It's a readiness notification, not an I/O submission mechanism. It doesn't help for file I/O on disk at all.

`libaio` (AIO, `io_submit`) was the earlier attempt at submission, and it shows: it only supports `O_DIRECT` on regular files, requires a separate `io_setup` syscall and an AIO context per thread, and its "userspace polling" of completion queues costs real CPU (you'll see that below — it's the one engine that lost the QD=1 race).

## What io_uring is: two rings and one shared queue

io_uring (merged in 5.1, usable from 5.6+) turns I/O into a producer/consumer problem over memory the kernel and your process share:

<figure>
<svg viewBox="0 0 660 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagram of the io_uring submission queue and completion queue rings shared between user space and the kernel">
  <!-- user space box -->
  <rect x="20" y="30" width="620" height="105" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <text x="32" y="24" fill="currentColor" font-size="11" font-family="monospace" opacity="0.7">USER SPACE (your process)</text>

  <!-- SQ ring -->
  <circle cx="180" cy="82" r="52" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <circle cx="180" cy="82" r="26" fill="#0f766e" opacity="0.12"/>
  <text x="180" y="86" fill="currentColor" font-size="12" text-anchor="middle">SQ ring</text>
  <text x="180" y="148" fill="currentColor" font-size="10" text-anchor="middle" font-family="monospace">SQEs you fill in</text>

  <!-- CQ ring -->
  <circle cx="480" cy="82" r="52" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <circle cx="480" cy="82" r="26" fill="#0f766e" opacity="0.12"/>
  <text x="480" y="86" fill="currentColor" font-size="12" text-anchor="middle">CQ ring</text>
  <text x="480" y="148" fill="currentColor" font-size="10" text-anchor="middle" font-family="monospace">results you reap</text>

  <!-- fill arrow to SQ -->
  <line x1="180" y1="155" x2="180" y2="196" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arrow)"/>
  <text x="192" y="180" fill="currentColor" font-size="10" font-family="monospace">fill up to 32 SQEs</text>

  <!-- kernel box -->
  <rect x="20" y="200" width="620" height="80" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <text x="32" y="194" fill="currentColor" font-size="11" font-family="monospace" opacity="0.7">KERNEL</text>
  <text x="330" y="248" fill="currentColor" font-size="11" text-anchor="middle" font-family="monospace">io_uring_enter(submit up to N at once) — then reaps into the CQ ring as they finish</text>

  <!-- completion arrow back up -->
  <line x1="480" y1="196" x2="480" y2="155" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#arrow)"/>
  <text x="494" y="180" fill="currentColor" font-size="10" font-family="monospace">peek — no syscall at all</text>

  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>io_uring's contract: you write submission queue entries into a ring the kernel reads, call <code>io_uring_enter</code> once for a whole batch, and the kernel posts results to a completion ring you can peek without any syscall at all.</figcaption>
</figure>

The submission queue (SQ) is a ring buffer you fill with SQE entries ("read 4k from offset X into buffer B"). The completion queue (CQ) is a ring the kernel fills with results. You can submit 32, 64, or 1000 operations with one `io_uring_enter` syscall, then poll the CQ ring in user space — **no syscall needed to check for completions**, because the ring is shared memory. One syscall per *batch*, not per I/O.

So the comparison against the alternatives:

- **vs. `epoll`**: epoll tells you when to call `read()`/`write()`; you still do one syscall + copy per I/O. io_uring *is* the I/O call.
- **vs. `libaio`**: io_uring supports buffered file I/O (no `O_DIRECT` requirement), avoids per-thread AIO context setup, supports registered files and buffers, and supports more operations (fsync, timeouts, sockets, `uring_cmd` for NVMe).
- **vs. threads**: io_uring gives you depth 1 without depth-1 cost: one thread can keep thousands of operations in flight; threads each cost a context switch per wakeup.

## The fio ioengine numbers, on real hardware

First, the environment. Everything below was measured on this box: kernel 7.2.9-arch1-1, 8 cores, a Micron 1100 SATA SSD (LUKS on sdb2, ext4), and tmpfs for a page-cached view. fio 3.42, liburing 2.15. io_uring is enabled here:

```sh
$ cat /proc/sys/kernel/io_uring_disabled
0
```

I ran the identical job with fio's three engines (`--ioengine=psync|libaio|io_uring`). Median of two 8-second runs.

**Page-cached (tmpfs), `randread --bs=4k`** — here the device is RAM, so what remains visible is pure submission-path cost:

| engine / shape | IOPS | avg lat | p99 lat | CPU |
|---|---|---|---|---|
| psync, QD=1 | 472,239 | 1.9 µs | 4.3 µs | 98.7% |
| libaio, QD=1 | 335,670 | 2.7 µs | 5.5 µs | 98.5% |
| io_uring, QD=1 | 99,275 | 9.6 µs | 18.8 µs | 58.2% |
| libaio, QD=32 ×4 jobs | 985,237 | 129.9 µs | 187.4 µs | 98.8% |
| io_uring, QD=32 ×4 jobs | 944,180 | 134.9 µs | 553.0 µs | 82.6% |

Two honest surprises. At QD=1, io_uring is *slower per op* than a blocking pread (9.6 µs vs 1.9 µs) — the ring indirection has to be paid once per batch, and at depth 1 the "batch" is one op. But it uses half the CPU, because it isn't blocking the thread on the device. At QD=32 the IOPS tie (both around a million, memory-bound), but io_uring does it with **16 points less CPU** — the submit+reap cost amortized over 32 ops is real. That's the whole thesis in one table: io_uring doesn't make the device faster, it makes *your core* spare.

**Real SSD (ext4 on LUKS), `randread --bs=4k --direct=1`, 2 GiB file:**

| engine / shape | IOPS | avg lat | CPU |
|---|---|---|---|
| psync, QD=1 | 5,859 | 169.7 µs | 8.4% |
| libaio, QD=1 | 5,679 | 175.0 µs | 9.1% |
| io_uring, QD=1 | 5,632 | 176.3 µs | 9.6% |
| libaio, QD=32 | 58,638 | 545.2 µs | 58.1% |
| io_uring, QD=32 | 59,817 | 534.1 µs | 56.9% |
| psync, 32 processes × QD=1 | 60,093 | 531.0 µs | 3.1% |

Here the device is the bottleneck (170 µs of SATA latency per op swamps everything), so **all engines tie at every depth** — depth scales IOPS 10x (5.6k → 59k) regardless of submission API. The CPU column tells the rest of the story: 32 blocking `psync` processes need an aggregate queue depth of 32 and they get it by being 32 context-switchy processes; io_uring needs one thread and no blocking wakeups per completion. (The 3.1% CPU for psync is misleading in the other direction — blocked threads burn no CPU precisely because the device is slow.)

And where io_uring does *not* win — sequential deep reads, on any engine:

```
seqread 1m QD=16 nj=1:  libaio 510 IOPS   io_uring 509 IOPS
```

One big sequential read is a bandwidth problem; submission batching is irrelevant. This matches the general shape from my earlier [fio deep dive](/posts/disk-io-and-fio/): match the tool to the workload axis.

## A C program: 32 I/Os per submit

Tables from fio are convincing, but the cleanest demonstration is my own program: walk the same 64 MiB region of a file in 4k blocks, three ways. Here's the core loop of the io_uring path:

```c
while (done < NBLOCKS) {
    int inflight = 0;
    while (inflight < BATCH && done + inflight < NBLOCKS) {   /* BATCH = 32 */
        struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
        if (!sqe) break;
        off_t off = (off_t)((done + inflight) * BS) % REGION;
        io_uring_prep_read(sqe, fd, bufs[inflight], BS, off);
        sqe->user_data = done + inflight;
        inflight++;
    }
    io_uring_submit(&ring);          /* ONE syscall for 32 ops        */
    submits++;

    int reaped = 0;
    while (reaped < inflight) {       /* peek the CQ ring, wait only if empty */
        struct io_uring_cqe *cqe;
        io_uring_wait_cqe(&ring, &cqe);
        sink[cqe->user_data & (BS - 1)] ^= bufs[cqe->user_data % BATCH][0];
        reaped++;
        io_uring_cqe_seen(&ring, cqe);
    }
    done += inflight;
}
```

Build: `gcc -O2 -o bench bench.c -luring`. Real output (median of 5 runs, 2 GiB file on the SSD, `O_DIRECT`):

```text
file=/var/tmp/fio-uring-bench/testfile mode=O_DIRECT kernel=7.2.9-arch1-1 io_uring_disabled=0  liburing=2.15
  pread      wall= 0.797s  IOPS=    20549  cpu= 0.16s (20.1%)  ios/submit=1.0
  uring      wall= 0.227s  IOPS=    72061  cpu= 0.05s (22.4%)  ios/submit=32.0
  uring-sqp  wall= 0.222s  IOPS=    73822  cpu= 0.23s (104.9%)  ios/submit=32.0
  uring-reg  wall= 0.227s  IOPS=    72304  cpu= 0.05s (23.7%)  ios/submit=32.0
```

Same file, same blocks, a 3.5x wall-clock difference: **20,549 → 72,061 IOPS**, with one `io_uring_submit` per 32 operations instead of one `pread` per operation. The page-cached variant (same code, no `O_DIRECT`) shows the submission path alone: pread 853,937 IOPS vs batched io_uring **1,364,467 IOPS** — 60% more, for the same data.

Note what doesn't help: SQPOLL (`IORING_SETUP_SQPOLL`, a kernel thread polling the SQ ring so you can skip submit syscalls entirely) bought ~2% more IOPS here and cost a whole core (104.9% CPU — the poller spinning). On the page-cache run it was *worse*: 1,157,842 vs 1,364,467 IOPS, because at these speeds the wakeup path beats the spinner. SQPOLL shines in specific latency-critical cases, not as a default.

## SQPOLL and registered buffers, briefly

- **SQPOLL** removes the submit syscall by having a kernel thread busy-poll the SQ ring. You trade a syscall for a dedicated CPU. My measurements say: benchmark it, don't assume it; it's an option (`--sqthread_poll=1` in fio), not a free lunch.
- **Registered buffers** (`IORING_REGISTER_BUFFERS`, `--fixedbufs=1` in fio) pin your buffers once so the kernel doesn't map them per operation. At this scale it measured a wash here (72,304 vs 72,061 IOPS), which is honest: the win shows up with huge buffer counts, many operations in flight, or NVMe-class latency where per-op mapping isn't free. I did hit a real portability wart doing this, which is a perfect lead-in to the caveats.

One caveat I measured rather than assumed: liburing's `io_uring_prep_read_fixed()` zeroes the SQE `addr` field (the kernel is supposed to use `buf_index` only). On this kernel every fixed read returned `-EFAULT`. Adding a non-NULL `addr` — exactly what fio's engine does — fixed it instantly. Small thing, but it's the general lesson: test io_uring features **on your kernel**, because they're version- and sometimes patch-level-dependent.

## The honest caveats

1. **Kernel version decides everything.** `io_uring` arrived in 5.1, was usable from 5.6, and has gained ops continuously; some environments still disable it (see `cat /proc/sys/kernel/io_uring_disabled` — `0` all on, `1` unprivileged off, `2` fully off). BSDs don't have it. Write a fallback path.
2. **Security surface.** io_uring has had its share of exploitable bugs, and hardened setups turn it off on purpose (some container runtimes and sandbox profiles restrict the syscalls). If you're deploying into someone else's hardened image, verify before you depend on it.
3. **It's not magic.** When the device is the bottleneck (my SATA SSD at QD=32), engines tie. When the workload is one deep sequential stream, engines tie. io_uring pays off at depth, with many small I/Os, on fast storage, when CPU per I/O matters.
4. **Buffered I/O caveats exist.** io_uring buffered reads can still block in the kernel for some cases (older kernels needed `IOSQE_ASYNC` to escape in-request blocking) — new kernels handle more inline, but check your version.

## Do I need this?

If your service does small random I/Os with depth beyond 4 — a vector store, a cache layer, a database — and you're approaching it with a thread pool, measure CPU per I/O and per-op latency at your real depth. If you're one-number-bound on a slow disk, or doing sequential streaming, you probably don't. And benchmark before rewriting: this box ties libaio and io_uring at QD=32 on the SSD, so the same experiment on NVMe or tmpfs-backed storage could tilt either way. The tool to check is right there — `fio --ioengine=` — and the runtime is `cat /proc/sys/kernel/io_uring_disabled`.

The pattern that survives all the noise is the original one: batching amortizes fixed costs. One submit per 32 reads turned 0.797s into 0.227s on the same file. Whether you get there with io_uring or something else, that's the lever.

---

*Related: [Disk I/O benchmarks that mean something: fio, IOPS, and fsync](/posts/disk-io-and-fio/) · [Understanding Linux Load Average](/posts/linux-load-average/)*
