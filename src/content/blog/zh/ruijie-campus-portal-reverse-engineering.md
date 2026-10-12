---
title: "逆向锐捷 ePortal 认证门户：用 CAS 单点登录做无浏览器校园网自动登录"
description: "本文记录我如何靠观察逆向锐捷 ePortal 认证门户与 CAS 单点登录流程，绕过老接口 404 的坑，用纯 Python 标准库写出无浏览器的校园网自动登录守护进程，并作为 systemd 服务部署，在强制断线后约 16 秒内自动重连。"
pubDate: 2026-10-13
lang: zh
translationKey: ruijie-campus-portal-reverse-engineering
tags: [networking, reverse-engineering, python, security]
featured: false
keywords:
  - 校园网自动登录
  - 锐捷 ePortal
  - CAS 单点登录
  - 无浏览器认证
  - Python 守护进程
---

每个校园网最终都会甩给你一个网页，然后把这件事叫做「安全」。你打开浏览器，
被弹到认证门户，输入账号密码，最后落在一个写着「已上线」的页面上。这本来没什么，
直到那台真正需要上网的机器没有浏览器：路由器、无头机器、NAT 后面的构建机。
这时候登录页就不再是一道手续，而是一堵墙。

我们实验室的上行链路，由一套 **锐捷 ePortal** 认证门户认证，前面套着一层
**CAS 单点登录**流程。我想要的是**校园网自动登录**：不需要人、不需要浏览器、
不需要显示器——一个纯 Python 程序，把 Chromium 走的同一串请求重走一遍，
再用一个 systemd 单元把它养着。这篇文章讲的就是：如何靠观察做**逆向工程**，
把门户变成一个状态机；以及这套守护进程如何在一次强制断线后约 **16 秒**内重新上线。

## 那个所有人都在写的老接口，以及它为什么在这里 404

你在网上能找到的「校园网自动登录」脚本，绝大多数都冲着锐捷的经典接口去：
`/eportal/InterFace.do?method=login`。POST 几个表单字段，网关就放你过去。
确实有成熟项目整套都建立在这个契约上。

但在我们的网关上，这个接口返回 **404**。这是较新的锐捷 ESS 门户，真正的认证被
委托给一个集中认证服务，浏览器会被重定向着走完一轮 CAS 握手。门户页面甚至带着
`__PLATFORM_SSO__='cas-sso'` 这个标记。你怎么调那些老参数都没用，因为登录面根本
就不是同一个。

我先看了现有生态。像
[`lololowe/ruijie-auto-login`](https://github.com/lololowe/ruijie-auto-login)
这样的工具把老版三态状态机实现得很好，但它说的不是这种「方言」。
`Polnareff258/openwrt-campus-auth` 针对的是同一类「新版 Portal + CAS」形态，
在单点登录这个思路上是很有价值的参考，但它绑定某一所大学，而且是 OpenWrt/ash 写的。
没有现成能直接用的，于是我针对自己的网关重新把流程反推了一遍，再用 Python 标准库
（外加 `openssl` 命令行做 AES）重新实现。

## 靠观察做逆向工程

方法刻意做得很无聊：先让浏览器登录一次，抓下每一跳，然后用脚本重放，哪里断了修哪里。
真正关键的只有六跳。

1. **探测一个外部 URL。** 未认证时，BRAS 拦截这条 HTTP 请求，返回一小段脚本，
   把浏览器重定向到 ePortal —— 一个带客户端 IP 和接入控制器名字的 `index.jsp` 地址。
2. **跟进入口。** `GET /eportal/index.jsp?...` 会以 302 回答到
   `/portal/portal-main?...`，而查询串里带着全新的 `sessionId`、`userIp`、
   `nasIp`、`customPageId` 和终端信息。这个 `sessionId` 由 BRAS 每次认证即时生成，
   **不能复用**，所以程序每次都是先探测、再登录。
3. **取回 CAS 挑战。** `GET /cas-sso/login?flowSessionId=...` 返回登录页。有两个元素
   很重要：id 为 `login-page-flowkey` 的那个（CAS 的 execution 令牌），以及 id 为
   `login-croypto` 的那个（一段 base64 编码的 16 字节 AES 密钥，每次加载页面都重新生成）。
4. **提交凭据。** 表单 POST 到 `/cas-sso/login`，带上 `type=UsernamePassword`、
   `_eventId=submit`、`execution`、`croypto`、明文用户名，以及用那把密钥加密的密码
   ——**AES-128-ECB**，PKCS7 padding 之后再 base64。成功是一个指向认证成功页的 302；
   失败则返回带错误码的页面。
5. **走完工作流。** 单点登录成功未必就是终点。门户随后会要求客户端走完一个小工作流：
   `POST /eportal/workFlow/getCurrentNode` 返回当前节点路径，客户端据此 POST 到
   `/eportal/network/deviceAuthentication`，轮询
   `/eportal/network/deviceAuthResult`，在 `serviceSelection` 节点选择运营商服务
   （`ctcc`、`cmcc` 或 `unicom`），再调用 `/eportal/network/serviceLogin`。
6. **验证。** 重新探测那个外部 URL。如果拦截页消失了，我们就在线了。

这就是经典的黑盒逆向：不反编译、不对网关做模糊测试——只是读重定向链和表单体，
直到形态足够清晰，再把那个形态编码成数据。

## CAS 单点登录里真正要紧的细节

关于 CAS 这一跳，有几点得老实说，因为大部分移植都是栽在这里：

- **那把 AES 密钥不是秘密。** `login-croypto` 每次加载页面重新生成，并直接写进 HTML
  发给客户端。加密密码是为了让凭据不能以明文被简单重放，它并不是传输加密。
  用户名仍然明文发送，密钥本身也能从页面里读出来。这也正是整套东西只在门户自己的
  通道里才说得通的原因。
- **挑战是有状态的。** `execution` 和 `croypto` 属于同一次页面加载。如果你取一次页面、
  过一会儿再重试 POST，execution 已经过期，CAS 会拒绝——所以客户端每次尝试都重新取挑战。
- **有一道验证码闸门。** 提交前，客户端会问一个 `captchaCount/validate` 接口是否需要
  验证码。在我们的部署里正常密码认证从不触发它，但这个检查留着，是为了让守护进程
  「响亮地失败」，而不是对着门户死循环猛敲。
- **不需要浏览器。** `urllib` 加 `http.cookiejar` 就够处理 cookie 和重定向了；AES 交给
  `openssl enc -aes-128-ecb`。第三方依赖数量因此是零。

## 状态机

我不想要一个假设每步都会成功的线性脚本。客户端是一台状态机，每一轮循环顶部都先做一个
明确的「我在线吗？」探测：

- **probe** → 在线？休眠、心跳、继续。离线 → 进入发现流程。
- **discover** → 抓取 `sessionId`、`userIp`、`nasIp`、`customPageId`。
- **cas** → 取挑战、加密、提交；出现 3xx 即视为被接受。
- **workflow** → 在有界次数内循环 `getCurrentNode`，把设备节点和服务节点分发出去，
  直到路径走到 `finish`。
- **verify** → 再次探测；若仍离线，就把整次尝试判为失败。

有界循环和显式失败不是过度谨慎。对着一个要求验证码的门户做无界重试，正是账号被锁的
标准姿势。

```bash
# 1) 只做发现——从不发送凭据，任何时候都能安全运行
$ sudo python3 ruijie_login.py --capture
{
  "sessionId": "…",
  "userIp": "10.19.x.x",
  "nasIp": "10.254.x.x",
  "customPageId": "…"
}

CAS login page: http 200, 48xxx bytes
login-page-flowkey: <execution 令牌> …
login-croypto     : <base64 编码的 16 字节 AES 密钥>

# 2) 真实登录一次，然后退出
$ sudo python3 ruijie_login.py --once
[…] captive sessionId=… userIp=… nasIp=…
[…] CAS accepted (302 -> /portal/assets/auth-success.html?ticket=ST-…)
[…] workflow node: serviceSelection
[…] serviceSelection candidates: ['ctcc', 'cmcc', 'unicom']
[…] workflow node: finish
[…] LOGIN OK - now online
```

注意 `--capture` 这个动词。留一个只走发现、只打印挑战、绝不发送凭据的模式，
值得花那十来行代码：它是你在门户悄悄改版时安全调试的方式，也是你确认自己读对了
页面的方式。

## 把它部署成 systemd 服务

客户端就是一个文件，带 `--status`、`--capture`、`--dry-run`、`--once`、`--logout`
以及守护模式。部署就是一个很小的单元：

```ini
[Unit]
Description=Ruijie ePortal auto-login (campus network keep-alive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/ruijie-login/ruijie_login.py \
          --config /etc/ruijie-login/config.json
Restart=always
RestartSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

守护进程的行为刻意保守。每 20 秒一次心跳，而且只有在探测判定为离线时才真正尝试登录
——它不会去拆掉一条正好好工作着的会话。失败时按指数退避（30s → 60s → … 封顶 30 分钟），
所以密码输错也不会把账号锁死。配置权限是 `0600`，因为它存着明文的校园网密码。
日志进 journal，另外有一个手机端控制脚本，让我在实验室想用自己的账号时，能通过 overlay
网络从手机上停掉或重启这个服务。

## 16 秒重连

一个声称能重连的守护进程，必须拿一次**真实**断线来验证。我用最老实的方式制造了一次：
改掉校园上行网口的 WAN MAC。

这会作废 BRAS 上的 MAC 绑定，路由器拿到一个新的校园 IP，网关把它踢回认证状态。
服务随后大致打出：

```text
[0] status before: ONLINE
[1] new WAN MAC -> 新的校园 IP，绑定失效 -> 离线
    captive sessionId=… userIp=10.19.x.x nasIp=10.254.x.x
    CAS accepted (302 -> /portal/assets/auth-success.html?ticket=ST-…)
    workflow node: serviceSelection
    serviceSelection candidates: ['ctcc', 'cmcc', 'unicom']
    workflow node: finish
    LOGIN OK - now online
```

从强制断线到重新上线，全程约 **16 秒**。这个数字不是什么魔法常数——它就是下一个 20 秒
检查周期，加上登录往返的开销；同时配置里把服务选择显式钉成 `ctcc`，所以工作流不会停在
那里等人输入。如果你把 `service` 留空，客户端就取门户给出的第一个候选。

## 把合法性说清楚

这套东西自动化的是**我自己**对一张我有权使用的网络的认证访问，用的就是我会敲进浏览器的
同一套凭据。它不绕过付费、额度或任何访问控制，也从不碰别人的账号，对网关的访问不超出
浏览器自己会调用的那些接口。它没有凭据就拒绝运行，被要求验证码就拒绝循环，动手之前
先探测。如果你们校园的政策禁止无人值守客户端或改 MAC，请遵守政策。不要把这类工具指向
你不拥有、也未被授权使用的网络。

## 我会对下一个人说的话

如果 `/eportal/InterFace.do?method=login` 返回 404，别再调你的参数了——你在 SSO 变体上，
那份老契约根本不存在。去读重定向链。把 `sessionId` 当成一次性的，每次重新获取。
先把「我在线吗？」这个探测写出来，因为其它一切都挂在它上面。以及，在写登录模式之前，
先写只做发现的模式；你会更常用到它。

支撑这一切的基础设施——自建的 Git 服务、overlay 网络、那台构建并伺服本站的机器——
正是[这个博客如何发布它自己](/zh/posts/how-this-blog-ships-itself/)的主题，如果你想要
更大的图景，那里是最好的起点。一个无头登录守护进程，不过是
[同一条流水线](/zh/posts/how-this-blog-ships-itself/)上的又一个服务：读、跑、验证、重复。
