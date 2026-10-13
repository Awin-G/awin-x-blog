---
title: "systemd-resolved 实战：被你遗忘的 127.0.0.53 本地存根解析器"
description: "systemd-resolved 是大多数系统早已在跑、却被悄悄绕开的本地缓存存根解析器，监听 127.0.0.53。一篇结合 resolvectl、缓存、分流 DNS、DNS over TLS 与 mDNS 的实战走读，全部输出来自一台 Arch 主机。"
pubDate: 2027-01-15
lang: zh
translationKey: systemd-resolved
tags: [networking, systemd]
featured: false
keywords:
  - systemd-resolved
  - resolvectl
  - 存根解析器
  - DNS over TLS
  - 分流 DNS
---

你的机器上已经跑着一个带缓存的 DNS 解析器、一个 DoT 客户端、一个**分流 DNS**引擎、一个 mDNS 响应器——开机自启，而且你几乎肯定没亲手装过它。它就是 **`systemd-resolved`**，随 systemd 发行了整整十年的那个本地**存根解析器**——并且它只用一条你大概从没敲过的命令管理：**`resolvectl`**。

这里有个我在自己 Arch 主机上撞到的反转，也正是我写这篇的全部理由：`systemd-resolved` 正在运行，*而且监听在 `127.0.0.53`*，但我的应用从不走它。下面每一行都是那台机器的真实输出，只在一堆 Docker 网桥会变成噪音的地方做了裁剪。没有一处是编的，并且每一个需要 root 的命令我都标了出来——在这台 systemd 262 主机上，需要 root 的比我预想的还多。如果你想先补齐"递归是怎么一步步走的"那套背景，我的[《DNS 究竟是怎么解析的》](/zh/posts/how-dns-resolves/)是配套阅读；这一篇只讲本地这一半。

<figure>
<svg viewBox="0 0 640 180" width="100%" role="img" aria-label="应用把查询发给 127.0.0.53 上的 systemd-resolved 存根解析器；命中走缓存，未命中按接口转发到上游，优先走 DNS over TLS" xmlns="http://www.w3.org/2000/svg" style="max-width:640px">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="12" y="60" width="110" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="67" y="93" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="currentColor">app</text>
  <line x1="122" y1="88" x2="208" y2="88" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="165" y="78" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor">query</text>
  <rect x="212" y="46" width="180" height="84" rx="12" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="302" y="76" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="currentColor">systemd-resolved</text>
  <text x="302" y="95" text-anchor="middle" font-family="monospace" font-size="13" fill="currentColor">127.0.0.53:53</text>
  <rect x="238" y="104" width="128" height="18" rx="9" fill="#0f766e"/>
  <text x="302" y="117" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">cache hit?</text>
  <text x="302" y="38" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#0f766e">stub listener + cache</text>
  <line x1="392" y1="88" x2="478" y2="88" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="435" y="78" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="currentColor">miss</text>
  <rect x="482" y="56" width="146" height="64" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <text x="555" y="82" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="currentColor">upstream</text>
  <text x="555" y="102" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#0f766e">DoT :853</text>
</svg>
<figcaption>你的应用先连到 <code>127.0.0.53</code> 上的本地 <strong>systemd-resolved</strong> 存根；命中直接走缓存，未命中转发给对应接口的上游——理想情况下走 DNS over TLS。可要是没人指向这个存根，那份缓存就只是死重量。</figcaption>
</figure>

## systemd-resolved 到底是什么（以及它为什么早就在跑）

概念上，`systemd-resolved` 是四样东西拼在一起：

- 一个跑在 `127.0.0.53` 的**缓存存根解析器**（`127.0.0.54` 归 LLMNR）。每个通过 libc 解析域名的进程都能指向它，共享同一份缓存。
- 一个**按接口的 DNS 调度器**。它不保存"那台 DNS 服务器"，而是给*每个网络接口*各存一台，然后按名字决定问哪一台。这就是**分流 DNS**，也是最多人忽略的部分。
- 一个**懂加密的转发器**。它能把上游查询走 **DNS over TLS**（`DNSOverTLS=`）发出去，并尝试校验 DNSSEC，于是一条恶意 LAN 就没法轻易偷看或伪造你的应答。
- 一个面向 `LLMNR` 和 mDNS（`.local`）的**链路本地名字引擎**，你的机器靠它在没有服务器的情况下找到 `printer.local` 或某个 Windows 邻居。

它不是魔法，也不是那种"我自己从根服务器一路走下来"的递归解析器——它转发给配置好的上游并缓存答案。这个区别我放到最后再讲，因为它决定了你到底还要不要留着它。

`resolvectl` 就是全部操作面板。我这台机器上的 `resolvectl --version`：

```bash
$ resolvectl --version
systemd 262 (262-1-arch)
+PAM +AUDIT -SELINUX ... +GNUTLS +OPENSSL ...
```

服务本身健康、按 socket 激活：

```bash
$ systemctl status systemd-resolved
● systemd-resolved.service - Network Name Resolution
     Loaded: loaded (/usr/lib/systemd/system/systemd-resolved.service; enabled; preset: enabled)
     Active: active (running) since Mon 2026-10-12 04:12:29 CST; 1 day 3h ago
   TriggeredBy: ● systemd-resolved-monitor.socket
               ● systemd-resolved-varlink.socket
   Main PID: 360 (systemd-resolve)
     Status: "Processing requests..."
```

这两个被触发的 socket 后面很关键——它们正是下面某条命令在没有 root 时失败的原因。

## systemd-resolved 对比 nss-dns、dnsmasq 与 Unbound

大家总把这些混为一谈，其实它们不在同一层：

| 解析者 | 它是什么 | 缓存 | 按接口 | DoT/DoH | LLMNR/mDNS |
|---|---|---|---|---|---|
| glibc `nss-dns` | libc 读 `/etc/resolv.conf`，明文发出 | 无 | 否 | 否 | 否 |
| `dnsmasq` | 独立守护进程，转发器 + 缓存 + DHCP | 有 | 部分 | 仅转发 | 靠 avahi |
| `systemd-resolved` | systemd 自带的解析器 | 有 | 原生支持 | 客户端，可选 | 内置 |
| `Unbound` | 完整的递归 + 校验解析器 | 有 | 你自己接 | 走向上游 | 无 |

一句大实话：如果你要的从来只是"读 `/etc/resolv.conf` 然后解析"，那 `nss-dns` 至今干得挺好，`resolvectl` 给不了你什么。如果你要的是一台带缓存、还带 DHCP 给局域网的守护进程，`dnsmasq` 是经典。如果你已经有 `systemd`（你当然有）、又有多个接口、一个 VPN，或者想不多装一个包，那 `systemd-resolved` 早就在解决问题了。这就引到了人人都会踩的那一处：那个把应用指向它的文件。

## 127.0.0.53 存根与 /etc/resolv.conf 符号链接

应用够到存根的途径是 `/etc/resolv.conf`，而它在 systemd 机器上*本来应该*被接成一条指向 `/run` 的符号链接：

```bash
# 当 systemd-resolved 接管 /etc/resolv.conf（mode: stub）时，它是一个指向
# /run/systemd/resolve/ 的符号链接。以下是我机器上真实存在的两个文件：
$ ls -l /run/systemd/resolve/
-rw-r--r-- 1 systemd-resolve systemd-resolve 920 ... stub-resolv.conf   # 存根
-rw-r--r-- 1 systemd-resolve systemd-resolve 808 ... resolv.conf        # 直连上游

$ cat /run/systemd/resolve/stub-resolv.conf
nameserver 127.0.0.53
options edns0 trust-ad
search .
```

两个不同的文件，而 `/etc/resolv.conf` 指向哪一个，决定了一切：

- `stub-resolv.conf` 里是 `nameserver 127.0.0.53`——应用打到缓存。**用这个。**
- `resolv.conf` 里列的是*真正的上游*——应用绕过缓存，直接找 `223.5.5.5`。这是"算了，干脆用上游"的逃生门。在把线接好的发行版上，你会
  `ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf`。

现在说我实际面对的这台机器。我这里*两条*都没链接。NetworkManager 写自己的文件，于是存根在跑，却成了没人认领的孤儿：

```bash
$ ls -l /etc/resolv.conf
-rw-r--r-- 1 root root 75 10月12日 16:50 /etc/resolv.conf       # 一个真实文件，不是符号链接
$ cat /etc/resolv.conf
# Generated by NetworkManager
nameserver 223.5.5.5
nameserver 119.29.29.29

$ ss -tuln | grep 53
udp   UNCONN 0  0 127.0.0.54:53        0.0.0.0:*   # LLMNR 存根
udp   UNCONN 0  0 127.0.0.53%lo:53     0.0.0.0:*   # DNS 存根，正在 LISTEN
tcp   LISTEN 0  0 127.0.0.53%lo:53     0.0.0.0:*
tcp   LISTEN 0  0 127.0.0.54:53        0.0.0.0:*
```

所以 `127.0.0.53` 上的存根是活的、健康的，而我的默认解析器却是 `223.5.5.5`。
`resolvectl status` 用一个词就点破了诊断——**`resolv.conf mode: foreign`**：

```bash
$ resolvectl status
Global
           Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
    resolv.conf mode: foreign
  Current DNS Server: 223.5.5.5
         DNS Servers: 223.5.5.5 119.29.29.29
Fallback DNS Servers: 9.9.9.9#dns.quad9.net 2620:fe::9#dns.quad9.net
                      1.1.1.1#cloudflare-dns.com ...

Link 3 (tun0)                                          # VPN
    Current Scopes: DNS
         Protocols: -DefaultRoute +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 100.100.100.101
        DNS Domain: ~internal
     Default Route: no

Link 2 (wlp2s0)                                        # Wi-Fi，默认路由
    Current Scopes: DNS LLMNR/IPv4 LLMNR/IPv6 mDNS/IPv4 mDNS/IPv6
         Protocols: +DefaultRoute +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 223.5.5.5
       DNS Servers: 223.5.5.5 119.29.29.29
     Default Route: yes
```

整篇的论点就浓缩在这一屏里。`systemd-resolved` 在跑，缓存在，但 `foreign`
模式意味着大多数应用根本看不到它——它们读 NetworkManager 那个文件，直奔阿里
DNS。而 `resolvectl` 以及任何显式打到存根的查询*确实*在用缓存。这就是"你遗忘
的那台存根解析器"，而在这样一台机器上第一件该修的事，就是把
`/etc/resolv.conf` 交还给存根。

## 缓存、resolvectl statistics，以及它为什么给我回 权限不够

缓存是回报：热点名字的重复查询在微秒级从内存答出，而且所有进程共享它。查看和
清空它的命令是：

```bash
$ resolvectl statistics        # 当前缓存大小、命中/未命中
$ resolvectl flush-caches      # 全部清空
```

唯独在我这台机器上，普通用户一条都跑不了：

```bash
$ resolvectl statistics
Failed to issue io.systemd.Resolve.Monitor.DumpStatistics() varlink call: 权限不够
$ resolvectl flush-caches
Failed to issue io.systemd.Resolve.Monitor.FlushCaches() varlink call: 权限不够
```

这是一个真实的 systemd-262 改动，我要白纸黑字记下来：缓存统计和清空从老的
D-Bus 方法（`DumpStatistics` 已经没了——直接调用会回 `Unknown method`）挪到了
受权限管控的 `io.systemd.Resolve.Monitor` varlink socket 上，它会用
`权限不够`（没有足够权限）回绝非特权调用方。所以在这台主机上，
**`resolvectl statistics` 和 `flush-caches` 都需要 root**，而下一节那些只读查询
不需要。我这儿没有 sudo，所以诚实的答案是：在 `262` 上、从一个非特权 shell，
我没法给你演示真实的命中/未命中计数。在更老的 systemd（≤ 252）上，它们过去是
以一张 `Current Cache Size` / `Cache Hits` / `Cache Misses` 的表返回的，没有这
种降级。

## 按接口的 DNS 与分流 DNS（resolvectl domain）

这是当你网络不止一个时，resolved 值得留下的那个功能。它把每个*名字*路由到正
确的链路。用 `resolvectl domain` 读这些域名：

```bash
$ resolvectl domain
Global:
Link 3 (tun0): ~internal
Link 60 (br-c9b53f86be7f):
...
Link 2 (wlp2s0):
```

`tun0` 上的 `~internal` 是一个**路由域名**。开头的 `~` 表示"把 `internal` 之下
的名字发给*这条*链路的解析器，但不要把它当成搜索后缀追加。"再配上 VPN 的
`Default Route: no` 和 Wi-Fi 的 `yes`，这套策略就是一次教科书式的分流：
`db.internal` 走隧道的解析器（`100.100.100.101`，由跑着 `tun0=10.126.126.3/24`
的 Easytier 守护进程喂给它），其余全部走 Wi-Fi 的 `223.5.5.5`。如果你*就是*想
让 VPN 抢下所有 DNS，那条链路需要 `Default Route: yes`，用 `resolvectl
default-route tun0 yes` 设置（需要 root）——上游的 `~.` 哨兵域名起的作用等同
于一条路由条目。

为了用可控的方式演示这套机制，我在一个私有 Docker 网络上起了个一次性解析器
——不用拉镜像，`coredns/coredns` 本地就有。它只服务一个内网 zone：

```bash
# 容器里的 Corefile（裁剪过）：
lab.internal.:53 {
    hosts { 10.99.0.42 api.lab.internal
            10.99.0.43 db.lab.internal
            fallthrough }
    whoami
    log
}
docker run -d --name corednsdemo --net dnsdemo -p 1053:53/udp -p 1053:53/tcp \
  coredns/coredns -conf /etc/coredns/Corefile

# 从同一网络上的第二个容器里：
$ nslookup api.lab.internal corednsdemo
Name:   api.lab.internal
Address: 10.99.0.42

$ nslookup example.com corednsdemo
** server can't find example.com: REFUSED
```

`*.lab.internal` 解析到我埋进去的地址；一个公网名字直接 `REFUSED`。这正是每
链路解析器干的事：它权威地回答*自己那一段*后缀，其余一律拒绝——这也正是分流
DNS 按后缀而不是按"那台 DNS 服务器"来路由的原因。我还在容器网络之外、从主机经
发布端口验证过：

```
QUERY api.lab.internal -> 127.0.0.1:1053  answers=1  A=['10.99.0.42']
QUERY db.lab.internal  -> 127.0.0.1:1053  answers=1  A=['10.99.0.43']
```

## DNS over TLS（DNSOverTLS）与 DNSSEC

状态屏上写着 `-DNSOverTLS DNSSEC=no/unsupported`——DoT 关着，且在这套配置下
DNSSEC 不支持。你用一段 drop-in 打开 DoT（`DNSOverTLS=yes` 表示必须用，
`opportunistic` 表示尽力），再把某个链路的 `DNS=` 指向支持 DoT 的服务器，比如
`1.1.1.1#cloudflare-dns.com`。启用和重载都需要 root（改 drop-in、
`systemctl restart systemd-resolved`），所以我就用你也能用的、免 root 的办法
验证了*传输层*——向 Cloudflare 解析端口的裸 TLS 握手：

```bash
$ openssl s_client -connect 1.1.1.1:853
subject=CN=cloudflare-dns.com
issuer=CN=SSL.com SSL Intermediate CA ECC R2
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Verify return code: 0 (ok)
```

`CN=cloudflare-dns.com` 配上 `Verify return code: 0 (ok)`，就是"这台解析器会说
DoT、并且出示的证书链能校验到你要配的那个 auth-name"的证据——不需要
`TCP/853` 抓包，也不需要 root。等 resolved 自己上了 DoT，`resolvectl query` 会
逐条应答告诉你；注意我这条明文查询带的是 `acquired via local or encrypted
transport: no`：

```bash
$ resolvectl query blog.awin-x.top
blog.awin-x.top: 88.218.79.95                               -- link: wlp2s0
-- Information acquired via protocol DNS in 55.4ms.
-- Data is authenticated: no; Data was acquired via local or encrypted transport: no
-- Data from: network
```

最后这行同时兼任 DNSSEC 的读数：今天 `authenticated: no`，等上游会校验、并设了
`DNSSEC=yes` 之后它才会翻成 `yes`。（注意这行*不是*你的证书检查——那件事交给
`openssl` 握手。）对于私有的、你不会公开的域名，DNSSEC 是杀鸡用牛刀；对公网域
名，挑一个会校验的上游、让 resolved 信任 `AD` 位就行，存根文件里那个
`options trust-ad` 干的就是这个。

## 三大坑，人人都会踩

**改 `/etc/resolv.conf` 会被覆盖。**它写着 `# Generated by NetworkManager`。你
在里面敲的任何东西，下次重连都会被重新生成。要配就配那个真正拥有它的东西——
NetworkManager，或者通过 `resolvectl` 和 `resolved.conf.d/` drop-in 配
`systemd-resolved`——永远别去配那个文件。（比如我那个全局
`DNS=223.5.5.5 119.29.29.29`，来自
`/etc/systemd/resolved.conf.d/99-easytier-dns.conf`，而不是我改 resolv.conf 改
出来的。）

**VPN 的 DNS "没生效"。**VPN 拉起来不等于它的解析器就赢了。我的 `tun0` 是
`Default Route: no`，所以普通查询仍然走 Wi-Fi。只有 `~internal` 之下的名字才用
隧道。你要是想让 VPN 兜住一切，就把它标成默认路由（需要 root）——否则这就是分
流 DNS 的正确行为，不是 bug。

**`.local` 撞名。** `*.local` 是留给 mDNS/LLMNR 的，所以*就把它当成*一个本地
链路名字，永不转发到单播。后果：一个正经的、以 `.local` 结尾的公网 DNS zone永
远解析不了；一个多归属的 `.local` 名字还可能在多台主机之间飘。我的查询也显示，
这种失败不过是"没人答应"：

```bash
$ resolvectl query foo.local
foo.local: resolve call failed: All attempts to contact name servers or networks failed
```

链路上没有响应者，也没有单播兜底——这是设计如此。

## 什么时候该用 Unbound 或 dnsmasq 替换 systemd-resolved

这些情况下就留着 resolved：它本来就在跑、你想要按接口的分流 DNS、你用 VPN，
而且缓存加可选 DoT 就够。别跟它较劲。

而当你的需求超出了一个转发器，就该换家伙了。那条清晰的界线是：resolved *转发并
缓存*；**Unbound** *自己递归并校验*，带 qname 最小化；而当你想要一台缓存 + DHCP
+ 广告拦截上游三合一的二进制时，**dnsmasq** 依旧是小盒子的冠军。如果你明确想
要一台自己从根服务器一路走下来、本地做 DNSSEC 校验、或者服务整个 LAN 的解析
器，那你就已经超出了一个存根的定位——那正是我的
[《自建递归 DNS 解析器》](/zh/posts/self-hosted-dns-resolver/)那篇的主题。就我
这台机器而言，一个 VPN 在做分流，resolved 已经值回票价；我唯一会做的改动，是
把 `/etc/resolv.conf` 重新指到 `127.0.0.53`，好让我从没舍得关掉的那份缓存，终
于被用上。
