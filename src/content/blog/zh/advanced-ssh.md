---
title: "进阶 SSH：一份 ssh config、隧道、ProxyJump 与端口转发"
description: "写一份 ssh config 是我在命令行上做过的性价比最高的一次效率升级。接着是 ssh 隧道：本地、远程与动态端口转发，用 ProxyJump 穿过跳板机，以及 ed25519 密钥和 ssh-agent。附可直接复制的配置与命令，还有那些同时改善日常体验的加固项。"
pubDate: 2026-11-11
lang: zh
translationKey: advanced-ssh
tags: [linux, networking, security]
featured: false
keywords:
  - ssh config
  - ssh 隧道
  - ProxyJump
  - 端口转发
  - ssh-agent
---

如果把我花在敲 IP 地址、长主机名、`-i` 密钥路径和非默认端口上的时间加起来，够我搭进去整整好几个工作日。我在命令行上做过的最有效的效率升级，不是什么新终端或复用器——而是写了一份 `~/.ssh/config`，让它替我交这笔税。从那里开始，同一个文件还悄悄解锁了进阶 SSH 的其余部分：**ssh 隧道**、穿过跳板机的 **ProxyJump**，以及不必背一次性参数的干净**端口转发**。

这就是我在自己机器上真正在用的那套 SSH。如果你还在加固一台新机器，我的 [VPS 加固清单](/zh/posts/hardening-a-public-server/)讲的是服务端；这一篇讲客户端。而如果你有些主机压根不可路由，那像我这套 [EasyTier 组网](/zh/posts/private-mesh-with-easytier/)的 mesh overlay 就是它的上一层。

## `~/.ssh/config`：性价比最高的那一次升级

SSH 每次启动都会自动读取 `~/.ssh/config`。任何你本可以在命令行上写成 `-o Key=Value` 的选项，都能永久地住在里面，并作用于匹配的主机。结果是：`ssh web` 替代了那条你再也不想敲第二遍的命令。

下面这份配置，是我会爽快交给新同事的版本：

```sshconfig
# ~/.ssh/config — chmod 600，chown 成你自己

# 作用于所有主机。保持它小且安全。
Host *
    ServerAliveInterval 30
    ServerAliveCountMax 3
    AddKeysToAgent yes
    IdentitiesOnly yes

Host web
    HostName 203.0.113.10
    User deploy
    Port 49222
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 15

Host bastion
    HostName bastion.example.com
    User jump
    Port 22
    IdentityFile ~/.ssh/id_ed25519_bastion

Host db
    HostName 10.0.0.5
    User postgres
    ProxyJump bastion
    IdentityFile ~/.ssh/id_ed25519
```

每条指令都给你换来了什么：

- **`Host`** 是你敲的别名，而且能匹配通配符（`Host *.internal`）。它不是主机名，而是个标签。
- **`HostName`** 是标签背后真正的地址。现在 `ssh web` 就能连到 `deploy@203.0.113.10:49222`，一个参数都不用敲。
- **`User`** 和 **`Port`** 去掉了临时命令里最常见的两个手误来源。
- **`IdentityFile`** 按主机钉死用哪把密钥，不用再猜。
- **`IdentitiesOnly yes`** 让 SSH *只*提供那把密钥，而不是 agent 里的每一把。光是这一条，就能修好当你 `ssh-agent` 里挂着十几把密钥时最常见的 `Too many authentication failures`。
- **`ProxyJump`** 让连接经由另一台主机（下面细讲）。
- **`ServerAliveInterval 30`** 每 30 秒发一次保活，这样 NAT 和空闲防火墙就不会悄悄掐掉你搁置的会话。`ServerAliveCountMax 3` 意味着链路断了大约 90 秒内你就会知道，而不是永远卡住。

两个习惯让它更安全：`chmod 600 ~/.ssh/config`（里面可能有你不愿外扬的主机名），以及当某个主机行为不对时，用 `ssh -G web` 打印出完全解析后的配置。

## ed25519 密钥、ssh-agent 与硬件密钥

如果你今天要生成密钥，就直接生成 **ed25519**。它小、快，对新密钥而言严格优于 RSA。

```bash
ssh-keygen -t ed25519 -C "deepseek@laptop-2026" -f ~/.ssh/id_ed25519
# ed25519-sk 是 FIDO2 硬件背书的那一版：每次使用都需要碰一下
ssh-keygen -t ed25519-sk -C "deepseek yubikey" -f ~/.ssh/id_ed25519_sk
```

设一个口令。注释（`-C`）只是个标签，方便以后在日志里分辨是哪把密钥。然后让 **ssh-agent** 帮你握着已解锁的密钥，这样你每次开机输一次口令，而不是每次连接输一次：

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
ssh-add -l            # 看看 agent 手里握着什么
```

接下来最诱人的是 **agent 转发**（`ssh -A bastion`）——把本地 agent 转发到远端，这样你可以继续往后跳而不用复制密钥。别随便这么干。只要你正连着，那台远端主机上的 root 就能跟你的转发 agent socket 说话，并以*你的身份*认证到你的密钥能到达的任何地方。一台被攻陷的跳板机，就变成了一把万能钥匙。现代的答案是 **ProxyJump**：私钥始终留在你的笔记本上，agent 从不向中间主机暴露。

对最重要的那些机器，用硬件密钥（`ed25519-sk`）。私钥永远不离开令牌，每次使用都需要物理碰触——这同时也意味着，一台被偷走的笔记本不等于被偷走的身份。

## 用 `-L` 做本地端口转发

本地转发会在*你的*机器上开一个监听套接字，把每条连接都通过隧道送到*远端*一侧可达的目的地。这是用来够到那些只监听回环的服务的工具。

```bash
# 语法：-L [本地绑定:]本地端口:目标主机:目标端口
ssh -N -L 5432:127.0.0.1:5432 db
# 在另一个终端里，数据库现在看起来就是本地的：
psql -h 127.0.0.1 -p 5432 -U postgres mydb
```

两个值得记住的参数：`-N` 表示“不跑 shell，只转发”，`-f` 把它推到后台，让你的终端保持可用。目标主机是在**远端**解析的，所以 `-L 8080:internal-web:80 web` 能让你在浏览器里访问 `http://localhost:8080`，够到只存在于私网内部的服务。默认监听地址是 `127.0.0.1`；除非你真的想把那个端口暴露给整个局域网，否则不要绑到 `0.0.0.0`。

## 用 `-R` 做远程端口转发

远程转发是镜像的那一面：监听套接字活在*远端*，连到它的连接再顺着隧道回到*你的*机器。这就是你把本地开发服务器展示给别人，或者够到那台只能发起出站连接的 NAT 后主机的办法。

```bash
# 语法：-R [远端绑定:]远端端口:目标主机:目标端口
ssh -N -R 8080:localhost:3000 web
# 现在，在服务器 'web' 上：
curl http://127.0.0.1:8080   # 由你笔记本上的 :3000 提供
```

默认情况下远端监听只在回环，这是安全的默认值。想绑得更宽，需要在*服务端的* `sshd_config` 里设 `GatewayPorts clientspecified`，并显式给出绑定地址——做之前想清楚，因为你刚刚在防火墙上打了个洞，直通你的笔记本。

## 用 `-D` 做动态转发：一条隧道，任意目的地

本地和远程转发都是点对点的。**动态转发**把 SSH 变成一个 SOCKS5 代理：你把客户端指向一个本地端口，它就能到达*远端*能到达的*任意*主机，连哪台在连接时才决定。

```bash
ssh -N -D 1080 bastion
# 经过这个代理的每个请求，都从 bastion 所在的网络出去
curl --socks5-hostname 127.0.0.1:1080 https://internal.example.com/
```

`--socks5-hostname` 是关键：它让代理在远端也做 DNS 解析，于是你的内部名字永远不会泄露给本地解析器，分域解析（split-horizon DNS）也能正常工作。任何浏览器都可以把 `127.0.0.1:1080` 设为 SOCKS 代理，效果一样。这是够到跳板机后面整片子网、又不必逐个服务转发的最快办法。

## 用 ProxyJump 穿过跳板机

我最常用的那条链：一台只能从公网 `bastion` 够到的私有 `db`。有了上面的配置，`ssh db` 直接就能用——`ProxyJump bastion` 的意思是，SSH 先经过跳板机开一条 TCP 连接，然后端到端地把 SSH 会话协商到 `db`。私钥始终留在你的机器上。

在命令行上，不依赖任何配置，同样的事情是：

```bash
ssh -J jump@bastion.example.com postgres@10.0.0.5
# 用逗号串起两跳，去往嵌套的网络
ssh -J jump@bastion.example.com,jump2@inner-host deploy@10.0.1.20
```

比起老式的“先 `ssh -A bastion`、再 `ssh db`”那套写法，优先用 `ProxyJump` 有两个原因：不再需要 agent 转发（见上面的风险），而且会话是端到端加密到 `db` 的，而不是去信任跳板机的 shell。如果你在配置里看到老旧的 `ProxyCommand nc %h %p`，`ProxyJump` 就是它的现代替代——多跳、IPv6 和重试，它都替你处理好了。

## 同时改善日常体验的加固项

我“为了安全”会做的一些改动，结果也让客户端更好用，所以我总是先做它们：

- **仅密钥认证，加上 `IdentitiesOnly yes`。** 服务端更安全，也顺手消掉了客户端上的认证失败噪音。
- **非默认端口，存进 `Host`。** 更少被扫描，而且你敲的是 `ssh web`，不是 `ssh -p 49222`。
- **`ServerAliveInterval`。** 让空闲的隧道和长会话在 NAT 超时窗口里活下去。
- **连接复用。** 把下面这段加进 `Host *`，对同一主机的每次重复连接都会复用第一条，于是 `scp`、`git` 和嵌套的 `ssh` 都会变得跟瞬时一样：

  ```sshconfig
  Host *
      ControlMaster auto
      ControlPath ~/.ssh/cm-%r@%h:%p
      ControlPersist 10m
  ```

- **用 ProxyJump 代替 agent 转发。** 爆炸半径里少一个秘密。
- **最重要的东西用 `ed25519-sk`。** 物理碰触，没什么可被偷。

这些都不替代服务端的工作——`sshd_config`、默认拒绝的防火墙和 fail2ban，去看[加固清单](/zh/posts/hardening-a-public-server/)。客户端配置只是让安全的路也变成方便的路，而这是唯一能熬过忙碌一周的安全。

## 常见问题

**`~/.ssh/config` 必须放在哪？** 对你的用户而言就是那个确切路径；系统级的 `/etc/ssh/ssh_config` 对所有人生效。第一个匹配到的值获胜，所以把具体的 `Host` 块放在宽泛的 `Host *` 之前。

**隧道是端到端安全的吗？** SSH 传输加密到你指定的远端端点为止。端点之后的数据——比如从服务器到它自己回环上的本地数据库——并不加密；它只按你要求的那样走。

**我能让隧道留在后台跑吗？** 可以：`ssh -fN -L ...` 在认证后脱离。配上 `ServerAliveInterval`，需要它扛住重连就再加 autossh。

**为什么 `ProxyJump` 比 `ProxyCommand` 好？** 机制相同，只是无聊的部分都替你处理好了——多跳、IPv6，不用再摆弄一个外部 `nc` 二进制。
