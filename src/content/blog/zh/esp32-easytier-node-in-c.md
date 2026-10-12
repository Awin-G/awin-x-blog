---
title: "让 ESP32-C3 成为一个真正的 EasyTier 节点：用 C 复刻线协议"
description: "ESPTier 用纯 C 在 ESP32-C3 上复刻了 EasyTier v2.6.4 的线协议——TCP 分帧、SipHash-1-3 身份、AES-128-GCM、路由同步与转发——让一颗受限 MCU 成为 overlay 网络中真正可被 ping 通的一员。"
pubDate: 2026-10-13
lang: zh
translationKey: esp32-easytier-node-in-c
tags: [esp32, networking, embedded, c, easytier]
featured: true
keywords:
  - EasyTier ESP32
  - ESP32-C3 组网
  - 嵌入式 overlay 网络
  - EasyTier 线协议
  - ESP-IDF C
---

这个博客所依赖的一切都活在一张 overlay 网络之后：Git 服务、部署机、构建这些页面的那些
机器。如果你想看拓扑，这里有一篇[关于那条流水线的实战记录](/zh/posts/how-this-blog-ships-itself/)。
真正让我好奇的是拨号的另一头——一个节点可以小到什么程度，还能算这张 overlay 里
*一等*成员？不是"用自制协议把 IP 隧道过去"的设备，而是被原版 EasyTier 节点列出、
ping 通、并且替它转发流量的那种节点。

ESPTier 就是我的答案：用纯 C 复刻 EasyTier 真正的线协议，让同一份可移植核心既跑在
Linux 上，也跑在 ESP32-C3 上。这是一份实战记录——线协议真正要求了什么，ESP32-C3 上的
嵌入式组网哪些地方让人觉得"作弊"（是好的那种），哪些不觉得，以及我在哪里刻意停手。

## 这里的嵌入式组网，为什么必须是真线协议而不是仿制品

这个项目最省事的做法，是自创一个小型 UDP 协议，然后管它叫"overlay"。我以前干过，
而它通不过唯一重要的检验：原版项目的节点会不会把你当邻居？所以目标被冻结得毫不
光鲜——**EasyTier v2.6.4**，commit `8428a89d2dabc94c97d370ec607c6ca142473626`。
更老的 2.4.5 节点明确不在范围内；我宁愿对一个受支持的版本诚实，也不想对好几个含糊。

代码的形状来自一条约束：协议那一半不能知道自己跑在哪颗芯片上。`components/etcore`
是**无 OS 依赖**的可移植 C11——没有 `socket`、没有 `time`、没有 `rand`、没有 `printf`。
它只通过两个窄接口触达外部世界：`et_transport`（`connect / send / recv / close`，
面向 TCP 字节流）与 `et_platform`（`et_now_ms / et_fill_random / et_log`）。**同一份
源码**既能作为主机静态库编进 CMake，也能作为 ESP-IDF 组件编进 ESP-IDF v5.4。
Linux 那侧拿到的是 POSIX socket 和一块 TUN 设备；ESP32-C3 这侧拿到的是 lwIP socket、
`esp_timer`、`esp_random` 和 `ESP_LOG`。

这个切分不是为了架构洁癖。它意味着协议行为在两个目标上逐字节一致，于是某个在主机
单测里复现出来的握手 bug，在设备上就是*同一个 bug*——而主机测试一秒就能跑完，不必
等一轮烧录。

## 帧就是契约：逐字节的 EasyTier TCP 线协议

每条消息就是一个 TCP 帧：

```text
frame = [ u32 LE outer_len ][ PeerManagerHeader 16B ][ payload ]
```

没有 magic 前缀。所有多字节整数都是小端，protobuf varint 也是。16 字节的
`PeerManagerHeader` 里依次是 `from_peer_id`（u32）、`to_peer_id`（u32）、
`packet_type`（u8）、`flags`（u8）、`forward_counter`（u8）、`reserved`（u8）
和 `len`（u32）。

整件事系于一条很容易搞错的不变式：`outer_len` 数的是*线上真实字节*，而头里的
`len` 字段是**明文**载荷长度。未加密时两者相等；加密时线上长度是 `16 + 明文 + 28`，
多出来的 28 字节是 AEAD 尾巴（下面细说）。解码时，payload 切片按**真实帧长**选取，
绝不按 `hdr.len` 读。一个"撒谎的 `len`"就是一枚随时会炸的内存安全漏洞——而在 MCU 上
没有 MMU 兜你。

`len` 上限是 2000，所以一帧最多 2004 字节——这决定了静态接收缓冲区的大小，也就决定了
单条 peer 的 RAM 硬上限。本实现会用到的 `packet_type`：`Data=1`、`HandShake=2`、
`Ping=4`、`Pong=5`、`RpcReq=8`、`RpcResp=9`。flags 里有 `ENCRYPTED=0x01`、
`LATENCY_FIRST=0x02`、`EXIT_NODE=0x04`、`NO_PROXY=0x08`、`COMPRESSED=0x10`、
`NOT_SEND_TO_TUN=0x40`。

## 握手与 SipHash-1-3 身份

握手刻意做得简单，而且**不加密**。主动拨号的一侧先发 `HandshakeRequest`：一个
`magic` 常量（接收方甚至不校验它）、一个运行时随机的 `my_peer_id`、`version=1`、
`network_name`，以及一个**必须恰好 32 字节**的 `network_secret_digest`。对端回发
自己的请求。我们只校验 `packet_type==2` 和 `len(digest)==32`，然后从中取出对方的
`peer_id`。

身份本身来自 SipHash-1-3（`c=1, d=3`）配 `(0,0)` 密钥，这与 Rust 的 `DefaultHasher`
逐字节等价。先写入 `network_name` 再写入 `network_secret`，把 `finish().to_be_bytes()`
折回 hasher，就得到一个 32 字节 digest；对密钥单独做同样的构造，就得到加密用的 16 字节
`key128`。有个细节很容易踩：`finish()` **不消费也不重置**状态，后续 `write()` 会继续
累积。要是这里搞错，你的 digest 会看起来很像样、但其实是错的——这是最糟的那种错。

还有一个行为细节值得单独点出，因为它是"能互通"与"正确"之间的分界：如果对端返回的
digest 与我们不一致，连接会进入**终态 dead、永不重试**。密钥错误不是瞬时故障；对着一个
已经拒绝你密钥的节点反复猛敲，只是失礼。

## AES-128-GCM 与那 28 字节尾巴

载荷用 **AES-128-GCM** 加密，密钥由密钥派生而来、是**网络级共享**的，不是逐会话的。
只加密载荷——16 字节的头留在明文。随载荷带上一个随机 12 字节 nonce，AAD 为空，
帧尾变成 `tag(16) || nonce(12)`，tag 在前，并置上对应的 `ENCRYPTED` 标志。

对受限目标来说有两点要紧。其一，nonce 来自注入的 RNG 回调；RNG 一旦失败，我们会
**拒绝发出这个包**，而不是降级成一个可预测的 nonce。其二，`HandShake`、`Ping`、
`Pong` 永不加密，而 `Data`、`RpcReq`、`RpcResp` 永远加密。AES-GCM 底层是 vendored
进来、主机与设备共用的，所以这最吓人的部分只有一份实现。

## 路由同步，才是你能被 ping 通的原因

握手成功只给你一条活的 TCP 连接，仅此而已。要被*寻址*，你还得同步路由表，而真实
EasyTier 的假设正是在这里咬人。

同步走 RPC 层，用 `OspfRouteRpc`、`method_index=1`，`domain_name` 设为网络名。
信封是 `RpcPacket`，以加密的 `RpcReq`/`RpcResp` 承载。一颗地雷：`compression_info`
必须为 `None`，而且**不得**暴露 `accepted_algo=Zstd`——否则对端会很乐意给你发
Zstd 压缩的 RPC body，而你解不开。宣告一项自己没实现的能力，就是一场自找的故障。

请求里带着你的 `peer_id`、一个稳定的 `session_id`、`is_initiator=true`，以及一串
`RoutePeerInfo`。关键约束是：EasyTier 解析 IP→peer **只走路由表**，而且它会**跳过
任何 `version` 为 0 的 peer**。所以除非你广播一条 `version >= 1` 的、属于你自己的
`RoutePeerInfo`，否则你根本不可能被 ping 到——没有第二条路。此外还得在 90 秒内刷新，
不然这条 peer 会被老化淘汰（`REMOVE_UNREACHABLE_PEER_INFO_AFTER`）。我们把自身地址
以大端 4 字节整数广播（`10.9.9.9` 即 `0x0A090909`）、24 位前缀，以及一个
`"2.6.4-esptier"` 的 `easytier_version` 字符串——这样在 peer 列表里一眼就能看出哪个
节点是那个异类。

此外还有一张全局邻接矩阵 `conn_bitmap`，每个 (源, 目的) 对映一个位，按每字节 LSB
优先打包。一条花了我一阵子才内化的规则：你必须广播*整张已知矩阵*，而不只是自己那一行。
链式拓扑只有在每个节点都替邻居转发它们的行时才会收敛。

## 转发：成为一个中转跳

路由一通，中继这件事的核心就变成了"别做多余的事"。`to_peer_id` 是**最终**目的地，
不是下一跳。`forward_counter` 从 1 起始、逐跳自增，超过 7 就丢帧——这是给一张没有全局
拓扑视图的网络准备的廉价环路护栏。中转节点**不**解密也不重新加密：载荷逐字节搬运，
头字段原样不动。

下一跳走"反向路径"——即我们学到这条路由的那条连接——而不是一次 Dijkstra 计算。这是
一个刻意的简化，对我们针对的树状拓扑够用。而 `HandShake`、`Ping`、`Pong` 会被中转节点
完全丢弃，因为它们是逐连接语义，不是端到端的。最后这条规则由一个怪癖兜住：EasyTier 在
用 `Pong` 回应 `Ping` 时只交换 `packet_type`，`to_peer_id` 仍指向**对端自己的 id**。
把这三类包一律放在连接层处理、永不放进转发路径，一切就对上了。

## 从主机仿真到真机：M0 到 M6

我按编号里程碑来建，全部合进了 `master`，每一条都是可被证伪的断言：

- **M0** —— 仓库骨架、主机构建、能跑 `idf.py build` 的 ESP32-C3 骨架，外加
  SipHash-1-3、protobuf 原语和黄金向量生成器。
- **M1** —— `PeerManagerHeader`/TCP 分帧、`HandshakeRequest`，以及由 fake transport
  驱动的 peer 状态机。
- **M2** —— 真实握手加 AES-128-GCM；主机仿真加入真实网络，并靠 Ping/Pong 保活稳定
  保持 `UP`。
- **M3** —— 双向的最小 `SyncRouteInfo`；我们出现在 `easytier-cli peer` 里，并能被
  真实节点 ping 通。
- **M4** —— 裸 IPv4 数据面：ICMP echo 应答与 UDP 回显，跨节点往返成功。
- **M5** —— ESP32-C3 接入真实 Wi-Fi，在真机上复现 M3/M4。
- **M6** —— 多直连 peer、全局邻接矩阵、按目的转发，于是真实节点能*经由*我们的中转
  节点路由。

## 跑起来：先主机，再开发板

主机路径不需要硬件、也不需要特权，如果你想亲眼看它工作，我会从这里开始：

```bash
cmake -S . -B build && cmake --build build
scripts/testnet.sh up
build/apps/host_sim/host_sim --network-name et_test --network-secret et-test-secret \
  --peer 127.0.0.1:11110 --my-ipv4 10.9.9.9/24 --hostname nodeA
# 另一个 shell 里：
easytier-cli -p 127.0.0.1:15988 peer
```

`easytier-cli peer` 的输出里应该出现 `10.9.9.9/24 nodeA`，`version=2.6.4-esptier`。
注意端口纪律：这里全程只用**测试**端口（listener `11110`、RPC `15988`）。同一台机器
上可能已有生产 overlay 在监听 `11010`/`15888`，脚本会拒绝启动，而不是去踩它。

在开发板上，同一份核心在 ESP-IDF v5.4 下编译：

```bash
scripts/install_idf.sh
. ~/dev/tools/esp/esp-idf/export.sh
cd apps/esp32
idf.py set-target esp32c3
idf.py -p /dev/ttyACM0 flash monitor
```

设备作为 Wi-Fi **STA** 主动拨向对端主机，所以它需要一个 2.4GHz 的 AP（ESP32-C3 只支持
2.4GHz），并且主机防火墙要放行入站的 `11110/tcp`。一次成功的启动会打印
`WiFi connected, got IP ...`，随后是 `peer <id> UP`。再往后，`scripts/e2e_m5.sh` 会
起一个真实节点、烧录开发板、以有界超时抓取串口日志，并同时断言设备出现在真实节点的
peer 列表里、以及 UDP/ICMP 往返成功。

## 它在芯片上的代价，以及我刻意不做的事

轮询任务跑在 **24KB** 栈上。这个数字不是随手定的：M6 的同步路径会把路由请求编码、RPC
信封和 `conn_bitmap` 暂存缓冲嵌在 peer TX 帧缓冲之下，16KB 开始不够用了。核心最多支持
4 个直连 peer，每个约 4KB 接收缓冲，且运行时不做内存增长。当前设备固件只接一个 peer
（slot 0）；多 peer 与转发是在主机侧验证的，而 ESP32-C3 没有 PSRAM 可以借。

我也想同样清楚地说明边界。**没有** NAT 打洞、中继发现、公共服务器发现。选路是反向
路径，不是完整 OSPF/Dijkstra。secure mode、Noise 握手和 credential 都未实现——只有
传统路径。非 TCP 隧道（UDP、WS、WG、QUIC）、LAN 广播发现、IPv6、压缩、ACL、
exit-node、Magic DNS 一概没有，2.4.5 互通也在范围外。开发主机上还没有 `tcpdump`，
所以 M4/M6 的中转是用路由表的 `next_hop_ipv4` 加上应用层计数（`UDP_REPLY`/`ICMP_REPLY`）
来证明的，而非字节级 `.pcap`。如果你要线上证据，可以通过项目的抓帧代理把 RPC 流抓成
fixture——这正是握手与路由编码器测试的做法。

这份清单很长，但这正是重点。让一颗受限 MCU 成为真实 mesh VPN 的正牌成员，不在于把
EasyTier 整个重写一遍，而在于**精确地**实现那个可互通子集、用里程碑逐条证明每个断言，
并知道——且说出——子集在哪里结束。这跟[这套栈的其余部分](/zh/posts/how-this-blog-ships-itself/)
做的是同一桩买卖：挑一个小面、把它自动化、对边界保持诚实。
