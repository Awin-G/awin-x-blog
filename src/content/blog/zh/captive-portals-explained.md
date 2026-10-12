---
title: "认证门户到底怎么工作：从数据包讲起——检测、Wi-Fi 登录跳转与无浏览器自动化"
description: "从数据包层面讲清认证门户（captive portal）的真实机制：DHCP 与 DNS 拦截、RFC 8910 认证门户 API、Wi-Fi 登录跳转、Android/iOS 的 CNA 检测、walled garden、MAB 与 RADIUS，以及如何实现无浏览器的自动登录。"
pubDate: 2026-10-14
lang: zh
translationKey: captive-portals-explained
tags: [networking, security, reverse-engineering]
featured: false
keywords:
  - 认证门户原理
  - captive portal 检测
  - RFC 8910
  - Wi-Fi 登录跳转
  - 无浏览器认证
---

**认证门户（captive portal）**看起来像一个网页，但它不是网页。它是网络在
逐个客户端地决定：你的数据包到底能不能离开。那个登录表单，只是一条拦截链最
末端可见的部分——这条链从链路层开始，到一条 RADIUS 的 `Access-Accept` 结束。
一旦你理解了这条链，**captive portal 检测**、**Wi-Fi 登录跳转**，以及
**无浏览器认证**就不再是玄学，而是一台你能读懂的**状态机**。

这是一篇厂商中立的解释，从数据包层面讲清认证门户到底怎么工作。需要具体例子时，
我会指向我此前逆向过的一套锐捷风格 ePortal 流程。

## 核心思想：一个做拦截的中间盒

在开放网络里，客户端关联、发一个 DHCP `DISCOVER`、拿到 IP，然后网关就转发它的
流量。在认证网络里，客户端拿到的 IP 一模一样——接入层在二层是刻意宽松的——但
网关（`BRAS`、`NAS` 或控制器）会给这个客户端装上一套逐客户端的**未授权**策略。
这套策略是过滤器，不是你肉眼可见的一条防火墙规则，它通常做三件事：

- 放行 **DHCP** 和 **ARP**，让客户端保持关联、保持可寻址。
- 放行一份**白名单**——DNS，外加一个由门户主机组成的「walled garden」。
- 丢弃或重定向**其它一切**。

客户端在二层是在线的，却在三层被困住。认证门户用到的每一种机制，都是「如何让这
个陷阱显形」，以及「之后如何把它解除」的不同变体。

## 三种拦截平面：DHCP、DNS 与 HTTP

门户可以在三个不同层面宣告自己、抓住你。真实部署往往把它们混着用。

### 1. DHCP——宣告门户的存在（RFC 8910）

最干净的机制是有标准的。**RFC 8910** 定义了一个 DHCP/RA-DHCP 选项，即
**选项 114**，它的值是一个指向门户上某个 HTTP API 的 URI。它同时定义了一个
用于同一目的的 `Captive-Portal` HTTP 响应头。当客户端支持它时，就能在发出任何
用户数据包*之前*发现门户，无需启发式猜测。

厂商也会用更老的 **选项 160**（思科定义的一个字符串）做类似的事。要点相同：网络
在 DHCP 租约里直接告诉客户端——「顺带一提，你在门户后面，去这里和它对话」。

### 2. DNS——那个一网打尽的解析器

大多数老式门户不使用 DHCP 信令。取而代之的是网关运行一层 **DNS 拦截**：
在你未授权时，任何域名的任何查询都被解析到一个固定的门户 IP。你问 `example.com`，
拿到的是门户。客户端的 DNS 缓存于是塞满了一堆全指向同一台主机的谎言。

这又便宜又通用，所以无处不在。它也会带来老式门户的第一个明显特征：无论你输入
什么，都被反复重定向到同一个地址。

### 3. HTTP——Wi-Fi 登录跳转

最可见的平面是 HTTP。当一个未授权客户端发出一个明文
`GET http://something/` 时，网关有两个选择：

- **拦截并应答。** 它终结这个连接，返回一个 200，里面是一小段脚本或 meta-refresh，
  把浏览器弹到门户。
- **拦截并重定向。** 它返回 `302 Found`，`Location` 头指向门户 URL，并把客户端的
  身份作为查询参数带过去。

第二种就是人人都认得的那次 **Wi-Fi 登录跳转**。典型的第一跳长这样：

```text
$ curl -sv http://example.com/ 2>&1 | grep -E '^< |^> '
> GET / HTTP/1.1
> Host: example.com
< HTTP/1.1 302 Found
< Location: http://10.10.0.1/portal/index.jsp?userIp=10.19.7.42
                 &nasIp=10.254.0.9&wlanAcName=BRAS-01
```

注意这个 URL *里面*有什么：`userIp`、`nasIp`，以及接入控制器的名字。门户并没有
问你是谁——网关已经告诉它了。这就是后面 MAC 与 IP 绑定的种子。

这个平面带来两个重要推论：

- **HTTPS 不会被重定向，它会被打断。** 中间盒无法为 `example.com` 出示一张有效
  证书，所以一次 HTTPS 的 `GET` 会以 TLS 错误失败，而不是被重定向。这是**有意
  为之**：门户可以劫持明文，但绝不应该能透明地 MITM TLS。你的浏览器弹出证书警告，
  恰恰是因为拦截无法伪造一张受信任的证书。
- **重定向是按会话的。** 门户 URL 带着一个专为这次未授权状态生成的令牌，登录之后
  就不能再复用了。

## captive portal 检测（CNA）：操作系统怎么发现

用户很少先输入网址。操作系统会自己发起探测，用一个**认证网络助手
（Captive Network Assistant，CNA）**——而正是这一部分，决定了你看到的是一个完整
浏览器窗口还是一张小小的弹窗。

每个平台都去抓一个已知 URL，并检查一个*精确*的响应：

| 平台 | 探测 URL | 期望响应 |
| --- | --- | --- |
| Android | `http://connectivitycheck.gstatic.com/generate_204` | HTTP `204`，空 body |
| iOS / macOS | `http://captive.apple.com/hotspot-detect.html` | 精确的 `Success` HTML |
| Windows | `http://www.msftconnecttest.com/connecttest.txt` | `Microsoft Connect Test` |

只要响应不是这个——一个 `302`、一个 body 不对的 `200`、一个指向意外之处的 DNS
应答——操作系统就判定为「captive」，并弹出登录界面。在 Android 和 iOS 上，这会打开
一个**不共享 cookie**、地址栏受限的沙箱迷你浏览器，这也是门户不能依赖已存凭据的
另一个原因。

**RFC 8910 与 RFC 8908** 把这套东西现代化了。不再靠字符串去匹配某个魔法页面
（RFC 8908 把这条路径叫做「probe」腿），有能力的客户端会去查询它从 DHCP 选项 114
得知的 Captive Portal API URL。该 API 返回 JSON：

```json
{
  "captive": true,
  "user-portal-url": "https://portal.example.edu/login",
  "venue-info-url": "https://portal.example.edu/info"
}
```

当 `captive` 翻转为 `false`，操作系统就知道这张网络是真开放的。围绕它的架构在
RFC 8952（CAPPORT）中规定——它之所以存在，是因为启发式探测很脆弱：一张健康的、
只是有个登录门页的网络，可能永远看起来都「captive」。

## 识别与授权客户端

检测负责把你*送到*门户。授权才是更难的那一半。

### walled garden

**walled garden** 是未授权状态下可达目的地的那份白名单。最小情况下，它是门户自己
的主机加 DNS。在更丰富的配置里，它还包括 SSO 提供方、认证门户 API 端点，甚至支付
或额度充值服务，让用户在拿到完全访问前就能付费。walled garden 让登录页能在一张其它
一切都被封的网络里渲染出来——而当 DNS 迁移时，它往往是最先坏掉的那一环。

### MAC 绑定 / MAB

网关不能只信 IP：客户端可以伪造 IP。所以会话会绑定到关联时观测到的**客户端 MAC**。
许多有线和无线部署使用 **MAB（MAC Authentication Bypass，MAC 认证旁路）**——交换机
或控制器把客户端 MAC 当作用户名和密码，放进 RADIUS 的 `Access-Request`，一个已在
目录中注册的 MAC 就被放行，连页面都不用出现。这正是为什么改掉你上行链路的 MAC，会
悄悄作废一个已有的绑定，把你扔回认证状态。

### 会话令牌与门户的职责

一旦你提交凭据，门户真正的工作是告诉网关打开你的流。它通过创建一个**会话**来实现
——一条带键的、记录 `(客户端 MAC, 客户端 IP, NAS, 策略)` 并有生命周期的记录。URL 里
的令牌和浏览器里设置的 cookie，都是指向那条会话的句柄。这就是为什么登录页不是安全
边界：边界是网关那条按会话的过滤器，而门户只是一个把它翻开的 HTTP 前端。

### 底下的 RADIUS 与 DHCP snooping

授权决策通常落在 **RADIUS** 上。NAS 发出一条 `Access-Request`，带着用户身份（真实
凭据，或在 MAB 下的一个 MAC）；RADIUS 服务器回 `Access-Accept`、`Access-Challenge`
或 `Access-Reject`，并可选地带回 `Session-Timeout`、接入 VLAN 等属性。会计的
`Start`/`Stop` 记录界定了会话的生命周期。把它包装成浏览器里的用户名/密码，掩盖了
一个事实：这张网络自始至终都在说 RADIUS。

在交换侧，**DHCP snooping** 与 IP source guard 会构建一张 IP-to-MAC-to-port 的绑定
表，让客户端无法声领一个不是租给它的 IP；动态 ARP 检测（DAI）则补上二层伪造的缺口。
这些合在一起，才让 MAC 绑定可信到足以作为授权依据。

## 一个具体流程：锐捷 ePortal + CAS SSO

这个通用形态，在一个真实系统里最好辨认。在一套锐捷风格的 ePortal 部署里，HTTP 平面
上的那次重定向带着 `sessionId`、`userIp`、`nasIp` 和 `customPageId`。门户随后把认证
交给一套 **CAS 单点登录**流程，成功后客户端还要走完一个小工作流（设备认证、服务选择），
网关才解除过滤器。整场逆向过程我写在
[逆向锐捷 ePortal 认证门户](/zh/posts/ruijie-campus-portal-reverse-engineering/) 里。

那里的机制，正是上文这些机制：一次携带身份的重定向、一个阻止重放的按次挑战、一个不
可复用的会话令牌，以及一个只有在 RADIUS 式授权之后才打开的网关。

## 无浏览器地自动化登录

上面的一切都是协议。只要是协议，脚本就能说。一个无浏览器的 **captive portal login**，
不过是浏览器走过的同一串请求，中间没有渲染：

```text
loop:
  probe   -> GET 一个外部 URL；204/预期 body 表示 ONLINE，休眠
  discover-> 跟随 302；抓取 sessionId、userIp、nasIp
  auth    -> 取登录页；解挑战；POST 凭据
  verify  -> 再探测一次；若仍被拦截，判为失败并退避
```

三条规则让这件事既合法又稳健：

- **先探测再行动。** 一个已经在线还去重新登录的客户端，会拆掉一条健康的会话。每轮
  循环顶部的那个探测，就是「保活」与「自伤式断网」之间的分界。
- **每次重新派生令牌。** 会话 ID 和挑战都是按次生成、会过期的。永远不要缓存它们。
- **失败要退避。** 一道验证码闸门或一个错误密码应当让循环停下，而不是猛敲——锁死账号
  最快的方式就是无界重试。

这只适用于你有权使用的网络、用你自己的凭据、针对浏览器自身会调用的同一批端点。它
不绕过付费、额度或任何访问控制，也绝不能指向你不拥有的网络。

## 心智模型

把 HTML 剥掉，一个认证门户就是四个活动部件：

1. 网关上一套**逐客户端的过滤器**，初始是关闭的。
2. 一个**拦截平面**（DHCP 选项 114、DNS，或 HTTP 302），它宣告门户并携带客户端身份。
3. 一份**检测契约**（CNA 探测，或 RFC 8910 / RFC 8908 API），它让操作系统决定是否
   弹出登录 UI。
4. 一个**会话与授权步骤**（MAC 绑定、MAB、RADIUS），它在有限时间内打开过滤器。

抓住这个模型，登录页就变成一件小事：一层盖在网关策略之上的前端。本站运行所依赖的
基础设施——自建的 Git 服务，以及部署它的那台机器——写在
[这个博客如何发布它自己](/zh/posts/how-this-blog-ships-itself/) 里，如果你想要流水线
的另一端。
