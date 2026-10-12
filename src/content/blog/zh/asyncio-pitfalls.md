---
title: "asyncio 陷阱：拖垮事件循环的五个错误"
description: "真实计时数据展示阻塞调用、顺序 await、未等待协程和 CPU 密集任务如何悄悄摧毁 asyncio 性能——以及如何逐一修复。"
pubDate: 2026-12-31
lang: zh
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

asyncio 是 Python 最强大的特性之一，也是最容易被误解的特性之一。心智模型很简单：单线程、协作式调度。但这个简洁背后隐藏着一个残酷的事实：**任何阻塞事件循环的东西都会阻塞一切**。一个 `time.sleep(1)` 不仅延迟一个任务——它冻结其他所有协程、所有心跳、所有连接。

本文将介绍五个在真实场景中造成最大伤害的 asyncio 陷阱，附带 Python 3.14.7 在 Linux 上的实测计时。每个代码块都是真实运行的脚本，每个数字都是真实输出。

## 心智模型：单线程，协作式调度

asyncio 在单线程上运行你的协程。没有抢占——协程一直保持控制权，直到遇到一个真正让出控制权的 `await`（比如 `asyncio.sleep`、socket 读取、队列 get）。如果你的代码从不让出，循环就永远拿不回控制权。

这意味着：

- `await asyncio.sleep(1)` → 让出，循环可以运行其他任务 ✅
- `time.sleep(1)` → 阻塞线程，循环被冻结 ❌
- `requests.get(url)` → 阻塞线程，循环被冻结 ❌
- `for i in range(10_000_000): total += i` → 阻塞线程，循环被冻结 ❌

修复方法始终一样：**找到阻塞调用，把它移出循环**。但首先，让我们看看危害有多大。

## 陷阱 #1：async 代码中的阻塞调用

最常见的 asyncio 陷阱是在协程中调用同步阻塞函数。`time.sleep`、`requests.get`、`psycopg2` 查询、文件 I/O——它们都会阻塞整个事件循环。

最小复现：

```python
import asyncio, time

async def heartbeat():
    for i in range(6):
        print(f"  [heartbeat] tick {i}  t={time.perf_counter()-T0:.3f}s")
        await asyncio.sleep(0.3)

async def blocking_task():
    print(f"  [blocker ] START blocking sleep(1.0)  t={time.perf_counter()-T0:.3f}s")
    time.sleep(1.0)  # <-- 错误所在
    print(f"  [blocker ] DONE  blocking sleep(1.0)  t={time.perf_counter()-T0:.3f}s")

async def main():
    global T0
    T0 = time.perf_counter()
    await asyncio.gather(heartbeat(), blocking_task(), heartbeat())

asyncio.run(main())
```

真实输出：

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

观察心跳 tick。它们应该每 0.3s 触发一次。但 tick 0 和 tick 1 都在 `t=1.000s` 触发——循环被冻结了整整一秒，而 `time.sleep(1.0)` 正在运行。其他所有协程、所有待处理的 I/O 事件、所有定时器回调——全部延迟了 1 秒。

在生产环境中，这表现为：WebSocket 服务器停止响应、健康检查失败、指标显示请求延迟飙升——所有这些都因为一个协程调用了同步库。

**修复方法**：使用异步替代方案（`aiohttp` 替代 `requests`，`asyncpg` 替代 `psycopg2`，`aiofiles` 替代 `open`），或者将阻塞工作移出循环（详见[执行器部分](#将阻塞和-cpu-工作移出循环)）。

## 陷阱 #2：顺序 await 而非 asyncio.gather

第二个最常见的错误是在本可以并发运行时逐个 await 协程。这不是正确性 bug——而是性能 bug，悄悄让你的代码慢 3 倍、10 倍、100 倍。

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

真实输出：

```
=== sequential await ===
  elapsed: 0.901s

=== asyncio.gather ===
  elapsed: 0.301s

speedup: 3.0x
```

三个 0.3s 的 I/O 操作：顺序 0.901s vs 并发 0.301s。数学很简单——顺序是总和，并发是最大值——但在真实代码中，await 分散在各个函数中，隐藏在条件判断后面，性能下降是不可见的，直到你进行性能分析。

**修复方法**：当你有独立的 I/O 操作时，用 `asyncio.gather` 包装它们。Python 3.11+ 中，你还可以使用 `asyncio.TaskGroup` 实现结构化并发：

```python
async with asyncio.TaskGroup() as tg:
    task1 = tg.create_task(fetch_user(user_id))
    task2 = tg.create_task(fetch_orders(user_id))
# 两个任务都在此完成；如果一个抛出异常，其他任务会被取消
```

## 陷阱 #3：忘记 await 协程

这个陷阱很隐蔽，因为它不会崩溃——只是静默地什么都不做。如果你调用协程函数时没有 `await`，你会得到一个永远不会执行的协程对象：

```python
import asyncio

async def fetch_data() -> str:
    await asyncio.sleep(0.1)
    return "data"

async def main():
    result = fetch_data()  # 错误：缺少 await
    print(f"  type(result) = {type(result)}")
    print(f"  result        = {result}")

asyncio.run(main())
```

真实输出：

```
/usr/lib/python3.14/asyncio/events.py:94: RuntimeWarning: coroutine 'fetch_data' was never awaited
  self._context.run(self._callback, *self._args)
RuntimeWarning: Enable tracemalloc to get the object allocation traceback
  type(result) = <class 'coroutine'>
  result        = <coroutine object fetch_data at 0x7f85be5d1cc0>
```

`RuntimeWarning` 只在协程被垃圾回收时才出现——这可能是在几秒钟之后，在你代码的完全不同的部分。真正的 bug（缺少 `await`）永远不会被指出。

**修复方法**：在开发期间启用 `PYTHONASYNCIODEBUG=1` 或 `asyncio.run(main(), debug=True)`。像 `flake8-async` 或 `ruff`（带 `ASYNC` 规则）这样的 linter 可以静态捕获此问题。

## 陷阱 #4：create_task 和未处理的异常

`asyncio.create_task` 调度一个协程"在后台"运行。但如果该任务抛出异常而你从未 `await` 它（或调用 `.exception()`），异常会被静默吞掉，直到任务对象被垃圾回收——此时你会得到一个令人困惑的 `Task exception was never retrieved` 警告，而且没有任何关于任务创建位置的上下文。

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

真实输出：

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

处理任务异常的三种模式：

1. **`gather(..., return_exceptions=True)`**——将结果和异常收集在一起，在所有任务完成后处理。
2. **`add_done_callback`**——附加一个接收已完成任务的回调；在其中检查 `.exception()`。
3. **保存任务引用并在稍后 `await`**——如果你最终需要结果，保留引用并在需要时 await 它。

## 陷阱 #5：超时、取消和清理

没有超时，一个挂起的协程可能永远阻塞你的应用程序。`asyncio.timeout`（Python 3.11+）是限制协程运行时间的现代方式：

```python
import asyncio

async def slow_operation():
    try:
        print("  [slow] starting 3s await...")
        await asyncio.sleep(3)
        print("  [slow] completed (should NOT reach here)")
    except asyncio.CancelledError:
        print("  [slow] CANCELLED — cleanup here")
        raise  # 必须重新抛出
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

真实输出：

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

取消的关键规则：

- **清理后始终重新抛出 `CancelledError`**。吞掉它会破坏 `cancel()` 语义，可能使应用程序处于不一致状态。
- **使用 `finally` 进行清理**——关闭文件、释放锁、发送断开连接通知。即使任务被取消，`finally` 块也会运行。
- **`asyncio.timeout` 在截止日期到期时向调用者抛出 `TimeoutError`**。内部任务收到 `CancelledError`。

## 将阻塞和 CPU 工作移出循环

如果你有一个没有异步替代方案的阻塞库，或者你需要进行大量计算。答案是将工作移出事件循环——移到线程或进程。

### asyncio.to_thread（Python 3.9+）

对于没有异步替代方案的阻塞 I/O，`asyncio.to_thread` 在线程池中运行该函数：

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

真实输出：

```
=== asyncio.to_thread (3.9+, preferred) ===
  results: ['a result', 'b result']  elapsed: 0.301s
```

两个 0.3s 的阻塞调用：总共 0.301s。线程池并发运行它们，而事件循环保持响应。

### run_in_executor

底层 API 让你控制执行器：

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

真实输出：

```
=== run_in_executor (low-level) ===
  results: ['a result', 'b result']  elapsed: 0.309s
```

相同的结果，略多的开销。除非你需要自定义执行器，否则优先使用 `asyncio.to_thread`。

### CPU 密集型工作：进程而非线程

线程对 CPU 密集型工作没有帮助，因为 GIL。对于大量计算，使用 `ProcessPoolExecutor`：

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

关键洞察：**并发不等于并行**。asyncio 给你并发（单线程，多个任务交错）。对于 CPU 密集型工作的真正并行，你需要进程。

以下是证明——CPU 密集型工作在线程上 vs 在执行器中：

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

真实输出：

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

CPU 密集型工作在线程上时，心跳的第二个 tick 在 0.526s 触发而不是 0.2s——被阻塞计算延迟了 0.3s。在执行器中，心跳保持准时。

## 调试 asyncio：调试模式和慢回调警告

asyncio 有内置的调试模式，在运行时捕获许多这些陷阱：

```python
import asyncio, time

async def main():
    loop = asyncio.get_running_loop()
    loop.set_debug(True)
    loop.slow_callback_duration = 0.05  # 回调超过 50ms 时警告

    async def bad_callback():
        time.sleep(0.1)  # 阻塞 100ms → 触发警告

    async def good_callback():
        await asyncio.sleep(0.1)  # 非阻塞

    print("=== bad callback (blocking) ===")
    await bad_callback()
    print("=== good callback (await) ===")
    await good_callback()
    print("done")

asyncio.run(main())
```

使用 `loop.set_debug(True)`，asyncio 会在回调耗时超过 `slow_callback_duration` 时警告你。在生产环境中，通过 `PYTHONASYNCIODEBUG=1` 或 `asyncio.run(main(), debug=True)` 启用它。

调试模式还启用：

- 协程跟踪（立即警告未等待的协程，而不是在 GC 时）
- 任务创建堆栈跟踪（显示每个任务的创建位置）
- 慢回调警告（实时捕获阻塞调用）

## asyncio 陷阱清单

在发布异步代码之前，过一遍这个清单：

- [ ] **没有 `time.sleep`**——使用 `await asyncio.sleep()`
- [ ] **没有同步 I/O 库**——使用 `aiohttp`、`asyncpg`、`aiofiles` 或 `asyncio.to_thread`
- [ ] **没有 CPU 密集型工作在线程上**——使用 `run_in_executor` 配合 `ProcessPoolExecutor`
- [ ] **所有协程都被 await**——启用调试模式或使用 linter
- [ ] **独立 I/O 使用 `gather` 或 `TaskGroup`**——而非顺序 await
- [ ] **所有任务都有异常处理**——`return_exceptions=True`、`add_done_callback` 或显式 `await`
- [ ] **所有网络调用都有超时**——`asyncio.timeout` 或 `asyncio.wait_for`
- [ ] **处理取消**——重新抛出 `CancelledError`，在 `finally` 中清理
- [ ] **开发环境启用调试模式**——`PYTHONASYNCIODEBUG=1`

## 总结

asyncio 是一个协作式调度器：单线程，多任务，无抢占。这个模型对于 I/O 密集型工作负载非常高效——但这意味着**一个阻塞调用会拖垮一切**。五个陷阱是：

1. **阻塞调用**（`time.sleep`、`requests`、同步数据库驱动）冻结循环
2. **顺序 await**悄悄增加延迟——使用 `asyncio.gather`
3. **未等待的协程**什么都不做，只在 GC 时警告
4. **未处理的任务异常**被吞掉直到垃圾回收
5. **缺少超时**让挂起的协程永远阻塞

修复方法很直接：异步库、`gather`/`TaskGroup`、`asyncio.timeout`、`to_thread`/`run_in_executor` 和调试模式。测量你的代码，找到阻塞调用，把它们移出循环。

你的事件循环会感谢你的。

---

*相关阅读：[阅读代码库](/zh/posts/reading-a-codebase/) · [用 strace 调试](/zh/posts/debugging-with-strace/)*
