---
title: "containerd 与 Docker：真正干活的到底是谁"
description: "Docker 到底和 containerd 是什么关系？用这台 Arch 机器上真实的 docker version、docker info、ps 和 runc 输出说话：谁真正启动容器、runc 这个 OCI 运行时在底层做了什么、Docker 又加了什么，以及为什么你大概率不该把它换掉。"
pubDate: 2027-01-16
lang: zh
translationKey: containerd-vs-docker
tags: [devops]
featured: false
keywords:
  - containerd
  - runc
  - Docker vs containerd
  - OCI 运行时
  - nerdctl
---

每隔几个月就有人问我：要不要"把 Docker 换成 containerd"？言下之意好像它们是两个功能重叠的竞品，一场 **Docker vs containerd** 的对决，总得分出个胜负。我已经不凭记忆回答这种问题了，我直接 `ps aux`。就比如我写这篇文章的这台机器——Arch Linux、内核 7.2.9、Docker 29.9.0——**containerd v2.4.1** 在跑，**runc 1.5.2** 装着，Docker 也在，因为 Docker 从来没有"取代"containerd：它是*架在*containerd 上面的。故事继续往下走——**runc**，这个真正发起系统调用的 **OCI 运行时**，才是 Docker 和 Kubernetes 最后都会调用的东西。一旦你看清了这些层，"Docker vs containerd" 就不再是对立关系，而是一套管路。

下面所有输出都来自这台机器——没有 `sudo`，没有 `--privileged`，我启动的每个容器在写完时都已销毁。哪些我没能跑起来，我会明说。

## 一张图看懂整个分层栈

容器不是一个程序，而是五层结构，每层把活儿往下交。你日常打交道的命令行，只是大多数人唯一见过的那一层：

<figure>
<svg viewBox="0 0 720 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="自顶向下的分层栈：docker 命令行与 buildx 和 compose、dockerd 守护进程、containerd、作为 OCI 运行时的 runc，以及提供命名空间、cgroups 和 overlayfs 的 Linux 内核。">
  <defs>
    <marker id="ar" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="60" y="16" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="44" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">docker 命令行 · buildx · compose</text>
  <line x1="250" y1="62" x2="250" y2="84" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="78" font-size="10" fill="#0f766e">HTTP/JSON · /var/run/docker.sock</text>
  <rect x="60" y="88" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="116" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">dockerd</text>
  <line x1="250" y1="134" x2="250" y2="156" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="150" font-size="10" fill="#0f766e">gRPC · /run/containerd/containerd.sock</text>
  <rect x="60" y="160" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="188" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">containerd</text>
  <line x1="250" y1="206" x2="250" y2="228" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="222" font-size="10" fill="#0f766e">拉起 containerd-shim-runc-v2</text>
  <rect x="60" y="232" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="260" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">runc</text>
  <line x1="250" y1="278" x2="250" y2="300" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="294" font-size="10" fill="#0f766e">创建并启动 init 进程</text>
  <rect x="60" y="304" width="380" height="46" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="250" y="332" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">Linux 内核</text>
  <text x="470" y="332" font-size="10" fill="#0f766e">命名空间 · cgroups · overlayfs</text>
</svg>
<figcaption>这台机器上真实存在的完整分层栈。只有最上面那个盒子是大多数人说的"Docker"；最下面三个盒子才是 Docker 和 Kubernetes 共用的部分。</figcaption>
</figure>

有两点要记住：你敲的 `docker` 是个*客户端*，它下面每一层都通过 Unix socket 说着不同的协议。

## 这台机器上到底装了什么：`docker version`

想证明"Docker 里包含着 containerd"，最快的办法就是问 Docker 自己：

```console
$ docker version
Client:
 Version:           29.9.0
 API version:       1.56
 Go version:        go1.27.1-X:nodwarf5
 Git commit:        f415da838b
 Built:             Fri Oct  9 00:19:20 2026
 OS/Arch:           linux/amd64
 Context:           default

Server:
 Engine:
  Version:          29.9.0
  API version:      1.56 (minimum version 1.40)
 containerd:
  Version:          v2.4.1
  GitCommit:        f2551031d7276a770f65f98c9b52e57e7dad07e8.m
 runc:
  Version:          1.5.2
 docker-init:
  Version:          0.19.0
```

仔细读 server 那半段。客户端是 29.9.0，Engine——也就是守护进程 `dockerd`——也是 29.9.0；但注意它把活儿派给了谁：`containerd v2.4.1`、`runc 1.5.2`、`docker-init 0.19.0`（一个加固版 `tini`，唯一职责就是当一个守规矩的 PID 1：回收僵尸进程、转发信号）。它们不是附带打包的依赖，它们是真正干活的部分。

客户端和 server 是打包在一起的两个程序：客户端只负责通过 `/var/run/docker.sock` 说 HTTP，剩下全归 server。所以你可以在容器里、在 CI 里、在另一台机器上驱动一个守护进程——也正因如此，socket 的访问权限是一条安全边界，这一点我在[容器安全实践](/zh/posts/container-security/)里写过。

## 在 `ps aux` 里看 Docker vs containerd

接下来这一屏通常能直接终结争论。在这台机器上，`containerd` 作为独立服务运行，而 `dockerd` 被指向了它：

```console
$ ps aux | grep -E 'containerd|dockerd' | grep -v grep
root      147850  1.7  0.3 2047448  48084 ?       Ssl  Oct12  15:36 /usr/bin/containerd
root      147879  0.4  0.7 2115664  89156 ?       Ssl  Oct12   4:22 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
```

这一个参数就是全部关系：`dockerd` 启动时*指向*了已存在的 containerd——它没有自己另起一个，而是连了上去。下面是各容器的 shim，五个运行中的容器，五个 shim：

```console
$ ps aux | grep containerd-shim | grep -v grep
root 605897 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id a98048d4dcd0941e50f66dd421b8a00e12e610321c27393f54547f4517e5e651 -address /run/containerd/containerd.sock
root 606458 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 680910beb06c0192fda511b7aa91a8a7788d9398c9667a57031a297d2b68638b -address /run/containerd/containerd.sock
root 970577 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 3d994363756589deb76c6bc8837b8839e8648f58699b59a9ca0c8fc27eb787ea -address /run/containerd/containerd.sock
root 971592 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 200df4ce0d236f1020a2ad4499e0d6b67217412eb68db96174ee125fe16ed6fb -address /run/containerd/containerd.sock
root 972001 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 6bcecf7782771f033093a99b9c30be889764f29574d3cc06f8a0f969a983bf5d -address /run/containerd/containerd.sock
```

三个细节解释了"容器是谁的"这件事：

- `-namespace moby`——从 containerd 的视角看，Docker 的容器不过是它 `moby` 命名空间里的普通容器。（Kubernetes 用的是 `k8s.io`。）"Docker 容器就是 containerd 容器"这句话正是这么来的。
- 每个容器一个 shim：它接管容器的标准输入输出，比守护进程活得久，`docker logs` 能工作靠的就是它。
- 每个 shim 的父进程是 PID 1 而不是 containerd——这是故意的，升级 containerd 不会连累容器。

`docker info` 从另一侧讲同一个故事，还顺手说明 Docker 的镜像存储已经*搬进了* containerd：

```console
$ docker info
Server:
 Server Version: 29.9.0
 Storage Driver: overlayfs
  driver-type: io.containerd.snapshotter.v1
 Logging Driver: json-file
 Cgroup Driver: systemd
 Cgroup Version: 2
 Runtimes: io.containerd.runc.v2 runc
 Default Runtime: runc
 Init Binary: docker-init
 containerd version: f2551031d7276a770f65f98c9b52e57e7dad07e8.m
 Security Options:
  seccomp
   Profile: builtin
  cgroupns
 Kernel Version: 7.2.9-arch1-1
 Operating System: Arch Linux
```

`Default Runtime: runc` 回答了"这里到底是谁在跑容器"——`runc` 这个 OCI 运行时，不管请求来自 Docker 还是直接来自 containerd。而 `io.containerd.snapshotter.v1` 意味着 Docker 的镜像层是由 containerd 的 snapshotter 解包和挂载的。（分层本身我在[Docker 网络详解](/zh/posts/docker-networking/)里聊过。）

## 跟着一个容器一路下沉到内核

一路追到底。挑一个正在运行的 nginx，从它的进程*往上*走到 shim：

```console
$ CPID=$(docker inspect -f '{{.State.Pid}}' 680910beb06c)   # nginx 容器
$ ps -o pid,ppid,cmd -p $CPID
  PID   PPID  CMD
606482 606458 nginx: master process nginx -g daemon off;

$ ps -o pid,ppid,cmd -p 606458
  PID   PPID  CMD
606458      1 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 680910beb06c0192fda511b7... -address /run/containerd/containerd.sock

$ cat /proc/$CPID/cgroup
0::/system.slice/docker-680910beb06c0192fda511b7aa91a8a7788d9398c9667a57031a297d2b68638b.scope
```

图景是这样的：containerd 拉起了 shim，shim 监管着容器的 init 进程，而内核把这个进程放进了一个叫 `docker-<id>.scope` 的 cgroup。注意缺了什么：`dockerd`——容器一旦跑起来，守护进程压根不在它的进程谱系里；dockerd 停了，这个 nginx 照常服务。`runc` 也不在：它只在创建时跑一次就退出。init 是长命的，造出它的运行时却是短命的。

再看内核在进程周边搭的东西，从一个我专为此启动的容器里头看：

```console
$ docker run -d --name ns-demo alpine sh -c 'sleep 60'
$ docker exec ns-demo sh -c 'ls -l /proc/1/ns/'
lrwxrwxrwx cgroup -> cgroup:[4026533017]
lrwxrwxrwx ipc    -> ipc:[4026533015]
lrwxrwxrwx mnt    -> mnt:[4026533012]
lrwxrwxrwx net    -> net:[4026533018]
lrwxrwxrwx pid    -> pid:[4026533016]
lrwxrwxrwx pid_for_children -> pid:[4026533016]
lrwxrwxrwx time   -> time:[4026533179]
lrwxrwxrwx time_for_children -> time:[4026533179]
lrwxrwxrwx user   -> user:[4026531837]
lrwxrwxrwx uts    -> uts:[4026533014]

$ docker exec ns-demo sh -c 'cat /proc/1/cgroup; ps aux'
0::/
PID   USER     TIME  COMMAND
    1 root      0:00 sleep 60
```

八个不同的命名空间 ID；一个以为自己是 PID 1、PID 命名空间里别无他进程的进程；一个根植于 `/` 的 cgroup 视图。`sleep 60` 就是"容器"。根文件系统同样说明问题：

```console
$ docker exec ns-demo mount | head -2
overlay on / type overlay (rw,relatime,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2682/fs:/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/981/fs,upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2683/fs,workdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2683/work,index=off)
proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)
```

`docker info` 说 "Docker Root Dir: /var/lib/docker"，但容器真正看到的合并视图来自 `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/...`。同一个内核特性——overlayfs——安装、挂载、归属都是 containerd。这一个目录名就是本文的全部论点。

## containerd 是什么，Kubernetes 为什么也在用

**containerd** 是一个 CNCF 毕业项目，一个把容器里那些无聊活儿干好的守护进程：拉取和校验镜像、存储镜像、把它们解包进 snapshotter，以及通过 runtime shim 启动、停止和监管容器。它在 2017 年从 Docker 中析出。它不是 Docker 的竞品，而是 Docker 自己也在用的组件；从 dockershim 在 1.20 被弃用、1.24 被移除开始，Kubernetes 也直接和它对话——kubelet 通过 socket 对它说 CRI，和 dockerd 做的完全一样。

值得偷师的设计是 shim：每个容器一个独立进程，且被 reparent 到 init，于是 containerd 可以随意升级而不伤及任何容器。守护进程来了又走，负载照常运行——这才是无论你敲 `docker run` 还是 `kubectl apply`，背后都是这两个守护进程的原因。

## Docker 在上面加了什么

Docker 还剩什么？所有与"跑容器"无关的东西：

```console
$ docker --version
Docker version 29.9.0, build f415da838b
$ docker buildx version
github.com/docker/buildx 0.38.0 0dbe87f36ed472fe36b6796c3f70b4210a731fc5
$ docker compose version
Docker Compose version 5.6.0
```

具体说，在"拉镜像、跑容器"之上：

- **不止 `run` 的命令行**——`docker build` 走 BuildKit，有正经的分层缓存；`docker compose` 把三个参数加一个网络收进一个 YAML 文件；再加上 `volume`、`network` 等等。
- **REST API。** `/var/run/docker.sock` 是一份文档化的 HTTP API；每个 CI 系统、IDE 插件、家庭实验室面板对接的都是*它*，不是 containerd 的 gRPC API。
- **生态。** Docker Hub、官方镜像、插件，以及全世界教程都默认 `docker` 存在这个事实。这些没一样是技术，全是协同。
- **runc 之外的稳妥默认值。** seccomp profile、cgroup 命名空间、capability 集合、`--init`——我[之前](/zh/posts/container-security/)写过的整套安全模型，被打包和维护好。

这些没有一样是 OCI 意义上的"容器运行时"特性。Docker 管前面，containerd 管中间，runc 管底下；内核悄悄管着一切。

## 为什么 OCI 规范很重要

这套分层栈之所以能随意拼装，靠的是 **OCI**（Open Container Initiative，开放容器倡议）的规范，其中两个最要紧：

1. **镜像规范**——一个分层 tar 包加一份 JSON manifest。containerd 能拉的任何 OCI 镜像 Docker 都能读，反之亦然。这不是营销话术，是规范。
2. **运行时规范**——一份描述*怎么跑*一个镜像的 JSON 文档：用哪些命名空间、挂哪些文件系统、给哪些 capability、设哪些 rlimit。这就是 containerd 与 runc 之间的接口。

第二份规范可以用本机的 runc 直接生成一份默认的看看：

```console
$ runc spec && head -c 700 config.json
{
	"ociVersion": "1.3.0",
	"process": {
		"terminal": true,
		"user": { "uid": 0, "gid": 0 },
		"args": [ "sh" ],
		"capabilities": {
			"bounding": [ "CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE" ],
			...
		},
		"root": { "path": "rootfs", "readonly": true },
		...
	}
```

再往下一点，就是 `ns-demo` 里那堆命名空间的出处：

```json
		"namespaces": [
			{ "type": "pid" },
			{ "type": "network" },
			{ "type": "ipc" },
			{ "type": "uts" },
			{ "type": "mount" },
			{ "type": "cgroup" }
		],
		"maskedPaths": [ "/proc/acpi", "/proc/sysrq_trigger", ... ],
		"readonlyPaths": [ "/proc/bus", "/proc/irq", "/proc/sys", ... ]
```

`runc --version` 甚至会声明它实现的规范版本——我这份报告 `spec: 1.3.0`。这就是镜像层和运行时层都没有锁定效应的原因：规范就是契约。

## `ctr`、`nerdctl`，以及我没跑成功的部分

下面的层可以直接手动使用——它们带 CLI，意义正在于此。`ctr` 是 containerd 的官方客户端，在这台机器上装着，版本与守护进程一致（v2.4.1）。但以我这个非特权用户去连：

```console
$ ctr namespaces list
time="2026-10-13T07:44:54+08:00" level=warning msg="Failed to check deprecations" error="connection error: desc = \"transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied\""
ctr: rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied"
```

权限拒绝，意料之中：socket 是 `root:root 660`，而我是 uid 1000。至于 nerdctl——大家说"containerd 配个好用的 CLI"时指的就是它——这台机器上根本没装。

我特意**没有**做的事：把 `/run/containerd/containerd.sock` 挂进容器，好让 `ctr` 连上真正的守护进程。这里的容器是实打实的 root（没有 user-namespace 重映射），所以这个操作不算"访问 containerd"——等同于把宿主机完整 root 交给任何能读这个 socket 的东西。想给 `ctr`/`nerdctl` 找练手场地，用一次性虚拟机或者 rootless 环境，别打工作机守护进程的主意。

## 你大概率不需要替换掉 Docker

如果 Docker 用得顺手，那就继续用。这次交换给你的东西是"进程更少、离 runc 更近一层"，账单却立刻到来——compose 文件、容器 DNS、日志驱动、团队对 `docker` 的肌肉记忆。遇到这些情况再考虑动身：

- **你已经在跑 Kubernetes。** 那 containerd 就在你脚底下，不管你乐不乐意；`ctr`/`crictl` 是排障素养，不是迁移项目。
- **你需要 rootless 或边缘部署。** rootless Docker 能用，但小机器上 rootless nerdctl + containerd 往往更顺。
- **你想要的是没有守护进程的运行时**——"加载一个 OCI 镜像，跑起来"，不要 API server。那 containerd + nerdctl 是更薄的一叠。
- **你只是好奇。** 可以——但在虚拟机上折腾，别在跑着数据库的机器上。

值得带走的习惯只有一个：容器出问题时，别停在 `docker logs`。`ps aux | grep containerd-shim`、`cat /proc/$(docker inspect -f '{{.State.Pid}}' <id>)/cgroup`，再 `docker exec` 看一眼命名空间，比任何仪表盘都更能说明问题——而你现在知道，这三条命令看的正是同一台机器的不同层。
