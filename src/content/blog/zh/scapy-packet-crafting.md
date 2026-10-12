---
title: "Scapy 教程：用 Python 构造数据包，只在自己的回环接口上嗅探"
description: "一份动手的 Python 抓包与组包教程：用 Scapy 手工构造 ICMP echo、一个 Ethernet/IP/TCP 帧和一个真实的 DNS 查询，只发到 127.0.0.1，再把回包嗅探回来。附真实的 show()、hexdump() 与解析器输出，以及 NET_RAW 与授权使用的边界。"
pubDate: 2027-01-04
lang: zh
translationKey: scapy-packet-crafting
tags: [networking, python, security]
featured: false
keywords:
  - Scapy 教程
  - 构造数据包
  - Python 抓包
  - 嗅探数据包
  - ICMP
  - DNS 查询
  - hexdump
---

读一份抓包，你知道网络做了什么；**构造数据包**再发出去，你才知道网络*以为*发生了什么。这就是这篇
**Scapy 教程**的论点：Scapy 是一个 Python 抓包/组包库，而据我所知，真正吃透一个协议最快的办法，
就是手工把它的一个包的每个字段敲出来，发到一台属于自己的机器上，再把回包**嗅探数据包**回来。没有
任何一个图形界面会告诉你 TCP 的标志位在报文段的第 13 个字节——自己写过那个字节，你就会了。

下面每一条命令都是在一个用完就扔的容器里跑出来的真实输出（scapy 2.8.0 / Python
3.12），是一次瞄准最安全目标的 **Python 抓包**练习：`127.0.0.1`。

## Scapy 是什么，为什么它比图形界面更适合学协议

Scapy 是一个库，不是"带脚本功能的协议分析器"。你把一个包描述成一个 Python
对象——每一层是一个类，每个字段是一个属性——用 `/` 把各层叠起来，再把结果塞进一个
raw socket。它同样能抓包、解析和重放。学习价值全在"描述"这一步：

- **每个字段都有名字和默认值。** 你不可能在不意识到的前提下设置一个 TTL——要设置它，
  就得先知道它存在。在图形界面里，你只会划过那些你不认识的字段。
- **这个栈*就是*协议本身。** `IP(dst=...) / TCP(dport=...)` 直译了封装：一个首部的
  若干字节，接着下一个首部的若干字节。
- **同一个库，两头都能用。** 你可以在一个进程里既构造查询、又构造响应——这是理解
  DNS 为什么要有事务 ID 的唯一便宜办法。

代价是另一方面的诚实：Scapy 不替你实现 TCP。它会把一个 raw socket 交给你，任你构造
一个内核一无所知的报文段。正是这个能力，让文末的边界变得重要。

## 实验环境：一个用完就扔的容器，只走回环

一切都跑在一个一次性容器里。不改宿主机、不用 `sudo`、不加 `--privileged`——只要
`NET_RAW`，也就是 raw socket 唯一需要的那一个能力：

```bash
docker run -d --rm --name scapylab --cap-add=NET_RAW python:3.12-slim-bookworm sleep infinity
docker exec scapylab pip install scapy
docker exec scapylab sh -c 'grep CapEff /proc/self/status'
```

```text
CapEff:	00000000a80425fb
```

> **只用于授权场景，且只走回环。** 本文的每一个包都发往 `127.0.0.1`，并在一个我所有、用完即删的容器内的 `lo` 上被抓取。回环不碰任何网线，所以不存在第三方、没有东西可拦截，也不需要向谁申请授权。不要把同样的代码指向不属于你的主机——最后一节会解释我为什么不这么做。

## 用 `/` 叠层来构造数据包：Ether()/IP()/TCP()、ICMP() 与 DNS()

### 每一层都是一个类，`/` 负责叠层

从最小可用的包开始。`IP()` 会把所有有默认值的字段补齐，`/` 追加下一层，
`/ b"..."` 追加裸字节：

```python
from scapy.all import IP, ICMP, conf, raw

conf.verb = 0                       # 别让每个包都刷屏
pkt = IP(dst="127.0.0.1") / ICMP(type="echo-request", id=0x1337, seq=1)
pkt = pkt / b"scapy-loopback-lab"

pkt.show()
```

```text
###[ IP ]###
  version   = 4
  ihl       = None
  tos       = 0x0
  len       = None
  id        = 1
  flags     =
  frag      = 0
  ttl       = 64
  proto     = icmp
  chksum    = None
  src       = 127.0.0.1
  dst       = 127.0.0.1
  \options   \
###[ ICMP ]###
     type      = echo-request
     code      = 0
     chksum    = None
     id        = 0x1337
     seq       = 0x1
     unused    = b''
###[ Raw ]###
        load      = b'scapy-loopback-lab'
```

`src = 127.0.0.1` 是查路由表得来的。`ihl`、`len` 和两个 `chksum` 都是 `None`，因为它们
是*在 build 时计算*的，不是在建对象时算的。`raw()` 负责 build——它是唯一真正离开进程的
东西：

```python
wire = raw(pkt)
print(wire)
print(len(wire), "bytes")
```

```text
b'E\x00\x00.\x00\x01\x00\x00@\x01|\xcc\x7f\x00\x00\x01\x7f\x00\x00\x01\x08\x00fK\x137\x00\x01scapy-loopback-lab'
46 bytes
```

把我们自己造的字节重新解析一遍，就能看到 Scapy 算出了什么：`ihl = 5`（20 字节的 IPv4
首部）、`len = 46`、`IP chksum = 0x7ccc`、`ICMP chksum = 0x664b`。20 字节首部 + 8 字节
ICMP 首部 + 18 字节载荷 = 46，而那些你从没写过的校验和全都是对的。

### 把一整个栈读回来：show() 与 ls()

下面是 Scapy 最经典的第一个程序，一个完整的 Ethernet/IP/TCP 帧：

```python
from scapy.all import Ether, IP, TCP

pkt = (Ether(src="02:00:00:00:00:02", dst="02:00:00:00:00:01")
       / IP(src="127.0.0.1", dst="127.0.0.1", ttl=64)
       / TCP(sport=40001, dport=8080, flags="S", seq=1000, window=64240))

print(len(pkt), "bytes")          # Ether 14 + IP 20 + TCP 20，没有载荷
pkt.show()
```

```text
54 bytes
###[ Ethernet ]###
  dst       = 02:00:00:00:00:01
  src       = 02:00:00:00:00:02
  type      = IPv4
###[ IP ]###
  ttl       = 64
  proto     = tcp
  chksum    = None
###[ TCP ]###
  sport     = 40001
  dport     = http_alt
  seq       = 1000
  ack       = 0
  flags     = S
  window    = 64240
  chksum    = None
  options   = []
```

有三个细节值得停一下。`type = IPv4` 和 `dport = http_alt`：Scapy 会把枚举值解析成名字，
所以 `0x0800` 印成 `IPv4`，`8080` 印成 `http_alt`。`chksum = None` 还是那句——build
时才算。还有 `options = []`：TCP 选项是独立的一层列表，这就是你加 MSS、时间戳或窗口
缩放因子的方式。

`ls()` 是自省视图——每个字段、它的 Scapy 类型、当前值和默认值。下面是对我们后面要用到的
DNS 层的输出，也是你摸清一层能干什么的入口：

```python
ls(DNS())
```

```text
length     : ShortField (Cond)                   = None            ('None')
id         : ShortField                          = 0               ('0')
qr         : BitField  (1 bit)                   = 0               ('0')
opcode     : BitEnumField                        = 0               ('0')
aa         : BitField  (1 bit)                   = 0               ('0')
tc         : BitField  (1 bit)                   = 0               ('0')
rd         : BitField  (1 bit)                   = 1               ('1')
ra         : BitField  (1 bit)                   = 0               ('0')
rcode      : BitEnumField                        = 0               ('0')
qdcount    : FieldLenField                       = None            ('None')
ancount    : FieldLenField                       = None            ('None')
nscount    : FieldLenField                       = None            ('None')
arcount    : FieldLenField                       = None            ('None')
qd         : _DNSPacketListField                 = [<DNSQR  |>]    ('[<DNSQR  |>]')
an         : _DNSPacketListField                 = []              ('[]')
```

略有删减——真实输出里还有 `z`、`ad`、`cd`、`ns` 和 `ar`。那四个 `*count` 是
`FieldLenField`：保持 `None`，Scapy 就替你数实际挂上去的记录数。整个 DNS 首部就这么
十几行。

## show() 与 hexdump()：协议树负责解释，字节才是事实

`show()` 是一次*解析*——Scapy 决定了每个字段从哪里开始，然后印了个名字。`hexdump()`
把字节连同偏移和 ASCII 列一起打出来，跟 Wireshark 的字节面板一样。两个都要用：树用
来读，十六进制用来核对。

```python
hexdump(pkt)
```

```text
0000  02 00 00 00 00 01 02 00 00 00 00 02 08 00 45 00  ..............E.
0010  00 28 00 01 00 00 40 06 7C CD 7F 00 00 01 7F 00  .(....@.|.......
0020  00 01 9C 41 1F 90 00 00 03 E8 00 00 00 00 50 02  ...A..........P.
0030  FA F0 F7 35 00 00                                ...5..
```

手工把它读回来，是让 `show()` 变得可信的那道练习：

```python
b = raw(pkt)
b[12:14].hex()                   # '0800' -> EtherType = IPv4
b[14] >> 4, b[14] & 0x0F         # 4 5    -> IPv4，IHL 5 = 20 字节首部
b[23]                            # 6      -> IP 协议号 = TCP
int.from_bytes(b[34:36], 'big')  # 40001  -> TCP 源端口
b[47]                            # 0x2    -> flags = SYN
```

```text
0800
4 5
6
40001
0x2
```

把这些字节重新解析回去，得到的包逐字节相同——这也正是下面代码块最后一行会咬人的地方：

```python
p2 = Ether(b)
print(p2.summary())
print(raw(p2) == b)
print(p2 == pkt)
```

```text
Ether / IP / TCP 127.0.0.1:40001 > 127.0.0.1:http_alt S
True
False
```

最后那个 `False` 是 Scapy 真实的坑，不是 bug。`pkt` 从未被 build，所以它的 `len` 和
`chksum` 还是 `None`；`p2` 是从 54 个真实字节解析出来的，字段都有值。当你在意两个包是
否是同一个包时，去比 `raw()`。

<figure>
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="Scapy 叠出来的三层结构：以太网首部含目的 MAC、源 MAC 与 EtherType；IPv4 首部含版本与 IHL、总长度、协议号、校验和以及源目地址；TCP 首部含源端口、目的端口、序列号、确认号、标志位、窗口与校验和。一个箭头从整叠结构指向 raw() 与 hexdump()。">
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5">
    <rect x="36" y="34" width="568" height="38" rx="6"/>
    <rect x="36" y="104" width="568" height="38" rx="6"/>
    <rect x="36" y="174" width="568" height="38" rx="6"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.25" fill="none" opacity="0.85">
    <rect x="40" y="38" width="176" height="30" rx="4"/>
    <rect x="220" y="38" width="176" height="30" rx="4"/>
    <rect x="400" y="38" width="76" height="30" rx="4"/>
    <rect x="40" y="108" width="60" height="30" rx="4"/>
    <rect x="104" y="108" width="72" height="30" rx="4"/>
    <rect x="180" y="108" width="60" height="30" rx="4"/>
    <rect x="244" y="108" width="84" height="30" rx="4"/>
    <rect x="332" y="108" width="140" height="30" rx="4"/>
    <rect x="476" y="108" width="124" height="30" rx="4"/>
    <rect x="40" y="178" width="72" height="30" rx="4"/>
    <rect x="116" y="178" width="72" height="30" rx="4"/>
    <rect x="192" y="178" width="108" height="30" rx="4"/>
    <rect x="304" y="178" width="108" height="30" rx="4"/>
    <rect x="416" y="178" width="56" height="30" rx="4"/>
    <rect x="476" y="178" width="60" height="30" rx="4"/>
    <rect x="540" y="178" width="60" height="30" rx="4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="128" y="57" text-anchor="middle">dst MAC · 6 B</text>
    <text x="308" y="57" text-anchor="middle">src MAC · 6 B</text>
    <text x="438" y="57" text-anchor="middle">type · 2 B</text>
    <text x="70" y="127" text-anchor="middle">ver/IHL</text>
    <text x="140" y="127" text-anchor="middle">len</text>
    <text x="210" y="127" text-anchor="middle">proto</text>
    <text x="286" y="127" text-anchor="middle">checksum</text>
    <text x="402" y="127" text-anchor="middle">src 127.0.0.1</text>
    <text x="538" y="127" text-anchor="middle">dst 127.0.0.1</text>
    <text x="76" y="197" text-anchor="middle">sport</text>
    <text x="152" y="197" text-anchor="middle">dport</text>
    <text x="246" y="197" text-anchor="middle">sequence</text>
    <text x="358" y="197" text-anchor="middle">ack</text>
    <text x="444" y="197" text-anchor="middle">flags</text>
    <text x="506" y="197" text-anchor="middle">window</text>
    <text x="570" y="197" text-anchor="middle">cksum</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="36" y="24" opacity="0.75">Ether() — 14 bytes on the wire</text>
    <text x="36" y="94" opacity="0.75">IP() — 20 bytes</text>
    <text x="36" y="164" opacity="0.75">TCP() — 20 bytes</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.5" marker-end="url(#scapylayerszh)">
    <path d="M620 53 H632 V193 H620"/>
  </g>
  <defs>
    <marker id="scapylayerszh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="36" y="246">Ether() / IP() / TCP()</text>
    <text x="36" y="266" opacity="0.75">→ raw(): 54 bytes</text>
    <text x="36" y="284" opacity="0.75">→ hexdump(): offset, hex, ASCII</text>
  </g>
</svg>
<figcaption>一个 Scapy 包就是一层层对象的叠堆。每一条是一层首部，字段就是你设的那些属性；<code>raw()</code> 负责把整叠变成线上传输的字节。</figcaption>
</figure>

## 发送与接收：sr、sr1、send 与 sniff

四个函数几乎覆盖全部场景，区别只在于你想不想要一个回答。

| 函数 | 做什么 | 什么时候用 |
|---|---|---|
| `send(pkt)` | 把包发出去，返回发送计数 | 你只希望这个包出现在线路上 |
| `sr(pkt)` | 发送，返回**已答**和**未答**两部分 | 你在意那些永远没有回音的探测 |
| `sr1(pkt)` | 发送，返回**第一个**回应 | 只要一个回答：ping、DNS 应答、SYN-ACK |
| `sniff(...)` | 抓包，返回包列表 | 你想看到一切，包括你自己发出去的 |

`sr1` 是主力：

```python
reply = sr1(IP(dst="127.0.0.1") / ICMP(type="echo-request", id=0x1337, seq=1)
            / b"scapy-loopback-lab", iface="lo", timeout=2)
print(reply.summary())
print(reply[ICMP].type, reply[ICMP].id, bytes(reply[ICMP].payload))
```

```text
IP / ICMP 127.0.0.1 > 127.0.0.1 echo-reply 0 / Raw
0 4919 b'scapy-loopback-lab'
```

`type = 0` 是 `echo-reply`，`id = 4919` 就是 `0x1337`——我们自己的——内核把载荷原样
回了过来。这是一次真实的 ICMP 往返，来自我手工敲出来的那个包。

### sniff() 能看到 send() 永远看不到的东西

`send()` 只返回一个计数。`sniff()` 返回整场对话，包括内核在你背后做的手脚。在 `lo`
上起一个 `AsyncSniffer`，然后发一个手工构造的 ICMP echo、一个 DNS 查询，再给一个普通
监听端口发一个手工构造的 TCP SYN：

```python
sniffer = AsyncSniffer(iface="lo", count=20)
sniffer.start()
sr1(IP(dst="127.0.0.1")/ICMP(type="echo-request", id=0x99, seq=7)/b"sniff me", iface="lo")
sr1(IP(dst="127.0.0.1")/UDP(sport=41010, dport=5353)
    /DNS(id=0x7777, rd=1, qd=DNSQR(qname="scapy.lab", qtype="A")), iface="lo")
send(IP(dst="127.0.0.1")/TCP(sport=41011, dport=8080, flags="S", seq=500), iface="lo")
sniffer.stop()

seen, uniq = set(), []
for p in sniffer.results:          # 每一帧都会过 lo 两次
    if raw(p) in seen:
        continue
    seen.add(raw(p))
    uniq.append(p)
print(len(sniffer.results), "frames,", len(uniq), "unique")
for p in uniq:
    print(p.summary())
```

```text
16 frames, 8 unique
Ether / IP / ICMP 127.0.0.1 > 127.0.0.1 echo-request 0 / Raw
Ether / IP / ICMP 127.0.0.1 > 127.0.0.1 echo-reply 0 / Raw
Ether / IP / UDP / mDNS Qry b'scapy.lab.'
Ether / IP / UDP / DNS Ans 127.0.0.1
Ether / IP / ICMP / IPerror / UDPerror / DNS Ans 127.0.0.1
Ether / IP / TCP 127.0.0.1:41011 > 127.0.0.1:http_alt S
Ether / IP / TCP 127.0.0.1:http_alt > 127.0.0.1:41011 SA
Ether / IP / TCP 127.0.0.1:41011 > 127.0.0.1:http_alt R
```

这里面有三件事是教程里不会写的。**每一帧都出现两次**——回环上一个包在 `lo` 上过一次是
出去，一次是进来，而 `PF_PACKET` 抓包两次都看得见。`tcpdump -i lo -c 6 icmp` 也同意：
一次 echo，它打印的是 `4 packets received by filter / 2 packets captured`。
**`IPerror / UDPerror` 那一帧**：我用源端口 41010 发出 DNS 查询，但那个端口上什么都没
绑，于是 dnsmasq 的应答到达时，内核回了一个 ICMP *端口不可达*，并把肇事的 IP 和 UDP
首部原文引在了错误报文里。**SYN 拿到了真实的 SYN-ACK，然后又拿到一个真实的 RST**——两者
都出自内核，因为我构造的那个包本来就是一个中规中矩的报文段。注意那个 RST 并不是我发的：
它是协议栈在回应一个自己毫无 socket 状态的 SYN-ACK。

## 一次真实的 DNS 查询：打一个本地解析器

DNS 查询是 Scapy 最好的练习：两层你已经认识，一层你还不认识，外加一个真实回答可以对
答案。在同一个容器里跑一个真的解析器，绑到一个非特权端口，免得和 53 打架：

```bash
docker exec scapylab sh -c 'dnsmasq --no-daemon --port=5353 \
  --listen-address=127.0.0.1 --bind-interfaces --no-resolv --no-hosts \
  --address=/scapy.lab/127.0.0.1 \
  --txt-record=scapy.lab,"hello from a real dnsmasq in the lab container" \
  --log-queries'
```

然后构造查询。`DNS()` 是报文，`DNSQR()` 是一个问题：

```python
q = IP(dst="127.0.0.1") / UDP(sport=41000, dport=5353) / DNS(
        id=0x4D3F, rd=1, qd=DNSQR(qname="scapy.lab", qtype="A"))
ans = sr1(q, iface="lo", timeout=3)

print(ans[DNS].rcode, ans[DNS].qr, [rr.rdata for rr in ans[DNS].an])
print(ans[UDP].sport, ans[UDP].dport)
```

```text
0 1 ['127.0.0.1']
5353 41000
```

仔细读这几行：`rcode = 0` 是 NOERROR，`qr = 1` 表示这是应答而不是查询，`an` 里是那条
应答记录，`rdata = 127.0.0.1`；而回包是**从** 5353 **发到**我们的 41000——五元组正好
反过来，理所当然。（Scapy 把 `dport` 印成 `mdns`，因为 5353 是 mDNS 的端口，数字才是
关键。）

对应答调 `show()` 是收获的时刻——RFC 里描述的那些计数，在这里就是字段：

```text
###[ DNS ]###
  id        = 19775
  qr        = 1
  opcode    = QUERY
  aa        = 1
  tc        = 0
  rd        = 1
  ra        = 1
  z         = 0
  ad        = 0
  cd        = 0
  rcode     = ok
  qdcount   = 1
  ancount   = 1
  nscount   = 0
  arcount   = 0
  \qd        \
   |###[ DNS Question Record ]###
   |  qname     = b'scapy.lab.'
   |  qtype     = A
   |  qclass    = IN
  \an        \
   |###[ DNS Resource Record ]###
   |  rrname    = b'scapy.lab.'
   |  type      = A
   |  rclass    = IN
   |  ttl       = 0
   |  rdata     = 127.0.0.1
  \ns        \
  \ar        \
```

改一个词，你就能拿到另一种回答——这才是学会*读* DNS 失败、而不是瞎猜的门。对同一个名字
发 TXT 查询，拿到的是 dnsmasq 里配好的那串字符串：

```text
TXT answer: [[b'hello from a real dnsmasq in the lab container']]
```

再问一个解析器既没有区域、也没有上游可问的名字：

```text
rcode: 5  ancount: 0
###[ DNS ]###
  qr        = 1
  rcode     = refused
  aa        = 0
  qdcount   = 1
  ancount   = 0
```

`rcode = 5` 是 REFUSED——dnsmasq 在说"不是我的，而且我也没地方可问"。这跟 NXDOMAIN
（"我问过了，它不存在"）和 SERVFAIL（"我问了，上游挂了"）是不同的失败。分清这三者，就
解决了 DNS 排障的一半，而你在本地一分钟内就能把它们全造出来。

## 诚实的边界：NET_RAW、只动自己的机器，以及互联网不是实验室

**只动自己的机器。** 上文的一切都发往一个我起过又删掉的容器里的 `127.0.0.1`。回环是
唯一一个你不可能影响第三方的目标，因为包根本不出 netns。想拿两台主机练手，就在一条你
私有的 bridge 网络上起两个容器，或者用一块仅主机模式的虚拟网卡。

**Raw socket 需要 `NET_RAW`。** raw socket 意味着内核不再给你的包加自己的首部：一切
由你提供。在宿主机上以一个普通用户身份，一句
`socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)` 就会抛
`PermissionError: [Errno 1] Operation not permitted`——在 `--cap-drop=ALL` 起的容器里
跑同一段 Python 也是同样的报错。Docker 的默认能力集本来就含 `NET_RAW`，所以容器里
`--cap-add=NET_RAW` 属于双保险；而在裸机上、或者能力被摘掉时，它就是"能跑"和"一串
traceback"的区别。

**`NET_RAW` 不是许可证。** 它让你能*发送任意字节*，并不会让一个包变得正当。伪造源地
址、往别人的连接里注入应答、或者扫描你不控制的网络，都不是"高级 Scapy"——那是未授权访
问。判断标准很无聊：如果你说不出该问谁、该问哪台机器，就别发这个包。

**Scapy 不替你实现 TCP。** 用错误的序列号构造一个报文段，对面只会甩你一个 RST：TCP 状
态机在内核里，不在你的脚本里。

**互联网不是实验室。** 往一个随机主机发一个手工包，对你很便宜，对某人却很显眼。它会落
进一份日志、触发一个限速器，把一个愉快的下午变成一封 Abuse 投诉。这里所有有趣的东西都
装得进一个接口。

## 我的收获

构造包是一种读文档换不来的协议教育。`show()` 告诉你一个首部*意味着*什么，`hexdump()`
告诉你它*在哪儿*，`sniff()` 告诉你内核为此做了什么。当一个你自己拼出来的 ICMP echo
发出去、一个真实的解析器回答了你亲手拼出来的 DNS 查询之后，RFC 就不再是散文，而是字
段表。

反方向——从别人抓到的字节出发——可以看
[如何读懂一次抓包](/zh/posts/reading-a-packet-capture/)，以及文件里到底有什么的
[用 Python 写一个 pcap 解析器](/zh/posts/writing-a-pcap-parser/)。
