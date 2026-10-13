---
title: "证书透明（Certificate Transparency）：被误签发的证书是怎么被抓到的"
description: "从实践角度解释证书透明机制：用 openssl 从真实证书里解出 SCT、认出签发它的 CT 日志、梳理 Chrome 的强制策略，再查询公开 CT 日志数据，第一时间发现误签发到你域名下的证书。"
pubDate: 2027-01-21
lang: zh
translationKey: certificate-transparency
tags: [security, networking]
featured: false
keywords:
  - 证书透明 Certificate Transparency
  - SCT
  - CT 日志
  - crt.sh
  - 误签发证书
---

我做安全工作，习惯看到那把锁就当它是可信的——而这恰恰是最不该有的直觉。锁值不值钱，取决于它背后那张证书；证书值不值钱，取决于给它背书的那家 CA。一家被攻破、或者只是马虎了的 CA 签给你的银行证书，就是一张**误签发证书**，而在互联网的大半历史上，域名主总是最后一个知道的人。证书透明（Certificate Transparency，CT）改变了这一点：今天每一张公开信任的证书都会被登记进公共 **CT 日志**，证书本身也带着收据——**SCT**——证明它登记过。这篇文章里，我会用 `openssl` 从一张真实证书里挖出真实的 **SCT** 数据，认出签发它的那几座 **CT 日志**，说明浏览器怎么强制这一切，然后做一件 CT 之所以存在的正事：查询公开日志数据，看一个名字下到底签发过哪些证书。协议背景可以看我写的 [TLS 1.3 握手逐步解析](/zh/posts/tls-1-3-handshake/)；`openssl` 基础不熟的话，看我这本 [openssl 命令手册](/zh/posts/openssl-cookbook/)。

## 证书透明到底是什么

在 CT 之前，Web PKI 有一个很要命的缺口：**任何**一家受信任的 CA，都可以给**任何**域名签发证书。如果一家 CA 被攻破、或者验证时出了错，一张 `your-bank.com` 的有效证书就可能流入市面，浏览器照样认，而没人会知道——审计制度也帮不上忙，它审的是流程，不是每一张具体证书。

CT 用一个想法堵住这个缺口：**把签发公开**。CA 想让浏览器认的每一张证书，都要提交给独立的、只能追加的、密码学上可验证的公共日志。作为交换，日志会返还一张 **Signed Certificate Timestamp（SCT）**——一份签名收据，意思是"某时刻 T，我登记了一份为此证书签发承诺"。CA 再把 SCT 嵌进最终证书，浏览器就有权利要求 SCT 全部过关，否则拒绝信任。不对称性正是重点：攻击者照样只能骗到一张证书，但这张证书从此在几秒之内向全世界广播，永远无法收回。

## CT 日志与 Merkle 树模型，一页讲清

一座 **CT 日志**不是你能悄悄删记录的 JSON feed。它是一个 **Merkle 树**数据结构，有几个关键性质：

- **只能追加。** 每张证书（严格说是预证书——往下看）被哈希成树的一个叶子；改写或删除历史几乎不可能。
- **根哈希公开签名。** 日志周期性公布一个 **签名树头（STH）**：树的大小、时间戳、根哈希，用日志私钥签名，任何人都能验证。
- **包含证明。** 给定一张证书，日志能给出 O(log n) 的包含证明——少数几个哈希，证明"这个叶子在以 R 为根哈希的树里"——日志无法抵赖它登记过什么。
- **一致性证明。** 大小为 N 的树头可以被证明与更早的大小为 M 的树头*一致*：什么都没被改写。这就是外部 **监视器** 盯住日志的方式。

数字最能说明规模——接下来我要解剖的那张证书，背后三座日志的签名树头长这样：

```console
$ curl -s https://wyvern.ct.digicert.com/2026h2/ct/v1/get-sth
{"tree_size":2157457519,"timestamp":1791860261426,"sha256_root_hash":"CzdmdaW0nk69cMWhv5IsYmdNz70aQGaQyHV4zx60Dso=","tree_head_signature":"BAMARzBFAiBB..."}

$ curl -s https://ct.googleapis.com/logs/us1/argon2026h2/ct/v1/get-sth
{"tree_size":3428898386,"timestamp":1791860182121,"sha256_root_hash":"BJbjdk+rCIvv5HZTGa+9jqkLLsBUXNUVqsO1ncxQXmE=","tree_head_signature":"BAMASDBGAiEAlrXI..."}

$ curl -s https://sphinx.ct.digicert.com/2026h2/ct/v1/get-sth
{"tree_size":2126174254,"timestamp":1791860263063,"sha256_root_hash":"WEJcjf1SqrAmTPtUXYV7K9+ACBOEIYLMrhDBrIVpMQs=","tree_head_signature":"BAMASDBGAiEAzl9wG..."}
```

Wyvern 里 21.5 亿张证书，Argon 里 34.3 亿张，Sphinx 里 21.3 亿张——凌晨三点，任何人都能白拿，不用账号。

<figure>
  <svg viewBox="0 0 760 200" width="100%" role="img" aria-labelledby="ct-flow-title" xmlns="http://www.w3.org/2000/svg" style="font-family:inherit;color:currentColor;background:none">
    <title id="ct-flow-title">CA 把预证书提交给 CT 日志，拿回嵌入最终证书的 SCT，任何人再监视同一座公开日志里出现的意外证书。</title>
    <defs>
      <marker id="ct-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <g fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="12" y="62" width="120" height="76" rx="8"/>
      <rect x="233" y="40" width="140" height="120" rx="8"/>
      <rect x="490" y="62" width="120" height="76" rx="8"/>
      <rect x="640" y="62" width="108" height="76" rx="8"/>
    </g>
    <g stroke="#0f766e" stroke-width="2" fill="none">
      <path d="M132 100 H225" marker-end="url(#ct-arrow)"/>
      <path d="M373 100 H482" marker-end="url(#ct-arrow)"/>
      <path d="M610 100 H632" marker-end="url(#ct-arrow)"/>
      <path d="M694 62 V28 H60 V62" stroke-dasharray="5 4" marker-end="url(#ct-arrow)"/>
    </g>
    <g fill="currentColor" font-size="13" text-anchor="middle">
      <text x="72" y="86">CA</text>
      <text x="72" y="106" font-size="10">验证域名后，</text>
      <text x="72" y="120" font-size="10">构造预证书</text>
      <text x="303" y="66">CT 日志（公开、</text>
      <text x="303" y="84" font-size="10">Merkle 树，</text>
      <text x="303" y="98" font-size="10">只追加）</text>
      <text x="303" y="120" font-size="11" fill="#0f766e">签发 SCT</text>
      <text x="303" y="136" font-size="10">带时间戳</text>
      <text x="550" y="86">证书</text>
      <text x="550" y="106" font-size="10">内嵌 SCT</text>
      <text x="550" y="120" font-size="10">列表</text>
      <text x="694" y="86">监视器 /</text>
      <text x="694" y="104" font-size="10">域名主</text>
      <text x="694" y="122" font-size="10">盯日志</text>
    </g>
    <g fill="#0f766e" font-size="10.5" text-anchor="middle">
      <text x="178" y="92">预证书</text>
      <text x="427" y="92">SCT</text>
      <text x="377" y="22">读取条目：get-sth / get-entries</text>
    </g>
  </svg>
  <figcaption>CT 的生命周期：CA 的预证书进入公共日志，返回的 SCT 嵌入最终证书，任何人又能监视同一份公开日志数据，发现自己没签发过的证书。</figcaption>
</figure>

## 从 CA 到 SCT：收据是怎么进到证书里的

机制按顺序走：

1. CA 先构造一张**预证书**：打算签发的证书，加上一个关键的"毒"扩展，让它作为正式证书*不可用*——预证书永远不会以外观合法的证书形式流通。
2. CA 把预证书提交给若干座 CT 日志（现在的 CA 一般用五个以上）。
3. 每座日志验证、把它追加进 Merkle 树，然后返还一张 **SCT**：日志 ID、毫秒级时间戳，以及对日志条目的签名。
4. CA 再签出*最终证书*，把 SCT 列表嵌进 OID 为 `1.3.6.1.4.1.11129.2.4.2` 的 X.509v3 扩展（一个 RFC 6962 的 `SignedCertificateTimestampList`，TLS 编码）。

一张 **SCT** 有三种投递方式，浏览器全都接受：**嵌入**证书（最常见，下文演示的就是）、通过握手**内嵌 TLS 扩展**（`signed_certificate_timestamp`）、以及通过 OCSP 装订（Chrome 从 148 版起弃用）。openssl 也能请求并*验证*握手送达的那种——前提是先把各日志的公钥打包给它，用 Chrome 官方日志列表生成一份小 CONF 文件即可：

```console
$ echo | openssl s_client -connect www.cloudflare.com -servername www.cloudflare.com \
    -ct -ctlogfile ctlogs.cnf 2>/dev/null
...
SCTs present (2)
SCT validation status: valid
Signed Certificate Timestamp:
    Version   : v1 (0x0)
    Log       : TrustAsia HETU2027
    Log ID    : ED:DA:EB:81:5C:63:21:34:49:B4:7B:E5:07:79:05:AB:
                D0:D9:31:47:C2:7A:C5:14:6B:3B:C5:8E:43:E9:B6:C7
    Timestamp : Oct 12 21:43:39.679 2026 GMT
...
```

Cloudflare 装订了两张 SCT，openssl 从配置里取到 HETU2027 日志的公钥并验签通过。（另一张显示 "unknown log"：配置里没有那家日志的公钥。"unknown" 只代表"不在我配置里"，绝不等于"无效"。）手里有 SCT，证书才算有效——这正是浏览器下一步要检查的东西。

## 在真实证书里看 SCT

拿这个博客自己的证书当实验品最方便：

```console
$ echo | openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top -showcerts 2>/dev/null
CONNECTED(00000003)
---
Certificate chain
 0 s:CN=blog.awin-x.top
   i:C=CN, O=TrustAsia Technologies, Inc., CN=TrustAsia DV TLS RSA CA 2025
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug 17 00:00:00 2026 GMT; NotAfter: Nov 14 23:59:59 2026 GMT
```

现在把 CT 扩展（OID `1.3.6.1.4.1.11129.2.4.2`）打出来：

```console
$ openssl x509 -in cert00 -noout -text | sed -n '/CT Precertificate SCTs/,/Signature Algorithm: sha256/p'
            CT Precertificate SCTs:
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : C2:31:7E:57:45:19:A3:45:EE:7F:38:DE:B2:90:41:EB:
                                C7:C2:21:5A:22:BF:7F:D5:B5:AD:76:9A:D9:0E:52:CD
                    Timestamp : Aug 17 01:11:10.280 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : D7:6D:7D:10:D1:A7:F5:77:C2:C7:E9:5F:D7:00:BF:F9:
                                82:C9:33:5A:65:E1:D0:B3:01:73:17:C0:C8:C5:69:77
                    Timestamp : Aug 17 01:11:10.245 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : 94:4E:43:87:FA:EC:C1:EF:81:F3:19:24:26:A8:18:65:
                                01:C7:D3:5F:38:02:01:3F:72:67:7D:55:37:2E:19:D8
                    Timestamp : Aug 17 01:11:10.311 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
```

三张 SCT，都是内嵌的，全是 `ecdsa-with-SHA256`。注意时间戳：01:11:10.245、.280 和 .311 GMT——彼此只差 **66 毫秒**。这是 CA 在并行地向三座日志投递预证书；收不齐 SCT，它就没法定稿这张证书。另外记住有效期：2026 年 8 月 17 日到 11 月 14 日共 89 天，后面会用到。

## 认出这些 ID 背后的 CT 日志

裸的日志 ID 没有意义——它只是日志公钥的 SHA-256。官方对照表由 Chrome 公布（`https://www.gstatic.com/ct/log_list/v3/all_logs_list.json`，base64 编码，每日更新）。我把这三个 ID 拿去匹配：

```console
$ curl -s https://www.gstatic.com/ct/log_list/v3/all_logs_list.json -o logs.json
$ # 把每个 base64 log_id 解成十六进制，检索我们那三个 ID：
C2317E57...0E52CD => DigiCert  / DigiCert 'Wyvern2026h2' | https://wyvern.ct.digicert.com/2026h2/
D76D7D10...8C56977 => Google    / Google 'Argon2026h2' log | https://ct.googleapis.com/logs/us1/argon2026h2/
944E4387...372E19D8 => DigiCert  / DigiCert 'Sphinx2026h2' | https://sphinx.ct.digicert.com/2026h2/
```

这张证书登记在**两座 DigiCert 日志和一座 Google 日志**里，都在 notBefore 后几分钟内完成——三个独立的见证者，共同证明这张证书确实存在。

## 浏览器怎么强制 CT

SCT 之所以能形成威慑，是因为缺了它要付出代价——而代价确实存在：**Chrome 和 Safari 都硬性要求公开信任证书满足 CT 合规**（两者都从 2018 年起，此后逐步收紧）。不合规的证书只会拿到一个硬性证书错误（网络错误码 `ERR_CERTIFICATE_TRANSPARENCY_REQUIRED`），而不是一个能点掉的警告。Chrome 的规则是一张值得记住的小表：

| 证书有效期 | 要求的 SCT 数（来自不同 CT 日志） |
|---|---|
| ≤ 180 天 | 2 |
| > 180 天 | 3 |

另外，对**内嵌 SCT** 还有附加条件：至少一张必须来自*检查当时*处于 `Qualified`、`Usable` 或 `ReadOnly` 状态的日志（Chrome 的日志列表一旦过期 70 天，CT 强制就整体关闭），且**至少两张要来自不同的 CT 日志运营者**——这正是 CA 不会把宝全押在一家运营者身上的原因。我们的证书：89 天、3 张 SCT、3 座不同日志、两家运营者（DigiCert ×2、Google ×1）。合规，还留有余量。

但强制只是故事的一半。日志里存着预证书，所以即便是流氓 CA 签给攻击者的证书，也会在几秒内出现在公开数据里——而这份公开可见性，正是你能盯的东西。

## 查询真实的 CT 日志数据

这些日志讲一套 HTTP JSON API（RFC 6962）。两个端点最有用：`get-sth`（前面见过的签名树头）和 `get-entries`（返回原始叶子）。下面是从 Wyvern 日志解出来的两个叶子，各带自己的版本、类型、时间戳和绑定签发者的附加数据：

```console
$ curl -s "https://wyvern.ct.digicert.com/2026h2/ct/v1/get-entries?start=2157429203&end=2157429204" | \
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d).entries;
      for(const en of e){const l=Buffer.from(en.leaf_input,"base64");
        console.log("leaf_input=" + l.length + "B version=" + l[0] + " leaf_type=" + l[1] +
          " entry_type=" + l.readUInt16BE(10) + " timestamp=" + new Date(Number(l.readBigUInt64BE(2))).toISOString() +
          " extra_data=" + Buffer.from(en.extra_data,"base64").length + "B");}})'
leaf_input=1178B version=0 leaf_type=0 entry_type=1 timestamp=2026-10-13T02:39:30.244Z extra_data=3584B
leaf_input=1392B version=0 leaf_type=0 entry_type=1 timestamp=2026-10-13T02:39:30.256Z extra_data=4044B
```

读 TLS 字节有点玄学，但看看它在说什么：两张预证书在 12 毫秒内被钉进树里，各自带时间戳和签发者密钥哈希。`entry_type=1` 表示"预证书"——正是产生我博客上那三张 SCT 的同类对象。API 可见、带时间戳、签名背书：没有黑箱，这正是误签发会被抓住的原因。按主体跨日志检索是监视服务的活儿；Cert Spotter 有公开 API，一次事故排查就是一条 curl：

```console
$ curl -s "https://api.certspotter.com/v1/issuances?domain=blog.awin-x.top&expand=dns_names"
[
	{
		"id": "16554053467",
		"tbs_sha256": "94c4fd813544972b48510491240905f85b13bafb29b996cdb509ca12d0b426c5",
		"cert_sha256": "6a9836bd7e1ffa266112e611449147b2fff3f211e91e40ec7979f9b661bfc135",
		"dns_names": ["blog.awin-x.top"],
		"pubkey_sha256": "6ca6e7bbf6a404fd7aa215aae7e449d1cfee480ad3e7456b8b95e63f418eae3a",
		"not_before": "2026-08-17T00:00:00Z",
		"not_after": "2026-11-14T23:59:59Z",
		"revoked": false
	}
]
```

误签到你的域名下的证书，会出现在这里——SAN 里的每个名字、签发者、有效期窗口。大家最先想到的检索界面是 **crt.sh**（https://crt.sh，同样的数据，JSON 端点：`?q=domain&output=json`）——但请给自动化脚本准备后备方案：我这台测试机上 crt.sh 对每个请求都返回 `502 Bad Gateway`，而上面的日志 API 毫秒级响应。多数据源，正是 CT 的精神。

## 监视自己的域名：一个周期性的 CT 哨兵

一个哨兵就是 25 行 shell。唯一不直觉的细节：**要比对公钥哈希，不是证书哈希**。上面输出里的 `cert_sha256`（`6a9836bd...`）是*预证书*的哈希；线上服务器抓的指纹是最终证书（这里是 `f4319141...`），两者永远对不上。公钥哈希能对上——`6ca6e7bb...` 正对我的服务器出示证书的 SPKI：

```console
$ openssl x509 -in cert00 -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 6ca6e7bbf6a404fd7aa215aae7e449d1cfee480ad3e7456b8b95e63f418eae3a
```

所以：先把你合法持有的每个公钥哈希做成基线，出现新的就告警：

```bash
#!/usr/bin/env bash
# ct-watch.sh DOMAIN —— 基于公开 CT 数据，监控某域名下的新证书
set -euo pipefail
DOMAIN="${1:?usage: ct-watch.sh example.com}"
STATE="$HOME/.ct-watch/$DOMAIN.json"
mkdir -p "$(dirname "$STATE")"

TMP=$(mktemp)
curl -sf --max-time 20 \
  "https://api.certspotter.com/v1/issuances?domain=$DOMAIN&expand=dns_names" -o "$TMP.new" || true

# 新 SPKI = 我们没见过的证书（预期情况：你刚部署了新的密钥）
now=$(jq -r '.[].pubkey_sha256' "$TMP.new" | sort -u)
if [[ -f "$STATE" ]]; then
  joined=$(comm -13 <(sort -u "$STATE") <(printf '%s\n' "$now"))
  [[ -n "$joined" ]] && notify-send "CT watch: $DOMAIN has NEW public keys" "$joined"
fi
printf '%s\n' "$now" > "$STATE"

# SAN 列表（摸清资产面和子域名）
jq -r '.[].dns_names[]' "$TMP.new" | sort -u | tee "$HOME/.ct-watch/$DOMAIN.san.txt"
```

用它挂个每日定时器（systemd、cron、CI 都行）。告警项按严重程度排：

1. **出现你没授权的公钥或签发者**——典型的误签发信号。核实，然后要求 CA 吊销。
2. **SAN 里有你还不拥有的名字**——CA 验证出错，或者有人在试探你；无论哪种，CA 都该知道。

这是事件发现的那一半。顺带的另一半：CT 也是有史以来最好的子域名发现工具——这就引到了人人都要面对的取舍。

## 隐私的代价：CT 会泄露主机名

"全公开"带来的必然推论就是"什么都公开"。CT 日志包含每一张证书的完整 SAN 列表，所以任何人一条 `curl` 就能枚举目标名下的 `vpn.`、`staging.`、`admin.`、`gitlab.` 等子域名。这不是 bug，这就是交易本身：透明就是检测机制。实操上：

- **别以为"藏着没人知道"的名字真被藏住了。** 带公开信任证书的 `staging.corp.example.com`，签发的瞬间就在全球可发现。名字就当它是公开的，改去加固主机。
- **真正内部的名字用私有 PKI 或自签名证书**，让它们永远不进公共 CT 日志。
- **对敏感部署**，反手也用这份数据：暴露出你子域名的同一份 CT 数据，也能在几秒内告诉你，有人签了一张。

## 我的实际收获

证书透明是少有的既便宜又自我强制的控制手段：CA 必须登记，浏览器必须拒收不规矩的证书，误签发的代价从"几天后才有人发现"变成"几秒内公开、永久留存"。下次调 TLS 时用 `openssl` 看看 SCT（[命令手册在此](/zh/posts/openssl-cookbook/)，[握手机制在此](/zh/posts/tls-1-3-handshake/)），然后把日志本身变成对自己域名的一个监视器。数据是公开的，收据是带密码学的——被抓住的，从此就是那张误签发的证书。
