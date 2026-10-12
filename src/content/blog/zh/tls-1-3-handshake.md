---
title: "TLS 1.3 握手全流程：一个往返、告别 RSA 密钥交换，以及它为何更安全"
description: "逐条消息走一遍 TLS 1.3 握手：它必须达成什么、ClientHello 里的 key_share、CertificateVerify 与 Finished、它与 TLS 1.2 的区别、0-RTT 的重放代价，以及如何在 openssl s_client 和 Wireshark 里读懂整个握手。"
pubDate: 2026-11-06
lang: zh
translationKey: tls-1-3-handshake
tags: [networking, security]
featured: false
keywords:
  - TLS 1.3 握手
  - TLS 握手
  - openssl s_client
  - 前向保密
  - 0-RTT
---

你这周见过的每一个小锁图标，都是由一次 **TLS 1.3 握手**换来的——它在你请求的第一个字节发出之前，就用掉几毫秒跑完了。我经常盯着这些握手看：在 `openssl` 里、在抓包文件里、在日志里。最让人意外的一点，是它相比 TLS 1.2 干的事**少**了那么多：消息更少、往返降到一次，而一整类历史坑（静态 RSA、压缩、重协商）是直接被删掉，而不是打补丁。这篇就逐条消息走一遍 **TLS 握手**，把每一步对应到 **`openssl s_client`** 的实际输出，并解释它为什么同时变得**更简单**又**更安全**。如果你是因为握手坏掉才点进来的，我那篇 [TLS 证书错误](/zh/posts/tls-errors-explained/) 是配套阅读；至于为大量域名自动签发，看 [自动化 TLS](/zh/posts/automated-tls-at-scale/)。

## TLS 握手必须达成什么

在讲消息之前，先讲目标。握手不是“加密”，它是一次协商，而这次协商必须交付四件彼此独立的东西：

- **认证（Authentication）**——客户端要确认自己在跟“它请求的那个域名所对应证书”的私钥持有者说话，而不是某个冒充者。
- **密钥协商（Key agreement）**——双方在一个窃听者可读的信道上，各自算出同一个对称密钥，而从不把这一密钥本身发出去。
- **前向保密（Forward secrecy）**——会话密钥派生自一个临时秘密，连接结束即被丢弃。即便攻击者*明天*偷走了服务器的长期私钥，也解不开*今天*抓到的流量。
- **完整性（Integrity）**——每一条握手消息都折进一个 transcript 哈希里，所以任何被篡改或拼接的消息序列都会让 Finished 校验失败。

把这四条记住：TLS 1.3 里每一次“删掉某功能”，理由都能落到上面某一条。

## TLS 1.3 握手，逐条消息拆解

下面是完整的 1-RTT 流程。花括号表示“已用握手密钥加密”。

```
   Client (initiator)                        Server (responder)
   ─────────────────────────────────        ─────────────────────────────────
   ClientHello ──────────────────────►
     • random
     • key_share            (X25519 public key)
     • supported_versions   = TLS 1.3
     • cipher_suites, SNI, ALPN
                                            │ pick a group, derive the
                                            │ shared secret from key_share
   ◄────────────────────────────── ServerHello
                                            • key_share (server public key)
                                            • cipher_suite, supported_versions
   ══════════ everything below is encrypted ══════════
   ◄──────────────────── {EncryptedExtensions}   ALPN, server_name ack
   ◄──────────────────── {Certificate}            server's chain
   ◄──────────────────── {CertificateVerify}      signature over transcript
   ◄──────────────────── {Finished}               server MAC over transcript
   {Finished} ───────────────────────►            client MAC over transcript
   ══════════ application data flows both ways ══════════
```

逐条来看：

- **ClientHello。** 客户端给出：一个随机数；一串加密套件（cipher suites）；通过 SNI 声明它想要的域名；以及——最关键的一项——一个 **`key_share`** 扩展，里面带着它的临时公钥（默认 X25519，也可能是 secp256r1 一类的曲线）。它同时声明 `supported_versions = 0x0304`，意思是“我会说 1.3”。
- **ServerHello。** 服务器选定一个加密套件和一个密钥交换组，回传*它自己的* `key_share`。至此双方都能算出共享的 ECDHE 秘密。这条消息之后的一切都是加密的。
- **EncryptedExtensions。** 那些不影响密钥推导的扩展——ALPN 选定的协议、对 SNI 域名的确认——挪到这条消息里，从而也受到保护。
- **Certificate。** 服务器证书链。历史上它是明文发送的，现在则走在加密流里。
- **CertificateVerify。** 用**证书**私钥对 transcript 哈希做的一次签名。正是它把**证书**绑定到*这一次*握手上，并证明对方确实握有私钥。
- **Finished。** 对整个 transcript 的 HMAC。双方各发一条。只要有任何重排或篡改，transcript 哈希就对不上，校验失败。

然后应用数据开始流动。整个协议就这么点东西：客户端一个飞行（flight），服务器一个飞行，一个往返。

## 前向保密这道保证，以及静态 RSA 为何必须退场

在 TLS 1.2 里，常见的默认做法是**静态 RSA 密钥交换**：客户端用一个随机的 premaster secret，用服务器的 RSA 公钥加密后发过去。会话密钥所需的一切都由这一个值派生，而这个值又能用服务器的私钥还原。于是任何先录下流量、*之后*才拿到私钥的人——一次传票、一次备份泄露、一个 Heartbleed 式的漏洞——都能解开过去多年的会话。这就是没有**前向保密**。

TLS 1.3 把静态 RSA 整个删掉了。剩下的唯一密钥交换是临时 Diffie-Hellman：客户端和服务器的 `key_share` 各用一次就丢。偷走证书私钥，你仍然能在未来冒充服务器，但过去的流量依旧不可读，除非那些临时密钥也泄露了。就靠这一处删除，**前向保密**从“你要去配置的选项”变成了“你关不掉的默认值”。

## 0-RTT：省下一个往返，买来一次重放风险

恢复（resumption）会话可以比一个往返做得更好。借助上一次连接留下的 PSK（服务器在上次握手末尾推来的 session ticket），客户端能在第一个飞行里就发出**early data**——也就是一个请求。这就是 **0-RTT**：服务器可能在任何一个往返完成之前就给出响应。

代价是真实存在的，值得直说：**0-RTT 数据可被重放，且不具备前向保密。** 攻击者抓到 early-data 飞行后可以原样再发一次。TLS 1.3 给了服务器一些对抗手段——一次性 ticket、时间窗口、重放缓存——但它们都不完美，而且只有当请求是幂等的时候，重放才真正无害。凡是会改变状态的，我一律不开 early data：不会用 `POST` 去扣款，不碰任何写接口。安全的 `GET`、只读操作的恢复，可以。又因为它放弃了前向保密，0-RTT 是协议里唯一一处拿安全属性换延迟的地方——请把 1-RTT 当基线，把 0-RTT 当刻意的例外。

## 用 openssl s_client 读懂握手

看清这一切最快的方式，就是 **`openssl s_client`**。两个参数能让它变成握手追踪器：`-msg` 会 dump 出每一条协议消息，`-state` 会在每次状态迁移时打印一行。

```bash
# 对一个真实主机追踪一次完整的 TLS 1.3 握手
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -state -msg </dev/null 2>&1 | head -80
```

按顺序读 `-state` 那些行，你就是在把上面那张图当日志来读：

```
SSL_connect:before SSL initialization
SSL_connect:SSLv3/TLS write client hello
SSL_connect:SSLv3/TLS read server hello
SSL_connect:TLSv1.3 read encrypted extensions
SSL_connect:TLSv1.3 read server certificate
SSL_connect:TLSv1.3 read server certificate verify
SSL_connect:TLSv1.3 read finished
SSL_connect:SSLv3/TLS write change cipher spec
SSL_connect:SSLv3/TLS write finished
SSL_connect:SSL negotiation finished successfully
SSL_connect:SSLv3/TLS read server session ticket
```

有两点值得注意。第一，从 `read server hello` 之后，每一行都带上了 `TLSv1.3` 标记——这正是加密开始的边界，跟我图里画的位置完全一致。第二，握手在客户端的 `Finished` 完成*之前*就已经到达 `negotiation finished successfully`，因为服务器的飞行早已送达。一个往返。

想确认协商出的协议和加密套件，直接向它要那段汇总信息：

```bash
# 一次拿到协商协议 + 加密套件 + 证书链验证结果
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 </dev/null 2>/dev/null \
  | grep -E "Protocol|Cipher|Verify return code"
# Protocol : TLSv1.3
# Cipher   : TLS_AES_256_GCM_SHA384
# Verify return code: 0 (ok)
```

要专门验证 0-RTT，就存下一张 ticket，再用 early data 恢复：

```bash
# 1) 存下一张 session ticket；2) 恢复并在第一个飞行里发 early data
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -sess_out /tmp/tls13.pem </dev/null >/dev/null 2>&1

printf 'GET / HTTP/1.1\r\nHost: blog.awin-x.top\r\nConnection: close\r\n\r\n' \
  > /tmp/req

openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -sess_in /tmp/tls13.pem -early_data /tmp/req -quiet
```

## 同样的握手，在 Wireshark 里

在 Wireshark 里你能眼看着那条加密边界出现。**ClientHello** 和 **ServerHello** 是可读的——握手类型 `1` 和 `2`——在 ServerHello 的扩展里还能看到 `supported_versions: 0x0304`。而紧接着的帧就不再是 “Handshake Protocol”，而是变成了 **Application Data** 记录，尽管它们其实装着 EncryptedExtensions、Certificate、CertificateVerify 和 Finished。这就是关键：TLS 1.3 把 hello 之后的握手记录包进了和应用数据同一种记录类型里，所以被动观察者连哪条消息是哪条都分不清。

```bash
# 列出抓包里的明文握手消息
tshark -r handshake.pcapng -Y 'tls.handshake.type == 1 || tls.handshake.type == 2' \
  -T fields -e frame.number -e tls.handshake.type
```

想让那些加密消息变得可读，就让客户端写出密钥日志，再把 Wireshark 指过去：

```bash
# 客户端侧：导出每次会话的秘密
SSLKEYLOGFILE=/tmp/keys.log openssl s_client -connect blog.awin-x.top:443 \
  -servername blog.awin-x.top -tls1_3 </dev/null >/dev/null 2>&1
# Wireshark：Preferences → Protocols → TLS → (Pre)-Master-Secret log filename
```

## 为什么 TLS 1.3 更简单也更安全

故事就在那些“删掉的东西”里：

- **没有静态 RSA 密钥交换** → 前向保密是强制的，不是可选项。
- **没有压缩** → CRIME 及其同类失去了攻击面。
- **没有重协商** → 那种“中途重认证把 transcript 搞乱”的 bug 类整个消失。
- **一个往返** → 更低的延迟，和一个更小的状态机。
- **hello 之后的握手全部加密** → 被动观察者拿到的元数据更少，可指纹化的东西也更少。
- **HKDF 密钥调度** → 握手密钥与应用密钥的派生更清晰、可审计。

“更简单”和“更安全”通常是互相拉扯的。这里之所以能统一，是因为设计者是**删掉选项**，而不是**加检查**。

## 我实际会查什么

握手出问题时，我的排查循环每次都一样：

1. 跑 `openssl s_client -state -msg`，找到它停在哪一步。
2. 确认协商出的协议是 `TLSv1.3`，且 `key_share` 用的是你打算提供的那个组。
3. 如果恢复行为不对，用 `-no_ticket` / `-sess_in` 把 0-RTT 和完整握手分开来验证。
4. 最后才去追证书——用 [证书错误指南](/zh/posts/tls-errors-explained/)，以及做续期自动化时的 [自动化 TLS](/zh/posts/automated-tls-at-scale/)。

TLS 1.3 是少见的那种、靠*删功能*让自己更快、更小、更难配错的协议版本。记住“一个飞行”的那张图，之后每一份 `s_client` 跟踪和 Wireshark 抓包都会变得可读。
