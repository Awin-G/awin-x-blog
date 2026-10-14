---
title: "FreeRTOS 任务与队列：在笔记本上真实复现"
description: "在 Linux 上克隆 FreeRTOS 内核、用 gcc 编译其 POSIX 端口，跑了五组真实实验——抢占式调度、vTaskDelay 对比忙等、队列、互斥量优先级反转、栈高水位标记——再把每个概念映射到 ESP32 上的 ESP-IDF。"
pubDate: 2027-02-21
lang: zh
translationKey: esp32-freertos-tasks
tags: [embedded]
featured: false
keywords:
  - FreeRTOS 任务
  - FreeRTOS 队列
  - 任务优先级
  - 优先级反转
  - vTaskDelay
---

我写 ESP32 固件，几乎所有代码都跑在 FreeRTOS 上，而且几乎不假思索。ESP-IDF 就是 FreeRTOS，所以 `xTaskCreate`、队列、互斥量和 `vTaskDelay` 都是日常词汇。但词汇不等于理解。读者们在[我的 ESP32 入门指南](/zh/posts/esp32-c3-getting-started/)下反复追问：为什么"超级循环"扩展不动，任务优先级到底能买到什么，为什么我的传感器读数会读到损坏的值？所以我去把内核跑了一遍。

先把诚实的话放在前面：**本文没有使用任何 ESP32。** 这台机器上没有接开发板，所以下面所有内容都是在我的笔记本上用内核官方的 [POSIX 端口](https://freertos.org/FreeRTOS-simulator-for-Linux.html)复现的——一个 Linux 模拟器，每个 FreeRTOS 任务是一个 pthread，时钟节拍由一个定时器线程产生。API、调度逻辑和故障模式都是真实内核的，缺的只有硅片。有些东西能完美迁移（任务、优先级、队列、互斥量、优先级反转这个 bug），有些不能（微秒级时序、真正的硬实时）。

## RTOS 相比超级循环多了什么

超级循环就是 `while(1) { read_sensor(); send_uart(); blink_led(); }`。它直到两件事必须同时发生、或者某件事会阻塞时才失效。到那时你要么轮询一切（白烧周期），要么往上贴状态机标志，直到这个循环变成一份写得稀烂的 RTOS 文档。

RTOS 免费给你三样东西：

- **抢占。** 一个变为就绪的高优先级任务会*打断*低优先级任务——不用轮询，不用手动让出。
- **优先级。** 调度器永远运行优先级最高的就绪任务；同优先级任务每个节拍轮转。
- **阻塞原语。** 等待时不再空烧 CPU，任务*阻塞*在队列、信号量或互斥量上，把 CPU 让给别人。就这一个思想让整套模型变得合理。

下面所有内容就是这三个思想，用日志复现出来。

## 诚实的实验环境：Linux 上的 FreeRTOS

我克隆了官方仓库并拉取内核子模块：

```console
$ git clone --depth 1 https://github.com/FreeRTOS/FreeRTOS.git
$ cd FreeRTOS
$ git submodule update --init --depth 1 FreeRTOS/Source
```

内核（V11.3.1）自带 POSIX/Linux 移植层，位于 `FreeRTOS/Source/portable/ThirdParty/GCC/Posix/`。每个任务是一个 pthread；一个定时器线程通过 `SIGALRM` 每隔 `1000000 / configTICK_RATE_HZ` 微秒产生一次节拍。我用的是 `configTICK_RATE_HZ = 1000`——一个节拍就是一毫秒，下面每一行日志都用 `xTaskGetTickCount()` 打上毫秒时间戳。

构建就是普通的 gcc——移植层、内核和 `heap_3`（对 `malloc`/`free` 的薄封装）：

```console
$ gcc --version
gcc (GCC) 16.2.1 20260810

$ make build/preempt          # kernel + posix port + heap_3 + demo, -pthread link
$ ./build/preempt
```

我的 `FreeRTOSConfig.h` 刻意做得极简：`configUSE_PREEMPTION 1`、`configUSE_MUTEXES 1`、`configMAX_PRIORITIES 7`，关闭定时器和协程，分配器用 `heap_3.c`。下面每一段输出都来自真实运行。

## FreeRTOS 任务与任务优先级：日志里的抢占

`LOW`（优先级 1）分三步工作；每一步它都通过一个队列发一个令牌，而 `HIGH`（优先级 2）正阻塞在这个队列上。`HIGH` 立刻被唤醒，打印一行，再次阻塞——每一次都抢在 `LOW` *自己的两行输出之间*：

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

看时间戳列：第一次抢占的整个过程发生在一个 1 毫秒的节拍之内。`LOW` 调用了 `xQueueSend`，内核把 `HIGH` 标记为就绪，调度器在 `LOW` 的下一条语句之前就切换了上下文。没有人请求这次切换——这就是"抢占"里的"抢"。

同一优先级内部，任务之间*没有*特权：同优先级任务每个节拍轮转一次。

## vTaskDelay 对比忙等

从超级循环带入 RTOS 代码最常见的习惯就是空烧 CPU 等事件。一个优先级 2 的"旋转任务"和一个优先级 1 的"心跳任务"（每 50 ms 打印一次）：A 阶段，旋转任务用墙钟自旋循环忙等约 300 ms；B 阶段，它改用 `vTaskDelay(300)` 睡觉：

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

A 阶段是教科书式的饥饿：旋转任务*从不让出*，所以低优先级的心跳直到旋转任务结束的那一刻才跑。B 阶段是同样的代码改了一行：`vTaskDelay` 让旋转任务进入阻塞态 300 个节拍，心跳在中间独占 CPU，50 分钟的节拍节奏丝毫未乱。（心跳打印顺序错乱，是因为它在 A 阶段已经循环了一半——真实输出，连瑕疵一起呈现。）

两点收获。`vTaskDelay` 不是"暂停"——它阻塞，把 CPU 给其他就绪任务，而且以*节拍*为单位计时（`pdMS_TO_TICKS` 做转换；我的节拍是 1 ms）。如果需要严格周期而不是"至少睡这么久"，用 `vTaskDelayUntil`——`vTaskDelay` 会随循环剩余部分的耗时产生漂移。

## FreeRTOS 队列：任务间移动数据的安全方式

从超级循环移植到 RTOS 时最经典的 bug 就是共享全局变量：ISR 写 `g_sensor`，循环读它，直到抢占落在更新中间，读方就会看到撕裂的值。队列消灭了这一整类 bug：内核复制数据，发送方和接收方永远不会同时碰同一块内存。

A 阶段：一个优先级 3 的消费者用 `xQueueReceive(..., portMAX_DELAY)` 阻塞，同时一个优先级 2 的生产者每隔 15 ms 发五个读数。消费者*在每个值到达的瞬间*就被唤醒，并抢在生产者前面把它打印出来：

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

注意每次发送的顺序：消费者的"received"行*先于*生产者的"sent"行打印，而且是同一个节拍——接收在阻塞，发送让它就绪，抢占完成剩下的部分。FIFO 顺序由内核保证，不靠自觉。

B 阶段展示没人及时取走数据时会发生什么：队列只有两个槽位，生产者连续打四个读数、发送超时设为 0：

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

那个 `FULL, dropped` 就是 `xQueueSend` 在队列满时带超时 0 返回的 `errQUEUE_FULL`——背压被明确展现出来，而不是悄悄写坏一个共享变量。（在 ESP32 上你通常会用超时阻塞发送，并且*处理*队列满的情况。）

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
<figcaption>FIG. 1 — 两个任务之间的 FreeRTOS 队列：两端都能阻塞，FIFO 顺序，满了就产生背压。</figcaption>
</figure>

## 互斥量对比二值信号量：优先级反转的真实复现

**互斥量**是一把有所有者的锁，还带一项超能力：**优先级继承**。**二值信号量**只是一个信号——没有所有者，也没有继承。把两者搞混是引入海森堡 bug 最便宜的方式，所以这里是完整实验：`LOW`（优先级 1）拿锁进入 300 ms 临界区；`HIGH`（优先级 3）在 t=20 ms 时想要同一把锁；`MED`（优先级 2）在 t=40 ms 开始烧 500 ms CPU 做无关的事。运行 1 用二值信号量，运行 2 用互斥量：

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

运行 1 就是**优先级反转**：`HIGH`（优先级 3）就绪但阻塞在锁上；`MED`（优先级 2）抢占了 `LOW`（优先级 1），在 `HIGH` 等待期间跑完自己整整 500 ms。`HIGH` 在 tick 496 才拿到锁——等了 **475 ms**，而 `LOW` 自己的临界区只占其中约 275 ms，其余全是纯粹的翻转。

运行 2 是同样的代码只改一处：换成互斥量。当 `HIGH` 阻塞在上面时，内核会*临时把 `LOW` 提升到优先级 3*。看 `MED` 的"medium work starts"行：它打印在 tick 1676，而不是 `MED` 被创建的 1441——`LOW` 被提升期间 `MED` 根本跑不了。`HIGH` 只等了 **255 ms**，恰好被 `LOW` 临界区的剩余部分限住。继承把"只要别人还想用 CPU 就等多久"变成了"只等临界区本身那么久"。

底层还有一个教训：即使有继承，`HIGH` 也在临界区里坐了 255 ms。**让临界区保持简短**——读几个寄存器，别放传感器转换。本实验把它拉到 300 ms 只是为了让反转在日志里可见。

## uxTaskGetStackHighWaterMark：给栈定尺寸

超级循环没有栈可定尺寸。FreeRTOS 里每个任务都有自己的栈；猜错了不会当场崩溃，而是悄悄踩坏堆。内核在每个栈创建时用已知模式（`0xa5`）填充，`uxTaskGetStackHighWaterMark(NULL)` 报告有多少字*从未被碰过*——你的真实余量。套路：给新任务一个宽裕的栈，跑最坏路径，减掉这个值，再加余量出厂。

我用一个真正吃掉 768 字节栈的"重任务"跑了一遍：

```console
[    1 ms] HEAVY  | free stack before work: 1019 words
[    1 ms] HEAVY  | free stack after work:  1019 words (delta 0 words = 0 bytes)
[    1 ms] LIGHT  | free stack: 1019 words - barely touches the stack
```

前后都是 1019 字空闲。这**不是**我演示里的 bug——这是本端口的一个诚实特性：POSIX 端口把每个任务的 C 代码跑在 pthread 的原生栈上，而持有模式填充的 FreeRTOS 堆区域只是账本。API 对自己能看见的区域说了真话。在 ESP32 上，同一个调用走的是 CPU 栈指针真正使用的硬件栈，所以那个数字在那里才有意义——栈定尺寸是一桩"在靶子上测量"的活。

同一个二进制里的轮转部分则是真调度：两个优先级 2 的旋转任务，被节拍分时。

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

同优先级、不让出，节拍每毫秒把它们交换一次——交错的日志行就是调度器干的。

## 把这一切映射到 ESP32

上面所有内容在 ESP32 上原封不动就能跑，因为 **ESP-IDF 就是 FreeRTOS**。映射关系：

- **创建任务。** `xTaskCreate(fn, name, stack_words, param, prio, &handle)` 完全一致。ESP-IDF 加了 `xTaskCreatePinnedToCore` 来选核：协议驱动钉在核 0（PRO_CPU），用户任务钉在核 1（APP_CPU），或不钉（它们会迁移——通常是地雷，要有意识地钉）。
- **任务优先级。** 规则相同——数字大的赢，永远抢占。ESP-IDF 默认给 25 级（0–24）；阻塞型任务保持在定时器守护任务之下。
- **节拍。** 我的演示节拍是 1 ms（1000 Hz）；ESP-IDF 默认 `CONFIG_FREERTOS_HZ = 100`，即 10 ms 节拍。`vTaskDelay(pdMS_TO_TICKS(ms))` 用法不变——但在芯片上 `vTaskDelay(1)` 的意思是"大约 10 ms"。
- **队列与互斥量。** `xQueueCreate`/`xQueueSend`/`xQueueReceive` 和 `xSemaphoreCreateMutex` 行为与上面完全一致，包括继承修复。互斥量表示所有权（"这个传感器是我的"），信号量表示 signaling（"数据好了"），永远不要用二值信号量当锁。
- **栈定尺寸。** `uxTaskGetStackHighWaterMark` 在真实栈上有效；ESP-IDF 还提供 `uxTaskGetStackHighWaterMark2` 和栈溢出钩子（`CONFIG_FREERTOS_CHECK_STACKOVERFLOW`）。[我的电源管理一文](/zh/posts/esp32-power-management/)讲的是睡眠这一半，任务设计是本文这一半。
- **ISR 变体。** ESP32 上到处都是 `...FromISR`：`xQueueSendFromISR`、`xSemaphoreGiveFromISR`，外加"唤醒了更高优先级任务"的让出模式。我的演示没有中断——这正是笔记本无法复现的最大一块。

## 抄走之前的 caveat

- **RTOS 不会让你的代码免于竞态。** 它只给你做到正确的工具。忘加的互斥量、不经队列就读的共享 `struct`、临界区里调用 `printf`——内核救不了你。
- **让临界区保持简短。** 演示里 300 ms 的临界区是故意夸张；硬件上从 `xSemaphoreTake` 到 `xSemaphoreGive` 应该是微秒级。
- **POSIX 端口不是硬实时。** `SIGALRM` 节拍和 pthread 调度意味着毫秒级抖动。*逻辑*能迁移，*时序保证*不能。在芯片上验证截止期限。
- **节拍率改变一切。** ESP32 上的 100 Hz 对比此处的 1000 Hz，意味着 `vTaskDelay` 粒度相差十倍。

完整迁移的东西：任务、抢占、优先级、轮转、阻塞对睡眠、队列作为数据通道、互斥量对信号量、优先级反转及其修复。只留一个习惯的话：永不忙等，永不共享内存——能用队列就别共享。
