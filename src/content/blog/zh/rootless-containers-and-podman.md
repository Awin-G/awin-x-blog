---
title: "无根容器：不用 root 运行容器（以及 Podman vs Docker）"
description: "有 root 权限的容器守护进程等同于 host 上的 root——容器逃逸即获得宿主机 root。用真实演示讲解 user namespaces、subuid/subgid 映射、unshare，以及无根模式的代价：低端口、存储驱动、cgroup 委托。对工作站与服务器给出诚实的 Podman vs Docker 建议。"
pubDate: 2027-02-05
lang: zh
translationKey: rootless-containers-and-podman
tags: [devops, security]
featured: false
keywords:
  - 无根容器
  - Podman vs Docker
  - user namespaces
  - subuid
  - 无守护进程
---

大多数容器安全建议止步于容器*内部*的姿态——丢弃 capabilities、以非 root 运行、只读文件系统。这些都很重要，我在[容器安全基础](/zh/posts/container-security/)中已经讲过。但下面还有一个更根本的问题：**谁在运行守护进程？** 有 root 权限的容器守护进程在宿主机上等同于 root。攻击者逃出容器后得到的不是"容器 root"，而是*宿主机* root——因为守护进程本身就是 root，而内核是共享的。**无根容器（rootless containers）**改变了这一切：守护进程以你——一个非特权用户——的身份运行，逃逸后攻击者得到的权限不会超过你本来就有权限。本文讲机制（user namespaces、`subuid`/`subgid`）、两种运行时（Podman vs Docker），以及诚实地讨论什么会坏掉。

## 问题：有 root 权限的守护进程等同于 root

在这台 Arch 机器上，Docker 守护进程以 root 身份运行：

```console
$ ps -o user,pid,comm -p $(pgrep -f dockerd | head -1)
USER         PID COMMAND
root      147879 dockerd
$ pgrep -fa dockerd
147879 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
```

这不是偶然——在经典模型中容器守护进程*必须*是 root，因为创建容器意味着调用特权内核操作（挂载 overlay 文件系统、操作网络接口、写 cgroup 文件），这些操作只有 root 才能执行。守护进程是一个 root 进程，监听一个 root 拥有的 socket（`/var/run/docker.sock`），并乐意代你执行 root 操作。把这个 socket 挂进容器，等于把宿主机拱手相让——`docker.sock` 这个坑本身就值一整篇文章。

Docker 报告的安全选项是真实的，但它们在容器*内部*：

```console
$ docker info | sed -n '/Security Options/,/Kernel Version/p'
 Security Options:
  seccomp
   Profile: builtin
  cgroupns
```

seccomp、cgroup namespace 隔离——这些保护宿主机免受容器*系统调用*的攻击。对守护进程自身的 root 权限却无能为力。内核逃逸的爆炸半径是守护进程的权限，不是容器的权限。这正是无根模式要填的缺口。

## User namespaces：让无根成为可能的机制

**User namespace**（用户命名空间）是一种重新映射用户和组 ID 的命名空间。在 user namespace 内部，你可以是 uid 0（root），而在外部——在真正的宿主机上——你仍然是普通的非特权用户。内核负责两种视角之间的转换。这是让无根容器成为可能的唯一原语，它不是容器的发明——而是通用的 Linux namespace，自内核 3.8 起可用。

在这台机器上验证。外面我是 `awinx`（uid 1000）。在新的 user namespace 内部，我是 root：

```console
$ unshare -Ur id
uid=0(root) gid=0(root) groups=0(root),65534(nobody)
$ echo "outside: $(id -un) (uid=$(id -u))"
outside: awinx (uid=1000)
$ unshare -Ur sh -c 'echo "inside userns: $(id -un) (uid=$(id -u))"'
inside userns: root (uid=0)
```

内核自己看到的映射，从内部看：

```console
$ unshare -Ur sh -c 'cat /proc/self/uid_map; echo "--- gid_map ---"; cat /proc/self/gid_map'
         0       1000          1
--- gid_map ---
         0       1000          1
```

`0 1000 1` 的含义是：*内部*的 uid 0 映射到*外部*的 uid 1000，范围为 1 个 ID。转换是一一对应的——你到底是谁，毫无歧义。

真正的证明是文件会发生什么。在 namespace 内部创建一个文件，从外部检查它的属主：

```console
$ unshare -Ur sh -c 'id; touch /tmp/opencode/work/rootless/inside_ns.txt; echo "inside sees:"; ls -ln /tmp/opencode/work/rootless/inside_ns.txt'
uid=0(root) gid=0(root) groups=0(root),65534(nobody)
inside sees:
-rw-r--r-- 1 0 0 0 10月14日 13:30 /tmp/opencode/work/rootless/inside_ns.txt
$ ls -ln /tmp/opencode/work/rootless/inside_ns.txt
-rw-r--r-- 1 1000 1000 0 10月14日 13:30 /tmp/opencode/work/rootless/inside_ns.txt
```

内部看：属于 root（uid 0）。外部看：属于 uid 1000，即 `awinx`。同一个文件，两个身份。无根容器运行时正是利用了这一点：容器的 root 被映射到你的用户拥有的一段次级 ID，所以"内部的 root"在外部确实是非特权的。

<figure>
<svg viewBox="0 0 680 240" width="100%" role="img" aria-label="uid 映射双面板图。左侧：宿主机视角，单个非特权用户 awinx uid 1000。右侧：user namespace 内部，容器 root uid 0。标注 0 到 1000 的箭头连接两侧。">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.55">
    <rect x="30" y="60" width="260" height="140" rx="10"/>
    <rect x="390" y="60" width="260" height="140" rx="10"/>
  </g>
  <g fill="#0f766e" stroke="none">
    <path d="M 320 130 L 380 130" stroke="#0f766e" stroke-width="2" fill="none"/>
    <polygon points="380,130 368,124 368,136" fill="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="160" y="30" text-anchor="middle" font-weight="600">宿主机视角（外部）</text>
    <text x="520" y="30" text-anchor="middle" font-weight="600">容器视角（userns 内部）</text>

    <text x="160" y="95" text-anchor="middle" font-weight="600">awinx</text>
    <text x="160" y="118" text-anchor="middle">uid 1000</text>
    <text x="160" y="140" text-anchor="middle" opacity="0.7">普通非特权用户</text>
    <text x="160" y="170" text-anchor="middle" opacity="0.7">宿主机上的真实身份</text>

    <text x="520" y="95" text-anchor="middle" font-weight="600">容器 root</text>
    <text x="520" y="118" text-anchor="middle">uid 0</text>
    <text x="520" y="140" text-anchor="middle" opacity="0.7">外部映射回 uid 1000</text>
    <text x="520" y="170" text-anchor="middle" opacity="0.7">名义上的 root</text>

    <text x="350" y="120" text-anchor="middle" fill="#0f766e" font-weight="700">0 → 1000</text>
    <text x="350" y="145" text-anchor="middle" fill="#0f766e" font-weight="700">1 个 ID 范围</text>
  </g>
</svg>
<figcaption>User namespace 的 uid 映射。容器的 uid 0 只在命名空间内部是真正的 root；外部它就是你的普通非特权 uid 1000。无根运行时正是构建在这个转换之上。</figcaption>
</figure>

## subuid 和 subgid：无根所需的 ID 范围

单 ID 映射（root → 你）足以*证明*这个概念，但一个真正的无根容器需要很多 UID：镜像里有属于 uid 0、1、2……的文件，它们都必须映射到某个非特权 ID。Linux 用**次级 ID 范围（subordinate ID ranges）**来解决这个问题。你的用户被分配一段连续的 UID 和 GID，可以在 namespace 内部使用：

```console
$ cat /etc/subuid
awinx:100000:65536
$ cat /etc/subgid
awinx:100000:65536
```

`awinx:100000:65536` 的含义是：用户 `awinx` 可以使用 65536 个从 100000 开始的次级 ID——即 UID 100000–165535 都归他映射。无根容器运行时从这段范围中划出一片，将容器的 uid 0 映射到其中的某个 ID，uid 1 映射到下一个，依此类推。宿主机保留低位范围（0–65535）给真正的系统账户，你的非特权用户拥有高位范围。这个文件是非用户能够使用无根的根因——没有分配的范围，就没有东西可以映射*到*。

两个 sysctl 控制着整个特性。在这台机器上两者都允许：

```console
$ sysctl kernel.unprivileged_userns_clone
kernel.unprivileged_userns_clone = 1
$ sysctl user.max_user_namespaces
user.max_user_namespaces = 47200
```

`kernel.unprivileged_userns_clone = 1` 是 Debian/Ubuntu 特有的开关，允许非特权用户创建 user namespace（此处设为 1；在某些发行版上默认为 0，必须手动开启）。`user.max_user_namespaces` 限制单个用户可创建的 user namespace 数量——此处为 47200，对于工作站实际上等于无限。如果任一为 0，无根模式直接不可用，修复方法是一行 `sysctl` 配置，而不是容器标志。

## Podman vs Docker：无守护进程 vs 无根守护进程

这是两种运行时真正产生差异的地方，而差异是架构层面的。

**Podman** 是**无守护进程（daemonless）**且**无根优先**的。根本没有长期运行的 root 守护进程。Podman 使用 fork/exec 模型：你调用的 `podman` 进程 fork 一个子进程，子进程成为容器，两者通过 socket 通信。当你以非特权用户运行时，Podman 为该子进程创建一个 user namespace，将你的 `subuid`/`subgid` 范围映射进去，并作为"root"在 namespace 内部*运行容器——而外部是你的非特权 uid。没有 root 守护进程，没有 root socket，在常见场景下不需要 setuid 辅助程序。CLI 有意与 Docker 兼容（`podman run`、`podman build`、`podman ps`），肌肉记忆可以直接迁移。

**Docker** 则是相反的形态：一个有 root 权限的 `dockerd` 守护进程，监听 root 拥有的 socket。Docker*可以*无根运行——`dockerd-rootless.sh` 以你的非特权用户在 user namespace 内启动一个守护进程——但这是附加模式，不是设计中心。无根 Docker 守护进程仍然需要相同的原语（user namespaces、次级 ID），加上内核通常为 root 执行的操作的用户空间替代品：**fuse-overlayfs** 用于 overlay 文件系统（因为非特权用户无法直接挂载 overlayfs），**slirp4netns** 或 **pasta** 用于网络（因为非特权用户无法配置真正的网络接口）。这些用户空间层可以工作，但比 Podman 在无根默认设置下采取的内核原生路径更慢、组件更多。

我无法在这台机器上运行 Podman 来展示——它没有安装：

```console
$ podman --version
zsh:1: command not found: podman
```

所以诚实的说法是：在这台特定主机上，我可以证明*原语*（user namespaces、次级 ID、namespace 创建）——两者都依赖它们——但我无法向你展示实时的 `podman run`。上述架构论断来自两者的构建方式，不是来自这台机器上的并排基准测试。

## 诚实地说：无根模式什么会坏

无根不是免费的。所有会坏的东西都有一个共同原因：非特权用户无法做 root 能做的事，而容器历来假设自己是 root。

**绑定 1024 以下的端口。** 端口 1–1023 是特权端口；只有 root 能绑定。无根容器尝试 `-p 80:80` 会失败。解决方案是让 `slirp4netns`/`pasta` 处理转换，或者直接使用非特权端口（8080、8443），让反向代理或宿主机的无根端口转发器处理 80/443。

**存储驱动。** overlay 文件系统需要挂载权限。有 root 的 Docker 使用内核 overlay 驱动；无根 Docker 必须使用 **fuse-overlayfs**——一个在用户空间运行的 FUSE 实现。它可以工作，但在 I/O 密集负载上有性能代价。Podman 在无根设置下使用相同的 FUSE 路径，除非有内核原生无根 overlay 可用。

**cgroup v2 委托。** 容器受 cgroup 限制，而写 cgroup 文件通常需要 root。无根设置需要 **cgroup v2 委托**——systemd（或运行时）必须将 cgroup 子树委托给你的用户，容器才能设置自己的 CPU/内存限制。没有它，`--memory` 和 `--cpus` 会被静默忽略或报错。

**`--privileged` 及其同类。** `--privileged` 在无根模式下没有意义——没有 root 可以*提权*。`--cap-add`、`--device`、root 拥有文件的主机路径挂载、`--network host`——全部要么失败，要么行为不同。这是特性（很难意外把宿主机交给容器），但会让人吃惊。

**卷上的文件属主。** 这个坑了所有人。无根容器以映射后的 UID（如 100000+）写文件，从宿主机角度看，这些是你的用户拥有但你不"打算"创建的高位 UID。解决方案是 `--userns=keep-id`（Podman）或 Docker 的等价选项，将你的宿主机 uid 映射到容器内部相同的 uid，这样你写的文件就是你期望的属主。

## 结论：什么时候无根是正确的默认

对于**工作站或开发机**——你登录、在上面运行项目、不想有一个 root 守护进程潜伏的机器——**无根是正确的默认**。威胁模型完全匹配：你是唯一用户，守护进程以你的身份运行，容器逃逸给攻击者的恰好是你本来的非特权访问权限，不会更多。Podman 的无守护进程、无根优先设计完美适合这种场景；Docker 的无根模式可以工作，但带着用户空间开销。

对于运行可信工作负载、只有一个管理员的**专用服务器**，有 root 权限配合良好隔离通常没问题，也更简单——你本来就需要解决 root 问题（SSH、加固、更新），一个有 root 的守护进程相对于一个锁定的 root 账户，边际风险很小。当场景变为多租户、执行不受信任代码的 CI runner、或任何面向互联网的服务时，计算就变了：无根消除了整类"逃逸 → 宿主机 root"的风险，同时不放弃容器。

诚实的总结：无根容器用一些便利（低端口、内核原生存储、cgroup 委托设置）换取严格更小的爆炸半径。在你每天真正使用的机器上，这笔交易是值得的——底层的 user namespace 原语现在已经足够成熟，"默认无根"是合理的姿态，不是实验。从你自己机器上的 `unshare -Ur id` 开始：如果你在外面是 `awinx` 的情况下看到 `uid=0(root)`，整个想法就已经在工作了，运行时只是它上面的一层包装。
