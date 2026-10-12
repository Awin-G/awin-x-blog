---
title: "用 Python 写一个 pcap 解析器（以及为什么你仍然需要一个）"
description: "一个只用标准库、一次就能读懂的 Python pcap 解析器：全局头与数据包记录、字节序与 snaplen、何时该用 scapy 或 dpkt、何时手写反而更划算、从以太网到 IPv4 再到 TCP 的 5 元组提取、pcapng 块结构速览，以及流式处理的性能笔记。"
pubDate: 2026-11-07
lang: zh
translationKey: writing-a-pcap-parser
tags: [networking, python]
featured: false
keywords:
  - pcap 解析器
  - Python pcap
  - scapy
  - 数据包分析
  - pcapng
---

数据包分析不一定得从 Wireshark 开始。当我要在一台没有显示器、没有 root、解释器里也没有
`scapy` 的机器上，从四十个 GB 的流量里只问一个具体问题时，我会直接写一个 **Python pcap
解析器**。它大约八十行，零依赖，而且是流式的。这篇文章就是那个解析器——同时也告诉你，
**pcap 解析器**到底在什么位置就不再是最合适的工具，这时候你反而应该去用 **scapy** 或
`dpkt`。

如果你读过我关于[读取一次数据包抓取](/zh/posts/reading-a-packet-capture/)的笔记，那这篇
就是 GUI 底下那一层。当我拆解别人流量的时候——和
[逆向一个私有 HTTP API](/zh/posts/reverse-engineering-a-private-api/) 遵循同样「先观察」
的纪律——手写解析器通常就是我拿到第一批真实数字的方式。

## pcap 格式：一个全局头，然后是一串记录

经典 `pcap` 就是一个 24 字节的全局头，后面跟着零个或多个数据包记录。整个格式就这么点
东西。全局头里有 magic number、主次版本号、`thiszone`、`sigfigs`、`snaplen` 以及链路层
类型。这些字段里，有两个承担了全部工作。

**字节序。** magic number 是 `0xa1b2c3d4`，以写入方的本机字节序存储。只要读出前四个
字节，你就顺便知道了整份文件的字节序：如果读出来是 `d4 c3 b2 a1`，说明是小端；
`a1 b2 c3 d4` 则是大端。还有一个变体 magic `0xa1b23c4d`，表示时间戳用的是纳秒而不是
微秒。这里搞错，之后你读到的每一个长度都是垃圾，所以先把字节序解出来，再把它贯穿到每一
次 `struct` 调用里。

**snaplen** 是抓包工具承诺为每个包存储的最大字节数。每条记录有 `incl_len`（实际存在的
字节数）和 `orig_len`（截断前线上的长度）。`incl_len` 永远不会超过 `snaplen`；而当你统计
字节数时必须用 `orig_len`，否则你报出的每一个总量都会低估真实流量。一条记录头就是四个
整数：`ts_sec`、`ts_usec`、`incl_len`、`orig_len`，后面跟着 `incl_len` 字节的帧。

```python
import struct

# The four magics map to (endianness, timestamp resolution).
PCAP_MAGIC = {
    b"\xd4\xc3\xb2\xa1": ("<", "us"),  # little-endian, microseconds
    b"\xa1\xb2\xc3\xd4": (">", "us"),  # big-endian,    microseconds
    b"\x4d\x3c\xb2\xa1": ("<", "ns"),  # little-endian, nanoseconds
    b"\xa1\xb2\x3c\x4d": (">", "ns"),  # big-endian,    nanoseconds
}

GLOBAL_HDR = struct.Struct("IHHiIII")  # magic, vmaj, vmin, thiszone, sigfigs, snaplen, linktype
RECORD_HDR = struct.Struct("IIII")     # ts_sec, ts_usec, incl_len, orig_len
```

## 一个只用标准库的 Python pcap 解析器

我依靠 `struct.unpack_from` 和 `struct.iter_unpack`，而不是手工切字节；并且把读取器写成
生成器，这样调用方可以随时提前退出。这个循环既不 seek，也不需要知道文件大小，任何时刻
内存里都只有一条记录。

```python
def read_pcap(path):
    with open(path, "rb") as f:
        header = f.read(24)
        if len(header) < 24:
            raise ValueError("truncated pcap global header")

        endian = PCAP_MAGIC.get(header[:4])
        if endian is None:
            raise ValueError("not a classic pcap file (maybe pcapng?)")
        endian, _resolution = endian

        _, vmaj, vmin, _, _, snaplen, linktype = GLOBAL_HDR.unpack(endian + header)
        rec = struct.Struct(endian + "IIII")

        while True:
            raw = f.read(16)
            if len(raw) < 16:
                return  # clean EOF, or a truncated final record header
            ts_sec, ts_usec, incl_len, orig_len = rec.unpack(raw)
            frame = f.read(incl_len)
            if len(frame) < incl_len:
                return  # capture was cut mid-record
            yield linktype, snaplen, (ts_sec, ts_usec), orig_len, frame
```

十二行格式加二十行循环。整个文件格式就这些。抓包真正难的部分都在这一层之上，在协议里。

## scapy 与 dpkt，对比手写解析

**scapy** 是一门用来描述数据包的语言，而不只是一个解析器。它给你 `rdpcap()`、分层对象、
`.show()`、`.sprintf()` 模板，以及构造并发送应答的能力。`dpkt` 是个轻薄、快速的 struct
库——和我上面写的东西更接近，但每种协议都已经替你解码好了。两者都是正确的选择，也都会
因为同一个原因变得不合适：依赖。

当你是在**探索**时，用 `scapy`。当你还不知道自己在找什么、想敲一行代码就看到字段、需要
构造数据包，或者它的协议覆盖（VXLAN、SCTP、DNS-over-HTTPS 以及上百种其它协议）能替你
省下一周时，就用它。当你想要速度和稳定的 API，并且乐意多一个带 C 加速的依赖时，就用
`dpkt`。

当问题**很窄、而数据很大**时，就手写解析。我的几条规则：

- **定向提取。**我只想要一个字段——5 元组、某个 TCP 标志、TLS SNI——而不是完整的协议
  模型。这时候拉进 `scapy` 就是拿大锤砸钉子。
- **超大文件。**手写解析器能以恒定内存流式处理 40 GB 的抓包。那些为每一帧都构造一个
  数据包对象的便利封装，才是真正吃爆内存的东西。
- **不允许有依赖。**一台抓包机、一个容器、一台被锁死的生产主机，或者一位必须能复现你
  数字的审阅者。`import struct` 永远能用。
- **可审计的正确性。**你自己完全读懂的八十行，胜过你信任但没读过的库。当数字很重要时，
  我想逐行读过产生它们的每一行代码。

诚实的答案其实是两者配合：先用 `scapy` 把问题原型化，等你确切知道自己要哪些字节之后，
再手写重写那条热路径。

## 从原始字节做数据包分析：以太网 → IPv4 → TCP

一次抓包就是一堆链路层帧。在以太网上，那是 14 字节的头——目的 MAC、源 MAC，以及一个
2 字节的 EtherType——然后才是载荷。`0x0800` 是 IPv4，`0x86DD` 是 IPv6，`0x8100` 是
802.1Q VLAN 标签，它插入额外四字节，而且可以层叠。在你假设这是 IPv4 之前，先跳过 VLAN
标签，否则你会悄悄丢掉所有打了标签的流量。

IPv4 头是很多新手解析器翻车的地方。第一个字节把版本塞在高四位、把头长（IHL）塞在低四
位，单位是 *32 位字*，所以真实头长是 `ihl * 4` 字节，通常是——但并不总是——20。选项会
让它更长；忽略 IHL 就是那个经典的多读/少读几个字节、把端口读成乱码的 bug。偏移 9 处的
`protocol` 告诉你下一层是什么：6 是 TCP，17 是 UDP，1 是 ICMP。

```python
import socket

ETHERTYPE_IPV4, ETHERTYPE_VLAN = 0x0800, 0x8100

def parse_ethernet_ipv4(frame):
    # Returns (proto, src_ip, src_port, dst_ip, dst_port, l4_len) or None.
    if len(frame) < 14:
        return None
    _dst, _src, ethertype = struct.unpack_from("!6s6sH", frame, 0)
    off = 14
    while ethertype == ETHERTYPE_VLAN:            # 802.1Q, possibly stacked
        if len(frame) < off + 4:
            return None
        ethertype = struct.unpack_from("!H", frame, off + 2)[0]
        off += 4
    if ethertype != ETHERTYPE_IPV4 or len(frame) < off + 20:
        return None

    ver_ihl = frame[off]
    ihl = (ver_ihl & 0x0F) * 4
    if (ver_ihl >> 4) != 4 or ihl < 20 or len(frame) < off + ihl:
        return None

    proto = frame[off + 9]                        # 6 TCP, 17 UDP
    total_len = struct.unpack_from("!H", frame, off + 2)[0]
    src_ip = socket.inet_ntoa(frame[off + 12:off + 16])
    dst_ip = socket.inet_ntoa(frame[off + 16:off + 20])

    if proto not in (6, 17):                      # only TCP/UDP have ports
        return None
    l4 = off + ihl
    if len(frame) < l4 + 4:
        return None
    src_port, dst_port = struct.unpack_from("!HH", frame, l4)
    return proto, src_ip, src_port, dst_ip, dst_port, total_len
```

TCP 是最简单的部分：端口是报文段的前四字节，数据偏移在字节 12 的高四位。但要注意两个
坑。分片的 IPv4 在首片之后就没有 L4 头了——在你相信自己刚读出来的那个「端口」之前，先
检查偏移 6–7 处的分片偏移。另外 `total_len` 是 *IP* 长度，不是帧长度；做字节统计时，
优先用记录的 `orig_len`。

## 提取 5 元组与字节计数

**5 元组**是协议、源 IP、源端口、目的 IP、目的端口。它是标识一条流的键，而我对一次抓包
的几乎所有问题，最后都归结为按它分组。一旦 `parse_ethernet_ipv4` 返回了它加上长度，剩下
的就交给 `collections`。

```python
from collections import Counter, defaultdict

def flows(path, top=10):
    per_flow = defaultdict(int)
    for linktype, snaplen, ts, orig_len, frame in read_pcap(path):
        parsed = parse_ethernet_ipv4(frame)
        if parsed is None:
            continue  # IPv6, ARP, non-initial fragment, malformed
        proto, sip, sport, dip, dport, _ip_len = parsed
        per_flow[(proto, sip, sport, dip, dport)] += orig_len
    return Counter(per_flow).most_common(top)
```

这就是一个完整、零依赖的流量统计工具。注意它刻意 *不* 做的事：不做 TCP 流重组、不处理
IPv6、不解码应用层数据。它把一个问答得很好，而且能处理比你内存还大的抓包。

## pcapng：是块，不是记录

现代的 `tcpdump -w` 和 Wireshark 默认写的是 **pcapng**，那是一个不同的容器。它没有全局
头，也没有平铺的记录列表。文件是一串带长度前缀的块：4 字节块类型、4 字节总长度、块体，
最后再重复一遍总长度作为尾部（这样你可以从后往前遍历文件）。重要的块类型有：Section
Header Block（`0x0A0D0D0A`，它自带字节序 magic）、Interface Description Block
（`0x00000001`，按接口携带链路类型和 snaplen）、Enhanced Packet Block（`0x00000006`）以及
Simple Packet Block（`0x00000003`）。

实际后果很小，但忽视它就致命：链路类型现在是按接口的，所以每个包会引用一个接口 id，
你得维护一张 id 到 `linktype` 的表；而且包可以带有按接口分辨率的时间戳。好消息是 pcapng
反而 *更容易* 流式处理，因为每个块都是自描述的。

```python
BLOCK_SECTION_HDR    = 0x0A0D0D0A
BLOCK_INTERFACE_DESC = 0x00000001
BLOCK_ENHANCED_PKT   = 0x00000006
BLOCK_SIMPLE_PKT     = 0x00000003

def iter_pcapng_blocks(f):
    """Yield (block_type, body) for every block in an open pcapng file."""
    while True:
        head = f.read(8)                    # type + total length
        if len(head) < 8:
            return                          # EOF
        btype, blen = struct.unpack("<II", head)
        if blen < 12:
            return                          # corrupt
        body = f.read(blen - 12)            # minus 8-byte head, 4-byte trailer
        f.read(4)                           # trailing length copy
        yield btype, body
```

用前四个字节判断格式：`0x0A0D0D0A` 就是 pcapng，所以上面那个 pcap magic 查表会干脆利落
地把它拒掉。一个健壮的工具会两种都嗅探，然后分派。

## 一个实际例子：top talkers

我被问得最多的问题就是「谁在用掉全部带宽」。按地址加协议组成 6 元组分组，累加
`orig_len`，然后打印前几名：

```python
def top_talkers(path, limit=10, threshold_mb=1.0):
    bytes_by_pair = Counter()
    for _link, _snap, _ts, orig_len, frame in read_pcap(path):
        parsed = parse_ethernet_ipv4(frame)
        if parsed is None:
            continue
        proto, sip, _sp, dip, _dp, _ip_len = parsed
        bytes_by_pair[(sip, dip, proto)] += orig_len

    floor = threshold_mb * 1_000_000
    ranked = [(k, v) for k, v in bytes_by_pair.items() if v >= floor]
    ranked.sort(key=lambda kv: kv[1], reverse=True)
    for (sip, dip, proto), nbytes in ranked[:limit]:
        name = {6: "TCP", 17: "UDP"}.get(proto, str(proto))
        print(f"{sip:>15} -> {dip:<15} {name:<4} {nbytes / 1e6:9.2f} MB")
```

把键换成 `(proto, sip, sport, dip, dport)`、把 `Counter` 换成 `defaultdict(int)`，你得到的
就是「超过某个字节阈值的连接」——同一个循环，换一个问题。这种复用正是关键：解析只做一
次，之后每个新问题都只是换一个 `dict` 的键。

## 性能笔记：流式，永不整包吞下

上面所有代码有一个共同点——它从不把整个文件放进内存。下面这些来自我自己使用的数字，
因为它们改变了我写这类工具的方式：

- **`struct.unpack_from` 胜过切片。**切 `bytes` 对象会产生拷贝；按偏移解包不会。在一份
  一千万包的追踪里，这个差别是实打实的。
- **永远不要 `list(rdpcap(...))`。**这是把抓包机搞成 OOM 最常见的方式。用生成器；一次
  消费一帧。
- **预编译 `Struct` 对象。**每条记录都构造一次格式串，是热循环里隐藏的分配开销。`Struct`
  建一次，`unpack` 用很多次。
- **统计字节用 `orig_len`，不是 `incl_len`。**否则 `snaplen` 会悄悄截断你的总量。
- **尽早过滤。**在碰端口之前先检查 EtherType 和协议。真实抓包里绝大多数帧都不是你要找
  的东西。
- **必须随机访问时就加索引。**如果你需要随机访问，先跑一遍把所有 `offset -> timestamp`
  记进一个小的旁路文件，就能不必重读整个文件而直接跳转。

在我测试里，纯 Python 解析器大概能跑到每秒几十万到两三百万帧，用 `memoryview` 加
`iter_unpack` 处理定长头还会更快。论原始吞吐，`dpkt` 会赢你。那没关系——你不是在跟它
竞争，你只是拒绝依赖它。

手写一个 pcap 解析器并不是「务实」的默认选项，`scapy` 才是。但存在着一大类无聊、真实、
且非常常见的活——一个问题、巨大的文件、不允许任何依赖——在那里，你完全读懂的八十行
`struct` 就是最快、最正确的答案。写一次，留着它，下次有人问谁在吃掉带宽时，直接拿出来用。
