---
title: "TLS OCSP 装订：不泄露隐私的证书吊销检查"
description: "证书吊销是怎么回事：CRL、OCSP 各自的问题与隐私代价，用 ssl_stapling 在真实 Docker 实验里配置 nginx 并以 s_client -status 验证，Must-Staple 的兴亡，以及 Let's Encrypt 2025 年关停 OCSP 如何改变了一切。"
pubDate: 2027-01-31
lang: zh
translationKey: tls-ocsp-stapling
tags: [security, networking]
featured: false
keywords:
  - OCSP 装订
  - 证书吊销
  - ssl_stapling
  - CRL
  - Must-Staple
---

一张证书可以既有效又已经死了。日期没问题，链验证通过，浏览器挂着让人安心的锁——而 CA 上周二就因为某人的私钥泄露吊销了它。**证书吊销（certificate revocation）**就是 CA 在 `notAfter` 到期之前收回「有效」二字的方式，而用来查证它的几乎每一种机制，都是隐私、时延和对失败坦白程度之间的权衡。这篇讲 **OCSP 装订（OCSP stapling）**：把吊销检查从客户端路径上搬走的技巧、它真正生效时长什么样，以及 2026 年那个尴尬的事实：全球最大的 CA 已经在 2025 年关掉了 OCSP，对我们大多数人来说它正在变成历史功能。下面所有命令行都是真跑过的——Docker 里一个用完即删的 nginx，配一个真实的本地 CA 和真实的 OCSP 应答端，再加上我实际检查的公开站点。握手本身在[《TLS 1.3 握手》](/zh/posts/tls-1-3-handshake/)里讲过，续签自动化在[《大规模自动化 TLS》](/zh/posts/automated-tls-at-scale/)。

## 证书吊销：过期日期覆盖不到的缺口

签发是一个承诺：*这个密钥、这个名字，到此日期为止。*吊销是 CA 提前撤销承诺。原因你在各种复盘里都见过：私钥泄露、CA 签错证书、域名换了主人而旧主人必须失去证书、恶意活动短暂挂名。一张宣称五年有效的证书，在第一年出事的那一刻就是负资产。

回答「这个序列号还有效吗」的经典方式有两种：

- **CRL —— 证书吊销列表。** CA 发布一个签名文件，列出它吊销过的每一个序列号。客户端把列表下载下来搜索。一个文件、一个签名、极易缓存——而且它只告诉 CA「你在检查某个来自本 CA 的证书」，不告诉 CA 你在访问哪个网站。
- **OCSP —— 在线证书状态协议。**客户端通过 HTTP 向 CA 的应答端查询一个具体序列号：`GET /ocsp?<序列号>`。小、快、精准——同时它准确告诉 CA：你在验证哪张证书、从哪个 IP、在什么时刻。

两种机制都不会让浏览器硬失败。这个细节比任何协议细节都重要，我一次次回到这一点。

## OCSP 的隐私与时延问题

OCSP 精准，它同时是一条追踪轨道。每一个用朴素方式检查吊销的客户端，都在**每访问一个网站时**向一个 CA 运营的 HTTP 端点发一次请求。即使 CA 承诺不留日志，它手里至少也握着一股实时的（IP、证书、时间戳）三元组洪流。这就是浏览历史；而只要哪天 CA 被勒令记录，一份历史就存在了。Let's Encrypt 在[总结这个决定](https://letsencrypt.org/2025/08/06/ocsp-service-has-reached-end-of-life/)时毫不含糊：他们关停 OCSP *主要*就是因为它构成隐私风险。他们公布的规模让这件事变得具体——峰值时他们每月处理约 **3400 亿次 OCSP 请求**，其中 CDN 上每秒超过 14 万次。

第二个问题是时延。想在开口说话之前确认的客户端，必须解析并查询应答端、等待一个签名响应、检查它的日期——在「连接是安全的」那一刻之前整整多一个往返；再算上验证应答端签名那套信任链流程，所付出的更多。链上每张证书都来一遍，「安全」的提示就明显地迟到了。浏览器之间的和解方案是**软失败**：OCSP 检查没有回来，就继续走。也就是说，在人们真实使用的 Web 上，吊销检查已经「仅供参考」非常久了。

## OCSP 装订：让服务器来带答案

修法是把请求的方向倒过来。*服务器*向 CA 应答端为自己的证书抓取 OCSP 响应——一次从数据中心发出的后台请求，按定时器、针对唯一一个序列号——缓存它，并在 TLS 握手中附带。客户端在 `ClientHello` 里用 `status_request` 扩展宣告支持，服务器以 `CertificateStatus` 消息回送签名响应。客户端自此不接触任何 CA 端点，用户不多付一个往返。隐私泄露消失了，因为有意思的查询现在都来自服务器自己，其形态完全暴露不了访客是谁。

<figure>
<svg viewBox="0 0 640 260" width="100%" role="img" aria-label="两幅示意图。有装订：服务器已提前取回 OCSP 响应并在 TLS 握手中发送，客户端从不联系 CA。无装订：客户端自行向 CA 的 OCSP 应答端发起 HTTP 查询，暴露正在访问的站点，并多付一个往返。">
  <defs>
    <marker id="ocsp-arrow-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
    <marker id="ocsp-arrow-dim-zh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11" opacity="0.75">
    <text x="10" y="14">有装订 —— 服务器随身带答案</text>
    <text x="10" y="152">无装订 —— 客户端去问 CA</text>
  </g>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.75">
    <rect x="10" y="30" width="120" height="40" rx="6"/>
    <rect x="330" y="24" width="170" height="52" rx="6"/>
    <rect x="330" y="140" width="170" height="40" rx="6"/>
    <rect x="470" y="184" width="160" height="52" rx="6" stroke-dasharray="5 4"/>
    <rect x="10" y="176" width="120" height="40" rx="6"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="130" y1="44" x2="326" y2="44" marker-end="url(#ocsp-arrow-zh)"/>
    <line x1="330" y1="66" x2="134" y2="66" marker-end="url(#ocsp-arrow-zh)"/>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <line x1="130" y1="190" x2="466" y2="200" marker-end="url(#ocsp-arrow-dim-zh)"/>
    <line x1="470" y1="226" x2="134" y2="216" marker-end="url(#ocsp-arrow-dim-zh)"/>
    <line x1="415" y1="76" x2="470" y2="182" stroke-dasharray="3 4" marker-end="url(#ocsp-arrow-dim-zh)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11">
    <text x="46" y="54">客户端</text>
    <text x="398" y="44">服务器</text>
    <text x="46" y="200">客户端</text>
    <text x="398" y="164">CA OCSP</text>
    <text x="486" y="212">应答端</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="10.5">
    <text x="136" y="38">ClientHello（status_request）</text>
    <text x="136" y="60">Certificate + 装订的 OCSP 响应</text>
    <text x="330" y="102">无客户端→CA 通信，不多一个往返</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="10.5" opacity="0.75">
    <text x="136" y="184">GET /ocsp?serial…</text>
    <text x="136" y="248">CA 得知站点 + IP + 时间</text>
    <text x="330" y="140">—— 挂锁之前多一个往返 ——</text>
  </g>
</svg>
<figcaption>全部要点：有 OCSP 装订时，服务器已取回响应并在握手中寄出，访客从不联系 CA；经典 OCSP 把箭头反过来——客户端亲自查询应答端，每一次查询都是关于你在访问什么的数据点。</figcaption>
</figure>

在看配置之前，先摆两条诚实的注意事项：

- **装订是尽力而为。** 客户端没有办法*要求*这个响应（除非证书带 Must-Staple），所以装钉配置坏掉只降级为「没有信息」，而不是失败——和之前一样的软失败形状，只是少了泄露。
- **一个序列号，不是整条链。** 装订的响应只覆盖服务器配置指向的叶证书。中间证书的吊销，在多数工程实践里是一个盲区。

## Must-Staple：想把装订从自愿变强制的扩展

只有服务器主动做，装订才有意义。**Must-Staple** 就是让它不可选的一次尝试：一个证书扩展（`tlsfeature`，OID `1.3.6.1.5.5.7.1.24`），告诉客户端「本证书只有在握手携带装订 OCSP 响应时才可用」。客户端看到这个扩展却拿不到响应，必须拒绝连接。吊销检查终于从「仅供参考」变成具有约束力。

它是个死于生态摩擦的好主意：浏览器从未一致地实现它，而一个配错的装订环境会变成自找的宕机制造机——证书*要求*一个服务器可能发不出的响应。Let's Encrypt 支持了它多年，然后在关停 OCSP 时叫停了这个实验：从 **2025 年 1 月 30 日**起新的 Must-Staple 请求失败，从 **2025 年 5 月 7 日**起所有携带该扩展的请求失败，包括续签。

## 在 nginx 里启用：ssl_stapling，和那个没人提的 resolver

以下全部跑在一个用完即删的容器里——nginx、一个本地 CA、一个 `openssl ocsp` 应答端扮演 CA 的 OCSP 服务——在私有网络上，无特权，做完清理。服务器证书像真实 CA 签发的那样带着 Authority Information Access 扩展，里面有 OCSP URL：

```bash
openssl x509 -in server.crt -noout -ocsp_uri
# http://ocsp-responder:18888/
```

nginx 这边是四个指令：

```nginx
server {
    listen 8443 ssl;
    server_name ocsp.lab.test;

    ssl_certificate     /certs/fullchain.crt;
    ssl_certificate_key /certs/server.key;

    # OCSP stapling: the server fetches the response, clients never do
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /certs/ca.crt;    # who to trust the stapled response from
    resolver 127.0.0.11 valid=10s;            # needed to resolve the responder hostname

    location / { return 200 "stapled handshake OK\n"; }
}
```

`ssl_stapling on` 是开关。`ssl_stapling_verify on` 加 `ssl_trusted_certificate` 告诉 nginx 该信任响应上的谁签名——这很重要：装订的响应只有在服务器验证过之后才有价值。`resolver` 看着像样板，却是「配置看着没问题却什么都没装订」最常见的原因——nginx 必须用运行时 DNS 解析应答端的主机名，而 `/etc/hosts` 不作数。删掉它，nginx 会针对每张证书明说：

```
[warn] no resolver defined to resolve ocsp-responder while requesting certificate status,
       responder: ocsp-responder, certificate: "/certs/fullchain.crt"
```

应答端就绪、网络可达时，握手里就带着真货。用 `openssl s_client -status` 索取它：

```bash
openssl s_client -connect 127.0.0.1:9443 -servername ocsp.lab.test -status \
  -verifyCAfile ca.crt </dev/null 2>/dev/null | grep -A12 'OCSP responses'
```

```
OCSP responses: number of responses: 1
======================================
OCSP Response Data:
    OCSP Response Status: successful (0x0)
    Response Type: Basic OCSP Response
    Responder Id: CN = OCSP Lab Root
    Produced At: Oct 14 03:46:27 2026 GMT
    Responses:
    Certificate ID:
      Hash Algorithm: sha1
      Issuer Name Hash: F8841CF33301178E2F1BBBF06A22DBE129CAC9DD
      Issuer Key Hash: DEAA545A24EFE55F25A8F11B005B7C7ADF6C2D02
      Serial Number: 1BDBDA62843525B120330AE007C87477EDFAF6B8
    Cert Status: good
    This Update: Oct 14 03:46:27 2026 GMT
    Next Update: Oct 14 04:46:27 2026 GMT
    Signature Algorithm: sha256WithRSAEncryption
```

`Cert Status: good`，序列号与刚送达的证书一致，响应由 CA 签名，并且带着 `thisUpdate`/`nextUpdate` 让客户端知道新鲜度窗口。把 `ssl_stapling off;` 切回去——同样的证书、同样的应答端——客户端看到的就是缺席：

```
OCSP responses: no responses sent
```

这一行就是装订的全部教训，两个状态而已。实验里还有两个确认过的事实，都出乎我意料：

**nginx 拒绝装订「已吊销」的答案。** 我把本地索引翻成 `revoked`，nginx 拒绝发送它：

```
[error] certificate status "revoked" in the OCSP response while requesting certificate status,
        responder: ocsp-responder, certificate: "/certs/fullchain.crt"
```

于是一张已吊销却仍在服务的证书干脆不产生响应，握手继续。以及**不要相信重启**：冷启动后第一次抓取可能落空，我这边的运行里装订是在启动几秒后才出现的。用 `s_client -status` 验证，永远不要用「它重启成功了」代替。

## 真实世界：2026 年的证书到底在做什么

理论告一段落。下面是公开站点真实的服务情况——用的就是上面同样的命令（`openssl x509 -noout -ocsp_uri` 和 `s_client -status`）：

| 站点 | 签发者 | 证书带 OCSP URL | 服务器装订 |
|---|---|---|---|
| aws.amazon.com | Amazon RSA 2048 M04 | 有（`ocsp.r2m04.amazontrust.com`） | **有** |
| blog.awin-x.top | TrustAsia DV TLS RSA CA 2025 | 有（`ocsp.digicert.com`） | 无 |
| github.com | Sectigo | 有（`ocsp.sectigo.com`） | 无 |
| cloudflare.com | Google Trust Services WE1 | 无 | 无 |
| fastly.com | Certainly Intermediate R1 | 无 | 无 |
| letsencrypt.org | Let's Encrypt YE2 | 无 | 无 |

`aws.amazon.com` 是可用的样板：真实的装订响应，`Cert Status: good`，一周的新鲜度窗口：

```
OCSP responses: number of responses: 1
    Cert Status: good
    This Update: Oct 13 14:39:00 2026 GMT
    Next Update: Oct 20 13:39:00 2026 GMT
```

你正在读的这个博客是反面教材：它的证书*确实*带 OCSP URL，而我的边缘服务器至今没有装订。这篇待办清单因此长了一项。表格里的格局就是 2025–2026 年的故事：六张证书里三张完全没有 OCSP URL。Let's Encrypt 在 2024 年 12 月宣布结束 OCSP 支持，2025 年 **5 月 7 日**起新证书不再含 OCSP URL，**2025 年 8 月 6 日**关停应答端。互联网上最大 CA 的吊销信息自此只通过 **CRL** 传播，浏览器从未崩溃，而这些证书的装订成了设计上的未配置项。

所以诚实的结论不是「去开装订」，而是：先看你的证书到底装了什么，再决定配置什么。`openssl x509 -noout -ocsp_uri` 在现代 Let's Encrypt 证书上什么都不打印，因为没有任何东西可装订。行业的赌注完全押向了另一边——短寿命证书：私钥泄露的证书自己很快过期。Let's Encrypt 在 2026 年 1 月上线六天证书，2025 年底把默认寿命压到 45 天，并宣布 2027 年 2 月起默认 64 天。六天的证书不需要靠吊销来保证安全，而 CA 为长期中间证书发布的 CRL 仍然是 CDN 路径上一份签名文件。

## 我在自己服务器上的做法

1. **先问证书**：`openssl x509 -noout -ocsp_uri`。没有 URL 说明装订无从谈起——把精力放在续签自动化上（那是[大规模自动化 TLS](/zh/posts/automated-tls-at-scale/)要解决的一半问题）。
2. **如果有 URL**，那四个指令就值得配：对看重隐私的客户端，隐私收益是真实的，而且请求零成本。
3. **用 `s_client -status` 定期验证**，并在响应不再出现时告警——悄悄消失的装订是典型的 resolver/抓取故障，只看日志你永远发现不了。
4. **不要碰 Must-Staple。** 它在 Let's Encrypt 已死，在浏览器从未普遍实现，它的主要遗产是能把一次过期的装订变成一次宕机。

吊销是 TLS 里最不讨喜的角落：本该起约束作用的机制悄悄「仅供参考」了十年，而服务着 Web 最大份额的 CA 认定最干净的修法是让证书快点过期。同时知道两半——面对仍在提供 OCSP 的 CA 时那个确实有效的装订配置，以及那句告诉你这一切与你的证书是否相关的 `openssl x509 -noout -ocsp_uri`——基本就是这件事的全部了。
