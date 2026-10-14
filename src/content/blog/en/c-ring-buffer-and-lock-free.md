---
title: "A Lock-Free Ring Buffer in C: SPSC, the One That's Actually Safe"
description: "Hand-roll a lock-free SPSC ring buffer in C with atomic indices and acquire/release ordering. Real benchmarks, ThreadSanitizer race detection, and mutex comparison."
pubDate: 2027-02-15
lang: en
translationKey: c-ring-buffer-and-lock-free
tags: [c, embedded]
featured: false
keywords:
  - lock-free ring buffer
  - SPSC queue
  - atomics C
  - ThreadSanitizer
  - memory ordering
---

A ring buffer is the workhorse of embedded and streaming systems. Fixed memory, no allocation, O(1) push and pop. But the moment two threads touch it — one producing, one consuming — you enter the minefield of concurrent data structures. The good news: the Single-Producer Single-Consumer (SPSC) case is the one lock-free queue you can safely hand-roll. It needs no mutex, no CAS loop, just two atomic indices and the right memory ordering. This post builds one from scratch, measures it, catches a real data race with ThreadSanitizer, and compares it against a mutex-protected queue.

If you're coming from a superloop or FreeRTOS background, you've already seen queues in action — the [superloop without an RTOS](/posts/embedded-c-without-an-rtos/) and [FreeRTOS tasks and queues](/posts/esp32-freertos-tasks/) posts cover those. Here we go one level deeper: what does a queue look like when you write the synchronization yourself, with nothing but C11 atomics?

## What a ring buffer is

A ring buffer is a fixed-size array treated as a circle. Two indices — `head` (write position) and `tail` (read position) — advance modulo the capacity:

```c
size_t next = (head + 1) & mask;   /* mask = capacity - 1, capacity is power of 2 */
```

That's the entire indexing scheme. Push writes at `head` and advances it; pop reads at `tail` and advances it. No `malloc`, no `free`, no pointer chasing. The memory footprint is known at compile time, which is exactly what you want on a microcontroller or in a latency-sensitive path.

<figure>
<svg viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ring buffer with head and tail pointers">
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
  <text x="285" y="95" font-size="12" font-family="monospace" fill="#0f766e">head → push</text>
  <text x="115" y="145" font-size="12" font-family="monospace" fill="#0f766e">← tail · pop</text>
</svg>
<figcaption>A ring buffer: the producer writes at <code>head</code>, the consumer reads at <code>tail</code>. Slots in teal hold live data; grey slots are free.</figcaption>
</figure>

## The full/empty ambiguity

`head == tail` could mean "empty" or "full." The classic resolution is to waste one slot: the buffer is full when `(head + 1) % capacity == tail`. A capacity of 8 gives you 7 usable slots. The alternative is a separate atomic counter, which costs an extra atomic operation on every push and pop. For most embedded uses, wasting one slot is the right trade.

## SPSC: the only lock-free queue to hand-roll

A naive ring buffer with plain `size_t` indices is a data race the moment two threads use it. But in the SPSC case — one producer thread, one consumer thread — the synchronization collapses to something beautiful:

- The producer owns `head` (only it writes `head`), and reads `tail` to check for full.
- The consumer owns `tail` (only it writes `tail`), and reads `head` to check for empty.
- Each side only *writes* its own index and only *reads* the other's.

That means the only cross-thread communication is: producer publishes `head`, consumer reads `head`; consumer publishes `tail`, producer reads `tail`. Two atomic loads, two atomic stores, acquire/release ordering. No lock, no CAS, no ABA problem.

Here is the complete implementation:

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
        return false;                          /* full */
    r->slots[h & r->mask] = val;
    atomic_store_explicit(&r->head, next, memory_order_release);
    return true;
}

bool spsc_ring_pop(spsc_ring_t *r, uint64_t *val) {
    size_t t = atomic_load_explicit(&r->tail, memory_order_relaxed);
    if (t == atomic_load_explicit(&r->head, memory_order_acquire))
        return false;                          /* empty */
    *val = r->slots[t & r->mask];
    atomic_store_explicit(&r->tail, (t + 1) & r->mask, memory_order_release);
    return true;
}
```

Twenty lines. That's the whole thing.

## Why acquire/release is enough

The memory-ordering reasoning is the part most people hand-wave. Let's be precise.

The producer does three things: (1) load `tail` with acquire, (2) store the slot, (3) store `head` with release. The consumer does the mirror: (1) load `head` with acquire, (2) load the slot, (3) store `tail` with release.

The release store to `head` guarantees that everything the producer did before it — including the slot write — is visible to any thread that acquires-loads `head` and sees the new value. That's the C11 memory model's *synchronizes-with* relationship. The consumer's acquire load of `head` is the matching edge. So when the consumer sees `head` advance, it is guaranteed to see the slot data the producer wrote. The same logic applies in reverse for the tail.

We use `memory_order_relaxed` for the load of our *own* index because only one thread writes it — no cross-thread synchronization is needed for that read. The acquire is only on the load of the *other* side's index, and the release only on the store of *our* index. That's the minimal correct ordering.

## Real multi-threaded test

I compiled the above with `gcc -O2 -pthread` on this machine (GCC 16.2.1) and ran a producer/consumer pair pushing 10,000,000 items through a 4096-slot ring:

```
Consumer received 10000000 items (expected 10000000)
First value: 0, last value: 9999999
Produced 10000000 items in 0.163 s
Throughput: 61.21 M ops/sec
Latency: 16 ns/op (amortized, both sides)
```

Ten million items in, ten million out, zero loss, zero duplicates. 61 million operations per second on a single core — that's the throughput you get when there's no lock, no syscall, no cache-line bouncing between contended atomics.

## OVERWRITE vs DROP

When the ring is full, you have two policies:

- **DROP**: reject the new item. Use this when every sample matters — sensor readings, network packets.
- **OVERWRITE**: advance the tail to discard the oldest item, then write. Use this when only the latest data matters — audio samples, gauge readings, log messages.

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

Both policies, measured on a capacity-8 ring with 20 pushes:

```
=== DROP policy (cap=8) ===
Pushed 7, dropped 13
Ring contents (oldest first): 0 1 2 3 4 5 6

=== OVERWRITE policy (cap=8) ===
Pushed 20 items into cap-8 ring with OVERWRITE
Ring contents (oldest first): 13 14 15 16 17 18 19
```

DROP kept the first 7 and rejected 13. OVERWRITE kept the last 7, silently discarding the oldest 13. Same ring, same code path except for one branch — completely different semantics.

## ThreadSanitizer catches the naive race

What happens if you skip the atomics and use plain `size_t` indices? Undefined behavior — and ThreadSanitizer will prove it. I wrote a naive version with plain loads and stores, compiled with `-fsanitize=thread`, and ran the same producer/consumer test:

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

Two data races, both on the `head`/`tail` indices. The naive version "works" in the sense that it printed the right count — on x86 with this timing, the plain stores happen to propagate fast enough. But it's undefined behavior. On a weakly-ordered architecture (ARM, Apple Silicon), the consumer could see the new `head` but stale slot data — a torn read that never shows up in testing but bites you in production.

I then compiled the same test against the atomic version with ThreadSanitizer:

```
Consumer received 100000 items
```

Clean. Zero warnings. The acquire/release ordering isn't just theoretical — it's the difference between "happens to work" and "guaranteed correct."

## SPSC ring vs mutex-protected queue

How much does the lock actually cost? I benchmarked the SPSC ring against a mutex + condition variable queue (same capacity, same item count, both compiled `-O2`):

```
Mutex queue: consumer received 5000000 items
Mutex queue: 1.033 s, 4.84 M ops/sec

SPSC ring: consumer received 5000000 items
SPSC ring: 0.085 s, 59.13 M ops/sec
SPSC is 12.2x faster than mutex queue
```

12× faster. The mutex version spends its time in `pthread_mutex_lock`/`unlock`, `pthread_cond_wait`/`signal`, and the cache-line bouncing of a contended lock. The SPSC ring does two atomic loads and two atomic stores per operation, all on cache lines that are hot in the respective core's L1. On x86, a `LOCK`-prefixed atomic operation on an uncontended cache line costs the same as a normal load — the hardware coherence protocol does the work without a bus lock.

The gap widens on multicore systems and on weakly-ordered architectures, where the mutex's memory barriers are more expensive and the SPSC ring's targeted acquire/release is exactly as strong as it needs to be — no stronger.

## When to use this and when not to

Use an SPSC ring when you have exactly one producer and one consumer: ISR-to-thread, UART RX to parser, sensor DMA to processing task, audio callback to DSP. The capacity is a power of two, the indices are `atomic_size_t`, and the ordering is acquire/release. That's it.

Do **not** hand-roll an MPMC (multi-producer, multi-consumer) lock-free queue. That is a research problem — LMAX Disruptor, Vyukov's MPMC queue, and concurrent intrusive linked lists all exist because the problem is genuinely hard. Getting it wrong means lost items, torn reads, and heisenbugs that reproduce once per million runs. Use a proven implementation, or wrap a mutex if you must.

And if you're on FreeRTOS, remember that `xQueueSend`/`xQueueReceive` already gives you an SPSC-safe queue with the right memory ordering baked in — see the [FreeRTOS tasks and queues](/posts/esp32-freertos-tasks/) post. The ring buffer here is what you reach for when you want to understand what's underneath, or when you need the absolute minimum latency with no RTOS overhead.

The ring buffer is one of those structures where twenty lines of C, done right, outperform a general-purpose lock. The key is understanding *why* it's correct: one writer per index, acquire/release on the cross-thread edges, and the discipline to stop there.
