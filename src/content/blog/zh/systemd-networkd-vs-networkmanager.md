---
title: "systemd-networkd 与 NetworkManager：谁来配置你的网络？"
description: "一篇带真实输出的 systemd-networkd 与 NetworkManager 对比：.network 声明式文件对比 nmcli 连接配置文件、同一份静态 IP 的两种写法、各自如何供 DNS 给 systemd-resolved，以及为什么两个一起跑是坏主意。"
pubDate: 2027-01-30
lang: zh
translationKey: systemd-networkd-vs-networkmanager
tags: [networking, systemd]
featured: false
keywords:
  - systemd-networkd
  - NetworkManager
  - Linux 网络配置
  - .network 文件
  - nmcli
  - netplan
  - systemd-resolved
---

任何一台有网的 Linux 机器，都在由*某个东西*在写 IP 地址。通常不是你，也不是某个开机脚本。
而是两个守护进程之一。搞清楚你跑的是哪一个、以及它怎么思考，决定的是一行命令
的改动还是一个下午的干仗。以下从我自己机器的真实状态讲起。

这是我的 Arch 桌面，此刻，它用的是 **NetworkManager**：

```bash
$ systemctl is-active NetworkManager systemd-networkd systemd-resolved
active
inactive
active
```

`systemd-networkd` 在这里不只是"没运行"，它是**被禁用**的——`UnitFileState`
就是这么说的，也就是说我默认的启动目标里没有任何东西会拉起它：

```bash
$ systemctl is-enabled NetworkManager systemd-networkd systemd-resolved
enabled
disabled
enabled
```

这才是笔记本上的正常格局：一个守护进程独占网络，另一个虽然装着（它随 systemd
一起来，没法单独卸掉）但被关着。下面讲清楚你该选哪个、两者的*形态*差在哪，
以及两个一起上会发生什么。每条命令都是真跑过的；凡是套了沙箱的地方我都会说明。

## 两者到底是什么

**systemd-networkd** 是随 systemd 一起发行的网络配置守护进程。它很小（空闲时
驻留内存只有几 MB），没有交互前端，而且它是*声明式*的：把 `.network` 文件丢进
`/etc/systemd/network/`，它察觉，然后把内核状态收敛到与文件一致。它对 systemd
的"嵌入感"有多强，从 systemd 自己给容器发的文件就能看出来——就在我这台机器上，
`/usr/lib/systemd/network/80-container-host0.network` 是一个真实存在的文件，
给 `systemd-nspawn` 那条 veth 链路的容器一侧配 DHCP。它是为"配一次就再也不
漫游"的机器设计的：服务器、虚拟机、容器、网络命名空间。

**NetworkManager** 是一个*有状态*的守护进程，带一整套 API。它维护的是活对象——
设备、连接、活动连接——而一条"连接"是一份配置档案："某某 SSID 配这把钥匙，
或者这块网卡配那个静态地址"，再加上一套决定*此刻*该用哪份档案的逻辑：附近
信号最强的 AP、应当跟随这个 SSID 的 VPN、以及你走出家 Wi-Fi 覆盖范围时的漫游规则。
`nmcli` 只是这套状态的命令行客户端，旁边还有 D-Bus API、一个 curses 界面
（`nmtui`）和一个桌面托盘程序。

说得再短一点：networkd 配置接口，NetworkManager 管理连通性。让 NetworkManager
变大的那些东西——保存的凭据、VPN 自动连接、对链路 up 事件做出反应的
dispatcher 脚本——是 networkd 根本不打算干的活；让 networkd 变小的那些东西——
没有 D-Bus、没有插件栈、能作为一个普通进程跑进网络命名空间——是 NetworkManager
没打算干、也干不了的活。

## 配置模型：`.network` 文件与连接档案

第二个差异是你每天都要碰的，因为它决定了一次改动在磁盘上长什么样。

networkd 的配置是**纯声明式文件**，按字典序排序，从 `/etc/systemd/network/`
（以及发行版自带的 `/usr/lib/systemd/network/`）里加载：

```ini
# /etc/systemd/network/10-static.network
[Match]
Name=netdemod

[Network]
Address=10.42.0.5/24
Gateway=10.42.0.1
DNS=10.42.0.1
```

NetworkManager 的配置是一份**有状态的档案**，由 `keyfile` 插件持久化为
`/etc/NetworkManager/system-connections/` 下的 `.nmconnection`——一种完全不同的
文件格式，有 `uuid`、有 `type`，还有一个 `method=` 字段说明这份档案是手工地址、
DHCP 还是共享热点。这个磁盘格式很要紧：在我这台机器上
`/etc/NetworkManager/system-connections/` 是 root 独占（我读不了，也不该读），
你一条命令建出来的档案，就是守护进程每次开机重新施加的那份。

架在两者之上的是 Ubuntu/Debian 的 **netplan**：一个薄薄的 YAML 前端，全部职责
就是按你选的 `renderer:` ，把自己**渲染成** networkd 的 `.network` 文件或者
NetworkManager 的 keyfile。Netplan 不是第三个守护进程，"netplan apply" 背后
还是上面两位之一。

## 同一份静态 IP，两种写法

我用两个工具分别配了完全相同的策略——`10.42.0.5/24`、网关 `10.42.0.1`、
DNS `10.42.0.1`——都打在一个一次性的 `dummy` 接口上，而且两者都成功生效了。
两条诚实的说明：我这台桌面跑的是 NetworkManager，所以 networkd 那一半是在
一次性沙箱里跑的；而且没有 root，我没法对*真实*网卡做这个实验。接口分别是
`netdemod`（networkd）和 `nmdemo`（NetworkManager）。

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="同一份静态地址写成两种格式：一边是 /etc/systemd/network 下的 systemd-networkd .network 文件，一边是 /etc/NetworkManager/system-connections 下的 NetworkManager keyfile，最终都得到 10.42.0.5/24，网关与 DNS 都是 10.42.0.1" xmlns="http://www.w3.org/2000/svg" style="max-width:680px">
  <defs>
    <marker id="arrow-zh" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="170" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#0f766e">systemd-networkd</text>
  <text x="510" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#0f766e">NetworkManager</text>
  <rect x="24" y="38" width="292" height="150" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="36" y="60" font-family="monospace" font-size="12" fill="currentColor">/etc/systemd/network/</text>
  <text x="36" y="80" font-family="monospace" font-size="12" fill="currentColor">  10-static.network</text>
  <text x="36" y="106" font-family="monospace" font-size="12" fill="#0f766e">[Match] Name=netdemod</text>
  <text x="36" y="126" font-family="monospace" font-size="12" fill="#0f766e">[Network] Address=10.42.0.5/24</text>
  <text x="36" y="146" font-family="monospace" font-size="12" fill="#0f766e">Gateway=10.42.0.1  DNS=10.42.0.1</text>
  <text x="36" y="170" font-family="monospace" font-size="11" fill="currentColor">声明式，有顺序，无状态</text>
  <rect x="364" y="38" width="292" height="150" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="376" y="60" font-family="monospace" font-size="12" fill="currentColor">/etc/NetworkManager/</text>
  <text x="376" y="80" font-family="monospace" font-size="12" fill="currentColor">  system-connections/static-demo</text>
  <text x="376" y="106" font-family="monospace" font-size="12" fill="#0f766e">[ipv4] method=manual</text>
  <text x="376" y="126" font-family="monospace" font-size="12" fill="#0f766e">address1=10.42.0.5/24</text>
  <text x="376" y="146" font-family="monospace" font-size="12" fill="#0f766e">gateway=10.42.0.1  dns=10.42.0.1</text>
  <text x="376" y="170" font-family="monospace" font-size="11" fill="currentColor">带 uuid 的档案，被实时跟踪</text>
  <line x1="170" y1="188" x2="170" y2="222" stroke="currentColor" stroke-width="2" marker-end="url(#arrow-zh)"/>
  <line x1="510" y1="188" x2="510" y2="222" stroke="currentColor" stroke-width="2" marker-end="url(#arrow-zh)"/>
  <text x="170" y="214" text-anchor="middle" font-family="monospace" font-size="11" fill="currentColor">networkctl status</text>
  <text x="510" y="214" text-anchor="middle" font-family="monospace" font-size="11" fill="currentColor">nmcli device show</text>
  <rect x="150" y="226" width="380" height="58" rx="10" fill="#0f766e"/>
  <text x="340" y="250" text-anchor="middle" font-family="monospace" font-size="13" fill="#ffffff">10.42.0.5/24</text>
  <text x="340" y="272" text-anchor="middle" font-family="monospace" font-size="12" fill="#ffffff">gw 10.42.0.1 · dns 10.42.0.1</text>
</svg>
<figcaption>同一个意图，两种表示。<code>systemd-networkd</code> 把它存成一份声明式
<code>.network</code> 文件，原样施加，链路每次变化都重新施加；NetworkManager 则维护一份
有状态的连接档案，落到磁盘上就是 keyfile，由守护进程把它与设备匹配，并在它认为时机
合适时激活。</figcaption>
</figure>

### networkd：写完文件，看它收敛

我把那份文件丢进了一个隔离的网络命名空间（`unshare -Urnm` 沙箱，另外单独
mount 了一个 `sysfs` 让 `networkd` 能看见这个接口——这一步是所有人都容易漏的）。
`networkd` 起来后，看到链路出现，就把它配上了：

```text
$ ip -brief addr show netdemod
netdemod         UNKNOWN        10.42.0.5/24 fe80::d45e:93ff:feba:8470/64

$ ip -4 route show
default via 10.42.0.1 dev netdemod proto static
default via 10.42.0.1 dev lo proto static
10.42.0.0/24 dev netdemod proto kernel scope link src 10.42.0.5

$ networkctl status netdemod
* 2: netdemod
                       State: routable (configured)
                Network File: /etc/systemd/network/10-static.network
                     Address: 10.42.0.5
                     Gateway: 10.42.0.1
                         DNS: 10.42.0.1
```

注意 `Network File:` 白送你的东西：守护进程直接点名当前状态背后到底是哪份声明式
文件。这不是贴心，这是排障手段——你永远不用纠结"三个文件里到底谁赢了"，因为顺序
有文档，链路自己会引用来源。

"声明式"的另一半是状态是*被强制维持*的，不是设一次就完。我绕到 networkd 背后
用手删掉了地址，然后要求它重配：

```bash
$ ip addr del 10.42.0.5/24 dev netdemod
$ networkctl reconfigure netdemod
$ ip -brief addr show netdemod
netdemod         UNKNOWN        10.42.0.5/24 fe80::cca6:85ff:fe19:902f/64
```

地址回来了。任何跟你的 `.network` 文件对着干的东西，都会在下一次 reconfigure 时
输掉——原则上，也包括另一个网络守护进程。

### NetworkManager：建档案，看它激活

同一个地址，这次用 `nmcli`，在一个 Debian 13 容器里（NetworkManager 加一条私有
D-Bus，`eth0` 放着不动）。从*档案*的视角看，"已连接"是一个要去达成的运行时
状态，不是既成事实：

```bash
$ nmcli con add type dummy ifname nmdemo con-name static-demo \
    ip4 10.42.0.5/24 gw4 10.42.0.1 ipv4.dns 10.42.0.1
Connection 'static-demo' (31b43c67-ec5b-4a4d-919c-b4b23220847a) successfully added.

$ nmcli con up static-demo
Connection successfully activated

$ nmcli -f GENERAL.TYPE,GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS device show nmdemo
GENERAL.TYPE:                           dummy
GENERAL.STATE:                          100 (connected)
IP4.ADDRESS[1]:                         10.42.0.5/24
IP4.GATEWAY:                            10.42.0.1
IP4.DNS[1]:                             10.42.0.1
```

档案也立刻落到了磁盘上，用的是 NetworkManager 自己的格式——权限 `0600`，因为
同一套格式还得装 Wi-Fi 的 PSK，这也正是我主机上那份目录我读不了的原因：

```ini
# /etc/NetworkManager/system-connections/static-demo.nmconnection
[connection]
id=static-demo
uuid=31b43c67-ec5b-4a4d-919c-b4b23220847a
type=dummy
interface-name=nmdemo

[ipv4]
address1=10.42.0.5/24
dns=10.42.0.1;
gateway=10.42.0.1
method=manual
```

两点差异值得点名。第一，NetworkManager 需要一次真正的*激活*：档案在有人拉起它
之前是惰性的，而我的第一次尝试就失败了——`device 'nmdemo' not compatible with
connection 'static-demo': The connection was not a dummy connection`，因为我漏了
`type=dummy`：它拿类型和 device 对了一致性然后拒绝，这正是 networkd 不会做的
那种有状态推理。第二，那个 `uuid`：档案是带身份的对象，不是文件。

### 我手上这台机器的真实档案

```bash
$ nmcli -f connection.id,connection.type,802-11-wireless.ssid,\
802-11-wireless.mode,802-11-wireless-security.key-mgmt,ipv4.method con show 317_NO_AUTH
connection.id:                          317_NO_AUTH
connection.type:                        802-11-wireless
802-11-wireless.ssid:                   317_NO_AUTH
802-11-wireless.mode:                   infrastructure
802-11-wireless-security.key-mgmt:      wpa-psk
ipv4.method:                            auto
```

这就是这台机器此刻在用的 Wi-Fi 连接，除了一切秘密之外的部分：`key-mgmt` 是
`wpa-psk`，所以磁盘那份文件里还躺着密码。再注意 `interface-name: --`——这份档案
不绑定任何一块网卡，谁是可用的 wifi 设备就绑谁。这就是漫游，被写成了数据。

## 各发行版默认用哪个

实际的分野跟着机器的活儿走：

- **NetworkManager**：Fedora 与 RHEL 8/9，桌面和服务器都是；Debian 与 Ubuntu
  桌面；openSUSE；Arch 桌面 spins。RHEL 从 7 开始切，而且走得比那更远——官方文档
  直接叫你用 `nmcli`，别去改文件。
- **systemd-networkd**：Ubuntu Server 和 Debian 走 netplan（默认 renderer 就是
  networkd），Fedora CoreOS 与 RHEL CoreOS 走 Ignition，Debian 最小化/服务器
  安装，以及基本上全部容器基础镜像——所以 systemd 自带的那些 `.network` 示例
  文件才都是容器和虚拟机口味的。
- **两个都不用**：不少最小镜像和大多数 Docker 容器只用 entrypoint 里的 `ip`
  命令，根本不装守护进程。

所以 Ubuntu Server 上你写 netplan，RHEL 上你敲 `nmcli`，而它们是同一个系统的
两种方言。Linux 网络配置要学的是"这两个里的一个"，不是"三个都学"。

## 各自怎么给 systemd-resolved 供 DNS

两个守护进程都能把 DNS 交给 **systemd-resolved**，但路线不同，结果直接反映在
`/etc/resolv.conf` 上。networkd 走的是特权钩子：它把每个链路的 DNS 写进
`/run/systemd/resolve/`，`resolved` 再据此拿出按接口的上游，分流 DNS 和 DoT
才成为可能。我主机上的 `resolvectl status` 展示的是另一种模型——NetworkManager
*和* `systemd-resolved` 都在跑，但两者是用最省钱的方式接在一起的：

```text
$ resolvectl status
Global
           Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
    resolv.conf mode: foreign
  Current DNS Server: 223.5.5.5
         DNS Servers: 223.5.5.5 119.29.29.29

Link 2 (wlp2s0)
    Current Scopes: DNS LLMNR/IPv4 LLMNR/IPv6 mDNS/IPv4 mDNS/IPv6
         DNS Servers: 223.5.5.5 119.29.29.29
       Default Route: yes

$ cat /etc/resolv.conf
# Generated by NetworkManager
nameserver 223.5.5.5
nameserver 119.29.29.29
```

`resolv.conf mode: foreign` 的意思是 `resolved` *没有*在管理
`/etc/resolv.conf`——那个文件是 NetworkManager 自己写的。它仍然看得见这些上游，
因为 NetworkManager 通过 D-Bus 推了过来；于是你得到了缓存和按链路的账目，
但没有 `127.0.0.53` 存根，也就没有按应用的分流和 DoT。这一行就告诉你你的机器
处在哪种模型里。完整机制见[《systemd-resolved 实战》](/zh/posts/systemd-resolved/)。

## 为什么两个一起跑是坏主意

两者都写同一批 netlink 对象——地址、路由、metric——而且谁也不知道对方的意图。
结果是地址反复抖动、默认路由忽现忽隐、DNS 随机指向各自最后一次相信的东西。
症状很少是"坏了"，而是"每隔几分钟网络就闪一下"，而修法永远是选一个、禁掉另一个。

我没有真的同时跑它们——我这台桌面上 networkd 是禁用的，它根本不碰任何接口——
但这台机器照样展示了两者冲突的*形状*。Docker 和一条 VPN 也在这儿配接口，而
NetworkManager 的应对是把一切不是它配置的东西丢进"不是我的"这个桶：

```bash
$ nmcli device status
DEVICE             TYPE      STATE                   CONNECTION
wlp2s0             wifi      connected               317_NO_AUTH
docker0            bridge    connected (externally)  docker0
lo                 loopback  connected (externally)  lo
tun0               tun       connected (externally)  tun0
04:D3:B5:46:EB:FA   bt        disconnected             --
veth6f9fc93        ethernet  unmanaged                --
veth9be9eb8        ethernet  unmanaged                --
```

`connected (externally)` / `unmanaged` 这个区别就是 NetworkManager 在宣布放弃
所有权：它只观察，不动手。对 `docker0` 和 `tun0` 这是对的代码，也正是两个管理器
*本该*共存的方式——给各自一份排他接口集，用 `NetworkManager.conf` 的
`[device] managed=0` 或者 netplan 的 `renderer:` 拆分，绝不让两边同时认领同一块
网卡。`systemd-resolved` 则可以放心共用，因为它是一个两者都消费的*服务*，不是
接口的管理者。

## 所以该用哪个？

诚实的建议主要是"沿用你发行版给的那个"，有理由时再刻意换：

- **服务器、虚拟机、容器、网络命名空间 → networkd，或者干脆不要守护进程。**
  静态 IP 就该待在一个 `.network` 文件里（或者一条 `ip` 命令），因为没有东西在
  漫游。networkd 也是那个能在网络命名空间里正常干活的，就像上面那个沙箱展示的
  ——如果你像我一样在[《网络命名空间与 veth》](/zh/posts/network-namespaces-and-veth/)
  里那样测叠加网络，这一点很关键。
- **笔记本、桌面、任何带 Wi-Fi 或 VPN 的 → NetworkManager。** 它相对 networkd
  多出来的每一项——漫游、凭据、D-Bus 控制——你一周之内都会用上。
- **两个混用 → 不要**，除非你显式划分接口并且写进文档：这种故障是间歇性的，
  看起来像硬件问题。
- **为换而换 → 不要。** 为了在一台从 netplan 启动的机器上敲 `nmcli`，没有奖赏。

最后一点视角：真正要紧的不是功能多少，而是*谁负责收敛*。networkd 持有一个期望
状态，把内核推向它，这就是 `networkctl reconfigure` 能把被我删掉的地址复活的
原因；NetworkManager 持有一个期望*连接*，把事件推进去，这就是同一份档案第二次
激活是空操作的原因。两种模型都成立。它们只是不能同时作用在同一个接口上。
