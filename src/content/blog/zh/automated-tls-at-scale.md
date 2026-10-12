---
title: "为大量子域做自动化 TLS：ACME、HTTP-01 与 DNS-01，以及我真正在跑的方案"
description: "我为几十个子域做自动化 TLS 的完整实践：ACME 流程、HTTP-01 与 DNS-01 挑战的真实取舍、用 DNS-01 签发通配符证书并安全保存凭据、续期钩子、systemd 定时器与监控、速率限制，以及那些真正会出问题的故障模式。"
pubDate: 2026-10-25
lang: zh
translationKey: automated-tls-at-scale
tags: [self-hosting, nginx, devops, security]
featured: false
keywords:
  - 自动化 TLS
  - ACME DNS-01
  - 通配符证书
  - certbot
  - 续期钩子
---

一个域名一张证书：跑一次 certbot，回答几个提示，然后忘掉它。这套做法能撑到你有三十个子域、跨五个服务、还为了随手新建的名字留了一张通配符证书，并且续期必须在你不盯着的时候也照常工作时为止。到那一步，问题就不再是“拿到一张证书”，而是“让每一张证书都按时有效，而且全程不用人插手”。下面就是我用 **ACME** 做**自动化 TLS** 的做法：为什么我选 **DNS-01 挑战**而不是 HTTP-01，我怎么让**通配符证书**和它的 DNS 凭据不至于成为最薄弱的一环，以及它坏掉时我是怎么发现的。这里假设入口是 nginx——也就是我那篇[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)里的架构，跑在一台按[公网服务器清单](/zh/posts/hardening-a-public-server/)加固过的机器上。

## 为什么手动证书在规模化后必然失效

手动签发对一两个名字完全没问题。Let's Encrypt 证书有效期 90 天，在这个量级下，你一年手动续几次，什么都不会出错。但一旦变成五个 vhost 上的三十个名字，再加上 staging、再加几个只在内网的名字，算术就变了：每张证书每年大约续四次，乘以证书数量，每一次都是一个“忘记”的机会。

失败从来不是密码学层面的，而是运维层面的：

- 没人记得去年那张证书上都包含哪些 SAN。
- 某个名字加进了 nginx，却忘了加进续期命令。
- 某次续期在调试时被“临时”停用，然后再也没被启用。
- 原来负责续期的那台机器被重装了，cron 条目没跟着走。

唯一可持续的答案，是一套知道全部清单、无需人工就能证明域名控制权、并且在失败时会喊出来的自动化。

## 一屏看懂 ACME 流程

ACME（RFC 8555）是 Let's Encrypt 使用的协议，也是你的客户端在背后做的事情：

1. **账户（Account）** —— 客户端生成账户密钥，向 CA 注册。
2. **订单（Order）** —— 它为一组指定的名字申请证书。
3. **挑战（Challenges）** —— CA 为每个名字返回一个挑战（`http-01`、`dns-01` 或 `tls-alpn-01`）。
4. **应答（Fulfill）** —— 客户端证明自己对每个名字的控制权。
5. **验证（Validate）** —— CA 检查这份证明。
6. **完成（Finalize）** —— 客户端提交 CSR，CA 签发，客户端下载证书与证书链。

第 1 步之后的一切都可以脚本化，这正是重点：如果你的 ACME 流程里还有需要人操作的环节，那个环节就是 bug。大多数客户端还会在本地保存状态，而这份状态顺带就是你的清单：

```ini
# /etc/letsencrypt/renewal/blog.example.com.conf —— 清单，就躺在一个文件里
[renewalparams]
account = a1b2c3d4e5f6
authenticator = dns-cloudflare
dns_cloudflare_credentials = /etc/letsencrypt/cloudflare.ini
server = https://acme-v02.api.letsencrypt.org/directory
[[webroot_map]]
```

`certbot certificates` 会以人类可读的形式打印同一份列表。不过真正的权威清单还是要放在配置管理里，因为客户端配置是很糟糕的信息源。

## HTTP-01 与 DNS-01 挑战：真正的取舍

你选的挑战类型，决定了后面所有事情。

**HTTP-01** 让 CA 去抓取 `http://<name>/.well-known/acme-challenge/<token>`。这要求该名字的 80 端口从公网可达，所以每个名字都得既有 DNS，又能路由到那台应答的机器。它无法签发通配符。好处是：不需要保存任何密钥。

**DNS-01** 则由客户端写一条 `_acme-challenge.<name>` 的 TXT 记录，CA 去查 DNS。完全不需要入站端口。它能工作在 NAT 后面、只监听 443 的主机上、没有公网 IP 的机器上，以及只能内网访问的名字上。它也是唯一能签发通配符的方法。代价很实在：你得交给客户端一份能改你 DNS 的 API 凭据。

| | HTTP-01 | DNS-01 |
|---|---|---|
| 需要入站 80 端口 | 是 | 否 |
| 通配符证书 | 否 | 是 |
| 需要保存的密钥 | 无 | DNS 服务商 API token |
| 失败面 | 防火墙、代理、CDN、重定向 | 传播延迟、TTL、服务商 API、写错 zone |
| 仅内网的名字 | 否 | 是 |
| 续期耗时 | 秒级 | 数秒到数分钟 |

我的经验法则：如果只有一台公网 Web 服务器、nginx 本来就在 80 端口应答，就用 HTTP-01；如果你需要通配符、80 端口被关掉，或者名字根本不指向这台机器，就用 DNS-01。注意 HTTP-01 是允许重定向到 HTTPS 的——CA 会跟着跳转。它不能容忍的，是把 80 端口完全挡在防火墙外，或者 CDN 拦掉了挑战路径。

## 用 DNS-01 签发通配符证书（以及风险在哪里）

通配符 `*.example.com` 覆盖 `api.example.com`，但**不**覆盖 `example.com` 本身，也不覆盖 `a.b.example.com`。所以我通常申请的证书是 `example.com` 加上 `*.example.com`：主域名加一层标签，装进同一个文件。

有两点后果很关键：

- **爆炸半径。** 一张证书意味着所有子域共用一把私钥。这把钥匙泄露，通配符背后的所有东西一起泄露。
- **分发。** 每个为该子域终止 TLS 的主机都需要同一份密钥材料，而你的部署钩子每续期一次就要再拷一遍。这就是更多可能泄露的地方。

所以通配符是一种便利，而不是默认选择。如果只有几个名字、都在同一台机器上，一张显式列出名字的 SAN 证书往往更安全。这个取舍要有意识地做。

## 把 DNS-01 凭据安全地放好

能创建 `_acme-challenge` 记录的 token，同样也能改你的邮件指向、接管整个 zone，甚至签发你根本没申请的证书。把它当作生产环境密钥对待：

- **限定范围。** 用一个只对那一个 zone 有 DNS 编辑权限的 token，而不是账号级的密钥，更不要用注册商的全局 API key。
- **每个 zone 一份凭据**，这样单次泄露不会把全部拖下水。
- **文件权限。** 属主为 root，权限 `0600`，放在版本控制之外。
- **优先用 systemd 凭据**（`LoadCredential=`），而不是磁盘上的明文文件；这样密钥只对那一个单元可见。
- **轮换与吊销。** 一旦有怀疑、或者密钥经手过别处，就换掉。
- **考虑 CNAME 委派**给 `acme-dns` 这类专用服务，让 ACME 客户端手里的凭据只能操作恰好一条 `_acme-challenge` 记录，别的都做不了。

```bash
# /etc/letsencrypt/cloudflare.ini —— 属主 root，0600，永不入库
sudo install -m 600 -o root -g root /dev/null /etc/letsencrypt/cloudflare.ini
sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<'EOF'
# Token 仅限 example.com 这一个 zone 的 Zone:DNS:Edit 权限
dns_cloudflare_api_token = 0123456789abcdef_CHANGEME
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
```

## 续期：钩子、systemd 定时器，以及为什么“设好就忘”还需要监控

续期其实是两个问题。第一个是拿到新证书，客户端自己搞定。第二个是让正在运行的服务用上它。nginx 只在加载时读取证书，所以磁盘上换了新文件、不 reload 就等于没换。邮件和代理守护进程可能把证书钉在内存里，需要各自 reload。

certbot 自带每天两次的 systemd 定时器，而部署钩子只在续期**成功**后运行——不是每次尝试都跑：

```bash
#!/usr/bin/env bash
# /etc/letsencrypt/renewal-hooks/deploy/reload-tls.sh  →  chmod +x
set -euo pipefail
# certbot 会为钩子导出 RENEWED_LINEAGE 和 RENEWED_DOMAINS
test -n "${RENEWED_LINEAGE:-}" || exit 0
nginx -t
systemctl reload nginx
for unit in haproxy.service dovecot.service; do
  if systemctl is-active --quiet "$unit"; then systemctl reload "$unit"; fi
done
logger -t tls-deploy "renewed ${RENEWED_DOMAINS:-unknown}"
```

`lego` 做的是同一件事。v5 里这个参数叫 `--deploy-hook`；更早的版本叫 `--run-hook` / `--renew-hook`：

```bash
lego --path /etc/lego --email ops@example.com --dns cloudflare \
  -d example.com -d '*.example.com' --accept-tos \
  --deploy-hook /usr/local/bin/reload-tls.sh run
```

如果你的客户端没有自带定时器，就自己加一个。随机抖动很重要：整个机群都在 `03:00:00` 准点续期，会一起冲垮 CA 并撞上速率限制。

```ini
# /etc/systemd/system/tls-renew.service
[Unit]
Description=Renew TLS certificates
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/lego --path /etc/lego --email ops@example.com \
  --dns cloudflare -d example.com -d '*.example.com' --accept-tos \
  --deploy-hook /usr/local/bin/reload-tls.sh run
```

```ini
# /etc/systemd/system/tls-renew.timer
[Unit]
Description=Twice-daily TLS renewal check

[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

所有人都跳过的那部分，是监控。因为自动续期是**静默**失败的：API token 被轮换了、DNS 服务商换了、磁盘满了，服务会一直拿着昨天的证书继续跑，直到某个早上突然不行了。一次每月的 `certbot renew --dry-run`，再加一个不信任客户端的外部检查：

```bash
#!/usr/bin/env bash
# check-cert-expiry.sh <hostname> —— 进入预警窗口就报警
set -euo pipefail
name="$1"; warn_days=14
not_after=$(openssl s_client -connect "$name:443" -servername "$name" </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)
end=$(date -d "$not_after" +%s); now=$(date +%s)
days=$(( (end - now) / 86400 ))
if [ "$days" -lt "$warn_days" ]; then
  echo "TLS WARNING: $name expires in ${days}d ($not_after)"
  exit 1
fi
echo "ok: $name has ${days}d left"
```

要从**另一台**机器或另一个地域去跑它，并且指向你提供的每一个主机名——不只是证书的主名字。本机上的客户端永远觉得一切正常。

## 速率限制：规模化之后真正会咬人的东西

Let's Encrypt 的限制在你不循环测试时其实很宽松。真正会碰到的几条：

- **每个注册域名每 7 天 50 张新证书**（全局，所有账号合计）。
- **完全相同的一组标识符每 7 天 5 张** —— 你重装客户端、或者每次部署都删掉 `/etc/letsencrypt` 时撞上的就是它。
- **每个账号每 3 小时 300 个新订单。**
- **每个标识符每小时 5 次失败授权。**

复用同一组名字的续期会被从宽处理，而支持 ACME Renewal Information（ARI）的客户端完全不受签发限制约束。实用规则：测试用 staging、把多个 SAN 合并成更少的证书而不是一个名字一张、把客户端状态留在磁盘上、用一张通配符顶掉四十张独立证书。犯错之后想审计，用 `crt.sh` 看看你的域名已经签发过什么。

## 我真正踩过的故障模式

- **证书过期。** 续期单元已经连续失败好几周。部署钩子里的 reload 一切正常——只是根本没有新东西可部署。监控本可以在一天内发现，其他任何手段都没发现。
- **`server_name` 写错 / 默认服务器。** 当 SNI 匹配不到任何 `server_name` 时，nginx 会返回**第一个** server 块，于是浏览器拿到的是那个名字的错误证书。加一个返回 `444` 的兜底 `server`，让配错的名字明显失败，而不是悄悄发出别人的证书。
- **证书链问题。** 让 nginx 指向叶子证书而不是 `fullchain.pem`，会搞坏老 Android 和一些 `curl`。要用完整链；当 CA 提供的证书链的根在某些老客户端里不存在时，用 `--preferred-chain`。
- **HSTS 是放大器。** 带着 `includeSubDomains`，某个子域上一张坏证书就会变成用户点不掉的报错，而且你再也无法退回 HTTP。只有在所有子域都覆盖之后才开 `includeSubDomains`，`preload` 更是要先用一段时间再说。
- **时钟偏移。** 时间不对会让验证莫名其妙地失败。跑着 `systemd-timesyncd`，并用 `timedatectl` 检查。

```bash
curl -sSI https://blog.awin-x.top | head -1
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null \
  | openssl x509 -noout -subject -issuer -dates
sudo nginx -T | grep -nE 'server_name|ssl_certificate'
```

## 我真正在跑的方案：端到端的自动化 TLS

具体到技术栈：一个 `lego` 二进制，通过服务商插件走 DNS-01，每个 zone 一张证书同时覆盖 `example.com` 和 `*.example.com`，凭据用 `LoadCredential` 投递，一个部署钩子负责校验并 reload nginx，每天两次带抖动的定时器，再加一个 14 天阈值的外部过期检查——在用户看到警告之前就先提醒我。

```bash
#!/usr/bin/env bash
# /usr/local/bin/lego-issue.sh —— tls-renew.service 的 ExecStart
set -euo pipefail
# token 来自单元的 LoadCredential，而不是磁盘
export CLOUDFLARE_DNS_API_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/cf")"
exec /usr/bin/lego --path /etc/lego --email ops@example.com \
  --dns cloudflare --domains example.com --domains '*.example.com' \
  --accept-tos --deploy-hook /usr/local/bin/reload-tls.sh run
```

这些一点都不冷门。回报是：加第四十一个子域只需要一条 DNS 记录，别的什么都不用——不用申请证书，不用提工单，不用在日历上记提醒。自动化 TLS 本该就是这种手感。如果你还没把机器锁好，先从[加固清单](/zh/posts/hardening-a-public-server/)开始；一张证书的可信度，不会超过保管那把钥匙的服务器。
