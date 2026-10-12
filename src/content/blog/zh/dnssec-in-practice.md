---
title: "DNSSEC 实战：签名一个区域并亲眼看验证失败"
description: "一次完整的 DNSSEC 实践：用 BIND 内联签名对真实区域签名，检查 DNSKEY/RRSIG/DS/NSEC 记录，通过验证解析器观察 ad 标志，故意破坏信任链后看 SERVFAIL，并了解密钥轮换为何让 DNSSEC 运维如此痛苦。"
pubDate: 2027-01-13
lang: zh
translationKey: dnssec-in-practice
tags: [networking, security]
featured: false
keywords:
  - DNSSEC
  - RRSIG
  - 信任链
  - DNSSEC 验证
  - DS 记录
---

DNSSEC 是一个所有人都同意重要、但几乎没人真正看过它运行的协议。我运行权威 DNS 已经好几年了——参见
[DNS 是如何解析的](/zh/posts/how-dns-resolves/) 和
[区域传输 AXFR](/zh/posts/dns-zone-transfer-axfr/)——但我从来没有
真正地对一个区域做过签名，然后故意破坏它来看看会发生什么。
所以我启动了一个临时的 BIND 服务器（仅绑定回环地址），签名了一个小区域，
用真实解析器验证它，然后故意破坏信任链看验证失败。
这篇文章就是我希望自己第一次学 DNSSEC 时就能读到的教程。

## DNSSEC 做什么（和不做什么）

DNSSEC 为 DNS 增加了**源认证**和**数据完整性**。它回答两个问题：
*这个回答真的来自区域所有者吗？* 和 *它在传输过程中被篡改了吗？*
它通过一条从 DNS 根开始、经过 TLD 委派、最终到达你区域的加密签名链来做到这些。

它**不**做的事：DNSSEC 完全不提供隐私。每条记录、每个签名、每把密钥
都以明文传输。链路上的任何人都能看到你查询了哪些名称。如果你想要隐私，
那是 [DNS-over-HTTPS / DNS-over-TLS](/zh/posts/encrypted-dns/)——
一个完全不同的问题。DNSSEC 解决的是信任，不是机密性。

## 记录类型：DNSKEY、RRSIG、DS 和 NSEC

四种记录类型使 DNSSEC 成为可能：

- **DNSKEY** —— 公钥。每个区域至少有一把密钥签名密钥（KSK，标记为
  `257`），用于签名其他密钥；以及一把或多把区域签名密钥（ZSK，标记为
  `256`），用于签名实际的区域数据。可以把它理解为密钥层次结构：KSK 是
  交给父区域的密钥，ZSK 负责日常的签名工作。
- **RRSIG** —— 签名。每个 RRset（同类型同名称的记录组）都有一个覆盖它的
  RRSIG。RRSIG 包含签名、算法、密钥标签和过期时间。如果你更改了 RRset
  中的任何记录，就必须重新签名。
- **DS 记录** —— KSK 的哈希，发布在*父*区域中。这就是信任链中的环节。
  父区域声明"子区域的 KSK 应该长这样"，验证器将子区域的实际 DNSKEY
  与此哈希进行比对。
- **NSEC / NSEC3** —— 不存在的证明。当你查询一个不存在的名称时，NSEC
  返回最接近的现有名称，并证明它们之间什么都没有。NSEC3 对名称进行哈希
  以防止简单的区域遍历，但代价是增加了额外的复杂性。

## 信任链：从根到区域

<figure>
<svg viewBox="0 0 600 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="从根到 TLD 再到区域的 DNSSEC 信任链">
  <defs>
    <style>
      .box { fill: #f0fdfa; stroke: #0f766e; stroke-width: 2; rx: 8; }
      .arrow { stroke: #0f766e; stroke-width: 2; fill: none; marker-end: url(#head); }
      .label { font-family: system-ui, sans-serif; font-size: 13px; fill: #134e4a; }
      .sublabel { font-family: system-ui, sans-serif; font-size: 11px; fill: #0f766e; }
    </style>
    <marker id="head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#0f766e"/>
    </marker>
  </defs>

  <!-- Root -->
  <rect class="box" x="220" y="10" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="32" text-anchor="middle">根 (.)</text>
  <text class="sublabel" x="300" y="48" text-anchor="middle">KSK → TLD 的 DS</text>

  <!-- Arrow root to TLD -->
  <path class="arrow" d="M300,60 L300,90"/>

  <!-- TLD -->
  <rect class="box" x="220" y="90" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="112" text-anchor="middle">TLD (.com)</text>
  <text class="sublabel" x="300" y="128" text-anchor="middle">KSK → 区域的 DS</text>

  <!-- Arrow TLD to zone -->
  <path class="arrow" d="M300,140 L300,170"/>

  <!-- Zone -->
  <rect class="box" x="220" y="170" width="160" height="50" rx="8"/>
  <text class="label" x="300" y="192" text-anchor="middle">区域 (example.com)</text>
  <text class="sublabel" x="300" y="208" text-anchor="middle">ZSK 签名所有 RRset</text>
</svg>
<figcaption>信任链：每一层通过发布 DS 记录（子区域 KSK 的哈希）来委派给下一层。验证器从根开始向下验证，检查每个环节。</figcaption>
</figure>

验证器从根区域的 KSK 开始——一个你配置为信任锚的密钥（或者随解析器
一起发布的密钥）。它验证 TLD 的 DS 与根的委派匹配，然后验证你区域的 DS
与 TLD 的委派匹配，最后验证你区域中的 RRSIG 与你的 DNSKEY 匹配。每一步
都是签名验证。任何一环断裂，整条链就失败。

## 用内联签名对区域签名

我在 Docker 中使用 BIND 9.18 绑定回环地址（`127.0.0.1:15353`）。配置的
关键部分：

```named
dnssec-policy "lab-policy" {
    keys {
        ksk lifetime P180D algorithm ecdsap256sha256;
        zsk lifetime P90D algorithm ecdsap256sha256;
    };
    signatures-refresh P14D;
    signatures-validity P21D;
};

zone "dnssec-lab.example" {
    type primary;
    file "/var/cache/bind/dnssec-lab.example.db";
    key-directory "/var/cache/bind/keys";
    inline-signing yes;
    dnssec-policy "lab-policy";
    journal "/var/cache/bind/dnssec-lab.example.db.journal";
};
```

`inline-signing yes` 意味着 BIND 在内存中对区域进行签名——磁盘上的区域
文件保持未签名状态，BIND 从内存加 journal 提供签名后的版本。当 BIND 以
这个策略启动时，它自动生成 KSK 和 ZSK，对每个 RRset 签名，并启动密钥
事件计时器用于轮换。

启动后，密钥就存在了：

```console
# ls /var/cache/bind/keys/
Kdnssec-lab.example.+013+06758.key    # KSK
Kdnssec-lab.example.+013+06758.private
Kdnssec-lab.example.+013+12610.key    # ZSK
Kdnssec-lab.example.+013+12610.private
```

查询 DNSKEY 记录：

```console
# dig @127.0.0.1 -p 15353 dnssec-lab.example DNSKEY +noall +answer
dnssec-lab.example.  3600  IN  DNSKEY  257 3 13 Qn7j7gOj5Cip060IT57fIChO3AIizRSE6KTqE+O8cFuqoVroLtog1ZzvSYoOdwM/f4aETvWnZToYYhuhnQCi6w==
dnssec-lab.example.  3600  IN  DNSKEY  256 3 13 S+M6QjU1xU0CgZsIeAjVi5gAt34H6p+pNmK80YCMf8gUESdnRucr60XvyjviSfeeKiqP17BPMaiTibZKLakq/Q==
```

两把密钥：`257`（KSK）和 `256`（ZSK），都是 ECDSA P-256 配 SHA-256
（算法 `13`）。KSK 的哈希值放入父区域的 DS 记录中。

从 KSK 生成 DS 记录——这是你交给注册商或发布到父区域的内容：

```console
# dnssec-dsfromkey /var/cache/bind/keys/Kdnssec-lab.example.+013+06758.key
dnssec-lab.example. IN DS 6758 13 2 1D548D007BFE3C245A35691B77A0ADB9A34F7E4A0BAF52E38315FEBF3668FF0C
```

`2` 是摘要类型（SHA-256）。长十六进制字符串是 KSK 的 DNSKEY rdata 的哈希。

现在区域中的每个回答都携带签名。用 `+dnssec` 查询 A 记录：

```console
# dig @127.0.0.1 -p 15353 www.dnssec-lab.example A +dnssec +noall +answer
www.dnssec-lab.example.  300  IN  A      192.0.2.100
www.dnssec-lab.example.  300  IN  RRSIG  A 13 3 300 20261102182703 20261012212032 12610 dnssec-lab.example. seFdliw1hffFqbe4PUW8yC7auJwtjDM0h6/SNJIbqF3SNnrYupvgot3U/+DvIgeS02hsKKXdxFZtYcMzAv1KQQ==
```

RRSIG 表示：这个 A RRset 由密钥 `12610`（ZSK）签名，算法为 `13`，
签名有效期至 `20261102182703`。如果你篡改了 IP 地址，签名将不再匹配。

对于不存在的名称，NSEC 提供证明：

```console
# dig @127.0.0.1 -p 15353 nonexistent.dnssec-lab.example A +dnssec +noall +authority
dnssec-lab.example.  300  IN  NSEC  api.dnssec-lab.example. NS SOA RRSIG NSEC DNSKEY TYPE65534
dnssec-lab.example.  300  IN  RRSIG NSEC 13 2 300 20261102204709 20261012212032 12610 dnssec-lab.example. WD79OOv4u6o1QRae3rdSdtXtBnoAK9Un9mS2FCrXfsGhjbWUCW/1tUb5bAaH0RLeFNUzt18RUkdx7TXbkdZ+Zg==
```

`dnssec-lab.example.` 处的 NSEC 记录指向 `api.dnssec-lab.example.` 作为
下一个存在的名称，证明 `nonexistent.dnssec-lab.example.` 不存在。它也是
签名的——没有 ZSK 你不能伪造 NXDOMAIN。

## DNSSEC 验证如何工作：ad 标志

一个验证解析器（如 Cloudflare 的 `1.1.1.1` 或 Quad9 的 `9.9.9.9`）从根
开始沿信任链向下验证。如果每个签名都验证通过，它会在响应中设置
**已认证数据**（`ad`）标志。

通过验证解析器查询一个真实签名区域：

```console
# dig @1.1.1.1 cloudflare.com A +dnssec +noall +answer
cloudflare.com.  102  IN  A      104.16.133.229
cloudflare.com.  102  IN  A      104.16.132.229
cloudflare.com.  102  IN  RRSIG  A 13 2 300 20261013232059 20261011212059 34505 cloudflare.com. CRZ11hpf69+l4qVHRkxS6Oglebm3yq20vvQCyihIbgvOGN12HaE5HniFuaXiMb6WTqmbplCc9MUTDE6Y+KTnNA==
```

头部说明了一切：

```
;; flags: qr rd ra ad; QUERY: 1, ANSWER: 3, ...
```

那个 `ad` 标志意味着：解析器将 RRSIG 与区域的 DNSKEY 进行了验证，将
DNSKEY 与父区域中的 DS 进行了验证，将 DS 与父区域的 DNSKEY 进行了验证，
依此类推一直到根。信任链完整。回答是经过认证的。

再用 `internet.nl` 举个例子：

```console
# dig @1.1.1.1 internet.nl A +dnssec +noall +answer
internet.nl.  3600  IN  A      62.204.66.10
internet.nl.  3600  IN  RRSIG  A 13 2 3600 20261022181337 20261008174412 22707 internet.nl. ZcI+3+M+SlioaOc7oNgB5hcSSD7k3OJv0BSzxtrW+cTAd2wzC5dswGTLAVnyKm5GOK33y+QYKocGO5cW0+36Aw==
```

同样的故事：`ad` 标志，有效的 RRSIG，信任链完好。

## 当 DNSSEC 失败时：SERVFAIL 和 Bogus

现在是每个人都应该至少看一次的部分：当信任链断裂时会发生什么。我使用
`dnssec-failed.org`，一个故意配置为 DNSSEC 链断裂的区域，这样你可以观看
验证器如何拒绝它。

通过验证解析器（`1.1.1.1`）查询：

```console
# dig @1.1.1.1 dnssec-failed.org A +dnssec +noall +comments +answer
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 57147
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, ...

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags: do; udp: 1232
; EDE: 9 (DNSKEY Missing): (no SEP matching the DS found for dnssec-failed.org.)
```

**SERVFAIL**。解析器尝试验证，在父区域中找到了 `dnssec-failed.org` 的
DS 记录，但区域的 DNSKEY 与该 DS 哈希不匹配。信任链断裂，所以解析器
拒绝回答。`EDE: 9` 是扩展 DNS 错误码——`DNSKEY Missing`——确切地告诉你
原因。

现在看关键对比：用 `+cd`（禁用检查）标志查询，告诉解析器跳过验证：

```console
# dig @1.1.1.1 dnssec-failed.org A +dnssec +cd +noall +comments +answer
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 65506
;; flags: qr rd ra cd; QUERY: 1, ANSWER: 2, ...

dnssec-failed.org.  300  IN  A      96.99.227.255
dnssec-failed.org.  300  IN  RRSIG  A 13 2 300 20261015015706 20261007225206 32784 dnssec-failed.org. na2euGmlBvOYfQ6l1qd9k6gzzAEMh7nI4wuIbjQJ5HoELOkd1ZuiMPqA1D+QEnBLepCjDkoK+PZ84UFOaF1wcA==
```

使用 `+cd`，你得到了回答。数据在那里，RRSIG 在那里，但信任链无法验证。
这正是攻击者想要的：他们可以注入一个带有自己密钥的虚假区域，如果你
禁用验证你就会相信它。DNSSEC 验证阻止了这种攻击——当它失败时，
你得到的是 SERVFAIL，而不是错误答案。

## 为什么 DNSSEC 运维如此痛苦

DNSSEC 理论上简单，实践中残酷。失败模式是不宽容的：

- **密钥轮换是一场舞蹈。** 你必须发布新的 KSK，等待父区域发布新的
  DS，等待旧 DS 从缓存中过期，然后才能删除旧密钥。做错了，你的区域
  就会从互联网上每个验证解析器中消失。BIND 的 `dnssec-policy` 中的密钥
  事件计时器有帮助，但你仍然必须理解各个状态。
- **时钟偏移破坏一切。** RRSIG 是有时间界限的。如果你的服务器时钟偏差
  超过签名验证窗口，验证就会失败。NTP 不是可选项——它是 DNSSEC 的
  依赖。
- **区域故障导致解析中断。** 与普通 DNS 配置错误（你可能得到过期答案
  或 NXDOMAIN）不同，DNSSEC 故障产生 SERVFAIL。每个使用验证解析器的
  客户端都无法解析你的区域。没有"部分降级"。
- **父区域协调是瓶颈。** 如果你运行自己的注册商或使用一个慢的，更新
  DS 记录可能需要数小时或数天。在密钥轮换期间，这个延迟就在你的关键
  路径上。
- **NSEC3 很复杂。** 它添加了哈希、盐值和迭代参数来防止区域枚举。
  大多数人使用 NSEC（更简单，但通过遍历会暴露区域中的所有名称）。

## 你应该启用 DNSSEC 吗？

我的诚实建议：**是的，如果你运行一个公共区域并且能小心地操作它。**
对 DNS 缓存投毒和区域劫持的防护是真实的。一个签名正确、信任链完整的
区域意味着链路上的攻击者无法在没有你私钥的情况下伪造你的记录。

但睁大眼睛进去：

- 如果你无法承诺密钥轮换、NTP 纪律和 DS 记录维护，故障不是*是否*
  的问题，而是*何时*的问题。
- 如果你的区域仅内部使用（如 `home.lan`），DNSSEC 不太关键——威胁
  模型不同，运维负担可能不值得。
- 在认为上线完成之前，始终用 `dig +dnssec` 和验证解析器*测试*。一条
  与 KSK 不匹配的 DS 记录就是一个定时炸弹。

DNSSEC 不是一个设置后就能忘记的功能。它是对你的关键互联网服务进行
加密密钥管理的承诺。深思熟虑地做出这个承诺，为密钥轮换准备运行手册，
并为 SERVFAIL 尖峰设置监控告警——因为当 DNSSEC 崩溃时，它会响亮地、
完全地崩溃。
