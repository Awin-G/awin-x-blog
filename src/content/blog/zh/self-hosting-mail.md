---
title: "自托管邮件：一份诚实的送达率指南"
description: "为什么发信是自托管里最难的一件事——信誉、IP 预热、黑名单——而收信相比之下简单得多。技术上的必备项（PTR、SPF、DKIM、DMARC、MTA-STS），运维上的真实情况（25 端口被封、退信、备用 MX），一套务实的 Postfix + Dovecot 方案，以及那个直白的结论：收信自己来，发信走中继。"
pubDate: 2026-10-29
lang: zh
translationKey: self-hosting-mail
tags: [self-hosting, security, linux]
featured: false
keywords:
  - 自托管邮件
  - 邮件送达率
  - SPF DKIM DMARC
  - 邮件服务器
  - PTR 记录
---

总有人问我该不该**自托管邮件**，而我的答案这些年从没变过：收信自己来，发信交给别人。
这不是敷衍，而是把整篇文章压缩成一句话——因为自托管邮件这件事，可以干净地劈成几乎
毫无共同点的两半。一半是技术问题，你一个周末就能解决；另一半是信誉问题，你根本解决
不了，只能租。这就是我这份诚实的**邮件送达率**指南，没有「照着这十二步做 Gmail 就会
爱上你」的童话。

我为自己域名跑着一台真正的**邮件服务器**——IMAP、投递（submission）、webmail，归档全在
我自己磁盘上。我在[2026 年我自托管了什么](/zh/posts/what-i-self-host-2026/)里简单提过
它，而那里的判断我依然坚持：它是我机器上最重、最脆弱的东西。下面详细讲讲为什么。

## 为什么发信是难的那一半（收信相比之下很简单）

收信是真的简单。把 MX 记录指向你的主机名，跑一个在 25 端口讲 SMTP 的服务，就完事了。
没有信誉要攒，没有 IP 要预热，没有黑名单要怕。从来没人因为「收」邮件被拉黑。邮件到了
你就过滤，没到那是发件人的问题，不是你的。整个收信侧就是「开着一个端口收连接」。

发信正好相反。你发信，是在请求一个陌生人的邮件服务器信任你，而信任不是配置文件。三件
事决定你的命运：

- **信誉。** Gmail、Microsoft、Yahoo 会用你看不到、也不会公开的信号，给你发信 IP 和域名
  打分。你只能靠发信去试探，而反馈是二元的：进收件箱、进垃圾箱，或者被静默丢弃。
- **IP 预热。** 一台全新的 VPS IP 没有任何历史。第一天就砸 5000 封，看起来跟垃圾邮件
  发送者一模一样。预热就是慢慢爬坡——先几十封，再几百封，持续几周——同时盯着投诉。
- **黑名单。** Spamhaus、Barracuda、SORBS 之流。一旦被列入，送达率直接崩，直到被移除；
  而重新被列入可能出于你完全无法控制的原因：你服务商网段里某个被攻陷的邻居，会把整段
  地址都拖下水。

最糟的失败模式是静默丢弃。退信至少告诉你哪里坏了；进了垃圾箱好歹还能捞回来；而一封消失在
大厂虚空里的邮件是完全隐形的——你不知道它发生了，收件人也不知道。

你能用的工具其实很少。Google Postmaster Tools 只有在 Google 认为你的体量大到值得报告
之后，才会显示某个域名的信誉——对一台机器的配置来说，这个门槛本身就挺可笑。你能做的最好的
事就是「种子列表」：往自己在 Gmail、Outlook、Yahoo 上的测试账号各发一封，看各自落在哪。
这又慢又手动，而且永远只是抽样。没有一条 `systemctl status` 能告诉你「我进收件箱了吗」。

## 任何邮件服务器都必须具备的技术项

下面这些 DNS 和 TLS 配置不是可有可无的装饰。少做任何一项，你都是在打上一场仗。如果你
跑任何公网服务，这些还得建立在和[加固公网服务器](/zh/posts/hardening-a-public-server/)
同样的卫生习惯之上——SMTP 端口是被人不断扫描的。

### PTR 记录（反向 DNS），以及正确的 EHLO

你发信 IP 的 **PTR 记录**必须解析到你 MTA 在 EHLO 问候里声明的那个准确主机名。这就构成了
正向确认的反向 DNS（FCrDNS），几乎所有大型收件方都会检查。PTR 通常不能在自己的 zone 里
设——它归 IP 的持有者管，所以你在 VPS 服务商的控制面板里设。如果 PTR 是
`host-1-2-3-4.provider.net`，而你 EHLO 报的是 `mail.example.com`，这一项就不通过，你会被
拒绝或被降分。

```ini
# /etc/postfix/main.cf —— 这些名字必须和你的 PTR 对得上
myhostname = mail.example.com
myorigin   = mail.example.com
mydestination = $myhostname, localhost.$mydomain, localhost
```

### SPF：谁被允许以你的域名发信

SPF 是一条 TXT 记录，列出被允许代表你域名发信的主机。

```dns
; SPF —— 只有你的主机和中继可以发。硬失败，中继只占一次查询。
example.com.        TXT  "v=spf1 mx a:mail.example.com include:relay.example.net -all"
```

`-all` 表示「其余一律拒绝」（硬失败）。测试阶段拿不准就用 `~all`。记录要保持不超过 10 次
DNS 查询，否则收件方会把它当成永久错误。

### DKIM：密码学签名

DKIM 用私钥给每封邮件签名，公钥放在 DNS 里，收件方据此验证邮件未被篡改、且确实来自你的
域名。

```dns
; DKIM —— 选择器 "sel"（2026），公钥以 TXT 记录发布
sel._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...IDAQAB"
```

用你的 MTA（OpenDKIM、Rspamd，或者你的中继替你处理）生成密钥对，只发布公钥，轮换选择器
而不是原地改。

### DMARC：前两项失败时，收件方该怎么办

DMARC 把 SPF 和 DKIM 与用户可见的 `From:` 头绑定起来，告诉收件方如何处理失败——并给你
报告。

```dns
; DMARC —— 先用 p=none 收集数据，干净了再收紧到 reject。
_dmarc.example.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; ruf=mailto:dmarc@example.com; fo=1; adkim=s; aspf=s; pct=100"
```

先用 `p=none`，读几周 `rua` 报告，把正常却失败的来源修好，再切到 `p=quarantine`，最后
`p=reject`。

### MTA-STS 和 TLS-RPT：强制传输加密

**MTA-STS** 告诉发件方「到我这儿必须用 TLS，并且校验我的证书」，背后靠一个通过 HTTPS
提供的策略支撑。TLS-RPT 会在加密失败时给你发报告。

```dns
; MTA-STS 策略指针 + TLS 报告
_mta-sts.example.com.   TXT  "v=STSv1; id=20261029000000Z"
_smtp._tls.example.com. TXT  "v=TLSRPTv1; rua=mailto:tlsrpt@example.com"
; 同时这个文件必须能在 https://mta-sts.example.com/.well-known/mta-sts.txt 访问到
```

```text
# https://mta-sts.example.com/.well-known/mta-sts.txt
version: STSv1
mode: enforce
mx: mail.example.com
max_age: 604800
```

### 25 端口：在承诺任何事之前先测它

很多 VPS 服务商为了反垃圾，默认封掉出站的 **25 端口**，几乎所有的住宅宽带 ISP 也这么做。
动手之前先测：

```bash
# 这台机器到底能不能在 25 端口上和外界对话？
nc -vz gmail-smtp-in.l.google.com 25
# 如果卡住或被拒绝，你就没法直接发信 —— 去开工单申请，或者改用中继。
```

## 没人会在你踩坑之前告诉你的运维现实

- **退信处理。** 你必须接收退信（空发件人 `<>`）并处理 DSN。不理它，你的收件人列表会烂成
  一门垃圾邮件炮。在 SMTP 阶段直接拒绝，你就会产生回退信（backscatter）。要在接收之后
  过滤，然后把退信排队处理。
- **速率限制。** 大厂按发送量和连接数限流。「发十封能通」完全说明不了发一万封会怎样。
- **备用 MX。** 用更高优先级数字的二级 MX，能在主站宕机时兜住邮件——但它会变成垃圾邮件和
  误投的入口，而且发件人本来就会重试好几天。诚实的答案往往是：干脆不要备用 MX。
- **入站垃圾过滤。** 真正的工作量在这里：Rspamd 或 SpamAssassin、灰名单（greylisting）、
  DNSBL 查询、ClamAV。这是一个永不停歇的移动靶。
- **日志与告警。** 凌晨三点邮队列堵满，然后一直堵到你发现为止——邮件就是这么悄悄死掉的。
  盯队列长度，而不是只盯「Postfix 还活着吗」。

这些单拎出来都不难。问题在于邮件对「只做了一半」零容忍：所有东西必须同时正确，否则你就会
以悄悄丢信的方式，学到自己漏了哪一块。

## 一套务实的方案：Postfix + Dovecot，或者只发不收

如果你想要一个真正的邮箱，那条无聊但文档齐全的组合就是：SMTP 用 **Postfix**，IMAP 和
投递用 **Dovecot**。

```ini
# /etc/postfix/main.cf —— 直接收信，但所有外发走中继
relayhost = [smtp.relay.example.net]:587
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_tls_security_level = encrypt
# 入站 TLS
smtpd_tls_security_level = may
smtpd_tls_cert_file = /etc/letsencrypt/live/mail.example.com/fullchain.pem
smtpd_tls_key_file  = /etc/letsencrypt/live/mail.example.com/privkey.pem
```

如果你只需要**发信**——告警、密码重置、收据——那就根本别跑邮件服务器。跑一个只发的代理
（`msmtp`、`dma`）指向 smarthost，或者更好：直接调服务商的 API（SES、Postmark、Mailgun、
Resend）。没有入站 25 端口，没有邮箱，没有要维护的信誉。

## 那个决定：收信自己来，发信走中继

下面是我会甩给朋友的直白表格。

| 任务 | 自己跑？ | 为什么 |
| --- | --- | --- |
| 入站（MX、IMAP、webmail） | 喜欢就跑 | 风险低，数据在你这，不需要信誉 |
| 入站垃圾过滤 | 可以，但要留出时间 | 永不停止的移动靶 |
| 个人邮箱外发 | 只发最小量，且走中继 | 你没有多余的信誉可挥霍 |
| 事务性 / 批量外发 | 不要 | 用靠谱的中继，让它们去承担信誉 |
| 送达率排障 | 不要 | 你没法调试一个自己看不见的系统 |

只自托管**收信**那一半才是最舒服的位置：归档和别名留在自己磁盘上，收件箱能用，而且你
永远不必向陌生人解释为什么你的邮件进了垃圾箱。发信走你付费的中继，把 SPF、DKIM、DMARC
配好，好让中继能替你签名，信誉就交给别人去当全职工作。

如果你跑公网服务还比较新，把这篇和[自托管清单](/zh/posts/what-i-self-host-2026/)一起看，
并且[先把机器加固好](/zh/posts/hardening-a-public-server/)。然后再诚实地问自己：你到底
愿意为一个邮队列搭进去多少个周末。
