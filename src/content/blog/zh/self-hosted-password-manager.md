---
title: "自建密码管理器：用 Vaultwarden 安全托管密码库的实战指南"
description: "一篇以安全为先的自建密码管理器指南：为什么要把密码库掌握在自己手里，以及随之而来的责任；Vaultwarden、KeePassXC + 同步与 Bitwarden 官方版之间怎么选；一份安全的部署方案（HTTPS、反向代理、admin token、关闭注册、备份加密数据库、二次验证）；诚实的威胁模型；客户端配置；以及服务器挂掉时的灾难恢复。"
pubDate: 2026-12-02
lang: zh
translationKey: self-hosted-password-manager
tags: [self-hosting, security, devops]
featured: false
keywords:
  - 自建密码管理器
  - Vaultwarden
  - Bitwarden
  - 密码库
  - 端到端加密
---

**自建密码管理器（self-hosted password manager）** 是唯一一个让你关心的不是"博客挂一小时"、而是"有人拿到了我所有的凭据"的自建服务。这恰恰是我认为它值得做的原因——也恰恰是它比随手 `docker compose up` 更值得认真对待的原因。这篇指南讲的是我怎么运行自己的 **密码库（password vault）**：用 **Vaultwarden** 当作轻量、兼容 Bitwarden 的服务器，配上一套我哪怕有人在背后盯着看也会满意的安全姿态。

## 为什么要自建密码管理器（以及你要承担的责任）

自建的理由很直白。**控制权：** 密码库放在我拥有的硬件上，在我选的司法辖区里，在一块我能亲自检查的磁盘上。**不用订阅：** Bitwarden 官方云又便宜又好用，但"永远免费、跑在我自己的机器上"胜过"免费到定价页改版为止"。**离线可用：** 我的设备上存着完整的加密副本，所以哪怕断网、哪怕服务器挂了，也不会把我锁在自己的登录之外。

最后这一点就是整个架构的核心，所以现在就记住它：一个好的自建 **密码库** *不是* 一个你依赖的 Web 服务，而是一个同步服务，用来同步那些本来就躺在你设备上的加密数据。服务器只是便利，不是真相之源。

然后是责任，不加任何修饰地说清楚。当你转向 **自建密码管理器** 时，*你* 就成了那顶王冠上珠宝的保管人。厂商有安全团队、on-call 轮值和事故响应预案；你只有一台 VPS、一个 compose 文件，和一个你在某个周二写下的备份脚本。如果你的服务器被攻陷、密码库被拖走，blast radius（爆炸半径）就是你的邮箱、你的银行、你的域名注册商，以及每一个通过它们找回密码的账号。这是一笔真实的交易，你应该睁大眼睛去做。

## 选项：Vaultwarden、KeePassXC + 同步，以及其他

这里有两种哲学，选哪一种才是真正的决定。

- **Vaultwarden**（前身 bitwarden_rs）是社区用 Rust 重写的 Bitwarden 服务端 API。它讲 Bitwarden 协议，所以能和官方的 **Bitwarden** 浏览器插件、桌面端和移动端配合——你只要把它们指向自己的 URL。它是单个容器里的单个二进制，后端是 SQLite 或 Postgres，空闲时只占几十 MB 内存。吸引力就在这里：真的客户端、极小的服务器、不用厂商账号。
- **KeePassXC + 同步** 是无服务器的另一种选择。你的密码库就是一个加密的 `.kdbx` 文件，KeePassXC 在本地打开它。"同步"就是你已经信任的、用来搬运一个文件的任何东西——Syncthing、一个 git 仓库、某个网盘。没有服务器可攻陷，因为没有服务器。代价是共享更笨拙，以及两台设备同时编辑时的文件冲突合并风险。
- **同族的其他选择：** **Bitwarden** 本身的官方自建（`bitwarden/server`），但重得多——约 2 GB 内存、多个服务和 MSSQL——这正是 Vaultwarden 存在的原因；还有 **Padloc**、**Passbolt**（面向团队、基于 GPG）以及你若是自虐狂可以用的纯 **age**/`gpg` 加密文件。我链接的那篇 `secrets-management` 讲的是面向机器密钥的文件档位；密码管理器是给 *人* 的登录用的。

如果你想要官方客户端又想要尽可能小的服务器，Vaultwarden 就是务实的默认答案。如果你想要零网络攻击面，KeePassXC 胜出。下文都假设用 Vaultwarden，但备份和威胁模型的推理对两者都成立。

## 密码库是端到端加密的——先理解这一点

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="客户端用主密码派生的密钥加密密码库；服务器只存密文；各设备在本地解密。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="16" y="26" width="180" height="198" rx="10"/>
    <rect x="444" y="26" width="180" height="198" rx="10"/>
    <rect x="252" y="70" width="136" height="110" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="106" y="50" font-size="14" font-weight="600">你的设备</text>
    <text x="106" y="78">主密码 + 二次验证</text>
    <text x="106" y="102">本地派生密钥（KDF）</text>
    <text x="106" y="126">在此解密密码库</text>
    <text x="106" y="160" font-weight="600">明文永不离开</text>
    <text x="320" y="94" font-size="14" font-weight="600">你的服务器</text>
    <text x="320" y="120">只存密文</text>
    <text x="320" y="144">同步 + 附件</text>
    <text x="534" y="50" font-size="14" font-weight="600">另一台设备</text>
    <text x="534" y="78">同一个主密码</text>
    <text x="534" y="102">在本地解密</text>
    <text x="534" y="126">服务器读不到</text>
    <text x="534" y="160" font-weight="600">只见密文</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#a)">
    <line x1="196" y1="120" x2="250" y2="120"/>
    <line x1="388" y1="120" x2="442" y2="120"/>
  </g>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    </marker>
  </defs>
</svg>
<figcaption>主密码在客户端派生出密码库密钥，服务器始终只持有密文，所以数据库被拖走不等于明文密码库被拖走。</figcaption>
</figure>

**端到端加密（end-to-end encryption）** 正是自建密码库能够成立的原因。客户端用你的主密码（经由 KDF）派生出密码库密钥，所有密码学运算都在本地完成。落到服务器数据库里的是密文。这不代表服务器不重要——被攻陷的服务器仍可能给你投毒一个恶意的 Web 密码库、篡改客户端更新，或泄露元数据——但它意味着最坏的"数据库被偷"并不自动等于"我的密码全公开"。记住这点，因为它塑造了下面威胁模型里的一切。

## 一份安全的 Vaultwarden 部署

顺序很重要：在反向代理上终结 TLS，让容器远离公网，并把项目给你的每一道闸门都打开。

### 1. HTTPS 是强制的，不是可选项

绝不要用纯 HTTP 暴露 Vaultwarden。Web 密码库和 API 都依赖安全来源（secure origin），否则浏览器会拒绝使用加密 API。在反向代理上终结 TLS——Caddy 会自动帮你拿到证书：

```Caddyfile
# Caddyfile —— vault.example.com 走自动 HTTPS
vault.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

如果你更喜欢 nginx，形状是一样的：一个带有效证书的 `server` 块、`proxy_pass http://127.0.0.1:8080;`，以及常规的转发头。容器本身只应绑定到回环地址——绝不要把 8080 端口发布给全世界。

### 2. compose 文件

```yaml
# docker-compose.yml —— Vaultwarden，只绑回环，数据放在容器外
services:
  vaultwarden:
    image: vaultwarden/server:latest
    container_name: vaultwarden
    restart: unless-stopped
    environment:
      DOMAIN: "https://vault.example.com"
      SIGNUPS_ALLOWED: "false"          # 关闭公开注册
      INVITATIONS_ALLOWED: "false"
      ADMIN_TOKEN: "${VW_ADMIN_TOKEN}"  # 长随机值，启动时经 argon2 哈希
      WEBSOCKET_ENABLED: "true"
      # 为简洁省略 SMTP —— 邮件二次验证和邀请需要它
    volumes:
      - ./vw-data:/data               # 加密数据库就在这里
    ports:
      - "127.0.0.1:8080:80"           # 绝不要写 0.0.0.0
```

有三个设置很关键。**`SIGNUPS_ALLOWED: "false"`** 在你创建完唯一那个账号后就把门关上——一台密码服务器上开着注册端点就是在发请帖。**`ADMIN_TOKEN`** 必须是一长串随机值；Vaultwarden 启动时会用 Argon2 对它做哈希，所以一个弱 token 就是攻击者和管理后台之间唯一的那道墙。**`DOMAIN`** 必须是真实的 HTTPS URL，否则客户端会对着错误的来源做认证。

### 3. 加密数据库的备份

`/data` 目录 *就是* 你服务器的全部状态：SQLite 数据库、RSA 密钥、附件和配置。按计划备份它，并在传输途中加密。一个懂 Vaultwarden 的备份必须先让数据库安静下来：

```bash
#!/usr/bin/env bash
# /usr/local/bin/vw-backup.sh —— 一致且加密的 Vaultwarden 备份
set -euo pipefail
DEST=/srv/backups/vaultwarden
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$DEST"

# 用内置的 SQLite dump，让副本在事务上保持一致。
docker exec vaultwarden sqlite3 /data/db.sqlite3 ".backup '/data/db.backup'"
docker cp vaultwarden:/data/db.backup "$DEST/db-$STAMP.sqlite3"
rm -f "$DEST"/*.backup

# 立刻加密 —— 绝不让明文数据库碰到异地存储。
tar -C "$DEST" -czf - "db-$STAMP.sqlite3" \
  | age -r "$(cat /etc/vaultwarden-backup.pub)" \
  > "$DEST/db-$STAMP.tar.gz.age"
rm -f "$DEST/db-$STAMP.sqlite3"
```

用 systemd timer 每晚触发它，再加一个任务把 `.age` 文件送到异地：

```ini
# /etc/systemd/system/vw-backup.timer
[Unit]
Description=Nightly Vaultwarden backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

要测试的是恢复，而不只是备份。一个恢复不了的密码库不算备份——[一份你真能恢复的备份](/zh/posts/backups-you-can-restore/) 讲的正是这份纪律，而静态数据的加密见 [静态加密](/zh/posts/encryption-at-rest/)。至于我如何处理这套栈周边的机器密钥，见 [secrets management](/zh/posts/secrets-management/)。

### 4. 账号上的二次验证

为你自己的账号打开二次验证，并留一条回来的路。WebAuthn/FIDO2 或一个 TOTP 应用都行；把 **恢复码离线保存**。Vaultwarden 的邮件二次验证需要一个能用的 SMTP 中继，那本身就是个泥潭——TOTP 应用能完全绕开这个依赖。重点是：只凭主密码，绝不应该足以触及你的密码库。

## 诚实地看待威胁模型

两类截然不同的攻击常被混成一句"自建有风险"。要把它们分开看。

- **服务器被攻陷。** 如果有人拿下了这台机器，他们能读到 SQLite 数据库——但那是密文，所以他们拿到的是元数据（用户名、同步时间、条目数），而不是密码。不过，他们可以给你投毒一个被篡改的 **Web 密码库**：Web 密码库是你下载并在浏览器里执行的 JavaScript，这就使它成为一块 XSS 攻击面。控制了服务器的攻击者可以注入脚本，在 *你解密之后* 偷走密码库。这就是为什么我把浏览器 Web 密码库当作便利，而把原生客户端当作可信路径——也是为什么"攻击者拥有服务器"对一个 Web 交付的客户端来说从不安稳。
- **客户端被攻陷。** 这才是真正的王冠珠宝事件。一台已解锁笔记本上的恶意软件、一个键盘记录器、一个恶意浏览器插件——任何一个都能在密码库打开后读到它，因为按定义那里就是明文所在之处。端到端加密对一台被攻陷的终端毫无作用；一个强主密码和一个锁定的密码库（很短的自动锁定、睡眠即锁）是你唯一的防线。

诚实的总结是：**加密数据库让一台被偷走的服务器变得可以承受；但没有任何东西能让一台被偷走的设备变得可以承受。** 据此分配你的精力。用高熵生成主密码、绝不复用，因为它是解开下游一切的唯一那把钥匙。

## 客户端配置

把 **Bitwarden** 客户端指向你的服务器，剩下的交给同步：

1. 安装官方 Bitwarden 插件和桌面/移动端应用。
2. 在登录页打开齿轮/区域选择器，选 **自建（Self-hosted）**，然后填入 `https://vault.example.com`。在每台设备上都设置同一个服务器，账号才对得上。
3. 用邮箱和主密码登录，完成二次验证，让第一次同步把密码库拉下来。打开飞行模式确认密码库能离线打开。
4. 设一个很短的自动锁定超时，并开启睡眠即锁。不用的时候就让它锁着。

## 灾难恢复：当服务器挂掉

这是大家最容易跳过、而自建真正回本的一环。你的设备上存着密码库的完整加密副本。如果 VPS 明天消失了：

- **你的密码还在。** 开飞行模式打开 Bitwarden（或 KeePassXC），密码库从本地存储解锁。你丢的是 *同步*，不是 *访问*。
- **重建前先导出。** 从一个已解锁的客户端导出密码库（加密 JSON 或 `.kdbx`），在你动服务器之前先把它放到安全的地方——绝不要依赖那台正在死去的机器。
- **从备份重建。** 把 `db-<stamp>.sqlite3` 恢复到一个新容器的 `/data`，用相同的 `DOMAIN` 启动，客户端就会重新同步。如果你怀疑旧主机被攻陷，轮换 admin token 和 RSA 密钥。
- **最后的手段。** 如果 *所有东西*——服务器和设备——都没了，回到一个 Bitwarden 密码库的唯一途径就是你离线保存的主密码和 **应急导出**。两者都没有，那这个密码库按设计就是不可恢复的。

这种不对称就是全部要义：让密码库对你的服务器安全的加密，同样也让它在 *你* 弄丢每一份密钥副本时对你不安全。把密码库留在你的设备上，留一份离线导出，留一份离线的备份副本和恢复码，于是一台死掉的服务器只是一点麻烦，而不是一场灾难。

## 总结

如果你接受随之而来的保管责任，**自建密码管理器** 就值得运行。要官方 Bitwarden 客户端加一台小服务器，就选 **Vaultwarden**；要干脆不要服务器，就选 **KeePassXC + 同步**。在反向代理上终结 HTTPS、关闭注册、设置强 admin token、打开二次验证，并按一个你真正演练过恢复的节奏备份加密数据库。然后信任这套架构：密码库是 **端到端加密** 的，服务器持有密文，你的设备才是真正的那份副本。像对待唯一单点故障那样守护好主密码，自建密码就不再是鲁莽之举，而是负责任的默认选择。
