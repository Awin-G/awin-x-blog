---
title: "C 语言无锁环形缓冲区：SPSC，唯一值得手写的那一个"
description: "用 C11 原子操作和 acquire/release 内存序手写一个无锁 SPSC 环形缓冲区。真实基准测试、ThreadSanitizer 竞态检测、与互斥锁队列的性能对比。"
pubDate: 2027-02-15
lang: zh
translationKey: c-ring-buffer-and-lock-free
tags: [c, embedded]
featured: false
keywords:
  - 无锁环形缓冲区
  - SPSC 队列
  - C 原子操作
  - ThreadSanitizer
  - 内存序
---

环形缓冲区是嵌入式和流式系统的基石。固定内存、零分配、O(1) 入队出队。但一旦两个线程同时操作它——一个生产、一个消费——你就踏入了并发数据结构的雷区。好消息是：单生产者单消费者（SPSC）场景是唯一可以安全手写的无锁队列。它不需要互斥锁、不需要 CAS 循环，只需要两个原子索引加上正确的内存序。本文从零构建一个 SPSC 环形缓冲区，进行性能基准测试，用 ThreadSanitizer 捕获真实的数据竞态，并与互斥锁保护的队列做对比。

如果你来自裸机 superloop 或 FreeRTOS 背景，你应该已经见过队列的实际应用——[不使用 RTOS 的 superloop](/zh/posts/embedded-c-without-an-rtos/) 和 [FreeRTOS 任务与队列](/zh/posts/esp32-freertos-tasks/) 这两篇文章已经覆盖过那些内容。这里我们深入一层：当你只用 C11 原子操作自己实现同步时，队列到底长什么样？

## 什么是环形缓冲区

环形缓冲区是一个固定大小的数组，逻辑上首尾相连成环。两个索引——`head`（写位置）和 `tail`（读位置）——按容量取模递增：

```c
size_t next = (head + 1) & mask;   /* mask = 容量 - 1，容量为 2 的幂 */
```

这就是全部的索引方案。入队时向 `head` 写入并推进 `head`；出队时从 `tail` 读取并推进 `tail`。没有 `malloc`，没有 `free`，没有指针跳转。内存在编译期就确定，这正是微控制器和延迟敏感路径最需要的特性。

<figure>
<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="带头尾指针的环形缓冲区">
  <g transform="translate(200, 110)">
    <circle cx="0" cy="-70" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
    <text x="0" y="-65" text-anchor="middle" font-size="11" font-family="monospace" fill="currentColor" opacity="0.4">0</text>
    <circle cx="50" cy="-50" r="22" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="50" y="-45" text-anchor="middle" font-size="11" font-family="monospace" fill="#0f766e">1</text>
    <circle cx="70" cy="0" r="22" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="70" y="5" text-anchor="middle" font-size="11" font-family="monospace" fill="#0f766e">2</text>
    <circle cx="50" cy="50" r="22" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="50" y="55" text-anchor="middle" font-size="11" font-family="monospace" fill="#0f766e">3</text>
    <circle cx="0" cy="70" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
    <text x="0" y="75" text-anchor="middle" font-size="11" font-family="monospace" fill="currentColor" opacity="0.4">4</text>
    <circle cx="-50" cy="50" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
    <text x="-50" y="55" text-anchor="middle" font-size="11" font-family="monospace" fill="currentColor" opacity="0.4">5</text>
    <circle cx="-70" cy="0" r="22" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="-70" y="5" text-anchor="middle" font-size="11" font-family="monospace" fill="#0f766e">6</text>
    <circle cx="-50" cy="-50" r="22" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="-50" y="-45" text-anchor="middle" font-size="11" font-family="monospace" fill="#0f766e">7</text>
  </g>
  <text x="285" y="95" font-size="12" font-family="monospace" fill="#0f766e">head → 入队</text>
  <text x="115" y="145" font-size="12" font-family="monospace" fill="#0f766e">← tail · 出队</text>
</svg>
<figcaption>环形缓冲区：生产者在 <code>head</code> 写入，消费者在 <code>tail</code> 读取。青色槽位存有有效数据；灰色槽位空闲。</figcaption>
</figure>

## 满/空的歧义

`head == tail` 可能表示"空"也可能表示"满"。经典解法是牺牲一个槽位：当 `(head + 1) % capacity == tail` 时视为满。容量为 8 的环形缓冲区实际可用 7 个槽位。另一种方案是使用独立的原子计数器，但每次入队/出队都多一次原子操作。对大多数嵌入式场景来说，牺牲一个槽位是正确的取舍。

## SPSC：唯一值得手写的无锁队列

如果使用普通 `size_t` 索引的朴素环形缓冲区，两个线程一起用就是数据竞态。但在 SPSC 场景下——一个生产者线程、一个消费者线程——同步逻辑可以简化到极致：

- 生产者独占 `head`（只有它写 `head`），读 `tail` 判断是否已满。
- 消费者独占 `tail`（只有它写 `tail`），读 `head` 判断是否为空。
- 每侧只*写*自己的索引，只*读*对方的。

这意味着唯一的跨线程通信是：生产者发布 `head`，消费者读 `head`；消费者发布 `tail`，生产者读 `tail`。两次原子加载、两次原子存储，加上 acquire/release 内存序。无锁、无 CAS、无 ABA 问题。

以下是完整实现：

```c
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
    size_t capacity;
    size_t mask;
    _Atomic size_t head;
    _Atomic size_t tail;
    uint64_t *slots;
} spsc_ring_t;

bool spsc_ring_push(spsc_ring_t *r, uint64_t val) {
    size_t h = atomic_load_explicit(&r->head, memory_order_relaxed);
    size_t next = (h + 1) & r->mask;
    if (next == atomic_load_explicit(&r->tail, memory_order_acquire))
        return false;                          /* 满 */
    r->slots[h & r->mask] = val;
    atomic_store_explicit(&r->head, next, memory_order_release);
    return true;
}

bool spsc_ring_pop(spsc_ring_t *r, uint64_t *val) {
    size_t t = atomic_load_explicit(&r->tail, memory_order_relaxed);
    if (t == atomic_load_explicit(&r->head, memory_order_acquire))
        return false;                          /* 空 */
    *val = r->slots[t & r->mask];
    atomic_store_explicit(&r->tail, (t + 1) & r->mask, memory_order_release);
    return true;
}
```

二十行代码，就这么简单。

## 为什么 acquire/release 就够了

内存序的推理是大多数人一带而过的地方。让我们说清楚。

生产者做三件事：(1) 以 acquire 加载 `tail`，(2) 写入槽位数据，(3) 以 release 存储 `head`。消费者做镜像操作：(1) 以 acquire 加载 `head`，(2) 读取槽位数据，(3) 以 release 存储 `tail`。

对 `head` 的 release 存储保证：生产者在此之前的全部操作——包括槽位数据的写入——对任何 acquire 加载 `head` 并看到新值的线程都可见。这就是 C11 内存模型的 *synchronizes-with* 关系。消费者对 `head` 的 acquire 加载是对应的边。因此当消费者看到 `head` 前进时，它保证能看到生产者写入的槽位数据。`tail` 方向同理。

对*自己*索引的加载使用 `memory_order_relaxed`，因为只有一个线程写它——该读取不需要跨线程同步。acquire 只加在*对方*索引的加载上，release 只加在*自己*索引的存储上。这就是最小正确的内存序。

## 真实多线程测试

我用 `gcc -O2 -pthread` 在本机（GCC 16.2.1）编译上述代码，运行生产者/消费者线程对，通过 4096 槽位的环形缓冲区推送 1000 万条目：

```
Consumer received 10000000 items (expected 10000000)
First value: 0, last value: 9999999
Produced 10000000 items in 0.163 s
Throughput: 61.21 M ops/sec
Latency: 16 ns/op (amortized, both sides)
```

一千万人队，一千万人出队，零丢失、零重复。单核每秒 6100 万次操作——这就是无锁、无系统调用、无缓存行弹跳的吞吐量。

## OVERWRITE vs DROP 策略

环形缓冲区满时，有两种策略：

- **DROP**：拒绝新条目。适用于每个样本都重要的场景——传感器读数、网络数据包。
- **OVERWRITE**：推进 `tail` 丢弃最旧的条目，再写入新数据。适用于只关心最新数据的场景——音频采样、仪表读数、日志消息。

```c
void spsc_ring_push_overwrite(spsc_ring_t *r, uint64_t val) {
    size_t h = atomic_load_explicit(&r->head, memory_order_relaxed);
    size_t next = (h + 1) & r->mask;
    size_t t = atomic_load_explicit(&r->tail, memory_order_acquire);
    if (next == t) {
        atomic_store_explicit(&r->tail, (t + 1) & r->mask,
                              memory_order_release);
    }
    r->slots[h & r->mask] = val;
    atomic_store_explicit(&r->head, next, memory_order_release);
}
```

两种策略，在容量为 8 的环形缓冲区上推送 20 个条目的实测结果：

```
=== DROP policy (cap=8) ===
Pushed 7, dropped 13
Ring contents (oldest first): 0 1 2 3 4 5 6

=== OVERWRITE policy (cap=8) ===
Pushed 20 items into cap-8 ring with OVERWRITE
Ring contents (oldest first): 13 14 15 16 17 18 19
```

DROP 保留了前 7 个，拒绝后 13 个。OVERWRITE 保留了最后 7 个，静默丢弃最旧的 13 个。同样的环形缓冲区，同样的代码路径，只多了一个分支——语义完全不同。

## ThreadSanitizer 捕获朴素版本的竞态

如果跳过原子操作、使用普通 `size_t` 索引会怎样？未定义行为——而 ThreadSanitizer 会证明这一点。我写了一个使用普通加载和存储的朴素版本，用 `-fsanitize=thread` 编译，运行同样的生产者/消费者测试：

```
==================
WARNING: ThreadSanitizer: data race (pid=1490572)
  Read of size 8 at 0x5645fde3f0b0 by thread T2:
    #0 naive_ring_pop /tmp/opencode/work/ringbuf/naive_ring.h:47 (test_naive_tsan+0x12f5)
    #1 consumer /tmp/opencode/work/ringbuf/test_naive.c:25 (test_naive_tsan+0x12f5)

  Previous write of size 8 at 0x5645fde3f0b0 by thread T1:
    #0 naive_ring_push /tmp/opencode/work/ringbuf/naive_ring.h:41 (test_naive_tsan+0x125b)
    #1 producer /tmp/opencode/work/ringbuf/test_naive.c:15 (test_naive_tsan+0x125b)

  Location is global 'ring' of size 40 at 0x5645fde3f0a0

SUMMARY: ThreadSanitizer: data race /tmp/opencode/work/ringbuf/naive_ring.h:47 in naive_ring_pop
==================
Consumer received 100000 items
ThreadSanitizer: reported 2 warnings
```

两个数据竞态，都在 `head`/`tail` 索引上。朴素版本"能跑"——在 x86 上这种时序下，普通存储恰好传播得足够快，输出计数是对的。但这是未定义行为。在弱内存序架构（ARM、Apple Silicon）上，消费者可能看到新的 `head` 但槽位数据是旧的——一个永远不会在测试中出现、但在生产环境中咬你一口的撕裂读。

然后我用 ThreadSanitizer 编译原子版本的同一测试：

```
Consumer received 100000 items
```

干净。零警告。acquire/release 内存序不只是理论——它是"碰巧能跑"和"保证正确"之间的区别。

## SPSC 环形缓冲区 vs 互斥锁队列

锁的代价到底有多大？我对 SPSC 环形缓冲区和互斥锁 + 条件变量队列做了基准测试（相同容量、相同条目数、均编译 `-O2`）：

```
Mutex queue: consumer received 5000000 items
Mutex queue: 1.033 s, 4.84 M ops/sec

SPSC ring: consumer received 5000000 items
SPSC ring: 0.085 s, 59.13 M ops/sec
SPSC is 12.2x faster than mutex queue
```

快 12 倍。互斥锁版本的时间花在 `pthread_mutex_lock`/`unlock`、`pthread_cond_wait`/`signal`，以及被争用锁的缓存行弹跳上。SPSC 环形缓冲区每次操作只做两次原子加载和两次原子存储，且都在各自核心的 L1 热缓存行上。在 x86 上，无竞争缓存行上的 `LOCK` 前缀原子操作与普通加载成本相同——硬件一致性协议完成工作，不需要总线锁。

差距在多核系统和弱内存序架构上更大——互斥锁的内存屏障更昂贵，而 SPSC 环形缓冲区的精准 acquire/release 恰好够用——不强不弱。

## 什么时候用、什么时候不要用

当你只有一个生产者和一个消费者时使用 SPSC 环形缓冲区：ISR 到线程、UART RX 到解析器、传感器 DMA 到处理任务、音频回调到 DSP。容量为 2 的幂，索引为 `atomic_size_t`，内存序为 acquire/release。就这样。

**不要**手写 MPMC（多生产者多消费者）无锁队列。那是一个研究课题——LMAX Disruptor、Vyukov 的 MPMC 队列、并发侵入式链表，这些存在本身就说明问题有多难。写错了意味着丢数据、撕裂读、以及每百万次运行才复现一次的海森堡 bug。用久经考验的实现，或者老老实实用互斥锁。

如果你用 FreeRTOS，记住 `xQueueSend`/`xQueueReceive` 已经为你提供了带有正确内存序的 SPSC 安全队列——参见 [FreeRTOS 任务与队列](/zh/posts/esp32-freertos-tasks/) 这篇文章。这里的环形缓冲区是当你想理解底层原理、或者在没有 RTOS 开销的情况下追求最低延迟时的选择。

环形缓冲区是那种"二十行 C 写对了就胜过通用锁"的结构。关键在于理解*为什么*它是正确的：每个索引只有一个写者、跨线程边上的 acquire/release、以及到此为止的自律。
