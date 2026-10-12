---
title: "容器安全基础：容器保护了什么，又没保护什么"
description: "容器不是虚拟机，而是跑在宿主机内核上的一个进程。本文用真实的 Docker 实验展示你继承来的默认值——root 用户、14 个 capability、宽松的 seccomp 配置——以及真正有用的开关：--user、--cap-drop、no-new-privileges、--read-only、内存限制、rootless，还有 docker.sock 这个致命陷阱。"
pubDate: 2026-12-10
lang: zh
translationKey: container-security
tags: [security, devops]
featured: false
keywords:
  - 容器安全
  - Docker 安全
  - capability 与 seccomp
  - rootless 容器
  - no-new-privileges
---

关于**容器安全**的建议，大多会滑向两个相反的极端：要么把容器当成一台轻量虚拟机，仿佛它把你和外界彻底隔开；要么把它贬成一无是处的打包格式。真相更窄，也更有用。容器是一个跑在**宿主机内核**上、只是对世界有不同视角的进程；而 **Docker 安全**的默认值，是用来防手滑的，不是用来挡攻击者的。下面讲清每一项默认值到底做了什么、运行时只是*配置*而非真正强制了什么，以及哪些开关能改变结论——全部配上你可以在自己机器上跑的实验。不用 sudo、不用 `--privileged`，只用本地已有的镜像。

<figure>
<svg viewBox="0 0 680 215" width="100%" role="img" aria-label="两张示意图。左：三个容器各含一个应用，共同坐在一个共享的宿主机内核之上，再往下是硬件。右：两台虚拟机各含一个应用和自己的客户机内核，坐在 hypervisor 之上，再往下是硬件。">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.55">
    <rect x="10" y="28" width="320" height="170" rx="10"/>
    <rect x="350" y="28" width="320" height="170" rx="10"/>
    <rect x="25" y="46" width="88" height="52" rx="6"/>
    <rect x="121" y="46" width="88" height="52" rx="6"/>
    <rect x="217" y="46" width="88" height="52" rx="6"/>
    <rect x="25" y="112" width="280" height="32" rx="6"/>
    <rect x="25" y="158" width="280" height="26" rx="6"/>
    <rect x="365" y="46" width="134" height="52" rx="6"/>
    <rect x="511" y="46" width="134" height="52" rx="6"/>
    <rect x="365" y="112" width="280" height="32" rx="6"/>
    <rect x="365" y="158" width="280" height="26" rx="6"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="170" y="20" text-anchor="middle" font-weight="600">容器</text>
    <text x="510" y="20" text-anchor="middle" font-weight="600">虚拟机</text>

    <text x="69" y="76" text-anchor="middle">应用</text>
    <text x="165" y="76" text-anchor="middle">应用</text>
    <text x="261" y="76" text-anchor="middle">应用</text>
    <text x="165" y="132" text-anchor="middle">宿主机内核 —— 只有一个，共享</text>
    <text x="165" y="175" text-anchor="middle">硬件</text>

    <text x="432" y="66" text-anchor="middle">应用</text>
    <text x="432" y="86" text-anchor="middle">客户机内核</text>
    <text x="578" y="66" text-anchor="middle">应用</text>
    <text x="578" y="86" text-anchor="middle">客户机内核</text>
    <text x="505" y="132" text-anchor="middle">hypervisor</text>
    <text x="505" y="175" text-anchor="middle">硬件</text>
  </g>
</svg>
<figcaption>容器模型里所有工作负载共用一个内核，于是这个内核就是信任边界；虚拟机模型里每个 guest 自带内核，由 hypervisor 做硬件级隔离。容器永远不是右边那张图。</figcaption>
</figure>

## 容器不是虚拟机：共享内核这一事实

虚拟机拿到的是一层 hypervisor、虚拟硬件，以及**它自己的内核**。容器拿到的是宿主机的内核，和一组重新划定它能*看见*什么的东西（namespace）。先证明这一点：

```console
$ uname -r
7.2.9-arch1-1
$ docker run --rm alpine:3.21 uname -r
7.2.9-arch1-1
$ docker run --rm alpine:3.21 cat /proc/version
Linux version 7.2.9-arch1-1 (linux@archlinux) (gcc ...) #1 SMP PREEMPT_DYNAMIC Sat, 03 Oct 2026
```

内核字符串一模一样，构建时间也一样。容器什么都没有模拟，它就是在你已经在跑的那个内核上发起系统调用。隔离来自四种机制叠加：

- **namespace** 决定进程能看见什么（PID、挂载、网络、主机名、用户）。
- **cgroup** 决定它能消耗多少（CPU、内存、PID 数量）。
- **capability** 决定 root 还能执行哪些特权内核操作。
- **LSM**（AppArmor/SELinux）在其上再加一层强制访问控制。

实际后果是：内核就是信任边界。一个内核漏洞，离变成一个宿主机漏洞只差一步逃逸；而同一台机器上所有容器共享这份爆炸半径。所以孤立的“安全容器”并不存在——存在的是一个防得住或防不住的*宿主机*。宿主机那一侧是另一篇文章：见[加固一台公网服务器](/zh/posts/hardening-a-public-server/)。

## 你继承来的默认值：root、capability、seccomp

直接 `docker run image`、不带任何参数时，你会继承三个在正常主机上会让运维皱眉的默认值。

**第一：你是 root。** 不是命名空间里假装出来的用户——就是容器用户命名空间里的 uid 0，而它默认就是宿主机的初始用户命名空间，除非你开了 rootless。

```console
$ docker run --rm alpine:3.21 id
uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),...
```

**第二：root 保留 14 个 capability。** 现代 Docker *不会*把全套 capability 交出去——它会丢掉除十四项"已知安全"之外的所有项，这确实不错。但"已知安全"是相对运行时而言的，不是相对你的应用而言的。

```console
$ docker run --rm alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -2'
Current: cap_chown,cap_dac_override,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,
cap_setpcap,cap_net_bind_service,cap_net_raw,cap_sys_chroot,cap_mknod,cap_audit_write,cap_setfcap=ep
Bounding set =cap_chown,cap_dac_override,...,cap_setfcap
```

注意 `cap_dac_override`：它的含义是"忽略文件权限位"。带着它的 root 进程，可以无视 mode 读取容器文件系统里的任何文件——这正是为什么单靠*文件*权限构不成边界。

**第三：seccomp 会过滤系统调用，但很宽松。** Docker 会装一份默认 seccomp 配置，在约 350 个系统调用里拦掉大约 40 个（多为冷门项：`keyctl`、`add_key`、`reboot`，以及命名空间创建）。内核把它报告为 filter 模式：

```console
$ docker run --rm alpine:3.21 grep Seccomp /proc/self/status
Seccomp:        2
Seccomp_filters:        1
$ docker run --rm alpine:3.21 unshare -U true
unshare: unshare(0x10000000): Operation not permitted
$ docker run --rm --security-opt seccomp=unconfined alpine:3.21 unshare -U true
$ echo $?
0
```

默认配置拒绝的同一个 `unshare` 调用，一旦关掉 seccomp 就被放行。这就是人们常混淆的 **capability 与 seccomp** 组合：capability 管的是*特权操作*，seccomp 管的是*哪些系统调用根本存在*。两者都要，丢掉任何一个都覆盖不了另一个。

## 真正有用的 Docker 安全开关

下面每个开关都是对"被攻陷进程能做什么"的一次真实削减，大致按每行配置的价值排序。

### `--user`：别再当 root

杠杆最高的一个参数。给进程一个什么都不拥有的 uid。

```console
$ docker run --rm --user 1000:1000 alpine:3.21 id
uid=1000 gid=1000 groups=1000
$ docker run --rm --user 65534:65534 alpine:3.21 grep '^Uid:' /proc/self/status
Uid:    65534   65534   65534   65534
```

现在进程启动时既不依赖 `cap_dac_override`，也没有对 root 属主路径的写权限。在镜像里，这该写进 Dockerfile（`USER 1000`），而不只是命令行参数。

### `--cap-drop=ALL`：让内核的检查重新生效

全部丢掉，再把应用真正需要的那一两个加回来。

```console
$ docker run --rm --cap-drop=ALL alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -2'
Current: =
Bounding set =
```

差别是功能性的，不是装饰性的。带默认 capability 时 root 无视文件 mode；丢掉之后，同一个 root 进程也会被拒：

```console
$ docker run --rm alpine:3.21 sh -c 'printf secret > /f; chmod 0000 /f; cat /f'
secret
$ docker run --rm --cap-drop=ALL alpine:3.21 sh -c 'printf secret > /f; chmod 0000 /f; cat /f'
cat: can't open '/f': Permission denied
```

大多数服务需要*零个* capability。只有当你能说清为什么时，才加回一个：

```console
$ docker run --rm --cap-drop=ALL --cap-add=NET_BIND_SERVICE alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -1'
Current: cap_net_bind_service=ep
```

### `--security-opt no-new-privileges`：堵住 setuid 提权

丢掉 capability，并不能阻止镜像里一个 setuid-root 的二进制在 `exec` 时把它们*重新拿回来*。`no-new-privileges` 能。你能亲眼看到内核的那一位翻转：

```console
$ docker run --rm alpine:3.21 grep NoNewPrivs /proc/self/status
NoNewPrivs:     0
$ docker run --rm --security-opt no-new-privileges alpine:3.21 grep NoNewPrivs /proc/self/status
NoNewPrivs:     1
```

而且它会改变行为。这里让一个非特权用户运行 setuid-root 的 Perl；不加这个参数它以 root 执行，加了之后提权被静静拒绝：

```console
$ docker run --rm debian:stable sh -c 'chmod u+s /usr/bin/perl;
    setpriv --reuid=1000 --regid=1000 --clear-groups perl -e "printf qq(euid=%d real=%d\n), \$>, \$<"'
euid=0 real=1000
$ docker run --rm --security-opt no-new-privileges debian:stable sh -c 'chmod u+s /usr/bin/perl;
    setpriv --reuid=1000 --regid=1000 --clear-groups perl -e "printf qq(euid=%d real=%d\n), \$>, \$<"'
euid=1000 real=1000
```

除非某样东西真的需要 setuid，否则给每个容器都加上它，包括你自己的 Compose 服务。

### `--read-only` 与 `--tmpfs`：把根文件系统变成只读

如果应用连自己的镜像都写不进去，那么落进容器里的攻击者也就无法通过改二进制或改配置来持久化。

```console
$ docker run --rm --read-only alpine:3.21 touch /evidence
touch: /evidence: Read-only file system
$ docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --tmpfs /run alpine:3.21 \
    sh -c 'touch /tmp/ok && ls -l /tmp/ok; mount | grep " /tmp "'
-rw-r--r--    1 root     root             0 Oct 12 09:10 /tmp/ok
tmpfs on /tmp type tmpfs (rw,nosuid,nodev,noexec,relatime,size=16384k,inode64,huge=advise)
```

模式就是：根文件系统只读，再加几个随容器一起消失的可写 `tmpfs` 挂载点。这些挂载点上的 `noexec,nosuid` 意味着丢进来的文件无法被执行，也无法用来提权。这是[systemd 加固](/zh/posts/systemd-hardening/)里只读文件系统那套做法的容器版本——同样的思路，在那里落成 `ProtectSystem=strict` 和 `ReadWritePaths=`。

### seccomp 与 AppArmor：系统调用层和 MAC 层

默认 seccomp 配置是地板，不是天花板。如果你清楚自己的二进制需要哪些系统调用，一份自定义配置能把"哪些系统调用存在"收窄到那张清单。`seccomp=unconfined` 只应是你调试时用、随后删掉的一步。在带 AppArmor 的主机上，`apparmor=unconfined` 会关掉默认开启的整整一层强制访问控制。它们都不能替代上面的参数，只是额外叠加的过滤器。

### 资源限制：`--memory`、`--cpus`、`--pids-limit`

隔离的一部分，是不让某个租户把整台机器拖垮。内存上限由 cgroup v2 强制执行，容器里也看得见：

```console
$ docker run --rm --memory=32m alpine:3.21 cat /sys/fs/cgroup/memory.max
33554432
$ docker run --rm alpine:3.21 cat /sys/fs/cgroup/memory.max
max
```

一旦超限，内核就杀掉进程，Docker 把它表现为一次 OOM kill：

```console
$ docker run -d --memory=32m python:3.12-slim python3 -c 'bytearray(200*1024*1024)'
$ docker inspect --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' <id>
OOMKilled=true ExitCode=137
```

再配上 `--pids-limit`（防 fork 炸弹）和 `--cpus`；在 cgroup v2 上它们是同一套机制。

## Docker socket 就是 root：docker.sock 陷阱

现在说那个能把上面一切努力清零的失误。把 `/var/run/docker.sock` 挂进容器，并不是"给了一点点 Docker 访问权限"。那个 socket *就是* Docker API，而 API 能创建容器——包括一个挂载了宿主机文件系统的容器。谁拿着这个 socket，谁就在宿主机上等于 root，这是结构决定的。在这台机器上：

```console
$ ls -l /var/run/docker.sock
srw-rw---- 1 root docker 0 Oct 12 04:12 /var/run/docker.sock
```

`docker` 组成员能读写它，所以 `docker` 组身份等价于 root——你把这个 socket 交给的任何容器同样如此。看一个只带着 socket 的容器，用标准库就连上了宿主机守护进程：

```python
import socket, http.client
class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")
c = UnixHTTP("localhost")
c.request("GET", "/containers/json?all=1")
print(c.getresponse().read().decode())
```

```console
$ docker run --rm -v /var/run/docker.sock:/var/run/docker.sock python:3.12-slim python3 demo.py
status 200 ApiVersion 1.56 Engine 29.9.0
  python:3.12-slim | /modest_lederberg
  postgres:17-alpine | /mq-pg
  nginx:1.27-alpine | /compose-cookbook-web-1
  ...
  total containers visible: 14
```

这个容器现在还能再创建一个挂载宿主机 `/` 的容器，以 root 运行，读到第一个容器永远碰不到的文件：

```console
POST /containers/create?name=sockpwn  ->  201 {"Id":"f6fe176b8cb7..."}
start  ->  204
--- id inside the new container ---
uid=0(root) gid=0(root) groups=0(root),...
--- host /etc/shadow, seen from the container ---
root:root 600 /host/etc/shadow
36
DELETE /containers/sockpwn?force=1  ->  204
```

那个 `600 root:root` 的文件，正是你以为存在的那道边界，而 socket 直接走了过去。规则说起来很简单：永远不要把 Docker socket 绑进不可信容器；如果某个服务必须响应 Docker 事件，就把它放到带端点白名单的 `tecnativa/docker-socket-proxy`（或等价物）后面；把每一个 `docker` 组成员都当成 root 账号。唯一该看到这个 socket 的容器，是一个只跑白名单代理、别的什么都不干的专用容器。

## rootless 容器：把 root 从守护进程里拿掉

上面每个参数都在缩小容器，而守护进程和它的 socket 仍然以 root 运行。**rootless 容器**从源头去掉这个前提：守护进程以非特权用户运行，借助用户命名空间，以及 rootlesskit 配 slirp4netns/pasta 之类的网络方案。这样一来，守护进程的漏洞就是*你自己用户*的漏洞，而不是 root 的；socket 也放在 `$XDG_RUNTIME_DIR` 下，而不是 `/var/run`。

```console
$ docker info --format '{{json .SecurityOptions}}'
["name=seccomp,profile=builtin","name=cgroupns"]
```

这台主机是 rootful 的——没有 `rootless` 这一项。在 rootless 安装上，这里会看到 `name=rootless`，守护进程的 `Root Dir` 也会落在 `~/.local/share/docker` 下。rootless 会付出一点代价（有时是 `overlayfs`、低端口绑定、某些网络模式），但它是可用的最强单点改动，因为它恰好移除了 docker.sock 陷阱交出去的那个东西。如果容器是你的主力运行时，它该排在任何单容器参数*之前*。

## 供应链：镜像来源、digest 与最小基础镜像

以上一切都假设镜像是诚实的。三条供应链习惯值得养成。

- **按 digest 固定，而不是只按 tag。** tag 是会动的。`alpine:3.21` 今天就解析到了这个 digest：

  ```console
  $ docker image inspect alpine:3.21 --format '{{index .RepoDigests 0}}'
  alpine@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
  ```

  `FROM alpine:3.21` 可能悄悄变成别的东西；`FROM alpine@sha256:48b0...` 不会。

- **知道是谁构建的、里面有什么。** 优先官方或已认证的发布者，部署前扫 CVE（`docker scout`、`trivy`、`grype`），并定期重建，好让基础镜像的补丁真正落到你这里。

- **从最小开始。** 攻击面与已安装包的数量成正比，因为每一个包都是一个额外的 setuid 二进制或库：

  ```console
  alpine:3.21         12.2MB
  nginx:1.27-alpine   74.5MB
  python:3.12-slim     190MB
  debian:stable        187MB
  golang:1.27-alpine   381MB
  ```

  再查一下镜像的默认用户——`User` 为空就意味着 root：

  ```console
  $ docker image inspect alpine:3.21 --format 'User={{.Config.User}}'
  User=
  $ docker image inspect nginx:1.27-alpine --format 'User={{.Config.User}}'
  User=
  ```

  这两个都算"最小"镜像，但两者默认仍是 root，所以 `--user`/`USER` 依然是你自己的活儿。

## 一份站得住脚的容器安全清单

默认值是起点，不是策略。我实际会按这个顺序来：

1. `--user` / `USER`——用非 root uid 运行。镜像不配合，就修镜像。
2. `--cap-drop=ALL`，再用 `--cap-add` 只加回你能说清理由的项。大多数服务一个都不需要。
3. `--security-opt no-new-privileges`——每个容器，永远都加。
4. `--read-only` 加上 `--tmpfs`，只为那几个必须可写的路径（`noexec,nosuid`）。
5. 保留默认 seccomp 配置，或更严格的自定义配置；绝不上线 `seccomp=unconfined` 或 `apparmor=unconfined`。
6. `--memory`、`--cpus`、`--pids-limit`——给爆炸半径设个上限。
7. 除一个带端点白名单的加固代理外，任何容器都不要挂 Docker socket；把 `docker` 组当成 root。
8. 工作负载允许时，优先用 rootless 容器。
9. 按 digest 固定镜像，从最小基础镜像起步，定期扫描并重建。
10. 加固宿主机本身——容器和你共享它的内核。见[加固一台公网服务器](/zh/posts/hardening-a-public-server/)。

这些都不会把容器变成虚拟机，也不是为了这个。目标是：让内核已有的检查保持开启，丢掉没人要过的特权，并确保那唯一握着钥匙的进程——Docker socket——永远不会交给你不掌控的代码。做到这些，容器就是一道真正有用的边界；做不到，你拥有的就是一个盖子朝外开、里面装着 root 的盒子。
