---
title: "无 RTOS 的嵌入式 C：让超级循环更可靠"
description: "超级循环对许多设备来说够用，但一个慢任务会拖垮所有其他任务。用真实测量展示抖动和漂移，以及无需 RTOS 的修复方案：固定时间片调度器、状态机和看门狗。"
pubDate: 2027-02-12
lang: zh
translationKey: embedded-c-without-an-rtos
tags: [embedded, c]
featured: false
keywords:
  - superloop
  - embedded C without RTOS
  - fixed timestep scheduler
  - task jitter
  - watchdog
---

超级循环（superloop）——一个 `while(1)` 依次调用每个任务——是我们大多数人在微控制器上写的第一个程序。它简单、可调试，对相当多的设备来说已经足够好。但只要有一个任务阻塞或运行时间过长，其他所有任务都会受到影响。我见过这在生产环境中出问题：一个偶尔耗时 50 ms 的传感器读取，会让一个需要每 5 ms 运行一次的控制循环挨饿，设备在现场表现异常。

这篇文章中，我想用真实数字展示这个问题，然后介绍不需要 RTOS 的修复方案——固定时间片调度器、非阻塞状态机和看门狗。以下所有代码都是真实的 C 代码，我在这台 Linux 主机上用 `gcc -O2` 编译并运行。测量使用 `clock_gettime(CLOCK_MONOTONIC)`，输出真实的微秒级差值。

如果你对嵌入式网络不熟悉，我的文章 [调试嵌入式 TCP](/zh/posts/debugging-tcp-on-embedded/) 和 [ESP32-C3 入门](/zh/posts/esp32-c3-getting-started/) 涵盖了硬件方面的内容。这里我们聚焦在调度器层面。

## 超级循环及其适用场景

超级循环就是字面意思：

```c
int main(void) {
    hardware_init();
    while (1) {
        task_a();
        task_b();
        task_c();
    }
}
```

每个任务运行到完成，然后下一个开始。没有抢占，没有优先级反转，没有上下文切换开销。对于一个只有少量任务的小型 MCU，这通常是正确的选择。你可以通过从上到下阅读来推理整个系统。

问题在于循环周期是所有任务时间的总和。如果 `task_a` 耗时 2 ms，`task_b` 耗时 5 ms，`task_c` 耗时 1 ms，那么循环每 8 ms 运行一次——任何需要比 8 ms 更紧截止期的任务都没戏了。

## 问题：抖动和漂移的真实测量

我写了一个包含三个任务的朴素超级循环，用 `clock_gettime(CLOCK_MONOTONIC)` 测量每个任务的实际周期：

```c
static uint64_t now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

static void spin_us(uint64_t us) {
    uint64_t start = now_us();
    while (now_us() - start < us) {}
}

static void task_a(void) { spin_us(2000); }   /* 2 ms 工作 */
static void task_b(void) { spin_us(5000); }   /* 5 ms 工作 */
static void task_c(void) { spin_us(1000); }   /* 1 ms 工作 */
```

以下是 20 次迭代后的真实输出：

```
Iter |  A_period  |  B_period  |  C_period  |  Loop_total |  Drift
-----+------------+------------+------------+-------------+--------
  0  |     2000 us |     7000 us |     8000 us |      8000s |     +0 us
  1  |     8004 us |     8004 us |     8004 us |      8004s |     +4 us
  2  |     8004 us |     8004 us |     8004 us |      8004s |     +4 us
  3  |     8005 us |     8005 us |     8005 us |      8005s |     +5 us
  5  |     8003 us |     8003 us |     8003 us |      8003s |     +3 us
 10  |     8001 us |     8001 us |     8001 us |      8001s |     +1 us
 17  |     8014 us |     8014 us |     8014 us |      8014s |    +14 us
 19  |     8007 us |     8007 us |     8007 us |      8007s |     +7 us
```

有两个问题很明显。第一，每个任务的周期相同——都是 8 ms——因为它们是顺序执行的。任务 A 并不是每 2 ms 运行一次；它每 8 ms 运行一次，等待 B 和 C。第二，存在真实抖动：循环总时间在 8001 到 8014 µs 之间变化，13 µs 的波动。这是定时器开销、缓存效应和 `clock_gettime` 调用本身造成的。在有中断处理器的真实 MCU 上，抖动会更严重。

如果任务 A 有 5 ms 的截止期，它每次迭代都会错过。这就是根本问题：在朴素超级循环中，最慢的任务决定了所有任务的周期。

## 修复 1：带截止期表的固定时间片调度器

第一个修复方案是给每个任务自己的周期，并跟踪它的截止时间。不再按顺序调用任务，而是维护一个截止期表，运行所有到期的任务：

```c
typedef struct {
    const char *name;
    void (*func)(void);
    uint64_t period_us;
    uint64_t next_due;
    uint64_t max_jitter;
    uint64_t runs;
} task_t;

task_t tasks[] = {
    { "sensor",  task_sensor,  10000, t0 + 10000, 0, 0 },
    { "control", task_control, 20000, t0 + 20000, 0, 0 },
    { "comm",    task_comm,     5000, t0 +  5000, 0, 0 },
};

while (1) {
    uint64_t now = now_us();
    for (int i = 0; i < NUM_TASKS; i++) {
        if (now >= tasks[i].next_due) {
            tasks[i].func();
            tasks[i].next_due += tasks[i].period_us;
        }
    }
}
```

我用 10 ms 的传感器任务、20 ms 的控制任务和 5 ms 的通信任务运行了这个程序。真实输出：

```
Tick | Task     | Expected | Actual   | Jitter   | Total_runs
-----+----------+----------+----------+----------+-----------
   0 | comm     |   5000 us |   5428 us |  +428 us |      1
   1 | sensor   |  10000 us |  10530 us |  +530 us |      1
   2 | comm     |   5000 us |   7036 us | +2036 us |      2
   3 | comm     |   5000 us |   6037 us | +1037 us |      3

--- Summary ---
sensor  : 1 runs, max jitter = 530 us
control : 0 runs, max jitter = 0 us
comm    : 3 runs, max jitter = 2036 us
```

调度器工作了——任务按自己的周期运行——但看看抖动。通信任务（5 ms 周期）的抖动高达 2036 µs。为什么？因为传感器任务占用 1.5 ms 的 CPU 时间，当它运行时，会延迟通信任务的下次调用。控制任务（20 ms 周期）在这个短测试中没有运行，因为循环太忙了。

这就是关键洞察：固定时间片调度器不会消除抖动；它只是让抖动变得可见且有界。你现在可以测量它，而测量结果会告诉你截止期是否得到满足。

## 修复 2：协作式任务表

对许多项目来说，更清晰的模式是协作式任务表——一个函数指针数组，每个任务有一个下次运行时刻：

```c
typedef struct {
    const char *name;
    void (*func)(void);
    uint64_t period_us;
    uint64_t next_run;
    uint64_t run_count;
} coop_task_t;

coop_task_t tasks[] = {
    { "read_adc",    task_read_adc,    5000, t0 +  5000, 0 },
    { "update_pwm",  task_update_pwm,  2000, t0 +  2000, 0 },
    { "send_uart",   task_send_uart,  10000, t0 + 10000, 0 },
    { "blink_led",   task_blink_led,   500,  t0 +   500, 0 },
};

while (1) {
    uint64_t now = now_us();
    for (int i = 0; i < NUM_TASKS; i++) {
        if (now >= tasks[i].next_run) {
            tasks[i].func();
            tasks[i].next_run += tasks[i].period_us;
            tasks[i].run_count++;
        }
    }
}
```

运行 50 ms 后的结果：

```
--- Final counts after 50 ms ---
read_adc    : 9 runs (expected ~10)
update_pwm  : 24 runs (expected ~25)
send_uart   : 4 runs (expected ~5)
blink_led   : 62 runs (expected ~100)
```

计数接近预期但不精确——循环开销和每个任务内部花费的时间会稍微偏移截止期。这是正常的。重要的是每个任务大致以自身的速率运行，慢任务不会阻止快任务运行。

## 修复 3：用非阻塞状态机替代 delay()

超级循环中最常见的 bug 是阻塞式 `delay()` 或 `sleep()`。当一个任务睡眠时，整个循环都冻结了。我写了一个演示程序，比较阻塞式延迟和非阻塞状态机在检测按钮按下时的差异：

```c
/* 阻塞版本——错过事件 */
for (int i = 0; i < 20; i++) {
    spin_us(500000); /* 500 ms 阻塞延迟 */
    if (button_pressed(now)) { /* 延迟后才检查 */ }
}

/* 非阻塞版本——状态机 */
typedef enum { IDLE, DEBOUNCE, PRESSED } button_state_t;
button_state_t state = IDLE;

while (now_us() - t0 < 100000) {
    bool raw = button_pressed(now);
    switch (state) {
        case IDLE:
            if (raw) { state = DEBOUNCE; state_entry = now; }
            break;
        case DEBOUNCE:
            if (now - state_entry >= 5000) {
                if (raw) { state = PRESSED; detected = true; }
                else state = IDLE;
            }
            break;
        case PRESSED:
            if (!raw) state = IDLE;
            break;
    }
    spin_us(100); /* 每次循环做其他工作 */
}
```

真实输出说明了一切：

```
--- Blocking Version (delay-based) ---
  Button press at t=30ms was MISSED (still in delay)
  Detection latency: >500ms (deadline was 10ms)

--- Non-Blocking Version (state machine) ---
  Button detected at t=35 ms
  Detection latency: 5 ms from press (deadline was 10ms) — PASS
```

阻塞版本完全错过了按钮，因为按下时它还在 500 ms 的延迟中。非阻塞状态机在按下后 5 ms 检测到——在 10 ms 截止期内。这个差异不是微妙的；它是一个设备能响应和不能响应之间的差异。

规则很简单：永远不要在超级循环中调用阻塞延迟。如果你需要等待，使用一个检查时间、只在截止期过后才推进的状态机。

## 修复 4：看门狗踢狗

即使使用了非阻塞代码，任务仍然可能挂死——I2C 总线被拉低、内存分配永不返回、由损坏状态触发的无限循环。看门狗定时器在软件未在超时时间内踢狗时复位系统。

模式很直接：

```c
typedef struct {
    uint64_t timeout_us;
    uint64_t last_kick;
    uint64_t reset_count;
} watchdog_t;

watchdog_t wd;
watchdog_init(&wd, 100000); /* 100 ms 超时 */

for (int i = 0; i < 10; i++) {
    watchdog_kick(&wd);          /* 循环开始踢狗 */
    task_that_might_hang(i);     /* 正常 5ms，但迭代 5 挂死 500ms */
    if (!watchdog_check(&wd)) {  /* 任务后检查 */
        /* 看门狗触发——系统会在这里复位 */
    }
}
```

真实输出：

```
Iter | Task_time | Watchdog_status
-----+-----------+----------------
  0  |   5000 us | OK
  1  |   5000 us | OK
  2  |   5000 us | OK
  3  |   5000 us | OK
  4  |   5000 us | OK
  [TASK] Iteration 5: simulating hang (500ms spin)...
  [TASK] Iteration 5: recovered
  [WATCHDOG] Timeout! No kick for 500004 us — RESET #1
  5  | 500004 us | RESET
  6  |   5000 us | OK
  7  |   5000 us | OK
  8  |   5000 us | OK
  9  |   5001 us | OK

Total watchdog resets: 1
```

看门狗恰好触发一次，当任务挂死 500 ms 时——是 100 ms 超时的五倍。在真实硬件上，看门狗会复位 MCU，系统会恢复。没有它，设备会永远挂死。

关键是在每次循环迭代开始时踢狗，而不是结束时。如果你在结束时踢狗，挂死的任务会阻止踢狗，看门狗会触发——这正是你想要的。如果你在开始时踢狗，你是在承诺"我将在超时时间内完成这次迭代"，看门狗让你信守这个承诺。

## 你真正需要 RTOS 的时候

我不是反 RTOS。有些问题超级循环确实无法解决：

- **带阻塞 API 的硬截止期。** 如果你必须调用阻塞的 socket `read()` 或阻塞的 I2C 事务，而且你有一个比最坏情况阻塞时间更短的截止期，你需要抢占。RTOS 让你在低优先级任务阻塞时运行高优先级任务。

- **真正的并行。** 如果你有两个必须以不同速率同时运行的控制循环，且两者都无法变成非阻塞的，带抢占式调度的 RTOS 是正确的工具。

- **复杂的同步。** 互斥锁、信号量和消息队列在超级循环上很难正确实现。如果你的系统需要它们，RTOS 给你经过测试的原语。

但对于大多数小型嵌入式设备——传感器节点、电机控制器、简单 UI——带固定时间片调度器、非阻塞状态机和看门狗的超级循环更简单、更易调试，而且完全够用。RTOS 增加了复杂性：上下文切换、栈管理、优先级配置，以及一整类超级循环永远不会有的 bug（优先级反转、栈溢出、死锁）。

## 诚实建议：先测量

在选择 RTOS 之前，先测量你的抖动。在 Linux 上使用 `clock_gettime(CLOCK_MONOTONIC)`，或在你的 MCU 上使用硬件定时器，记录每个任务的实际周期。计算最大抖动——最长周期和最短周期之间的差值。如果最大抖动远在截止期之内，你不需要 RTOS。如果不在，修复那个任务：让它变成非阻塞的，移到定时器中断中，或拆分成更小的步骤。

超级循环不是玩具。它是一个支撑数百万设备的合法架构。关键是理解它的局限——一个慢任务会拖垮其他任务——并应用保持其可靠的修复方案：固定时间片调度器让每个任务有自己的周期，非阻塞状态机让没有任务能冻结循环，看门狗让挂死任务不会挂死设备。测量抖动，修复你发现的问题，然后才考虑 RTOS 是否值得它的复杂性。
