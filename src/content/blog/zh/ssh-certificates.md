---
title: "SSH 证书：别再手动管理 authorized_keys 了"
description: "一旦有人入职或要更换密钥，authorized_keys 的散乱就崩了。SSH 证书能治好它：一个 SSH CA 用 principals 和有效期来签用户证书，主机证书干掉 TOFU 提示，短时效凭证则让吊销列表变得多余。附可复制的 ssh-keygen -s 与 sshd 配置。"
pubDate: 2026-11-24
lang: zh
translationKey: ssh-certificates
tags: [security, networking, linux]
featured: false
keywords:
  - SSH 证书
  - SSH CA
  - TrustedUserCAKeys
  - 主机证书
  - principals
---

我跑着的每台服务器上，仍然躺着一个 `~/.ssh/authorized_keys`，而多年来这个文件就是我发放访问权限的方式：粘一个公钥，关掉工单，继续干活。一台笔记本对一台机器，它很好使。可只要任何一边变成两个——两个人、两台服务器，或者一个人两台设备——它立刻就不够用了。**SSH 证书（SSH certificates）** 就是我用来解决这个问题的办法。与其在每台主机上维护一份不断增长的密钥清单，不如让一个 **SSH CA** 去签几段很小的数据，写明"这把密钥属于这个人，可以扮演这些角色，有效期到这个时刻"，而每台服务器只需要信任那个 CA。要搭的东西比大多数人以为的少：服务器上多一个文件，每个人多跑一次 `ssh-keygen -s`。

如果客户端那套对你来说还是个谜，先去读我的[进阶 SSH](/zh/posts/advanced-ssh/)——里面讲密钥、`ssh-agent` 和 `~/.ssh/config`。同时也把[服务器加固清单](/zh/posts/hardening-a-public-server/)放在手边，因为证书改变的是你"如何授权"，而不是门的其他部分。

## authorized_keys 散乱带来的痛

让我把失效模式讲具体点，因为很长一段时间里我也觉得 `authorized_keys` 挺好：

- **加一个人就是一次扇出。** 新同事的密钥得进到他能触达的每一台主机上的 `/home/deploy/.ssh/authorized_keys`，还得有 `root` 那份，再加上那台你早就忘了的备份机。N 台主机、N 次编辑、N 次把 IP 敲错、粘到错服务器上的机会。
- **删一个人更糟。** 你得找出这把密钥的*每一份*拷贝。漏掉的那份，恰恰是最要命的那份。你永远没有一个真实可信的中心化"谁对什么有访问权"。
- **轮换没有截止日期。** 2021 年拷到某台笔记本上的密钥，到 2026 年依然有效，除非有人记得去删。`authorized_keys` 根本没有过期字段，所以一把密钥的默认寿命就是"永久，直到有人来清理"。
- **没有范围（scope）。** 对它所处的那个账号而言，一把密钥是全有或全无。你没法说"这把密钥可以在 Web 服务器上开 shell，但不能碰数据库"，除非你再造一个 Unix 用户和整套文件权限。
- **没有审计线索。** 这个文件只能告诉你某把密钥存在，告诉不了你它握在谁手里、什么时候签发的。

三台服务器时这些都不算危机。到十台就变成每月例行的杂活，到五十台就是一条实打实的审计发现项。最气人的地方在于，解药并不是什么产品——它是 `ssh` 和 `sshd` 已经支持了好多年的一个模式。

## SSH CA 是怎么工作的：证书、principals、有效期

SSH 证书不是 X.509。它是一个很小、格式固定的数据块，由一把 CA 密钥签名，包住用户公钥或主机公钥其中之一。`ssh-keygen` 负责生成，`ssh` 和 `sshd` 负责校验，而格式里只有少数几个你需要关心的字段：

- **CA 的公钥**——服务器唯一需要分发出去的东西。只要签名能对着它验过，这张证书就被信任。
- **Key ID（`-I`）**——一个会出现在日志里的人可读标签，比如 `deepseek@laptop-2026`。它不是安全控制，但它是日志变可读的原因。
- **Principals（`-n`）**——这张证书被允许用来登录的名字。`-n deploy` 意味着这把密钥可以以 `deploy` 账号认证。`-n deploy,admin` 的证书两者都授予，登录时再拿这个清单去比对目标用户名。
- **有效期（`-V`）**——明确的起止时间。`-V +8h` 是一个工作日，`-V +52w` 是一年。这正是 `authorized_keys` 从来没有的字段。
- **Critical options（`-O`）**——由服务器强制执行：`force-command`、`source-address`、`no-port-forwarding` 等等。如果某台服务器不认识某个 critical option，它必须拒绝这张证书，格式因此才敢被安全地扩展。

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="同一个 SSH CA 签出两类证书：包住用户密钥的用户证书，以及包住服务器主机密钥的主机证书。服务器通过 TrustedUserCAKeys 用 CA 公钥校验用户证书；客户端用 known_hosts 里的 at-cert-authority 行，用同一个公钥校验主机证书。">
  <defs>
    <marker id="sshc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="54" width="146" height="46" rx="7"/>
    <rect x="16" y="200" width="146" height="46" rx="7"/>
    <rect x="246" y="116" width="168" height="68" rx="8"/>
    <rect x="468" y="54" width="176" height="46" rx="7"/>
    <rect x="468" y="200" width="176" height="46" rx="7"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="162" y1="77" x2="244" y2="130" marker-end="url(#sshc-arrow)"/>
    <line x1="162" y1="223" x2="244" y2="170" marker-end="url(#sshc-arrow)"/>
    <line x1="414" y1="130" x2="466" y2="77" marker-end="url(#sshc-arrow)"/>
    <line x1="414" y1="170" x2="466" y2="223" marker-end="url(#sshc-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="89" y="74" text-anchor="middle">用户密钥</text>
    <text x="89" y="90" text-anchor="middle">id_ed25519</text>
    <text x="89" y="220" text-anchor="middle">主机密钥</text>
    <text x="89" y="236" text-anchor="middle">ssh_host_ed25519_key</text>
    <text x="330" y="142" text-anchor="middle" font-size="13">SSH CA</text>
    <text x="330" y="160" text-anchor="middle" font-size="11">离线，带口令</text>
    <text x="556" y="74" text-anchor="middle">id_ed25519-cert.pub</text>
    <text x="556" y="90" text-anchor="middle">-n principals  -V +8h</text>
    <text x="556" y="220" text-anchor="middle">host-cert.pub</text>
    <text x="556" y="236" text-anchor="middle">-h -n web-01</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="330" y="202" text-anchor="middle">签发</text>
    <text x="330" y="278" text-anchor="middle">服务器和客户端只需要 CA 公钥</text>
  </g>
</svg>
<figcaption>同一个 SSH CA 签出两类证书。服务器用 `TrustedUserCAKeys` 拿 CA 公钥校验用户证书；客户端用 `known_hosts` 里的 `@cert-authority` 行拿同一把公钥校验主机证书。</figcaption>
</figure>

一个关键的不对称之处：用户证书由**服务器**通过 `TrustedUserCAKeys` 校验，主机证书由**客户端**通过 `known_hosts` 里的 `@cert-authority` 校验。同一套机制，方向相反，解决的是两个不同的问题。

## 建一个 CA，并签出你的第一张用户证书

我会生成两把 CA 密钥：一把给人，一把给主机。如果条件允许，把用户 CA 离线保存——一个 U 盘或一台气隙机器——因为谁拿到那把私钥，谁就能假冒任何人登录。

```bash
# 一次性：创建用户 CA（ed25519，带口令保护）。离线保存。
ssh-keygen -t ed25519 -f ~/.ssh/ca_user -C "team user CA 2026"

# 把某个用户的公钥签成一张证书。
#   -I  会出现在日志里的 key id
#   -n  principals：这张证书可以以哪些账号登录
#   -V  有效期（+8h、+52w，或显式写成 20261124:20261201）
ssh-keygen -s ~/.ssh/ca_user \
  -I deepseek@laptop-2026 \
  -n deploy,admin \
  -V +8h \
  ~/.ssh/id_ed25519.pub
# -> 在密钥旁边写出 ~/.ssh/id_ed25519-cert.pub
```

当证书和私钥同名、只是多一个 `-cert.pub` 后缀地放在一起时，`ssh` 会自动把它捡起来用。任何时候都能用 `-L` 查看它，它会打印出 principals、有效期和 critical options：

```bash
ssh-keygen -L -f ~/.ssh/id_ed25519-cert.pub
# Type: ssh-ed25519-cert-v01@openssh.com user certificate
# Public key: ED25519 ...
# Valid: from 2026-11-24T09:00:00 to 2026-11-24T17:00:00
# Principals: deploy, admin
# Critical Options: (none)
```

要进一步收紧一张证书，就在签名时加 `-O` 参数。下面这几个是我最常用的：

```bash
# 只允许来自办公室/VPN 网段，禁止转发，只跑一条强制命令
ssh-keygen -s ~/.ssh/ca_user -I ci-runner -n deploy -V +1h \
  -O source-address=203.0.113.0/24 \
  -O no-port-forwarding -O no-agent-forwarding \
  -O force-command='/usr/local/bin/backup.sh' \
  ~/.ssh/id_ed25519.pub
```

证书就是公开数据——随便粘到聊天里、交给同事、或者提交进配置仓库都是安全的。只有 CA 私钥是秘密。就这一句话，是证书能规模化的原因。

## 在服务器上信任这个 CA：TrustedUserCAKeys

在服务器上，一行配置把 `sshd` 指向 CA 的*公钥*。此后任何由该 CA 签出的证书都会被接受，前提是它的 principals 和有效期合规：

```sshdconfig
# /etc/ssh/sshd_config
TrustedUserCAKeys /etc/ssh/user_ca.pub

# 可选：每个用户被允许的 principals 放在哪里
AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u

# 可选：把 key id 和 principals 记进认证日志
LogLevel VERBOSE
```

```bash
# 用你的配置工具，把 CA 公钥一次性装到每台服务器上
sudo install -m 0644 -o root -g root ~/.ssh/ca_user.pub /etc/ssh/user_ca.pub
sudo sshd -t && sudo systemctl reload sshd
```

当 agent 持有证书时，真正被用上的是那份 `.pub`。把私钥和证书一起加进去，agent 才能两者都提供：

```bash
eval "$(ssh-agent -s)"
ssh-add -t 8h ~/.ssh/id_ed25519           # 会顺带装上同名的 -cert.pub
# 或者写明确一点
ssh-add ~/.ssh/id_ed25519 ~/.ssh/id_ed25519-cert.pub
ssh-add -L | head -2                       # 第二行就是那张证书
```

`AuthorizedPrincipalsFile` 就是用来替代逐主机 `authorized_keys` 做角色控制的那个部件：`deploy` 只有在证书带着 `deploy` 这个 principal 时才能进来，同时你还能为那唯一一个遗留账号保留一份手写的 `authorized_keys`。迁移期间，`TrustedUserCAKeys` 和 `authorized_keys` 是共存的——我自己就并行跑了好几个月。

## 主机证书：干掉 TOFU 提示

第一次连一台新服务器时，`ssh` 会打印一串指纹，让你输入 `yes`。这就是 TOFU——首次使用即信任（trust on first use）——而在一整个集群里，正是它把人们训练成无视那个真正要紧的告警。主机证书能把它消除：同一个 CA 去签服务器的*主机*密钥，于是每个本就信任该 CA 的客户端都会无提示地接受连接。

```bash
# 在主机 CA 上做（可以放在构建机或你的笔记本上）
ssh-keygen -t ed25519 -f ~/.ssh/ca_host -C "team host CA 2026"

# 签服务器的公钥。-h 把它标记为主机证书；
# -n 列出客户端会用来访问它的那些名字。
ssh-keygen -s ~/.ssh/ca_host -I web-01 -h \
  -n web-01.example.com,10.0.0.5,web-01 \
  -V +52w \
  /etc/ssh/ssh_host_ed25519_key.pub
# -> /etc/ssh/ssh_host_ed25519_key-cert.pub
```

```sshdconfig
# /etc/ssh/sshd_config
HostKey /etc/ssh/ssh_host_ed25519_key
HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub
```

在每个客户端上，`known_hosts` 里加一行——不用再一家家去追每条主机记录：

```text
@cert-authority *.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... host-ca
```

现在 `ssh web-01.example.com` 会拿 CA 去校验主机密钥，包括它匹配到的名字。如果有人用一把从未被签过的密钥对你做中间人攻击，客户端会直接拒绝、连问都不问——这正是那个 `yes` 提示一直没能做到的事。以后要轮换主机密钥，只需签一下新密钥；客户端根本看不到什么吓人的变更告警。

## 面向团队的短时效凭证

真正带来质变的部分，是短有效期。我的默认值是：交互式登录八小时，自动化任务十五分钟，因为一张会过期的凭证是不可能被遗忘的：

- **入职者**拿到一张证书。没有任何一步需要去碰五十台服务器，因为服务器向来只信任那个 CA。
- **离职者**什么都不用对他做。他的证书自然过期，密钥一文不值。离职时的慌乱消失了。
- **被攻破**的影响是有界的。一台被偷的笔记本只换来 8 小时的窗口，而不是永久访问——而且只要你记录了 key ID，就能精确知道该对哪张证书生气。
- **轮换**变成自动的：签发、使用、过期、再来一遍。没有任何东西需要删除。

实践中，你会停止手工敲 `ssh-keygen -s`，转而在你的身份提供方背后放一个小的签发器：一条内部命令、一个网页表单，或者像 step-ca、Vault 这样的 CA 实现。签发器确认你是谁，然后用正确的 `-n` principals 签出 `-V +8h`。服务器从此再也不用改。

## 不靠 CRL 的吊销

你*确实*可以吊销一张证书，用的是由 `ssh-keygen -k` 生成、并在 `sshd_config` 里通过 `RevokedKeys` 引用的 **KRL**（key revocation list）。它管用，也值得了解，但我很少动用它：

```bash
# 列出要吊销的对象，然后编译出一个 KRL
ssh-keygen -k -f /etc/ssh/revoked_keys \
  -s /etc/ssh/revoked_keys.serial ~/.ssh/to-revoke.pub
```

```sshdconfig
RevokedKeys /etc/ssh/revoked_keys
```

我很少需要它的原因：KRL 得被推送到每一台服务器上，这不就是 `authorized_keys` 当初那个分发难题吗。**短有效期本身就是吊销机制。** 如果最坏情况的窗口只有一个工作日，那"吊销"就变成了"等到 17:00"。把 KRL 留给连这个窗口都无法接受的情形——一场正在进行的应急事件、一枚丢失的硬件令牌——把它当作应急工具，而不是日常卫生。

## 什么时候普通密钥依然够用

证书不是宗教。我在好几个地方仍然用普通密钥：

- **一台家庭服务器，只配我自己的一两台设备。** 每台笔记本一行 `authorized_keys`，没有团队，没有轮换压力。上 CA 纯属仪式感。
- **一台全新机器上的第一把密钥。** 在你信任一个 CA 之前，总得先进得去；一把裸密钥就是那扇门。
- **把 `authorized_keys` 当作迁移的缓坡。** 为遗留账号让它和 `TrustedUserCAKeys` 并存，是务实的做法，不是失败。
- **影响面极小的硬件密钥。** 一台笔记本上、只对一台主机用的 `ed25519-sk`，不需要有效期也很安全。

我用的准则是：当*人数乘以服务器数*大到你没法在脑子里列清楚这份访问权，或者你需要一个真正的过期时间时，就上 **CA**。低于这个门槛，散乱是廉价的，而 CA 是一件需要重新保护的新东西——CA 私钥是一份高价值秘密，你得存好、轮换好、保护好。别为了一台机器就签下这份负担。

## 收尾

**SSH 证书**不是什么新协议；它是一个 `ssh` 一直悄悄支持着的老协议。迁移就三步：建一个 CA，用 **`TrustedUserCAKeys`** 把 `sshd` 指向它的公钥，然后发放短时效证书，而不是去养一个越来越大的文件。再补一张**主机证书**，TOFU 提示也没了。做完之后，"谁能登到哪"就是由你掌控的一个文件，和一行能从日志里直接读出来的过期时间——比起一个自上次有人离职后就再没审计过的 `authorized_keys` 目录，这是好得多的处境。
