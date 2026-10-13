---
title: "IPv6 SLAAC 与路由器通告：完整复现"
description: "无需 DHCP，主机如何自动获得 IPv6 地址——RS/RA 交换、前缀信息、A/M/O 标志、EUI-64 与稳定隐私地址、真实 radvd 输出。"
pubDate: 2027-01-16
lang: zh
translationKey: ipv6-slaac-and-ra
tags: [networking, linux]
featured: false
keywords:
  - IPv6 SLAAC
  - 路由器通告
  - radvd
  - EUI-64
  - RS RA
  - DHCPv6
---

如果你曾在 Linux 主机上启用 IPv6，然后发现一个全局地址在没有任何 DHCP 配置的情况下自动出现，那就是 **IPv6 SLAAC**（无状态地址自动配置）在起作用。本文在一次性 Docker 容器中完整复现整个流程——从路由器的 `radvd` 通告到主机自动配置地址——并逐一解释每个标志位和选项。

我们将覆盖：

- RS/RA 交换以及**路由器通告**的实际内容
- A/M/O 标志如何引导主机选择 SLAAC 或 **DHCPv6**
- **EUI-64** 与稳定隐私地址生成
- 从 RA 获取的默认路由
- 为什么"直接启用 IPv6"常常给你一个未加防火墙的全局地址
- 如何使用 `ip -6 addr`、`ip -6 route`、`rdisc6` 和 `tcpdump icmp6` 进行调试

## 实验环境

我在 Docker 网桥上运行了两个一次性 Debian 容器。路由器容器运行 `radvd`；主机容器只运行 `iproute2` 和 `rdisc6`。整个环境中没有任何 DHCP 服务器。

路由器的 `radvd.conf`：

```conf
interface eth0
{
    AdvSendAdvert on;
    AdvManagedFlag off;
    AdvOtherConfigFlag off;
    prefix fd00:dead:beef:1::/64
    {
        AdvOnLink on;
        AdvAutonomous on;
        AdvRouterAddr off;
    };
    RDNSS fd00:dead:beef:1::1
    {
    };
};
```

路由器分配了静态 ULA 地址：

```console
$ ip -6 addr add fd00:dead:beef:1::1/64 dev eth0
$ sysctl -w net.ipv6.conf.all.forwarding=1
net.ipv6.conf.all.forwarding = 1
```

## RS → RA 交换

当主机启用 IPv6 接口后，会向 `ff02::2`（所有路由器）发送**路由器请求（RS）**。路由器以**路由器通告（RA）**回复到 `ff02::1`（所有节点）。以下是路由器上用 `tcpdump` 捕获的 RA：

```console
$ tcpdump -i eth0 -vv icmp6
tcpdump: listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes
23:54:54.068011 IP6 (flowlabel 0x2b2df, hlim 255, next-header ICMPv6 (58) payload length: 80) fe80::f0d6:17ff:fe20:e09a > ip6-allnodes: [icmp6 sum ok] ICMP6, router advertisement, length 80
	hop limit 64, Flags [none], pref medium, router lifetime 1800s, reachable time 0ms, retrans timer 0ms
	  prefix info option (3), length 32 (4): fd00:dead:beef:1::/64, Flags [onlink, auto], valid time 86400s, pref. time 14400s
	    0x0000:  40c0 0001 5180 0000 3840 0000 0000 fd00
	    0x0010:  dead beef 0001 0000 0000 0000 0000
	  rdnss option (25), length 24 (3):  lifetime 600s, addr: fd00:dead:beef:1::1
	    0x0000:  0000 0000 0258 fd00 dead beef 0001 0000
	    0x0010:  0000 0000 0001
	  source link-address option (1), length 8 (1): f2:d6:17:20:e0:9a
	    0x0000:  f2d6 1720 e09a
```

关键字段解读：

| 字段 | 值 | 含义 |
|------|------|------|
| `hop limit` | 64 | 路由器建议的跳数限制 |
| `Flags [none]` | — | M=0, O=0（不使用 DHCPv6） |
| `router lifetime` | 1800s | 该路由器作为默认网关的有效时间 |
| `prefix info` | `fd00:dead:beef:1::/64` | 用于自动配置的子网前缀 |
| `Flags [onlink, auto]` | — | L=1（在链路上），A=1（自治/SLAAC） |
| `rdnss` | `fd00:dead:beef:1::1` | 递归 DNS 服务器 |
| `source link-address` | `f2:d6:17:20:e0:9a` | 路由器的 MAC 地址 |

主机的初始状态——只有链路本地地址，没有全局前缀：

```console
$ ip -6 addr show eth0
2: eth0@if1452: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default  link-netnsid 0
    inet6 fe80::7ca7:21ff:fe19:fad5/64 scope link tentative
       valid_lft forever preferred_lft forever
```

## A/M/O 标志

RA 头部的三个标志告诉主机如何配置自己：

- **M（Managed）** — 置 1 时，主机必须使用 **DHCPv6** 获取地址。M=0 时，主机使用 SLAAC。
- **O（Other）** — 置 1 时，即使地址使用 SLAAC，主机也应使用 **DHCPv6** 获取"其他"配置（DNS、NTP 等）。
- **A（Autonomous）** — 每个前缀独立标志。置 1 时，主机可以使用此前缀通过 SLAAC 自动配置地址。

在我们的捕获中，`Flags [none]` 表示 M=0、O=0，而前缀的 `Flags [onlink, auto]` 表示 A=1。纯 SLAAC，无 DHCPv6。

用 `rdisc6` 发送 RS 时，工具会自动解码 RA：

```console
$ rdisc6 -1 eth0
Soliciting ff02::2 (ff02::2) on eth0...

Hop limit                 :           64 (      0x40)
Stateful address conf.    :           No
Stateful other conf.      :           No
Router preference         :       medium
Router lifetime           :         1800 (0x00000708) seconds
 Prefix                   : fd00:dead:beef:1::/64
  On-link                 :          Yes
  Autonomous address conf.:          Yes
  Valid time              :        86400 (0x00015180) seconds
  Pref. time              :        14400 (0x00003840) seconds
 Recursive DNS server     : fd00:dead:beef:1::1
 Source link-layer address: F2:D6:17:20:E0:9A
 from fe80::f0d6:17ff:fe20:e09a
```

## SLAAC：主机如何构建地址

收到 RA 后，主机自动配置地址。结果如下：

```console
$ ip -6 addr show eth0
2: eth0@if1452: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP group default  link-netnsid 0
    inet6 fd00:dead:beef:1:c40f:92cc:4745:970e/64 scope global temporary dynamic
       valid_lft 86400sec preferred_lft 14400sec
    inet6 fd00:dead:beef:1:7ca7:21ff:fe19:fad5/64 scope global dynamic mngtmpaddr
       valid_lft 86400sec preferred_lft 14400sec
    inet6 fe80::7ca7:21ff:fe19:fad5/64 scope link
       valid_lft forever preferred_lft forever
```

出现了两个全局地址：

1. **临时地址**（`fd00:dead:beef:1:c40f:92cc:4745:970e`）— 稳定隐私地址，用于出站连接。其接口标识符随机生成并定期轮换。
2. **EUI-64 地址**（`fd00:dead:beef:1:7ca7:21ff:fe19:fad5`）— 从 MAC 地址派生，用于入站连接。

### EUI-64 推导

EUI-64 接口标识符从 48 位 MAC 地址计算：

```console
$ cat /sys/class/net/eth0/address
7e:a7:21:19:fa:d5
```

算法：

1. 将 MAC 地址分成两半：`7e:a7:21` + `19:fa:d5`
2. 在中间插入 `ff:fe`：`7e:a7:21:ff:fe:19:fa:d5`
3. 翻转第一个字节的第 7 位（U/L 位）：`7e` → `7c`（二进制 `01111110` → `01111100`）
4. 结果 IID：`7c:a7:21:ff:fe:19:fa:d5`
5. 完整地址：`fd00:dead:beef:1:7ca7:21ff:fe19:fad5`

与实际地址完全一致。

### 稳定隐私地址

临时地址使用**随机生成**的接口标识符，而非 EUI-64。这防止跨网络追踪——地址会随时间变化（默认优先使用临时地址，每 24 小时轮换）。内核同时创建 EUI-64 地址作为"管理临时地址"（`mngtmpaddr`），确保入站连接始终有稳定的目标地址。

## 默认路由

RA 还会安装默认路由。主机的路由表在 SLAAC 之后：

```console
$ ip -6 route show
fd00:dead:beef:1::/64 dev eth0 proto kernel metric 256 expires 86399sec pref medium
fe80::/64 dev eth0 proto kernel metric 256 pref medium
default via fe80::f0d6:17ff:fe20:e09a dev eth0 proto ra metric 1024 expires 1799sec hoplimit 64 pref medium
```

`default via` 行是路由器的链路本地地址，以 `proto ra` 安装——来自 RA，不是任何路由守护进程。

## 连通性测试

```console
$ ping6 -c 3 -I eth0 fd00:dead:beef:1::1
PING fd00:dead:beef:1::1(fd00:dead:beef:1::1) from fd00:dead:beef:1:c40f:92cc:4745:970e eth0: 56 data bytes
64 bytes from fd00:dead:beef:1::1: icmp_seq=1 ttl=64 time=0.123 ms
64 bytes from fd00:dead:beef:1::1: icmp_seq=2 ttl=64 time=0.073 ms
64 bytes from fd00:dead:beef:1::1: icmp_seq=3 ttl=64 time=0.052 ms

--- fd00:dead:beef:1::1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2068ms
rtt min/avg/max/mdev = 0.052/0.082/0.123/0.029 ms
```

零手动地址配置，端到端连通。

## SLAAC 与 DHCPv6 对比

| | SLAAC | DHCPv6 |
|---|-------|--------|
| 地址来源 | RA 中的前缀 + 自生成 IID | DHCPv6 服务器分配 |
| 默认路由 | 来自 RA | 来自 RA（或 DHCPv6） |
| DNS 服务器 | RA 中的 RDNSS 选项（或 DHCPv6） | DHCPv6 |
| M 标志 | 0 | 1 |
| O 标志 | 0 | 1（用于 DNS） |
| 需要服务器 | 否 | 是（DHCPv6 服务器） |
| 适用场景 | 家庭网络、简单部署 | 企业、策略控制 |

大多数家庭网络使用 SLAAC。M=1 / O=1 的组合常见于需要集中分配地址和分发 DNS 的企业环境。

## 为什么"直接启用 IPv6"可能是安全问题

当你在主机上启用 IPv6，且网络中有路由器发送 RA 时，主机会：

1. 自动配置全局地址（如果 A 标志置位）
2. 通过 RA 路由器安装默认路由
3. 开始使用 IPv6 发送流量——**无需你写任何防火墙规则**

如果你的防火墙只有 IPv4 规则，IPv6 流量将不受阻碍地通过。这就是"影子网络"问题：你以为没有全局 IPv6 暴露，但 SLAAC 悄悄给了你一个可路由的地址。

**缓解措施：** 如果你不需要 IPv6，明确禁用它：

```bash
sysctl -w net.ipv6.conf.all.disable_ipv6=1
sysctl -w net.ipv6.conf.default.disable_ipv6=1
```

或者，如果你需要 IPv6 但想控制它，设置 `accept_ra=0` 并手动配置地址，或者运行自己的 DHCPv6 服务器来实施策略。

## 调试

```console
# 显示所有 IPv6 地址
$ ip -6 addr show

# 显示 IPv6 路由（查找 "proto ra" 确认 RA 安装的路由）
$ ip -6 route show

# 检查 RA 接受状态
$ sysctl net.ipv6.conf.eth0.accept_ra net.ipv6.conf.eth0.accept_ra_defrtr

# 发送 RS 并解码 RA
$ rdisc6 eth0

# 捕获 RA/RS 数据包
$ tcpdump -i eth0 -vv icmp6

# 强制地址重新生成（临时地址）
$ sysctl -w net.ipv6.conf.eth0.use_tempaddr=2
```

如果 SLAAC 不工作，按顺序检查：

1. 接口上 IPv6 是否启用？（`disable_ipv6=0`）
2. 接口是否接受 RA？（`accept_ra=1`）
3. 路由器是否确实在发送 RA？（`tcpdump icmp6`）
4. RA 中 A 标志是否置位？（`rdisc6` 可解码）

## 总结

**IPv6 SLAAC** 是一个极其简洁的协议：路由器通告前缀，主机附加自生成的接口标识符，连通性就此建立。无需服务器、无需租约、无需手动配置。**路由器通告**不仅携带前缀，还携带标志位（A/M/O）、默认路由、DNS 服务器和生命周期信息。**radvd** 是标准的 Linux 守护进程，通过发送这些通告将主机变成 IPv6 路由器。

SLAAC 的简洁性既方便又容易被忽视——这正是理解 RA 数据包和标志位对每个管理网络的人至关重要的原因。

---

*相关文章：[IPv6 实用入门](/zh/posts/ipv6-practical-intro/) · [家庭网络中的 IPv6](/zh/posts/ipv6-at-home/)*
