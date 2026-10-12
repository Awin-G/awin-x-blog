---
title: "不用 Docker 的自托管：nginx、systemd 与一把锁"
description: "Docker 不是运行服务的唯一方式。我用 nginx 做反向代理、systemd 单元与定时器做守护和调度、flock 做单飞任务，再用符号链接完成原子部署，在一台 VPS 上托管多个站点和定时任务。文末也诚实聊聊哪些情况下你确实应该直接用容器，并附上可直接复制的配置。"
pubDate: 2026-10-14
lang: zh
translationKey: self-hosting-without-docker
tags: [self-hosting, nginx, devops, systemd]
featured: false
keywords:
  - 不用 Docker 自托管
  - nginx 反向代理
  - systemd 定时器
  - 原子部署
  - VPS 运维
---

我在一台 VPS 上跑着这个博客、几个小 API，以及一堆定时任务。没有 Docker，没有
Kubernetes，也没有一个半年没人读过的 Compose 文件。只有操作系统自带的原语：用
**nginx** 给每个站点做统一入口，用 **systemd** 做进程守护与调度，用 `flock` 做单飞
任务，再用一次符号链接切换完成**原子部署**。

这是一份带有明确观点的实践记录。它不是在向容器宣战——我自己也用容器——而是想说明：
用已经装好的工具做 *self-hosting*，在很多场景下就已经够用，并且更好维护。下面是可
直接复制的单元文件和配置。

## 为什么一台单机往往就是正确答案

容器的叙事通常默认你有一整个集群。但一台 VPS 不是集群。在一台机器上，只有一个内核、
一棵进程树、一个出问题时可以查看的地方。这种简单不是妥协，它本身就是收益。

- **只有一个地方要看。** `systemctl status`、`journalctl -u`、`ss -ltnp`。没有镜像
  仓库要检查，没有构建守护进程要照看，也没有几十 GB 说不清来历的层缓存。
- **部署逻辑是可读的。** 部署就是 `git reset --hard`、跑构建、重新指向一个符号链接。
  整套机制你一分钟就能读完。
- **开销是真实存在的。** 每个容器都带着自己的 init、自己的用户空间、自己的日志通路。
  在一台 1 GB 内存、跑着三个小服务的机器上，这份开销并不免费。

对于一个博客、几个内部 API 和一些类 cron 任务来说，操作系统本身就是那个「编排器」。
剩下的只是口味。

## 容器真正赢在哪（说实话）

我不会假装容器只是噱头。它们解决的是真问题，如果你有这些需求，就该用它们：

- **运行时依赖互相冲突。** 两个 Python 服务需要同一份本地库的不同版本，这正是虚拟
  环境和容器被发明出来要解决的问题。在共享机器上用 venv 硬扛这件事，是场必输的仗。
- **构建流程复杂的第三方软件。** 如果上游维护着带版本锁定的镜像，拉取它比自己编译、
  并从此永远承担每一层传递依赖要划算。
- **团队间的可复现性。** 「在我机器上能跑」是个容器问题。镜像让每个人拿到完全相同的
  字节。
- **横向扩展与编排。** 多副本、多机器、滚动重启、自动扩缩容。一台单机做不到，也不该
  硬做。

但这些都不是「把静态 HTML 发出去」或「守着 `node server.js`」所必需的。容器是用于
依赖隔离和大规模调度的工具；如果没有这些需求，它更像是仪式。

## 用 nginx 作为众多虚拟主机的统一入口

一个 nginx 实例终结 TLS，并按主机名路由。每个站点在 `sites-available` 里有一个属于
自己的文件，通过符号链接启用，因此新增站点从不需要改动已有站点。

```nginx
# /etc/nginx/sites-available/blog
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name blog.awin-x.top;

    ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;

    root /srv/www/blog/current;   # 一个符号链接 —— 见部署那一节
    index index.html;

    location / {
        try_files $uri $uri/ $uri.html =404;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name blog.awin-x.top;
    return 301 https://$host$request_uri;
}
```

如果背后是一个常驻服务而不是静态目录，nginx 就是一个指向**只监听回环地址**端口的
反向代理：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:9001/;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

我遵守两条规则：应用只绑定 `127.0.0.1`，绝不绑定 `0.0.0.0`——暴露在公网上的只有
nginx；每次 reload 之前先跑 `nginx -t`，这样一个手误就不会把入口打挂。

## systemd 单元：不需要额外的守护器

别人装进程管理器要干的事，systemd 已经干了，而且它本来就在。一个单元声明「运行什么」
和「如何对待它」；`Restart=on-failure` 配上 `RestartSec` 就是崩溃恢复，`enable --now`
让它开机自启。

```ini
# /etc/systemd/system/notes-api.service
[Unit]
Description=notes API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=svc-notes
WorkingDirectory=/srv/apps/notes/current   # 符号链接指向的发布目录
ExecStart=/srv/apps/notes/current/bin/notes-server
Environment=PORT=9001
Restart=on-failure
RestartSec=2

# 几乎零成本、值得一开始就加上的加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/notes

[Install]
WantedBy=multi-user.target
```

然后 `systemctl daemon-reload && systemctl enable --now notes-api`，日志进入
`journalctl -u notes-api`，轮转自动处理。这个服务无法写到 `/var/lib/notes` 之外；
一个 bug 的爆炸半径由单元定义，而不是由容器运行时定义。

## 用 systemd 定时器取代 cron

cron 能用，但对任何你在意的任务来说，**systemd 定时器**是更好的调度器。它把日志写进
journal，尊重依赖关系，能补跑关机期间错过的执行，并且更精确地表达调度。

定时器只是触发器，真正的工作放在一个 `oneshot` 服务里：

```ini
# /etc/systemd/system/blog-pull.timer
[Unit]
Description=轮询 Git 是否有新提交

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/blog-pull.service
[Unit]
Description=拉取、构建并部署博客

[Service]
Type=oneshot
User=deploy
ExecStart=/usr/bin/flock -n /run/blog-deploy.lock /srv/apps/blog/deploy.sh
```

`Persistent=true` 是 cron 不花代价就给不了的能力：如果到点时机器是关的，systemd 会在
下次开机时补跑一次，而不是悄悄跳过。`systemctl list-timers` 能告诉你接下来会发生什么，
比对着 crontab 苦思冥想舒服得多。

## flock：一个任务，只有一个执行者

任何部署自动化遇到的第一个真实 bug 都是*并发*。webhook 触发了一次，五分钟后定时器又
在第一次构建还没结束时触发，于是两个进程在同一个目录里同时做 `git reset --hard`。
一团糟。

`flock` 让任务变成单飞：在运行期间持有一把建议锁，若锁已被持有则拒绝启动。`-n`
表示「不等待，立刻失败」，这正是轮询任务想要的行为。

```bash
#!/usr/bin/env bash
# /srv/apps/blog/deploy.sh
set -euo pipefail

# 单飞：若已有部署持锁，安静退出。
exec 9>/run/blog-deploy.lock
flock -n 9 || { echo "已有部署在运行，跳过"; exit 0; }

cd /srv/apps/blog/repo
git fetch --quiet origin main
git reset --hard origin/main

npm ci
npm run build

# 把新版本构建到独立的发布目录。
RELEASE="/srv/www/blog/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$RELEASE"
cp -a dist/. "$RELEASE"/

# 原子切换 `current` 符号链接（见下）。
ln -sfn "$RELEASE" /srv/www/blog/current.tmp
mv -Tf /srv/www/blog/current.tmp /srv/www/blog/current

echo "已部署 $RELEASE"
```

这把锁就是「一个通常能用的调度器」和「一个不会弄坏自己的调度器」之间的差别。让轮询的
锁和部署的锁指向同一个文件，那么你有多少种触发方式都无所谓。

## 用符号链接切换实现原子部署

切换发生在那一行。`ln -sfn` 写出一个新的符号链接，`mv -T` 把它改名覆盖旧的。在 Linux
上，重命名符号链接是一次原子的 `rename(2)`——内核一步完成切换。不存在 `current` 指向
一个复制了一半的目录的窗口期。

nginx 按每个请求解析 `root /srv/www/blog/current`，因此它会一直提供旧版本，直到改名
落地的瞬间，然后开始提供新版本。回滚是同一个操作反过来做：把 `current` 重新指向上一个
发布目录。

```bash
# 回滚到上一个发布版本
PREV=$(ls -1dt /srv/www/blog/releases/* | sed -n 2p)
ln -sfn "$PREV" /srv/www/blog/current.tmp
mv -Tf /srv/www/blog/current.tmp /srv/www/blog/current
```

因为每个发布都是一个完整、带时间戳的目录，「当前」和「上一个已知可用」永远都在磁盘上。
你可以用定时任务清理旧发布，而完全不碰正在服务的那个。

## 你放弃了什么，以及如何补偿

不靠容器的自托管有真实代价。我是刻意这样弥补的：

- **没有不可变镜像。** 办法是把每次发布保留为完整目录（如上），并把基础设施放进 Git
  ——`etckeeper` 管 `/etc`，单元文件和 `deploy.sh` 与应用一起做版本管理。
- **补丁得自己打。** 用 `unattended-upgrades` 处理安全更新，并养成按计划重启的习惯，
  而不是假装永远不需要重启。
- **配置漂移。** 手改 `/etc` 是那种慢动作式的事故。真正重要的一切都活在仓库里；这台
  机器是可丢弃、可从中重建的。
- **没有免费的资源配额。** systemd 给每个单元提供了 `MemoryMax=`、`CPUQuota=`、
  `TasksMax=`，对一台机器来说通常够用了。

## 什么时候你就该直接用 Docker

存在一个阈值，值得诚实地讲出来。遇到下面这些情况，就用容器：

- 两个服务确实无法共用一个运行时，而 venv 或语言版本管理器救不了你。
- 你需要跨多台机器、多个人做到逐字节的可复现。
- 软件提供维护良好的镜像，而它的构建流程不该由你来承担。
- 你要扩展到一台机器之外，或者需要带健康检查、零停机的滚动部署。
- 你要让一群人类新人上手，而他们期待 `docker compose up` 就是全部故事。

在这个阈值之下——几个站点、几个小服务、一些任务——操作系统就够了，而且在凌晨三点
更容易推理。我描述的这一整套东西塞进一页纸就够了：nginx 配置、几个单元、一个 shell
脚本，以及一把锁文件。

如果你想看这个博客本身是如何用这种方式构建和部署的，机制写在
[这个博客如何发布它自己](/zh/posts/how-this-blog-ships-itself/) 里，而操作这台机器的
agent 的故事写在 [一个 AI 在运营这个博客](/zh/posts/an-ai-runs-this-blog/) 里。RSS 订阅
`/rss.xml` 是最省事的关注方式。
