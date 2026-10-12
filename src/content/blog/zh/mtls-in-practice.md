---
title: "mTLS 实战：握手、命令，以及那些坑"
description: "用 openssl 搭一套极小的 PKI，让 nginx 通过 ssl_verify_client 强制要求客户端证书（client certificate），再用 curl 与 openssl s_client 验证握手，并绕开 EKU、SAN、证书链与吊销这几个最容易踩的坑。"
pubDate: 2026-12-13
lang: zh
translationKey: mtls-in-practice
tags: [security, networking, nginx]
featured: false
keywords:
  - mTLS
  - 双向 TLS
  - 客户端证书
  - ssl_verify_client
  - EKU clientAuth
---

我手里有个小小的私有 API，只有几台机器该访问它，而我不想发那种能被人从磁盘上拷走的 bearer token。双向 TLS（**mTLS**）正好补上这个缺口：服务器照旧证明自己的身份，而客户端也用一张**客户端证书**向服务器证明自己的身份。它的机制就是一次普通的 TLS 握手、中间多一轮交换——所以一旦理解，加进来很便宜；可一旦证书扩展写错，排查起来就很贵。下面我用 `openssl` 搭一套用完即弃的 CA，让 **nginx** 通过 **`ssl_verify_client`** 强制要求客户端证书，并贴出真实的握手：成功、失败，以及检查命令。想补协议基础，先读 [TLS 1.3 握手](/zh/posts/tls-1-3-handshake/)；想了解密钥与证书底层操作，把 [openssl 手册](/zh/posts/openssl-cookbook/) 放在旁边。

## 双向 TLS 相比你已有的那把锁，多了什么

你每天都在用的 TLS 是**单向**的：服务器出示证书，你的客户端校验它，而在你发出密码或 token 之前，服务器根本不知道你是谁。**双向 TLS** 把这个闭环补上——两端都在传输层完成认证，在解析哪怕一个字节的应用协议之前。在 TLS 1.3 里，服务器只多发一条消息 `CertificateRequest`（curl 把它打印成 `Request CERT (13)`），客户端则用自己的 `Certificate` 和一次证明自己握有私钥的 `CertificateVerify` 签名作答。

这带来了三样 token 给不了的东西。身份绑定在**私钥**上，而不是一个可以复制的字符串。没有可供钓鱼的共享秘密——偷到 token 能重放，但偷到客户端证书却没有对应私钥就毫无用处。而且认证发生在 TLS 内部，所以它也能保护那些本身没有认证机制可言的协议。

<figure>
<svg viewBox="0 0 720 344" width="100%" role="img" aria-label="A lab CA signs two certificates: a server certificate with SAN localhost and EKU serverAuth, and a client certificate with SAN device-42 and EKU clientAuth. In the handshake below, the curl client and nginx server exchange ClientHello, ServerHello with Certificate and CertificateRequest, and the client Certificate plus Finished, with both sides verifying the peer chain against the CA.">
  <defs>
    <marker id="mtls-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="mtls-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="20" y="24" width="176" height="60" rx="7"/>
    <rect x="272" y="20" width="176" height="68" rx="8"/>
    <rect x="524" y="24" width="176" height="60" rx="7"/>
    <rect x="20" y="248" width="176" height="76" rx="7"/>
    <rect x="524" y="248" width="176" height="76" rx="7"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="272" y1="54" x2="200" y2="50" marker-end="url(#mtls-arrow-accent)"/>
    <line x1="448" y1="54" x2="520" y2="50" marker-end="url(#mtls-arrow-accent)"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <line x1="196" y1="272" x2="520" y2="272" marker-end="url(#mtls-arrow)"/>
    <line x1="524" y1="294" x2="196" y2="294" marker-end="url(#mtls-arrow)"/>
    <line x1="196" y1="316" x2="520" y2="316" marker-end="url(#mtls-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">
    <text x="36" y="46">server.crt</text>
    <text x="36" y="62">SAN DNS:localhost, IP:127.0.0.1</text>
    <text x="36" y="78">EKU serverAuth</text>
    <text x="288" y="46">awin-x lab CA</text>
    <text x="288" y="64">basicConstraints CA:TRUE</text>
    <text x="288" y="80">ca.key offline</text>
    <text x="540" y="46">client.crt</text>
    <text x="540" y="62">SAN DNS:device-42</text>
    <text x="540" y="78">EKU clientAuth</text>
    <text x="36" y="290">curl  (client)</text>
    <text x="36" y="310">--cert client.crt --key client.key</text>
    <text x="540" y="290">nginx  (server)</text>
    <text x="540" y="310">ssl_verify_client on</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">
    <text x="236" y="40" text-anchor="middle">signs</text>
    <text x="484" y="40" text-anchor="middle">signs</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.85">
    <text x="360" y="262" text-anchor="middle">ClientHello</text>
    <text x="360" y="284" text-anchor="middle">ServerHello + Certificate + CertificateRequest</text>
    <text x="360" y="306" text-anchor="middle">Client Certificate + Finished</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">
    <text x="360" y="340" text-anchor="middle">both sides verify the peer chain against the CA's public key</text>
  </g>
</svg>
<figcaption>同一个 CA 签发两种身份。握手中，服务器向客户端索要证书，客户端出示自己的证书，双方各自用 CA 的公钥校验对方的证书链。</figcaption>
</figure>

## PKI 的几块拼图：一个 CA、两张证书，以及几个关键的扩展

双向 TLS 只需要三样东西：一个两端都信任的 **CA**、一张由它签发的**服务器证书**、一张由它签发的**客户端证书**。CA 的私钥能凭空铸造身份，所以它要么离线保存、要么放进 HSM，对外只分发它的公开证书。有两个扩展承担了主要工作，而两者都很容易写错。**EKU（`extendedKeyUsage`）** 声明一张证书*被允许做什么*——服务器证书需要 `serverAuth`，客户端证书需要 **`clientAuth`**，检查用途的校验器会拒绝写错的那张。**SAN（`subjectAltName`）** 是现代工具寻找身份的地方：对服务器来说，它必须包含客户端连接用的域名（和/或 IP）。

## 用 openssl 搭一套极小的 PKI

CA 需要 `basicConstraints CA:TRUE`（它有权签发证书）和 `keyUsage keyCertSign,cRLSign`（它有权签发证书和吊销列表）。注意这里的 `pathlen:0`——对一个只签发叶证书的根来说它是对的，而后文我会展示它会破坏什么。

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=awin-x lab CA/O=awin-x" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt

openssl x509 -in ca.crt -noout -subject
# subject=CN=awin-x lab CA, O=awin-x
```

每张叶证书都带着自己的 SAN 与 EKU；把 EKU 的方向写反了，就什么都验不过。

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -new -key server.key -subj "/CN=localhost/O=awin-x lab" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -sha256 \
  -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n") -out server.crt
# ...and the same for client.key / client.crt, with:
#   extendedKeyUsage=clientAuth    subjectAltName=DNS:device-42
```

确认每个文件里到底落进了什么；永远别假设 `-extfile` 生效了：

```text
$ openssl x509 -in server.crt -noout -ext subjectAltName,extendedKeyUsage
X509v3 Extended Key Usage: TLS Web Server Authentication
X509v3 Subject Alternative Name: DNS:localhost, IP Address:127.0.0.1
$ openssl x509 -in client.crt -noout -ext extendedKeyUsage
X509v3 Extended Key Usage: TLS Web Client Authentication
```

## 在 nginx 里用 ssl_verify_client 强制要求客户端证书

四条指令。`ssl_client_certificate` 是 nginx 用来*校验客户端*的 CA——它不是服务器自己的证书。

```nginx
server {
  listen 8443 ssl;
  ssl_certificate     /pki/server.crt;
  ssl_certificate_key /pki/server.key;
  ssl_client_certificate /pki/ca.crt;   # CAs allowed to verify clients
  ssl_verify_client      on;            # on | optional | optional_no_ca
  ssl_verify_depth       2;             # root -> intermediate -> leaf
  location / {
    default_type text/plain;
    return 200 "hello\nclient_dn=$ssl_client_s_dn\nverify=$ssl_client_verify\n";
  }
}
```

`on` 会拒绝任何没有有效客户端证书的请求；`optional` 会索要但不强制；`optional_no_ca` 会接受一张未经验证的证书、留给你自己校验——很少是个好主意。在应用里，`$ssl_client_s_dn` 是已验证的身份，`$ssl_client_verify` 则是 `SUCCESS` 或一个错误。

## 从客户端验证：curl --cert 与 openssl s_client

持有证书和密钥的客户端就能进来（`--cacert` 是 curl 用来信任*服务器*的）：

```bash
$ curl -sS --cacert ca.crt --cert client.crt --key client.key https://localhost:8443/
hello
client_dn=O=awin-x lab,CN=device-42
verify=SUCCESS
```

不带客户端证书，nginx 就用一个 HTTP `400` 响应体拒绝——在 TLS 1.3 里客户端证书是*最后一个*飞行，所以应用层是第一个能抱怨它的地方：

```bash
$ curl -sS --cacert ca.crt https://localhost:8443/
<head><title>400 No required SSL certificate was sent</title></head>
```

`curl -v` 会显示这轮多出来的交换是如何夹在普通握手消息之间的：

```bash
$ curl -v --cert client.crt --key client.key --cacert ca.crt https://localhost:8443/ 2>&1 | grep TLS
* TLSv1.3 (IN), TLS handshake, Request CERT (13):
* TLSv1.3 (OUT), TLS handshake, Certificate (11):
* TLSv1.3 (OUT), TLS handshake, CERT verify (15):
* TLSv1.3 (OUT), TLS handshake, Finished (20):
```

要看更多细节就用 `openssl s_client`。加上 `-cert`/`-key`，并读 **`Acceptable client certificate CA names`** 那一段——服务器就是靠它告诉客户端它会接受哪个 CA，而客户端也靠它从证书库里挑出正确的一张：

```bash
$ openssl s_client -connect 127.0.0.1:8443 -servername localhost \
    -CAfile ca.crt -cert client.crt -key client.key </dev/null 2>&1
 0 s:CN=localhost, O=awin-x lab
   i:CN=awin-x lab CA, O=awin-x
Acceptable client certificate CA names
CN=awin-x lab CA, O=awin-x
Protocol: TLSv1.3
Verify return code: 0 (ok)
```

要检查服务器出示的**对端**证书，就把这段输出管给 `x509`——一条证书链“看起来不对”时，我伸手就是这条命令：

```bash
$ openssl s_client ... 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName
subject=CN=localhost, O=awin-x lab
issuer=CN=awin-x lab CA, O=awin-x
X509v3 Subject Alternative Name: DNS:localhost, IP Address:127.0.0.1
```

## 用 openssl verify 检查每一块拼图

在怪罪 TLS 之前，先把证书单独验一遍。`openssl verify` 会走一遍证书链，并且能强制一个 **purpose（用途）**——而这恰好就是 TLS 服务器做的检查：

```bash
$ openssl verify -CAfile ca.crt server.crt client.crt
server.crt: OK
client.crt: OK
$ openssl verify -CAfile ca.crt -purpose sslclient client.crt
client.crt: OK
$ openssl verify -CAfile ca.crt -purpose sslclient bad-eku.crt
error 26 at 0 depth lookup: unsuitable certificate purpose
error bad-eku.crt: verification failed
```

`-purpose sslclient` 就是 nginx 用你那包 `ssl_client_certificate` 所做检查的离线等价物，也是不碰服务器就能抓到 EKU bug 的最快办法。

## 吊销，以及为什么短命证书胜过 CRL

客户端密钥泄露时，经典答案是 **CRL**：CA 发布一份签名过的、列着被吊销序列号的清单。先吊销，再签出清单：

```bash
$ openssl ca -config openssl-ca.cnf -revoke client.crt -keyfile ca.key -cert ca.crt
Revoking Certificate 15D7D16F84A29F40799C99925FDD22621E900D99.
$ openssl ca -config openssl-ca.cnf -gencrl -keyfile ca.key -cert ca.crt -out ca.crl
```

而如果校验方真的去查了它，吊销就生效了：

```bash
$ openssl verify -CAfile ca.crt -CRLfile ca.crl -crl_check client.crt
error 23 at 0 depth lookup: certificate revoked
error client.crt: verification failed
$ openssl verify -CAfile ca.crt client.crt      # no -crl_check
client.crt: OK
```

最后这一对就是陷阱：**CRL 除非有人去查，否则毫无作用。** 在加上 `ssl_crl /pki/ca.crl;` 之前，我的 nginx 一直乐呵呵地接受那张已被吊销的客户端证书（`verify=SUCCESS`）；加上之后它才开始回 `400 The SSL certificate error`。正因如此，我在 mTLS 里更偏爱**短命证书**。CRL 是一个**拉取**机制，每个校验方都得去取、缓存，并自己判断“多旧算太旧”——漏掉一次刷新，吊销就悄无声息地失效了。而一张有效期只有 24 小时的证书根本不需要吊销故事：不管怎样它明天就死了，你靠*不续期*来“吊销”。

```bash
# Renew hourly; the client hot-reloads the files.
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 2 -sha256 -extfile <(printf "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n") \
  -out client.crt.new && mv client.crt.new client.crt
```

## 花掉我一下午的那些坑

下面每一条都在我写这篇时真实地绊过我，而且每条都有一个独特的报错：

- **EKU `clientAuth` 写错或缺失。** 只带 `serverAuth` 的客户端证书会被拒绝（`400 The SSL certificate error`；离线则是 `error 26 unsuitable certificate purpose`）。更阴险的情况是**完全没有 EKU**：OpenSSL 把它当作“任何用途”并接受它（`bad-eku-free.crt: OK`），于是 mTLS 照常工作，你永远没发现这张证书权限过宽。
- **SAN 不匹配。** 如果你连接的名字不在服务器的 SAN 里，客户端会拒绝：`error 62 hostname mismatch`。在现代校验器里，`CN` 不是它的替代品。
- **证书链没有发送。** 只发叶子证书的服务器会让只持有根证书的客户端失败：`error 20 unable to get local issuer certificate`。必须把每一级中间证书都打包进去（`ssl_certificate` 要指向 `cat leaf.crt intermediate.crt`）。
- **给会签发中间证书的 CA 设了 `pathlen:0`。** 我的根证书带着 `pathlen:0`，两级证书链就报 `error 25 path length constraint exceeded`——这个本该阻止*子* CA 继续签发 CA 的约束，同时挡住了你自己。
- **吊销从未接线。** 在设上 `ssl_crl` 之前，一张被吊销的证书会一直能用；吊销默认是惰性的。
- **代理吃掉了客户端证书。** 当负载均衡终止 TLS 时，是*它*在验证客户端，你的后端只看到被代理过来的请求。把 `$ssl_client_s_dn` / `$ssl_client_verify` 作为头转下去并在边缘校验，否则你得到的是“代理处有 mTLS、背后却是匿名 HTTP”。
- **PEM 与 DER，以及 `--key`。** curl 和 nginx 要 PEM；有些 SDK 输出 DER（`openssl x509 -in cert.der -inform DER -out cert.pem`）。发了证书却没提供对应密钥，你得到的会是签名失败，而不是一条清晰的错误。

## mTLS 什么时候值得，什么时候 token 更好

mTLS 在你两端都可控、且希望身份绑定在密钥上时物有所值：服务到服务的调用、一群设备或 agent、内部管理端点，以及任何“网络位置”不能等同于“可信”的零信任路径。它认证的是信道本身，所以也能保护非 HTTP 协议。当另一端是**浏览器**或你不掌控的第三方时，它就是错的工具——用户不会去装客户端证书，而在一群不受信的人群里分发和吊销证书本身就是个项目。那种场景下，带短有效期和 refresh token 的 OAuth 或 JWT 能给出更快的吊销，且无需分发密钥。两者还能组合：在边缘用 mTLS 终止以确定机器身份，再在应用层用 JWT 承载人的身份。

## 我实际会查什么

1. `curl -v --cert ... --key ... --cacert ...`，找 `Request CERT (13)`——如果没有它，服务器压根没索要客户端证书。
2. `openssl s_client -cert ... -key ...`，读 `Acceptable client certificate CA names` 和 `Verify return code`。
3. `openssl verify -CAfile ca.crt -purpose sslclient client.crt`，把 EKU 或证书链问题从 TLS 问题里隔离出来。
4. 确认服务器确实发了它的中间证书，并确认客户端信任的和服务器被签发所在的，是同一个根。
5. 最后才去看吊销和有效期。

双向 TLS 并不复杂——一个 CA 加两张带对扩展的证书。复杂之处藏在那些坑里，而它们每一个现在都会以一个你能读懂的具体错误码现身。
