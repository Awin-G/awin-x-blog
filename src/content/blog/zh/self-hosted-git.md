---
title: "搭好你自己的 Git 服务器：Gitea 与 Forgejo 的生产实践"
description: "自建 Git 服务器什么时候值得，托管 forge 什么时候反而更好，以及如何避开 Gitea / Forgejo 的坑：安装方式、SSH 与 HTTPS 克隆地址、反向代理与证书、webhook 可达性、邮件、升级，以及一份你真的恢复过的备份。"
pubDate: 2026-12-01
lang: zh
translationKey: self-hosted-git
tags: [self-hosting, devops, nginx]
featured: true
keywords:
  - 自建 Git
  - Gitea
  - Forgejo
  - git 服务器
  - 反向代理
  - 备份
  - webhook
---

几年前我把仓库搬到了**自建 Git** 服务器上，从此没再回头。不是因为 GitHub
邪恶，而是我不想再「租用」那个存放我全部作品的地方。这就是我还会再做一次
的那个决定：一台 **Gitea** 或 **Forgejo** 机器到底给你换来了什么，什么时候
托管 forge 才是更聪明的选择，以及——大多数文章都跳过的那部分——在
`git push` 第一次成功*之后*会咬你的那几件事。

一台 **git 服务器**并不难。它就是一个 web 应用、一个数据库，加一个装满裸仓库
的目录。难的是它周围的一切：证书、代理头、可达的 webhook、邮件，以及一份你
演练过的恢复流程。把这些弄对，它会是你运维过的最省心的服务之一。

## 自建 Git 什么时候真的划算

自建 forge 不是一场纯粹主义考试。它在四种具体场景下才回本：

- **隐私与数据归属。** 你的代码、issue 和 CI 日志都在你掌控的机器上，落在你
  选定的司法辖区。对于受 NDA 约束的外包工作，或任何把凭据写进历史记录的仓库，
  这就是全部理由。
- **没有速率限制，没有意外账单。** CI 分钟数、LFS 带宽、API 调用，以及「你已
  超出 Actions 配额」的邮件全都不存在了。只要 CPU 还热着，你的 runner 就能一直构建。
- **CI 与钩子由你说了算。** 和数据库同机的 runner 可以直接访问内网服务。需要一个
  打到内网地址的 webhook？在托管 forge 上，那是一个你解决不了的防火墙问题。
- **掌控生命周期。** 你依赖的功能不会被从脚下悄悄废弃，升级什么时候做也由你决定。
  光是这一点，Forgejo 就是个很好的论据：它是 Gitea 在某个基金会下的社区分叉，
  治理模式完全不同。

## 什么时候托管 forge 就挺好（甚至更好）

诚实地看待这笔交易。托管 forge 免费给你一支只负责可用性的团队、一份异地代码
副本，以及零打补丁。以下情况请毫无愧疚地选它：

- 你是单人开发者，只有几个公开仓库，里面没有秘密。
- 你其实并不会测试自己的备份——一份没测过的自建备份*比*托管的更糟，因为它让你
  误以为安全。
- 你没有第二台机器。把 forge 放在你唯一拥有的那台机器上，离「非常糟糕的一周」
  只差一次硬盘故障。
- 你更看重贡献者而不是掌控——大 forge 的网络效应对开源来说是真金白银。

我的规则：两个都跑。把重要的仓库镜像到自建 forge 以保所有权，同时在大家都待的
地方留一个公开镜像。如果你想配上与之相适的单人工作流，请读
[单人开发者的 Git 工作流](/zh/posts/git-for-solo-developers/)。

## 安装方式：选一种，然后别纠结

安装 Gitea 或 Forgejo 有三种靠谱方式。它们都行；把它们混着用才是麻烦的来源。

### 二进制 + systemd

官方静态二进制就是一个文件，除数据库外没有任何运行时依赖。在普通 VPS 上这是我的
默认选择。

```bash
# 用一个无特权用户；二进制是自包含的。
sudo useradd --system --home /var/lib/gitea --shell /usr/sbin/nologin git
sudo install -o git -g git -m 0750 -d /var/lib/gitea/{data,log,custom,conf}
curl -L -o /tmp/gitea \
  https://dl.gitea.com/gitea/1.22.6/gitea-1.22.6-linux-amd64
sudo install -o git -g git -m 0755 /tmp/gitea /usr/local/bin/gitea
```

一个能让它活着、崩了就重启的 unit：

```ini
# /etc/systemd/system/gitea.service
[Unit]
Description=Gitea
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=git
Group=git
WorkingDirectory=/var/lib/gitea
ExecStart=/usr/local/bin/gitea web --config /var/lib/gitea/conf/app.ini
Restart=on-failure
RestartSec=5
Environment=USER=git HOME=/var/lib/gitea
# 别让 web 应用和内核抢内存。
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 容器

如果你本来就在跑容器，镜像是最省事的路。把数据和配置 bind-mount 出去，绝不要让
数据库待在容器的可写层里。

```yaml
# compose.yaml —— 数据库和仓库都在具名卷上，不在可写层。
services:
  gitea:
    image: gitea/gitea:1.22
    restart: unless-stopped
    environment:
      - GITEA__database__DB_TYPE=postgres
      - GITEA__database__HOST=db:5432
      - GITEA__server__SSH_PORT=2222
      - GITEA__server__DOMAIN=git.example.com
      - GITEA__server__ROOT_URL=https://git.example.com/
    volumes:
      - ./data:/data
      - ./config:/etc/gitea
    ports: ["127.0.0.1:3000:3000", "2222:22"]
    depends_on: [db]
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      POSTGRES_USER: gitea
      POSTGRES_DB: gitea
volumes: { pgdata: {} }
```

### 发行版软件包

在 Debian/Ubuntu 上，`apt install gitea`（来自上游仓库）或 Forgejo 自己的包会给你
一个加固过的 unit、一个系统用户，以及 `/etc/gitea` 里的配置。当你已经信任的发行版
替你走完升级路径时，这很香。无论选哪种：**一台机器只装一个**，只有一个数据库。
两个半配置状态的安装共用一个数据目录，是你给自己写的工单。

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="流量路径：浏览器与 git 客户端经 443 和 22 到达 nginx，nginx 代理到监听在本地的 Gitea Web 应用，Gitea 再与 PostgreSQL 和磁盘上的仓库通信。">
  <g fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7">
    <rect x="16" y="70" width="120" height="80" rx="10"/>
    <rect x="200" y="70" width="130" height="80" rx="10"/>
    <rect x="392" y="20" width="150" height="64" rx="10"/>
    <rect x="392" y="136" width="150" height="64" rx="10"/>
    <path d="M136 96 H200"/><path d="M136 128 H200"/>
    <path d="M330 96 H392"/><path d="M330 128 H392"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="30" y="108">浏览器 + git</text><text x="30" y="126">客户端</text>
    <text x="214" y="100">nginx</text><text x="214" y="118" opacity="0.75">:443 / :22 TLS</text>
    <text x="406" y="46">Gitea Web 应用</text><text x="406" y="64" opacity="0.75">127.0.0.1:3000</text>
    <text x="406" y="162">PostgreSQL</text><text x="406" y="180" opacity="0.75">磁盘上的仓库</text>
  </g>
</svg>
<figcaption>对世界暴露的只有 nginx 的端口。Gitea 和数据库都待在回环地址上。</figcaption>
</figure>

## 第一次 push 之后会咬你的那些事

### 既备份数据库，*也*备份仓库

仓库是磁盘上的文件；而*元数据*——用户、issue、PR、webhook、令牌——活在数据库里。
只抓 `repositories/` 的备份，恢复出来的是一个能跑但谁都不认识的 forge。只抓数据库的
备份，恢复出来的是一个满屏空项目的 forge。你需要两者，而且要一致。

### SSH 与 HTTPS 克隆地址

Gitea 在自己的端口（常见是 `2222`）上暴露 SSH，而系统 sshd 在 `22`。把 `SSH_PORT`
和 `SSH_DOMAIN` 设对，否则你打印出来的每个克隆地址都是错的：

```ini
# /var/lib/gitea/conf/app.ini
[server]
DOMAIN           = git.example.com
ROOT_URL         = https://git.example.com/
SSH_DOMAIN       = git.example.com
SSH_PORT         = 2222          ; 应用容器端口，不是 nginx
START_SSH_SERVER = false         ; false = 用宿主机的 sshd，更好
HTTP_PORT        = 3000
```

设成 `START_SSH_SERVER = false` 后，应用依赖宿主机的 `sshd` 和 `git` 用户。这意味着
`git` 账号需要一个 shell（`git-shell`）和它的密钥，防火墙也必须真的打开 `2222`。
而 HTTPS 克隆地址对 CI 和身处企业防火墙后的人最友好——两种都支持，两种都测。克隆
地址是一个承诺；确保它能解析。

### 反向代理与证书

在 nginx 终止 TLS，并把真实的 host 和 scheme 透传过去，否则 Gitea 会生成 `http://`
链接，弄坏 webhook 和 OAuth 重定向：

```nginx
# /etc/nginx/sites-available/git.example.com
server {
    listen 443 ssl http2;
    server_name git.example.com;

    ssl_certificate     /etc/letsencrypt/live/git.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/git.example.com/privkey.pem;

    client_max_body_size 512M;      # 否则大 push 会 413
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

证书方面，跑 `certbot --nginx -d git.example.com`，让它按定时器自动续期。唯一的坑：
续期会重载 nginx，所以务必在测试里验证这次重载能成功，而不是凌晨三点部署到一半时才
发现。

### webhook 可达性

webhook 会静默失败，而这正是问题所在。多数失败来自两点：

- **这个 URL 从 Gitea 容器里不可达。** 容器里的 `localhost` 是容器自己，不是你的
  CI 主机。用一个真实名字或局域网 IP。
- **私有 IP 被拦。** 为防 SSRF，Gitea 默认拒绝对 `127.0.0.1` 和 `10.0.0.0/8` 投递。
  如果 CI runner 真的在局域网上，就精确放行那个网段，别放更宽的。

```ini
[webhook]
ALLOWED_HOST_LIST = private, git.example.com, 127.0.0.1
```

然后去 **仓库 → 设置 → Webhooks → Recent Deliveries** 看投递记录。如果在那儿看不到
请求，再怎么猜你的 CI 都没用。在用上 webhook 之前先测它，并让 Gitea 在失败时通知你。

### 发通知用的邮件

密码重置、新用户确认、issue 通知，全都走 forge 的 mailer。第一天就把它从「未配置
邮件」的状态里弄出来：

```ini
[mailer]
ENABLED  = true
PROTOCOL = smtp+starttls
SMTP_ADDR = smtp.example.com
SMTP_PORT = 587
FROM     = forge@example.com
USER     = forge@example.com
PASSWD   = __用密钥存储__
```

用一个有真实信誉的专用 SMTP 中继；事务性邮件服务就挺好，而且比自建 MTA 强。如果邮件
悄悄进了垃圾箱，用户只会以为这个 forge 坏了。

## 认证：本地用户、OAuth 与 SSH 密钥

前两个账号先用本地用户，然后刻意做决定：

- **本地用户**最简单，离线也能用。小团队够用；人一多就烦。
- **OAuth / OIDC**（配合身份提供方）意味着你永远不用管密码，而且集中禁用一个账号
  就真的禁用了。只要不止一个人，就值得上。
- **SSH 密钥**给推送代码的人用；**deploy key** 是给服务器和 CI 用的只读（或单仓库
  可写）密钥。绝不把个人密钥当 deploy key 复用，也绝不给 deploy key 超过单个仓库的
  权限。

等你自己的账号建好后，关掉开放注册（`DISABLE_REGISTRATION = true`），并对所有能用
密钥的人禁用密码登录。公开 forge 上一个开放的注册页，就是一张请柬。

## 在小机器上跑

Gitea/Forgejo 是真的轻：一台 **1 vCPU / 1 GB** 的实例就能舒服地服务小团队。如果你
在同一台机器上跑自己的 CI runner，请上到 2 GB，否则构建会把 forge 本身 OOM 掉。
几个具体的旋钮：

- 数据库放本地、放 SSD 上，并且备份它——别放 NFS。
- 在 `app.ini` 里设好 `LFS_JWT_SECRET` 和一个真正的 `SECRET_KEY`，让会话能跨重启
  存活、签名 URL 保持有效。
- 让 git 干自己的活：`gc` 和 packfile 都会被处理，但要开启内置的 housekeeping，
  让大仓库按计划跑 `git gc`。
- 盯着磁盘：仓库悄悄变大，LFS 对象则会大声变大。

服务器侧的基础功——防火墙、自动安全更新、日志轮转——我的
[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/) 指南是本文的配套。

## 升级：读迁移说明

绝不跳过升级说明，也绝不盲穿大版本。Gitea 和 Forgejo 都会在启动时跑数据库迁移，
而且是单向的。安全的仪式是：

```bash
# 1. 先备份（见下）。没有备份的迁移是赌博。
# 2. 停服、换二进制、启动、盯日志里的迁移错误。
sudo systemctl stop gitea
sudo install -o git -g git -m 0755 /tmp/gitea-1.23.0-linux-amd64 /usr/local/bin/gitea
sudo -u git /usr/local/bin/gitea --version
sudo systemctl start gitea
sudo journalctl -u gitea -f     # 认真读；别只看「active」
```

读你要升*到*的那个版本的发布说明，以及中间每一个版本，重点关注 `[security]`、配置项
改名，以及「migration requires」。有条件就先在数据库的 staging 副本上做一遍。因为迁移
是单向的，回滚靠的是*那份备份*，而不是旧二进制。

## 一份真的能用的备份与恢复

把数据库、仓库和配置一起备份，用定时器跑，并且验证。这是精简版；完整的纪律在
[一份你能恢复的备份](/zh/posts/backups-you-can-restore/) 里。

```bash
#!/usr/bin/env bash
# /usr/local/bin/backup-gitea.sh —— 由 systemd timer 以 root 运行。
set -euo pipefail
DEST=/srv/backup/gitea/$(date +%F)
install -d -m 0700 "$DEST"

# 1. 数据库转储（Postgres）。用 --clean 便于覆盖已有数据库恢复。
sudo -u postgres pg_dump --clean --if-exists gitea | gzip > "$DEST/gitea.sql.gz"

# 2. 配置与密钥（app.ini 里有数据库凭据和 JWT secret）。
tar -czf "$DEST/conf.tar.gz" -C /var/lib/gitea conf custom

# 3. 仓库 + LFS + 附件。这一步要么停写，要么走快照。
sudo -u git tar -czf "$DEST/data.tar.gz" \
  -C /var/lib/gitea data/repositories data/lfs data/attachments

# 4. 验证：非空，且转储至少能列出表。
test -s "$DEST/gitea.sql.gz" && test -s "$DEST/data.tar.gz"
zcat "$DEST/gitea.sql.gz" | grep -q 'CREATE TABLE'
echo "backup ok: $DEST"
```

恢复才是证明它的那一步。在目标机器上：

```bash
sudo systemctl stop gitea
sudo -u postgres createdb gitea                      # 全新、空的
zcat "$DEST/gitea.sql.gz" | sudo -u postgres psql -d gitea
sudo tar -xzf "$DEST/conf.tar.gz" -C /var/lib/gitea  # app.ini 各就各位
sudo tar -xzf "$DEST/data.tar.gz" -C /var/lib/gitea  # 仓库、lfs、附件
sudo chown -R git:git /var/lib/gitea
sudo systemctl start gitea
```

每季度至少在一台一次性 VM 上做一次这个演练。你需要它的那个晚上，绝不是你发现 `git`
用户读不了自己数据目录的好时机。

## 诚实的总结

自建 forge 就是一个 web 应用、一个数据库，加一个装满裸仓库的文件夹。服务本身简单；
它周围的运维——TLS、代理头、可达的 webhook、邮件、单向迁移，以及一份演练过的恢复——
才是真正的工作。把这些弄对，同时跑一个自建 forge 和一个公开镜像，你就拥有了自己的
代码，而不是让它拥有你的夜晚。
