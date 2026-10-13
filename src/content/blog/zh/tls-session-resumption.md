---
title: "TLS 会话恢复：完整握手 vs 恢复会话，以及 TLS 1.3 0-RTT"
description: "完整 TLS 握手到底要花多少往返和字节；TLS 1.2 的会话 ID 与会话票据、TLS 1.3 的 PSK 票据如何让重连客户端跳过大部分工作；用 openssl s_client -sess_out/-sess_in 亲眼验证；nginx ssl_session_cache 调优；以及 TLS 1.3 0-RTT 的重放代价。"
pubDate: 2027-01-15
lang: zh
translationKey: tls-session-resumption
tags: [security, networking]
featured: false
keywords:
  - TLS 会话恢复
  - 会话票据
  - TLS 1.3 0-RTT
  - openssl s_client
  - PSK
---

每一条新的 TLS 连接，都要先付一次**完整握手**的代价，然后你的请求才能流动一个字节。在个人项目里你根本察觉不到；到了平台规模，这笔税就是实打实的——每个连接多走的往返、每次握手重传的证书链、每次建连全新的非对称运算。**TLS 会话恢复**（TLS session resumption）就是协议的答案：重连的客户端证明"我来过"，从而跳过大部分工作。

这篇文章里，我会给出完整握手的真实代价，讲清两种恢复机制——TLS 1.2 的会话 ID 与会话票据、TLS 1.3 的 PSK 票据——并用一次性 nginx 实验环境里的真实 `openssl s_client` 输出逐一验证。之后调一调 nginx 的 `ssl_session_cache`，最后聊 TLS 1.3 0-RTT：它买来了什么，以及随之而来的重放账单。如果你想先补握手本身的功课，我的 [TLS 1.3 握手逐条拆解](/zh/posts/tls-1-3-handshake/) 是前置读物。

## 完整握手的代价

两笔代价：**延迟**（往返次数）和**加密开销**（字节 + CPU）。

- TLS 1.2 需要 2 个 RTT：`ClientHello`，然后 `ServerHello`/`Certificate`/`ServerHelloDone`，再 `ClientKeyExchange`/`ChangeCipherSpec`/`Finished`——到此应用数据才能流动。
- TLS 1.3 只需要 1 个 RTT：带 `key_share` 的 `ClientHello`，然后 `ServerHello`…`Finished`。恢复会话的 RTT 数和完整握手一样——省的是字节和服务器 CPU，不是往返次数。

规模一大，加密开销才是大头。每次完整握手都意味着一次 ECDHE 密钥交换、一次证书链传输、**每条连接**一次签名验证。在 RTT 100 ms 的移动链路上，TLS 1.2 完整握手在第一个字节发出前就烧掉约 300 ms；TLS 1.3 约 100 ms。乘上一百万条连接，服务器的加密预算立刻吃紧。

以下是我实验环境里的真实数字——一次性 `nginx:1.27-alpine`（nginx 1.27.5，OpenSSL 3.3.3）加一张自签 RSA-2048 证书，127.0.0.1 上两个 vhost，一个 TLS 1.3、一个 TLS 1.2：

| 握手 | 读取字节 | 写入字节 | 合计 |
|---|---|---|---|
| TLS 1.3 完整 | 1369 | 1631 | ≈ 3.0 KB |
| TLS 1.3 恢复 | 245 | 1934 | ≈ 2.2 KB |
| TLS 1.2 完整 | 1466 | 1626 | ≈ 3.1 KB |
| TLS 1.2 恢复 | 141 | 1776 | ≈ 1.9 KB |

两个细节值得注意。第一，恢复会话的客户端写得*更多*——它的 `ClientHello` 要带上 PSK 扩展和一份新的 `key_share`。第二，服务器的报文急剧变小，因为**证书链不再重传**（读取从 1369 降到 245 字节）。净效果：线上流量减少约 25–30%，每条连接少一次签名验证。

在回环（loopback）网络上，端到端耗时看不出差别——两种握手实测都约 15 ms，几乎全是进程启动开销。这是诚实的本地结果；延迟上的收益只有在 RTT 真实的网络上才显现。

## 两种机制：TLS 1.2 的会话 ID/票据 vs TLS 1.3 的 PSK 票据

**TLS 1.2** 提供两种恢复方式：

- **会话 ID（session ID）**——服务器把完整会话状态存在自己内存里，用 `ServerHello` 里下发的 ID 做索引。客户端重连时原样带回这个 ID。简单，但状态在服务器侧：除非所有节点共享会话缓存，否则无法水平扩展。
- **会话票据（session ticket，RFC 5077）**——服务器用 AES 把会话状态密封成一个数据块交给客户端。服务器保持无状态；客户端下次连接出示这张票据。代价是密钥管理：票据加密密钥必须在节点间共享并定期轮换。

**TLS 1.3**（RFC 8446）彻底取消会话 ID，只用 **PSK 票据**。握手结束后，服务器发送 `NewSessionTicket` 消息，里面带着加密过的预共享密钥。重连时客户端把这张 PSK 放进 `ClientHello` 的 `pre_shared_key` 扩展——关键在于，TLS 1.3 会在 PSK 之上再做一次**全新的 ECDHE**。相比 TLS 1.2 的恢复，这正是安全升级：普通 TLS 1.2 恢复会话直接复用旧的主密钥，而 TLS 1.3 的恢复因为流量密钥总会混入新的临时交换，前向保密得以保留。我的抓包里，服务器每次握手发两张 `NewSessionTicket`，这很典型。

<figure>
<svg viewBox="0 0 780 372" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="TLS 1.3 完整握手与恢复握手的消息流对比，两者都只需一个往返">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <style>
    .lbl { font: 600 13px system-ui, sans-serif; fill: currentColor; }
    .sm { font: 12px system-ui, sans-serif; fill: currentColor; }
    .byte { font: 11px ui-monospace, SFMono-Regular, monospace; fill: #0f766e; }
    .acc { fill: #0f766e; }
  </style>

  <!-- 面板一：完整握手 -->
  <text class="lbl" x="20" y="26">完整握手</text>
  <text class="sm" x="62" y="58">客户端</text>
  <text class="sm" x="238" y="58">服务器</text>
  <line x1="100" y1="70" x2="100" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="300" y1="70" x2="300" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="100" y1="118" x2="296" y2="118" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="110">ClientHello</text>
  <text class="byte" x="112" y="132">写入 1 631 B</text>
  <line x1="300" y1="182" x2="104" y2="182" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="174">ServerHello · Certificate · CertVerify · Finished</text>
  <text class="byte" x="112" y="196">读取 1 369 B</text>
  <path d="M 330 118 L 342 118 L 342 182 L 330 182" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text class="acc" x="350" y="153" style="font:600 12px system-ui,sans-serif">1 RTT</text>
  <line x1="100" y1="252" x2="296" y2="252" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="244">HTTP 请求（已加密）</text>
  <line x1="300" y1="296" x2="104" y2="296" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="288">响应</text>

  <!-- 面板二：恢复握手 -->
  <text class="lbl" x="420" y="26">恢复会话（会话票据）</text>
  <text class="sm" x="462" y="58">客户端</text>
  <text class="sm" x="638" y="58">服务器</text>
  <line x1="500" y1="70" x2="500" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="700" y1="70" x2="700" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="500" y1="118" x2="696" y2="118" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="110">ClientHello + PSK（票据）</text>
  <text class="byte" x="512" y="132">写入 1 934 B</text>
  <line x1="700" y1="182" x2="504" y2="182" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="174">ServerHello + Finished —— 无证书</text>
  <text class="byte" x="512" y="196">读取 245 B</text>
  <path d="M 730 118 L 742 118 L 742 182 L 730 182" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text class="acc" x="748" y="153" style="font:600 12px system-ui,sans-serif">1 RTT</text>
  <line x1="500" y1="252" x2="696" y2="252" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="244">HTTP 请求（已加密）</text>
  <line x1="700" y1="296" x2="504" y2="296" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="288">响应</text>
  <text class="byte" x="420" y="352">字节少约 27%，省去证书验证</text>
</svg>
<figcaption>TLS 1.3 的完整握手与恢复握手都只需 1 个 RTT——收益在字节和服务器 CPU，而非往返次数。字节数取自 nginx 1.27.5 上真实的 <code>openssl s_client</code> 输出。</figcaption>
</figure>

## 亲眼验证：`openssl s_client -sess_out` / `-sess_in`

`s_client` 能把服务器提供的会话存下来，并在下一条连接里交回去。整个过程就两条命令。

先做完整握手，把会话存入文件：

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -sess_out sess13.pem
...
SSL handshake has read 1369 bytes and written 1631 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 2048 bit
...
Early data was not sent
Verify return code: 18 (self-signed certificate)
```

`New` 表示全新会话。有两行和后面的 0-RTT 讨论直接相关：`Early data was not sent`（本客户端没有尝试 0-RTT），以及紧随其后到达的 `NewSessionTicket`——用 `-msg` 能看到：

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -msg
...
<<< TLS 1.3, Handshake [length 0109], NewSessionTicket
    04 00 01 05 00 01 51 80 83 e3 6c 85 08 00 00 00
...
<<< TLS 1.3, Handshake [length 0109], NewSessionTicket
```

现在带着保存的会话重连——同一条命令，换成 `-sess_in`：

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -sess_in sess13.pem
...
SSL handshake has read 245 bytes and written 1934 bytes
Verification error: self-signed certificate
---
Reused, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Early data was not sent
Verify return code: 18 (self-signed certificate)
```

就一个词——**`Reused`**——就是全部故事：服务器接受了票据里的 PSK，跳过了证书传输，握手只读了 245 字节而不是 1369。保存下来的文件恰好展示了客户端手里攥着什么：

```
$ openssl sess_id -in sess13.pem -text
Protocol  : TLSv1.3
Cipher    : TLS_AES_256_GCM_SHA384
Session-ID: 73E27FCBAE2B6CBC52EC25696369A740607BF5CDEB21DB7FF8D6B9EAB40CD9BB
Resumption PSK: 2F516D2DD8B5235F991F6198648F426BF342C267093C96A86A29C4389626A298D31949367583537DFC859951352F0554
PSK identity: None
TLS session ticket lifetime hint: 86400 (seconds)
Max Early Data: 0
```

`Resumption PSK` 是派生出的预共享密钥，`lifetime hint` 为 86400 秒，正是服务器的 `ssl_session_timeout`（我配的是 24 h）告知客户端的值。`Max Early Data: 0` 表示这台服务器没有提供 0-RTT——详见下文。

TLS 1.2 走同样的 `-sess_out`/`-sess_in` 流程，但恢复用的是**会话 ID**（若服务器也发票据，则还可走票据）：

```
# TLS 1.2 vhost，127.0.0.1:19444
$ openssl s_client -connect 127.0.0.1:19444 -sess_out sess12.pem
SSL handshake has read 1466 bytes and written 1626 bytes
New, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384

$ openssl s_client -connect 127.0.0.1:19444 -sess_in sess12.pem
SSL handshake has read 141 bytes and written 1776 bytes
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
```

规律一目了然：读取量骤降（1466 → 141），因为证书链留在服务器侧；写入量略增，因为客户端要带回自己的会话材料。

## `-reconnect`：一条命令看完完整与恢复

`s_client -reconnect` 会连续建立六条连接——快速观察服务器恢复行为的好办法。对着 TLS 1.2 vhost：

```
$ openssl s_client -connect 127.0.0.1:19444 -reconnect
New,    TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
```

TLS 1.2 的会话 ID 就装在 `ServerHello` 里，所以恢复立即生效。TLS 1.3 vhost 则是另一番景象：

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -reconnect
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
```

六条全是 `New`。这是真实存在的坑，不是实验环境的假象：TLS 1.3 的票据是**握手后**消息，而 `s_client -reconnect` 在票据落地之前就断开了每条连接——我在 `-msg` 抓包里 grep 过，后面的 `ClientHello` 里 `pre_shared_key` 扩展数量是零。所以对 TLS 1.3，请用 `-sess_out`/`-sess_in`（如上）；`-reconnect` 只能演示 TLS 1.2 的恢复。

## 服务器侧：nginx 的 `ssl_session_cache`、超时与票据

我的实验配置，也就是上面全部输出的来源：

```nginx
# 共享内存会话缓存：1 MiB ≈ 4000 个会话
ssl_session_cache shared:TLS:1m;
ssl_session_timeout 24h;
ssl_session_tickets on;
```

- **`ssl_session_cache shared:TLS:1m`**——名为 `TLS` 的共享内存缓存，1 MiB，跨 worker 进程共享。TLS 1.2 会话 ID 恢复能跨 worker 存活，靠的就是它。不配（nginx 默认是 `none`）的话，TLS 1.2 恢复就退化成客户端自己记住的机制——通常就是票据（如果开着）。
- **`ssl_session_timeout 24h`**——会话可恢复的有效期（nginx 默认 5 m）。客户端会把它当作票据 lifetime hint 看到。
- **`ssl_session_tickets on`**——签发 TLS 1.3（以及 TLS 1.2）会话票据。现代 nginx 默认开启。

**安全提示。** 会话票据是*加密后的状态*，不是明文：服务器用票据密钥把 PSK 封进数据块，客户端读不出也改不了。但这个密钥自此进入你的信任边界——能读到它的人能解密抓到的票据，能写它的人能伪造可恢复会话。只在你完全信任的节点间共享它、定期轮换它、像保护私钥一样保护它。如果威胁模型考虑密钥泄露，关掉票据（`ssl_session_tickets off`）是合理的权衡：客户端会退回到 TLS 1.2 会话 ID 恢复（查共享缓存），或者干脆完整握手。你失去无状态恢复能力和一部分恢复率，但缩小了密钥管理面。还要记住前面说过的前向保密点：TLS 1.3 票据恢复骑在全新 ECDHE 之上，所以开启票据**不会**像老式 TLS 1.2 恢复那样削弱逐连接的前向保密。

有一件事我替你验证过了：把 `worker_processes` 调到 4，票据恢复 12 次全部成功——nginx 在 worker 之间共享票据密钥，所以除非你在上古版本上或想显式控制密钥，否则不需要配 `ssl_session_ticket_key`。

## TLS 1.3 0-RTT：免费午餐，但账单是重放

TLS 1.3 的票据可以授权**早期数据（early data）**：客户端把应用数据塞进*同一批*报文，和 `ClientHello` + PSK 一起发出，用票据派生的密钥加密。服务器立即处理——**0 个往返**，而不是 1 个。在 200 ms 的卫星链路上，整个握手就这样蒸发了。

两个注意事项，也正是 0-RTT 不默认开启的原因：

1. **TCP 上的客户端支持有限。** 浏览器在普通浏览中不会对 TLS 1.3-over-TCP 发送早期数据——你在野外见到 0-RTT，通常是在 QUIC 里（见我的 [QUIC 与 HTTP/3](/zh/posts/quic-and-http3/) 一文）。服务器侧 nginx 用 `ssl_early_data on;` 开启。
2. **重放风险。** 早期数据*不受*协议的重放保护。攻击者抓到一个 0-RTT 报文就能重放；服务器若接受两次，任何副作用都会发生两次。防御手段是有的——单次使用票据、服务器侧重放缓存（OpenSSL 自带）、nonce——但稳妥的运维法则是：只有幂等请求（安全 `GET`）才配进早期数据，一切有副作用的请求必须等完整握手。我的实验输出里写着 `Max Early Data: 0`——nginx 根本没提供 early data，这正是安全的默认姿态。

所以：0-RTT 对高延迟、请求-响应式且请求可重放无害的流量，是实打实的延迟收益。其他一切，留在 1-RTT 的恢复握手上就好。

## 何时有用，何时无关

**有用：** 移动与卫星客户端（RTT 主导一切——恢复把 TLS 1.2 的 2-RTT 握手变成 1-RTT，0-RTT 则彻底消除）；大规模 TLS 终结代理与负载均衡（更少签名验证、更低 CPU，用票据的话还省掉共享会话缓存的运维）；一切开大量短连接的场景；反复重连的受限 IoT 设备。

**无关：** 局域网与数据中心流量——我的回环数字（两者都约 15 ms）说明 RTT ≈ 0 时无从可省；长连接——HTTP/2 与 HTTP/3 在一条连接上多路复用，恢复只在建连时付一次；以及根本没有重连的客户端（恢复终究是"*重*连"优化）。

## 小结

- 完整握手要付 RTT 和逐连接的加密开销；对着我的 nginx 1.3 vhost，这是 3.0 KB 线上流量和每条连接一次证书验证。
- TLS 1.2 靠**会话 ID**（服务器状态）或**票据**（加密的、客户端持有的状态）恢复；TLS 1.3 靠 `NewSessionTicket` 的 **PSK 票据**恢复，且永远叠加全新 ECDHE。
- `openssl s_client -sess_out`/`-sess_in` 把恢复显形为 `Reused`；`-reconnect` 能演示 TLS 1.2 恢复，却会跑在 TLS 1.3 票据前面。
- nginx：`ssl_session_cache` 管共享状态，`ssl_session_timeout` 管有效期，`ssl_session_tickets on` 管无状态 PSK 恢复——并把票据密钥当作它所处的信任边界来对待。
- TLS 1.3 0-RTT 消掉了握手的 RTT，但早期数据可被重放：只放幂等请求。
