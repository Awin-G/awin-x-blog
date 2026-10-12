---
title: "Docker networking 详解：容器眼里的网络到底长什么样"
description: "一份从容器内部出发的 Docker networking 实操：docker0 怎么发 IP、怎么 NAT 到外网，veth 如何把 eth0 接到网桥，user-defined bridge 为什么自带 DNS，-p 到底做了什么，host/none/macvlan/overlay 的取舍，以及用真实输出调试 container networking 的固定套路。"
pubDate: 2026-12-06
lang: zh
translationKey: docker-networking
tags: [networking, devops, self-hosting]
featured: true
keywords:
  - Docker networking
  - docker bridge network
  - container networking
  - docker0
  - veth
---

大多数讲 **Docker networking** 的文章从守护进程和命令行参数讲起。我觉得从墙的另一侧——也就是容器内部——讲起更清楚。站在容器里看，container networking 其实就那么几样东西：一张叫 `eth0` 的网卡、一条指向你并不认识的网关的默认路由、一个可能存在也可能不存在的 DNS 服务器，外加主机侧一座叫 `docker0` 的网桥。只要你能从两侧同时看见这四样东西，几乎所有“我的容器怎么互相不通”的问题都能有答案。

下面全部是这台机器（Docker 29.9.0、6.x 内核、`iptables v1.8.13 (nf_tables)`）上真实容器的真实输出，写这段的时候一路建了一路删。全程不需要 `--privileged`。

## 默认 bridge：docker0 给容器发地址、发路由

每台 Docker 主机都有一张 `docker0` 网卡。它就是一个普通的 Linux bridge，也是默认的 **docker bridge network**。Docker 自己对它的描述很密，但很全：

```console
$ docker network inspect bridge --format '{{json .Options}}'
{"com.docker.network.bridge.default_bridge":"true",
 "com.docker.network.bridge.enable_icc":"true",
 "com.docker.network.bridge.enable_ip_masquerade":"true",
 "com.docker.network.bridge.host_binding_ipv4":"0.0.0.0",
 "com.docker.network.bridge.name":"docker0",
 "com.docker.network.driver.mtu":"1500"}
```

其中三条最关键：这座网桥就叫 `docker0`；容器间通信是开着的；IP masquerade 也是开着的——最后这条就是让容器能上外网的 NAT。在主机上看，它就是一张普通的网桥：

```console
$ ip -br addr show docker0
docker0          UP    172.17.0.1/16 fe80::24be:f0ff:fec9:94cf/64
```

在它上面跑一个容器，然后从里面看：

```console
$ docker run --rm alpine sh -c 'ip addr show eth0; echo; ip route; echo; cat /etc/resolv.conf'
2: eth0@if74: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1500 qdisc noqueue state UP
    link/ether b6:b1:4e:e3:d7:44 brd ff:ff:ff:ff:ff:ff
    inet 172.17.0.6/16 brd 172.17.255.255 scope global eth0
       valid_lft forever preferred_lft forever

default via 172.17.0.1 dev eth0
172.17.0.0/16 dev eth0 scope link  src 172.17.0.6

nameserver 223.5.5.5
nameserver 119.29.29.29
```

仔细读这几行，它一次性回答了大部分问题：

- 容器只有**一张**网卡 `eth0`，地址从 `172.17.0.0/16` 里取。这是 Docker 的 IPAM 分配的；看着像 DHCP，其实不是——根本没有 DHCP 服务器。守护进程自己挑一个地址，直接把网卡配好。
- 默认路由指向 `172.17.0.1`，也就是主机上的 `docker0`。网桥就是网关。
- DNS 服务器是主机的解析器（这里是 `223.5.5.5`），**不是** Docker 的 DNS。在默认 bridge 上，你 `nslookup` 另一个容器的名字，查询会被发到公网，然后失败。
- `eth0@if74` 这个写法暗示了它是 **veth** 对的一端——记住这一点。

## veth 对：eth0 是怎么接到 docker0 的

veth 对就是一根两端开口的虚拟网线：一个包从一端进去，就从另一端出来，像被真正连在一起一样。Docker 为每个容器网络端点建一对。一端留在主机上、被挂到网桥；另一端被挪进容器的网络命名空间，改名 `eth0`。

在主机上你只能看到两端，看不到对应关系，所以要靠接口编号来配对：

```console
$ ip -o link | grep veth
65: vethffd2a6e@if2: ... master docker0 state UP ...
69: veth8ba5050@if2: ... master br-3030e858b1f6 state UP ...
70: vethed0a861@if2: ... master br-3030e858b1f6 state UP ...

$ docker exec dnet-a ip -o addr show eth0
2: eth0    inet 172.28.0.2/16 brd 172.28.255.255 scope global eth0

$ docker exec dnet-a cat /sys/class/net/eth0/ifindex /sys/class/net/eth0/iflink
2
69
```

`eth0` 在主机侧显示为 `@if2`，而它对端的编号是主机上的 **69**——正好就是上面的 `veth8ba5050`，挂在网桥 `br-3030e858b1f6` 上。`bridge link show` 会把同样的关系连同 master 一起打出来。所以路径是：netns 里的 `eth0` → veth → 主机上的网桥。容器 ARP 要找的就是网桥的 MAC：

```console
$ docker exec dnet-a ip neigh
172.28.0.1 dev eth0 lladdr 52:4e:3e:33:7e:4a STALE
```

<figure>
<svg viewBox="0 0 720 200" width="100%" role="img" aria-label="容器的网络命名空间里放着 eth0，通过一对 veth 接到主机上的 docker0 Linux 网桥；网桥是默认网关，经 iptables/nftables 做 MASQUERADE 后再从物理网卡发往互联网。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.75">
    <rect x="8" y="34" width="604" height="140" rx="10"/>
    <rect x="22" y="72" width="152" height="100" rx="8" stroke-dasharray="6 4"/>
    <rect x="34" y="92" width="130" height="42" rx="6"/>
    <rect x="214" y="92" width="112" height="48" rx="6"/>
    <rect x="340" y="92" width="112" height="48" rx="6"/>
    <rect x="466" y="92" width="112" height="48" rx="6"/>
    <circle cx="662" cy="116" r="40"/>
    <path d="M174 116 H214"/>
    <path d="M326 116 H340"/>
    <path d="M452 116 H466"/>
    <path d="M578 116 H622" stroke="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui,sans-serif" font-size="12">
    <text x="18" y="54">host network namespace (kernel)</text>
    <text x="34" y="88">container netns</text>
    <text x="48" y="110">eth0</text>
    <text x="48" y="127" font-size="11">172.17.0.6/16</text>
    <text x="34" y="158" font-size="11">default via 172.17.0.1</text>
    <text x="228" y="114">docker0</text>
    <text x="228" y="131" font-size="11">172.17.0.1/16</text>
    <text x="172" y="108" font-size="11" fill="#0f766e">veth pair</text>
    <text x="348" y="114" font-size="11">MASQUERADE</text>
    <text x="348" y="131" font-size="11">nat/POSTROUTING</text>
    <text x="480" y="114">physical NIC</text>
    <text x="480" y="131" font-size="11">192.168.1.70</text>
    <text x="636" y="120" font-size="12">Internet</text>
  </g>
</svg>
<figcaption>一个容器的出网路径：它自己网络命名空间里的 eth0、一对 veth、docker0 网桥、Docker 写下的 NAT 规则，最后是物理网卡。</figcaption>
</figure>

## user-defined bridge 与 Docker 自带的 DNS

默认 bridge 能用，但它是刻意做了限制的。你自己建一座 **user-defined bridge** 的那一刻，两件事会变：Docker 给网桥起一个你定的名字、配一段你能指定的子网，同时会打开一个内嵌的 DNS 服务器，把容器名解析成地址。

```console
$ docker network create --driver bridge --subnet 172.28.0.0/16 --gateway 172.28.0.1 dnet
3030e858b1f67d9676d71b96ec3f0a7a4b9451f85585bc4a54e9ce92c70982ea
$ docker run -d --name dnet-a --network dnet --hostname alpha alpine sleep 3600
$ docker run -d --name dnet-b --network dnet --hostname beta  alpine sleep 3600
```

容器的 resolv.conf 就是信号：

```console
$ docker exec dnet-a cat /etc/resolv.conf
nameserver 127.0.0.11
options ndots:0
```

`127.0.0.11` 不是一个真实地址——它是 Docker 内嵌 DNS 在那个容器命名空间里监听的魔法地址。它会把容器名和网络别名解析成当前的 IP：

```console
$ docker exec dnet-a nslookup beta
Server:		127.0.0.11
Address:	127.0.0.11:53
Name:	beta
Address: 172.28.0.3

$ docker exec dnet-a ping -c 2 beta
64 bytes from 172.28.0.3: seq=0 ttl=64 time=0.156 ms
```

默认 bridge 上没有 `127.0.0.11`，同一条查询会被丢给上游，然后死掉：

```console
$ docker run --rm alpine nslookup dnet-a
Server:		223.5.5.5
Address:	223.5.5.5:53
** server can't find dnet-a: NXDOMAIN
```

<figure>
<svg viewBox="0 0 640 170" width="100%" role="img" aria-label="左：默认 bridge 上的容器去问主机的上游解析器，查另一个容器名得到 NXDOMAIN。右：user-defined bridge 上的容器去问 Docker 内嵌 DNS 127.0.0.11，拿到对端的地址。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="8" y="16" width="300" height="136" rx="10"/>
    <rect x="24" y="56" width="92" height="34" rx="6"/>
    <rect x="160" y="56" width="132" height="34" rx="6"/>
    <path d="M116 73 H160"/>
    <rect x="332" y="16" width="300" height="136" rx="10" stroke="#0f766e"/>
    <rect x="348" y="56" width="92" height="34" rx="6"/>
    <rect x="484" y="56" width="132" height="34" rx="6"/>
    <path d="M440 73 H484" stroke="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui,sans-serif" font-size="12">
    <text x="24" y="40">default bridge</text>
    <text x="34" y="77">container</text>
    <text x="170" y="77" font-size="11">223.5.5.5 upstream</text>
    <text x="24" y="128" font-size="11">nslookup dnet-a -&gt; NXDOMAIN</text>
    <text x="348" y="40" fill="#0f766e">user-defined bridge</text>
    <text x="358" y="77">container</text>
    <text x="494" y="77" font-size="11">127.0.0.11 embedded</text>
    <text x="348" y="128" font-size="11">nslookup beta -&gt; 172.28.0.3</text>
  </g>
</svg>
<figcaption>默认 bridge 与 user-defined bridge 的真正差别就是名字解析：127.0.0.11 上的内嵌 DNS 只存在于后者。</figcaption>
</figure>

这就是 Compose 里服务发现“白送”的原因：每个 service 都加入一张 user-defined 网络，于是每个 service 名都成了一个 DNS 名。

## 端口发布：`-p` 到底做了什么

`-p 127.0.0.1:18080:80` 看着是一个动作，其实是两个。分清是哪两个，就能解释掉大部分端口冲突和“流量怎么到不了”的 bug。

第一条在用户态：守护进程绑定主机 socket，并把监听的 fd 交给 `docker-proxy`。

```console
$ docker run -d --name dnet-web --network dnet -p 127.0.0.1:18080:80 nginx:1.27-alpine
$ ss -ltnp | grep 18080
LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:*
$ ps -eo pid,args | grep 'host-port 18080'
155140 /usr/bin/docker-proxy -proto tcp -host-ip 127.0.0.1 -host-port 18080 \
       -container-ip 172.28.0.4 -container-port 80 -use-listen-fd
```

`-use-listen-fd` 是个较新的细节：它表示 `docker-proxy` 自己**没有**绑端口——是 dockerd 绑好之后把描述符传下来的。不管哪种，总得有东西在监听才能收到第一个包。

第二条路径是内核 NAT，而且只有这条路径对“不落在主机 loopback socket 上”的流量生效。Docker 会往 `nat` 表里写一条 DNAT 规则：

```console
$ iptables -t nat -L DOCKER -n -v
Chain DOCKER (2 references)
 pkts bytes target prot opt in                    out  source     destination
    0     0 DNAT   tcp  --  !br-3030e858b1f6     *    0.0.0.0/0  127.0.0.1   tcp dpt:18080 to:172.28.0.4:80
```

看字段：`!br-3030e858b1f6` 的意思是“不是从容器自己那座网桥进来的”（那种情况另有规则处理，用于 hairpin 流量）；`127.0.0.1` 是我选的绑定地址；`dpt:18080` 是发布端口；`to:172.28.0.4:80` 是容器。如果你发布到 `0.0.0.0`，这条规则就变得从局域网也能到达——所以在 VPS 上敲 `-p 8080:80` 是一个安全决策，不是图省事。

## 出网 NAT：MASQUERADE 与 Docker 写下的规则

出方向的流量需要反过来的把戏。容器只有私有地址，而互联网必须看到主机的公网地址，所以 Docker 会为每座网桥的子网往 `POSTROUTING` 里写一条 **MASQUERADE** 规则：

```console
$ iptables -t nat -L POSTROUTING -n -v | grep 172.28
    0     0 MASQUERADE  all  --  *  !br-3030e858b1f6  172.28.0.0/16  0.0.0.0/0

$ docker exec dnet-a ping -c 3 1.1.1.1     # 从容器里发一个 ping

$ iptables -t nat -L POSTROUTING -n -v | grep 172.28
    1    84 MASQUERADE  all  --  *  !br-3030e858b1f6  172.28.0.0/16  0.0.0.0/0
```

计数器从 0 变成了 1 个包、84 字节。容器眼里的外网也证实了这次改写：

```console
$ docker exec dnet-a wget -qO- http://ipv4.icanhazip.com
182.150.122.48
```

这是主机的公网地址，不是 `172.28.0.2`。“我的容器到底有没有走 NAT？”就看那条规则上的计数器，一眼的事。这套地址改写机制和家里的普通 NAT 是同一套——它的各种失败模式我在[《NAT traversal 到底怎么工作》](/zh/posts/nat-traversal-explained/)里拆过，而容器这个场景只是它的简单版。

有一个坑要说清楚：在这台主机上，`iptables` 用的是 nftables 后端，Docker 也报告 `Firewall Backend: iptables`。所以这些规则物理上住在一张 `nft` 表里：

```console
$ nft list tables
table ip filter
table ip6 filter
table ip nat
table ip6 nat
table ip raw
```

通过 `iptables` 回读是能用的，但 nft 自己会警告你别碰：`# Warning: table ip nat is managed by iptables-nft, do not touch!`。如果你要手写防火墙规则，别改 Docker 的链——用 `DOCKER-USER`，Docker 特意把它留空，就是为了让它在重载后还在。另外注意 `FORWARD` 链的默认策略是 `DROP`，是 Docker 的 `DOCKER-FORWARD`/`DOCKER` 链补上了那些 `ACCEPT`，发布端口才通。这也是为什么 ufw 或 firewalld 一条敌意十足的 `FORWARD` 策略，就能悄悄把 container networking 搞坏。

关于这些输出，还有两点要老实交代。第一，非特权用户根本读不到 netfilter 状态：

```console
$ iptables -t nat -L -n
iptables v1.8.13 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)
```

你需要 `CAP_NET_ADMIN`。用一个限定能力的容器来读是正当做法——`--cap-add=NET_ADMIN --network host`，这是加能力，不是 `--privileged`——上面这些表就是这么拿到的。

## host、none、macvlan 与 overlay

你实际会在这四种网络模式之间选，它们的行为差别很大：

**`--network none`** 只给容器一个 loopback，别的什么都没有。没有路由，连 DNS 都死。适合那种你想保证它绝对打不回外网的批处理任务：

```console
$ docker run --rm --network none alpine ip -o addr show
1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
1: lo    inet6 ::1/128 scope host
```

**`--network host`** 干脆去掉容器的网络命名空间。进程看到的就是主机的真实网卡——`wlp2s0`、`tun0`、主机的路由——而 `-p` 变得毫无意义（容器的端口**就是**主机的端口）。隔离度：零。

**macvlan** 给容器一个你物理局域网上的真实地址，还带自己的 MAC：

```console
$ docker network create -d macvlan --subnet 192.168.1.0/24 \
      --gateway 192.168.1.1 -o parent=wlp2s0 mvn
$ docker run --rm --network mvn alpine ip -o addr show eth0
97: eth0    inet 192.168.1.2/24 brd 192.168.1.255 scope global eth0
```

看着完美。在 Wi-Fi 上它通常并不完美：我的测试容器拿到了合法的局域网地址，但对主机和对局域网网关都是 **100% 丢包**，因为 AP 会丢掉源 MAC 不是它关联的那个站点的帧。而且按设计，macvlan 容器根本没法访问它自己的主机。

**overlay** 是 swarm 作用域的选项：容器拿到私有、跨主机的子网，由节点做隧道。

```console
$ docker network create -d overlay --attachable ovl
$ docker exec ovl-a ip -o addr show eth0
108: eth0    inet 10.0.1.2/24 brd 10.0.1.255 scope global eth0
```

每个节点还会多出一座 `docker_gwbridge` 网桥，和每个容器一根用于出网的 veth；而 VXLAN 设备本身待在一个只有 root 才能列出的网络命名空间里。你不需要跨主机寻址的话，user-defined bridge 更简单，也一样快。

## 容器怎么访问主机，主机又怎么访问容器

容器 → 主机：网关**就是**主机。我那台 user-defined 网络上的 `172.28.0.1`、默认 bridge 上的 `172.17.0.1`，都是主机地址，所以能 ping 通、能访问。想要一个稳定的名字就加一个：

```console
$ docker run --rm --network dnet --add-host host.docker.internal:host-gateway \
    alpine getent hosts host.docker.internal
172.17.0.1        host.docker.internal
```

坑在于：`host-gateway` 解析成的是**默认 bridge** 的网关（`172.17.0.1`），不是你家自定义网络的那个网关；而且在 Linux 上没有任何东西替你定义 `host.docker.internal`——Docker Desktop 会，Linux 上的守护进程不会。

主机 → 容器：主机对每段网桥子网都有路由，所以能直接访问容器地址，完全不需要 `-p`：

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://172.28.0.4:80
200
```

能通是因为 `172.28.0.0/16 dev br-3030e858b1f6` 这条路由是主机本地的。它**不是**发布端口的替代品——别的机器做不到——但这也正是为什么在主机上 `curl <容器IP>` 是判断“毛病出在应用还是端口转发”的最快办法。相关地，在[《容器里的 WireGuard》](/zh/posts/wireguard-in-containers/)里，同样是“我现在在哪个命名空间”这个问题，决定了隧道是有用的还是只是看着健康。

## 调试 container networking：一个固定顺序

从容器往外走，遇到第一层坏掉的就停下：

1. **容器到底在不在网络上？** `docker network inspect <net>` 会列出每个挂上去的容器、它的 MAC 和 `IPv4Address`。如果压根不在，那就不是网络问题。
2. **容器有没有地址和路由？** `docker exec <c> ip addr; ip route`。没有路由，说明没网关，或者用的是 `none` 网络。
3. **DNS 解析得了吗？** `docker exec <c> nslookup <另一个容器>`。记住 `127.0.0.11` 那条规则：名字只在 user-defined 网络上才解析。
4. **是不是二层的问题？** 在主机上用 `ip -o link | grep veth` 加 `bridge link show`，看哪根 veth 挂在哪座网桥上，再把编号和容器里的 `eth0@ifN` 对上。
5. **是 NAT 还是发布端口？** 读规则，更有用的是读计数器：`iptables -t nat -L POSTROUTING -n -v` 和 `-L DOCKER -n -v`。一条你没预料到的 `DNAT` 规则，说明端口被别的东西占了——就是我在 `8080` 上撞到的那种冲突，端口已经分配给了另一个服务。

关于 `nsenter`：有 root 的时候它是对的工具，因为它直接把你塞进容器的命名空间——`nsenter -t $(docker inspect -f '{{.State.Pid}}' <c>) -n ip addr`。非特权用户跑它只会失败：

```console
$ nsenter -t $(docker inspect -f '{{.State.Pid}}' dnet-a) -n ip -o addr show
nsenter: reassociate to namespaces failed: Operation not permitted
```

有两个非特权的等效手段能覆盖几乎所有场景。`docker exec` 直接在命名空间**里**跑命令；`--network container:<name>` 则干脆加入另一个容器的命名空间：

```console
$ docker run --rm --network container:dnet-a alpine sh -c 'hostname; ip -o addr show eth0'
alpha
2: eth0    inet 172.28.0.2/16 brd 172.28.255.255 scope global eth0
```

## 一段话记住整个心智模型

容器的 `eth0` 是 **veth** 对的一端，另一端挂在主机的一座 Linux 网桥上。**默认 bridge** 就是 `172.17.0.1/16` 的 `docker0`，它给每个容器一条以自己为网关的默认路由，用一条 `MASQUERADE` 规则把出网流量 NAT 出去，并且没有名字解析。**user-defined bridge** 是同一套机制，只是子网归你管，还多了一个 `127.0.0.11` 上的内嵌 DNS——这才让容器名能解析。`-p` 是两套机制：`nat` 表里的一条 `DNAT` 规则，加一个 `docker-proxy` 的 socket；对不从 loopback 进来的流量，只有前者有意义。`host`、`none`、`macvlan`、`overlay` 则是把这张图里的零件换掉。它坏掉的时候，Docker 自己那些规则上的计数器会告诉你坏在哪一块。
