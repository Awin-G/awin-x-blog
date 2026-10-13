---
title: "Linux capabilities 解密：root 的权限，逐项拆解"
description: "一份实战 Linux capabilities 指南，附真实 Docker 演示：为什么 root 权限过大、约 40 个 capability 如何拆分它、五个集合、capsh、/proc/self/status、getcap/setcap、bounding set、CAP_SYS_ADMIN 问题，以及 drop-all-add-back 实用配方。"
pubDate: 2027-01-18
lang: zh
translationKey: linux-capabilities
tags: [security, linux]
featured: false
keywords:
  - Linux capabilities
  - CAP_NET_RAW
  - capsh
  - cap-drop
  - setcap
---

**Linux capabilities**（权能）是每个系统管理员最终都会问的问题的答案："为什么一个进程仅仅为了发送一个原始包就必须是 root？"在 Linux 2.2 之前，答案是非此即彼的——一个进程要么拥有完全特权（root），要么没有。这意味着任何只需要*一种*特殊能力的程序（绑定低端口、发送 ping、更改文件所有者）都必须以 root 运行，而如果该程序有漏洞，你的整台机器就被攻破了。**Capabilities** 将 root 的单一权力拆分为约 40 个可以独立授予的细粒度权限，使进程恰好获得它需要的权限，不多不少。本文将讲解模型、五个集合、工具（`capsh`、`getcap`、`setcap`、`/proc/self/status`）、容器如何利用它们实现最小权限，为什么 `CAP_SYS_ADMIN` 被称为"新 root"，以及今天就能使用的实战配方。每个演示都在一次性 Docker 容器中运行——不使用 `--privileged`，主机上不需要 sudo。

## 为什么 root 权限过大

传统 Unix 特权模型极其简单：uid 0（root）可以做任何事，其他人几乎什么都做不了。问题不在于 root 强大——而在于"任何事"实在太多了。root 可以：

- 读写系统上的每个文件，无视权限设置
- 绑定任何端口，包括 1024 以下的 privileged 端口
- 发送和接收原始网络包（构造任意包）
- 加载内核模块、挂载文件系统、更改系统时间
- 追踪和杀死任何进程
- 更改文件所有权、绕过 DAC（自主访问控制）

如果某个程序需要上述一种能力——比如需要发送自定义 ICMP 包的网络诊断工具——该程序历史上就必须以 root 运行。而一旦以 root 运行，其中任何漏洞（缓冲区溢出、逻辑错误、库缺陷）都会给攻击者*所有*这些能力，而不仅仅是程序需要的那一个。

Capabilities 通过将 root 的"一切"拆分为独立的、可单独授予的权限来解决这个问题。你不再只能说"root 或什么都不是"，而是可以说"这个进程可以发送原始包，但不能加载内核模块或更改系统时间。"

<figure>
<svg viewBox="0 0 680 215" width="100%" role="img" aria-label="左侧一个大箱子标记为 root，内含许多小 capability 箱子。箭头从这些小箱子指向右侧一个大箱子，其中只有三个，展示了 root 的权限如何被拆分为独立 capability，然后进程只接收它需要的三个。">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.5">
    <rect x="10" y="28" width="320" height="170" rx="12"/>
    <rect x="360" y="28" width="310" height="170" rx="12"/>
    <rect x="40" y="50" width="62" height="28" rx="5"/>
    <rect x="110" y="50" width="62" height="28" rx="5"/>
    <rect x="180" y="50" width="62" height="28" rx="5"/>
    <rect x="250" y="50" width="62" height="28" rx="5"/>
    <rect x="40" y="86" width="62" height="28" rx="5"/>
    <rect x="110" y="86" width="62" height="28" rx="5"/>
    <rect x="180" y="86" width="62" height="28" rx="5"/>
    <rect x="250" y="86" width="62" height="28" rx="5"/>
    <rect x="40" y="122" width="62" height="28" rx="5"/>
    <rect x="110" y="122" width="62" height="28" rx="5"/>
    <rect x="180" y="122" width="62" height="28" rx="5"/>
    <rect x="250" y="122" width="62" height="28" rx="5"/>
    <rect x="75" y="160" width="62" height="28" rx="5"/>
    <rect x="145" y="160" width="62" height="28" rx="5"/>
    <rect x="215" y="160" width="62" height="28" rx="5"/>
    <rect x="390" y="50" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
    <rect x="390" y="110" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
    <rect x="530" y="75" width="120" height="40" rx="6" fill="#0f766e" fill-opacity="0.15"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="170" y="20" text-anchor="middle" font-weight="600">root (uid 0)</text>
    <text x="515" y="20" text-anchor="middle" font-weight="600">此进程</text>
    <text x="71" y="69" text-anchor="middle">CAP_NET_RAW</text>
    <text x="141" y="69" text-anchor="middle">CAP_SYS_ADMIN</text>
    <text x="211" y="69" text-anchor="middle">CAP_CHOWN</text>
    <text x="281" y="69" text-anchor="middle">CAP_KILL</text>
    <text x="71" y="105" text-anchor="middle">CAP_SETUID</text>
    <text x="141" y="105" text-anchor="middle">CAP_SYS_TIME</text>
    <text x="211" y="105" text-anchor="middle">CAP_SYS_MODULE</text>
    <text x="281" y="105" text-anchor="middle">…约40个</text>
    <text x="71" y="141" text-anchor="middle">CAP_NET_BIND</text>
    <text x="141" y="141" text-anchor="middle">CAP_SYS_PTRACE</text>
    <text x="211" y="141" text-anchor="middle">CAP_MKNOD</text>
    <text x="281" y="141" text-anchor="middle">CAP_AUDIT</text>
    <text x="106" y="179" text-anchor="middle">CAP_FOWNER</text>
    <text x="176" y="179" text-anchor="middle">CAP_SETPCAP</text>
    <text x="246" y="179" text-anchor="middle">…</text>
    <text x="450" y="75" text-anchor="middle">CAP_NET_RAW</text>
    <text x="450" y="135" text-anchor="middle">CAP_NET_BIND_SERVICE</text>
    <text x="590" y="100" text-anchor="middle">CAP_CHOWN</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" marker-end="url(#arrow)">
    <line x1="340" y1="64" x2="388" y2="70"/>
    <line x1="340" y1="94" x2="388" y2="125"/>
    <line x1="340" y1="136" x2="528" y2="95"/>
  </g>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
</svg>
<figcaption>Capability 出现之前：root 是一个包含所有权限的大箱子。之后：每个权限是独立的 capability，进程只接收它需要的三个——<code>CAP_NET_RAW</code>、<code>CAP_NET_BIND_SERVICE</code>、<code>CAP_CHOWN</code>——其余的留在原地。</figcaption>
</figure>

## 约 40 个 capabilities：root 的逐项拆解

Linux 定义了约 40 个命名的 capability（确切数量因内核版本略有不同）。每个对应一个特定的特权操作。你在实际工作中最常见的：

| Capability | 允许的操作 |
|---|---|
| `CAP_CHOWN` | 更改文件所有权（chown） |
| `CAP_DAC_OVERRIDE` | 绕过文件读/写/执行权限检查 |
| `CAP_NET_RAW` | 发送/接收原始包、使用原始套接字 |
| `CAP_NET_BIND_SERVICE` | 绑定 1024 以下端口 |
| `CAP_SYS_ADMIN` | 挂载文件系统、加载模块等等——"新 root" |
| `CAP_SYS_PTRACE` | 追踪和检查其他进程 |
| `CAP_KILL` | 向你拥有的进程之外发送信号 |
| `CAP_SETUID` | 更改进程的有效 uid |
| `CAP_SETPCAP` | 向/从其他进程转移 capabilities |

完整列表在 `man 7 capabilities` 中。关键洞察是这些能力是*独立的*——授予 `CAP_NET_RAW` 不会授予 `CAP_CHOWN`，反之亦然。

## 五个集合：capabilities 的存储位置

每个 capability 可以存在于附加到进程的五个集合中的一个或多个中。理解这些集合是理解 capabilities 实际工作原理的关键：

- **Effective (CapEff)**：进程当前*使用*的 capabilities，用于进行权限检查。如果一个 capability 在此集合中，进程现在就可以行使它。
- **Permitted (CapPrm)**：进程被*允许*拥有的 capabilities。这是它能获得的最大值——可以随时将一个 capability 从 permitted "提升"为 effective。
- **Inheritable (CapInh)**：在 `execve()` 中存活的 capabilities（当进程替换为新程序时）。仅当新程序设置了文件 capabilities 时才有意义。
- **Bounding (CapBnd)**：*上限*——进程永远无法获得 bounding set 之外的 capability，无论如何都不行。这就是 `--cap-drop=ALL` 实际缩小的集合。
- **Ambient (CapAmb)**：自动对子进程可用的 capabilities，即使它们没有文件 capabilities。设计目的是让文件 capabilities 在实践中更易使用。

你可以随时从 `/proc/self/status` 读取所有五个集合：

```
$ grep -E "^Cap" /proc/self/status
CapInh:	0000000000000000
CapPrm:	0000000000002000
CapEff:	0000000000002000
CapBnd:	0000000000002000
CapAmb:	0000000000000000
```

这些是 64 位十六进制掩码——每一位代表一个 capability。解码方法：

```
$ capsh --decode=0000000000002000
0x0000000000002000=cap_net_raw
```

这是一个只有一个 capability 的进程：`CAP_NET_RAW`。

## capsh：capabilities 的瑞士军刀

`capsh` 是 `libcap2-bin` 包中的工具，让你可以从命令行检查和操作 capabilities。最常用的命令是 `capsh --print`，显示当前状态：

```
$ capsh --print
Current: cap_wake_alarm=i
Bounding set =cap_chown,cap_dac_override,cap_dac_read_search,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_linux_immutable,cap_net_bind_service,cap_net_broadcast,cap_net_admin,cap_net_raw,cap_ipc_lock,cap_ipc_owner,cap_sys_module,cap_sys_rawio,cap_sys_chroot,cap_sys_ptrace,cap_sys_pacct,cap_sys_admin,cap_sys_boot,cap_sys_nice,cap_sys_resource,cap_sys_time,cap_sys_tty_config,cap_mknod,cap_lease,cap_audit_write,cap_audit_control,cap_setfcap,cap_mac_override,cap_mac_admin,cap_syslog,cap_wake_alarm,cap_block_suspend,cap_audit_read,cap_perfmon,cap_bpf,cap_checkpoint_restore
Ambient set =
Current IAB: cap_wake_alarm
Securebits: 00/0x0/1'b0 (no-new-privs=0)
uid=1000(awinx) euid=1000(awinx)
gid=1000(awinx)
Guessed mode: HYBRID (4)
```

注意：即使是普通用户，我的 *bounding set* 也包含约 40 个 capabilities。它们在 bounding set（上限）中，但不在 effective set 中——所以如果 setuid 二进制文件或文件 capability 允许，我*可以*获得它们，但我现在没有使用它们。`capsh` 还支持 `--drop=`、`--addamb=` 和 `--decode=` 用于交互式 capability 操作。

## CAP_NET_RAW 演示：ping 失败，ping 成功

这是让一切变得具体的实验。我将使用 Docker 运行两个容器——一个*完全没有* capability，另一个只添加回 `CAP_NET_RAW`。然后测试原始 ICMP 套接字，这需要 `CAP_NET_RAW`。

首先，使用 `--cap-drop=ALL` 的容器：

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c '
    python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    print(\"RAW SOCKET: SUCCESS - have CAP_NET_RAW\")
except PermissionError as e:
    print(f\"RAW SOCKET: DENIED - {e}\")
    "'
RAW SOCKET: DENIED - [Errno 1] Operation not permitted
```

现在使用 `--cap-drop=ALL --cap-add=NET_RAW` 的同一容器：

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c '
    python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    print(\"RAW SOCKET: SUCCESS - have CAP_NET_RAW\")
except PermissionError as e:
    print(f\"RAW SOCKET: DENIED - {e}\")
    "'
RAW SOCKET: SUCCESS - have CAP_NET_RAW
```

相同内核、相同容器镜像、相同用户（容器内为 root）。唯一的区别就是一个 capability。关键点是：起作用的是 capability，不是 uid。进程在*两种*情况下都是 root——但 bounding set 中没有 `CAP_NET_RAW`，即使是 root 也无法创建原始套接字。这就是最小权限的全部意义。

你可能注意到 `ping` 本身即使使用 `--cap-drop=ALL` 也能工作，至少在现代内核上。这是因为 Linux 有一个 sysctl `net.ipv4.ping_group_range`，允许某些组在不使用 `CAP_NET_RAW` 的情况下使用 ICMP 套接字：

```
$ cat /proc/sys/net/ipv4/ping_group_range
0	2147483647
```

该设置允许所有组使用 ping 套接字（便利功能）。但原始套接字——允许构造*任意*包——仍然需要 `CAP_NET_RAW`。不要混淆这两者。

## 从 /proc/self/status 读取 capabilities

让我们直接看每种场景下的 capability sets。使用 `--cap-drop=ALL` 时：

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c '
    grep -E "^Cap" /proc/self/status &&
    echo "" &&
    capsh --decode=$(grep CapEff /proc/self/status | awk "{print \$2}") &&
    capsh --decode=$(grep CapBnd /proc/self/status | awk "{print \$2}")'
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	0000000000000000
CapAmb:	0000000000000000

0x0000000000000000=

0x0000000000000000=
```

所有集合都是空的。Bounding set 为零——这个进程*永远*无法获得 capability，无论它运行什么二进制文件。使用 `--cap-add=NET_RAW` 时：

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c '
    grep -E "^Cap" /proc/self/status &&
    echo "" &&
    capsh --decode=$(grep CapEff /proc/self/status | awk "{print \$2}")'
CapInh:	0000000000000000
CapPrm:	0000000000002000
CapEff:	0000000000002000
CapBnd:	0000000000002000
CapAmb:	0000000000000000

0x0000000000002000=cap_net_raw
```

现在 bounding set、permitted 和 effective 都恰好包含 `cap_net_raw`。此容器中的 `capsh --print` 输出证实了这一点：

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo capsh --print
Current: cap_net_raw=ep
Bounding set =cap_net_raw
Ambient set =
uid=0(root) euid=0(root)
Guessed mode: HYBRID (4)
```

`ep` 表示 "effective + permitted"。Bounding set 从约 40 个 capabilities 缩减到恰好一个。这就是最小权限的实际应用。

## 文件 capabilities vs setuid root

向非 root 进程授予特定 capability 有两种方式：**setuid root** 和**文件 capabilities**。

setuid root 二进制文件由 root 拥有并设置了 setuid 位，所以当你运行它时，进程获得 root 的*完全*特权。这是旧模型——全有或全无。**文件 capability** 将特定 capabilities 附加到二进制文件，运行它只授予这些 capabilities，而不是完整的 root。

`getcap` 命令显示二进制文件上的文件 capabilities。在典型的 Debian/Ubuntu 系统上，`ping` 具有文件 capability 而非 setuid root：

```
$ getcap /usr/bin/ping
/usr/bin/ping cap_net_raw=ep
```

这意味着：当任何用户运行 `ping` 时，进程自动在其 effective 和 permitted sets 中获得 `CAP_NET_RAW`。让我们在实践中看到它。我复制 `ping`，给它一个文件 capability，然后观察 `chown` 在获得 `CAP_CHOWN` 之前失败、之后成功：

```
$ cp /usr/bin/ping /tmp/ping-test
$ setcap cap_net_raw+ep /tmp/ping-test
$ getcap /tmp/ping-test
/tmp/ping-test cap_net_raw=ep

$ ls -la /tmp/ping-test
-rwxr-xr-x 1 root root 156136 Oct 13 00:38 /tmp/ping-test

$ /tmp/ping-test -c 1 -W 2 127.0.0.1
PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: seq=0 ttl=64 time=0.034 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.034/0.034/0.034/0.000 ms

$ setcap -r /tmp/ping-test
$ getcap /tmp/ping-test
(空 = caps 已移除)
```

同样的原理适用于 `chown`。这里有一个演示，展示带 `CAP_CHOWN` 的 shell 副本可以在不是 root 的情况下更改文件所有权：

```
$ cp /bin/sh /tmp/dash-cown
$ setcap cap_chown+ep /tmp/dash-cown
$ getcap /tmp/dash-cown
/tmp/dash-cown cap_chown=ep

$ /tmp/dash-cown -c "chown 1000:1000 /tmp/testfile && echo chown NOW WORKS with CAP_CHOWN"
chown NOW WORKS with CAP_CHOWN
```

文件 capabilities 是 setuid 的现代替代品。它们授予*特定*权限而非整个 root。代价是复杂性——需要用 `setcap`/`getcap` 管理它们，并非所有文件系统都支持（大多数现代文件系统支持）。

## 容器如何使用 capabilities：Docker 的故事

Docker 容器启动时默认拥有约 14 个 capabilities——一个精选列表，比典型进程需要的更广泛。默认集合包括 `CAP_NET_RAW`、`CAP_CHOWN`、`CAP_DAC_OVERRIDE`、`CAP_SETUID`、`CAP_SETGID`、`CAP_NET_BIND_SERVICE` 等几个。这就是为什么 `ping` 在容器内无需任何特殊配置即可工作。

`--cap-drop` 和 `--cap-add` 标志让你调整这个集合。安全最佳实践是**drop all，只添加回你需要的**：

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_RAW cap-demo sh -c 'ping -c 1 -W 2 127.0.0.1'
PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: seq=0 ttl=64 time=0.055 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.055/0.055/0.055/0.000 ms
```

这个容器可以 ping（因为我们添加了 `CAP_NET_RAW`），但不能 chown 文件、绑定低端口、更改系统时间、加载内核模块，或做默认集合允许的其他约 39 件事。如果容器被攻破，攻击者的能力恰好限于我们添加回的内容。

Bounding set 是关键。使用 `--cap-drop=ALL` 时，Docker 将容器的 bounding set 设置为空。即使容器内的二进制文件有文件 capabilities 或是 setuid root，bounding set 也充当天花板，限制这些机制能授予的内容。没有二进制文件、没有漏洞利用、没有 setuid 技巧能给进程 bounding set 之外的 capability。

## CAP_SYS_ADMIN："新 root"问题

并非所有 capabilities 都是平等的。`CAP_SYS_ADMIN` 是一个包含行政管理能力的大杂烩——挂载文件系统、操作命名空间、配置网络、加载模块等等。它如此广泛，以至于安全从业者称之为"新 root"。向容器授予 `CAP_SYS_ADMIN` 通常等同于给它主机的完整 root 权限，因为容器可以利用这些能力逃逸其命名空间并访问主机。

这就是为什么默认 Docker 集合*确实*包含 `CAP_SYS_ADMIN`——许多工作负载需要它（Docker-in-Docker、某些存储驱动程序、某些监控工具）。但如果你不需要它，就 drop 它：

```
$ docker run --rm --cap-drop=ALL cap-demo sh -c 'capsh --print'
Current: =ep
Bounding set =
Ambient set =
uid=0(root) euid=0(root)
```

空的 bounding set。进程按 uid 是 root，但它完全没有 capabilities。它不能挂载、不能 ptrace、不能做任何特权的事情。这就是容器版 setuid 精简二进制文件——shell 说"root"但内核说"不行"。

## 实用配方：drop all，添加回你需要的一个

我对每个不需要广泛默认集合的容器使用的配方：

1. **从 `--cap-drop=ALL` 开始**——将 bounding set 缩减为零。
2. **只添加回应用需要的内容**——例如，网络工具添加 `--cap-add=NET_RAW`，80 端口的 web 服务器添加 `--cap-add=NET_BIND_SERVICE`。
3. **结合其他加固措施**——`--read-only` 文件系统、`--security-opt=no-new-privileges`、非 root 的 `--user` 和资源限制。

一个具体的例子——只需要绑定 80 端口、不需要其他任何内容的容器：

```
$ docker run --rm --cap-drop=ALL --cap-add=NET_BIND_SERVICE --read-only cap-demo sh -c 'echo "I can bind port 80, and nothing else"'
I can bind port 80, and nothing else
```

这就是完整的哲学：**最小权限**。不是"root 加几步"，而是一个恰好拥有其工作所需权限的进程——不多不少。

如果你在生产环境中运行容器，审计每个容器实际需要哪些 capabilities。大多数不需要大多数默认值。[容器安全基础](/zh/posts/container-security/)和[加固公共服务器](/zh/posts/hardening-a-public-server/)是很好的配套文章。

## 总结

Linux capabilities 使 Linux 上的最小权限成为可能。它们将 root 的单一权力拆分为约 40 个独立权限，将它们组织成五个集合（effective、permitted、inheritable、bounding、ambient），让你能恰好授予进程需要的权限——不多不少。工具很简单：`capsh` 用于检查和操作，`getcap`/`setcap` 用于管理文件 capabilities，`/proc/self/status` 用于读取原始掩码，Docker 的 `--cap-drop`/`--cap-add` 用于在容器中应用该模型。

关键要点：**bounding set 是天花板**。将其降为零，只添加回需要的，你就将攻击面从"整个 root"缩小到"这个程序实际使用的一个能力"。这就是能读取主机文件的被攻破容器和只能做一件事的被攻破容器之间的区别——仅此而已。
