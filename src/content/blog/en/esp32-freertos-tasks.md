---
title: "FreeRTOS tasks and queues, reproduced on my laptop"
description: "I cloned the FreeRTOS kernel, compiled its POSIX port with gcc, and ran five real experiments on Linux — preemptive scheduling, vTaskDelay vs busy-waiting, queues, mutex priority inversion, stack high-water marks — then mapped every concept to ESP-IDF on the ESP32."
pubDate: 2027-02-21
lang: en
translationKey: esp32-freertos-tasks
tags: [embedded]
featured: false
keywords:
  - FreeRTOS tasks
  - FreeRTOS queue
  - task priority
  - priority inversion
  - vTaskDelay
---

I write ESP32 firmware, and almost all of it runs on FreeRTOS without a second thought. ESP-IDF is FreeRTOS, so `xTaskCreate`, queues, mutexes and `vTaskDelay` are daily vocabulary. But vocabulary is not understanding. Readers of [my ESP32 getting started guide](/posts/esp32-c3-getting-started/) keep asking: why doesn't a "superloop" scale, what does a task priority actually buy me, why did my sensor reading arrive corrupted? So I went and ran the kernel.

Honest part up front: **no ESP32 was used in this article.** No board is attached to this machine, so everything below is reproduced on my laptop with the kernel's official [POSIX port](https://freertos.org/FreeRTOS-simulator-for-Linux.html) — a Linux simulator where each FreeRTOS task is a pthread and the tick is a timer thread. The APIs, scheduler logic and failure modes are the real kernel's; only the silicon is missing. Some things transfer perfectly (tasks, priorities, queues, mutexes, the inversion bug); some do not (microsecond timing, hard real-time).

## What an RTOS gives you over a superloop

A superloop is `while(1) { read_sensor(); send_uart(); blink_led(); }`. It works until two things must happen at once, or one thing blocks. Then you poll everything (wasting cycles) or bolt on flags until the loop resembles a poorly documented RTOS anyway.

An RTOS gives you three things for free:

- **Preemption.** A higher-priority task that becomes ready *interrupts* a lower-priority task — no polling, no manual yielding.
- **Priorities.** The scheduler always runs the highest-priority ready task; equal-priority tasks round-robin on each tick.
- **Blocking primitives.** Instead of burning CPU while waiting, a task *blocks* on a queue, semaphore or mutex and lets everyone else run. That one idea makes the model sane.

Everything below is those three ideas, reproduced in logs.

## The honest setup: FreeRTOS on Linux

I cloned the official repo and pulled the kernel submodule:

```console
$ git clone --depth 1 https://github.com/FreeRTOS/FreeRTOS.git
$ cd FreeRTOS
$ git submodule update --init --depth 1 FreeRTOS/Source
```

The kernel (V11.3.1) ships a POSIX/Linux port at `FreeRTOS/Source/portable/ThirdParty/GCC/Posix/`. Each task is a pthread; a timer thread raises the tick via `SIGALRM` every `1000000 / configTICK_RATE_HZ` microseconds. I used `configTICK_RATE_HZ = 1000` — one tick is one millisecond, and every log line below is stamped with `xTaskGetTickCount()` in milliseconds.

The build is plain gcc — port, kernel, and `heap_3` (a thin wrapper over `malloc`/`free`):

```console
$ gcc --version
gcc (GCC) 16.2.1 20260810

$ make build/preempt          # kernel + posix port + heap_3 + demo, -pthread link
$ ./build/preempt
```

My `FreeRTOSConfig.h` is deliberately tiny: `configUSE_PREEMPTION 1`, `configUSE_MUTEXES 1`, `configMAX_PRIORITIES 7`, timers and co-routines off, `heap_3.c` as allocator. Every output block below is copied from an actual run.

## FreeRTOS tasks and task priority: preemption in the log

`LOW` (priority 1) works through three steps; at each step it sends a token through a queue that `HIGH` (priority 2) is blocked on. `HIGH` wakes instantly, prints one line, blocks again — preempting `LOW` *between two of `LOW`'s own lines*, every time:

```console
[    1 ms] HIGH   | blocked on queue, waiting for token
[    1 ms] LOW    | step 1: working, about to send token
[    1 ms] HIGH   | woke with token 1 - preempted LOW mid-step
[    1 ms] HIGH   | blocked on queue, waiting for token
[    1 ms] LOW    | step 1: token sent (HIGH ran in between)
[   21 ms] LOW    | step 2: working, about to send token
[   21 ms] HIGH   | woke with token 2 - preempted LOW mid-step
[   21 ms] HIGH   | blocked on queue, waiting for token
[   21 ms] LOW    | step 2: token sent (HIGH ran in between)
[   41 ms] LOW    | step 3: working, about to send token
[   41 ms] HIGH   | woke with token 3 - preempted LOW mid-step
[   41 ms] HIGH   | blocked on queue, waiting for token
[   41 ms] LOW    | step 3: token sent (HIGH ran in between)
[   61 ms] LOW    | all steps done
vTaskStartScheduler returned
```

Read the tick column: the whole first preemption happens inside one 1-ms tick. `LOW` called `xQueueSend`, the kernel marked `HIGH` ready, and the scheduler switched context before `LOW`'s next statement. Nobody asked for that switch — that is the "pre" in preemptive. Within one priority level, equal-priority tasks round-robin, one time slice per tick.

Within one priority level, tasks are *not* privileged: equal-priority tasks round-robin, one time slice per tick. The last demo shows two priority-2 spinners alternating lines roughly every tick.

## vTaskDelay versus busy-waiting

The most common superloop habit that survives into RTOS code is burning CPU while waiting. A priority-2 "spinner" and a priority-1 "heartbeat" (prints every 50 ms): phase A, the spinner busy-waits ~300 ms in a wall-clock spin loop; phase B, it sleeps with `vTaskDelay(300)` instead:

```console
[    0 ms] SEQ    | phase A: spinner busy-waits 300 ms (prio 2), heartbeat prio 1
[    1 ms] SPIN   | start, tick = 1 (busy-waiting on the CPU)
[  281 ms] SPIN   | done, tick = 281
[  281 ms] BEAT   | beat 0 (tick 281)
[  331 ms] BEAT   | beat 1 (tick 331)
[  381 ms] BEAT   | beat 2 (tick 381)
[  431 ms] BEAT   | beat 3 (tick 431)
[  451 ms] SEQ    | phase A over at tick 451
[  451 ms] SEQ    | phase B: spinner sleeps via vTaskDelay 300 ms (prio 2)
[  451 ms] SPIN   | start, tick = 451 (sleeping with vTaskDelay)
[  451 ms] BEAT   | beat 0 (tick 451)
[  481 ms] BEAT   | beat 4 (tick 481)
[  501 ms] BEAT   | beat 1 (tick 501)
[  531 ms] BEAT   | beat 5 (tick 531)
[  551 ms] BEAT   | beat 2 (tick 551)
...
[  751 ms] SPIN   | done, tick = 751
[  751 ms] BEAT   | beat 6 (tick 751)
[  801 ms] BEAT   | beat 7 (tick 801)
[  901 ms] SEQ    | done. final tick = 901
```

Phase A is textbook starvation: the spinner *never yields*, so the lower-priority heartbeat runs exactly once the moment the spinner finishes. Phase B is the same code with one line changed: `vTaskDelay` moves the spinner to the blocked state for 300 ticks, the heartbeat owns the CPU in between, and its 50 ms cadence survives untouched. (The beats print out of order because the heartbeat was already mid-loop from phase A — real output, warts and all.)

Two takeaways. `vTaskDelay` is not a "pause" — it blocks, hands the CPU to anyone else who is ready, and counts in *ticks* (`pdMS_TO_TICKS` converts; my tick is 1 ms). For a strict period, use `vTaskDelayUntil` — `vTaskDelay` drifts by however long the rest of your loop takes.

## The FreeRTOS queue: the safe way to move data between tasks

The classic bug in superloop-to-RTOS ports is the shared global: an ISR writes `g_sensor`, the loop reads it, and nobody gets hurt until preemption lands mid-update and the reader sees a torn value. Queues delete that whole class of bug: the kernel copies the data, and sender and receiver never touch the same memory at the same time.

Phase A: a consumer at priority 3 blocks with `xQueueReceive(..., portMAX_DELAY)` while a producer at priority 2 sends five readings 15 ms apart. The consumer wakes *the instant* each value lands and preempts the producer to print it:


```console
[    0 ms] SEQ    | phase A: consumer(3) blocks, producer(2) sends 5 readings
[    1 ms] CONS   | queue empty - blocking with xQueueReceive(MAX_DELAY)
[    1 ms] CONS   | received reading 1 (fifo order preserved)
[    1 ms] CONS   | queue empty - blocking with xQueueReceive(MAX_DELAY)
[    1 ms] PROD   | sent reading 1 -> queued (waiting=0)
[   16 ms] CONS   | received reading 2 (fifo order preserved)
[   16 ms] CONS   | queue empty - blocking with xQueueReceive(MAX_DELAY)
[   16 ms] PROD   | sent reading 2 -> queued (waiting=0)
[   31 ms] CONS   | received reading 3 (fifo order preserved)
...
[   61 ms] CONS   | received reading 5 (fifo order preserved)
[   61 ms] CONS   | queue empty - blocking with xQueueReceive(MAX_DELAY)
[   61 ms] PROD   | sent reading 5 -> queued (waiting=0)
```

Notice the order at each send: the consumer's "received" line prints *before* the producer's "sent" line, at the same tick — the receive blocked, the send made it ready, preemption did the rest. FIFO order is guaranteed by the kernel, not by discipline.

Phase B shows what happens when nobody drains fast enough: the queue has two slots, and the producer fires four readings back-to-back with a zero timeout:

```console
[  201 ms] SEQ    | phase B: queue depth 2, producer fires 4 readings, no delay
[  201 ms] PROD   | sent reading 11 -> queued (waiting=1)
[  201 ms] PROD   | sent reading 12 -> queued (waiting=2)
[  201 ms] PROD   | sent reading 13 -> FULL, dropped (waiting=2)
[  201 ms] PROD   | sent reading 14 -> FULL, dropped (waiting=2)
[  201 ms] CONS   | waiting...
[  201 ms] CONS   | received reading 11
[  201 ms] CONS   | waiting...
[  201 ms] CONS   | received reading 12
[  201 ms] CONS   | waiting...
[  501 ms] SEQ    | done. final tick = 501
```

That `FULL, dropped` is `errQUEUE_FULL` from `xQueueSend` with timeout 0 — backpressure made visible instead of a silently corrupted variable. (On ESP32 you would usually block with a timeout and *handle* the full case.)

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 210" role="img" aria-label="A producer task and a consumer task passing data through a FreeRTOS queue">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="110" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="75" y="90" text-anchor="middle" font-family="monospace" font-size="15" fill="currentColor">producer</text>
  <text x="75" y="112" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">prio 2</text>
  <rect x="170" y="35" width="80" height="120" rx="6" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="210" y="58" text-anchor="middle" font-family="monospace" font-size="13" fill="#0f766e">queue</text>
  <line x1="185" y1="80" x2="235" y2="80" stroke="#0f766e" stroke-width="3"/>
  <line x1="185" y1="105" x2="235" y2="105" stroke="#0f766e" stroke-width="3"/>
  <line x1="185" y1="130" x2="235" y2="130" stroke="#0f766e" stroke-width="3"/>
  <rect x="290" y="60" width="110" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="345" y="90" text-anchor="middle" font-family="monospace" font-size="15" fill="currentColor">consumer</text>
  <text x="345" y="112" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">prio 3</text>
  <line x1="130" y1="95" x2="166" y2="95" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <line x1="250" y1="95" x2="286" y2="95" stroke="#0f766e" stroke-width="2" marker-end="url(#arr)"/>
  <text x="210" y="196" text-anchor="middle" font-family="monospace" font-size="12" fill="currentColor">the kernel copies the data; the tasks never share memory</text>
</svg>
<figcaption>FIG. 1 — A FreeRTOS queue between two tasks: blocking on both ends, FIFO order, backpressure when full.</figcaption>
</figure>

## Mutex vs binary semaphore: priority inversion, reproduced

A **mutex** is a lock with an owner and one superpower: **priority inheritance**. A **binary semaphore** is just a signal — no owner, no inheritance. Confusing them is the cheapest way to ship a heisenbug, so here is the full experiment: `LOW` (prio 1) takes a lock for a 300 ms critical section; `HIGH` (prio 3) wants it at t=20 ms; `MED` (prio 2) starts at t=40 ms and burns 500 ms of CPU. Run 1 uses a binary semaphore, run 2 a mutex:

```console
[    0 ms] SEQ    | run 1: BINARY SEMAPHORE (no inheritance) - HIGH expected to be starved by MED
[    1 ms] LOW    | lock taken, starting 300 ms critical section
[   21 ms] HIGH   | trying to take the lock...
[   41 ms] MED    | unrelated medium work starts (500 ms of CPU)
[  496 ms] MED    | medium work done
[  496 ms] HIGH   | got the lock after 475 ms
[  496 ms] LOW    | lock released
[ 1401 ms] SEQ    | run 1 over at tick 1401
[ 1401 ms] SEQ    | run 2: MUTEX (priority inheritance) - HIGH expected to wait only LOW's section
[ 1401 ms] LOW    | lock taken, starting 300 ms critical section
[ 1421 ms] HIGH   | trying to take the lock...
[ 1676 ms] HIGH   | got the lock after 255 ms
[ 1676 ms] MED    | unrelated medium work starts (500 ms of CPU)
[ 2137 ms] MED    | medium work done
[ 2137 ms] LOW    | lock released
[ 2301 ms] SEQ    | done. final tick = 2301
```

Run 1 is **priority inversion**: `HIGH` (prio 3) is ready but blocked on the lock; `MED` (prio 2) preempts `LOW` (prio 1) and runs its full 500 ms while `HIGH` waits. `HIGH` gets the lock at tick 496 — after **475 ms**, of which `LOW`'s own critical section accounts for only ~275 ms. The rest is pure inversion.

Run 2 is the same code with one change: a mutex. When `HIGH` blocks on it, the kernel *temporarily raises `LOW` to priority 3*. Look at `MED`'s "medium work starts" line: it prints at tick 1676, not at 1441 when `MED` was created — `MED` could not run while `LOW` was boosted. `HIGH` waits only **255 ms**, bounded by exactly the remainder of `LOW`'s critical section. Inheritance converts "as long as anyone else wants the CPU" into "as long as the critical section itself."

And the lesson underneath: even with inheritance, `HIGH` sat inside a critical section for 255 ms. **Keep critical sections short** — register reads, not sensor conversions. The demo stretches them to 300 ms only so the inversion shows up in a log.

## uxTaskGetStackHighWaterMark: sizing stacks

On a superloop there is no stack to size. In FreeRTOS every task gets its own stack; guess it wrong and you get heap corruption with no crash at the fault. The kernel fills every stack with a known pattern (`0xa5`) at creation, and `uxTaskGetStackHighWaterMark(NULL)` reports how many words were *never touched* — your real headroom. The recipe: generous stack, run the worst case, subtract the mark, ship with margin.

I ran it with a "heavy" task that genuinely uses 768 bytes:

```console
[    1 ms] HEAVY  | free stack before work: 1019 words
[    1 ms] HEAVY  | free stack after work:  1019 words (delta 0 words = 0 bytes)
[    1 ms] LIGHT  | free stack: 1019 words - barely touches the stack
```

All 1019 words free, before and after. That is **not** a bug in my demo — it is an honest property of this port: the POSIX port runs each task's C code on the pthread's native stack; the FreeRTOS heap region holding the pattern fill is only bookkeeping. The API answered truthfully about the region it can see. On ESP32 the same call walks the real hardware stack the CPU's stack pointer uses, so the number is meaningful there — stack sizing is a measure-on-the-target job.

The round-robin part of the same binary is real scheduling: two priority-2 spinners, time-sliced by the tick.

```console
[  201 ms] rrA    | start tick 201
[  202 ms] rrB    | start tick 202
[  226 ms] rrB    |   ...still spinning at tick 226
[  227 ms] rrA    |   ...still spinning at tick 227
[  252 ms] rrB    |   ...still spinning at tick 252
[  253 ms] rrA    |   ...still spinning at tick 253
...
[  400 ms] rrB    | end tick 400
[  401 ms] rrA    | end tick 401
```

Same priority, no yields; the tick swaps them every millisecond — the interleaved lines are the scheduler's doing.

## Mapping all of this to the ESP32

Everything above runs unmodified on ESP32, because **ESP-IDF *is* FreeRTOS**. The mapping:

- **Creating tasks.** `xTaskCreate(fn, name, stack_words, param, prio, &handle)` is identical. ESP-IDF adds `xTaskCreatePinnedToCore` to choose a core: pin protocol drivers to core 0 (PRO_CPU), user tasks to core 1 (APP_CPU), or leave them unpinned (they migrate — usually a footgun, pin deliberately).
- **Task priority.** Same rule — higher number wins, always preemptive. ESP-IDF gives 25 levels (0–24) by default; keep blocking tasks below the timer daemon.
- **The tick.** My demo tick is 1 ms (1000 Hz); ESP-IDF's default is `CONFIG_FREERTOS_HZ = 100`, a 10 ms tick. Same `vTaskDelay(pdMS_TO_TICKS(ms))` idiom — but `vTaskDelay(1)` means "about 10 ms" on the chip.
- **Queues and mutexes.** `xQueueCreate`/`xQueueSend`/`xQueueReceive` and `xSemaphoreCreateMutex` behave exactly as shown, including the inheritance fix. Mutexes for ownership ("this sensor is mine"), semaphores for signalling ("data ready"), never a binary semaphore as a lock.
- **Stack sizing.** `uxTaskGetStackHighWaterMark` works on the real stack; ESP-IDF also offers `uxTaskGetStackHighWaterMark2` and a stack-overflow hook (`CONFIG_FREERTOS_CHECK_STACKOVERFLOW`). [My power post](/posts/esp32-power-management/) touches the sleep side; task design is this post's half.
- **ISR variants.** ESP32 gives you `...FromISR` everywhere: `xQueueSendFromISR`, `xSemaphoreGiveFromISR`, plus the "higher-priority task woken" yield pattern. My demos have no interrupts — the one big area this laptop cannot reproduce.

## Caveats before you copy-paste

- **An RTOS does not make your code race-free.** It gives you the primitives to be correct. A mutex you forget, a shared `struct` you read without a queue, a critical section that calls `printf` — the kernel will not save you.
- **Keep critical sections short.** The demo's 300 ms sections are deliberately absurd; on hardware the take-to-give span should be microseconds.
- **The POSIX port is not hard real-time.** `SIGALRM` ticks and pthread scheduling mean millisecond jitter. The *logic* transfers; the *timing guarantees* do not. Validate deadlines on the chip.
- **Tick rate changes everything.** 100 Hz on ESP32 vs 1000 Hz here means `vTaskDelay` granularity differs tenfold.

What transferred completely: tasks, preemption, priorities, round-robin, blocking versus sleeping, queues as data channels, mutexes versus semaphores, priority inversion and its fix. Keep one habit if you keep none other: never busy-wait, and never share memory when a queue will do.
