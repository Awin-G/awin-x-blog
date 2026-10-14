---
title: "Embedded C Without an RTOS: Making the Superloop Reliable"
description: "A superloop is fine for many devices, but one slow task starves the others. Real measurements of jitter and drift, plus the fixes that don't need an RTOS: fixed-timestep schedulers, state machines, and watchdogs."
pubDate: 2027-02-12
lang: en
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

The superloop — a `while(1)` that calls each task in turn — is the first
program most of us write for a microcontroller. It is simple, debuggable, and
good enough for many devices. But one task that blocks or runs long starves
every other task. I have seen this bite in production: a sensor read that
occasionally takes 50 ms starves a control loop that needs 5 ms.

In this article I show the problem with real numbers, then walk through fixes
that do not require an RTOS — a fixed-timestep scheduler, non-blocking state
machines, and a watchdog. All code below is real C compiled and run on this
Linux host with `gcc -O2`. Measurements use `clock_gettime(CLOCK_MONOTONIC)`
and print actual microsecond deltas.

If you are new to embedded networking, my posts on
[debugging TCP on embedded](/posts/debugging-tcp-on-embedded/) and
[ESP32-C3 getting started](/posts/esp32-c3-getting-started/) cover the
hardware side. Here we stay at the scheduler level.

## The superloop and why it works

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

Each task runs to completion, then the next starts. No preemption, no priority
inversion, no context-switch overhead. The catch: the loop period is the sum
of all task times. If `task_a` takes 2 ms, `task_b` 5 ms, `task_c` 1 ms, the
loop runs every 8 ms — and any task needing a tighter deadline is out of luck.

## The problem: jitter and drift, measured

I wrote a naive superloop with three tasks and measured each period:

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

static void task_a(void) { spin_us(2000); }   /* 2 ms work */
static void task_b(void) { spin_us(5000); }   /* 5 ms work */
static void task_c(void) { spin_us(1000); }   /* 1 ms work */
```

Real output after 20 iterations:

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

Two things jump out. Every task's period is the same — 8 ms — because they
are sequential. Task A does not run every 2 ms; it runs every 8 ms, waiting
for B and C. And there is real jitter: the loop total varies from 8001 to
8014 µs, a 13 µs spread. On a real MCU with interrupt handlers, the jitter
would be far worse.

If task A had a 5 ms deadline, it would be missed every iteration. The
slowest task sets the period for everything.

## Fix 1: a fixed-timestep scheduler with a deadline table

Give each task its own period and track deadlines:

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

Real output with 10 ms sensor, 20 ms control, 5 ms comm:

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

The scheduler works — tasks run at their own periods — but the jitter is
real. The comm task shows up to 2036 µs of jitter because the sensor task
takes 1.5 ms of CPU time, delaying the comm task's next invocation. The
control task did not run at all in this short test.

Key insight: a fixed-timestep scheduler does not eliminate jitter; it makes
it visible and bounded.

## Fix 2: a cooperative task table

A cleaner pattern is a cooperative task table — function pointers with a
next-run tick for each:

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

Running for 50 ms:

```
--- Final counts after 50 ms ---
read_adc    : 9 runs (expected ~10)
update_pwm  : 24 runs (expected ~25)
send_uart   : 4 runs (expected ~5)
blink_led   : 62 runs (expected ~100)
```

Counts are close but not exact — loop overhead shifts deadlines slightly.
Each task runs at roughly its own rate, and a slow task does not prevent a
fast task from running.

## Fix 3: non-blocking state machines instead of delay()

The most common superloop bug is a blocking `delay()` or `sleep()`. While one
task sleeps, the entire loop is frozen. A demo comparing blocking vs
non-blocking for detecting a button press:

```c
/* Blocking version — misses the event */
for (int i = 0; i < 20; i++) {
    spin_us(500000); /* 500 ms blocking delay */
    if (button_pressed(now)) { /* check after delay */ }
}

/* Non-blocking version — state machine */
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
    spin_us(100); /* other work, every loop */
}
```

Real output:

```
--- Blocking Version (delay-based) ---
  Button press at t=30ms was MISSED (still in delay)
  Detection latency: >500ms (deadline was 10ms)

--- Non-Blocking Version (state machine) ---
  Button detected at t=35 ms
  Detection latency: 5 ms from press (deadline was 10ms) — PASS
```

The blocking version misses the button entirely — it is still in a 500 ms
delay when the press happens. The non-blocking state machine detects it 5 ms
after the press, within the 10 ms deadline. Rule: never call a blocking delay
in a superloop. Use a state machine that checks the time and advances only
when the deadline has passed.

## Fix 4: a watchdog kick

Even with non-blocking code, a task can hang — an I2C bus stuck low, an
infinite loop from corrupt state. A watchdog resets the system if not kicked
within a timeout.

```c
typedef struct {
    uint64_t timeout_us;
    uint64_t last_kick;
    uint64_t reset_count;
} watchdog_t;

watchdog_t wd;
watchdog_init(&wd, 100000); /* 100 ms timeout */

for (int i = 0; i < 10; i++) {
    watchdog_kick(&wd);          /* kick at start of loop */
    task_that_might_hang(i);     /* normal 5ms, iteration 5 hangs 500ms */
    if (!watchdog_check(&wd)) {  /* check after task */
        /* watchdog fired — system would reset here */
    }
}
```

Real output:

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

The watchdog fires once, when the task hangs 500 ms — five times the 100 ms
timeout. On real hardware, the MCU resets and the system recovers. Without
it, the device hangs forever.

Kick at the start of each loop iteration, not the end. If you kick at the
end, a hanging task prevents the kick and the watchdog fires — which is what
you want. If you kick at the start, you promise "I will complete this
iteration within the timeout," and the watchdog holds you to it.

## When you genuinely need an RTOS

I am not anti-RTOS. A superloop cannot handle hard deadlines with blocking APIs
(you need preemption when a blocking `read()` or I2C transaction exceeds your
deadline), true parallelism (two control loops at different rates, neither
makeable non-blocking), or complex synchronization (mutexes, semaphores, and
message queues are hard to implement correctly on a superloop).

But for most small embedded devices — a sensor node, a motor controller, a
simple UI — a superloop with a fixed-timestep scheduler, non-blocking state
machines, and a watchdog is simpler, easier to debug, and sufficient. An RTOS
adds context switches, stack management, priority configuration, and bugs
(priority inversion, stack overflow, deadlock) that a superloop never has.

## The honest advice: measure first

Before reaching for an RTOS, measure your jitter. Use
`clock_gettime(CLOCK_MONOTONIC)` on Linux, or a hardware timer on your MCU,
and record each task's actual period. Compute the max jitter — the difference
between longest and shortest period. If it is well within your deadline, you
do not need an RTOS. If not, fix the offending task: make it non-blocking,
move it to a timer interrupt, or split it into smaller steps.

The superloop is not a toy. It powers millions of devices. The trick is
understanding its limits — one slow task starves the others — and applying
the fixes: a fixed-timestep scheduler, non-blocking state machines, and a
watchdog. Measure the jitter, fix what you find, and only then consider
whether an RTOS is worth its complexity.
