---
title: "加固容器：seccomp、只读文件系统与 capabilities"
description: "通过真实实验讲解 Docker 安全选项：seccomp 配置文件、只读容器、丢弃 capabilities 与 no-new-privileges 的实际用法与效果。"
pubDate: 2027-01-26
lang: zh
translationKey: container-seccomp-hardening
tags: [security, devops]
featured: false
keywords:
  - 容器 seccomp
  - docker 安全选项
  - 只读容器
  - cap-drop
  - no-new-privileges
---

> **授权使用说明。** 以下所有实验仅针对你自己的本地 Docker 守护进程和你自己的容器。请勿在你未获授权的基础设施上运行这些命令。

## 为什么容器加固很重要

容器不是虚拟机。它们共享宿主机内核，你的应用程序发出的每一个 syscall 在到达硬件之前都要经过内核的多个安全层。如果你的应用程序被攻破——无论是依赖 CVE、反序列化漏洞，还是配置错误——攻击者仍然需要突破容器的隔离层才能真正造成破坏。

我之前写过[容器安全](/zh/posts/container-security/)和 [Linux capabilities](/zh/posts/linux-capabilities/)两篇文章。本文在此基础上，通过真实实验展示如何叠加使用 seccomp、只读文件系统、丢弃 capabilities 和 `no-new-privileges`，让被攻破的攻击面尽可能小。

## 隔离栈

容器不是单一机制，而是多个内核特性协同工作的产物：

<figure>
<svg viewBox="0 0 640 320" xmlns="http://www.w3.org/2000/svg" font-family="monospace" font-size="12">
  <!-- Host kernel -->
  <rect x="20" y="260" width="600" height="40" rx="4" fill="#e5e7eb" stroke="#9ca3af"/>
  <text x="320" y="285" text-anchor="middle" fill="#374151">Linux 内核（系统调用接口）</text>
  <!-- Layers -->
  <rect x="40" y="210" width="560" height="40" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="320" y="235" text-anchor="middle" fill="#92400e">seccomp（BPF 系统调用过滤器）</text>
  <rect x="40" y="160" width="560" height="40" rx="4" fill="#dbeafe" stroke="#2563eb"/>
  <text x="320" y="185" text-anchor="middle" fill="#1e40af">Capabilities（细粒度 root 权限）</text>
  <rect x="40" y="110" width="560" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="320" y="135" text-anchor="middle" fill="#166534">Namespaces（pid、net、mount、ipc、uts、user）</text>
  <rect x="40" y="60" width="560" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="320" y="85" text-anchor="middle" fill="#991b1b">cgroups（资源限制）</text>
  <!-- Container -->
  <rect x="240" y="10" width="160" height="40" rx="4" fill="#0f766e" stroke="#0f766e"/>
  <text x="320" y="35" text-anchor="middle" fill="#ffffff">应用程序</text>
  <!-- Arrows -->
  <line x1="320" y1="50" x2="320" y2="60" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="100" x2="320" y2="110" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="150" x2="320" y2="160" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="200" x2="320" y2="210" stroke="#6b7280" stroke-width="2"/>
  <line x1="320" y1="250" x2="320" y2="260" stroke="#6b7280" stroke-width="2"/>
</svg>
<figcaption>图 1 — 容器隔离栈。每层都缩小攻击面；seccomp 最靠近内核。</figcaption>
</figure>

关键理念：**纵深防御**。没有任何单一层是足够的。如果容器以 root 运行且拥有全部 capabilities，seccomp 单独无法阻止容器逃逸。如果应用程序仍然可以发起网络 syscall，只读文件系统单独无法阻止反弹 shell。你需要叠加使用。

## seccomp：内核的系统调用过滤器

seccomp（安全计算模式）是 Linux 内核的一项特性，使用 BPF（Berkeley Packet Filter）过滤系统调用。当进程发起系统调用时，内核会检查附加在该进程上的 BPF 程序。该程序返回一个动作：允许、杀死、陷阱或返回错误。

Docker 默认对每个容器应用 seccomp 配置文件，除非你用 `--security-opt seccomp=unconfined` 覆盖。默认配置允许约 330 个常见系统调用，阻止约 50 个危险调用（如 `kexec_load`、`reboot`、`swapon`、`bpf`）。

以下是真实对比。我用 Python ctypes 调用了默认 seccomp 阻止的三个系统调用：`bpf`、`perf_event_open` 和 `userfaultfd`。

**默认 seccomp 配置文件**（Docker 内置）：

```console
$ docker run --rm alpine:latest sh -c "apk add --no-cache python3 >/dev/null 2>&1 && python3 -c \"
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name, nr in [('bpf', 321), ('perf_event_open', 298), ('userfaultfd', 323)]:
    r = libc.syscall(nr, 0, 0, 0, 0, 0)
    e = ctypes.get_errno()
    print(f'{name}: ret={r} errno={e} ({errno.errorcode.get(e,\\\"?\\\")})')
\""
bpf: ret=-1 errno=1 (EPERM)
perf_event_open: ret=-1 errno=1 (EPERM)
userfaultfd: ret=-1 errno=1 (EPERM)
```

**unconfined seccomp**（`--security-opt seccomp=unconfined`）：

```console
$ docker run --rm --security-opt seccomp=unconfined alpine:latest sh -c "apk add --no-cache python3 >/dev/null 2>&1 && python3 -c \"
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name, nr in [('bpf', 321), ('perf_event_open', 298), ('userfaultfd', 323)]:
    r = libc.syscall(nr, 0, 0, 0, 0, 0)
    e = ctypes.get_errno()
    print(f'{name}: ret={r} errno={e} ({errno.errorcode.get(e,\\\"?\\\")})')
\""
bpf: ret=-1 errno=22 (EINVAL)
perf_event_open: ret=-1 errno=14 (EFAULT)
userfaultfd: ret=-1 errno=1 (EPERM)
```

注意区别。默认配置下，三个系统调用都返回 `EPERM`（errno 1）——seccomp 在内核之前就阻止了它们。`unconfined` 下，系统调用到达内核后因参数为零而失败，返回 `EINVAL`（无效参数）或 `EFAULT`（错误地址）。系统调用*被允许通过*了，只是在内核的参数校验阶段失败。`userfaultfd` 仍返回 `EPERM`，因为它还需要 `CAP_SYS_ADMIN`——capabilities 是独立的层。

这才是关键对比：**seccomp 将潜在的攻击原语变成即时的 `EPERM`**。即使攻击者发现了应用程序的漏洞，他们用来提权或逃逸容器的系统调用在内核边界就被阻止了。

## 编写自定义 seccomp 配置文件

Docker 的默认配置文件是精选的允许列表。你可以自己编写。配置文件是一个 JSON 文件，包含 `defaultAction` 和 `syscalls` 列表。最严格的方式是 `SCMP_ACT_ERRNO`（默认拒绝）加显式允许列表：

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "fstat", "mmap", "mprotect",
                "munmap", "brk", "rt_sigaction", "rt_sigprocmask", "execve",
                "exit_group", "access", "arch_prctl", "clock_gettime",
                "close_range", "dup", "dup2", "epoll_create1", "epoll_ctl",
                "epoll_wait", "eventfd2", "fcntl", "futex", "getcwd", "getdents64",
                "geteuid", "getgid", "getpid", "getppid", "getrandom", "getrlimit",
                "gettid", "getuid", "ioctl", "lseek", "madvise", "mkdirat", "newfstatat",
        "openat", "pipe2", "poll", "pread64", "prlimit64", "readv", "recvmsg",
        "rt_sigreturn", "sched_getaffinity", "set_robust_list", "set_tid_address",
        "sigaltstack", "socket", "socketpair", "stat", "tgkill", "times",
        "uname", "wait4", "writev"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

用 `--security-opt seccomp=./profile.json` 应用。如果遗漏了应用程序需要的系统调用，运行时会失败——通常错误信息很隐晦。我就踩过这个坑：漏掉了 `epoll_ctl`，HTTP 服务器无声挂起而不是明确崩溃。

以下是一个阻止 `bpf` 的自定义配置文件的真实输出（默认允许加定向拒绝，更容易调试）：

```console
$ docker run --rm --security-opt seccomp=./block-bpf.json alpine:latest python3 -c "..."
bpf: ret=-1 errno=1 (EPERM)
perf_event_open: ret=-1 errno=14 (EFAULT)
userfaultfd: ret=-1 errno=1 (EPERM)
```

`bpf` 以 `EPERM` 被阻止，而 `perf_event_open` 到达内核后以 `EFAULT` 失败。这确认了拒绝规则生效：过滤器在内核看到 `bpf` 之前就拦截了它。

**警告。** 不要照搬网上的配置文件。每个应用程序的系统调用需求不同。过于严格的配置会在生产环境破坏你的应用程序。从 Docker 默认配置开始，监控应用程序实际调用了什么（`strace -f -e trace=network,process,file` 是你的好帮手），只在有证据表明需要时才添加限制。

## 只读文件系统

下一层是让容器的根文件系统只读：

```console
$ docker run --rm --read-only alpine:latest sh -c "echo test > /tmp/testfile && echo 'write to /tmp succeeded' || echo 'write to /tmp failed'"
write to /tmp failed
sh: can't create /tmp/testfile: Read-only file system
```

加上 tmpfs 挂载 `/tmp`：

```console
$ docker run --rm --read-only --tmpfs /tmp alpine:latest sh -c "echo test > /tmp/testfile && echo 'write to /tmp succeeded' || echo 'write to /tmp failed'"
write to /tmp succeeded
```

写入 `/etc` 仍然失败：

```console
$ docker run --rm --read-only alpine:latest sh -c "echo test > /etc/testfile 2>&1 || echo 'write to /etc failed'"
sh: can't create /etc/testfile: Read-only file system
write to /etc failed
```

这非常有效，因为很多攻击依赖写文件：在 `/etc/cron.d` 放 cron 任务、在 `/usr/lib` 植入共享库、或修改应用程序二进制。使用 `--read-only` 后，这些写入以 `EROFS` 失败。`/tmp` 的 tmpfs 是临时的——存在于内存中，容器停止后消失。

## 丢弃 capabilities

Linux 将 root 的单一权限划分为约 40 个细粒度 capabilities。Docker 默认授予每个容器约 14 个。你可以全部丢弃：

```console
$ docker run --rm alpine:latest sh -c "cat /proc/self/status | grep Cap"
CapInh: 0000000000000000
CapPrm: 00000000a80425fb
CapEff: 00000000a80425fb
CapBnd: 00000000a80425fb
CapAmb: 0000000000000000
```

```console
$ docker run --rm --cap-drop=ALL alpine:latest sh -c "cat /proc/self/status | grep Cap"
CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 0000000000000000
CapAmb: 0000000000000000
```

使用 `--cap-drop=ALL` 后，有效 capability 集合为零。`mount` 失败：

```console
$ docker run --rm --cap-drop=ALL alpine:latest sh -c "mount -t tmpfs tmpfs /mnt 2>&1 || echo 'mount failed'"
mount: permission denied (are you root?)
mount failed
```

我在[专门的文章](/zh/posts/linux-capabilities/)中详细讨论了 capabilities；这里的关键结论是 `--cap-drop=ALL` 是核选项，你需要用 `--cap-add` 只添加应用程序必需的。

## 以非 root 用户运行

这是最有效且最被低估的选项：

```console
$ docker run --rm --user 1000:1000 alpine:latest sh -c "id && whoami"
uid=1000 gid=1000 groups=1000
whoami: unknown uid 1000
```

即使攻击者突破了应用程序，他们是 uid 1000 而非 root。他们无法读取 `/etc/shadow`，无法绑定 1024 以下端口，无法修改系统文件。结合 `--read-only`，非 root 用户的活动空间非常有限。

## no-new-privileges

`--security-opt no-new-privileges` 阻止容器进程通过 `setuid` 二进制或 `execve` 调用获得新权限。这阻止了一整类权限提升漏洞：

```console
$ docker run --rm --security-opt no-new-privileges alpine:latest sh -c "cat /proc/self/status | grep -i 'NoNewPrivs\|CapEff\|CapBnd'"
CapEff: 00000000a80425fb
CapBnd: 00000000a80425fb
NoNewPrivs: 1
```

设置 `NoNewPrivs: 1` 后，容器内的 setuid 二进制（如 `su` 或 `sudo`）无法将权限提升到当前 bounding set 之外。这对于运行不可信代码或第三方依赖的容器尤为重要。

## 组合使用

一个加固后的容器调用如下：

```bash
docker run \
  --read-only \
  --tmpfs /tmp \
  --user 1000:1000 \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --security-opt seccomp=./custom-profile.json \
  -p 127.0.0.1:8080:8080 \
  myapp:latest
```

每个标志都是一层：

| 层 | 标志 | 阻止什么 |
|---|---|---|
| 文件系统 | `--read-only` | 写入根文件系统 |
| 用户 | `--user 1000:1000` | 以 root 运行 |
| Capabilities | `--cap-drop=ALL` | 内核权限位 |
| seccomp | `--security-opt seccomp=...` | 危险系统调用 |
| 权限提升 | `--security-opt no-new-privileges` | setuid 漏洞 |

## 诚实的框架

我想说清楚这些层能做什么、不能做什么。**它们不是银弹。** 大多数容器中的真正风险是应用程序代码和你给的挂载，而不是缺少某条 seccomp 规则。如果应用程序存在远程代码执行漏洞，攻击者仍然可以通过网络窃取数据——seccomp 不阻止 `sendto`。如果将 Docker socket（`/var/run/docker.sock`）挂载进容器，所有这些层都被绕过，因为容器可以直接与以 root 运行的 Docker 守护进程通信。

这些层是**纵深防御**。它们让利用变得困难，而非不可能。它们为你争取时间，提高入侵在变成入侵被发现之前的概率。将它们作为更广泛策略的一部分，包括最小基础镜像、依赖扫描、网络分段和最小权限挂载。

但不要照搬安全选项。理解每个标志的作用，测试应用程序是否仍然正常工作，基于证据而非恐惧添加限制。
