---
title: "网络命名空间与 veth：在一台机器上搭一张假网络"
description: "用 ip netns、veth 对、网桥和 NAT，在一台 Linux 机器里搭出一个小型多主机网络，让命名空间之间能互相 ping、能走网桥交换、还能经 NAT 上公网。这是一篇动手实战指南：不用额外硬件就能测试路由、overlay 配置和防火墙规则，并用 ping、ip route 和 tcpdump 逐项验证。"
pubDate: 2026-10-21
lang: zh
translationKey: network-namespaces-and-veth
tags: [linux, networking, devops]
featured: false
keywords:
  - 网络命名空间
  - ip netns
  - veth 对
  - Linux 网络
  - 容器网络
---

你想测一条路由规则、一份 overlay 配置，或者一条防火墙策略。你不想为此开三台虚拟机、
把它们连起来、再等云镜像开机。你也不需要。Linux 能给你一整套隔离的网络栈——网卡、路由、
ARP 表、防火墙规则——那就是一个**网络命名空间（network namespace）**；而 **veth 对**
可以像一根网线那样，把两个这样的栈接在一起。这样重复几遍，你就有了一张住在单台机器里的
小型多主机网络：能互相 ping 的主机、中间的一台交换机，以及一台带 NAT、能出公网的
路由器。

这是我做 **Linux 网络** 实验时用的那套流程，而它也正是**容器网络**底下跑的同一套机制。
我们会建两个命名空间，用一对 **veth** 把它们连起来，加一台网桥，配好 **NAT** 让其中一个
能上网，然后用 `ping`、`ip route` 和 `tcpdump` 逐项验证。之后再讲它到底有什么用、又会在
哪里坑你。

## 为什么网络命名空间可行：一个内核，多个网络栈

一个网络命名空间，是内核对整个网络栈的一份拷贝：它有自己的网卡、自己的路由表、自己的
`iptables`/`nftables` 规则、自己的 socket 空间。命名空间里的进程只看得到自己那一个空间。
这正是容器所获得的隔离——Docker、Podman、Kubernetes 都是把容器的网络放进一个命名空间。
当你执行 `ip netns exec ns1 ping 10.0.0.2` 时，你就在 `ns1` 的世界里，而 `ns1` 的内核网络
是完全真实的，只是被默认命名空间（宿主机）隔开了。

它们很便宜。没有虚拟机、没有 hypervisor、没有第二个内核。创建一个命名空间实际上相当于
一次 `mount --bind`，它和其余一切共享同一个内核。

## 第 1 步——创建两个命名空间

这里所有操作都需要 `CAP_NET_ADMIN`，所以用 `sudo` 跑（或者在特权容器里跑）。`ip netns`
是前端命令；它还会挂载一个按命名空间划分的 `/var/run/netns` 句柄，让你可以用名字来引用
一个命名空间。

```bash
# 创建两台隔离的主机
sudo ip netns add ns1
sudo ip netns add ns2

# 确认
ip netns list
```

正是这个句柄让你可以写 `ip netns exec ns1 ...`，而不必去摆弄 PID。每个命名空间一开始只有
一个 lo 环回接口，而且它的环回是**处于 down 状态**的。记住这一点——它是那个经典 bug 的
根源。

```bash
sudo ip netns exec ns1 ip link show
```

## 第 2 步——接上 veth 对

一对 **veth** 就是两个被死死绑在一起的虚拟网卡：从一端进去的，会从另一端出来，像一根
两端各带一个插头的网线。你先创建这对网卡，然后把两端分别挪进两个命名空间。

```bash
# 一根有两个头的网线，两头一开始都在宿主机
sudo ip link add veth1 type veth peer name veth2

# 一头插进 ns1，另一头插进 ns2
sudo ip link set veth1 netns ns1
sudo ip link set veth2 netns ns2
```

现在两端各住在不同的网络栈里。宿主机已经看不到 `veth1` 或 `veth2` 了；它们只存在于各自的
命名空间内。这就是全部的诀窍——一根跨两个网络栈的线。

## 第 3 步——分配地址并 ping 通

配置地址、把网卡拉起。环回不管怎样都得 `up`，因为很多软件默认它一定存在。

```bash
# ns1
sudo ip netns exec ns1 ip addr add 10.0.0.1/24 dev veth1
sudo ip netns exec ns1 ip link set veth1 up
sudo ip netns exec ns1 ip link set lo up

# ns2
sudo ip netns exec ns2 ip addr add 10.0.0.2/24 dev veth2
sudo ip netns exec ns2 ip link set veth2 up
sudo ip netns exec ns2 ip link set lo up
```

两端都在同一个 `/24` 上拉起后，内核会自动装上一条直连路由（给网卡加地址就会为该子网
创建路由）。跨这根线 ping：

```console
$ sudo ip netns exec ns1 ping -c2 10.0.0.2
PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.
64 bytes from 10.0.0.2: icmp_seq=1 ttl=64 time=0.061 ms
64 bytes from 10.0.0.2: icmp_seq=2 ttl=64 time=0.063 ms
```

`ttl=64` 说明没有任何路由参与——这就是同一根线上的两台主机。看一下路由表，弄清它为什么
能通：

```console
$ sudo ip netns exec ns1 ip route
10.0.0.0/24 dev veth1 proto kernel scope link src 10.0.0.1
```

就一条直连路由，没有默认路由。`ns1` 够得着 `ns2`，是因为两者都落在 `10.0.0.0/24` 这个
"on-link" 范围里。如果你把它们的地址指到不同子网、中间又没有路由器，它立刻就通不了了——
而这正是要记住的教训。

## 第 4 步——在中间放一台网桥

一对 veth 是一条点对点的线，所以它只能连两台主机。要造一台能连好几台的交换机，就用
**network bridge（网桥）**——一个软件二层交换机。在宿主机里创建它，然后把每个命名空间那
一端的网卡挂进去做从属。

```bash
# 宿主机里的一台虚拟交换机
sudo ip link add br0 type bridge
sudo ip link set br0 up

# 再建两个命名空间"主机"
sudo ip netns add ns3
sudo ip link add veth3 type veth peer name br-veth3
sudo ip link set veth3 netns ns3
sudo ip link set br-veth3 master br0   # 靠宿主机那端插进交换机
sudo ip link set br-veth3 up

# ns3 接上交换机
sudo ip netns exec ns3 ip addr add 10.0.0.3/24 dev veth3
sudo ip netns exec ns3 ip link set veth3 up
sudo ip netns exec ns3 ip link set lo up
```

现在 `ns3` 和 `ns1`、`ns2` 处在同一个二层网段上——只要它们也在交换机上，三者就都能互相
ping，网桥会学习它们的 MAC。网桥的行为就像一台非网管交换机：对未知目的泛洪、学习源 MAC、
然后转发。要把 `ns1`/`ns2` 也挪上来，就给每个命名空间各建一根靠宿主机的 veth，同样
`master` 到 `br0` 上。

## 第 5 步——加 NAT，让命名空间能上公网

现在是好玩的部分：给一个命名空间配上网关，让它能到达外面的世界。宿主机就是我们的路由器。
需要两件事：在宿主机上**开启 IP 转发**，以及在宿主机的出网卡上对命名空间的源地址做
**伪装（masquerade，即 NAT）**。

先给这个"局域网"建一条专用链路/命名空间，并让宿主机在这条线上占一只脚。我为命名空间规划
`10.99.0.0/24`，让宿主机拥有 `10.99.0.1`：

```bash
# 一根从宿主机通进命名空间的 veth，这个命名空间将作为我们的"外部"主机
sudo ip netns add ns4
sudo ip link add veth4 type veth peer name host-veth4
sudo ip link set veth4 netns ns4
sudo ip addr add 10.99.0.1/24 dev host-veth4
sudo ip link set host-veth4 up

# ns4 这一侧
sudo ip netns exec ns4 ip addr add 10.99.0.2/24 dev veth4
sudo ip netns exec ns4 ip link set veth4 up
sudo ip netns exec ns4 ip link set lo up

# ns4 把宿主机当作它的网关
sudo ip netns exec ns4 ip route add default via 10.99.0.1
```

接着把宿主机变成一台 NAT 路由器。先找到宿主机真正的出网卡——我这里假设是 `eth0`。

```bash
# 1. 让内核允许转发
sudo sysctl -w net.ipv4.ip_forward=1

# 2. 改写从 eth0 出去的命名空间流量的源地址
sudo nft add table ip nat
sudo nft 'add chain ip nat postrouting { type nat hook postrouting priority srcnat; }'
sudo nft add rule ip nat postrouting ip saddr 10.99.0.0/24 oifname "eth0" masquerade
```

如果你用的是旧工具链，`iptables` 的等价写法就一行：

```bash
sudo iptables -t nat -A POSTROUTING -s 10.99.0.0/24 -o eth0 -j MASQUERADE
```

现在 `ns4` 可以按 IP ping 通公网了：

```console
$ sudo ip netns exec ns4 ping -c2 1.1.1.1
64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms
```

注意 `ttl=57`：这些包被路由过了（在宿主机那里从 64 掉一跳，然后真实互联网又吃掉几跳）。
DNS 还没有配——那是另一件事，所以 `ping 1.1.1.1` 能通，而 `ping example.com` 要等你往这个
命名空间的 `/etc/resolv.conf` 里写了东西才行。

## 用 ip route、ping 和 tcpdump 验证

三件工具足以证明一切。`ip route` 告诉你这个网络栈*以为*自己能怎么走；`ping` 证明数据通路
真的存在；`tcpdump` 让你直接看到那些包本身。

```bash
# ns4 眼里的世界是什么样的？
sudo ip netns exec ns4 ip route
# default via 10.99.0.1 dev veth4
# 10.99.0.0/24 dev veth4 proto kernel scope link src 10.99.0.2

# 观察这个"发卡弯"：包到达 veth4 时还没被 NAT，
# 出发经过 eth0 时已经变成 NAT 过的样子
sudo ip netns exec ns4 tcpdump -ni veth4 icmp
```

"啊哈"时刻就发生在 `tcpdump` 里。在 `ns4` 内部，看一个发往 `1.1.1.1` 的包的源地址：它是
`10.99.0.2`，私有地址。在宿主机上，`tcpdump -ni eth0 icmp` 会显示同一个包，源地址是
`203.0.113.7`——宿主机的地址。这一对抓包就是 NAT 的全部：一次按连接的源地址改写，再加上
返程方向的反向翻译。它和我
在[《NAT 穿透到底是怎么工作的》](/zh/posts/nat-traversal-explained/)里拆开的机制完全一样，
只不过在这里你能亲眼看着它跑。

## 它到底有什么用

这可不是什么花架子；它是不建实验室就能测网络代码的方式。

- **overlay 和 VPN 配置。** 你可以在单台主机上搭出一张由"远端"命名空间组成的假 WAN，
  在碰真实硬件之前，先测 overlay 的路由安装、MTU 处理和 NAT 穿透行为。这是在可复现的
  沙盒里快速验证某个东西——比如[一张私有 mesh VPN](/zh/posts/private-mesh-with-easytier/)——
  的最快办法。
- **复现路由 bug。** "我在局域网里好好的，一走隧道就不行"，通常都是 MTU、路由或者反向
  路径过滤的问题。命名空间让你能重现出一模一样的拓扑，几秒钟内二分定位。
- **CI。** 内核命名空间创建起来廉价又快速，这正是网络测试套件（以及容器运行时、overlay
  的集成测试）用它的原因。并行 CI 任务之间的隔离，白送。
- **学习。** 想真正*看见*"默认网关"只是条路由、"网桥"只是台学 MAC 的交换机、"NAT"只是条
  改写规则，没有比它更好的办法了。

## 会浪费你一下午的坑

- **环回默认是 down 的。** 如果命名空间里 `ping 127.0.0.1` 不通，那就是你忘了
  `ip link set lo up`。没有它，很多守护进程会悄无声息地挂掉。
- **命名空间重启就没了。** 它们不持久。要么在脚本里重建，要么接受 `/run` 下的
  `ip netns` 句柄重启后消失。但凡需要可复现，就把整套设置包进一个能重跑的 shell 脚本。
- **`ip netns exec` 还是 `ip -n`。** 两者都行；`ip -n ns1 addr` 更短，但没法跑任意命令。
  当你要跑非 `ip` 的程序时，用 `ip netns exec`。
- **转发默认是关的。** 一个当路由器用的命名空间需要 `net.ipv4.ip_forward=1`。没有它，NAT
  悄无声息地什么也不做。
- **`rp_filter` 与非对称路径。** 开着严格反向路径过滤时，来自命名空间的包可能因为返程
  路由"讲不通"而被丢掉。当你刻意搭非对称拓扑时，就把它放松
  （`net.ipv4.conf.*.rp_filter`）。
- **没有 DNS，也没有 ARP 帮忙。** 在你写进去之前，命名空间没有解析器；而网桥不会在子网
  之间做路由——它只在一个子网内做交换。
- **防火墙默认策略。** 如果命名空间连不到宿主机或公网，把命名空间*和*宿主机两边的
  `nft list ruleset` 都看一遍；任何一边有个 `DROP` 策略就足以掐死它。
- **清理。** `sudo ip netns delete ns1` 一次就把命名空间和它的网卡全删掉。删吧——忘了删会
  在宿主机里堆下一堆 veth 的残留端。

## 一段话总结

一个**网络命名空间**就是 Linux 网络栈的一份私有拷贝，一对 **veth** 就是两个命名空间之间的
一根网线。连两个命名空间，你就有了两台主机；在几台之间放一台**网桥**，你就有了交换机；
再加上 `ip_forward` 和一条 **MASQUERADE** 规则，宿主机就成了带 **NAT** 的路由器。用
`ip route`、`ping` 和 `tcpdump` 来验证——这三样会告诉你：网络栈是否相信自己能路由、包是否
真的在流动、以及它们在线上长什么样。这里没有任何一步需要 hypervisor、第二台机器或云账号：
它离你只有一条 `ip netns` 命令，而它正是容器和 overlay 所依赖的同一块底座。
