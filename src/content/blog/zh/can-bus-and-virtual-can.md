---
title: "Linux 上用 vcan 跑 CAN 总线：不用硬件就能学的嵌入式组网"
description: "在 Linux 上用 SocketCAN 和虚拟 vcan0 接口搭起一条 CAN 总线：真实帧、真实的仲裁规则、candump、cansend、cansniffer、CAN-FD，以及通往真实硬件的路径。"
pubDate: 2027-02-11
lang: zh
translationKey: can-bus-and-virtual-can
tags: [embedded, networking]
featured: false
keywords:
  - CAN 总线
  - SocketCAN
  - vcan
  - candump
  - CAN 仲裁
---

我学 **CAN 总线**的方式，是从没碰过一条真总线。Linux 给你一个离 `ip link add`
只有一条命令之遥的虚拟 CAN 接口，而整套工具链——SocketCAN 加上 `candump`、
`cansend` 这些伙伴——在车上的表现和在笔记本上别无二致。我就是这样从"CAN 是汽车
上那个东西"走到能读帧、能过滤帧、能理解仲裁的，全程没有收发器，也没有 ECU。

下面每一条命令和每一段输出，都出自我开发机上一次临时容器
（`ubuntu:24.04`、`--cap-add=NET_ADMIN`、不加 `--privileged`）。`can-utils` 和
`iproute2` 原本没有安装；我在容器里装上了它们，现在容器没了，它们也没了。全篇只有
一处用模型代替了真实总线，那一处我明确标注了。

## CAN 是什么：一条没有地址的总线

CAN（Controller Area Network）是一条广播式、多主机的总线，为汽车和工业控制而生。
它的规格里有三个性质，比其余一切都重要：

- **没有地址。**一帧只有一个消息 ID 和最多八个字节的载荷，总线上每个节点都会
  收到它。帧里没有"节点地址"这种东西。
- **消息 ID 携带优先级。**ID 命名的是*消息*，不是发送者，ID 越小优先级越高。
- **接入方式是 CSMA/CR。**两个主机同时开口时，竞争者按位化解冲突，而不是把帧撞毁。
  没有任何东西会丢失，也不需要重传定时器——输的那一方静默下来，等当前这一帧结束后
  重发。

物理上它是一对差分线（CAN_H/CAN_L），用显性 0 与隐性 1 传输，这正是它能在汽车的
电磁环境里活下来的原因。经典 CAN 跑 500 kbit/s 或 1 Mbit/s，两端各一个 120Ω 端接
电阻把反射压下去。

## 帧：11 位与 29 位 ID、DLC 与数据

帧有两种格式：CAN 2.0A（"标准"）用 11 位 ID，即 0x000–0x7FF；CAN 2.0B（"扩展"）用
29 位。两者都带一个 DLC（数据长度码，0–8）和最多八个字节的载荷，另外还有一种远程帧
变体，用来请求节点发送某个 ID。

把虚拟接口拉起来，发一帧试试：

```text
$ ip link add dev vcan0 type vcan
$ ip link set up vcan0
$ ip -details link show vcan0
3: vcan0: <NOARP,UP,LOWER_UP> mtu 2060 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/can  promiscuity 0  allmulti 0 minmtu 0 maxmtu 0
    vcan addrgenmode eui64 numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535 tso_max_size 65536 tso_max_segs 65535 gro_max_size 65536
```

`link/can` 就是标记：这是一个 SocketCAN 接口，你对真实 `can0` 能做的事这里都能做。
现在发一个标准帧，再发一个扩展帧：

```text
$ cansend vcan0 123#DEADBEEF
$ cansend vcan0 12345678#DEADBEEF
$ candump vcan0
  vcan0  12345678   [4]  DE AD BE EF
  vcan0       123   [4]  DE AD BE EF
```

`123#DEADBEEF` 是 11 位 ID `0x123`、DLC 4、载荷 `DE AD BE EF`；`12345678#...` 是
29 位 ID。（`candump` 把 ID 右对齐，所以你一眼就能看出哪一帧是扩展帧。）远程帧是
个特例：

```text
$ cansend vcan0 123#R
$ candump vcan0
  vcan0  123   [0]  remote request
```

故意按没排过序的次序发几帧，`candump -L`——即在标准输出上用日志文件格式——会把同样
的帧带上时间戳和线格式原样打出来，这正是你该贴进 bug 报告里的东西：

```text
$ candump -L vcan0
(1791967959.294730) vcan0 456#01
(1791967959.295476) vcan0 123#02
(1791967959.296132) vcan0 7DF#03
(1791967959.296800) vcan0 000#04
```

## 为什么 ID 不是地址

既然每个节点都会收到每一帧，ID 就是一封邮件的*主题行*，不是收件人。关心门开关的
车身控制模块会听 `0x1A0`；不关心的发动机控制器直接忽略它。这正是从 TCP/IP 或
Modbus 过来的人最容易绊倒的地方：总线上没有任何东西把你的帧路由给某个节点，发送方
也不知道、不在乎有没有人在听。

过滤是总线保持廉价的手段，它发生在控制器里（MCP2515 用两个接收缓冲上的掩码和过滤
器在硬件中完成）、内核的每个 socket 上，或者你自己的进程里。同一个接收过滤器用几行
C 写出来是这样，这里只接受 `0x123`：

```c
struct can_filter rfilter[1];
rfilter[0].can_id = 0x123;
rfilter[0].can_mask = CAN_SFF_MASK;   /* 11 位必须全部匹配 */
setsockopt(s, SOL_CAN_RAW, CAN_RAW_FILTER, rfilter, sizeof(rfilter));
```

在那个程序阻塞在 `read()` 的时候，`456`、`123`、`7DF`、`456`、`123` 五帧被发到总线
上，它只被其中一个唤醒：

```text
received can_id=0x123 can_dlc=3 data=C0 FF EE
```

`candump` 在命令行上有同样的能力，这是把一条繁忙总线快速收窄到一条消息的办法：

```text
$ candump vcan0,123:7FF
  vcan0  123   [1]  AB
  vcan0  123   [1]  CD
```

`123:7FF` 的意思是"接受 ID 0x123，把整个 11 位 ID 域当掩码"。同时发出去的 `456` 和
`7DF` 两帧从未出现。

<figure>
<svg viewBox="0 0 640 268" width="100%" role="img" aria-label="两个节点在仲裁：节点 A 发 0x456，节点 B 发 0x123。它们的 ID 在最高位上就分出了胜负：A 写隐性 1，B 写显性 0，于是 A 静默，0x123 得到总线，A 在当前帧结束后重试。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="46" y="150" width="180" height="54" rx="8"/>
    <rect x="414" y="150" width="180" height="54" rx="8"/>
    <line x1="136" y1="204" x2="136" y2="244" stroke-dasharray="5 4"/>
    <line x1="504" y1="204" x2="504" y2="244"/>
    <line x1="70" y1="247" x2="570" y2="247" stroke-width="6" opacity="0.35"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="136" y="182">节点 A</text>
    <text x="504" y="182">节点 B</text>
    <text x="320" y="46">第一个不同的位：显性 0 胜过隐性 1</text>
    <text x="136" y="132" opacity="0.85">0x456</text>
    <text x="504" y="132" opacity="0.85">0x123</text>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15" text-anchor="middle">
    <text x="136" y="112" fill="currentColor">10001010110</text>
    <text x="504" y="112" fill="currentColor">00100100011</text>
  </g>
  <g stroke="#0f766e" stroke-width="2">
    <line x1="106" y1="118" x2="122" y2="118"/>
    <line x1="474" y1="118" x2="490" y2="118"/>
    <line x1="106" y1="140" x2="122" y2="140"/>
    <line x1="474" y1="140" x2="490" y2="140"/>
    <line x1="106" y1="118" x2="106" y2="140"/>
    <line x1="122" y1="118" x2="122" y2="140"/>
    <line x1="474" y1="118" x2="474" y2="140"/>
    <line x1="490" y1="118" x2="490" y2="140"/>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="136" y="264">停止发送，等这一帧结束后重试</text>
    <text x="504" y="264">赢得总线，帧继续发送</text>
    <text x="320" y="140" opacity="0.9">0x123 作为胜出的帧离开总线</text>
  </g>
</svg>
<figcaption>仲裁一位一位地决定，最高位在前。一个节点写隐性 1，另一个写显性 0，写 1 的那个读到不一致就立刻认输——所以优先级更低的 ID 从构造上就不可能赢，输家的帧稍后会重发。因为仲裁不具破坏性，没有任何带宽被冲突浪费掉。</figcaption>
</figure>

## 仲裁：为什么更低的 ID 会赢

CSMA/CR 是这样工作的：发送前和发送中，每个节点都在监听（载波侦听）。ID 域按最高位
优先的顺序发出。一个节点写了 1 却读回 0，就知道有别人在写更重要的那一位，于是停止
发送，等下一个空闲。两个 ID 第一个不同的那一位，决定了胜负。

两个发送方在我的 `vcan0` 上同时猛发 `456#01` 和 `123#02`，dump 出来是这样——之后的
计数才是关键：

```text
$ grep -c '456#01' /tmp/arbitration.log
6591
$ grep -c '123#02' /tmp/arbitration.log
6597
$ head -4 /tmp/arbitration.log
(1791967965.300812) vcan0 456#01
(1791967965.300898) vcan0 123#02
(1791967965.301452) vcan0 456#01
(1791967965.301610) vcan0 123#02
```

诚实地说清楚这部分：**vcan 不仲裁。**没有物理总线，没有显性与隐性电平，也就没有
可仲裁的东西——内核只是按到达顺序把帧交给接口的发送队列，这就是两个 ID 大致均匀交
替、而不是 `0x123` 把 `0x456` 饿死的原因。为了看到规则本身，我把总线的判决过程写成
了六十行 C（这是一个模型，不是抓包）：

```text
$ ./arb 456 123
  A id=0x456  10001010110
  B id=0x123  00100100011

  at bit 10: A sends 1, B sends 0 -> B drives dominant, A loses
  loser goes silent and retries after the current frame ends
  => the frame now on the bus is id=0x123

$ ./arb 7DF 1A0
  at bit 10: A sends 1, B sends 0 -> B drives dominant, A loses
  => the frame now on the bus is id=0x1A0
```

这就是 CAN 服务质量的全部：最低的 ID 永远能通过。狂发低 ID 的节点会把其他所有人饿死
——这是真实且常见的总线故障。高频率的消息应该拿低 ID，而总线负载超过大约 60–70% 之
后，你看到的会是延迟毛刺而不是丢帧。ID 不是一个名字，它是一张进入总线队列的门票，
所以要谨慎挑选。

## vcan：同一条总线，去掉电线

`vcan` 是内核里的虚拟 CAN 总线：你发出的帧立刻被投递到同一个接口的接收队列，不去别
的地方。没有丢帧、确认、错误或仲裁——而这正是它有用的原因。你拿到的是真实的
SocketCAN ABI、真实的帧解析、真实的 `can-utils`，却没有一点物理层的负担。我整套测试台
就是这些：

```text
$ docker run -d --name vcan-lab --cap-add=NET_ADMIN ubuntu:24.04 sleep 1200
$ docker exec vcan-lab apt-get install -y iproute2 can-utils
$ docker exec vcan-lab ip link add dev vcan0 type vcan
$ docker exec vcan-lab ip link set up vcan0
```

容器一退出，一切就消失。它是下面这些事情的正确环境：开发解码器、重放现场服务电话里
抓回来的日志（`canplayer`）、针对一台模拟 ECU 跑 CI 测试，或者开一场收发器预算为零的
工作坊。

## 工具：candump、cansend、cansniffer 及其他

`can-utils` 小到可以完全掌握。`candump` 读总线（`-L` 加时间戳，`<id>,<id>:<mask>`
过滤），`cansend` 写总线，`cansniffer` 给你一个按 ID 排序的实时视图——每个消息一行，
带每窗口帧计数，这是你在陌生总线上找 ID 的办法（我剥掉了终端转义序列，它才能被粘贴
下来）。`cangen`、`canplayer` 和 `cangw` 网关补全了这个集合；网关在两个接口之间转发
帧，这就是你用两个 `vcan` 接口加一个真实适配器拼出一套测试台的方法。

```text
$ cansniffer vcan0
00001 | 123 | DE AD BE EF             ....
00001 | 1A0 | 01 02 03 04 05 06 07 08 ........
00001 | 456 | CA FE                   ..
```

想知道总线忙不忙，`canbusload` 按标称比特率估算出线上的比特数——下面这个数字是发送
循环跑着的时候，一条假设 500 kbit/s 的 `vcan0` 上的 27%。各列依次是收到的帧数、占用
的总比特数、载荷占用的比特数；比特率必须显式给出，因为虚拟接口没有这个参数。

```text
$ canbusload vcan0@500000
 vcan0@500000  1430  135850  45760      0  27%
```

接口自己的计数器就是普通的链路统计，形状和 `eth0` 一模一样：

```text
$ ip -s link show vcan0
    RX:  bytes packets errors dropped  missed   mcast
         32004   17795      0       0       0       0
    TX:  bytes packets errors dropped carrier collsns
         32004   17795      0       0       0       0
```

## CAN-FD：同一个 socket，更大的载荷

CAN-FD（Flexible Data rate）把仲裁阶段保持在经典速率，数据阶段跑得更快，并把载荷从
8 字节提到 64 字节。远程帧没有了，DLC 现在直接表示长度。凡是讲 ISO-TP 的东西——UDS、
超过 7 字节的 OBD-II 请求——一帧 FD 就能替掉一串多帧传输，这比多出来的速率更要紧。

在 Linux 上 CAN-FD 就是同一个 SocketCAN 栈，接口只需声明自己支持 FD，而上面的
`vcan0` 并不支持：

```text
$ cansend vcan0 123##1DEADBEEF
CAN interface is not CAN FD capable - sorry.
```

判断依据是接口 MTU：CAN-FD 帧需要 `CANFD_MTU`（72）而不是 `CAN_MTU`（16）。在接口
down 的状态下改掉它，同一帧就发了出去：

```text
$ ip link set vcan0 down
$ ip link set vcan0 mtu 72
$ ip link set vcan0 up
$ cansend vcan0 123##1DEADBEEF
$ cansend vcan0 12345678##0DEADBEEFCAFEBABE1122334455667788
$ cansend vcan0 456#0102030405
$ candump vcan0
  vcan0  123  [04]  DE AD BE EF
  vcan0  12345678  [16]  DE AD BE EF CA FE BA BE 11 22 33 44 55 66 77 88
  vcan0       456   [5]  01 02 03 04 05
```

16 字节的载荷在经典 CAN 里是不可能的，而经典的 3 位十六进制 ID 和扩展的 8 位十六进制
ID 都没变：FD 是一次帧格式升级，不是一张新网络。到了真实硬件上，能力来自控制器
（MCP2517 或 MCP2518，而不是 MCP2515）和驱动的位定时，而不是你手工设的 MTU。

## 从 vcan0 到真实的 can0

真实总线只多三样东西：一颗懂协议的芯片、一颗驱动差分线的收发器、端接电阻。硬件接好
之后，Linux 这一侧平淡无奇：

```text
$ ip link set can0 type can bitrate 500000
$ ip link set up can0
$ candump can0
```

`can0` 来自驱动——挂在 SPI 上的 MCP2515 对应 `mcp251x`，PCAN 接收器对应 `peak_usb`，
或者板子上自带的控制器——从那一刻起，你的代码不知道也不关心它到底在跟哪一种说话。
`ip -details link show can0` 会显示真实的比特率、采样点和控制器模式，这些 `vcan0`
都没有。

对 ESP32 来说，便宜的那一端已经自带外设：ESP32、S3 和 C3 在硅片里就有一个 TWAI
控制器（CAN 2.0B），在 ESP-IDF 里以 `twai_driver_install`、`twai_start` 和
`twai_message_t` 暴露出来——把 SN65HVD230 这样的收发器接到两个引脚上，你就有了一个
真实节点。SPI 外接 MCP2515 也能用，代价是多几个引脚、一条 IRQ 线，以及 TWAI 完全不需要
的驱动代码。这和我在 [EasyTier 节点](/zh/posts/esp32-easytier-node-in-c/) 上做的取舍是
同一个：协议逻辑是可移植的，底下的传输层决定了硬件要吃掉多少预算。如果你是要把线上已
有的东西逆向出来，[串口协议那篇](/zh/posts/decoding-a-serial-protocol/)里的方法可以逐字
照搬，只是把逻辑分析仪通道换成 `candump`。

两点提醒。真实总线上只在两端各放一个 120Ω——一条总线两个端接电阻，不是每个节点一个。
另外，不要在你不拥有的车上"测试"；上面的一切都跑在一个只存在了二十分钟、如今已经
消失的容器里的虚拟接口上。
