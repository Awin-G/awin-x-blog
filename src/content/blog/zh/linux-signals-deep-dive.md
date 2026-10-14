---
title: "Linux 信号：kill 与 kill -9 的区别，以及 PID 1 容器陷阱"
description: "Linux 信号是异步通知，而不是消息队列。了解 SIGTERM 与 SIGKILL 的区别、信号处理器如何实现优雅关闭、sigprocmask 如何延迟信号投递，以及 PID 1 容器陷阱——你的应用必须自己处理 SIGTERM。"
pubDate: 2027-01-28
lang: zh
translationKey: linux-signals-deep-dive
tags: [linux]
featured: false
keywords:
  - Linux 信号
  - SIGTERM vs SIGKILL
  - 信号处理器
  - PID 1 容器
  - 优雅关闭
---

每个 Linux 进程都生活在信号的持续"降雨"中——来自内核、其他进程或终端的小型异步通知。信号不是消息队列：没有缓冲，除每种信号类型各一个 pending 位之外没有投递保证，除了信号编号本身没有有效载荷。信号会中断进程正在做的事情，给它一个反应的机会——如果进程没有意见，内核就应用默认处置方式：终止、停止或忽略。

理解信号是系统能干净关闭和系统损坏状态之间的区别。本文将介绍重要的信号、使优雅关闭成为可能的处理器模式、延迟投递的掩码机制，以及几乎每个人在发布第一个 Docker 镜像时都会遇到的容器 PID 1 陷阱。

## 重要的信号

`kill -l` 列出系统知道的每个信号：

```
HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS RTMIN RTMIN+1 ... RTMAX-1 RTMAX
```

实践中你大概只会用到其中十个：

| 信号 | 编号 | 默认动作 | 用途 |
|--------|--------|---------|-----|
| `SIGTERM` | 15 | 终止 | "请干净地关闭。" |
| `SIGKILL` | 9 | 终止 | "立即去死。" 不可捕获、不可阻塞。 |
| `SIGINT` | 2 | 终止 | 终端 Ctrl-C。 |
| `SIGHUP` | 1 | 终止 | 终端挂断；被重新用作配置重载。 |
| `SIGSTOP` | 19 | 停止 | 暂停执行。不可捕获。 |
| `SIGCONT` | 18 | 忽略 | 恢复已停止的进程。 |
| `SIGCHLD` | 17 | 忽略 | 子进程退出或停止。 |
| `SIGPIPE` | 13 | 终止 | 写入没有读取端的管道。 |

有两个信号——`SIGKILL` 和 `SIGSTOP`——无法被捕获、阻塞或忽略。内核直接处理它们。这是一个安全保证：即使进程卡住了，也总是可以杀死它。

## SIGTERM vs SIGKILL：礼貌的请求与铁锤

`SIGTERM`（15）是一个请求。进程可以捕获它、运行清理代码、以状态 0 退出。`SIGKILL`（9）是一个命令。内核立即拆除进程——没有处理器运行，没有 atexit 钩子触发，没有缓冲区刷新。

这是一个安装处理器并优雅关闭的最小 Python 程序：

```python
import signal, sys, time, os

shutdown = False

def handler(signum, frame):
    global shutdown
    name = signal.Signals(signum).name
    print(f"[{time.strftime('%H:%M:%S')}] caught {name} (signal {signum})", flush=True)
    print(f"[{time.strftime('%H:%M:%S')}] flushing buffers, closing files, exiting cleanly...", flush=True)
    shutdown = True

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGINT, handler)
print(f"PID {os.getpid()} running, handlers installed. Send SIGTERM or SIGINT.", flush=True)

while not shutdown:
    time.sleep(0.2)

print("Clean exit.", flush=True)
```

发送 `SIGTERM`：

```
$ python3 graceful.py &
PID 1125498 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -TERM 1125498
[10:23:05] caught SIGTERM (signal 15)
[10:23:05] flushing buffers, closing files, exiting cleanly...
Clean exit.
exit code: 0
```

同样的程序、同样的状态，但用 `kill -9`：

```
$ python3 graceful.py &
PID 1125586 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -9 1125586
exit code: 137
```

退出码 137 = 128 + 9。处理器从未运行。没有输出、没有清理、没有刷新。内核回收了进程及其持有的一切。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" role="img" aria-label="SIGTERM 被捕获并处理；SIGKILL 不会">
  <defs>
    <style>
      .box { fill: #f7f6f2; stroke: #0f766e; stroke-width: 1.5; }
      .box-red { fill: #fef2f2; stroke: #dc2626; stroke-width: 1.5; }
      .arrow { stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#teal); }
      .arrow-red { stroke: #dc2626; stroke-width: 2; fill: none; marker-end: url(#red); }
      .label { font-family: ui-monospace, monospace; font-size: 13px; fill: #0f1513; }
      .label-sm { font-family: ui-monospace, monospace; font-size: 11px; fill: #4b5563; }
      .title { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; fill: #0f766e; }
      .title-red { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; fill: #dc2626; }
    </style>
    <marker id="teal" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0f766e"/></marker>
    <marker id="red" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <!-- SIGTERM path -->
  <text x="20" y="30" class="title">SIGTERM (15) — caught</text>
  <rect x="20" y="45" width="120" height="50" rx="4" class="box"/>
  <text x="80" y="75" text-anchor="middle" class="label">kill -TERM</text>
  <line x1="140" y1="70" x2="200" y2="70" class="arrow"/>
  <rect x="200" y="45" width="140" height="50" rx="4" class="box"/>
  <text x="270" y="75" text-anchor="middle" class="label">handler runs</text>
  <line x1="340" y1="70" x2="400" y2="70" class="arrow"/>
  <rect x="400" y="45" width="140" height="50" rx="4" class="box"/>
  <text x="470" y="75" text-anchor="middle" class="label">clean exit (0)</text>
  <!-- SIGKILL path -->
  <text x="20" y="140" class="title-red">SIGKILL (9) — uncatchable</text>
  <rect x="20" y="155" width="120" height="50" rx="4" class="box-red"/>
  <text x="80" y="185" text-anchor="middle" class="label">kill -9</text>
  <line x1="140" y1="180" x2="200" y2="180" class="arrow-red"/>
  <rect x="200" y="155" width="140" height="50" rx="4" class="box-red"/>
  <text x="270" y="185" text-anchor="middle" class="label">kernel reclaims</text>
  <line x1="340" y1="180" x2="400" y2="180" class="arrow-red"/>
  <rect x="400" y="155" width="140" height="50" rx="4" class="box-red"/>
  <text x="470" y="185" text-anchor="middle" class="label">exit 137, no cleanup</text>
  <!-- Note -->
  <text x="20" y="225" class="label-sm">SIGKILL and SIGSTOP cannot be caught, blocked, or ignored — by design.</text>
</svg>
<figcaption>图 1 — SIGTERM 给进程清理的机会；SIGKILL 不会。</figcaption>
</figure>

经验法则：**总是先尝试 `SIGTERM`，等待几秒钟，然后升级到 `SIGKILL`。** `systemctl stop`、`docker stop` 和 `kubectl delete` 都遵循这个模式——它们发送 SIGTERM，等待宽限期（Docker 默认 10 秒，systemd 默认 90 秒），然后发送 SIGKILL。如果你的应用正确处理 SIGTERM，你永远不会看到 SIGKILL。

## 信号处理器与优雅关闭

信号处理器是信号到达时内核调用的函数。在 Python 中用 `signal.signal(signal.SIGTERM, handler)` 安装。在 C 中，`sigaction(2)` 是现代接口（避免使用 `signal(2)`——其语义在不同 UNIX 版本间有差异）。

处理器应该尽可能少做事。设置一个标志、写入管道或发布到事件循环——然后返回。真正的清理发生在主循环中。这是因为大多数函数不是 async-signal-safe 的；如果信号在这些函数运行中途中断了它们，从处理器中调用 `printf` 或 `malloc` 可能死锁。

Shell 等价物是 `trap`：

```bash
#!/bin/bash
echo "[$(date +%H:%M:%S)] script started, PID $$"

cleanup() {
    echo "[$(date +%H:%M:%S)] trap triggered — cleaning up temp files, releasing lock..."
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    sleep 0.2
done
```

运行它并发送 SIGTERM：

```
$ ./trap_demo.sh &
[10:23:25] script started, PID 1125597
$ kill -TERM 1125597
[10:23:25] trap triggered — cleaning up temp files, releasing lock...
exit code: 0
```

`trap` 触发，清理运行，退出码 0。没有 trap，shell 会立即以退出码 143（128 + 15）死亡。

## 信号掩码与延迟投递

进程可以**阻塞**信号。被阻塞的信号不会丢失——它变为*待处理*（pending），在取消阻塞时立即投递。这就是临界区如何保护自己不被中断的。

```python
import signal, time, os

print(f"PID {os.getpid()}", flush=True)

def handler(signum, frame):
    print(f"[{time.strftime('%H:%M:%S')}] DELIVERED: {signal.Signals(signum).name}", flush=True)

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGUSR1, handler)

mask = {signal.SIGTERM, signal.SIGUSR1}
signal.pthread_sigmask(signal.SIG_BLOCK, mask)
print(f"[{time.strftime('%H:%M:%S')}] signals blocked: SIGTERM, SIGUSR1", flush=True)
print(f"[{time.strftime('%H:%M:%S')}] sending SIGTERM and SIGUSR1 (they will be pending)...", flush=True)

os.kill(os.getpid(), signal.SIGTERM)
os.kill(os.getpid(), signal.SIGUSR1)
print(f"[{time.strftime('%H:%M:%S')}] pending signals: {signal.sigpending()}", flush=True)

print(f"[{time.strftime('%H:%M:%S')}] unblocking after 2 seconds...", flush=True)
time.sleep(2)
signal.pthread_sigmask(signal.SIG_UNBLOCK, mask)
print(f"[{time.strftime('%H:%M:%S')}] unblocked. Waiting...", flush=True)
time.sleep(1)
print("done.", flush=True)
```

输出：

```
PID 1125590
[10:23:25] signals blocked: SIGTERM, SIGUSR1
[10:23:25] sending SIGTERM and SIGUSR1 (they will be pending)...
[10:23:25] pending signals: {<Signals.SIGUSR1: 10>, <Signals.SIGTERM: 15>}
[10:23:25] unblocking after 2 seconds...
[10:23:27] DELIVERED: SIGUSR1
[10:23:27] DELIVERED: SIGTERM
[10:23:27] unblocked. Waiting...
done.
```

两个信号都在 10:23:25 发送，但在 10:23:27 投递——两秒的延迟。在 C 中，等价的是 `sigprocmask(2)`（多线程程序中用 `pthread_sigmask(2)`）。这就是让进程在完成不可中断操作后再处理关闭请求的机制。

## SIGHUP：重载约定

`SIGHUP`（1）最初表示"终端挂断"。关闭 SSH 会话时，内核向会话领导者及其子进程发送 SIGHUP。默认动作是终止。

长期运行的守护进程将 SIGHUP 重新用作**重载**信号：它们不死亡，而是重新读取配置。nginx、sshd 和大多数 syslog 实现都这样做。这个约定已经足够普遍，运维人员不假思索地输入 `kill -HUP <pid>`。

```python
import signal, time, os

config_reloads = 0

def reload_handler(signum, frame):
    global config_reloads
    config_reloads += 1
    print(f"[{time.strftime('%H:%M:%S')}] SIGHUP received — reloading config (reload #{config_reloads})", flush=True)

signal.signal(signal.SIGHUP, reload_handler)
print(f"PID {os.getpid()} running, watching for SIGHUP...", flush=True)

for i in range(30):
    time.sleep(0.2)
    if i == 5:
        os.kill(os.getpid(), signal.SIGHUP)
    if i == 15:
        os.kill(os.getpid(), signal.SIGHUP)

print(f"[{time.strftime('%H:%M:%S')}] done. Total config reloads: {config_reloads}", flush=True)
```

```
PID 1125593 running, watching for SIGHUP...
[10:23:26] SIGHUP received — reloading config (reload #1)
[10:23:28] SIGHUP received — reloading config (reload #2)
[10:23:31] done. Total config reloads: 2
```

进程在两个信号下都存活并继续运行。这就是 `systemctl reload nginx` 背后的模式——它发送 SIGHUP，而不是 SIGTERM。

## PID 1 容器陷阱

在普通 Linux 系统中，PID 1 是 `init`（或 `systemd`）。它有一个特殊的内核权限：**不会为它安装默认信号处置方式。** 如果 PID 1 没有为 SIGTERM 安装处理器，SIGTERM 到达时内核什么都不做——信号被静默丢弃。这是设计意图：init 不能因为一个杂散信号而死亡。

运行容器时，你的应用成为 PID 1。如果它不处理 SIGTERM，`docker stop` 会发送 SIGTERM，等待 10 秒，然后向容器发送 SIGKILL。你的应用永远没有机会清理。

这是一个处理 SIGTERM 的最小 Python 程序：

```python
import signal, sys, time, os

def handler(signum, frame):
    print(f"[{time.strftime('%H:%M:%S')}] PID 1 caught {signal.Signals(signum).name} — shutting down", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)
print(f"PID {os.getpid()} (container PID 1) running with SIGTERM handler", flush=True)

while True:
    time.sleep(0.2)
```

**Exec 形式**——`CMD ["python", "/app.py"]`——python *就是* PID 1：

```
$ docker run -d --name sig-exec signals-exec
$ docker stop sig-exec
PID 1 (container PID 1) running with SIGTERM handler
[02:23:59] PID 1 caught SIGTERM — shutting down
```

处理器运行。干净关闭。

**Shell 形式**——包装脚本，`sh` 保持为 PID 1，python 是子进程：

```dockerfile
RUN echo '#!/bin/sh' > /entrypoint.sh \
 && echo 'python /app.py &' >> /entrypoint.sh \
 && echo 'wait' >> /entrypoint.sh \
 && chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
```

```
$ docker run -d --name sig-shell3 signals-shell3
$ docker stop sig-shell3
PID 7 (container PID 1) running with SIGTERM handler
```

处理器从不运行。`sh` 是 PID 1，内核不会为 PID 1 安装默认信号处置方式——SIGTERM 被静默丢弃。`docker stop` 等待 10 秒，然后发送 SIGKILL。python 进程被杀死，没有任何清理、刷新或优雅退出的机会。

修复方法有以下几种：

1. **在 Dockerfile 中使用 exec 形式**：`CMD ["python", "app.py"]`——没有 shell 包装，你的应用就是 PID 1。
2. **使用 init 系统**，如 [`tini`](https://github.com/krallin/tini)：`ENTRYPOINT ["tini", "--"]` + `CMD ["python", "app.py"]`。`tini` 是 PID 1，将信号转发给你的应用，并回收僵尸进程。
3. **在 entrypoint 脚本中处理 SIGTERM**——如果必须使用 shell 包装器，trap SIGTERM 并转发：

```sh
#!/bin/sh
python /app.py &
PID=$!
trap "kill -TERM $PID; wait $PID" TERM INT
wait $PID
```
```

同样的原则适用于 systemd 单元——参见 [systemd 单元 cookbook](/zh/posts/systemd-unit-cookbook/) 了解 `ExecStop` 和 `TimeoutStopSec` 如何与此交互。如果你想知道为什么容器有时恰好需要 10 秒才能停止，那就是 Docker 守护进程的宽限期在 SIGKILL 之前到期。

## SIGSTOP 与 SIGCONT：暂停和恢复

`SIGSTOP`（19）暂停进程。像 SIGKILL 一样，它无法被捕获。`SIGCONT`（18）恢复它。这就是终端中 `Ctrl-Z` 触发的方式——shell 向前台作业发送 SIGSTOP。

```
$ python3 graceful.py &
PID 1125588 running, handlers installed. Send SIGTERM or SIGINT.
$ kill -STOP 1125588
--- sending SIGCONT ---
$ kill -CONT 1125588
$ kill -TERM 1125588
[10:23:26] caught SIGTERM (signal 15)
[10:23:26] flushing buffers, closing files, exiting cleanly...
Clean exit.
exit code: 0
```

进程在执行中途被冻结，恢复，然后正常关闭。每个 shell 的作业控制都建立在这两个信号之上。

## SIGPIPE：隐形杀手

当写入一个读取端已关闭的管道时，内核向写入者发送 `SIGPIPE`（13）。默认动作是终止。这就是 `yes | head -1` 干净退出的原因——`head` 在一行后关闭管道，`yes` 收到 SIGPIPE 并死亡。

大多数程序不会看到 SIGPIPE，因为它们检查写入错误。但如果你安装了 SIGPIPE 处理器（或忽略它），`write(2)` 会返回 `-1` 并设置 `errno = EPIPE`，你必须显式处理这个错误。

## 检查清单

- [ ] **在每个长期运行的进程中处理 SIGTERM**。设置标志、停止接受工作、刷新缓冲区、关闭文件、以 0 退出。
- [ ] **永远不要依赖 SIGKILL** 进行正常关闭。它是最后手段，不是机制。
- [ ] **使用 `sigprocmask`** 在关键区段期间延迟信号——之前阻塞，之后取消阻塞。
- [ ] **重新利用 SIGHUP** 用于守护进程的配置重载。运维人员期望它。
- [ ] **在 Docker 中，使用 exec 形式**或 `tini`。永远不要让 shell 包装器在没有 trap 的情况下成为 PID 1。
- [ ] **测试你的关闭流程**：`kill -TERM <pid>`，等待，检查退出码。不要等到生产部署才发现处理器有问题。
- [ ] **尊重升级阶梯**：SIGTERM → 等待 → SIGKILL。`systemctl stop` 和 `docker stop` 已经这样做了；你的脚本也应该如此。

信号是内核告诉进程"发生了事情——你决定怎么做"的方式。存活下来的进程是那些决定得当的进程。
