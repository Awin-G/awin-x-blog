---
title: "DNS 区域传送（AXFR）：它如何泄露整个区域，以及如何封堵"
description: "一次 DNS 区域传送（AXFR）会把整个区域的主机名一次送给陌生人。本文用 127.0.0.1 上真实的 BIND 实验，展示 dig AXFR 成功拖走整个 zone、allow-transfer { none; } 后被真实 REFUSED、TSIG 只放行备用服务器，以及 NSEC3 签名后的传送内容，并给出自查清单。"
pubDate: 2027-01-07
lang: zh
translationKey: dns-zone-transfer-axfr
tags: [networking, security]
featured: false
keywords:
  - DNS 区域传送
  - AXFR
  - allow-transfer
  - dig AXFR
  - 区域枚举
---

我知道的最有价值的一条 DNS 查询只有一行：`dig AXFR`。它向权威服务器请求一次
**DNS 区域传送**（zone transfer）——整个区域的完整副本——而一旦服务器配置不当，
它就会答应。而且不是给一条记录：SOA、所有 NS、所有 A、CNAME、SRV、TXT，有多少给
多少。我在 Docker 里跑了一个用完就扔的 BIND9，绑在 `127.0.0.1:15353` 上，先成功
拖了一次，再把服务器收紧后拖一次，这样你能同时看到泄露现场和本该出现的真实
`REFUSED`。下面每一条命令和每一段输出，都是 BIND 9.18.49 与 dig 9.18.49 上跑出来的
真实结果。

**仅限授权测试：** 本文的一切只适用于你自己拥有、或已签约获准测试的区域。对你自己
的权威服务器跑 `dig AXFR`——这正是文末自查清单存在的意义。

## DNS 区域传送（AXFR）到底是什么

DNS 的设计允许一个区域同时存在于多台机器上：**主服务器**（primary）持有可编辑的
那份副本，**备用 DNS 服务器**（secondary DNS）保留完整副本来保证一台机器宕机时区域
还在。把完整区域从主服务器搬到备用服务器的协议就是 AXFR（RFC 5936）：53 端口上
一条 TCP 会话，服务器把整个区域流式发过来，首尾各一个 SOA 记录。现代的增量变体
IXFR 只传某个序列号之后的变更——但如果你要的是“全部”，AXFR 就是那个请求。

这个设计有一面很锋利的刃：备用服务器用来同步的同一个协议操作，对**任何**服务器
愿意搭理的人都开放，除非你显式限制它。暴露的 **AXFR** 不是什么生僻功能的误配——
它就是“我从某篇博客抄了份配置”之后最常见的存活状态，而全网扫描器常年不间断地探测
它。ICANN 的 DNSSEC 演练报告和各类安全基线里，“禁止未授权区域传送”始终在列，原因
下面就能看到。

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="主服务器持有区域数据。备用服务器凭 TSIG 密钥请求 AXFR 并成功；攻击者不带密钥直接 dig AXFR 则被拒绝。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.85">
    <rect x="225" y="30" width="190" height="64" rx="8"/>
    <rect x="470" y="34" width="150" height="56" rx="8"/>
    <rect x="20" y="130" width="150" height="56" rx="8"/>
    <path d="M470 62 H420" marker-end="url(#axfr-arrow-zh)"/>
    <path d="M170 140 H225" stroke-dasharray="6 5" marker-end="url(#axfr-arrow-zh)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">
    <text x="320" y="55" font-weight="600">主服务器 ns1</text>
    <text x="320" y="75" opacity="0.75">allow-transfer { key }</text>
    <text x="545" y="57" font-weight="600">备用 ns2</text>
    <text x="545" y="77" opacity="0.75">持有 TSIG 密钥</text>
    <text x="95" y="153" font-weight="600">攻击者</text>
    <text x="95" y="173" opacity="0.75">dig AXFR（无密钥）</text>
    <text x="445" y="50" opacity="0.9">AXFR + TSIG</text>
    <text x="197" y="130" opacity="0.9">REFUSED</text>
  </g>
  <defs>
    <marker id="axfr-arrow-zh" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>
<figcaption>区域传送本是共享密钥的机器之间的正经流量，其他人只该吃到 <code>REFUSED</code>——这正是 <code>allow-transfer</code> 的职责。</figcaption>
</figure>

## 实验环境：127.0.0.1:15353 上用完就扔的 BIND9

不用 sudo，不暴露任何端口：一个 Debian 容器，里面装 BIND9，宿主端口只发布到
loopback。区域文件是一份典型的小“生产”区域——里面全是最容易被看穿内部结构的主机名：

```text
; db.lab.example —— 实验区域
$TTL 3600
@       IN  SOA ns1.lab.example. admin.lab.example. (
                2027010701 ; serial
                3600       ; refresh
                900        ; retry
                1209600    ; expire
                3600 )     ; minimum
@       IN  NS      ns1.lab.example.
@       IN  NS      ns2.lab.example.
@       IN  MX  10  mail.lab.example.
@       IN  A       203.0.113.10
www     IN  A       10.10.0.5
db      IN  A       10.10.0.6
replica IN  A       10.10.0.7
mail    IN  A       10.10.0.10
vpn     IN  A       10.10.0.25
git     IN  A       10.10.0.30
backup  IN  A       10.10.0.40
staging IN  CNAME   www.lab.example.
mon     IN  A       10.10.0.32
_sip._tcp IN SRV   10 5 5060 mail.lab.example.
```

第一阶段的配置是故意写错的——就是那条大家不假思索抄进生产的那一行：

```text
// named-lab.conf —— 第一阶段：传送敞开，这就是漏洞
options {
    directory "/var/cache/bind";
    listen-on port 15353 { any; };   // dockerd 只把它发布到宿主 127.0.0.1
    listen-on-v6 { none; };
    recursion no;
    allow-query { any; };
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    allow-transfer { any; };   // <-- 任何人都能拷走整个区域
};
```

启动之后，BIND 会加载区域。先来一条 SOA 和一条 NS，确认服务器确实是权威的
（`aa` 标志），再动手拷它：

```text
$ dig @127.0.0.1 -p 15353 lab.example SOA +noall +answer
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600

$ dig @127.0.0.1 -p 15353 lab.example NS +noall +answer +additional
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	NS	ns2.lab.example.
ns1.lab.example.	3600	IN	A	10.10.0.53
ns2.lab.example.	3600	IN	A	10.20.0.53
```

注意那两条 NS 和 glue：连最平淡的查询都已经告诉攻击者——这个区域有几台名字服务器、
分别在哪。接下来才是重点。

## dig AXFR：一次查询拖走整个区域

现在发起攻击查询。一条 TCP 连接，一整段响应流：

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example
; <<>> DiG 9.18.49-1~deb12u2-Debian <<>> AXFR @127.0.0.1 -p 15353 lab.example
; (1 server found)
;; global options: +cmd
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	NS	ns2.lab.example.
lab.example.		3600	IN	MX	10 mail.lab.example.
lab.example.		3600	IN	TXT	"v=spf1 mx -all"
lab.example.		3600	IN	A	203.0.113.10
_sip._tcp.lab.example.	3600	IN	SRV	10 5 5060 mail.lab.example.
api.lab.example.	3600	IN	CNAME	www.lab.example.
backup.lab.example.	3600	IN	A	10.10.0.40
ci.lab.example.		3600	IN	CNAME	git.lab.example.
db.lab.example.		3600	IN	A	10.10.0.6
git.lab.example.	3600	IN	A	10.10.0.30
mail.lab.example.	3600	IN	A	10.10.0.10
mon.lab.example.	3600	IN	A	10.10.0.32
ns1.lab.example.	3600	IN	A	10.10.0.53
ns2.lab.example.	3600	IN	A	10.20.0.53
replica.lab.example.	3600	IN	A	10.10.0.7
staging.lab.example.	3600	IN	CNAME	www.lab.example.
vpn.lab.example.	3600	IN	A	10.10.0.25
www.lab.example.	3600	IN	A	10.10.0.5
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
;; Query time: 1 msec
;; SERVER: 127.0.0.1#15353(127.0.0.1) (TCP)
;; WHEN: Mon Oct 12 19:48:23 UTC 2026
;; XFR size: 21 records (messages 1, bytes 554)
```

21 条记录、一次查询、554 字节。我这套命名体系，一毫秒内全部送达。没有爆破、没有
触发限速、客户端侧没有任何告警。

## 为什么暴露的 AXFR 是侦察大礼包

从上面这段输出做**区域枚举**只要一行管道——把所有 A 和 CNAME 的所有者名抽出来
排序：

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example \
    | grep -E '^[a-z0-9_.-]+[[:space:]]+[0-9]+[[:space:]]+IN[[:space:]]+(A|CNAME|MX)[[:space:]]' \
    | awk '{print $1}' | sed 's/\.lab\.example\.$//' | sort -u
api
backup
ci
db
git
lab.example.
mail
mon
ns1
ns2
replica
staging
vpn
www
```

站在攻击者的角度读这份名单：`vpn`、`db`、`replica`、`backup`、`git`、`staging`——
我刚知道了哪些服务存在、哪些主机大概率在内网，以及下一阶段的短名单：扫这些 IP、
猜 `vpn` 的凭据、对 `staging.lab.example` 钓鱼（staging 环境向来是最弱的一环）、
或者把名单喂给凭据填充工具。隔几小时再拖两次，对比 SOA 序列号
（`2027010701`）的 bump，还能白嫖一份“区域变更检测”订阅：什么时候改过、多了什么。

那 `ANY` 查询呢？它历来是“把这个名字的所有记录都给我”的侧信道，值得理解，但
指望不上：

```text
$ dig @127.0.0.1 -p 15353 lab.example ANY +noall +answer
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010701 3600 900 1209600 3600
lab.example.		3600	IN	NS	ns2.lab.example.
lab.example.		3600	IN	NS	ns1.lab.example.
lab.example.		3600	IN	MX	10 mail.lab.example.
lab.example.		3600	IN	TXT	"v=spf1 mx -all"
lab.example.		3600	IN	A	203.0.113.10
```

有用，但只按单个名字来——对 apex 问 `ANY` 发现不了 `vpn.lab.example`。而且越来越多
的运营方按 RFC 8482 对 `ANY` 只回最小响应，它作为侦察工具本就不可靠。**AXFR 始终是
唯一能一次拿回整个区域的查询，这正是它的 ACL 才是关键控制点的原因。**

## 封堵：BIND 里的 allow-transfer

BIND9 的修复只有一行。我把 `allow-transfer { any; }` 改成
`allow-transfer { none; }`，检查配置后重启：

```text
# named-checkconf /etc/bind/named-lab.conf && rndc reconfig   （或直接重启 named）

$ dig AXFR @127.0.0.1 -p 15353 lab.example
; <<>> DiG 9.18.49-1~deb12u2-Debian <<>> AXFR @127.0.0.1 -p 15353 lab.example
; (1 server found)
;; global options: +cmd
; Transfer failed.
```

`; Transfer failed.`——真实的拒绝。打开 comments 还能看到*为什么*，包括现代的
Extended DNS Error：

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 51765
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
; EDE: 18 (Prohibited)
; Transfer failed.
```

服务器侧日志说的是同一件事——这行就是你该在自己名字服务器上 grep 的东西：

```text
12-Oct-2026 19:49:14.046 error: client @0x7f4a97c20c98 172.17.0.1#50606 (lab.example): zone transfer 'lab.example/AXFR/IN' denied
```

而普通解析完全不受影响——限制只作用于传送，不作用于查询：

```text
$ dig @127.0.0.1 -p 15353 www.lab.example A +short
10.10.0.5
```

两点补充。其一，AXFR 只走 TCP，所以这条 ACL 的防火墙版本是：只放你的备用服务器
地址进 tcp/53，其余一律拒。其二，从你不再跑备用的那一刻起，
`allow-transfer { none; }` 就是正确设置——意外多的区域其实只有一台机器在服务，
那扇门从来就没必要开着。

## TSIG：留着备用服务器，关上敞开的门

如果你**确实**跑备用，现代的标准姿势是 **notify + TSIG**：主服务器通知备用
“序列号变了”，传送用共享 HMAC 密钥认证，门只给持钥者开。我在实验服务器上生成了
一把真实的临时密钥：

```text
$ tsig-keygen -a hmac-sha256 axfr-lab
key "axfr-lab" {
	algorithm hmac-sha256;
	secret "DR+b53nkSQGqRgDX/YfJ2H4hks2JC1AUmdoxDBNsBvY=";
};
```

把 key 块放进配置，区域子句改成只认这一个身份：

```text
key "axfr-lab" {
    algorithm hmac-sha256;
    secret "DR+b53nkSQGqRgDX/YfJ2H4hks2JC1AUmdoxDBNsBvY=";
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    allow-transfer { key "axfr-lab"; };   // 只放行这个持钥的备用——其他人没有
};
```

之前那条 `dig AXFR` 现在照样失败——服务器原则上允许传送，但请求没有身份：

```text
$ dig AXFR @127.0.0.1 -p 15353 lab.example +noall +comments
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 7835
; EDE: 18 (Prohibited)
; Transfer failed.
```

用 `-y hmac-sha256:axfr-lab:<secret>` 带着密钥再问同一台服务器，传送成功。其他
守护进程用各自的方言表达同一条策略。NSD：

```text
# nsd.conf —— NSD 等价写法
zone:
    name: "lab.example"
    zonefile: "lab.example"
    provide-xfr: 10.20.0.53 axfr-lab        # 只此备用、只此密钥，别无其他
```

Knot DNS：

```yaml
# knot.conf —— Knot 等价写法
zone:
  - domain: lab.example
    file: "lab.example.zone"
    acl:
      - id: secondary-xfr
        address: [10.20.0.53]
        action: transfer
        key: axfr-lab
```

没碰过 NSD 或 Knot 也没关系：形状完全一样——一把具名密钥（TSIG）、一个具名对端、
一条规则把 `transfer` 授给这个对端，其余默认拒绝。密钥要定期轮换，放进你现成的
秘密管理系统；TSIG 密钥躺在 Ansible 仓库里，等于给未来的某天埋雷。

## 如果区域签了 DNSSEC，传送里连签名一起给

有人以为 DNSSEC 能让这件事变得无所谓。并不能——DNSSEC 证明区域里**是什么**，
不决定谁可以**拷走**它。为了让这点具体化，我用 BIND 的 inline signing 加 NSEC3 链
重新签了实验区域：

```text
dnssec-policy lab-nsec3 {
    keys { csk lifetime unlimited algorithm ecdsap256sha256; };
    nsec3param iterations 8 salt-length 6;
};

zone "lab.example" IN {
    type master;
    file "/var/lib/bind/db.lab.example";
    inline-signing yes;
    dnssec-policy lab-nsec3;
    allow-transfer { key "axfr-lab"; };
};
```

通过认证的 AXFR 随后返回签名视图——DNSKEY、每个 RRset 的 RRSIG、NSEC3PARAM 和
整条 NSEC3 链，消息本身还带 TSIG 签名：

```text
lab.example.		3600	IN	DNSKEY	257 3 13 HgSx1zqU0doyyQF+R5l8tsHhhKLheL/+AhSaLooVJjqe0yD9icq8jd+2 ...
lab.example.		0	IN	NSEC3PARAM 1 0 8 F65EB0CD4453
6RNEG2MMDM9GVIGODBA49DS7E35K7S51.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 A5H8P1E4NAF5NGMU6PC521IVMTCQGJ59 A NS SOA MX TXT RRSIG DNSKEY NSEC3PARAM TYPE65534
V640UOA1PU45U1443HA1HOQB0FIK5BU7.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 0P634D8KK6PS0BI63BA0UL0LAGRSQQ6O A RRSIG
axfr-lab.		0	ANY	TSIG	hmac-sha256. 1791834757 300 32 w1YoDEoU9AqFWGYqQiPnOasQglAxo1oXOS/D9avRoyE= ...
;; XFR size: 78 records (messages 1, bytes 6208)
```

NSEC3 买到什么、代价是什么，值得说清。它用哈希过的主人名替换 NSEC 的明文“下一
名字”链，于是验证式解析器问一个不存在的名字时，能拿到密码学意义上的 NXDOMAIN
证明：

```text
$ dig @127.0.0.1 -p 15353 nope.lab.example A +dnssec +noall +authority
lab.example.		3600	IN	SOA	ns1.lab.example. admin.lab.example. 2027010712 3600 900 1209600 3600
lab.example.		3600	IN	RRSIG	SOA 13 2 3600 20261026195223 20261012185223 19342 lab.example. ...
48FU8OQCKV4R8PKTA8RRM0P8PALGUL6P.lab.example. 3600 IN NSEC3 1 0 8 F65EB0CD4453 6RNEG2MMDM9GVIGODBA49DS7E35K7S51 A NS SOA MX TXT RRSIG DNSKEY NSEC3PARAM TYPE65534
```

NSEC3 的盐值加哈希能拖慢 Casual 的 zone walking，但别忘了，一旦有人从上文的
AXFR 拿到了区域，整条链就在那儿摆着，而 DNSSEC 真正保护的是签名密钥本身。结论不变：
传送 ACL 和 DNSSEC 是两套正交的控制，两个都要。

## 现代实践到底是什么样的

具体讲，如果有个同事拿着一个区域来问我怎么保护，我会这么说：

- **没有备用？那就把门焊死。** BIND 上 `allow-transfer { none; }`，NSD 里不写
  `provide-xfr`，Knot 里不写 `transfer` ACL。冗余交给 DNS 服务商或注册商——
  那正是你付钱让他们干的事。
- **有备用？只走 notify + TSIG。** 主服务器通知已知的备用，只向带密钥、按 IP 钉死
  的对端传送。永远不要 `any`。
- **隐藏主服务器模式。** 公共 NS 记录指向你的备用；主服务器只对它们可达，传送只
  放行它们的密钥。多数认真运营的人就是这么干的。
- **盯日志。** 来自陌生地址的 AXFR 拒绝，说明侦察已经摸到你的区域；来自任何非备用
  源的**成功** AXFR 则是安全事件。序列号用日期格式，IXFR 才能工作，备用才能快速
  重同步。
- **DNSSEC 是叠加项，不是替代品。** 签名与传送控制互不替代。

## 怎么检查自己的区域（仅限授权测试）

对每一个你运营的区域，在一台你控制的机器上：

```text
# 1. 这个区域由谁服务？
dig NS lab.example +short            # 自己的区域，不要碰别人的

# 2. 谁能 AXFR 它？
dig AXFR @<你的主服务器> <你的区域>
#   预期：  ; Transfer failed.   / status: REFUSED
#   如果拿到记录：今天就把 allow-transfer 修了

# 3. 如果某个备用是合法的，验证 TSIG 这条路真的通
dig -y hmac-sha256:<密钥名>:<密钥> AXFR @<你的主服务器> <你的区域>
```

一条 `dig`、一秒钟，你就知道了。如果第 2 步把记录递到你手上，那正是本文的全部
要点：互联网上任何一台扫描器，现在都能对你的 IP 跑出完全相同的命令。

## 清理现场

实验什么都没留下：

```bash
docker rm -f axfr-srv axfr-client
```

## 我的收获

AXFR 的存在是为了让一个区域活在多台机器上，这功能值得留着——直到
`allow-transfer { any; }` 把你的整套主机清单递给每一个开口问的人。跑一次实验
BIND，亲眼看 `dig AXFR` 成功，再把一行改成 `allow-transfer { none; }`，眼看真实的
`REFUSED` 回来。两种都见过之后，你再也不会照抄配置了。（DNS 的另一半——递归侧是
怎么工作的——见 [DNS 究竟是怎么解析的](/zh/posts/how-dns-resolves/) 和我关于
[自建递归 DNS 解析器](/zh/posts/self-hosted-dns-resolver/)的笔记。）
