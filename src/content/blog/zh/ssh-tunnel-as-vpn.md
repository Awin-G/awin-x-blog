---
title: "SSH 隧道当穷人版 VPN：本地/远程/动态转发、autossh 与 systemd，以及该上 WireGuard 的时刻"
description: "把本地、远程与动态 SSH 端口转发讲具体，加上用 ProxyJump 穿跳板、autossh 与一份 systemd 单元保活，并诚实说清 ssh 隧道在哪一刻不够用、该改用 WireGuard 或 mesh 覆盖网络。"
pubDate: 2026-11-19
lang: zh
translationKey: ssh-tunnel-as-vpn
tags: [networking, linux]
featured: false
keywords:
  - ssh 隧道
  - SOCKS 代理
  - 远程端口转发
  - autossh
  - 穷人版 VPN
---

我对基础设施有个不成文的规矩：能用最小的工具解决眼前的问题，就别上更重的东西；只有当问题是一个*网络*、而不是一个*服务*时，才去搭覆盖网络。这条规矩，是我在 2026 年、在 WireGuard 早就成为站点互联标准答案之后，仍然几乎每周敲 **ssh 隧道**命令的原因。SSH 两端本来就装好了、也已经认证过，加个转发只是多一个参数。管它叫**穷人版 VPN** 不是贬义——对于“穿过跳板机去够一台数据库”这种需求，它是一笔非常划算的交易；而一旦你真想要的是一个子网，它就是一笔亏本买卖。这篇是具体版：三种转发、让它们活下来的参数，以及我什么时候收手、改用别的东西。

如果你还没把 SSH 客户端配置收拾利索，我那篇[进阶 SSH](/zh/posts/advanced-ssh/)已经讲了 `~/.ssh/config`、密钥和 `ssh-agent`；本文都建立在那个基础上。而当答案确实是一个覆盖网络时，我的 [EasyTier mesh 实录](/zh/posts/private-mesh-with-easytier/)就是故事的另一半。

## 为什么我的第一反应还是 ssh 隧道

SSH 提供三种端口转发，它们全都跑在你早已用来开 shell 的那条加密传输上。**本地转发**把监听 socket 放在你这边；**远程转发**把它放在对面；**动态转发**则把这条连接变成一个单端口的 **SOCKS 代理**，能抵达对面能抵达的任何东西。不用新守护进程、不用新密钥、对面不用改防火墙、不用内核模块——这就是它全部的魅力。

<figure>
<svg viewBox="0 0 660 210" width="100%" role="img" aria-label="三种 SSH 转发并排：本地转发 -L 在本机监听、从对面去连接服务；远程转发 -R 在对面监听、连回本机服务；动态转发 -D 暴露一个 SOCKS5 端口，可抵达对面能到的任意 TCP 目标。">
  <defs>
    <marker id="sshf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" opacity="0.35">
    <rect x="8" y="18" width="204" height="176" rx="8"/>
    <rect x="228" y="18" width="204" height="176" rx="8"/>
    <rect x="448" y="18" width="204" height="176" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="110" y="40" text-anchor="middle">-L  本地</text>
    <text x="330" y="40" text-anchor="middle">-R  远程</text>
    <text x="550" y="40" text-anchor="middle">-D  动态</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="22" y="64" width="72" height="34" rx="6"/>
    <rect x="124" y="64" width="76" height="34" rx="6"/>
    <rect x="242" y="64" width="72" height="34" rx="6"/>
    <rect x="344" y="64" width="76" height="34" rx="6"/>
    <rect x="462" y="64" width="72" height="34" rx="6"/>
    <rect x="564" y="64" width="76" height="34" rx="6"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="94" y1="81" x2="122" y2="81" marker-end="url(#sshf-arrow)"/>
    <line x1="344" y1="81" x2="316" y2="81" marker-end="url(#sshf-arrow)"/>
    <line x1="534" y1="81" x2="562" y2="81" marker-end="url(#sshf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="58" y="86" text-anchor="middle">你:8080</text>
    <text x="162" y="86" text-anchor="middle">svc:5432</text>
    <text x="278" y="86" text-anchor="middle">你:3000</text>
    <text x="382" y="86" text-anchor="middle">vps:8080</text>
    <text x="498" y="86" text-anchor="middle">app:1080</text>
    <text x="602" y="86" text-anchor="middle">任意主机</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="110" y="126" text-anchor="middle">在本机监听，</text>
    <text x="110" y="142" text-anchor="middle">由对面发起连接</text>
    <text x="330" y="126" text-anchor="middle">在对面监听，</text>
    <text x="330" y="142" text-anchor="middle">从这里发起连接</text>
    <text x="550" y="126" text-anchor="middle">一个端口做 SOCKS5，</text>
    <text x="550" y="142" text-anchor="middle">抵达任意 TCP 目标</text>
    <text x="330" y="180" text-anchor="middle" opacity="0.9">三种转发共用同一条加密的 SSH 传输</text>
  </g>
</svg>
<figcaption>三种转发唯一的区别，是监听 socket 归哪一边所有。`-L` 与 `-R` 是点到点；`-D` 是一个 SOCKS5 代理，任何 TCP 客户端都能指向它。</figcaption>
</figure>

## 本地端口转发 `-L`：穿过跳板机去够远程服务

本地转发会在*你的*机器上开一个 socket，并把每条连接都隧道到*对面*能抵达的目标。当你有个服务只监听 loopback、或者只存在于私有网络里时，它就是那个趁手的工具。

```bash
# 语法：-L [绑定地址:]本地端口:目标主机:目标端口
ssh -N -L 5432:db.internal:5432 jump
# 另开一个终端，数据库看起来就像在本机：
psql -h 127.0.0.1 -p 5432 -U app appdb
```

目标 `db.internal:5432` 是从**跳板机的视角**解析的，不是你的视角。这正是诀窍所在：这个名字可以是一条你看不见的私有 DNS 记录，对面替你发起连接。默认监听只绑在 `127.0.0.1`；除非你真的想把这个端口暴露给整个局域网，否则别写 `-L 0.0.0.0:5432:...`。`-N` 的含义是“不执行命令，只做转发”——它阻止 SSH 分配 pty、拉一个登录 shell。

## 远程端口转发 `-R`：把本机服务暴露出去

**远程端口转发**是镜像版：监听方在*对面*，连到它的流量顺着隧道回到*你的*机器。这就是你把本地开发服务器展示给别人看、或者从 NAT 后面（只有出站连接可用）暴露一个入口的办法。

```bash
# 语法：-R [绑定地址:]远程端口:目标主机:目标端口
ssh -N -R 8080:localhost:3000 vps
# 现在，在服务器 vps 上：
curl http://127.0.0.1:8080   # 由你笔记本的 :3000 提供
```

这里的 `目标主机` 是从*你这一侧*解析的，所以 `localhost:3000` 指向你的笔记本。默认情况下远程监听只绑 loopback——这是安全的默认值。想绑得更宽，需要在*服务器端*的 `sshd_config` 里开 `GatewayPorts clientspecified`，并显式写绑定地址。动手前请想清楚：你正把对面防火墙上一根管子，直接捅进自己的机器。

## 动态转发 `-D`：给浏览器或应用用的 SOCKS 代理

前两种转发是点到点的，目标在开始时就得定死。第三种不定。动态转发把 SSH 变成一个 **SOCKS 代理**：你把客户端指向一个本地端口，它就能抵达对面能抵达的*任意*主机，目标在连接时才决定。

```bash
ssh -N -D 1080 jump
# 经过这个代理的每个请求，都从对面的网络出去
curl --socks5-hostname 127.0.0.1:1080 https://internal.example.com/
```

`--socks5-hostname` 很关键：它要求代理在远端也做 DNS 解析，于是内部域名不会泄漏给你的本地解析器，split-horizon DNS 也能照常工作。任何浏览器把 SOCKS5 主机指到 `127.0.0.1:1080`，效果相同。这是不逐个转发服务、就够到跳板机后面整个子网的最快办法——也是 SSH 最接近 VPN 的地方。

## ProxyJump：穿跳板机，不用那些仪式

我最常用的链路是一条只能经公网跳板抵达的私有主机。**ProxyJump** 先经过跳板开一条 TCP 连接，再把 SSH 会话端到端协商到目标上，因此你的私钥从不离开本机。

```bash
ssh -J jump@bastion.example.com deploy@10.0.0.5
# 多层嵌套网络就用逗号串起多跳
ssh -J jump@bastion.example.com,jump2@inner deploy@10.0.1.20
```

比起老的 `ssh -A bastion` 再 `ssh db` 那一套，优先用这个：不做 agent 转发（被攻陷的跳板也无法借用你的密钥），而且会话是端到端加密到目标的，而不是把信任交给跳板的 shell。它同样是 `ProxyCommand nc %h %p` 那种配置的现代替代——IPv6、多跳、重试都替你处理好了。

## 让 ssh 隧道活下去：`-N`、`-f`、`ServerAliveInterval` 与 autossh

一条凌晨三点悄悄断掉、却无人察觉的隧道，比没有隧道更糟——因为上游还有东西在往里发请求。三个参数能把一条一次性命令变成靠谱的东西：

- **`-N`** —— 不执行远程命令，只转发。
- **`-f`** —— 认证完成后转入后台，你的终端照常可用。
- **`ServerAliveInterval 30`** 配 **`ServerAliveCountMax 3`** —— 每 30 秒发一次保活，让闲置的 NAT 与防火墙映射不超时；一旦链路真的断了，约 90 秒内就会把会话判死。

还有一个参数很值钱、却几乎没人用：**`ExitOnForwardFailure yes`**。没有它，当远端端口已被占用时，SSH 会若无其事地保持连接却什么都不转发——这种静默失败够你查上一个钟头。加上它，SSH 会直接退出，交给监管程序去重试。

```bash
ssh -fN \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L 5432:db.internal:5432 jump
```

链路不稳时，**autossh** 会包住 SSH，在连接断开时把它拉起来。现代的用法是关掉 autossh 自带的回显端口监测（`-M 0`），改为依赖 SSH 的保活——既简单又更可靠：

```bash
autossh -M 0 -fN \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L 5432:db.internal:5432 jump
```

## 把一个 ssh 隧道做成 systemd 单元

在任何有 systemd 的机器上，我会干脆跳过 `autossh`：systemd 本身就是监管程序，同时套两套重启机制，只会让你出问题时多一个地方要查。一个 unit 白送你开机自启、失败重启，外加 `journalctl` 看日志。

```ini
# /etc/systemd/system/ssh-tunnel-db.service
[Unit]
Description=Persistent SSH tunnel to db.internal:5432
After=network-online.target
Wants=network-online.target

[Service]
User=deepseek
ExecStart=/usr/bin/ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -i /home/deepseek/.ssh/id_ed25519 \
  -L 5432:db.internal:5432 jump
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ssh-tunnel-db
systemctl status ssh-tunnel-db      # 还有：journalctl -u ssh-tunnel-db -f
```

两个容易踩的细节：系统级服务不会继承你 shell 里的 `ssh-agent`，所以要用 `-i` 指向一个真实密钥文件，并确保它对 `User=` 可读；以及每个 `-o` 选项都要加引号，免得 unit 解析器在空格处拆断。如果只想做某个用户的隧道，把同样的文件放进 `~/.config/systemd/user/`，再用 `systemctl --user enable --now`。

## ssh 隧道给不了你的东西

这一节能帮你省下一周，因为 SSH 隧道看起来像 VPN，直到它不像为止：

- **它不是一个 L3 接口。** 没有 `tun0`，没有路由表，没有一个你能 `ping` 的地址。你转发的是端口，不是接入一个网络。
- **没有 UDP，没有 ICMP。** 转发承载的是 TCP（外加一点 X11 和 agent 的管道）。游戏流量、QUIC、DNS-over-UDP、WireGuard 本身——这些都不会走一条普通 SSH 转发。
- **一条转发一个协议。** `-L` 和 `-R` 各是一对端口；`-D` 是仅支持 TCP 的 SOCKS5，而不少应用忽视 SOCKS、或拒绝用它承载部分流量。“多协议无缝共存”不在菜单上。
- **不能漫游。** 笔记本一换 IP，隧道下面那条 TCP 连接就死了，你得重连。WireGuard 的对端能从任何已认证报文里重新学到彼此；SSH 做不到。
- **性能平平且容易崩。** 一切都压在同一条 TCP 连接上，于是丢包时会碰上 TCP-over-TCP 崩溃、一个流的队头阻塞，也没有内核快路径。开个数据库会话没问题；大流量传输就很难受。

## ssh 隧道 vs WireGuard 与 EasyTier

WireGuard 是诚实的反面：它是内核里一个真正的 L3 接口。把 `AllowedIPs` 指向一个子网，你就得到了路由、任意协议、ICMP、漫游，以及接近线速的吞吐。代价是配置——密钥、每个接口的配置、一两条路由、两端都要 root——以及 WireGuard 刻意不做*寻找*对端这件事，NAT 穿越得你自己扛。像 [EasyTier](/zh/posts/private-mesh-with-easytier/) 这样的覆盖网络补上最后这块：它保留类 WireGuard 的数据面，但加上了会合、打洞和中继，于是笔记本和手机不必手写端点也能彼此发现。

所以这笔交易不是“安全 vs 不安全”——SSH 同样端到端加密。它是**一个服务 vs 一个网络**：SSH 隧道零成本起步，但一次只能扩展到一对端口；覆盖网络要花一个下午搭好，之后它永远像一个局域网。

## 诚实的建议

该用 **ssh 隧道**的时候：你已经能 SSH 到一台看得见目标的中转机、你需要的恰好就是那个东西、而且现在就要——一台数据库、一个内部面板、一个展示给同事的本地开发服务器、一次穿过 SOCKS 代理的浏览器会话。一条命令，不留痕迹，再加上 `-J` 和一个 systemd 单元，就足够省心到能长期留着。

该用 **WireGuard 或 mesh 覆盖网络**的时候，只要下面任何一条成立：服务不止寥寥几个；你需要 UDP 或任意协议；你需要笔记本换网络后它还活着；或者你在意吞吐。两三个固定主机加一个子网 → 上原生 WireGuard。会漫游的笔记本、手机、NAT 后面的机器 → 上 EasyTier 这样的覆盖网络。

我能给的最短版本：**服务用 SSH，网络用覆盖层。** 穷人版 VPN 是笔好买卖——直到你发现自己正拿一堆端口转发去拼一个网络。
