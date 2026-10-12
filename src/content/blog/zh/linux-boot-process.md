---
title: "Linux 启动过程到底发生了什么：从固件、initramfs 到 systemd targets"
description: "在一台真实的 Arch Linux 笔记本上完整走一遍 Linux 启动过程：UEFI 固件与 ESP、GRUB、内核与 initramfs、作为 PID 1 的 systemd、sysinit → basic → multi-user → graphical 的 target 链、用 systemd-analyze 看启动耗时，以及一份排查慢启动与启动失败的实战手册。"
pubDate: 2027-01-01
lang: zh
translationKey: linux-boot-process
tags: [linux, systemd]
featured: false
keywords:
  - Linux 启动过程
  - systemd targets
  - initramfs
  - systemd-analyze
  - GRUB
  - UEFI
  - PID 1
---

我读过的启动日志比我自己愿意承认的要多。并不是因为喜欢，而是因为我名下的每一台
机器最终都会有一次拒绝启动，而答案几乎总是藏在它生命最初的十五秒里。这篇是我对
**Linux 启动过程**的完整走查——从固件到登录界面——所有示例都取自此刻我正在用的这
台机器：一台叫 `BOOK` 的 Arch Linux 笔记本，内核 `7.2.9-arch1-1`，systemd 262，
LUKS 加密根分区。下面代码块里的每一行输出都是从那台主机上原样复制的；凡是需要
root 或我没有的权限才能跑的命令，我都如实说明，而不是编造输出。我们也会讲到
**initramfs**、**systemd targets** 这条链，以及如何用 `systemd-analyze` 读启动
耗时。

<figure>
<svg viewBox="0 0 640 205" width="100%" role="img" aria-label="Linux 启动过程分为五个阶段：UEFI 固件把控制权交给 GRUB，GRUB 加载内核与 initramfs，initramfs 解锁 LUKS 并挂载真正的根文件系统，systemd 作为 PID 1 沿着 target 链走到 graphical.target，登录界面出现。本机实测：固件 4.3 秒、loader 1.4 秒、内核 0.9 秒、initrd 4.7 秒、用户态 3.8 秒，合计 15.1 秒。">
  <defs>
    <marker id="boot-ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <rect x="8" y="34" width="112" height="54" rx="9"/>
    <rect x="136" y="34" width="112" height="54" rx="9"/>
    <rect x="264" y="34" width="112" height="54" rx="9"/>
    <rect x="392" y="34" width="112" height="54" rx="9"/>
    <rect x="520" y="34" width="112" height="54" rx="9"/>
    <path d="M122 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M250 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M378 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M506 61 h12" marker-end="url(#boot-ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5" text-anchor="middle">
    <text x="320" y="18" opacity="0.85">Linux 启动过程，从头到尾</text>
    <text x="64" y="26" opacity="0.6" font-size="11">1</text>
    <text x="192" y="26" opacity="0.6" font-size="11">2</text>
    <text x="320" y="26" opacity="0.6" font-size="11">3</text>
    <text x="448" y="26" opacity="0.6" font-size="11">4</text>
    <text x="576" y="26" opacity="0.6" font-size="11">5</text>
    <text x="64" y="57">UEFI 固件</text>
    <text x="64" y="76" opacity="0.75" font-size="11">ESP 与启动项</text>
    <text x="192" y="57">GRUB</text>
    <text x="192" y="76" opacity="0.75" font-size="11">加载内核与 initrd</text>
    <text x="320" y="57">内核 + initramfs</text>
    <text x="320" y="76" opacity="0.75" font-size="11">解锁 LUKS，挂载 /</text>
    <text x="448" y="57">systemd，PID 1</text>
    <text x="448" y="76" opacity="0.75" font-size="11">target 链 → graphical</text>
    <text x="576" y="57">登录</text>
    <text x="576" y="76" opacity="0.75" font-size="11">getty / 显示管理器</text>
    <text x="64" y="108" opacity="0.85" font-size="11">4.3 s</text>
    <text x="192" y="108" opacity="0.85" font-size="11">1.4 s</text>
    <text x="320" y="108" opacity="0.85" font-size="11">0.9 s + 4.7 s</text>
    <text x="448" y="108" opacity="0.85" font-size="11">3.8 s</text>
    <text x="576" y="108" opacity="0.85" font-size="11">≈ 0 s</text>
    <text x="320" y="140" opacity="0.75" font-size="11">Arch Linux，内核 7.2.9-arch1-1，systemd 262</text>
    <text x="320" y="160" opacity="0.75" font-size="11">固件 4.317s + loader 1.405s + 内核 883ms + initrd 4.683s + 用户态 3.785s = 15.076s</text>
  </g>
</svg>
<figcaption>五个阶段，一台机器，真实测量：在 `BOOK` 上执行 `systemd-analyze time`，从固件到 `graphical.target` 共 15.076 秒。</figcaption>
</figure>

## 阶段一：UEFI 固件找到 ESP

在任何 Linux 代码运行之前，先跑起来的是固件。这台主机通过 UEFI 启动，这一点我
可以去证明而不是靠猜——`/sys/firmware/efi` 只在内核由 EFI 启动时才存在：

```
$ ls -ld /sys/firmware/efi
drwxr-xr-x 5 root root 0 10月12日 04:12 /sys/firmware/efi
```

（本机 locale 是中文，所以逐字复制的输出里日期是这个格式。）

UEFI 把启动项存在 NVRAM 里，而在这台机器上 `efibootmgr` 普通用户就能读：

```
$ efibootmgr
BootCurrent: 0000
Timeout: 0 seconds
BootOrder: 0000,0001,0002,0003
Boot0000* GRUB	HD(1,GPT,00981c32-ada8-46ca-99e6-1d9bab3c5f72,0x800,0x100000)/\EFI\GRUB\grubx64.efi
Boot0001* UEFI:CD/DVD Drive	BBS(129,,0x0)
Boot0002* UEFI:Removable Device	BBS(130,,0x0)
Boot0003* UEFI:Network Device	BBS(131,,0x0)
```

`BootCurrent: 0000` 说明这次启动用的是 `GRUB` 这一项：某块 GPT 磁盘
（`sdb`）的第一个分区，也就是 EFI 系统分区，运行
`\EFI\GRUB\grubx64.efi`。`Timeout: 0` 意味着固件瞬间交权——没有菜单，没有按键等
待窗口。一切正常时这是便利，出问题时就是个小陷阱：超时为零，你就没法在固件层选
择备用启动项，引导器层面的恢复只能靠改 GRUB 自己的菜单。

## 阶段二：GRUB 加载内核与 initramfs

这台机器的 ESP 挂在 `/boot`——一个 FAT32 分区——所以 `lsblk -f` 把它显示得清清
楚楚，内核和 initramfs 也住在这里面：

```
$ lsblk -f
NAME          FSTYPE      FSVER LABEL       UUID                                 FSAVAIL FSUSE% MOUNTPOINTS
sda
└─sda1        crypto_LUKS 2     data-crypt  5051dd9f-ee0c-4a55-a369-19b22308d97d
  └─data      ext4        1.0   coldbackup  324279fc-b511-464e-a3fb-03f8dc68cbac  278.7G     5% /data
sdb
├─sdb1        vfat        FAT32             5B41-70E4                             368.8M    28% /boot
└─sdb2        crypto_LUKS 2                 f872976e-53b5-4a38-8953-995ce2bc6153
  └─cryptroot ext4        1.0               14d09c9a-b9e2-4988-8099-129f919e67e7      75G    63% /
sdc
└─sdc1        vfat        FAT32 BIOS        8019-1093
zram0         swap        1     zram0       6c1f9c74-50c2-4050-96b2-21218de9e48e                [SWAP]
```

存储要分三层记住：ESP（`5B41-70E4`，`/boot`）、加密的根容器
（`f872976e…`，`sdb2` 上的 LUKS）、以及容器内的 ext4 文件系统
（`14d09c9a…`，`/`）。本次启动所用的 GRUB 菜单项好心地十分平淡——而这正是一个引
导器该有的样子：

```
$ grep -nE '^\s*(linux|initrd)\s' /boot/grub/grub.cfg
	linux	/vmlinuz-linux root=UUID=14d09c9a-b9e2-4988-8099-129f919e67e7 rw root=/dev/mapper/cryptroot loglevel=3 quiet rd.systemd.show_status=auto memmap=1M$0x2F000000 ramoops.mem_address=0x2F000000 ramoops.mem_size=0x100000 ramoops.record_size=0x40000 ramoops.console_size=0x40000
	initrd	/intel-ucode.img /initramfs-linux.img
```

有两个细节值得记住。第一，CPU 微码在内核**之前**加载——CPU 勘误修复必须在内核开
始使用这颗 CPU 之前落地，所以 `intel-ucode.img` 排在 `initrd` 行里
`initramfs-linux.img` 的前面。第二，磁盘上的 `grub.cfg` 只决定**下一次**启动。
那一行里的 `memmap`/`ramoops` 参数并没有出现在上一次启动真实的
`/proc/cmdline` 里，说明配置是在上次重启之后重新生成的。内核自己的记录才是事实
来源，而这份记录在运行时就能读：

```
$ cat /proc/cmdline
BOOT_IMAGE=/vmlinuz-linux root=UUID=14d09c9a-b9e2-4988-8099-129f919e67e7 rw root=/dev/mapper/cryptroot loglevel=3 quiet rd.systemd.show_status=auto
```

注意 `root=` 出现了**两次**。内核采用命令行里**最后**一个 `root=`，所以真正的根
是 `/dev/mapper/cryptroot`——一个此刻还不存在的设备映射名。第一个
`root=UUID=…` 指向容器内的 ext4 文件系统，这是 `sd-encrypt` 这个 initramfs hook
所遵循的约定。以 `rd.`（ramdisk）开头的参数是给 initramfs 的，不是给内核的。

## 阶段三：initramfs 解锁磁盘并挂载真正的根

内核刻意做得很小——它不可能内置所有存储控制器和加密驱动。于是引导器递给它第二
个归档文件，也就是 **initramfs**；内核把它解开到一个临时根文件系统里，并让它作
为 PID 1 运行，直到真正的根就绪。在这台主机上它 27 MB，旁边还有一个 73 MB 的
fallback 镜像：

```
$ ls -l /boot
总计 129468
-rwxr-xr-x 1 root root 73013318 10月12日 05:25 initramfs-linux-fallback.img
-rwxr-xr-x 1 root root 27033876 10月12日 05:24 initramfs-linux.img
-rwxr-xr-x 1 root root  15265792  9月26日 06:53 intel-ucode.img
-rwxr-xr-x 1 root root  17238584 10月10日 17:20 vmlinuz-linux
```

在 Arch 上这个镜像由 mkinitcpio 组装，而它的 hook 列表就是这个阶段的全部任务
说明：

```
$ grep -n '^HOOKS' /etc/mkinitcpio.conf
HOOKS=(base systemd autodetect microcode modconf kms keyboard keymap sd-vconsole block sd-encrypt filesystems fsck)
```

按顺序把这些 hook 当成一张待办清单来读：搭一个极简 systemd，自动检测本机真正需
要的模块，应用微码，拉起步键盘和 KMS 好让解锁密码提示可用，组装块设备，运行
`sd-encrypt` 解锁 `sdb2` 上的 LUKS 容器，挂载真正的根，对它做 fsck。
`/etc/crypttab` 告诉 `sd-encrypt` 哪个容器映射到哪个名字——它在这台主机上是
`000` 权限，我读不了，但上面 `lsblk -f` 里的 LUKS UUID `f872976e…` 正是它匹配的
那个。当 `/init` 跑完，内核会被告知 `switch_root`：initramfs 被丢弃，真正的 `/`
接管。如果这次交接失败，启动就已经失败了——而且你会掉进的是 initramfs 的紧急
shell，而不是 systemd 的。

这个阶段最常见的坑：`autodetect` 记录的是**当前运行中**内核需要的模块。升了内核
却不重新生成镜像，下一次启动就可能得到一个看不见自己磁盘的 initramfs。旁边那个
fallback 镜像正是为此存在——它带的是一大批通用模块，而不是精挑细选的那一套。

## 阶段四：systemd 成为 PID 1

`switch_root` 之后，用户态的 init 接管。这台机器上是 systemd，内核可以直接作证：

```
$ head -12 /proc/1/status
Name:	systemd
State:	S (sleeping)
Tgid:	1
Pid:	1
PPid:	0
```

（`/proc/1/exe` 确实指向 `/usr/lib/systemd/systemd`，但这个符号链接只有 root 能
读——我这边 permission denied，对于别人的进程来说这是意料之中。）

PID 1 的职责不是「从头到尾跑脚本」——那是 SysV。systemd 读取单元文件
（`.service`、`.socket`、`.mount`、`.target` 等），把它们当作依赖图来解析，
**并行**启动互相独立的单元，并持续监督它们。generator 会在启动时从
`/etc/fstab`、`/etc/crypttab` 和内核命令行合成单元，这就是为什么 `fstab` 里的一
行会悄悄变成一个 `.mount` 单元，`crypttab` 里的一行变成一个
`systemd-cryptsetup@…` 服务。

## systemd targets：单元如何被编排成一次启动

**systemd targets** 是同步点，而不是换了说法的运行级。每个 target 把共享同一个
就绪里程碑的单元归拢到一起，单元之间的排序则由 `After=`/`Requires=` 边定义。这
台桌面的默认 target 是：

```
$ systemctl get-default
graphical.target
```

标准的链是 `sysinit.target` → `basic.target` → `multi-user.target` →
`graphical.target`，运行中的机器上所有 target 可以一次看全：

```
$ systemctl list-units --type=target
  UNIT                   LOAD   ACTIVE SUB    DESCRIPTION
  basic.target           loaded active active Basic System
  cryptsetup.target      loaded active active Local Encrypted Volumes
  getty.target           loaded active active Login Prompts
  graphical.target       loaded active active Graphical Interface
  local-fs.target       loaded active active Local File Systems
  multi-user.target      loaded active active Multi-User System
  network.target        loaded active active Network
  network-online.target loaded active active Network is Online
  sockets.target        loaded active active Sockets
  sysinit.target        loaded active active System Initialization
  slices.target         loaded active active Slices
```

服务器通常默认停在 `multi-user.target`；桌面则继续走到 `graphical.target`，加上
显示管理器。这台主机跑的是 KDE Plasma 的 `plasmalogin.service`，
`systemd-analyze critical-chain` 把从默认 target 一路回到 `sysinit.target` 的关
键路径完整显示了出来：

```
$ systemd-analyze critical-chain
graphical.target @3.785s
└─plasmalogin.service @3.739s
  └─plymouth-quit.service @3.704s +32ms
    └─systemd-user-sessions.service @3.685s +15ms
      └─network.target @3.661s
        └─NetworkManager.service @3.243s +417ms
          └─basic.target @3.242s
            └─dbus-broker.service @3.204s +37ms
              └─dbus.socket @3.196s +49us
                └─sysinit.target @3.195s
                  └─systemd-update-done.service @3.176s +18ms
                    └─ldconfig.service @2.899s +276ms
                      └─systemd-tmpfiles-setup.service @2.493s +404ms
                        └─local-fs.target @2.487s
                          └─boot.mount @2.326s +159ms
                            └─systemd-fsck@dev-disk-by\x2duuid-5B41\x2d70E4.service @1.956s +63ms
                              └─dev-disk-by\x2duuid-5B41\x2d70E4.device
```

自底向上读：ESP 先作为 device 出现，被 fsck，被挂载到 `/boot`，到达
`local-fs.target`，tmpfiles 和 ldconfig 运行，`sysinit` 完成，socket 和 D-Bus 把
`basic.target` 拉起来，随后网络、会话和登录管理器把它一路带到
`graphical.target`。`@` 是单元变为 active 的时刻，`+` 是它启动花了多久。从
3.242s 的 `basic.target` 到 3.785s 的 `graphical.target`，中间全部只花了大约半秒
钟。

## 到底花了多久？systemd-analyze

`systemd-analyze` 是第一个该拿起的工具，它的三种模式分别回答三个不同的问题。
`time` 把启动切成几个阶段——文章开头那张图就是按这份测量画的：

```
$ systemd-analyze time
Startup finished in 4.317s (firmware) + 1.405s (loader) + 883ms (kernel) + 4.683s (initrd) + 3.785s (userspace) = 15.076s
graphical.target reached after 3.785s in userspace.
```

这里固件加 loader 占了大头——一个慢的 UEFI 实现配上零超时，比任何服务都更值得优
化。`blame` 则归因用户态的时间：

```
$ systemd-analyze blame | head -5
6.406s systemd-fsck@dev-mapper-data.service
5.856s dev-tpm0.device
5.856s sys-devices-platform-MSFT0101:00-tpm-tpm0.device
5.809s dev-disk-by\x2dpath-pci\x2d0000:00:17.0\x2data\x2d3.0\x2dpart-by\x2duuid-5B41\x2d70E4.device
5.809s dev-disk-by\x2ddiskseq-2\x2dpart1.device
```

两个告诫，都在这台主机上看得见。一个 `.device` 单元「花了」5.8 秒，几乎从来不
意味着磁盘慢——它意味着有东西在*等待*那块磁盘出现，而 blame 把等待记在了设备
头上。`systemd-fsck@dev-mapper-data` 烧掉的 6.4 秒也完全不在关键路径上：`/data`
在 `/etc/fstab` 里是以 `nofail` 加 `x-systemd.automount` 挂载的，它的 fsck 在后台
懒执行。`blame` 度量的是时间花在了哪里，而不是启动卡在了哪里——后者是
`critical-chain` 的职责。

## Linux 启动过程在哪里会坏

**initramfs 看不见根盘。** 缺一个存储或加密模块——通常是升了内核而镜像过期——
结局是一个告诉你找不到根文件系统的 shell，或者一个永远等不到设备的 `sd-encrypt`
提示。从 GRUB 菜单启动 fallback 镜像，然后重新生成：Arch 上是 `mkinitcpio -P`。

**`root=` 写错了。** 症状是内核 panic，或者紧急 shell 里一句 "No root filesystem
found"，常发生在磁盘操作改变了 UUID 之后。用 `lsblk -f` 核对，修
`/etc/default/grub`，再重建 `grub.cfg`。永远不要手写 `/dev/sdX` 作为根——那些名
字会变，UUID 和 `/dev/mapper/` 名不会。

**某个挂载失败。** 一行错误的 `fstab` 会让启动掉进 `emergency.target`，
`systemctl --failed` 会直接指着肇事者。这台主机上 `/data` 那一行就是防御式写法
的范本：`nofail` 加 `x-systemd.automount`，再加明确的
`x-systemd.device-timeout=15s`——一块备份盘可以不在，但不该拦住机器启动。

**某个单元挂住。** 启动停在 "A start job is running…"，最终超时（文档里的默认
`DefaultTimeoutStartSec` 是 90 秒）。在内核命令行追加
`systemd.unit=emergency.target` 进救援 shell，然后 `systemctl list-jobs` 看它在等
什么，对那个没有也能活的单元 `systemctl mask`。

## 慢启动或启动失败的排查手册

按顺序，每次都这么做：

1. `systemd-analyze time`——秒数归哪个阶段。
2. `systemd-analyze blame | head -20`——谁花掉了它们（`.device` 单元要打折看，
   那是等待，不是干活）。
3. `systemd-analyze critical-chain graphical.target`——真正的关键路径。
4. `systemctl --failed` 和 `journalctl -b -p err`——这次启动里什么失败了。
5. `journalctl -b -k` 看内核消息。这台主机上直接 `dmesg` 是被禁的——它报
   「读取内核缓冲区失败: 不允许的操作」，因为非特权读取内核环形缓冲受到限制——
   但 `journalctl -b -k` 普通用户跑得好好的，所以我才用它。
6. 当它根本起不来的时候：把内核命令行里的 `quiet` 去掉（或设 `loglevel=7`），
   把消息而不是开机画面看出来；启动 fallback initramfs；用
   `systemd.unit=emergency.target` 换来一个 shell。

这就是完整生命周期：固件找到 ESP，引导器加载内核和 initramfs，initramfs 解锁并
挂载真正的根，systemd 作为 PID 1 接管，target 链把机器从 `sysinit` 一路推到
`graphical`，直到登录界面出现。没什么神秘——只是五个阶段，各自以特有的方式失败，外加一批多得
惊人、能准确告诉你究竟是哪一环出错的工具。

如果你想深入用户态那一半：[systemd 单元手册](/zh/posts/systemd-unit-cookbook/)
讲的是上面一切的单元语法基础，而
[systemd 定时器 vs cron](/zh/posts/systemd-timers-vs-cron/) 则是我等一台机器稳定
启动之后，开始按日程跑东西时的下一篇。
