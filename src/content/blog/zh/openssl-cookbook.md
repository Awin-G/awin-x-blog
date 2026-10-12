---
title: "openssl 命令手册：检查、验证并转换证书"
description: "一组实用的 openssl 命令：用 x509 检查证书、验证证书链，再用 openssl s_client 探测线上 TLS 服务器。附 req、verify、pkcs12 的真实输出，以及 PEM/DER/PKCS#12 互转和最常见的那几个坑——叶证书与链、密钥与证书。"
pubDate: 2026-12-04
lang: zh
translationKey: openssl-cookbook
tags: [security, linux]
featured: false
keywords:
  - openssl 命令
  - openssl s_client
  - 检查证书
  - 验证证书链
  - x509
---

我日常就在调 TLS，但直到今天，让我吃惊的是：有相当多的事故最后查出来，只是证书链里错了一个字节。好消息是，要找出它你几乎不需要什么高级工具：**openssl 命令** 就能把 subject、issuer、有效期、SAN 列表，以及这条链到底能不能连起来，全都摊在你面前。这是我反复回来翻的那本手册——怎么 **检查一张证书**、怎么 **验证一条证书链**、怎么把 **openssl s_client** 指向一台线上服务器，每个命令都附上真实输出。

如果你想先弄清楚接下来这些报错 *为什么* 会出现，去读我的 [TLS 错误详解](/zh/posts/tls-errors-explained/)；如果你对 X.509 已经熟门熟路，可以略过。想看这套东西的 SSH 版兄弟，去看 [SSH 证书](/zh/posts/ssh-certificates/)。

下面所有命令，都是我在 `/tmp` 里生成的一把一次性密钥上跑的；不碰第三方主机，不用 sudo，不装任何东西。

## 先搞清楚你在跑哪个 openssl

动手之前先看版本——因为现代的 `openssl` 命令，其实是套着同一个名字的两件工具。

```console
$ openssl version
OpenSSL 3.6.5 29 Sep 2026 (Library: OpenSSL 3.6.5 29 Sep 2026)

$ openssl version -a
built on: Tue Sep 29 15:51:51 2026 UTC
platform: linux-x86_64
OPENSSLDIR: "/etc/ssl"
```

真正会咬人的分界线是 **3.x 与 1.1.1**：

- **3.x 换了个生成密钥的工具名。** `openssl genrsa` 已废弃，请用 `openssl genpkey`。两者都还在，但只有一个代表未来。
- **`-nodes` 变成了 `-noenc`。** "不要加密私钥"现在的写法是 `-noenc`；`-nodes` 还能用，但会提示已废弃。
- **provider 取代了 engine。** `openssl list -providers` 会显示 `default` provider；那些不再被认可的算法（MD5、RC4、老旧密码套件）被挪进一个独立的 `legacy` provider，你得显式加载。
- **报错行的形态变了。** 3.x 打印的是 `error:0A000197:SSL routines:...` 这种新 reason code，老的正则匹配会漏。

1.1.1 从 2023 年起就已 EOL，所以如果你还在用它，这本身就是一条待办问题。

## 造一把一次性密钥和证书

我从不在生产材料上调试。一张自签证书就够练手了：

```console
$ openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out leaf.key
$ openssl req -new -x509 -key leaf.key -days 30 \
    -subj "/CN=test.awin-x.local" \
    -addext "subjectAltName=DNS:test.awin-x.local,DNS:localhost,IP:127.0.0.1" \
    -out leaf.crt
```

两个值得知道的细节：`genpkey -algorithm` 是 3.x 的写法；`-addext`（1.1.1 引入）无需配置文件就能塞进 SAN。注意 `req -x509` 默认会把结果标成 CA——测试无所谓，但真正的服务器证书这么写就错了。为了得到一条像样的链，我还造了一个很小的 CA，并用它签了一张叶证书，也就是后面几节用的那套。

## 检查一张证书：x509 -text -noout

这是整个工具箱里最有用的一个命令。`-noout` 会压掉 base64 blob，只留下人类可读的字段：

```console
$ openssl x509 -in leaf.crt -text -noout
Certificate:
    Data:
        Version: 3 (0x2)
        Signature Algorithm: sha256WithRSAEncryption
        Issuer: CN=test.awin-x.local
        Validity
            Not Before: Oct 12 08:43:38 2026 GMT
            Not After : Nov 11 08:43:38 2026 GMT
        Subject: CN=test.awin-x.local
        Subject Public Key Info:
            Public Key Algorithm: rsaEncryption
                Public-Key: (2048 bit)
        X509v3 extensions:
            X509v3 Basic Constraints: critical
                CA:TRUE
            X509v3 Subject Alternative Name:
                DNS:test.awin-x.local, DNS:localhost, IP Address:127.0.0.1
```

从上往下读：谁签的、活多久、是给谁的、装了哪把公钥、哪些扩展在约束它。大多数时候你只想要其中一片，那就用这些单行提取器：

```console
$ openssl x509 -in leaf.crt -noout -subject -issuer -dates -ext subjectAltName
subject=CN=test.awin-x.local
issuer=CN=test.awin-x.local
notBefore=Oct 12 08:43:38 2026 GMT
notAfter=Nov 11 08:43:38 2026 GMT
X509v3 Subject Alternative Name:
    DNS:test.awin-x.local, DNS:localhost, IP Address:127.0.0.1
```

这一块就是我往工单里粘的那块。要回答"它是不是快过期了？"并写成脚本，用 `-checkend`：

```console
$ openssl x509 -in leaf.crt -noout -checkend 86400 && echo "valid for 24h more"
Certificate will not expire
valid for 24h more
```

证书会在窗口期内过期时，`-checkend` 以非零退出——所以它天生适合做监控。盯 SAN，别盯 CN：浏览器几年前就不再信任只有 CN 的证书了，所以一张 `CN` 写对、却漏了 `DNS:` 条目的证书，是最常见、也最让人窝火的失败。

## 验证一条证书链

**验证证书链** 和读证书是两件不同的工作。一张叶证书只有在能连到 *你信任库里的* 某个根时才被信任——而如果有人忘了发中间证书，它就接不上。

```console
$ openssl verify -CAfile ca.crt srv.crt
srv.crt: OK

$ openssl verify -show_chain -CAfile ca.crt srv.crt
srv.crt: OK
Chain:
depth=0: CN=api.awin-x.local (untrusted)
depth=1: CN=awin-x test CA, O=awin-x
```

`-CAfile` 是信任锚。`-untrusted` 不一样：它提供对端没给你的中间证书，但 **并不** 因此信任它们。只拿中间证书来跑 verify，它会以和真实服务器忘发中间证书时一模一样的方式失败：

```console
$ openssl verify -untrusted ca.crt srv.crt
CN=awin-x test CA, O=awin-x
error 19 at 1 depth lookup: self-signed certificate in certificate chain
error srv.crt: verification failed
```

"Self-signed certificate in certificate chain"几乎总是意味着：服务器发的是它自己的中间证书，或者叶证书是自签的，或者根证书缺失。修的地方在服务器端，不在客户端——把中间证书发出去（但永远别发根）。一个 CA 的 `subject_hash` 等于它叶证书的 `issuer_hash`，这正是 OpenSSL 在哈希目录里找父证书的方式：

```console
$ openssl x509 -in ca.crt -noout -subject_hash
4688f5f1
```

## 用 openssl s_client 探测线上服务器

`openssl s_client` 是客户端的对应物：它开一条 TCP 连接，完成握手，把服务器出示的东西打印出来。一定要带 `-servername`（SNI），否则在共享主机上你会检查到错的那张证书：

```console
$ openssl s_server -accept 127.0.0.1:8446 \
    -cert srv.crt -cert_chain ca.crt -key srv.key -www &

$ echo | openssl s_client -connect 127.0.0.1:8446 \
    -servername api.awin-x.local -showcerts -CAfile ca.crt
Certificate chain
 0 s:CN=api.awin-x.local
   i:CN=awin-x test CA, O=awin-x
 1 s:CN=awin-x test CA, O=awin-x
   i:CN=awin-x test CA, O=awin-x
Verification: OK
Verify return code: 0 (ok)
```

那张 `Certificate chain` 表就是全部故事：第 0 项是叶证书，每个 `s:` 是一个 subject，每个 `i:` 是它的 issuer。如果第 0 项的 issuer 从没在它下面作为 subject 出现过，说明服务器没发中间证书——典型的错误。`-showcerts` 会把服务器发来的所有东西以 PEM 导出，方便你离线细看。

想让 `s_client` 在链有问题时真的 *让进程失败*（脚本和 CI 里有用），加上 `-verify_return_error`。没有信任锚时它会直接拒绝，而不是打个警告继续跑：

```console
$ echo | openssl s_client -connect 127.0.0.1:8446 \
    -servername api.awin-x.local -verify_return_error
verify error:num=20:unable to get local issuer certificate
Verify return code: 20 (unable to get local issuer certificate)
```

`s_client` 是 *被动* 检查：它协商 TLS 然后挂断。除了握手它不登录、不发数据（那个 `echo |` 只是关掉 stdin），所以对自己的主机跑它是安全的。别去戳不属于你的系统。

## 转换格式：PEM、DER 与 PKCS#12

三种容器格式制造了大部分困惑。**PEM** 是夹在 `-----BEGIN ...-----` 之间的 base64 文本；**DER** 是同样数据的原始二进制；**PKCS#12**（`.p12`/`.pfx`）是受密码保护的"密钥 + 证书"打包。

```console
$ openssl x509 -in srv.crt -outform DER -out srv.der      # PEM -> DER
$ file srv.der
srv.der: Certificate, Version=3
$ openssl x509 -in srv.der -inform DER -out srv-from-der.pem   # DER -> PEM
```

就一条规则：如果 `openssl` 报"unable to load certificate"，你就是忘了 `-inform DER`。做一个 **PKCS#12** 包（Windows 和很多设备要的格式）：

```console
$ openssl pkcs12 -export -inkey srv.key -in srv.crt -certfile ca.crt \
    -name "api.awin-x.local" -passout pass:changeit -out srv.p12
$ openssl pkcs12 -in srv.p12 -passin pass:changeit -info -noout
MAC: sha256, Iteration 2048
PKCS7 Encrypted data: PBES2, PBKDF2, AES-256-CBC, Iteration 2048
Certificate bag
Certificate bag
Shrouded Keybag: PBES2, PBKDF2, AES-256-CBC, Iteration 2048
```

## 从 PKCS#12 里导出密钥

反方向才是人们卡住的地方，因为一个 `.p12` 装着好几个对象，你必须点名你要哪个。要把私钥以不加密的形式取出来：

```console
$ openssl pkcs12 -in srv.p12 -passin pass:changeit \
    -nocerts -nodes -out extracted.key
$ head -1 extracted.key
Bag Attributes
```

`-nocerts` 表示只要密钥，`-nodes` 表示不要给输出再加密一遍，另外注意 `Bag Attributes` 这几行——它们说明提取成功了，底层文件仍是合法的 PEM。要取证书而不是密钥，把参数换成 `-clcerts -nokeys`：

```console
$ openssl pkcs12 -in srv.p12 -passin pass:changeit \
    -clcerts -nokeys -out extracted.crt
$ openssl x509 -in extracted.crt -noout -subject
subject=CN=api.awin-x.local
```

## 生成并签发一个 CSR

**CSR** 是一把公钥加上你想要的那些名字，并由配对的私钥签名，好让 CA 知道这把密钥确实在你手里。用 `req -new` 生成：

```console
$ openssl req -new -key srv.key -subj "/CN=blog.awin-x.local" -out blog.csr
$ openssl req -in blog.csr -noout -verify -subject
Certificate request self-signature verify OK
subject=CN=blog.awin-x.local
```

`req -noout -verify` 会校验那个自签名——在 CSR 送到 CA 之前，这是快速发现损坏或密钥不匹配的办法。然后 CA 来签它（`x509 -req`），并把你申请的扩展拷进去：

```console
$ openssl x509 -req -in blog.csr -CA ca.crt -CAkey ca.key \
    -CAcreateserial -days 90 -copy_extensions copy -out blog.crt
Certificate request self-signature ok
subject=CN=blog.awin-x.local
```

## 指纹与哈希

**指纹（fingerprint）** 钉住的是某一张确切的证书——它是 DER 字节的哈希，不是 subject。你要用 SHA-256，绝不要 SHA-1：

```console
$ openssl x509 -in srv.crt -noout -fingerprint -sha256
sha256 Fingerprint=BC:12:24:B5:2E:43:1B:F6:63:33:61:05:EE:4D:C2:60:6E:98:78:BF:D3:A4:60:E0:13:2E:9C:3D:8E:45:A4:7A
```

记住两点。第一，任何东西一变指纹就变——续期会产生新指纹，所以钉叶证书会逢轮换必断；改钉 CA 或公钥。第二，这个指纹是针对 **证书** 而非密钥的，所以它不是密钥指纹，没法拿去和私钥文件比对。要比对，就直接比公钥：

```console
$ openssl x509 -in srv.crt -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 5c03e514747a9ef4cca158a2a57fa11043d9c9ec5140b301cfff61132fc6a367
$ openssl pkey -in srv.key -pubout -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 5c03e514747a9ef4cca158a2a57fa11043d9c9ec5140b301cfff61132fc6a367
```

哈希一致，说明密钥和证书是一对。

## 常见混淆：叶证书与链、密钥与证书

这么多年，最耗我时间的是这三种混：

- **叶证书 vs 链。** 叶证书是一张；链是叶证书加中间证书。服务器必须发中间证书，客户端必须已持有根证书。服务器上只放一张证书，是"curl 能过、Java 不过"的头号原因。
- **密钥 vs 证书。** `.key` 是秘密，永不发送；`.crt` 是公开的，每次握手都发。把工具指错文件，它会大声报错——`openssl x509 -in srv.key` 说 `Could not find certificate`，`openssl pkey -in srv.crt` 说 `Could not find private key`。那不是文件损坏，是文件类型不对。
- **Subject vs SAN。** 身份如今住在 `subjectAltName` 里。CN 只是装饰。

还有一个格式混：PEM 与 DER。以 `-----BEGIN` 开头的文本是 PEM；以 `0x30` 字节开头的文件是 DER。拿不准时，`openssl x509 -in file -noout -subject` 能告诉你它到底加载成功没有。

把下面这六个钉死，几乎任何 TLS 问题你都能在 shell 里诊出来：`version`、`x509 -text -noout`、`verify -CAfile`、`s_client -connect -servername -showcerts`、`pkcs12`、`x509 -fingerprint -sha256`。等这套检查成了肌肉记忆，[TLS 错误详解](/zh/posts/tls-errors-explained/) 里的报错就不再吓人，而变成一张清单。
