---
title: "inotify：Linux 是如何告诉你文件变了"
description: "一篇动手实践向的 inotify 指南：真实的 inotifywait 与 inotifywatch 输出、用 Python ctypes 读事件队列，并真实复现一次事件队列溢出。"
pubDate: 2027-02-08
lang: zh
translationKey: linux-inotify-and-file-watching
tags: [linux]
featured: false
keywords:
  - inotify
  - Linux 文件监控
  - inotifywait
  - 文件变更事件
  - max_user_watches
---

总得有人注意到 `/etc/nginx/nginx.conf` 变了。而且你往往正需要这个能力：监视器一旦发现文件变化就重载服务，同步工具在文件落盘的瞬间把它推走，编辑器因为别的进程覆盖了文件而重新读入缓冲区。几十年来最直接的答案是**轮询**——在循环里 stat 每个文件、比较 mtime。它能用、好懂，代价是持续空转 CPU 而换不来任何新信息。2005 年之后，Linux 有了更好的答案：**inotify**，一个在事件发生的瞬间就把**文件变更事件**推给你的内核 API。不用扫描，不用 sleep，没有那几秒钟的延迟。

本文是一次完整的动手实践。下面每个输出块都是从我的 Arch 机器（内核 `7.2.9-arch1-1`、`inotifywait` 4.26.0，都是系统自带的，不需要容器）真实运行后逐字复制的。

## inotify 到底是什么：文件描述符上的监听

心智模型比 API 更重要。inotify 不是一个守护进程，也不是一个需要安装的库——它只是三个系统调用：

1. `inotify_init()`——你拿到**一个文件描述符**。它是一个属于你进程的事件*队列*。
2. `inotify_add_watch(fd, path, mask)`——你告诉内核"盯着这个目录/这个文件，只要这几类事件"。内核返回一个**监听描述符**（watch descriptor，一个整数，相当于这次监听的小句柄）。
3. `read(fd, buf)`——事件以定长的 `struct inotify_event` 记录进入队列：监听描述符、掩码、cookie、名字长度、可选的文件名。你可以像读任何其他 fd 一样读它（也可以 `select()`、`poll()`、`epoll`）。

日常最关心的事件：

| 事件 | 含义 | 值 |
|---|---|---|
| `IN_CREATE` | 被监视目录里出现新条目 | `0x100` |
| `IN_OPEN` | 有东西打开了文件 | `0x20` |
| `IN_MODIFY` | 内容被写入 | `0x2` |
| `IN_ATTRIB` | 元数据变了（chmod、chown、touch） | `0x4` |
| `IN_CLOSE_WRITE` | 写者关闭了文件 | `0x8` |
| `IN_MOVED_FROM` / `IN_MOVED_TO` | 移出 / 移入该目录 | `0x40` / `0x80` |
| `IN_DELETE` | 条目被删除 | `0x200` |

还有一点值得知道：inotify **不改变写入本身的路径**。程序写数据时照样经由 page cache，和以往完全一样——inotify 只是并行地旁观并报告（我在 [Linux page cache 与 mmap](/zh/posts/linux-page-cache-and-mmap/) 里写过这条写入路径）。而且与轮询循环白白让一个核保持温热不同，inotify 空闲时几乎零开销——如果你在追查一个来历不明的 CPU 占用者，看[平均负载那篇](/zh/posts/linux-load-average/)可以帮你区分两者。

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 150" role="img" aria-label="进程添加监听，内核把事件排进 inotify 文件描述符的队列，进程再读出来">
  <rect x="8" y="40" width="120" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="68" y="70" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">你的进程</text>
  <text x="68" y="90" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">inotify fd</text>
  <rect x="260" y="24" width="120" height="102" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="320" y="70" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">内核</text>
  <text x="320" y="90" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.7">fd 队列</text>
  <rect x="512" y="40" width="120" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="572" y="78" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">read()</text>
  <path d="M40 40 L40 20 L268 20 L268 24" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="150" y="16" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">inotify_add_watch(dir)</text>
  <path d="M272 130 L200 130 L200 140 L40 140 L40 110" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="150" y="146" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.7">事件立即入队</text>
  <path d="M380 30 L452 30 L452 60" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="338" y="24" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">poll/epoll</text>
</svg>
<figcaption>inotify 的全部约定：添加监听，内核把事件排到你的 fd 上，你来读。队列是双方唯一的共享状态——它是有界的。</figcaption>
</figure>

## 初体验：用 `inotifywait` 监视文件

经典的用户态工具是 `inotify-tools`。一个终端盯着目录，另一个终端干点寻常的文件操作：

```bash
$ inotifywait -m -q . &          # 持续监视，静默前缀
$ echo "hello" > hello.txt      # 创建 + 首次写入
$ echo "more" >> hello.txt      # 追加
$ cp hello.txt copy.txt         # 复制创建
$ mv hello.txt renamed.txt      # 目录内改名
$ mv renamed.txt ../moved-out.txt   # 移出目录
$ rm copy.txt                   # 删除
```

监视终端逐字打印出的内容：

```
./ CREATE hello.txt
./ OPEN hello.txt
./ MODIFY hello.txt
./ CLOSE_WRITE,CLOSE hello.txt
./ OPEN hello.txt
./ MODIFY hello.txt
./ CLOSE_WRITE,CLOSE hello.txt
./ OPEN hello.txt
./ CREATE copy.txt
./ OPEN copy.txt
./ ACCESS hello.txt
./ MODIFY copy.txt
./ CLOSE_WRITE,CLOSE copy.txt
./ CLOSE_NOWRITE,CLOSE hello.txt
./ MOVED_FROM hello.txt
./ MOVED_TO renamed.txt
./ MOVED_FROM renamed.txt
./ DELETE copy.txt
```

这份真实输出里有三件事值得注意：

- **一次"保存"是一串事件。** 我那次两行追加触发了 `OPEN` → `MODIFY` → `CLOSE_WRITE,CLOSE`。如果你的监视程序对每个事件都响应，它就会跑两次。几乎所有严肃的工具都等 `CLOSE_WRITE` 而不是 `MODIFY`，原因正在于此：`MODIFY` 每个 write 系统调用都发一次，而 `CLOSE_WRITE` 每次保存只发一次。（另外注意 `CLOSE_WRITE,CLOSE`——一条事件带两个掩码位。）
- **目录内改名 = `MOVED_FROM` + `MOVED_TO`。** `mv hello.txt renamed.txt` 在同一个被监视目录里产生的正是这两个事件。`MOVED_TO` 和 `MOVED_FROM` 共享一个 **cookie**，于是监视程序能把它俩配对成"重命名"，而不是"删除 + 创建"。后面那条 Python 输出会更直观：两个事件的 cookie 同为 `629578`。
- **监听跟随目录，不跟随文件。** 当 `renamed.txt` 被移到 `../moved-out.txt`，只监视 `.` 的终端只打印了 `MOVED_FROM renamed.txt`，别无其他——目标目录上没有任何监听。

`inotifywait` 有个好搭档：`inotifywatch` 是**统计**工具——监听、收集事件，最后打印一张汇总表。在被监视目录里创建 300 个文件后结束：

```
$ inotifywatch -t 8 -r bench &
$ seq 1 300 | while read i; do echo x > bench/f$i.txt; done

Establishing watches...
Finished establishing watches, now collecting statistics.
total  modify  close_write  open  create  filename
1200   300     300          300   300     bench/
```

300 次保存恰好 1200 条事件（每次保存 4 条：`create`、`open`、`modify`、`close_write`）——"一次保存顶好几次事件"这个坑，一张表就说明白了。如果你疑惑过为什么一个朴素的 inotify 消费者比你以为的忙四倍，这就是答案。

## inotify 默认不是递归的——所以 `-r` 很重要

内核里 `inotify_add_watch(fd, "/srv/data", mask)` 加的那一条监听只覆盖**这一个 inode**，不覆盖它的子目录。之后创建 `/srv/data/newdir`，内核会照常排入 `IN_CREATE newdir`（因为 `IN_CREATE` 本身包含目录），但 `newdir` 里面发生的一切你都听不到——没有东西在监视它。递归是工具自己实现的：

- `inotifywait -r dir` 在启动时遍历整棵树，给每个目录加一条监听。之后新建的目录呢？`inotifywait -r` 会处理 `IN_CREATE`/`IN_ISDIR` 事件并即时补上监听（另一些工具则默默漏掉）。
- Syncthing、rsync 守护进程、编辑器等等，各自维护自己内存里的监听表。

这种设计的代价落在一个 sysctl 上——见下文。启动时用 `-r` 递归的代价只是每个目录一次 `readdir`，之后归零：

```
$ inotifywait -m -q -r tree &
$ echo a > tree/top.txt
$ echo b > tree/sub/mid.txt           # 先建好的子目录
$ echo c > tree/sub/deep/bottom.txt   # 更深一层

tree/ CREATE top.txt
tree/ OPEN top.txt
tree/ MODIFY top.txt
tree/ CLOSE_WRITE,CLOSE top.txt
tree/sub/ CREATE mid.txt
tree/sub/ OPEN mid.txt
tree/sub/ MODIFY mid.txt
tree/sub/ CLOSE_WRITE,CLOSE mid.txt
tree/sub/deep/ CREATE bottom.txt
tree/sub/deep/ OPEN bottom.txt
tree/sub/deep/ MODIFY bottom.txt
tree/sub/deep/ CLOSE_WRITE,CLOSE bottom.txt
```

同样每次保存一串事件，只是现在前缀带上了子路径。每个被监视目录消耗一条系统级监听——而系统给这个总量设了上限。

## 自己读队列：用 Python ctypes 调用 inotify

跟 inotify 说话不需要任何第三方包。下面这个小脚本直接用标准库 `ctypes`：`inotify_init`、`inotify_add_watch`，然后把 fd 上的 `struct inotify_event` 记录逐条解析。它监视一个目录，解码掩码和 cookie：

```python
import ctypes, ctypes.util, os, select, struct, sys

libc = ctypes.CDLL(ctypes.util.find_library("c"))
fd = libc.inotify_init()                                 # 队列 fd
wd = libc.inotify_add_watch(fd, b"pdir", 0xFFF)           # 监听所有事件类型

while True:
    if not select.select([fd], [], [], 5.0)[0]: break
    buf = os.read(fd, 4096)
    i = 0
    while i < len(buf):
        w, mask, cookie, ln = struct.unpack_from("iIII", buf, i)
        name = buf[i+16:i+16+ln].split(b"\0")[0].decode()
        print(f"event mask=0x{mask:08x} name={name!r} cookie={cookie}")
        i += 16 + ln
```

真实运行结果——每行一条事件，可以看到每次移动的那一对事件共享同一个 cookie，正好用来把 `MOVED_FROM` 和 `MOVED_TO` 配到一起：

```
event mask=0x00000100 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000040 name='a.txt' cookie=629578
event mask=0x00000080 name='b.txt' cookie=629578
event mask=0x00000100 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000040 name='a.txt' cookie=629579
event mask=0x00000080 name='b.txt' cookie=629579
event mask=0x00000100 name='c.txt' cookie=0
event mask=0x00000020 name='c.txt' cookie=0
event mask=0x00000002 name='c.txt' cookie=0
event mask=0x00000008 name='c.txt' cookie=0
event mask=0x00000040 name='c.txt' cookie=629580
event mask=0x00000080 name='d.txt' cookie=629580
```

（`pdir` 是被监视的目录；掩码对应第一节的表格：`0x100`=CREATE、`0x20`=OPEN、`0x2`=MODIFY、`0x8`=CLOSE_WRITE、`0x40`/`0x80`=MOVED_FROM/MOVED_TO。）三次创建文件共产出 21 条事件，三对重命名各自的 cookie 是：`629578`、`629579`、`629580`。如果你想要更顺手的 API，`watcher` / `inotify_simple` 这类包做的就是这层封装；原生的路径二十行就够，值得自己走过一遍。

## 上限，以及真实的溢出失败

有两个数字约束着一切，而且都是内核级（自 Linux 5.x 起按 user namespace 计）：

- **`/proc/sys/fs/inotify/max_user_watches`**——每个**用户**的监听总数上限。上面说的 `-r` 设计意味着每个被监视目录各占一条。
- **`/proc/sys/fs/inotify/max_queued_events`**——每个 inotify 实例的**队列深度**。

我机器上的值：

```
$ cat /proc/sys/fs/inotify/max_user_watches /proc/sys/fs/inotify/max_queued_events
524288
16384
```

现在看失败模式。队列满了之后再有事件进来，内核会**丢弃新事件**——没有阻塞，没有唤醒，没有报错。唯一痕迹是塞进队列的一条 `IN_Q_OVERFLOW` 事件（`mask 0x4000`，监听描述符 `-1`）。翻译成人话：**你的读取方只要慢，就会静悄悄地漏事件。**

我想诚实地演示这一点。首先尝试把队列人为调小：

```
$ LC_ALL=C sysctl -w fs.inotify.max_queued_events=64
sysctl: permission denied on key "fs.inotify.max_queued_events"
exit=1
```

这台机器上我没有 root，`fs.inotify` 的 sysctl 不是命名空间化的，非特权 `unshare -r` 也拿不到可写的 `/proc/sys`——所以**我没法调低这个上限**。于是我改用更硬的方式触发溢出：一个 Python 监视程序故意**停滞** 12 秒不读，同时另一个进程往被监视目录里灌 8,000 次文件创建（每次点亮 CREATE + OPEN + ATTRIB + CLOSE_WRITE ≈ 32,000 条事件，而队列只有 16,384 深）：

```
fd=3 wd=1; not reading for 12s
*** wd<0 event: mask=0x00004000 cookie=0
--- drained 16385 events total
--- mask histogram: {'0x4': 4096, '0x8': 4096, '0x20': 4096, '0x100': 4096, '0x4000': 1}
--- wd<0 (overflow markers): 1
--- last events: [(1, '0x4', 0), (1, '0x8', 0), (-1, '0x4000', 0)]
```

仔细读这份输出，这就是全部的教训：约 32,000 条事件里，内核只留下了 16,384 条（正好是最先四类事件各 4,096 条）**外加一条溢出标记**，之后的一切都被静默丢弃。队列里的最后一条事件就是溢出标记本身（`wd=-1, mask=0x4000`）。队列填满之后创建的每个文件，从这份监听的视角里彻底消失了。如果你在这之上做一个受管上传工具，你无法只凭事件本身察觉这个缺口，只能因为"明明存在的文件从没上报过"而事后发现。

实操结论：读队列要快，绝不要在处理器里阻塞；把 `IN_Q_OVERFLOW` 当成一个硬信号，"立刻全量重扫目录"；当你确实追不上时，就是该退回定期对账（轮询）的信号——混合设计本来就很常见。

## 谁在用这套机制（以及一个真实的 `systemd.path` 单元）

这套 API 支撑着你已经在依赖的许多工具：`tail -f` 式的日志跟随器、监视文件被外部修改的编辑器、`inotifywait` 驱动的构建/systemd 胶水、Syncthing 家族的文件同步器、`lsyncd`，以及 `watchman` 式的构建工具链。

`systemd.path` 单元就是这套想法的成品化：声明式地"监视一个路径，变化时触发一个服务"——不用写代码，也不用自己养守护进程。我实跑了一个用户级的：

```ini
# ~/.config/systemd/user/blog-watch-demo.path
[Unit]
Description=Demo: react when trigger.txt changes

[Path]
PathModified=/tmp/opencode/work/inotify/trigger.txt

[Install]
WantedBy=default.target
```

配套一个 `blog-watch-demo.service`（Type=oneshot，`ExecStart` 往日志里追加一行 `date`）。对目标文件写两次，服务就跑两次：

```
$ systemctl --user start blog-watch-demo.path
$ echo "change" > trigger.txt              # 第一次写
$ echo "trigger.txt v2" >> trigger.txt     # 第二次写
$ cat trigger.log
1791959259 fired by systemd.path
1791959261 fired by systemd.path
```

相隔两秒的两次写入，换来两次触发。底层上，systemd 做的正是本文从头到尾描述的事：在路径上 `inotify_add_watch`，然后在 `CLOSE_WRITE` 时触发服务单元。（演示单元我随后删掉了——请在自己的临时目录里试，别拿真正重要的目录玩。）

## inotify、轮询与 `systemd.path` 怎么选

- **inotify**——即时、空闲时近乎零成本，但：默认不递归；有按用户的监听上限；队列有限且超载时**丢**事件；还有它报告的是文件系统层的变化，对"内容变化"一无所知。当"文件一变立刻响应"是硬需求时用它。
- **轮询**——可移植性极好，在 NFS 和多数网络文件系统上也能用（那里 inotify 可能根本不触发），而且只要每次全量扫一遍就不会**漏**。适用于对账、低频检查，以及一切不能信任 inotify 语义的场景（比如很多容器 volume 驱动；进容器后记得重看 `/proc/sys/fs/inotify/*`——容器可能把 `max_user_watches` 压得远低于宿主机）。
- **`systemd.path`**——不用你自己写监视器的 inotify。`PathModified`/`PathChanged` 几行就覆盖常见场景，和 `journalctl`、单元依赖天然集成，省掉"为这事写个守护进程"的全部麻烦。能先用它就别自己写服务；当你需要扇出、去抖、跨目录树语义时，再写真正的监视程序（inotify-tools、Python，或某个封装库）。

无论用哪种机制，有一条经验我屡试不爽：**宁可一次保存只响一次，也不要每次写都响一次**——等 `CLOSE_WRITE`，用 cookie 配对 `MOVED_FROM`/`MOVED_TO`，把溢出当作重同步的警报。inotify 之所以快，是因为内核替你盯着；队列之后的部分，就是你的设计了。
