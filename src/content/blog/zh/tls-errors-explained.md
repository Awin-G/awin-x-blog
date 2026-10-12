---
title: "TLS 证书错误全解：每一种报错的原因、诊断命令与修法"
description: "一份实战版 TLS 证书错误指南：证书链不完整、SNI 缺失、证书过期、主机名不匹配、自签名证书、时钟偏移、协议/加密套件不匹配、Let's Encrypt 速率限制，以及 HSTS——每种都给出原因、能验证它的 openssl s_client 命令，以及具体的修法。"
pubDate: 2026-11-05
lang: zh
translationKey: tls-errors-explained
tags: [security, networking, self-hosting]
featured: false
keywords:
  - TLS 证书错误
  - openssl s_client
  - 证书链
  - SNI
  - HSTS
---

我最近几年查过的每一个 **TLS 证书错误**，最后都落在十来种原因里，而且几乎全都能靠在你笔记本上跑一条 **`openssl s_client`** 看出来。诀窍只是知道该读输出的哪一段：**证书链**断裂和 **SNI** 名字缺失在握手里长得完全不一样，可浏览器却把它们统统压成同一句没用的“你的连接不是私密连接”。这就是我当时最想要的那份指南——大家真正会撞上的报错、原因、能证明它的命令，以及修法。如果你连签发都还没搭起来，先看我的[自动化 TLS](/zh/posts/automated-tls-at-scale/) 方案；这篇讲的是它坏掉之后怎么办。

## TLS 证书错误是一次诊断，不是什么玄学

浏览器是个糟糕的调试器。它把过期证书、缺失的中间证书、错误的主机名、不受信任的签发者，全揉进同一个红色页面。别信它给出的结论。到命令行里复现故障——真正的 TLS 告警和引发它的那张证书都会被完整打印出来，十次里有九次你能在一分钟内叫出原因。

## 从 openssl s_client 开始

`openssl s_client` 会建立一条 TLS 连接，并打印协商出的协议与加密套件、完整的证书链以及验证结果。真正有用的四个参数：`-connect host:443`（连哪儿）、`-servername host`（发送 SNI）、`-showcerts`（打印整条链）、`-verify_return_error`（一旦验证失败就让握手失败，这样退出码才能用于脚本）。

```bash
# 每接一个 TLS 工单，我第一件事就是跑这条
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -showcerts -verify_return_error </dev/null 2>&1 | head -60

# curl -v 会补上客户端侧的主机名校验和验证结果
curl -vI https://blog.awin-x.top/ 2>&1 | sed -n '1,40p'
```

## `unable to get local issuer certificate` 与不完整的证书链

**症状。** `curl: (60) ... unable to get local issuer certificate`，可这张证书有效、没过期、也确实由正规 CA 签发——但只在 `curl` 里报错，或者在老旧 Android 上、在某个 Go 服务里报错。

**原因。** 服务器只发了叶子证书，没带任何中间证书。桌面浏览器会自己抓取或缓存缺失的中间证书来兜底，所以“Chrome 里是好的”什么都说明不了。

**验证。** `-showcerts` 能数出实际发来的证书数量。如果只有一张，那就是病根。

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -showcerts </dev/null 2>/dev/null | grep -c 'BEGIN CERTIFICATE'
```

**修法。** 让服务器指向**完整**证书链，而不是叶子证书——在 nginx 里，`ssl_certificate` 必须是 `fullchain.pem`，绝不能只用 `cert.pem`：

```nginx
ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;
```

然后 `nginx -t && systemctl reload nginx`，再跑一次上面的计数，这时应该是 2 或 3。

## SNI 写错或缺失：默认服务器的证书错配

**症状。** 名字连得上，但发回来的却是**另一个**域名的证书——通常是你第一个 vhost。或者用 IP 或内网健康检查去连时，拿到了错误的证书。

**原因。** **SNI**（RFC 6066）是客户端在握手完成**之前**告诉服务器它想要哪个主机名的方式。没有它，服务器无从选择证书，只能发默认 vhost 的那张。老客户端、按 IP 连接、以及任何匹配不到 `server_name` 的名字，都会撞上。

**验证。** 先带名字问一次，再故意不带名字问一次。

```bash
# 带 SNI：拿到 blog.awin-x.top 的证书
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
# 不带 SNI：你会拿到默认服务器的那张证书
openssl s_client -connect blog.awin-x.top:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject
```

**修法。** **测试**时永远带上 `-servername`（那是测试侧的修法，不是服务器侧的）。服务器侧要把错配变得可见：给每个真实名字配上 `server_name` 和匹配的证书，再加一个兜底块，直接拒绝未知名字，而不是泄漏默认证书。

```nginx
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/ssl/self-signed-default.crt;
    ssl_certificate_key /etc/ssl/self-signed-default.key;
    return 444;
}
```

## `certificate has expired`（证书过期）

**症状。** `curl: (60) ... certificate has expired`，或者一个你点不过去的警告页。它昨天还是好的。

**原因。** `notAfter` 已经过去了。这几乎从来不是“忘了手动续期”，而是自动续期已经**静默**失败了好几周，而那张 90 天的旧证书一直在被继续发送。

**验证。**

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
# 再到机器上查清楚续期为什么失败
sudo certbot renew --dry-run && sudo journalctl -u certbot.timer -n 50 --no-pager
```

**修法。** 先续上，再修掉它失效的**原因**：DNS API token 过期或被轮换、磁盘满、挑战路径改名、或者重装的机器上定时器没跟着装。我的[自动化 TLS](/zh/posts/automated-tls-at-scale/) 流程就是为了让它不进人工清单——但没有过期监控的自动化，只会失败得更晚、更响。

## 主机名不匹配、SAN 与通配符的覆盖范围

**症状。** `curl: (60) ... no alternative certificate subject name matches target host name`。证书有效、链也没问题——只是不是给**这个**名字的。

**原因。** 现代客户端忽略老旧的 `CN` 字段，只看 `subjectAltName`（SAN）列表。两个经典坑：一张给 `example.com` 的证书被拿去服务 `www.example.com`（主域名不覆盖子域）；以及通配符 `*.example.com` 恰好只匹配一层标签——它覆盖 `api.example.com`，但不覆盖 `a.b.example.com`，也不覆盖主域名本身。

**验证。**

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName
```

**修法。** 用精确的名字重新签发，把名字放进 SAN 列表——通常是一张证书同时写 `example.com` 和 `*.example.com`——并确认 `server_name` 对应到正确的 vhost。记住那一条“单层标签”规则，然后 reload。

## `self signed certificate`（自签名证书）

**症状。** `curl: (60) ... self signed certificate`（或“self signed certificate in certificate chain”）。

**原因。** 三种情况会给出同一句话：货真价实的自签名证书（内网服务、开发机、路由器管理页）；客户端不信任的私有 CA；或者企业中间盒在拦截 TLS。看签发者就能分辨。

```bash
openssl s_client -connect internal.example:443 -servername internal.example </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -fingerprint -sha256
```

**修法。** 如果那是你自己私有 CA 背后的服务，就把该 CA 根证书分发给客户端（`update-ca-certificates`，或 macOS 钥匙串），而不是教所有人用 `curl -k`。对任何能从公网访问的东西，**绝不要**靠关闭校验来消掉报错——那等于把锁变成装饰。如果签发者既不是你的、也不该出现，就当作可能被中间人拦截，停下来。

## 时钟偏移：没有任何证书有错的那种报错

**症状。** 每张证书看起来都过期或“尚未生效”，连你刚签发的也不例外。刚建的虚拟机和刚刷好固件的设备是惯犯。

**原因。** TLS 是拿**客户端**的时钟去验证的。时钟差了几分钟甚至几天，`notBefore`/`notAfter` 的比较就会失败，哪怕证书完美无缺。

```bash
timedatectl status        # 「System clock synchronized: yes」了吗？
date -u                   # 和可信来源对一下
```

**修法。** 跑一个时间守护进程（`systemd-timesyncd`，需要更严的同步就用 `chrony`），放行出站 NTP，并给定时器开 `Persistent=true`，好让挂起过的机器补上。注意 timesyncd 在启动时如果时钟差得太离谱会拒绝直接跳——而这恰恰是没有 RTC 的设备最需要它的时候，所以这类设备还是留一颗硬件 RTC 吧。

## TLS 版本与加密套件不匹配

**症状。** `error:0A000152:SSL routines::unsafe legacy renegotiation disabled`，或者连证书都还没发出来握手就突然失败，或者 `no protocols available`。

**原因。** 客户端和服务器协商不出协议或加密套件——通常是只讲旧 TLS 的客户端撞上现在要求 1.2+ 的服务器，或套件对不上。

```bash
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top -tls1 </dev/null
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top </dev/null 2>/dev/null \
  | grep -E 'Protocol|Cipher'
```

**修法。** 把服务器现代化，而不是降级：要求 TLS 1.2+（nginx 里写 `ssl_protocols TLSv1.2 TLSv1.3;`），让 TLS 1.3 自己挑套件。如果老的是**客户端**，那就升级或隔离它。

## Let's Encrypt 速率限制与 ACME 失败

**症状。** 签发失败并报 `urn:ietf:params:acme:error:rateLimited`、“too many failed authorizations”，或者挑战一直验证不过。

**原因。** 要么撞了限制（每个注册域名每 7 天 50 张新证书；完全相同的一组名字每 7 天 5 张；每个标识符每小时 5 次失败授权），要么是挑战本身失败——通常是 DNS-01 传播、写错 zone，或者 HTTP-01 路径被代理或 CDN 拦掉。

```bash
# 调试时绝不要拿生产环境猛敲；用 staging
sudo certbot renew --dry-run --server https://acme-staging-v02.api.letsencrypt.org/directory
# 审计你的域名已经签发过什么
curl -s 'https://crt.sh/?q=example.com&output=json' | head -c 500
```

**修法。** 先退避——每对失败的标识符重试一次，就会重置那每小时 5 次的失败计数。修好挑战本身（TTL/传播、正确的 zone、80 端口可达），到 staging 上测试，并优先用一张 DNS-01 通配符顶掉四十张证书。完整的[速率限制算术](/zh/posts/automated-tls-at-scale/)在另一篇里；一句话版本是：除非你一周内烧得起五次，否则**永远不要为了“从头来过”而删掉 `/etc/letsencrypt`**。

## HSTS：当一次 TLS 失误变成永久

**症状。** 用户完全打不开某个子域；根本没有“继续访问”按钮。修好证书也没用——对那些已经看过该策略的浏览器来说毫无帮助。

**原因。** **HSTS** 会让浏览器在固定的 max-age 内拒绝明文 HTTP、也拒绝为该主机放行证书例外。带上 `includeSubDomains`，主域名上的一条响应头就覆盖了**所有**子域——于是一张坏证书会让那个名字对所有访客彻底“砖掉”，直到 max-age 过期（若是 `preload`，则要等浏览器更新）。HSTS 把五分钟的失误变成一座纪念碑。

```bash
curl -sSI https://blog.awin-x.top/ | grep -i strict-transport-security
```

**修法。** 把 HSTS 当成一道单向门：先用很小的 `max-age`（比如 300），确认每个子域都有有效证书，再逐步拉长。只有在主域名下所有名字都被覆盖之后，才加 `includeSubDomains`；而 preload，至少要等策略稳定运行几个月再说。

## 预防清单

- **自动化续期。** 一个每天两次、带抖动的定时器，加一个负责 reload 服务的部署钩子——也就是[自动化 TLS](/zh/posts/automated-tls-at-scale/) 那套。手动续期就是一次写好了日期的未来故障。
- **从外部监控过期。** 一个从**另一台**机器发起的独立检查，在约 14 天前告警，让静默的续期失败在用户之前先浮出来。
- **从外部、带 SNI 测试。** 对每个公网名字，从机器之外跑 `openssl s_client -servername` 和 `curl -v`，而不是只在服务器本机上跑。
- **发送完整证书链。** 指向 `fullchain.pem`，并用 `-showcerts` 验证。
- **对 HSTS 保持克制。** 先小 max-age；只有所有名字都覆盖了才加 `includeSubDomains`；preload 要等数月稳定之后。
- **先把机器锁好。** 一张证书的可信度，不会超过保管那把钥匙的服务器——先从[公网服务器加固清单](/zh/posts/hardening-a-public-server/)开始。

这些错误没有一个是密码学谜题。它们都是配置、时间与自动化的问题——而且每一个都会在 `openssl s_client` 的头六十行里自报家门。读懂握手，叫出原因，改掉配置，然后确保这个修法不会悄悄烂掉。
