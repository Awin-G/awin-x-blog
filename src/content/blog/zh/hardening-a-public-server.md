---
title: "VPS 加固：我在全新 Linux 服务器上真正会跑的清单"
description: "一份可直接复制的 Linux 服务器安全清单：从建非 root 管理员用户开始，做 SSH 加固、默认拒绝的防火墙、fail2ban、自动安全更新、sysctl 与时间基础、nginx 加固响应头、日志轮转，以及经过验证的异机备份。文末还列出不该做的事与失联后的恢复回滚办法。"
pubDate: 2026-10-16
lang: zh
translationKey: hardening-a-public-server
tags: [self-hosting, security, devops, systemd]
featured: false
keywords:
  - 服务器加固清单
  - Linux 服务器安全
  - SSH 加固
  - ufw fail2ban
  - 自动安全更新
---

VPS 一拿到公网 IP，就立刻开始被探测。不是一天，也不是一小时——机器刚起来几分钟内，第一批 SSH 暴力破解尝试通常就到了。所以**服务器加固（VPS hardening）**不是“以后再说”的任务，而是我在开通机器之后、安装任何重要东西之前做的第一件事。下面这份清单，就是我为了**保护一台 Linux 服务器**真正会按顺序跑一遍的东西，每条命令都能直接复制。

它刻意很“无聊”。没有冷门守护进程，没有内核补丁，也不买安全产品。只有四件能挡住绝大多数真实攻击的事情：SSH 不用密码、一个默认拒绝的**防火墙**、**fail2ban**、自动安全更新——再加上大多数人会跳过的基础运维卫生。如果你想看更完整的“如何把服务跑好”，我那篇[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)是配套文章；这一篇只讲怎么把门锁好。

## 速览版：清单

在一台新机器上从上往下跑一遍。在第 4 步于**新**会话里验证通过之前，不要关掉你当前这个 SSH 会话。

- [ ] **第 0 步 —— 创建一个带 sudo 的非 root 管理员用户。**
- [ ] **第 1 步 —— 为这个用户安装你的 SSH 公钥。**
- [ ] **第 2 步 —— 加固 sshd：仅密钥、禁 root 登录、非默认端口、`AllowUsers`。**
- [ ] **第 3 步 —— 先在第 2 个终端里验证新登录**，再动旧会话。
- [ ] **第 4 步 —— 开启默认拒绝的防火墙（ufw）**，只放行你需要的端口。
- [ ] **第 5 步 —— 加上 fail2ban**，覆盖 SSH 与任何暴露的 Web 登录。
- [ ] **第 6 步 —— 启用自动安全更新。**
- [ ] **第 7 步 —— 设置时间、时区和几个 sysctl 基础项。**
- [ ] **第 8 步 —— 加上 nginx／透传加固响应头。**
- [ ] **第 9 步 —— 配置日志轮转**，别让磁盘悄无声息地写满。
- [ ] **第 10 步 —— 配置好你已经真正恢复过一次的备份。**

下面把每一步展开讲。

## 第 0 步 —— 非 root 管理员用户与 sudo

永远不要以 root 身份交互式操作。Debian/Ubuntu 的基础镜像经常没有配好 sudo 组，所以显式做一遍。

```bash
# 以 root 身份，通过控制台或你最初的会话
adduser deploy                       # 设一个强口令
usermod -aG sudo deploy              # Debian/Ubuntu
# usermod -aG wheel deploy          # RHEL/Fedora 系

# 可选：给少量管理命令配置免密 sudo
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/sbin/ufw' \
  | tee /etc/sudoers.d/deploy-ops
chmod 440 /etc/sudoers.d/deploy-ops
```

用一个具名用户的意义在于可追责和更小的爆炸半径：除非你刻意索取，普通 shell 不会把 `/` 删掉。

## 第 1 步 —— 把 SSH 公钥放到机器上

在你**本地**机器上把公钥复制过去。趁密码登录还能用，现在就做。

```bash
ssh-copy-id -p 22 deploy@203.0.113.10
# 在禁用密码之前，先确认密钥可用
ssh -o PreferredAuthentications=publickey -p 22 deploy@203.0.113.10 'echo ok'
```

如果没有 `ssh-copy-id`，就手动追加：

```bash
cat ~/.ssh/id_ed25519.pub | \
  ssh root@203.0.113.10 "install -d -m700 -o deploy -g deploy /home/deploy/.ssh && \
    tee -a /home/deploy/.ssh/authorized_keys && \
    chmod 600 /home/deploy/.ssh/authorized_keys"
```

## 第 2 步 —— SSH 加固

这是整份清单里性价比最高的一项。打开 `/etc/ssh/sshd_config.d/99-hardening.conf`（用 drop-in 文件，好过直接改那个大配置文件），写入：

```ini
Port 49222
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
PermitEmptyPasswords no
AllowUsers deploy
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
```

几点说明，因为默认值会骗人：

- **非默认端口**只是减少噪音，挡不住真正的攻击者。值得做，是因为它能把日志里 99% 的蠢机器人流量清掉，但绝不能把它当成安全本身。参见[不该做的事](#不该做的事)。
- `AllowUsers deploy` 意味着即使 root 登录被配错了，也只有那个账号能认证。
- 保留 `PermitRootLogin no`，不要改成 `prohibit-password`，除非你有明确理由。

重启**之前**先校验语法，否则你可能把自己锁在外面：

```bash
sudo sshd -t && sudo systemctl restart ssh
```

Debian 上单元名是 `ssh`，RHEL 上是 `sshd`。先确认你的发行版。

## 第 3 步 —— 关掉旧会话之前，先验证新登录

这一步最常被跳过，也正是它把一次加固操作变成一台失联的服务器。另开一个**新**终端，同时测试端口和密钥路径：

```bash
ssh -p 49222 deploy@203.0.113.10 'whoami && hostname'
# 预期：deploy / 你的主机名
```

只有这条命令成功了，才去关掉最开始那个会话。如果失败，你手里还有一个可用的会话能改回配置。

## 第 4 步 —— 防火墙：默认拒绝，显式放行

我用 `ufw`，因为它可读，而且默认行为是正确的。关键规则是**拒绝入站、允许出站**，然后只为你真正要提供的服务开洞。

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 49222/tcp comment 'ssh'
sudo ufw allow 80/tcp  comment 'http'
sudo ufw allow 443/tcp comment 'https'
sudo ufw enable
sudo ufw status verbose
```

如果你用 **Docker**，现在就得知道：发布容器端口会写入它自己的 iptables 规则，可能绕过 ufw。要么在 compose 文件里把端口绑到 `127.0.0.1` 再用反向代理暴露，要么接受“ufw 并非全部”这个事实。我这套 [nginx 入口方案](/zh/posts/self-hosting-without-docker/)正是因此让服务端口只监听回环。

## 第 5 步 —— fail2ban

防火墙决定*哪些端口*可达，`fail2ban` 则盯着日志，把持续猜密码的 IP 封掉。两者合起来，才是“可达”和“难以攻击”的区别。

```bash
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.local >/dev/null <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = 49222
EOF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

给任何带登录表单的东西都加上 jail——nginx basic-auth、WordPress、Nextcloud——这样单个服务就不会被慢慢爆破。

## 第 6 步 —— 自动安全更新

现实世界里大多数入侵，都是某个没人打补丁的包上的已知 CVE。把无聊的部分自动化：安全补丁自己应用，但我从不允许它在我白天工作时偷偷重启服务。

```bash
sudo apt install -y unattended-upgrades
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Debian/Ubuntu：只更新 security 源，不做意外重启
sudo tee /etc/apt/apt.conf.d/51myunattended-upgrades >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
sudo unattended-upgrade --dry-run -d | tail -n 5
```

如果你会更新内核，就按自己的节奏重启，并留意 `/var/run/reboot-required`。

## 第 7 步 —— 时间、时区与 sysctl 基础

很无聊，但时间不对会搞坏 TLS、日志和备份。设一次就好。

```bash
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true
timedatectl status
```

几个值得加的 sysctl 开关（写到 `/etc/sysctl.d/99-hardening.conf`）：

```ini
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.tcp_syncookies = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.dmesg_restrict = 1
```

```bash
sudo sysctl --system
```

## 第 8 步 —— nginx／透传加固响应头

如果 nginx 是你的入口，给每个 server 加一小段响应头。它们替代不了应用层的安全，但能砍掉一整类浏览器侧问题——而且如果你前面还有一层代理，要一致地透传这些头。

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# 不要泄露版本号
server_tokens off;
```

reload 之前先测试：

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://example.com | grep -Ei 'strict-transport|x-frame|x-content'
```

## 第 9 步 —— 日志轮转

没轮转的日志，是一台健康机器在半年内把磁盘写满的最常见方式。`logrotate` 一般都有，关键是真正给你的输出设上限。

```ini
# /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

```bash
sudo logrotate -d /etc/logrotate.d/myapp   # 空跑
sudo journalctl --disk-usage
# 顺便给 journal 也设上限
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

## 第 10 步 —— 备份（以及验证过的恢复）

一台你恢复不了的加固服务器，仍然是失败的服务器。备份，是让其余每一步都变得可挽救的那一步。

```bash
# 一个最小但诚实的例子：加密、异地、带版本
tar -C / -czf - etc/opt/services 2>/dev/null \
  | age -r "$RECIPIENT" \
  | rclone rcat backup-remote:host1/$(date +%F).tar.gz.age

# 相信它之前，先确认归档可读
rclone cat backup-remote:host1/$(date +%F).tar.gz.age | age -d -i key.txt | tar -tz | head
```

不管选什么工具——restic、borg、纯 tar——规则都一样：备份要落到一台**不是这台机器**的地方，而且你至少真正恢复过一次。可以看看这个博客自己的[构建与部署流水线](/zh/posts/how-this-blog-ships-itself/)是怎么对待可复现性的；备份值得同样认真。

## 不该做的事

- **只靠隐蔽性。** 改了 SSH 端口就说搞定了，那不是加固。攻击者扫描所有端口；你只是躲开了懒人。
- **因为“只是台小机器”就跳过备份。** 小机器恰恰常常存着某样东西的唯一副本。
- **验证新登录之前就关掉旧 SSH 会话。** 这是把远程访问搞挂的最常见方式。新开终端，验证，*然后*再关。
- **放行 SSH 端口之前就先开防火墙。** 一样的道理。先放行，再启用。
- **无视 Docker 发布端口绕过 `ufw`。** 一个已发布的容器端口，可能完全不受防火墙规则约束地对外可达。
- **白天自动重启。** 补丁自动化；重启要刻意安排。

## 恢复与回滚

只要你把加固拆成一个个经过验证的小步骤，它就是可逆的。把逃生口一直留着：

- **保留一个可用会话**（或服务商的控制台/VNC），直到新配置被证明可用。它就是你的回滚。
- **改配置前先备份** —— `sudo cp /etc/ssh/sshd_config.d/99-hardening.conf{,.bak}`。
- **准备串口控制台。** 每个正经服务商都提供，要在你需要它*之前*确认它可用。
- **让回滚足够便宜：** 某个步骤把你锁在外面时，修复应该是“还原一个文件、重启一个服务”，而不是“重装系统”。

做一次，写成脚本，之后每台新机器就只要二十分钟，而不是一个提心吊胆的晚上。

## 常见问题

**真的需要非默认 SSH 端口吗？** 不需要，但它能大幅减少日志噪音。真正的防护是仅密钥认证；端口只是顺手的好处。

**ufw 还是直接用 nftables？** 先用 ufw，为的是清晰。当你需要集合、限速或 NAT，而 ufw 又无法干净表达时，再降到 nftables。

**既然 SSH 只用密钥了，fail2ban 还有意义吗？** 有。它仍会封掉行为不端的扫描器，并保护你暴露的任何 Web 登录——那通常才是更弱的攻击面。

**多久检查一次 reboot-required？** 每次自动升级跑完之后看一眼。对一台小机器来说，每周瞄一次 `/var/run/reboot-required` 就够了。
