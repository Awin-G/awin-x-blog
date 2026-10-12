---
title: "systemd socket 激活：在第一个连接时才启动服务，而非开机"
description: "把 systemd socket 激活讲透：由 systemd 持有监听 socket（ListenStream），在第一个连接到来时才启动服务，并通过 sd_listen_fds 把 fd 传给它。全部是 systemctl --user 的真实输出，含 .socket/.service 配对、systemd-socket-activate 演示，以及诚实的取舍。"
pubDate: 2027-01-10
lang: zh
translationKey: systemd-socket-activation
tags: [systemd, linux]
featured: false
keywords:
  - systemd socket 激活
  - ListenStream
  - sd_listen_fds
  - .socket unit
  - LISTEN_FDS
---

我跑的大多数服务都是常开的：它们 `socket()`、`bind()`、`listen()`，然后就干等——哪怕一天只来两次请求，也一直占着一个端口、一个常驻内存里的进程。**systemd socket 激活**把这套翻了过来：监听 socket 归 systemd 所有，端口由它打开，而你的服务可以彻底死着，直到第一个连接到来——那一刻 systemd 才启动服务，并把那个已经打开的 fd 交给它。服务从不调用 `bind()`，它只是在系统递给它的一个 `ListenStream` fd 上 accept。下面我在 `systemctl --user` 下（无需 root）真正搭一个 socket 激活的服务，看着一个连接把它从 `inactive (dead)` 拉起来，再把它停掉、看着 listener 活下来，最后用 `systemd-socket-activate` 把同样的事再来一遍。所有输出都是这台机器（systemd 262）上的真实结果。

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="服务 inactive 时，systemd 已在 18765 端口持有监听 socket。当客户端发起第一个连接，systemd 启动 demo-echo.service，并把监听 fd 作为 fd 3 传给它，程序便在该 fd 上 accept。" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="sock-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/></marker>
  </defs>
  <rect x="14" y="66" width="210" height="130" rx="12" fill="none" stroke="#0f766e" stroke-width="2.5"/>
  <g text-anchor="middle" font-family="system-ui, sans-serif">
    <text x="119" y="92" fill="#0f766e" font-weight="700" font-size="15">systemd</text>
    <text x="119" y="114" fill="#0f766e" font-size="11">持有 socket，尚未起服务</text>
    <text x="119" y="146" fill="currentColor" font-family="monospace" font-size="13">:18765 LISTEN</text>
    <text x="119" y="170" fill="currentColor" font-family="monospace" font-size="11" opacity="0.75">fd 3 由管理器持有</text>
  </g>
  <g stroke="#0f766e" fill="none" stroke-width="2" marker-end="url(#sock-arrow)">
    <path d="M224 131 H274"/>
  </g>
  <text x="249" y="119" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">首个连接</text>
  <text x="332" y="136" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="12">拉起服务</text>
  <g stroke="#0f766e" fill="none" stroke-width="2" marker-end="url(#sock-arrow)">
    <path d="M392 131 H442"/>
  </g>
  <text x="417" y="119" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">传 fd 3</text>
  <rect x="446" y="66" width="180" height="130" rx="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7" stroke-dasharray="6 5"/>
  <g text-anchor="middle" font-family="system-ui, sans-serif">
    <text x="536" y="92" fill="currentColor" font-weight="700" font-size="14">demo-echo.service</text>
    <text x="536" y="114" fill="currentColor" font-size="11">连接前一直 inactive</text>
    <text x="536" y="146" fill="currentColor" font-family="monospace" font-size="12">accept() on fd 3</text>
    <text x="536" y="170" fill="#0f766e" font-family="monospace" font-size="11">LISTEN_FDS=1</text>
  </g>
</svg>
<figcaption>端口由管理器用自己持有的描述符一直开着；服务按需拉起，并通过 <code>LISTEN_FDS</code> / <code>sd_listen_fds()</code> 被告知该在哪个 fd 上 accept。</figcaption>
</figure>

## systemd socket 激活到底是什么

正常情况下，*提供服务的进程*也正是*占端口的进程*：它创建 socket、绑到地址端口、调用 `listen()`，然后 accept。**systemd socket 激活**把前三步从你的程序里搬进 systemd。`.socket` unit 持有一条 `ListenStream=`（一个 TCP 端口、一个 UNIX socket 路径等等）；systemd 打开它并一直保持。你程序的 `.service` 开机并不启动——它会一直停在 `inactive (dead)`、`MainPID` 为 0，没有进程、没有常驻内存。第一次有客户端连接时，systemd 察觉到流量，启动服务，把那个正在监听的 fd 递过去。

第一次让我吃惊的是：端口其实*始终*开着。socket 活在管理器里，不在你的服务里，所以它能挺过服务的死亡与任何重启。服务只是按需挂上去——它不是代理也不是包装；你的进程在一个真正的 socket 上 accept，就像它自己创建了这个 socket 一样。

## 它好在哪（又在什么时候只是噪音）

我会反复用它的四个理由：

- **没有常驻守护进程。** 罕用的服务可以常驻内存为零，直到有人来访问。在这台机器上，服务是 `inactive (dead)`、`MainPID 0`，而端口仍在应答。
- **重启而不丢 listener。** 因为 socket 归管理器持有，你可以停、升级、重启服务，进来的连接只是排在 backlog 里，而不是被 `connection refused`。下文有演示。
- **权限分离。** 对系统服务来说，管理器（常是 root）可以持有低端口，服务则能以无特权的 `User=` 运行、依旧在它继承来的 fd 上 accept——“端口在管理器里监 443，应用以 `nobody` 跑。”
- **并行启动。** socket 很廉价，所以 systemd 可以先把它们全部打开，再按需并行地启动真正的服务，而不是串行地等每个守护进程 bind。

诚实的代价是**多了一层间接**。你的程序没打开自己的 socket，所以“哪个进程 `bind()` 了、它起没起”这种本能反应，不再指向你的服务。而且它只在你的程序配合时才有用：程序必须会用继承来的 fd。一个硬编码了自己 `socket()/bind()/listen()` 的服务会无视传进来的 fd 并 bind 失败，因为端口已经被管理器占着。如果服务是 7×24 高负载、必须随时热着，或者根本接不了继承来的 fd，那 socket 激活对你毫无好处，只会多一个 `.socket` 文件、多一层要想的东西。

## `.socket` unit 与它的 `.service` 配对

socket 激活是一对：一个 `.socket` unit 说*在哪儿监听*，一个同名的 `.service` unit 说*跑什么*。不显式指定时，`demo-echo.socket` 触发 `demo-echo.service`。下面是我那两个文件，逐字来自临时目录：

```ini
# demo-echo.socket
[Unit]
Description=Scratch echo socket (systemd owns this listener)

[Socket]
ListenStream=127.0.0.1:18765
# Accept= is left unset -> defaults to false -> ONE service instance that
# receives the listening fd as fd 3 and accepts connections itself.
# (Accept=yes would instead fork a per-connection unit, inetd-style, fd 0.)

[Install]
WantedBy=sockets.target
```

```ini
# demo-echo.service
[Unit]
Description=Echo listener started on first connection by demo-echo.socket

[Service]
Type=exec
ExecStart=/tmp/opencode/work/socket-activation/listener
Restart=on-failure
StandardOutput=journal
StandardError=journal
```

真正承重的两条指令：

- **`ListenStream=`** 是 systemd 打开的地址。`127.0.0.1:18765` 是 TCP 监听；一个裸路径（如 `/run/foo.sock`）是 UNIX socket；一个裸 `18765` 会在所有网卡上绑 IPv4+IPv6。可重复写来开多个 socket；同类还有 `ListenDatagram=`（UDP）和 `ListenSequentialPacket=`。
- **`Accept=`** 选择激活模型。默认 `Accept=no` 只启动**一个**实例，把*监听* fd（fd 3）交给它去跑 accept 循环，像 nginx。`Accept=yes` 是 inetd 模型：systemd 自己 accept 每个连接，然后 fork 一个模板服务（通常是 `@.service`）的**每连接**实例，把已连接的 socket 作为 fd 0（stdin）传入。一个常驻 accept 循环，还是每连接一个进程——想清楚再选。

注意 service 从头到尾没提 socket 一嘴。这正是它的优雅之处：程序不关心 socket 是谁开的，所以同一个二进制稍后在 `systemd-socket-activate` 下也能跑。

## 程序如何拿到 fd：`sd_listen_fds`、`LISTEN_FDS`、fd 3

systemd 启动一个 `Accept=no` 的服务时，在 `exec()` 之前做三件事：把监听 socket 复制进进程的 **fd 3**，并设置两个环境变量——`LISTEN_FDS`（传了几个 fd）和 `LISTEN_PID`（传给*谁*的 pid，这样 fork 出来的子进程就不能偷偷复用它们）。规范的读取方式是 libsystemd 的帮手 `sd_listen_fds()`：它校验 `LISTEN_PID == getpid()`、返回数量，并把第一个 fd 放在 `SD_LISTEN_FDS_START`（即 3）。我这个小监听程序会把它收到的都打印出来，好让机制可见：

```c
/* listener.c — a deliberately tiny socket-activated listener.
 *
 * It does NOT create the listening socket. systemd owns it, does the
 * bind()+listen(), and passes the fd to us at startup (fd 3). We read
 * the fd via sd_listen_fds(), accept() on it, and answer with our own
 * PID so the activation is visible. Works identically under
 * `systemctl --user` (fd inherited as fd 3) and `systemd-socket-activate`.
 *
 * Build: gcc -O2 -Wall -o listener listener.c -lsystemd
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <systemd/sd-daemon.h>

int main(void) {
    /* Capture the raw env systemd set, before sd_listen_fds consumes it. */
    const char *raw_fds = getenv("LISTEN_FDS");
    const char *raw_pid = getenv("LISTEN_PID");

    /* unset_env=1: validate LISTEN_PID == getpid() AND unset the vars, so
     * a forked/exec'd child cannot passively reuse a stale fd number. */
    int n = sd_listen_fds(1);
    if (n < 0) { fprintf(stderr, "sd_listen_fds failed: %s\n", strerror(-n)); return 1; }
    if (n != 1) { fprintf(stderr, "expected exactly 1 inherited fd, got %d\n", n); return 1; }

    int fd = SD_LISTEN_FDS_START;   /* == 3, first fd systemd passed us */

    printf("listener up: pid=%d LISTEN_FDS=%s LISTEN_PID=%s "
           "-> sd_listen_fds()=%d listening_fd=%d\n",
           (int)getpid(), raw_fds ? raw_fds : "(unset)",
           raw_pid ? raw_pid : "(unset)", n, fd);
    fflush(stdout);

    signal(SIGPIPE, SIG_IGN);       /* a client hang-up must not kill us */

    for (;;) {
        struct sockaddr_in peer;
        socklen_t plen = sizeof peer;
        int c = accept(fd, (struct sockaddr *)&peer, &plen);
        if (c < 0) { if (errno == EINTR) continue; perror("accept"); continue; }

        char body[256];
        ssize_t r = read(c, body, sizeof body - 1);
        if (r < 0) r = 0;
        body[r] = '\0';
        while (r > 0 && (body[r-1] == '\n' || body[r-1] == '\r')) body[--r] = '\0';
        char out[256];
        int len = snprintf(out, sizeof out,
            "handled by socket activation: pid=%d listening_fd=%d received=\"%s\" (%zd bytes)\n",
            (int)getpid(), fd, body, r);
        (void)write(c, out, (size_t)len);

        printf("accepted %s:%u -> served by pid=%d on inherited_fd=%d received=\"%s\"\n",
               inet_ntoa(peer.sin_addr), (unsigned)ntohs(peer.sin_port),
               (int)getpid(), fd, body);
        fflush(stdout);
        close(c);
    }
    return 0;
}
```

编译用 `gcc -O2 -Wall -o listener listener.c -lsystemd`。关键那几行是：`sd_listen_fds(1)` 解析出唯一的 fd，然后 `accept(fd, …)` 在它上面 accept——我们从不调用 `socket()` 或 `bind()`，因为 listen 早已由 systemd 替我们做了。`sd_listen_fds(1)` 返回 1，就是 fd 完好送达的证据。

## 在 `systemctl --user` 下真实激活

把两个 unit 软链进 `~/.config/systemd/user`，`daemon-reload`，然后启动**socket**——不是服务。服务会一直死着直到客户端出现：

```console
$ systemctl --user enable --now demo-echo.socket
Created symlink '/home/awinx/.config/systemd/user/sockets.target.wants/demo-echo.socket' → '/tmp/opencode/work/socket-activation/demo-echo.socket'.

$ ss -tln | grep 18765
LISTEN 0      4096       127.0.0.1:18765      0.0.0.0:*

$ systemctl --user status demo-echo.socket --no-pager
● demo-echo.socket - Scratch echo socket (systemd owns this listener)
     Active: active (listening) since Tue 2026-10-13 04:23:28 CST
   Triggers: ● demo-echo.service
     Listen: 127.0.0.1:18765 (Stream)

$ systemctl --user status demo-echo.service --no-pager
○ demo-echo.service - Echo listener started on first connection ...
     Active: inactive (dead)
TriggeredBy: ● demo-echo.socket
```

端口在 `LISTEN`、socket unit `active (listening)`，而服务 `inactive (dead)`、没有进程——整个承诺三行讲完。socket 通告 `Triggers: demo-echo.service`，服务报告 `TriggeredBy: demo-echo.socket`，systemd 已经把这一对连上了。

现在连上去，看服务凭空起来：

```console
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18765)); s.sendall(b"first-connection\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=614805 listening_fd=3 received="first-connection" (16 bytes)

$ journalctl --user -u demo-echo.service --no-pager
Starting Echo listener started on first connection by demo-echo.socket...
Started Echo listener started on first connection by demo-echo.socket.
listener up: pid=614805 LISTEN_FDS=1 LISTEN_PID=614805 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:55546 -> served by pid=614805 on inherited_fd=3 received="first-connection"
```

一秒前 `MainPID` 还是 0，日志显示服务以 pid 614805 活了过来。那行启动信息把整个机制一次讲清：systemd 设置了 `LISTEN_FDS=1` 和 `LISTEN_PID=614805`，`sd_listen_fds()` 把它们解析成 `listening_fd=3`——程序 accept 的这个 fd，正是管理器递给它的那个。随后它把这两个变量 unset，好让 fork 出的子进程没法复用陈旧的 fd 号。

## 重启而不丢掉 listener

这是我最看重的那个性质。我只停**服务**，然后看端口是否还开着：

```console
$ systemctl --user stop demo-echo.service
Stopping 'demo-echo.service', but its triggering units are still active:
demo-echo.socket

$ ss -tln | grep 18765
LISTEN 0      4096       127.0.0.1:18765      0.0.0.0:*
$ systemctl --user is-active demo-echo.service
inactive
```

systemd 甚至警告说 socket 仍然 active——`ss` 证实了它：listener 挺过了服务的死亡，所以间隙里连上来的客户端只是排在 backlog 等待，而不是被拒。重连，就有个全新进程在同一端口上被拉起：

```console
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18765)); s.sendall(b"second-connection\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=615413 listening_fd=3 received="second-connection" (17 bytes)

$ journalctl --user -u demo-echo.service --no-pager | grep -E 'listener up|accepted'
listener up: pid=614805 LISTEN_FDS=1 LISTEN_PID=614805 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:55546 -> served by pid=614805 on inherited_fd=3 received="first-connection"
listener up: pid=615413 LISTEN_FDS=1 LISTEN_PID=615413 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:38462 -> served by pid=615413 on inherited_fd=3 received="second-connection"
```

换二进制、停服务、重启——socket 一刻都不眨，下一个连接唤醒一个崭新的进程。这种模型也让 *listener* 层面的零宕期变得微不足道：socket 的生命周期与服务的生命周期解耦了。

拆卸时咬过我的一个后果：一个已经启动的实例会通过 fd 3 持有监听 fd 的副本，所以 `disable` socket **不会**杀掉一个正在运行的服务——端口会一直开到那个实例退出。`ss -tlnp` 甚至在 unit 已经没了之后还显示 `users:(("listener",pid=615413,fd=3))`。激活归激活，清理时记得服务*和* socket 一起清。

## 不写 unit 也能测：`systemd-socket-activate`

不必有 `.socket` unit 也能演练这套机制——`systemd-socket-activate` 一条命令就能绑端口、在第一个连接到来时启动你的程序。我拿同一个二进制指向一个新端口：

```console
$ systemd-socket-activate -l 127.0.0.1:18766 ./listener &
$ python3 -c 'import socket; s=socket.create_connection(("127.0.0.1",18766)); s.sendall(b"via systemd-socket-activate\n"); print("client got:", s.recv(200).decode().strip())'
client got: handled by socket activation: pid=615573 listening_fd=3 received="via systemd-socket-activate" (27 bytes)
```

而 `systemd-socket-activate` 自己的输出把这次 fd 交接讲得很清楚：

```
Listening on 127.0.0.1:18766 as 3.
Communication attempt on fd 3.
Executing: /tmp/opencode/work/socket-activation/listener
listener up: pid=615573 LISTEN_FDS=1 LISTEN_PID=615573 -> sd_listen_fds()=1 listening_fd=3
accepted 127.0.0.1:44704 -> served by pid=615573 on inherited_fd=3 received="via systemd-socket-activate"
```

`as 3` 是它在报告 listener 会成为 fd 3；`Communication attempt on fd 3` 是触发；`Executing: ...` 是拉起。这是在你动 unit 文件之前，验证自己 `sd_listen_fds()` 接线对不对最快的方法——而且因为程序对 socket 来源无感，同一个二进制在这里和真正的 `.socket` 下都能跑。

## 接线之前先校验这对 unit

`systemd-analyze verify` 能抓出文件里看不出来的错。我这对干净的 unit 安静无声：

```console
$ systemd-analyze verify ./demo-echo.socket ./demo-echo.service; echo "exit=$?"
exit=0
```

但它不是橡皮章。`Accept=` 打错字，以及一个 `.socket` 找不到它的 `.service`，都会大声失败：

```console
$ systemd-analyze verify ./broken-accept.socket
broken-accept.socket: Failed to parse Accept=maybe, ignoring: Invalid argument
broken-accept.socket: service broken-accept.service not loaded, socket cannot be started.
```

第二行把配对规则讲清楚了：`.socket` 需要一个可触发的 `.service`，而 verify 会在找不到时直说。`daemon-reload` 之前先跑它。

## 什么时候不值得

给你边界，而不是一把锤子：

- **常热服务。** 如果应用持续有流量，你本来就得让它常驻；socket 激活省不下什么，只添间接。
- **首连延迟。** 空闲之后第一个客户端会在线承担进程启动开销。如果冷启动会击穿 SLO，那就让它热着。
- **必须自己占 socket 的应用。** 用特殊选项做裸 `bind()`、或自己管理 socket 生命周期的软件，可能会和管理器打架。只有程序肯用继承来的 fd，它才有意义。
- **`Accept=no` 期待一个常驻 accept 循环**，所以那种一生一了的 per-connection 场景该用 `Accept=yes`——代价是每连接一次 fork。
- **有状态的推理。** “哪个 pid 持有端口”在 socket 归管理器、服务被反复重启时会变得不好想，就像上文拆卸那样。

至于其它一切——低频的边车、一天用几次的内部工具、想绑特权端口却能以无特权二进制运行的服务——它就是“一个守护进程一直在跑”和“端口在等着被用”之间的区别。

## 说到这儿

一个 socket 激活的服务是三样小而可检查的产物：一个带一条 `ListenStream=` 的 `.socket`、一个 accept 递给它的 fd 的 `.service`，以及一个用 `sd_listen_fds()` 读这个 fd 的程序。socket 归 systemd、按第一个连接启动你、还能让你重启服务而端口不眨。要 unit 文件层面的机制，我的 [systemd unit file 速查](/zh/posts/systemd-unit-cookbook/) 覆盖了 `ExecStart`、`Type` 与校验；而一旦服务按需启动，自然的下一步就是缩小运行进程能碰到的东西，我在 [systemd 加固](/zh/posts/systemd-hardening/) 里做这件事。打开 socket，校验它，然后让连接去启动。
