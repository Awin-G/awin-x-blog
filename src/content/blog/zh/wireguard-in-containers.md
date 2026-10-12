---
title: "WireGuard Docker：容器里会坏在哪，以及怎么修"
description: "WireGuard 装进容器看起来很简单，直到内核模块、/dev/net/tun 和 NET_ADMIN 开始作祟。一份实用的 WireGuard Docker 指南：主机命名空间 vs 容器命名空间、NET_ADMIN、wireguard-go 兜底、kill switch 与路由陷阱、把密钥留在镜像之外，以及什么时候干脆别用容器。"
pubDate: 2026-11-29
lang: zh
translationKey: wireguard-in-containers
tags: [networking, self-hosting, nginx]
featured: false
keywords:
  - WireGuard Docker
  - WireGuard 容器
  - NET_ADMIN
  - /dev/net/tun
  - wireguard-go
---

**WireGuard Docker** 看上去就是五行 Compose 服务，直到它不是。接口起不来，或者起来了却在漏流量，或者在你笔记本上正常、一到 VPS 上就翻车。几乎所有失败都能追回到同样四件事：内核模块、`/dev/net/tun`、`NET_ADMIN` 权限，以及一个你必须刻意做出的决定——WireGuard 到底该活在**哪个网络命名空间**里。这是我在自己并不完全掌控的机器上跑 **WireGuard 容器**时学到的东西：一种干净的做法、两种可接受的做法，以及一组在从论坛抄配置之前值得先知道的路由与密钥陷阱。

## 为什么把 WireGuard 装进容器很别扭

WireGuard 不是一个守护进程，也不是一个替你开好 socket 的进程。在 Linux 上，它是一个内核模块，注册出一种新的网络接口类型；再配一个用户态工具（`wg`），通过 netlink 去配置它。容器化它时所有别别扭扭的地方，都来自这个形态。

- **接口本身是内核对象。** 创建 `wg0` 是在**你所在的网络命名空间**里执行的特权操作。进程必须在该命名空间里持有 `CAP_NET_ADMIN`，否则 netlink 调用直接返回 `Operation not permitted`。
- **模块必须已经加载好。** 好消息是：WireGuard 从 5.6 起就进了主线内核，所以在 2026 年的任何主机上模块都在，而容器与主机共享内核——你**不需要**从容器里 `modprobe`。只有跑自编译或极老内核时，才需要挂载 `/lib/modules` 并授予 `SYS_MODULE`。大多数还在教你这么做的指南，是在照搬 2018 年的老问题。
- **`/dev/net/tun` 通常不需要——但经常恰恰需要。** 内核实现**不**使用 TUN 设备，它直接创建一个 `wg` 类型的接口。所以纯内核 WireGuard 容器完全可以不给 `/dev/net/tun` 就起来。但只要你用了**用户态**协议栈（`wireguard-go`、boringtun），或者镜像在底层回退到用户态，它就变成必需。传进去成本很低；该有却没有，代价很高。
- **主机网络 vs 命名空间不是细节。** 它决定了谁能用这条隧道。选错了，你会得到一个健康得挑不出毛病的隧道，却一个你关心的包都没运。

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="两张示意图。左：WireGuard 运行在主机命名空间，主机应用经 wg0 出去。右：WireGuard 运行在容器命名空间，wg0 与 tun 设备位于其中，靠 NET_ADMIN 创建，只有容器内的应用走它。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="30" width="300" height="160" rx="10"/>
    <rect x="352" y="30" width="300" height="160" rx="10"/>
    <rect x="28" y="52" width="120" height="40" rx="6"/>
    <rect x="176" y="52" width="110" height="40" rx="6"/>
    <rect x="28" y="128" width="258" height="40" rx="6"/>
    <rect x="372" y="52" width="260" height="70" rx="6"/>
    <rect x="372" y="140" width="120" height="40" rx="6"/>
    <rect x="512" y="140" width="120" height="40" rx="6"/>
    <path d="M148 72 H176"/>
    <path d="M88 128 V92"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="158" y="22" text-anchor="middle" font-weight="600">主机命名空间</text>
    <text x="502" y="22" text-anchor="middle" font-weight="600">容器命名空间</text>
    <text x="88"  y="70" text-anchor="middle">主机应用</text>
    <text x="88"  y="86" text-anchor="middle">+ 路由</text>
    <text x="231" y="70" text-anchor="middle">wg0（内核）</text>
    <text x="231" y="86" text-anchor="middle">udp 51820</text>
    <text x="157" y="152" text-anchor="middle">物理 eth0 → 互联网</text>
    <text x="502" y="76" text-anchor="middle">wg0 + /dev/net/tun</text>
    <text x="502" y="93" text-anchor="middle">靠 NET_ADMIN 创建</text>
    <text x="502" y="110" text-anchor="middle">（veth → 主机 → eth0）</text>
    <text x="432" y="164" text-anchor="middle">容器内应用</text>
    <text x="572" y="164" text-anchor="middle">只有它走隧道</text>
  </g>
</svg>
<figcaption>你把 WireGuard 放进哪个命名空间，被隧道承载的就是那个命名空间的流量。放在主机上，所有主机进程都能用；放在容器里，就只有这个容器能用。</figcaption>
</figure>

## 三种做法一览

其实答案只有三种，按「你被允许碰主机多少」排序：

1. **WireGuard 跑在主机网络命名空间。** 最简单也最强，代价是牺牲容器隔离。当整台机器都该走隧道时用它。
2. **WireGuard 跑在容器命名空间，配 `NET_ADMIN` + `/dev/net/tun`。** 隧道被限定在这一个容器里。当**某个服务**需要走指定隧道出去时用它。
3. **用户态实现（`wireguard-go`、boringtun）。** 当你用不了内核模块、或拿不到主机权限时用它。

## 做法一：WireGuard 跑在主机网络命名空间

如果整台机器都该走隧道，就用 `network_mode: host` 让 WireGuard 直接作用于主机命名空间：

```yaml
services:
  wg:
    image: lscr.io/linuxserver/wireguard:latest
    network_mode: host            # wg0 属于主机
    cap_add:
      - NET_ADMIN
    volumes:
      - ./config:/config
    restart: unless-stopped
```

现在 `wg0` 出现在主机上，每个主机进程都能用它。但要对自己诚实：到这一步，容器几乎没有替你省下什么。你用的是主机网络加主机权限，剩下唯一的隔离只是进程自己的文件系统。如果这就是你想要的，那把 WireGuard 直接装在主机上、交给 systemd 单元管理就好——这正是[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)的整套论点，而一个 `wg-quick@wg0.service` 确实比一份授予 `NET_ADMIN` 的 Compose 文件需要你操心的地方更少。

## 做法二：带 NET_ADMIN 与 /dev/net/tun 的容器

这才是真正有意思的场景：一个应用，一个出口。经典用法是让下载客户端或爬虫必须以指定的 VPN 出口，而主机其余部分继续走正常路由。

```yaml
services:
  vpn:
    image: lscr.io/linuxserver/wireguard:latest
    cap_add:
      - NET_ADMIN                 # 必需：在这个命名空间里创建 wg0
    devices:
      - /dev/net/tun:/dev/net/tun # 只有在用到用户态协议栈时才需要
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
    ports:
      - "51820:51820/udp"
    volumes:
      - ./config:/config          # 密钥和 wg0.conf 放这里，不进镜像
    restart: unless-stopped

  client:
    image: curlimages/curl:latest
    network_mode: "service:vpn"   # 与 vpn 容器共享同一命名空间
    depends_on:
      - vpn
    command: ["curl", "-s", "https://ifconfig.me"]
```

第二个服务才是重点。`network_mode: "service:vpn"` 把 `client` 放进与 `vpn` **相同**的网络命名空间，于是它直接继承 `wg0` 和它的路由，自己一个权限都不需要。这就是干净地表达「只有这个进程走隧道」的方式——主机级的默认路由一根都没动。

实践中有两点。第一，`net.ipv4.conf.all.src_valid_mark=1` 不是装饰品：`wg-quick` 用防火墙标记来为封装后的 UDP 包做路由，少了这个 sysctl，在全隧道默认路由下内核会把这些包当火星包直接丢弃。第二，如果你用不了 `network_mode: service:`（比如客户端是个需要自己占端口的长驻守护进程），替代方案是一个小小的路由 sidecar，用同样的方式共享命名空间。

## 做法三：碰不了主机时，用 wireguard-go

如果内核模块不可用——老内核、被锁死的容器、CI 里的 macOS——用户态实现会替你做加密，再把包交给一个 TUN 设备。用户态去掉的是**内核模块**依赖，并没有去掉「创建接口」这件事。你仍然需要 `NET_ADMIN` 和 `/dev/net/tun`，除非你给进程一个自己的非特权命名空间，在那里它只对自己持有 `NET_ADMIN`：

```bash
# 用户态，在一个用完即弃的 user+net 命名空间里：无需主机权限
unshare --user --map-root-user --net --mount --uts --fork \
  sh -c '
    wireguard-go wg0
    wg set wg0 private-key /config/wg0.key \
       peer <server.pub> \
       endpoint 203.0.113.10:51820 \
       allowed-ips 0.0.0.0/0 \
       persistent-keepalive 25
    ip -6 addr add fd00::2/64 dev wg0 2>/dev/null || true
    ip -4 addr add 10.9.0.2/24 dev wg0
    ip link set wg0 up
    ip route add default dev wg0
    wg show
  '
```

因为命名空间是私有的，你装的默认路由只影响这棵进程树。这就是一个穷人版 sidecar——不用构建镜像，主机上也不需要任何权限。

## Kill switch 与路由陷阱

一条悄悄回落到明文互联网的隧道，比没有隧道更糟。几乎所有的漏流量都来自三个陷阱。

**命名空间里的默认路由。** `AllowedIPs = 0.0.0.0/0` 会让 `wg-quick` 在 **wg0 所在的那个命名空间**里安装一条默认路由。在做法二里，那就是容器的命名空间——正是你想要的。如果你更想自己接线路由，就在 `[Interface]` 里设 `Table = off`，然后手工加路由。

**Kill switch。** `wg-quick` 的路由只在接口存活时把流量留在隧道里。一旦隧道断开、接口被移除，回退的默认路由就接管，流量立刻泄漏。真正的 kill switch 是一条防火墙规则：只放行隧道和 WireGuard 对端，其余全部丢弃：

```bash
# 硬 kill switch：没有 wg0，就没有互联网
nft add table inet wgkill
nft add chain inet wgkill output '{ type filter hook output priority 0; policy drop; }'
nft add rule inet wgkill output oifname "wg0" accept
nft add rule inet wgkill output ip daddr 203.0.113.10 udp dport 51820 accept
nft add rule inet wgkill output oifname "lo" accept
```

有了这条默认策略，隧道一死连接就死，永远不会静默逸出。

**DNS 泄漏是「测试」问题，不是路由问题。** 全隧道并不会魔法般地改变你用哪个解析器——容器里你可能仍指向 Docker 内嵌的 `127.0.0.11`，或者主机的 `resolv.conf`。修法是显式设置解析器，但纪律是**验证**而不是想当然：

```bash
# 这个包会走哪条路由？
ip route get 1.1.1.1                 # 应当显示 "dev wg0"
# 哪个解析器应答的，从哪来的？
dig +short whoami.akamai.net @$(awk '/nameserver/{print $2; exit}' /etc/resolv.conf)
# 世界看到的我的 IP 是什么？
curl -s https://ifconfig.me; echo
```

三条命令都要从**共享该命名空间的容器内部**跑，而不是在主机上跑。如果返回的 IP 不是 VPN 的，那就是泄漏——而且现在你知道是哪一层漏的。

## 密钥与配置：别把它们烤进镜像

最常见的容器错误和任何服务一样：把秘密写进构建。绝不要 `COPY wg0.conf` 进镜像，也绝不要用 `ENV` 传私钥——环境变量对任何能执行 `docker inspect` 的人都可见。正确做法是在主机上生成密钥，再以只读方式挂进去：

```bash
umask 077
wg genkey | tee ./config/wg0.key | wg pubkey > ./config/wg0.pub
chmod 700 ./config
```

```yaml
services:
  vpn:
    image: lscr.io/linuxserver/wireguard:latest
    cap_add: [NET_ADMIN]
    devices: ["/dev/net/tun:/dev/net/tun"]
    secrets:
      - wg_private_key
    volumes:
      - ./config:/config:rw
    restart: unless-stopped

secrets:
  wg_private_key:
    file: ./config/wg0.key
```

配置卷就是那条接口：镜像保持通用，机器专属的密钥和 `wg0.conf` 留在磁盘上，轮换密钥只是改一个文件再重载——无需重新构建。把这个目录设成 `0700`，不要把它提交进 Git，并且像对待任何其他秘密一样给它做备份。这套密钥轮换纪律无论隧道在容器里还是在主机上都是一样的，我在 [WireGuard 从零开始](/zh/posts/wireguard-from-scratch/)里把它讲透了。

## WireGuard Docker 对比直接装在主机上

我的诚实规则是这样的。

**装在主机上**：一条隧道、一台机器，且这台机器上的一切都该走它时。你得到内核快路径、作为开机单元的 `wg-quick@wg0`、不用和权限搏斗，以及唯一一个调试的地方——`wg show`、`ip route`。我在 VPS 上就是这么干的。[不用 Docker 自托管](/zh/posts/self-hosting-without-docker/)那篇的论点在这里几乎完全适用。

**用 WireGuard 容器**：当你需要**按服务**划分出口（三个客户端、三个出口地域），当你想让隧道及其用户态工具被钉死并可复现，或者当一个 `network_mode: service:vpn` sidecar 比在主机上摆弄防火墙更干净时。容器靠**作用域**赢下它的位置，而不是靠安全表演。

无论哪条路，你都不会凭白得到：NAT 穿越、地址分配、密钥分发。容器修不好 WireGuard 的边界——它只是挪动了接口所在的位置。先定命名空间，只在真的需要时才授予 `NET_ADMIN` 和 `/dev/net/tun`，把密钥放在挂载卷上，然后去**测**泄漏，而不是相信配置。
