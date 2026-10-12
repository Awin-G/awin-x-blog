---
title: "用 EasyTier 搭建跨机器的私有 mesh VPN：一个 homelab 的 overlay 实践"
description: "我把一套 hub-and-spoke 的 WireGuard 换成了 EasyTier 的 mesh VPN：一个 overlay 网络名加一个密钥，节点之间尽力打洞走直连 P2P，走不通才回落到中继。这是一篇可照抄的 homelab 实操——安装、组网、验证路由、暴露服务。"
pubDate: 2026-10-14
lang: zh
translationKey: private-mesh-with-easytier
tags: [networking, self-hosting, homelab, easytier]
featured: false
keywords:
  - EasyTier 组网
  - 私有 mesh 网络
  - overlay 网络
  - WireGuard 替代
  - P2P VPN
---

我真正在意的每一台机器——一台开发机、自建的 Git 服务、对外提供这个站点的公网机——过去都挂在
一套 hub-and-spoke 的 VPN 上：一个常驻端点，所有机器都往它上面拨，每个包都要绕一个三角形，
而那个中心可能远在大洋彼岸。这篇文章讲的就是我怎么把这一切换成一张 **overlay 网络**：用
**EasyTier** 搭起来的私有 **mesh VPN**，每个节点都尽力直连彼此，只有在 NAT 挡路时才回落到中继。
这正是 homelab 想找一个 WireGuard 替代品时想要的那种 **overlay 网络**，只是不用再为每对节点
维护密钥。

我不打算把它说得多么玄乎。这里讲的是能落地的那一面：mesh 到底改变了什么、EasyTier 的模型是
怎么运作的、以及一套你可以直接抄的流程。凡是会随版本变动的地方我都会标出来，因为这样的地方
很多。

## mesh VPN 与 hub-and-spoke：overlay 究竟改变了什么

一套 hub-and-spoke 的 VPN（最典型的就是 WireGuard 加一台 VPS 当网关）有一个会随着机器变多而
毁掉一切的属性：**所有路径都要穿过 hub**。开发机访问 Gitea 是开发机 → hub → Gitea，哪怕这两台
机器就在同一个局域网里。这意味着 hub 承担全部带宽、成为单点故障，还给你定下一个客户端侧
无法消除的延迟下限。

**P2P VPN** 的 mesh 把默认行为反了过来。节点之间仍然需要*发现*彼此——依然要有一个汇合点——
但一旦打上照面，流量就可以走直连。hub 从"所有数据的承运人"降级成"牵线人"，只有当直连根本不
可能时，才需要一个中继。

第二个区别小一些，但每天都在起作用：mesh overlay 通常是一张**扁平的 L3 子网**。每个节点在同一
网段里拿到一个虚拟 IP（EasyTier 常用类似 `10.144.144.0/24` 这样的范围），从应用程序的视角看，
它就是一张普通的可路由网络。`ping tower`、`curl http://10.144.144.3:3000`、挂载 NFS 共享
——不需要为每个服务配隧道，也不需要为目标写一条 `wg-quick` 配置。

难点是所有 overlay 都要继承的同一个：**NAT 穿透**。两个都躲在 NAT 后面的节点没法直接互拨。
它们需要类似 STUN 的机制去发现自己的公网映射，再协同打洞，在两侧 NAT 上各开一个口子。这招
大多数时候管用。当 NAT 是对称型、或者防火墙很激进时就会失败，而失败正是中继存在的理由。

## EasyTier 是如何描述一张网络的

EasyTier 是去中心化的——没有客户端/服务端之分。任何能连上网络里任意一个节点的机器都能加入，
其余的 mesh 会逐渐学习到它。四个概念就能覆盖大部分内容。

### 身份就是"一个名字 + 一个密钥"

一张私有网络由两个字符串定义：**network name**（网络名）和 **network secret**（网络密钥）。
名字和密钥相同的两个节点就在同一张 overlay 里；密钥不对会被直接拒绝，而不是无限重试。整个
成员模型就这么简单——没有 CA，没有按用户的账号体系。这也正是它诚实的缺点：密钥*就是*边界，
所以要像对待 SSH 私钥那样对待它，而不是像对待一个能随手发出去的 Wi-Fi 密码。

### peer、中继与 P2P 路径

引导一个节点的方式，是把它指向一个或多个 **peer**（公网 IP、域名，或社区共享节点）。连接建立
之后，节点之间会交换可达性信息，并尝试把每条连接升级成直连的 P2P 链路。打洞成功，数据就点对
点流动；打洞失败，流量就经某一个双方都能连到的节点**中继**。中继就是普通基础设施，不是魔法
——它往往就是刚才牵线的那个节点，也正是你需要按容量去规划的那份资源。

### 类 OSPF 的路由

EasyTier 不走静态下一跳，而是让节点之间交换路由，各自基于一个 cost 度量算出最短路径。这就是
"类 OSPF"的那部分：加一个节点，mesh 重新收敛；某条链路变差，路径自动切换；链路中间的一个
节点可以替两个彼此看不见的节点充当转发。平时你基本不用关心它，但你*可以*去查看它——
`easytier-cli route` 会列出每个被通告前缀的下一跳和 cost，这正是你用来证明某条路径确实是直连、
而不是在偷偷中继的办法。

### 加密与信任模型

数据面默认用 AEAD 加密（可选 AES-GCM 或 ChaCha20-Poly1305），密钥来自那个**共享的网络密钥**，
所以在这里把它和 WireGuard 相提并论，公平但不够精确。和 WireGuard 一样，它是一条现代化的
加密隧道；但和 WireGuard 不同，它用的是从单一密钥派生出来的*全网*密钥，而不是按节点交换的
公私钥。较新的版本加入了基于 Noise 的安全握手，但信任锚点始终是你分发出去的那个密钥。它一旦
泄露，整张 overlay 会同时失守——没有按链路吊销这回事。

## 安装 EasyTier

有好几种受支持的安装方式，选一种即可。它们都会提供两个二进制：`easytier-core`（节点本身）和
`easytier-cli`（通过 RPC 与运行中的节点通信的客户端，RPC 默认端口 `15888`）。

```bash
# 1. 直接用预编译发行版：下载对应系统/架构的压缩包，解压后：
./easytier-core --version

# 2. 一键安装脚本（仅 Linux）——装到 /opt/easytier，并注册 systemd 服务：
wget -O /tmp/easytier.sh \
  "https://raw.githubusercontent.com/EasyTier/EasyTier/main/script/install.sh"
sudo bash /tmp/easytier.sh install

# 3. Docker：
docker run -d --privileged --network host easytier/easytier:latest
```

> 注意：安装方式、URL 路径，以及服务单元的准确名字都随版本变化。上面这些是你在 v2.x 各版本里
> 会看到的大致形状；请以你所使用版本的项目安装文档为准。

## 组建一张私有 mesh 网络

最短的版本就是命令行上的两个节点。第一个节点是你的"锚点"——它有一个其他节点能拨过去的稳定
地址：

```bash
# 在锚点节点上（给它一个固定的虚拟 IP）：
sudo easytier-core \
  --network-name awin-mesh \
  --network-secret "$(cat ~/.config/et/secret)" \
  --hostname anchor \
  --ipv4 10.144.144.1
```

```bash
# 在其他所有节点上（DHCP 式虚拟 IP，拨向锚点）：
sudo easytier-core \
  --network-name awin-mesh \
  --network-secret "$(cat ~/.config/et/secret)" \
  --hostname devbox \
  --dhcp \
  --peers udp://anchor.example.com:11010
```

`--peers` 接收的是一个 URL，所以传输方式是显式的：`udp://`、`tcp://`、`ws://`、`wg://`、
`quic://`。通常选 UDP，因为它最容易打洞成功。你可以列多个 peer 做冗余，而且最好让每个节点都
指向同一份列表，这样大家对"汇合点集合"的认知一致。默认监听端口是 `11010/tcp` 和 `11010/udp`；
RPC 门户默认是 `15888`。

对任何长期运行的东西，我都会用配置文件，而不是一条越写越长的命令行。它大致长这样（TOML，
用 `-c` 加载）：

```toml
instance_name = "default"
hostname = "devbox"
dhcp = true
listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010"]

[network_identity]
network_name = "awin-mesh"
network_secret = "REPLACE_WITH_YOUR_SECRET"

[[peer]]
uri = "udp://anchor.example.com:11010"

[[peer]]
uri = "udp://backup-relay.example.com:11010"
```

```bash
sudo easytier-core -c ./easytier.toml
```

> 配置文件的 schema 和键名会随版本变化。上面这套结构是 v2.x 中有代表性的写法；如果某个键被
> 拒绝，请运行 `easytier-core --help`，或直接用项目提供的在线配置助手为你当前的版本生成一份
> 文件，而不是靠猜。

## 验证连通性

别信"它启动了"。去问节点它自己知道些什么：

```bash
# 网络里有哪些节点，它们之间是直连还是中继？
easytier-cli peer

# 去往每个前缀的流量到底走哪，cost 是多少？
easytier-cli route

# 这个节点认为自己是啥（虚拟 IP、hostname、id）？
easytier-cli node
```

我看 `peer` 输出时盯的是：同一个局域网里的两个节点应该显示很低的 `cost` 和 `udp` 的
`tunnel_proto`（直连），而不是一个中继跳。如果所有东西都是 `cost = 2+`，多半就是在中继——
去看 `route` 里的 `next_hop` 列，把那多余的一跳修掉。而当 peer 列表有内容、ping 却仍然不通时，
几乎总是**主机防火墙**把虚拟网卡的入站流量丢了，而不是 overlay 的问题。

```bash
ping -c 3 10.144.144.2
```

## 在 mesh 之上暴露服务

一旦节点共享同一张扁平子网，最简单的做法就是让服务直接监听、然后用虚拟 IP 去访问——不用端口
转发，不用反向代理。这正是 L3 overlay 的意义所在。

当服务只能绑定到 localhost，或者节点没有 TUN 设备时（比如你用 `--no-tun` 启动它），就用
**port forward** 把一个本地 socket 桥接到虚拟网络上：

```bash
# 在本地绑定 127.0.0.1:8500，转发到 mesh 内的 10.144.144.3:3000：
sudo easytier-core \
  --port-forward tcp://127.0.0.1:8500/10.144.144.3:3000
```

目标必须是路由表里真实存在的虚拟 IP——它不会回落到宿主网络，所以一个笔误换来的是一条无声的
no-route，而不是连到错误的机器上。于是在另一头，`curl 127.0.0.1:8500` 就摸到了别的节点上的
服务。

## 当 NAT 赢了：中继、对称 NAT 与安全模型

关于局限，我得直说，因为营销文案从不会说。

- **NAT 穿透是尽力而为，不是保证。** UDP 打洞能穿过大多数家用路由器。对称型 NAT（在某些
  CGNAT 和移动网络里很常见）对它很不友好。EasyTier 也会用一套基于生日攻击的手法去对付对称
  NAT，但它可能被 ISP 限速甚至封禁——所以别做一套*必须*直连才能成立的方案。永远在 peer 列表里
  放一个公网可达的节点，并接受某些节点对只能走中继。
- **中继是失败回退路径，却处在关键路径上。** 如果你唯一的公网节点挂了，所有躲在 NAT 后面的
  节点就失去了汇合点。跑两个，最好在不同厂商那里。
- **密钥就是安全边界。** 加密默认开启，但成员校验靠的是共享密钥，数据密钥也由它派生。轮换
  密钥意味着同时重配所有节点；没有部分轮换。如果你要跑一个对外的节点，看看 private-mode 和
  relay-whitelist 这些选项，免得你的节点在悄悄替陌生人的流量做转发。
- **这并不等于"在线上隐形"。** overlay 把内部结构挡在公网之外，但加密传输仍然从真实的公网 IP
  发出，带着真实的时间特征。它是一张私有网络，不是 mixnet。

这些都不是否决项，它们只是"带回退的 P2P"这句话诚实的含义。

## mesh 里最小的那个节点

我比它的营销更相信 EasyTier 协议设计的原因，是我把它拆开过。我用纯 C 复刻了它的线协议，并在
**ESP32-C3** 上跑出了一个真实、可被 ping 通的 overlay 节点——那是一颗只有 400KB 内存的单片机。
这就是[完整的 ESPTier 实战记录](/zh/posts/esp32-easytier-node-in-c/)。如果这么小的节点都能维护
一张路由表、完成加密握手、并出现在 `easytier-cli peer` 里，那这里的"mesh"就是一套真正的协议，
而不是套在三个端点外面的壳。

这个博客就跑在同一张 overlay 上：Git 服务只能通过这条私有 mesh 访问，而构建这些页面的公网机
是在信任边界之内去拉取它的。那条流水线[在这里有完整记录](/zh/posts/how-this-blog-ships-itself/)。

## 动手之前我想告诉你的

挑一个公网节点当锚点，在另一个独立的地方再跑一个，把同一份 peer 列表放到每台机器上，然后用
配置文件，而不是一条你迟早会忘记的命令行。然后在你确信 mesh 是直连之前，用 `easytier-cli peer`
和 `route` 去验证——当你第一次看到某一对节点显示 `cost = 1` 和 `tunnel_proto = udp`，而它过去
一直要绕一台 VPS 走三角形时，你就会明白为什么这张 mesh 值得多出那点 NAT 穿透的复杂度。把中继
留在回退位置上，把密钥当密钥看待，这张 overlay 就会成为你 homelab 里最不起眼、也最可靠的那
一部分。
