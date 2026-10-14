---
title: "用 nftables 做 IPv6 防火墙：一张 inet 表同时管两个协议族"
description: "一次真机 IPv6 防火墙实验：用一张 nftables inet 表同时给 IPv4 和 IPv6 设防，讲清 IPv6 离不开的 ICMPv6/NDP 规则、链路本地与多播放行、默认拒绝的 input 链，附真实放行与拦截的测试输出、计数器，以及和 ip6tables 的对比。"
pubDate: 2027-02-04
lang: zh
translationKey: ipv6-firewalling-with-nftables
tags: [networking, security]
featured: false
keywords:
  - IPv6 防火墙
  - nftables inet
  - ICMPv6
  - ip6tables 与 nftables
  - 默认拒绝
---

我跑的每一台机器现在都是双栈，而 IPv6 上线的那一周教会了我最不舒服的那一课：
**IPv6 防火墙**并不是"地址更长的 IPv4 防火墙"。没有 NAT 可以躲在后面，ICMPv6
是承重墙而不是可选噪音，而你继承下来的那套工具——一边 `iptables`、一边
`ip6tables`——正是 **nftables `inet`** 族存在的意义所要消灭的重复。所以这篇文章只讲
这件事里 IPv6 专属的那一片：一个装在单张 `inet` 表里的真实**默认拒绝** input 策略，
用真实的放行与拦截流量测试过，外加那些 IPv6 一旦缺了就彻底罢工的 **ICMPv6** 规则。
我不会复述 nftables 的通用模型——那在我的 [nftables 实战](/zh/posts/nftables-in-practice/)
里；SLAAC 和 /64 我也假设你已经从[这篇 IPv6 实操入门](/zh/posts/ipv6-practical-intro/)
里知道了。下面的实验是私有 IPv6 网络上的两个一次性容器，只给 `NET_ADMIN`
能力（不用 `--privileged`），全是我自己的机器，跑完即删。

## 为什么 IPv6 防火墙是另一份工作

有四个差异比其余全部加起来都重要：

- **没有 NAT。** 每台主机都持有全局可路由地址，所以从 v6 地址被分配的那一刻起，
  这台机器就*可能*被整个互联网触达——防火墙不再是可选项，而是唯一的边界。IPv4
  那种"因为地址稀缺而意外隐蔽"的红利没有了，你的 input 策略现在是一个真实的安全
  决策，不是形式主义。
- **ICMPv6 是强制的，不是友好的。** 邻居发现（类型 133–136）替代 ARP；路径 MTU
  发现依赖 "Packet Too Big"（类型 2）。成片丢弃 ICMPv6，协议栈就无法解析邻居、
  无法发现 MTU。IPv4 时代"ping 也封掉"的习惯，在 v6 上就是自找的故障。
- **链路本地与多播是一等流量。** `fe80::/10` 是 NDP、路由器公告（RA）和 DHCPv6
  说话的地方；`ff02::/16` 多播是 NDP 的被请求节点组和全节点组。一份只按全局单播
  地址推演的规则集，过滤的是这套协议的错的那一半。
- **ULA 不是"像 RFC1918 那样的私网"。** `fd00::/8` 唯一本地地址给你的是可路由、
  默认没有任何过滤的实验室空间，但那是*你的*地址，不是 RFC1918 的假装私密。任何
  拿着 `2000::/3` 全局地址的主机，在它的前缀被路由的那一刻就在公网上。

<figure>
<svg viewBox="0 0 880 310" width="100%" role="img" aria-labelledby="inet-fam-title inet-fam-desc" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
  <title id="inet-fam-title">一张 nftables inet 表用同一条链过滤 IPv4 和 IPv6</title>
  <desc id="inet-fam-desc">一个 IPv4 包和一个 IPv6 包进入同一张 inet 表的 input 链，链上的规则放行两个协议族的服务端口，并按策略丢弃其余流量。</desc>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="currentColor">
    <text x="120" y="46" text-anchor="middle" opacity="0.7">IPv4 包</text>
    <text x="120" y="64" text-anchor="middle">172.17.0.10 → .9:8443</text>
    <text x="120" y="176" text-anchor="middle" opacity="0.7">IPv6 包</text>
    <text x="120" y="194" text-anchor="middle">fd00:ab:ce::3 → ::2:8443</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5">
    <rect x="20" y="26" width="200" height="52" rx="8" stroke-opacity="0.45"/>
    <rect x="20" y="156" width="200" height="52" rx="8" stroke-opacity="0.45"/>
    <line x1="220" y1="52" x2="290" y2="120"/>
    <line x1="220" y1="182" x2="290" y2="195"/>
    <rect x="292" y="26" width="330" height="262" rx="12"/>
    <line x1="622" y1="150" x2="700" y2="96"/>
    <line x1="622" y1="165" x2="700" y2="212"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <polygon points="294,118 283,113 284,124" fill="#0f766e"/>
    <polygon points="704,96 693,91 694,102" fill="#0f766e" transform="rotate(35 704 96)"/>
    <polygon points="704,212 693,207 694,218" fill="#0f766e" transform="rotate(-35 704 212)"/>
  </g>
  <g fill="currentColor">
    <text x="457" y="54" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="600">table inet fw</text>
    <text x="457" y="74" text-anchor="middle" font-size="11" opacity="0.7">chain input · type filter hook input · priority filter</text>
    <text x="457" y="92" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="#0f766e">policy drop</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">
    <text x="310" y="122">iifname "lo" accept</text>
    <text x="310" y="142">ct state established,related accept</text>
    <text x="310" y="162">ip6 nexthdr ipv6-icmp icmpv6 type { nd-*, packet-too-big }</text>
    <text x="310" y="182">ip6 saddr fe80::/10 accept</text>
    <text x="310" y="202">ip6 daddr ff02::/16 accept</text>
    <text x="310" y="222" font-weight="600">tcp dport 8443 accept</text>
    <text x="310" y="242">ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept</text>
    <text x="310" y="270">counter drop</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="1.5">
    <rect x="706" y="70" width="154" height="52" rx="8"/>
    <rect x="706" y="186" width="154" height="52" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g fill="currentColor" font-size="11">
    <text x="783" y="90" text-anchor="middle">本地套接字</text>
    <text x="783" y="106" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" opacity="0.75">*:8443（一个监听）</text>
    <text x="783" y="206" text-anchor="middle">已丢弃 · 已计数</text>
    <text x="783" y="222" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" opacity="0.75">counter packets 12</text>
  </g>
</svg>
<figcaption>一张 <code>inet</code> 表，一条挂在 <code>filter</code> 优先级的 <code>input</code> 链。同一条规则既看得见来自 <code>172.17.0.10</code> 的 IPv4 SYN，也看得见来自 <code>fd00:ab:ce::3</code> 的 IPv6 SYN——保护一台机器的规则集从此不必存在两份。在我的实验里，IPv4 与 IPv6 流量流过同一条链的同时，丢弃计数器最终涨到了 12 个包。</figcaption>
</figure>

## nftables 的 `inet` 族：一张表，两个协议族

nftables 里你要做的第一个决定是表的*协议族*。`ip` 只过滤 IPv4，`ip6` 只过滤
IPv6，而 `inet` 两个都过滤——一张表、一组链、一个 `nft list ruleset` 视图。整个
特性就这一句话：写在 `inet` 链里的 `tcp dport 8443 accept` 这一行，同时匹配来自
`172.17.0.10` 的 IPv4 SYN 和来自 `fd00:ab:ce::3` 的 IPv6 SYN。

有两个细节只在真实流量下才看得见，我想把它们演示出来而不是空口断言。第一，我
在文件里*怎么写*规则，和内核在 `nft list ruleset` 里怎么回显它们：

```nft
# 我在文件里写的：
meta nfproto ipv6 ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
meta nfproto ipv6 icmpv6 type echo-request accept
```

```bash
# nft list ruleset 打印回来的：
	ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
	icmpv6 type echo-request accept
```

地址和协议匹配本身就隐含了协议族，所以 nftables 把我多余的
`meta nfproto ipv6` 删掉了。它是被接受的合法语法，在一条规则确实没有其他协议族
线索时有用，但实战中 `icmpv6 type …` 和 `ip6 saddr …` 就是你想要的协议族限定。
第二，ICMPv6 的类型名是符号化的，而且可以直接去问 nftables：

```bash
$ nft describe icmpv6 type
pre-defined symbolic constants (in decimal):
	destination-unreachable       	                   1
	packet-too-big                	                   2
	time-exceeded                 	                   3
	parameter-problem             	                   4
	echo-request                  	                 128
	echo-reply                    	                 129
	nd-neighbor-solicit           	                 135
	nd-neighbor-advert            	                 136
```

我就是这样确认 133–136 是 NDP、2 是 PMTUD 的：用短名字，而不是用一年后会回来
读的规则集里的魔法数字。（完整列表还包括 MLD 和重定向/重编号类型。）

## 带齐 IPv6 必备项的默认拒绝规则集

下面是我实际加载的完整文件——一张 `inet` 表、input 上 `policy drop`，中间夹一小
批 v6 专属放行。实验里的地址是 ULA（`fd00::/8`），不涉及任何公网地址。

```nft
#!/usr/sbin/nft -f
# /root/fw6.nft —— 一张 inet 表：input 默认拒绝，同时覆盖 IPv4 和 IPv6。

flush ruleset

table inet fw {
    chain input {
        type filter hook input priority filter; policy drop;

        # 1. 回环永远只在本机说话
        iifname "lo" accept

        # 2. 我们自己发起的连接的回包，以及属于这些流的 ICMP 差错
        ct state established,related accept
        ct state invalid drop

        # 3a. 协议栈自己产生、也自己消费的 ICMPv6：
        #     NDP（133-136）和用于 PMTUD 的 Packet-Too-Big。
        ip6 nexthdr icmpv6 icmpv6 type {
            nd-router-solicit, nd-router-advert,
            nd-neighbor-solicit, nd-neighbor-advert,
            packet-too-big
        } accept

        # 3b. 邻居用链路本地地址和我们说话
        ip6 saddr fe80::/10 accept

        # 3c. NDP/MLD 把链路本地多播组当作目的地址
        ip6 daddr ff02::/16 accept

        # 4. 两个协议族的 ping 都放行，但限速，成本保持便宜
        ip  protocol icmp icmp type echo-request limit rate over 30/second counter drop
        ip  protocol icmp icmp type echo-request accept
        meta nfproto ipv6 icmpv6 type echo-request limit rate over 30/second counter drop
        meta nfproto ipv6 icmpv6 type echo-request accept

        # 5. 服务本身：一条规则，两个协议族
        tcp dport 8443 accept

        # 6. 一个只应存在于 v6 覆盖网络上的服务
        meta nfproto ipv6 ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept

        # 7. 其余全部丢弃，并且计数
        counter drop
    }

    chain forward {
        type filter hook forward priority filter; policy drop;
    }

    chain output {
        type filter hook output priority filter; policy accept;
    }
}
```

```bash
$ nft --check -f /root/fw6.nft   # 只查语法，不应用（无输出即通过）
$ nft -f /root/fw6.nft           # 原子加载
$ nft list ruleset               # 当前真正在跑的
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
		ct state established,related accept
		ct state invalid drop
		ip6 nexthdr ipv6-icmp icmpv6 type { packet-too-big, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
		ip6 saddr fe80::/10 accept
		ip6 daddr ff02::/16 accept
		ip protocol icmp icmp type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		ip protocol icmp icmp type echo-request accept
		icmpv6 type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		icmpv6 type echo-request accept
		tcp dport 8443 accept
		ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
		counter packets 0 bytes 0 drop
	}

	chain forward {
		type filter hook forward priority filter; policy drop;
	}

	chain output {
		type filter hook output priority filter; policy accept;
	}
}
```

留意这些归一化：`ip6 nexthdr icmpv6` 变成了 `ip6 nexthdr ipv6-icmp`，两行 echo
也丢掉了多余的 `meta nfproto ipv6`。规则 4 里成对写法的门道在于：第一行只丢弃
*超过*限额的部分（健康的实验里它的计数器一直是零），第二行放行其余全部——这是
一种不必彻底封锁 ICMPv6 就能扛住 ping 洪泛的廉价办法。

## 实测：真实的放行与真实的拦截

实验阵容：`srv6` 是被测机器（eth0 上 `fd00:ab:ce::2`，eth1 上 `172.17.0.9`），
`cli6` 是一个普通客户端（`fd00:ab:ce::3`、`172.17.0.10`）。一个监听同时服务两个
协议族——python 绑在 `::` 上：

```bash
$ ss -lntp
State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess
LISTEN 0      4096      127.0.0.11:37605      0.0.0.0:*
LISTEN 0      5                  *:8443             *:*    users:(("python3",pid=3558,fd=3))
```

现在上流量。两个协议族都通，走的是同一份规则：

```bash
$ ping6 -c 3 fd00:ab:ce::2                 # IPv6，放行
PING fd00:ab:ce::2(fd00:ab:ce::2) 56 data bytes
64 bytes from fd00:ab:ce::2: icmp_seq=1 ttl=64 time=0.104 ms
64 bytes from fd00:ab:ce::2: icmp_seq=2 ttl=64 time=0.075 ms
64 bytes from fd00:ab:ce::2: icmp_seq=3 ttl=64 time=0.056 ms

--- fd00:ab:ce::2 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2058ms
rtt min/avg/max/mdev = 0.056/0.078/0.104/0.019 ms

$ ping -c 3 172.17.0.9                      # IPv4，同一份规则
PING 172.17.0.9 (172.17.0.9) 56(84) bytes of data.
64 bytes from 172.17.0.9: icmp_seq=1 ttl=64 time=0.115 ms
64 bytes from 172.17.0.9: icmp_seq=2 ttl=64 time=0.047 ms
64 bytes from 172.17.0.9: icmp_seq=3 ttl=64 time=0.062 ms

--- 172.17.0.9 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2026ms
rtt min/avg/max/mdev = 0.047/0.074/0.115/0.029 ms
```

服务规则覆盖两个协议族——注意 `remote_ip`：

```bash
$ curl -6 -m 5 -sS -o /dev/null -w 'HTTP %{http_code} via %{remote_ip}\n' http://[fd00:ab:ce::2]:8443/
HTTP 200 via fd00:ab:ce::2
$ curl -4 -m 5 -sS -o /dev/null -w 'HTTP %{http_code} via %{remote_ip}\n' http://172.17.0.9:8443/
HTTP 200 via 172.17.0.9
```

再来一个没有规则放行的端口，两个协议族都试——连接直接超时，因为
`policy drop` 是丢弃而不是拒绝：

```bash
$ sh -c 'curl -6 -m 4 -sS -o /dev/null -w "%{http_code} via %{remote_ip}\n" http://[fd00:ab:ce::2]:9999/; echo curl exit=$?'
curl: (28) Connection timed out after 4000 milliseconds
000 via
curl exit=28
```

证明丢包确实发生在防火墙里——最后的计数器就是策略丢弃：

```bash
$ nft list chain inet fw input
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
		ct state established,related accept
		ct state invalid drop
		ip6 nexthdr ipv6-icmp icmpv6 type { packet-too-big, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
		ip6 saddr fe80::/10 accept
		ip6 daddr ff02::/16 accept
		ip protocol icmp icmp type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		ip protocol icmp icmp type echo-request accept
		icmpv6 type echo-request limit rate over 30/second counter packets 0 bytes 0 drop
		icmpv6 type echo-request accept
		tcp dport 8443 accept
		ip6 saddr fd00:ab:ce::/64 tcp dport 2222 accept
		counter packets 8 bytes 560 drop
	}
}
```

8 个包、560 字节——被拦截连接那几次重传的 SYN，全部记在最后一条规则上。一个
诚实的备注：`nft monitor trace` 在我的容器里是沉默的（逐包追踪需要我的实验网络
命名空间没有授予的上下文），所以包级别的证据靠的是计数器；普通的 `nft monitor`
（监视规则集变更）则工作正常——下面是我动态加一条规则时它的真实输出：

```bash
$ nft add rule inet fw input tcp dport 9443 accept        # 一个 shell 里
add rule inet fw input tcp dport 9443 accept              # nft monitor，另一个 shell
# new generation 13 by process 1207483 (nft)
```

链路本地流量正好验证 `fe80::/10` 那条放行——并且和入门文里说的一样，zone ID 是
必须的：

```bash
$ ping6 -I eth0 -c 2 fe80::fc29:25ff:fe16:9846%eth0      # 从 cli6 打到 srv6 的链路本地地址
ping6: Warning: source address might be selected on device other than: eth0
PING fe80::fc29:25ff:fe16:9846%eth0(fe80::fc29:25ff:fe16:9846%eth0) from :: eth0: 56 data bytes
64 bytes from fe80::fc29:25ff:fe16:9846%eth0: icmp_seq=1 ttl=64 time=0.084 ms
64 bytes from fe80::fc29:25ff:fe16:9846%eth0: icmp_seq=2 ttl=64 time=0.060 ms

--- fe80::fc29:25ff:fe16:9846%eth0 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1016ms
rtt min/avg/max/mdev = 0.060/0.072/0.084/0.012 ms
```

## ICMPv6：搞坏了它，真实的样子

我故意犯一次那个经典错误，让你以后不必亲历：在 input 钩子上成片丢弃所有
ICMPv6，然后强制一次全新的邻居解析。

```bash
$ nft insert rule inet fw input ip6 nexthdr ipv6-icmp counter drop
$ ip -6 neigh flush dev eth0             # 忘掉已经学到的邻居信息
$ ping6 -c 2 fd00:ab:ce::3                # srv6 -> cli6：需要 NDP 来解析
PING fd00:ab:ce::3(fd00:ab:ce::3) 56 data bytes

--- fd00:ab:ce::3 ping statistics ---
2 packets transmitted, 0 received, 100% packet loss, time 1015ms

$ ping6 -c 2 fd00:ab:ce::2                # cli6 -> srv6：echo 本身被丢
--- fd00:ab:ce::2 ping statistics ---
2 packets transmitted, 0 received, +2 errors, 100% packet loss, time 1013ms

$ ping -c 2 172.17.0.9                     # 同一台机器的 IPv4：完全正常
2 packets transmitted, 2 received, 0% packet loss, time 1031ms
rtt min/avg/max/mdev = 0.059/0.074/0.089/0.015 ms
```

这就是全部的失败形态：主机 IPv4 连通性完好、自我感觉健康，而 IPv6 已经死了——
邻居请求发得出去，回来的邻居公告在 input 钩子上被丢，`ip -6 neigh` 永远到不了
`REACHABLE`。计数器记录下这次错误的代价：

```bash
$ nft -a list chain inet fw input | head -6
table inet fw {
	chain input { # handle 1
		type filter hook input priority filter; policy drop;
		ip6 nexthdr ipv6-icmp counter packets 11 bytes 952 drop # handle 20
		iifname "lo" accept # handle 4
```

删掉那条坏规则，网络自己恢复——NDP 只是把没干完的活干完：

```bash
$ nft delete rule inet fw input handle 20
$ ip -6 neigh flush dev eth0
$ ping6 -c 2 fd00:ab:ce::2                  # 从 cli6
2 packets transmitted, 2 received, 0% packet loss, time 1043ms

$ ip -6 neigh show dev eth0
fd00:ab:ce::3 lladdr de:52:e7:55:19:1b DELAY
```

所以实操结论就是 RFC 4890 用更大嗓门说过的那句话：永远不要成片丢弃 ICMPv6。
NDP 类型（133–136）和 `packet-too-big`（2）必须放行；echo-request（128）可以
限速；echo-reply 和 `destination-unreachable` 最好交给
`ct state established,related` 带回，而前面那条规则已经覆盖了。 

## `ip6tables` 与现代发行版上的 nftables

"**ip6tables 与 nftables**"早已不是 2010 年的迁移故事。在 Debian 12 上，随系统
发行的 `iptables` *就是*一个 nft 后端：

```bash
$ iptables --version
iptables v1.8.9 (nf_tables)
```

也就是说旧工作流照样能用——也照样要维护一份和 IPv4 规则*分开*的 IPv6 规则集：

```bash
$ ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
$ ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$ ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
$ ip6tables -A INPUT -p tcp --dport 8443 -j ACCEPT
$ ip6tables -P INPUT DROP
$ ip6tables -L INPUT -n -v
Chain INPUT (policy DROP 0 packets, 0 bytes)
 pkts bytes target     prot opt in     out     source               destination
    0     0 ACCEPT     6    --  *      *       ::/0                 ::/0                 tcp dpt:22
    0     0 ACCEPT     0    --  *      *       ::/0                 ::/0                 ctstate RELATED,ESTABLISHED
    0     0 ACCEPT    58    --  *      *       ::/0                 ::/0
    0     0 ACCEPT     6    --  *      *       ::/0                 ::/0                 tcp dpt:8443
```

两套视图，一个内核：`nft list ruleset` 把我的 `inet` 表和它写下的 legacy
`ip6 filter` 表并排列出，还附带一句警告：

```bash
table inet fw {
	chain input {
		type filter hook input priority filter; policy drop;
		# ……就是上面那份规则集，未改动
	}
	# 这里省略 forward/output 链
}
table ip6 filter {
	chain INPUT {
		type filter hook input priority filter; policy drop;
		tcp dport 22 counter packets 0 bytes 0 accept
		ct state related,established counter packets 0 bytes 0 accept
		meta l4proto ipv6-icmp counter packets 0 bytes 0 accept
		tcp dport 8443 counter packets 0 bytes 0 accept
	}
}
# Warning: table ip6 filter is managed by iptables-nft, do not touch!
```

注意这行输出里的堆叠陷阱：两条链都挂在同一优先级的 `input` 上，所以它们*同时
生效*——legacy `ip6` 表的策略丢弃是我这条 `inet` 链底下的第二张网（它当时还在为
我的表早已放行的 ICMPv6 计数）。混用两套工具意味着你要同时推理两份互相重叠的
规则集；只写一张 `inet` 表则意味着只有一个文件要读。如果迁移后你还留着任何
legacy 规则，先用 `nft list tables` 确认还有哪些协议族的表存在，再相信一次
`curl`。

## 最小可用规则集

把这套东西搬到真机上只是替换，不是重设计：换成你真实的接口（该用
`iifname "eth0"` 就用）、真实的服务端口、真实的地址策略——全局 `2000::/3` 来源
或某个 ULA 范围，要*有意*放行，而不是无意中放行。持久化方面和 nftables 那篇一
样：`/etc/nftables.conf` 挂在 `nftables.service` 后面，每次加载前先
`nft --check`，SSH 上改防火墙之前先架一个回滚定时器。

唯一我想纹在脑子里的：**永远不要成片丢弃 ICMPv6。** 无条件放行 NDP 和
`packet-too-big`，放行链路本地 `fe80::/10` 来源与 `ff02::/16` 多播目的，echo
限速，让 `ct state established,related` 把差错报文带回来。在这之上的一切——
默认拒绝、计数器、一张 `inet` 表管两个协议族——相比之下都平淡无奇，而这正是重
点所在。
