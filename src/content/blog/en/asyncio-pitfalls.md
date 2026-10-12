---
title: "asyncio pitfalls: the five mistakes that stall your event loop"
description: "Real measured timings showing how blocking calls, sequential awaits, un-awaited coroutines, and CPU-bound work silently kill your asyncio performance — and how to fix each one."
pubDate: 2026-12-31
lang: en
translationKey: asyncio-pitfalls
tags: [python]
featured: false
keywords:
  - asyncio pitfalls
  - event loop blocking
  - asyncio.gather
  - python async
  - run_in_executor
---

asyncio is one of Python's most powerful features — and one of the most misunderstood. The mental model is simple: one thread, cooperative scheduling. But that simplicity hides a brutal truth: **anything that blocks the event loop blocks everything**. A single `time.sleep(1)` doesn't just delay one task — it freezes every other coroutine, every heartbeat, every connection.

In this article I'll walk through the five asyncio pitfalls that cause the most real-world damage, with measured timings from Python 3.14.7 on Linux. Every code block is a real script I ran; every number is real output.

## The mental model: one thread, cooperative scheduling

asyncio runs your coroutines on a single thread. There is no preemption — a coroutine keeps control until it hits an `await` that actually yields (like `asyncio.sleep`, a socket read, or a queue get). If your code never yields, the loop never gets control back.

This means:

- `await asyncio.sleep(1)` → yields, loop can run other tasks ✅
- `time.sleep(1)` → blocks the thread, loop is frozen ❌
- `requests.get(url)` → blocks the thread, loop is frozen ❌
- `for i in range(10_000_000): total += i` → blocks the thread, loop is frozen ❌

The fix is always the same: **find the blocking call, move it off the loop**. But first, let's see the damage.

## Pitfall #1: blocking calls in async code

The most common asyncio pitfall is calling a synchronous blocking function inside a coroutine. `time.sleep`, `requests.get`, `psycopg2` queries, file I/O — they all block the entire event loop.

Here's a minimal reproduction:

```python
import asyncio, time

async def heartbeat():
    for i in range(6):
        print(f"  [heartbeat] tick {i}  t={time.perf_counter()-T0:.3f}s")
        await asyncio.sleep(0.3)

async def blocking_task():
    print(f"  [blocker ] START blocking sleep(1.0)  t={time.perf_counter()-T0:.3f}s")
    time.sleep(1.0)  # <-- THE MISTAKE
    print(f"  [blocker ] DONE  blocking sleep(1.0)  t={time.perf_counter()-T0:.3f}s")

async def main():
    global T0
    T0 = time.perf_counter()
    await asyncio.gather(heartbeat(), blocking_task(), heartbeat())

asyncio.run(main())
```

Real output:

```
  [heartbeat] tick 0  t=0.000s
  [blocker ] START blocking sleep(1.0)  t=0.000s
  [blocker ] DONE  blocking sleep(1.0)  t=1.000s
  [heartbeat] tick 0  t=1.000s
  [heartbeat] tick 1  t=1.000s
  [heartbeat] tick 1  t=1.301s
  [heartbeat] tick 2  t=1.301s
  [heartbeat] tick 2  t=1.601s
  [heartbeat] tick 3  t=1.601s
  [heartbeat] tick 3  t=1.901s
  [heartbeat] tick 4  t=1.901s
  [heartbeat] tick 4  t=2.202s
  [heartbeat] tick 5  t=2.202s
  [heartbeat] tick 5  t=2.502s
```

Look at the heartbeat ticks. They should fire every 0.3s. Instead, ticks 0 and 1 both fire at `t=1.000s` — the loop was frozen for a full second while `time.sleep(1.0)` ran. Every other coroutine, every pending I/O event, every timer callback — all delayed by 1 second.

In production this looks like: your WebSocket server stops responding, your health checks fail, your metrics show request latency spikes — all because one coroutine called a sync library.

**The fix**: use async alternatives (`aiohttp` instead of `requests`, `asyncpg` instead of `psycopg2`, `aiofiles` instead of `open`), or move blocking work off the loop (more on that in the [executor section](#running-blocking-and-cpu-work-off-the-loop)).

## Pitfall #2: sequential awaits instead of asyncio.gather

The second most common mistake is awaiting coroutines one at a time when they could run concurrently. This isn't a correctness bug — it's a performance bug that silently makes your code 3x, 10x, 100x slower.

```python
import asyncio, time

T0 = 0.0

async def fake_io(name: str, delay: float) -> str:
    await asyncio.sleep(delay)
    return f"{name} done"

async def sequential():
    results = []
    for i, delay in enumerate([0.3, 0.3, 0.3]):
        r = await fake_io(f"seq-{i}", delay)
        results.append(r)
    return results

async def concurrent():
    return await asyncio.gather(
        fake_io("par-0", 0.3),
        fake_io("par-1", 0.3),
        fake_io("par-2", 0.3),
    )

async def main():
    global T0
    T0 = time.perf_counter()
    print("=== sequential await ===")
    T0 = time.perf_counter()
    await sequential()
    seq_time = time.perf_counter() - T0
    print(f"  elapsed: {seq_time:.3f}s\n")
    print("=== asyncio.gather ===")
    T0 = time.perf_counter()
    await concurrent()
    par_time = time.perf_counter() - T0
    print(f"  elapsed: {par_time:.3f}s\n")
    print(f"speedup: {seq_time/par_time:.1f}x")

asyncio.run(main())
```

Real output:

```
=== sequential await ===
  elapsed: 0.901s

=== asyncio.gather ===
  elapsed: 0.301s

speedup: 3.0x
```

Three 0.3s I/O operations: 0.901s sequential vs 0.301s concurrent. The math is obvious — sequential is the sum, concurrent is the max — but in real code the awaits are scattered across functions, hidden behind conditionals, and the slowness is invisible until you profile.

**The fix**: when you have independent I/O operations, wrap them in `asyncio.gather`. In Python 3.11+, you can also use `asyncio.TaskGroup` for structured concurrency:

```python
async with asyncio.TaskGroup() as tg:
    task1 = tg.create_task(fetch_user(user_id))
    task2 = tg.create_task(fetch_orders(user_id))
# Both complete here; if one raises, the others are cancelled
```

## Pitfall #3: forgetting to await a coroutine

This one is insidious because it doesn't crash — it just silently does nothing. If you call a coroutine function without `await`, you get a coroutine object that never executes:

```python
import asyncio

async def fetch_data() -> str:
    await asyncio.sleep(0.1)
    return "data"

async def main():
    result = fetch_data()  # WRONG: missing await
    print(f"  type(result) = {type(result)}")
    print(f"  result        = {result}")

asyncio.run(main())
```

Real output:

```
/usr/lib/python3.14/asyncio/events.py:94: RuntimeWarning: coroutine 'fetch_data' was never awaited
  self._context.run(self._callback, *self._args)
RuntimeWarning: Enable tracemalloc to get the object allocation traceback
  type(result) = <class 'coroutine'>
  result        = <coroutine object fetch_data at 0x7f85be5d1cc0>
```

The `RuntimeWarning` only appears when the coroutine is garbage-collected — which might be seconds later, in a completely different part of your code. The actual bug (missing `await`) is never pointed to.

**The fix**: enable `PYTHONASYNCIODEBUG=1` or `asyncio.run(main(), debug=True)` during development. Linters like `flake8-async` or `ruff` with the `ASYNC` rules will catch this statically.

## Pitfall #4: create_task and unhandled exceptions

`asyncio.create_task` schedules a coroutine to run "in the background." But if that task raises an exception and you never `await` it (or call `.exception()`), the exception is silently swallowed until the task object is garbage-collected — at which point you get a confusing `Task exception was never retrieved` warning with no context about where the task was created.

```python
import asyncio

async def failing_task(name: str):
    await asyncio.sleep(0.1)
    raise ValueError(f"{name} exploded")

async def main():
    print("=== fire-and-forget (exception swallowed until GC) ===")
    t1 = asyncio.create_task(failing_task("background"), name="bg")
    await asyncio.sleep(0.2)
    print(f"  t1.done() = {t1.done()}  (exception not retrieved)")

    print("\n=== gather with return_exceptions=True ===")
    results = await asyncio.gather(
        failing_task("a"),
        failing_task("b"),
        return_exceptions=True,
    )
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            print(f"  task[{i}] raised: {type(r).__name__}: {r}")
        else:
            print(f"  task[{i}] returned: {r}")

    print("\n=== add_done_callback for explicit handling ===")
    t2 = asyncio.create_task(failing_task("callback"), name="cb")
    t2.add_done_callback(lambda t: print(f"  callback: {t.exception()!r}" if t.exception() else "  callback: ok"))
    await asyncio.sleep(0.2)

asyncio.run(main())
```

Real output:

```
Task exception was never retrieved
future: <Task finished name='bg' coro=<failing_task() done, defined at /tmp/opencode/work/asyncio/04_create_task_exceptions.py:4> exception=ValueError('background exploded')>
Traceback (most recent call last):
  File "/tmp/opencode/work/asyncio/04_create_task_exceptions.py", line 6, in failing_task
    raise ValueError(f"{name} exploded")
ValueError: background exploded
=== fire-and-forget (exception swallowed until GC) ===
  t1.done() = True  (exception not retrieved)

=== gather with return_exceptions=True ===
  task[0] raised: ValueError: a exploded
  task[1] raised: ValueError: b exploded

=== add_done_callback for explicit handling ===
  callback: ValueError('callback exploded')
```

Three patterns for handling task exceptions:

1. **`gather(..., return_exceptions=True)`** — collect results and exceptions together, handle them after all tasks complete.
2. **`add_done_callback`** — attach a callback that receives the finished task; check `.exception()` there.
3. **Store the task and `await` it later** — if you need the result eventually, keep a reference and await it when you need it.

## Pitfall #5: timeouts, cancellation, and cleanup

Without timeouts, a hung coroutine can block your application forever. `asyncio.timeout` (Python 3.11+) is the modern way to bound how long a coroutine can run:

```python
import asyncio

async def slow_operation():
    try:
        print("  [slow] starting 3s await...")
        await asyncio.sleep(3)
        print("  [slow] completed (should NOT reach here)")
    except asyncio.CancelledError:
        print("  [slow] CANCELLED — cleanup here")
        raise  # MUST re-raise
    finally:
        print("  [slow] finally: closing resources")

async def main():
    print("=== asyncio.timeout(0.5) ===")
    try:
        async with asyncio.timeout(0.5):
            await slow_operation()
    except TimeoutError:
        print("  [main] caught TimeoutError — task cancelled, resources cleaned")

    print("\n=== manual cancel ===")
    task = asyncio.create_task(slow_operation())
    await asyncio.sleep(0.1)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        print("  [main] task cancelled successfully")

asyncio.run(main())
```

Real output:

```
=== asyncio.timeout(0.5) ===
  [slow] starting 3s await...
  [slow] CANCELLED — cleanup here
  [slow] finally: closing resources
  [main] caught TimeoutError — task cancelled, resources cleaned

=== manual cancel ===
  [slow] starting 3s await...
  [slow] CANCELLED — cleanup here
  [slow] finally: closing resources
  [main] task cancelled successfully
```

Key rules for cancellation:

- **Always re-raise `CancelledError`** after cleanup. Swallowing it breaks `cancel()` semantics and can leave your application in an inconsistent state.
- **Use `finally` for cleanup** — close files, release locks, send disconnect notifications. The `finally` block runs even when the task is cancelled.
- **`asyncio.timeout` raises `TimeoutError`** in the caller when the deadline expires. The inner task receives `CancelledError`.

## Running blocking and CPU work off the loop

So you have a blocking library with no async alternative. Or you need to do heavy computation. The answer is to move that work off the event loop — either to a thread or a process.

### asyncio.to_thread (Python 3.9+)

For blocking I/O that has no async alternative, `asyncio.to_thread` runs the function in a thread pool:

```python
import asyncio, time

def blocking_io(name: str, delay: float) -> str:
    time.sleep(delay)
    return f"{name} result"

async def main():
    print("=== asyncio.to_thread (3.9+, preferred) ===")
    t = time.perf_counter()
    results = await asyncio.gather(
        asyncio.to_thread(blocking_io, "a", 0.3),
        asyncio.to_thread(blocking_io, "b", 0.3),
    )
    print(f"  results: {results}  elapsed: {time.perf_counter()-t:.3f}s")

asyncio.run(main())
```

Real output:

```
=== asyncio.to_thread (3.9+, preferred) ===
  results: ['a result', 'b result']  elapsed: 0.301s
```

Two 0.3s blocking calls: 0.301s total. The thread pool runs them concurrently while the event loop stays responsive.

### run_in_executor

The lower-level API gives you control over the executor:

```python
import asyncio, time

def blocking_io(name: str, delay: float) -> str:
    time.sleep(delay)
    return f"{name} result"

async def main():
    loop = asyncio.get_running_loop()
    print("=== run_in_executor (low-level) ===")
    t = time.perf_counter()
    results = await asyncio.gather(
        loop.run_in_executor(None, blocking_io, "a", 0.3),
        loop.run_in_executor(None, blocking_io, "b", 0.3),
    )
    print(f"  results: {results}  elapsed: {time.perf_counter()-t:.3f}s")

asyncio.run(main())
```

Real output:

```
=== run_in_executor (low-level) ===
  results: ['a result', 'b result']  elapsed: 0.309s
```

Same result, slightly more overhead. Prefer `asyncio.to_thread` unless you need a custom executor.

### CPU-bound work: processes, not threads

Threads don't help with CPU-bound work because of the GIL. For heavy computation, use `ProcessPoolExecutor`:

```python
import asyncio, time
from concurrent.futures import ProcessPoolExecutor

def cpu_intensive(n: int) -> int:
    total = 0
    for i in range(n):
        total += i * i
    return total

async def main():
    loop = asyncio.get_running_loop()
    with ProcessPoolExecutor() as pool:
        result = await loop.run_in_executor(pool, cpu_intensive, 5_000_000)
    print(f"  result: {result}")

asyncio.run(main())
```

The key insight: **concurrency is not parallelism**. asyncio gives you concurrency (one thread, many tasks interleaved). For true parallelism with CPU-bound work, you need processes.

Here's the proof — CPU-bound work on the loop vs in an executor:

```python
import asyncio, time

def cpu_intensive(n: int) -> int:
    total = 0
    for i in range(n):
        total += i * i
    return total

async def heartbeat():
    for i in range(4):
        print(f"  [heartbeat] tick {i}  t={time.perf_counter()-T0:.3f}s")
        await asyncio.sleep(0.2)

T0 = 0.0

async def main():
    global T0
    print("=== CPU-bound on the event loop (BAD) ===")
    T0 = time.perf_counter()
    async def bad_cpu():
        return cpu_intensive(5_000_000)
    results = await asyncio.gather(heartbeat(), bad_cpu())
    print(f"  elapsed: {time.perf_counter()-T0:.3f}s  (heartbeat delayed)\n")

    print("=== CPU-bound in executor (GOOD) ===")
    T0 = time.perf_counter()
    loop = asyncio.get_running_loop()
    async def good_cpu():
        return await loop.run_in_executor(None, cpu_intensive, 5_000_000)
    results = await asyncio.gather(heartbeat(), good_cpu())
    print(f"  elapsed: {time.perf_counter()-T0:.3f}s  (heartbeat on time)")

asyncio.run(main())
```

Real output:

```
=== CPU-bound on the event loop (BAD) ===
  [heartbeat] tick 0  t=0.000s
  [heartbeat] tick 1  t=0.526s
  [heartbeat] tick 2  t=0.727s
  [heartbeat] tick 3  t=0.927s
  elapsed: 1.127s  (heartbeat delayed)

=== CPU-bound in executor (GOOD) ===
  [heartbeat] tick 0  t=0.000s
  [heartbeat] tick 1  t=0.206s
  [heartbeat] tick 2  t=0.411s
  [heartbeat] tick 3  t=0.612s
  elapsed: 0.813s  (heartbeat on time)
```

With CPU-bound work on the loop, the heartbeat's second tick fires at 0.526s instead of 0.2s — delayed by 0.3s of blocking computation. In an executor, the heartbeat stays on schedule.

## Debugging asyncio: debug mode and slow-callback warnings

asyncio has a built-in debug mode that catches many of these pitfalls at runtime:

```python
import asyncio, time

async def main():
    loop = asyncio.get_running_loop()
    loop.set_debug(True)
    loop.slow_callback_duration = 0.05  # warn if callback > 50ms

    async def bad_callback():
        time.sleep(0.1)  # blocks 100ms → triggers warning

    async def good_callback():
        await asyncio.sleep(0.1)  # non-blocking

    print("=== bad callback (blocking) ===")
    await bad_callback()
    print("=== good callback (await) ===")
    await good_callback()
    print("done")

asyncio.run(main())
```

With `loop.set_debug(True)`, asyncio warns you when a callback takes longer than `slow_callback_duration`. In production, enable it via `PYTHONASYNCIODEBUG=1` or `asyncio.run(main(), debug=True)`.

Debug mode also enables:

- Coroutine tracking (warns on un-awaited coroutines immediately, not at GC time)
- Task creation stack traces (shows where each task was created)
- Slow callback warnings (catches blocking calls in real time)

## The asyncio pitfalls checklist

Before you ship async code, run through this list:

- [ ] **No `time.sleep`** — use `await asyncio.sleep()`
- [ ] **No sync I/O libraries** — use `aiohttp`, `asyncpg`, `aiofiles`, or `asyncio.to_thread`
- [ ] **No CPU-bound work on the loop** — use `run_in_executor` with a `ProcessPoolExecutor`
- [ ] **All coroutines are awaited** — enable debug mode or use a linter
- [ ] **Independent I/O uses `gather` or `TaskGroup`** — not sequential awaits
- [ ] **All tasks have exception handling** — `return_exceptions=True`, `add_done_callback`, or explicit `await`
- [ ] **All network calls have timeouts** — `asyncio.timeout` or `asyncio.wait_for`
- [ ] **Cancellation is handled** — re-raise `CancelledError`, clean up in `finally`
- [ ] **Debug mode is enabled in development** — `PYTHONASYNCIODEBUG=1`

## Summary

asyncio is a cooperative scheduler: one thread, many tasks, no preemption. That model is incredibly efficient for I/O-bound workloads — but it means **one blocking call stalls everything**. The five pitfalls are:

1. **Blocking calls** (`time.sleep`, `requests`, sync DB drivers) freeze the loop
2. **Sequential awaits** silently multiply latency — use `asyncio.gather`
3. **Un-awaited coroutines** do nothing and warn only at GC time
4. **Unhandled task exceptions** are swallowed until garbage collection
5. **Missing timeouts** let hung coroutines block forever

The fixes are straightforward: async libraries, `gather`/`TaskGroup`, `asyncio.timeout`, `to_thread`/`run_in_executor`, and debug mode. Measure your code, find the blocking calls, and move them off the loop.

Your event loop will thank you.

---

*Related: [Reading a codebase](/posts/reading-a-codebase/) · [Debugging with strace](/posts/debugging-with-strace/)*
