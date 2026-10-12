---
title: "nftables 实战：无痛从 iptables 迁移到 nftables"
description: "一份 nftables 实战指南：从 tables/chains/rules 心智模型讲起，给出服务器可直接复制的默认拒绝规则集，用集合与命名区间管理 IP 列表，讲清 masquerade 与端口转发 NAT、持久化，以及如何读懂 nft list ruleset，并附上不把自己锁在 SSH 门外的回滚办法。"
pubDate: 2026-11-26
lang: zh
translationKey: nftables-in-practice
tags: [linux, networking, security]
featured: false
keywords:
  - nftables
  - 从 iptables 迁移到 nftables
  - nftables 规则集
  - 防火墙
  - masquerade
---

`nftables` 是那套终于让 Linux 包过滤从“四个工具”变成“一个东西”的**防火墙**。如果你维护过 `iptables` 规则，你一定熟悉那套仪式：IPv4 用 `iptables`，IPv6 用 `ip6tables`，这个发行版是 legacy、那个发行版是 `iptables-nft`，任何像样的地址列表都得上 `ipset`，而每次改一条正在生效的链，心里都有点发虚。**从 iptables 迁移到 nftables** 不只是换个语法——它用一个 `nft` 二进制替代了四个工具，也让你可以把整份**防火墙**规则从上到下读懂。我从家里的路由器到公网 VPS，把所有机器都迁了过来，下面就是我当初希望有人递给我的那份操作手册。

## 心智模型：tables → chains → rules

nftables 里只有三个名词，理解之后剩下的都只是语法。

- **表（table）** —— 给链分组的命名空间。每张表都有一个*协议族*：`ip`、`ip6`、`inet`、`arp`、`bridge` 或 `netdev`。你几乎总是想要 **`inet`**，它把 IPv4 和 IPv6 规则放进同一张表。仅仅这一个选择，就删掉了整份 `iptables`/`ip6tables` 的重复。
- **链（chain）** —— 一组有序的规则。挂到**钩子（hook）**上的链才能看到真实流量；普通链只是一个用 `jump` 调用的子程序。带钩子的链需要三样东西：`type`（`filter`、`nat`、`route`）、`hook`（`prerouting`、`input`、`forward`、`output`、`postrouting`）和 `priority`。
- **规则（rule）** —— 一个匹配加上一个动作。`tcp dport 443 accept` 就是一条规则。规则在链内自上而下执行，先匹配先赢，`policy` 决定什么都没匹配上时怎么办。

**优先级（priority）** 是最容易绊人的地方。内核对同一个钩子上的链，是跨*所有表*按优先级升序执行的。所以 `priority dstnat`（`-100`）的 `nat` 链，会在同一个钩子上先于 `priority filter`（`0`）的 `filter` 链运行。你几乎不用手写数字——那些具名值存在，就是为了让你永远不必写。

<figure>
  <svg viewBox="0 0 800 360" width="100%" role="img" aria-labelledby="nft-path-title nft-path-desc" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="nft-path-title">数据包经过 nftables 各钩子的路径</title>
    <desc id="nft-path-desc">数据包从 prerouting 进入，经过路由决策，再走 input（本机投递）或 forward（转发），最后经 postrouting 发出。</desc>
    <g fill="none" stroke="#0f766e" stroke-width="1.5">
      <rect x="20" y="178" width="70" height="44" rx="8" stroke-opacity="0.4"/>
      <rect x="140" y="178" width="130" height="44" rx="8"/>
      <rect x="320" y="178" width="130" height="44" rx="8"/>
      <rect x="440" y="68" width="120" height="44" rx="8"/>
      <rect x="610" y="68" width="150" height="44" rx="8" stroke-opacity="0.4"/>
      <rect x="610" y="178" width="150" height="44" rx="8"/>
      <rect x="440" y="278" width="120" height="44" rx="8"/>
      <rect x="610" y="278" width="150" height="44" rx="8"/>
    </g>
    <g stroke="#0f766e" stroke-width="1.5">
      <line x1="90" y1="200" x2="130" y2="200"/><polygon points="134,200 124,195 124,205" fill="#0f766e"/>
      <line x1="270" y1="200" x2="310" y2="200"/><polygon points="314,200 304,195 304,205" fill="#0f766e"/>
      <line x1="385" y1="178" x2="385" y2="90"/><line x1="385" y1="90" x2="430" y2="90"/><polygon points="434,90 424,85 424,95" fill="#0f766e"/>
      <line x1="560" y1="90" x2="600" y2="90"/><polygon points="604,90 594,85 594,95" fill="#0f766e"/>
      <line x1="685" y1="112" x2="685" y2="168"/><polygon points="685,172 680,162 690,162" fill="#0f766e"/>
      <line x1="385" y1="222" x2="385" y2="300"/><line x1="385" y1="300" x2="430" y2="300"/><polygon points="434,300 424,295 424,305" fill="#0f766e"/>
      <line x1="560" y1="300" x2="600" y2="300"/><polygon points="604,300 594,295 594,305" fill="#0f766e"/>
      <line x1="685" y1="222" x2="685" y2="268"/><polygon points="685,272 680,262 690,262" fill="#0f766e"/>
      <line x1="760" y1="300" x2="778" y2="300"/><polygon points="782,300 772,295 772,305" fill="#0f766e"/>
    </g>
    <g fill="currentColor" text-anchor="middle">
      <text x="55" y="205">入</text>
      <text x="205" y="198" font-weight="600">prerouting</text>
      <text x="205" y="214" font-size="10" opacity="0.7">nat · dstnat · -100</text>
      <text x="385" y="205">路由决策</text>
      <text x="500" y="88" font-weight="600">input</text>
      <text x="500" y="104" font-size="10" opacity="0.7">filter · 0</text>
      <text x="685" y="94">本机进程</text>
      <text x="685" y="198" font-weight="600">output</text>
      <text x="685" y="214" font-size="10" opacity="0.7">filter · 0</text>
      <text x="500" y="298" font-weight="600">forward</text>
      <text x="500" y="314" font-size="10" opacity="0.7">filter · 0</text>
      <text x="685" y="298" font-weight="600">postrouting</text>
      <text x="685" y="314" font-size="10" opacity="0.7">nat · srcnat · +100</text>
      <text x="770" y="292" font-size="10" opacity="0.7">出</text>
    </g>
  </svg>
  <figcaption>每个数据包都要经过这五个钩子。只有当你在某处挂了链，它才会看到流量：<code>prerouting</code> 在路由决策之前，<code>input</code> 或 <code>forward</code> 在其后，<code>postrouting</code> 在发出的路上。</figcaption>
</figure>

## 从 iptables 迁移到 nftables：到底变了什么

- **一个工具。** `nft` 取代 `iptables`、`ip6tables`、`arptables`、`ebtables` 和 `ipset`。
- **一个地址族视图。** `table inet` 让同一条规则同时匹配 IPv4 和 IPv6，你不再维护两套并行规则。
- **链由你定义。** 没有固定的 `INPUT`/`OUTPUT`/`FORWARD` 供你追加。你自己建链，再挂到想要的位置。
- **集合是原生能力。** 一个 IP 列表是一等对象，成员查找很快——不需要 `ipset`，也不需要为每个地址生成一条链。
- **原子加载。** `nft -f ruleset.nft` 在一次事务里替换*整份*规则集。只要有一行解析失败，就什么都不应用。
- **真正的配置文件。** 规则集是可以进版本管理的文本，而不是一百条 `iptables -A` 累积下来的残渣。

```bash
# 旧世界
iptables  -A INPUT -p tcp --dport 22 -j ACCEPT
ip6tables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables  -A INPUT -j DROP

# 新世界：一张表、一条链、两个协议族
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority filter; policy drop; }'
nft add rule  inet filter input tcp dport 22 accept
```

实际用起来，我不会在命令行里手敲 `nft add`。我把整份规则写进文件再加载——也就是下一节的内容。

## 一份可直接用的服务器 nftables 规则集

这是我给公网机器用的规则集：input 上**默认拒绝**，放行回环，放行已建立连接，丢弃无效包，放行 SSH 与 HTTP(S)，其余全部丢弃并计数，方便我看噪声。

```nft
#!/usr/sbin/nft -f
# /etc/nftables.conf — 公网服务器的默认拒绝防火墙

flush ruleset

table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;

        # 1. 回环永远可以和自己通信
        iifname "lo" accept

        # 2. 我们自己发起的连接的回包，以及 ICMP 差错
        ct state established,related accept
        ct state invalid drop

        # 3. 真正需要的 ICMP（v4 与 v6 写在一起）
        ip  protocol icmp   icmp   type { echo-request, destination-unreachable, time-exceeded } accept
        ip6 nexthdr  icmpv6 icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept

        # 4. SSH：放行，但对每个来源的新连接洪水做限速
        tcp dport 22 ct state new limit rate over 8/minute burst 4 packets
        tcp dport 22 accept

        # 5. Web
        tcp dport { 80, 443 } accept

        # 6. 剩下的全部丢弃，并计数
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

有几点值得点出来：

- `flush ruleset` 让文件自包含：加载它就替换掉原有的一切，所以这个文件就是全部真相。
- 顺序很重要。`ct state established,related accept` 必须在默认丢弃之前，否则连你自己发起的 SSH 的出站回包都会被丢掉。
- `limit rate over 8/minute` 只在一个来源的新连接超过突发限额时才会生效；正常登录完全感觉不到。
- `forward` 上的 `policy drop` 在机器开始路由的那一刻就变得关键——无论是路由器，还是跑着挂在网桥后面虚拟机的宿主机。网络隔离策略就住在这里；如果你在划分网络，见[家庭网络分段](/zh/posts/home-network-segmentation/)。
- 如果机器上有 **Docker**，它发布的端口会自己写规则。把服务端口绑在回环上再用反向代理转发。我那份[VPS 加固清单](/zh/posts/hardening-a-public-server/)讲了这一点，以及 SSH 密钥、fail2ban、自动更新等前置工作。

## 用集合与命名区间管理 IP 列表

集合是 nftables 真正拉开与 iptables 差距的地方。集合是一个命名的值集合，规则可以一步就完成匹配。

```nft
table inet filter {
    # 精确地址的命名集合
    set admin_hosts {
        type ipv4_addr
        flags interval
        elements = { 198.51.100.7, 203.0.113.0/24 }
    }

    # 命名区间集合：范围与 CIDR，自动合并
    set bogons {
        type ipv4_addr
        flags interval
        auto-merge
        elements = {
            0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
            172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4
        }
    }

    chain input {
        type filter hook input priority filter; policy drop;
        # ...
        ip saddr @bogons drop
        tcp dport 22 ip saddr @admin_hosts accept
        # ...
    }
}
```

更新正在生效的集合，而不用碰防火墙的其余部分：

```bash
# 往运行中的集合加一个地址——立即生效
nft add element    inet filter admin_hosts { 203.0.113.55 }
# 移除它
nft delete element inet filter admin_hosts { 203.0.113.55 }
# 查看集合里到底有什么
nft list set inet filter admin_hosts
```

因为匹配是一次集合查找，而不是一长串比较，所以一万个地址的集合与十个地址的集合，每个包的开销大致相同。这就是一个能长长长、和一个你总得替它道歉的**防火墙**之间的差别。`flags interval` 配合 `auto-merge`，让你可以写下 `10.0.0.0-10.0.0.255` 以及彼此重叠的 CIDR，而 nftables 会自己把它们合并成最小的区间集合。

## NAT：masquerade、源 NAT 与端口转发

nftables 的 NAT 只是一条 `type nat` 的普通链。源 NAT 放在 `postrouting` 链里；**masquerade** 会把源地址改写出接口当前的地址，正是动态 WAN 想要的。

```nft
table inet nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname "eth0" masquerade
    }
}
```

如果是静态链路，更推荐显式 SNAT，这样就不依赖接口地址变化——`oifname "eth0" snat to 203.0.113.10`。

端口转发就是 `prerouting` 里的目的 NAT：

```nft
table inet nat {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        # 公网 :8080 -> 内网 Web 服务器
        iifname "eth0" tcp dport 8080 dnat to 10.0.0.5:80
        # 公网 :2222 -> 实验机的 SSH
        iifname "eth0" tcp dport 2222 dnat to 10.0.0.9:22
    }
}
```

有两件常被忘掉的事。第一，转发需要 `net.ipv4.ip_forward=1`，以及 `forward` 链里匹配的 `accept`——masquerade 自己不会打开转发通路。

```bash
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-forward.conf
```

```nft
    chain forward {
        type filter hook forward priority filter; policy drop;
        iifname "eth0" oifname "lan0" ct state established,related accept
        iifname "eth0" oifname "lan0" tcp dport { 22, 80 } accept
    }
```

第二，DNAT 发生在 `prerouting`，也就是路由决策之前，所以 `forward` 过滤链看到的包，目的地已经指向内网主机了。

## 持久化：让防火墙扛过重启

规则集活在核心里，会随机器一起消失。解法是一个文件加一个 unit。

```bash
# /etc/nftables.conf 由 nftables.service 在启动时加载
sudo nft --check -f /etc/nftables.conf   # 只做语法检查，不应用
sudo nft -f /etc/nftables.conf           # 立即应用（原子）

# Debian / Ubuntu
sudo systemctl enable --now nftables
systemctl status nftables --no-pager

# 把正在运行的规则抓回文件里
sudo sh -c 'nft list ruleset > /etc/nftables.conf'
```

RHEL/Fedora 系里 unit 同样是 `nftables.service`，但它加载的是 `/etc/sysconfig/nftables.conf`，后者再 `include` 你的文件。不管哪个发行版，模型都一样：文件是唯一事实来源，unit 在启动时重放它，而由于 `nft -f` 是原子的，写坏的文件绝不会把你留在半配置状态。

## 用 nft list ruleset 读懂规则集

一个工具的一半价值，在于一个统一的视图。

```bash
nft list ruleset               # 所有表、所有协议族
nft list table inet filter     # 只看 filter 这张表
nft -a list ruleset            # 给每条规则标注 handle
nft list sets                  # 你的 IP 列表及其元素
nft monitor                    # 实时跟踪规则集变化
```

handle 是你删除单条规则的钥匙——`nft delete rule inet filter input handle 27`——而 `nft list ruleset` 输出的文件本身就是一份可用的规则集，这正是上面持久化那步回写能成立的原因。

## 别把自己锁在门外

远程防火墙只有一条铁律：永远不要成为自己回不去的*唯一*原因。具体就是：在设定默认拒绝策略之前先放行 SSH 端口；留一个会话开着；并确认你知道怎么进服务商的控制台。

```bash
# 1. 在动手之前，先保存当前正在运行的规则
sudo nft list ruleset > /root/nftables.rollback.nft

# 2. 布下一个自动回滚：5 分钟内没回来就还原
sudo sh -c 'sleep 300; nft -f /root/nftables.rollback.nft' &

# 3. 应用新规则集（这里若语法出错，什么都不会变）
sudo nft -f /etc/nftables.conf

# 4. 用一个新终端登录，确认能进
ssh -p 22 deploy@203.0.113.10 'echo still here'
#    然后取消计时器
sudo pkill -f 'sleep 300'
```

如果第 4 步失败，什么都别做：五分钟后旧规则集回来，你的会话就恢复了。先用 `nft --check -f` 校验，这个习惯对你零成本，却能省下一次跑控制台。

## 短版总结

**从 iptables 迁移到 nftables** 基本是“做减法”。四个工具变成一个；两套规则（IPv4 与 IPv6）变成一张 `inet` 表；`ipset` 那一套舞蹈消失在原生集合里。心智模型就三个词——表、链、规则——再加上钩子与优先级，然后整份**防火墙**就是一份你能读懂的文件。写一个默认拒绝的 `input`，`policy drop`；放行 `lo`、`established,related`、你需要的 ICMP、SSH 和 80/443；其余用计数器丢弃。NAT 放在 `nat` 链里——**masquerade** 在 `postrouting`，`dnat` 在 `prerouting`。把它持久化为 `/etc/nftables.conf`，交给 `nftables.service`；在远程机器上加载之前，先布一个五分钟回滚，再从第二个会话确认。做过一次之后你会发现，iptables 看起来才像那个痛苦版本。
