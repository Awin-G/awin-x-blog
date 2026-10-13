---
title: "nginx WAF 实战：ModSecurity 与 OWASP CRS，实测 SQL 注入、XSS 与路径遍历"
description: "一次动手实测：nginx + ModSecurity + OWASP CRS 4.30 拦住真实的 SQL 注入、XSS 与路径遍历，403 响应与真实审计日志规则 ID（942100、941100、930110）；以及 DetectionOnly 灰度上线、误报、延迟代价，以及小型自托管场景下 WAF 到底该放在哪。"
pubDate: 2027-01-19
lang: zh
translationKey: nginx-modsecurity-waf
tags: [security, nginx]
featured: false
keywords:
  - ModSecurity
  - OWASP CRS
  - WAF
  - nginx WAF
  - SQL 注入
---

这周我给 nginx 前面加了一层 **WAF**：**ModSecurity** 配上 **OWASP Core Rule
Set**，挡在一个只绑 `127.0.0.1` 的一次性应用前面。然后我朝它打了三种最经典的
攻击——**SQL 注入**、XSS 载荷和路径遍历——看看会发生什么。三个请求全部 `403`，
而审计日志精确指出了是哪条规则拦住了每一次攻击。这篇文章就是那次完整实测，
全部是真实输出，外加厂商通常绝口不提的部分：头五分钟里它就制造的误报、带来的
延迟，以及为什么 **nginx WAF** 只是缓解手段，而不是修复。

## WAF 是什么——以及它不是什么

**Web 应用防火墙**在应用看到请求**之前**过滤 HTTP 请求。它位于请求路径上——
在 nginx 里就是 `modsecurity` 模块——检查方法、URI、头部、参数和请求体，当
请求看起来像攻击时返回 `403`。这里有两类检测机制值得了解：

- **基于签名/特征**：用正则或 libinjection 这类引擎，把请求对照已知的攻击
  形态匹配。CRS 就是这一类。
- **基于异常评分**：每命中一条规则加分，越过阈值就拒绝。CRS 同时也是这一类
  ——签名命中喂给评分系统。

WAF **不是**什么：

- **不是应用的修复**。拦下 `?id=1' OR '1'='1` 只说明有一条攻击字符串被抓住，
  它背后的注入漏洞原封不动。
- **不是网络防火墙**。它只懂 HTTP；它替代不了 nftables、fail2ban，也替代不了
  一台真正打了补丁的机器。
- **不是魔法**。编码变形、multipart 请求体、调松的规则都会造成绕过。WAF 抬高
  攻击成本，它不终结攻击。

<figure>
<svg viewBox="0 0 640 176" width="100%" role="img" aria-label="请求路径：客户端请求进入挂着 ModSecurity 与 OWASP CRS 的 nginx，规则命中不断累加异常分。低于 5 分放行并代理给应用的正常 200；达到或超过 5 分则以 403 拒绝并写入审计日志。">
  <defs>
    <marker id="wafAr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="10" y="62" width="118" height="46" rx="8"/>
    <rect x="452" y="26" width="128" height="44" rx="8"/>
    <rect x="452" y="104" width="128" height="44" rx="8"/>
  </g>
  <g stroke="#0f766e" stroke-width="2" fill="none">
    <rect x="212" y="16" width="176" height="140" rx="8"/>
    <path d="M128 85 h76" marker-end="url(#wafAr)"/>
    <path d="M388 62 C418 62 424 48 448 48" marker-end="url(#wafAr)"/>
    <path d="M388 108 C418 108 424 124 448 126" marker-end="url(#wafAr)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="69" y="82">HTTP 请求</text>
    <text x="69" y="99" opacity="0.7" font-size="11">任意客户端</text>
    <text x="300" y="44" font-weight="600">nginx</text>
    <text x="300" y="64">ModSecurity</text>
    <text x="300" y="84">OWASP CRS</text>
    <text x="300" y="110" opacity="0.75" font-size="11">942100 SQLi +5</text>
    <text x="300" y="126" opacity="0.75" font-size="11">941100 XSS +5</text>
    <text x="516" y="46">后端应用</text>
    <text x="516" y="63" font-size="11" opacity="0.75">200，代理放行</text>
    <text x="516" y="124">403 + 审计日志</text>
    <text x="516" y="141" font-size="11" opacity="0.75">949110、ID、分数</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" fill="#0f766e">
    <text x="418" y="42">分数 &lt; 5</text>
    <text x="418" y="140">分数 ≥ 5</text>
  </g>
</svg>
<figcaption>每个请求在碰到应用之前都要过一遍 CRS：签名命中累加成异常分，低分被代理转发，达到或超过入站阈值的请求被拒绝并记入审计日志。</figcaption>
</figure>

## ModSecurity 与 OWASP CRS

**ModSecurity** 是引擎：`libmodsecurity3` 加一个 nginx 连接器。在你的配置里
它是三行——在 server 或 http 块里 `modsecurity on;`、一个规则文件，以及
`SecRuleEngine`：

```nginx
modsecurity on;
modsecurity_rules_file /etc/modsecurity.d/setup.conf;
```

CRS 就是这个文件指向的规则包。下面是我用的容器里真实的 include 链
（modsecurity 3.0.17 的规则加载方式）：

```nginx
# /etc/modsecurity.d/setup.conf — owasp/modsecurity-crs 镜像内部
Include /etc/modsecurity.d/modsecurity.conf
Include /etc/modsecurity.d/modsecurity-override.conf
Include /etc/modsecurity.d/owasp-crs/crs-setup.conf
Include /etc/modsecurity.d/owasp-crs/rules/*.conf
```

`crs-setup.conf` 是策略所在：阈值、偏执等级、评分。以下是这次运行中该文件的
真实取值（第 280–341 行）：

```nginx
setvar:tx.critical_anomaly_score=5,
setvar:tx.error_anomaly_score=4,
setvar:tx.warning_anomaly_score=3,
setvar:tx.notice_anomaly_score=2
setvar:tx.inbound_anomaly_score_threshold=5,
setvar:tx.outbound_anomaly_score_threshold=4
```

也就是说，一条 CRITICAL 级命中（比如 SQL 注入）加 5 分，独自就顶破 5 分的
阈值；两条 WARNING 各加 3 分，攒两条也能过线。规则按编号的攻击类别文件组织
——与三种经典攻击直接相关的有：

| 规则文件 | 家族 | 拦什么 |
|---|---|---|
| `REQUEST-942-...SQLI.conf` | 942100+ | SQL 注入（正则 + libinjection） |
| `REQUEST-941-...XSS.conf` | 941100+ | 跨站脚本载荷 |
| `REQUEST-930-...LFI.conf` | 930100+ | 本地文件包含 / 路径遍历 |
| `REQUEST-949-BLOCKING-EVALUATION.conf` | 949110 | 真正执行拒绝的规则 |

每条规则都有稳定的 `[id]`、一条 `[msg]`，以及包含 `paranoia-level` 的标签。
**偏执等级**（PL）1–4 决定规则包的攻击性：PL1 是默认的低误报档，PL2 拦截面
明显更大、调优代价也明显更高，PL3–PL4 适合能把正常输入也当敌情处理的严格
API。没有一手审计日志，不要升等级。

## 实验环境：我实际跑了什么

一个 docker 网络、一个 Python 回声小程序，加上官方镜像。全程只用我自己的
机器——这是授权自测的实验：

```bash
docker network create waf-lab

# tiny app: 对一切请求回答 "app-200: <method> <path>"
docker run -d --name backend --network waf-lab \
  -v $PWD/backend.py:/backend.py:ro \
  python:3-alpine3.23 python /backend.py

# nginx 1.30.5 + ModSecurity-nginx 1.0.4（libmodsecurity3 3.0.17）+ CRS 4.30.0
docker run -d --name waf-on --network waf-lab -p 127.0.0.1:8088:8080 \
  -e BACKEND='http://backend:8000' \
  -e MODSEC_RULE_ENGINE=on \
  -e MODSEC_AUDIT_ENGINE=RelevantOnly \
  -e MODSEC_AUDIT_LOG=/tmp/modsecurity/audit.log \
  -e MODSEC_AUDIT_LOG_FORMAT=Native \
  owasp/modsecurity-crs:4.30.0-nginx-202610051210
```

那个 `MODSEC_RULE_ENGINE=on` 环境变量，作用就是把 `SecRuleEngine on` 写进
生成的配置——也就是经典指令写法给的那组对照：`SecRuleEngine On` 拒绝，
`SecRuleEngine DetectionOnly` 只记录。

## 正常请求直接通过

```bash
$ curl -s 'http://127.0.0.1:8088/api/items?id=42'
app-200: GET /api/items?id=42 from 172.22.0.3
```

`200`，回路环上约 5 ms 直达后端。WAF 对无害流量不增加任何可见行为——按设计，
它在这里应该是隐形的。（一个细节：审计引擎连这条请求都记了，因为有一条
WARNING 级规则在它身上触发了。下面会讲。）

## 三个真实攻击，三个 403

同一个 WAF、同一秒，三个地球上每个扫描器都会发的载荷：

```bash
$ curl -s -G 'http://127.0.0.1:8088/api/items' \
    --data-urlencode "id=1' OR '1'='1" -o /dev/null -w '%{http_code}\n'
403

$ curl -s -G 'http://127.0.0.1:8088/search' \
    --data-urlencode "q=<script>alert(1)</script>" -o /dev/null -w '%{http_code}\n'
403

$ curl -s -G 'http://127.0.0.1:8088/download' \
    --data-urlencode "file=../../etc/passwd" -o /dev/null -w '%{http_code}\n'
403
```

后端从没见过它们——后端的回复列表里只有之前那条正常请求。这就是签名型 WAF
的活：无聊、量大、永远不会消失的攻击形态，在应用被卷入之前用微秒级时间拦掉。

## 读懂审计日志：规则 ID 告诉了你什么

上面的一切在审计轨迹里都可见。一条记录长这样（花括号部分是最长的正则行，
为排版做了截断）：

```
---YBrOqrfy---A--
[13/Oct/2026:00:49:45 +0000] 179185258531.775734 172.22.0.1 33924 172.22.0.3 8080
---YBrOqrfy---B--
GET /api/items?id=1%27+OR+%271%27%3D%271 HTTP/1.1
Host: 127.0.0.1:8088
User-Agent: curl/8.22.0
Accept: */*

---YBrOqrfy---H--
ModSecurity: Warning. detected SQLi using libinjection. [file "/etc/modsecurity.d/owasp-crs/rules/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] [line "46"] [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"] [data "Matched Data: s&sos found within ARGS:id: 1' OR '1'='1"] [severity "2"] [ver "OWASP_CRS/4.30.0"] ... [tag "paranoia-level/1"] [uri "/api/items"] [unique_id "179185258531.775734"]
ModSecurity: Access denied with code 403 (phase 2). Matched "Operator `Ge' with parameter `5' against variable `TX:BLOCKING_INBOUND_ANOMALY_SCORE' (Value: `8' ) [file "/etc/modsecurity.d/owasp-crs/rules/REQUEST-949-BLOCKING-EVALUATION.conf"] [line "222"] [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 8)"]

---YBrOqrfy---Z--
```

`A` 段是事务头，`B` 段是请求行与头部，`H` 段是消息——规则 ID 就在这里——
`Z` 段闭合记录。段的集合是可配置的（这个镜像记录 `ABIJDEFHZ`）。

决定性的一行是 **949110**：规则 942100 给入站评分加了 5 分，Host 头告警又
加了 3 分，8 ≥ 5，事务在第 2 阶段被拒绝。看看各是哪条规则立的功：

```text
$ grep -oE '\[id "[0-9]+"\] \[rev "[^"]*"\] \[msg "[^"]+"\]' audit.log | sort | uniq -c | sort -rn | head
     91 [id "920350"] [rev ""] [msg "Host header is a numeric IP address"]
      3 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 8)"]
      2 [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"]
      2 [id "930110"] [rev ""] [msg "Path Traversal Attack (/../) or (/.../)"]
      1 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 33)"]
      1 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 23)"]
      1 [id "941100"] [rev ""] [msg "XSS Attack Detected via libinjection"]
      1 [id "941110"] [rev ""] [msg "XSS Filter - Category 1: Script Tag Vector"]
      1 [id "941160"] [rev ""] [msg "NoScript XSS InjectionChecker: HTML Injection"]
      1 [id "941390"] [rev ""] [msg "Javascript method detected"]
      1 [id "930100"] [rev ""] [msg "Path Traversal Attack (/../) or (/.../)"]
      1 [id "930120"] [rev ""] [msg "OS File Access Attempt"]
      1 [id "932160"] [rev ""] [msg "Remote Command Execution: Unix Shell Code Found"]
```

分数本身在讲故事：SQL 注入 8 分，XSS 叠了四条 XSS 规则（23 分），路径遍历
同时踩中 LFI 与 RCE 规则（33 分）。而第一行——920350 命中 91 次——就是调优
的故事。

## 五分钟内遇到的误报

CRS 拦的不全是攻击。在探测正常流量时，我发了一个带比较运算符的搜索词：

```bash
$ curl -s -G 'http://127.0.0.1:8088/search' \
    --data-urlencode "q=python3 < vs >" -o /dev/null -w '%{http_code}\n'
403
```

审计日志：规则 **932260**，"Remote Command Execution: Direct Unix Command
Execution"，CRITICAL 级，+5——被拦。一个搜索 `python3 < vs >` 的用户得到
一个光秃秃的 `403` 页面，并且完全不知道为什么。这就是在文本型应用上以 PL1
跑 WAF 的日常：markdown 文章、代码片段、日志行、表单里的正则——真实内容
看起来就像 shell 元字符。

我的实验还放大了这一点：我用 IP 访问，于是告警规则 920350（"Host header
is a numeric IP address"，+3）在**每一条**请求上触发，这份日志里 91 次。
每笔交易白送 3 分，就是离拒绝线近 3 分。真实部署里配上真实的 `server_name`
这条规则会安静下来——但它演示了告警级噪音如何累积成异常分。

## DetectionOnly：先记录，后拦截

这是谁都不该跳过的上线方式，而且只要改一行：`SecRuleEngine DetectionOnly`
（在这个镜像里就是 `-e MODSEC_RULE_ENGINE=DetectionOnly`）。规则照常执行，
审计日志照记命中的 ID 和分数，但永不拒绝。我对第二个同样配置的容器打了同样
三个攻击：

```text
benign:     HTTP 200
sqli:       HTTP 200
xss:        HTTP 200
traversal:  HTTP 200

$ curl -s -G 'http://127.0.0.1:8089/api/items' --data-urlencode "id=1' OR '1'='1"
app-200: GET /api/items?id=1%27+OR+%271%27%3D%271 from 172.22.0.4
```

这条 SQL 注入**被完整送到了应用**——而审计日志依然记录 942100 和 8 分：

```text
$ docker exec waf-detect grep -c "Access denied" /tmp/modsecurity/audit.log
0

$ grep 942100 audit.log | grep -oE '\[id "942100"\].*paranoia-level/1' | head -1
[id "942100"] ... [msg "SQL Injection Attack Detected via libinjection"] ... [tag "paranoia-level/1"]
```

流程就是：DetectionOnly，观察一周 949110 的分和 920xxx 的告警，针对你真实
流量的样子写排除规则，然后再切到 `On`。跳过这步，就是拿你的流量去赌一整套
为整个互联网写的规则。

## 诚实的代价

- **误报会打断正常请求。** 上面那条 932260 只是小儿科；真实世界里是搜索页、
  富文本编辑器、值里带 `<` 的 JSON API、文件上传。每一个误报都是一个用不了
  你网站的用户，和一张你解释不清的工单。
- **调优负担没有尽头。** CRS 发版本会挪规则 ID、收紧正则，重算我这台机器上的
  评分（本次运行是 4.30.0）。升级意味着重新 DetectionOnly 跑一轮。排除规则
  （`SecRuleRemoveById`、按标签排除）是一份兼职工作。
- **延迟。** 回路环、小请求、50 次取中位数：纯 nginx 代理 **1.06 ms**，
  DetectionOnly **2.80 ms**，拦截模式 **2.74 ms**。单看不夸张，但它让本来
  可以忽略的回路环开销翻倍；且随请求体增大而增长（整个请求体被缓冲并扫描），
  每个请求都是实打实的 CPU 活。
- **日志量。** 这次实验 90 笔交易产生了 132 KB 审计日志——`Native` 格式下
  每请求约 1.5 KB。用镜像默认的 JSON 格式还会更大。对繁忙站点来说这是日志
  管道的决策，不是顺手勾选的选项。
- **是缓解，不是修复。** WAF 拦着载荷的同时，注入漏洞还躺在应用里。任何绕过
  ——新编码、未覆盖的规则——都会把洞重新打开。WAF 买来的是彻底修好它的时间。

## 小型自托管者该把 WAF 放在哪

对单机 homelab 或一台小 VPS：

- **你挂在 CDN 的托管 WAF（Cloudflare 之类）后面？** 边缘层已经有签名过滤了。
  再叠 ModSecurity，通常只是重复它看不见的那一小块。
- **你在动态应用前面跑自己的反向代理（带评论的博客、wiki、任何有登录的
  东西）？** 这是甜点区：DetectionOnly 起跑，看一周干净日志再 `On`，按需
  逐 location 开。
- **站点是纯静态？** 跳过。静态文件服务器从请求检查里几乎一无所获，你的精力
  花在响应头和源站加固上更划算——见我写的
  [Web 安全响应头](/zh/posts/web-security-headers/)。nginx 侧的那些机制
  ——location 匹配、代理、`add_header` 陷阱——在
  [nginx 配置手册](/zh/posts/nginx-cookbook/)里。
- **无论哪种**，把 WAF 放在日志能落地的地方：CRS 审计日志才是产出，远比那些
  403 更有价值。访问日志里的 403 只说明有攻击发生过；持续上涨的 949110
  分数才说明你的规则还配不配得上你的流量。

整个实验在一台机器上十分钟内跑完：两个容器、一个网络、零特权端口。这些 403
是真的，规则 ID 是真的，那个会被拦的 `python3 < vs >` 用户也是真的。先用
DetectionOnly 跑——日志会先告诉你的流量长什么样，再决定你要弄坏什么。

*以上全部只在我自己 `127.0.0.1` 上的一次性容器里测试。攻击流量请只发向你
拥有或获得书面许可测试的系统。*
