---
title: "Core Web Vitals 实战：LCP、CLS、INP 不猜，只测"
description: "不猜，只测：我搭了两个几乎一样的文章页面，一个乱、一个对，然后把 Lighthouse 和 web-vitals 的真实输出贴在下面。在以静态为主的站点上，LCP、CLS、INP 到底由什么决定，哪些微优化不值得做。"
pubDate: 2027-01-18
lang: zh
translationKey: core-web-vitals
tags: [seo, astro]
featured: false
keywords:
  - 核心网页指标
  - LCP
  - CLS
  - INP
  - Lighthouse
---

我不信「感觉很快」这种话，所以这篇文章是替代方案：两个几乎一样的文章页面——
同样的正文、同一张照片，一个按大多数站点实际发货的方式乱来，一个按应该发货
的方式来做——用真实的工具测量，输出原样贴在下面。**Core Web Vitals**
（LCP、CLS、INP）是三个你只能测量、没法嘴炮的数字，我选择测量。下面讲每一项
指标到底由什么构成，以及一份诚实的「哪些修复值得花一个晚上」清单。

## 三个指标、阈值，和谁来给你打分

| 指标 | 好 | 待改进 | 差 | 是什么 |
|---|---|---|---|---|
| **LCP**（最大内容绘制） | < 2.5 s | 2.5–4 s | > 4 s | 视口内最大元素绘制完成的时间 |
| **CLS**（累积布局偏移） | < 0.1 | 0.1–0.25 | > 0.25 | 访问期间意外布局偏移的总和 |
| **INP**（交互到下一次绘制） | < 200 ms | 200–500 ms | > 500 ms | 整个访问中最差的一次交互延迟 |

没人解释的部分是*谁给你打分*。**现场数据（field）**来自 CrUX，即 Chrome
用户体验报告：真实 Chrome 用户、第 75 百分位、统计 28 天。影响排名的是这个
数字。**实验室数据（lab）**是一次 Lighthouse 运行：被限速、被模拟的一次性访
问。PageSpeed Insights 两者并排显示，这是读报告唯一诚实的方式——实验室一
片绿而现场一片红，说明你的用户设备和实验室毫无关系。两个后果：其一，INP 以现场数据为准，一次没有交互的实验室运行其实没法给它打
分，Total Blocking Time（TBT）只是代理指标，而下面我会展示这个代理能撒多大
的谎。其二，模拟限速让实验室数字变得无聊：每个 fixture 跑三次，未优化的那个
每次都逐字节一致，优化后的那个则在几百毫秒的范围内晃动。

## LCP：四段时钟，其中三段在你手里

一次 LCP 测量是一条四段的小瀑布：

1. **TTFB**——HTML 首字节。服务器、CDN、TLS。
2. **资源加载延迟**——从首字节到浏览器*开始*下载 LCP 资源。给 hero 图加
   `loading="lazy"` 就生活在这一段。
3. **资源加载时长**——线上传输的字节。图片大小、格式。
4. **元素渲染延迟**——字节到达到像素绘制。主线程占用、阻塞渲染的 CSS、字体。

Lighthouse 把优化版 fixture 的 LCP 恰好拆成这四段
（取自 JSON 报告里的 `lcp-breakdown-insight`）：

```json
{"subpart":"timeToFirstByte","label":"Time to first byte","duration":4.325},
{"subpart":"resourceLoadDelay","label":"Resource load delay","duration":15.877},
{"subpart":"resourceLoadDuration","label":"Resource load duration","duration":4.531},
{"subpart":"elementRenderDelay","label":"Element render delay","duration":36.247}
```

LCP 元素是 `body > main.wrap > picture > img.hero`——一个放在 `<picture>`
里的 24.8 KB AVIF，带真实的 `width`/`height` 和 `fetchpriority="high"`。
每一段都很小，因为我让每一段都小了。

未优化的 fixture：同一张照片用 2.27 MB 的 PNG 发送，外加一个 880 KB 未子集化
的 TTF（`font-display: swap`），外加 53 KB CSS 和 52 KB「标签管理器」脚本，
两个都阻塞渲染、都放在 head 里。它测得的 LCP 是 **8.8 s**，而 Lighthouse
会自己点名凶手：

```
render-blocking-resources   Est savings of 4,990 ms | analytics.js 901ms ; app.css 751ms
uses-responsive-images      Est savings of 1,898 KiB | hero-big.png 1847KB ; hero-1200.webp 51KB
lcp-lazy-loaded             hero-big.png" loading="lazy" alt="…">
unsized-images              hero-big.png, hero-1200.webp
total-byte-weight           Total size was 3,258 KiB
```

三条教训，按字节排。**字节数胜过奇技淫巧**：2.2 MB 的 PNG 在 4G 上是几分钟
的痛苦，在本地网络上完全看不出来——所以第二个 fixture 用缩放过的、
AVIF 优先的 `<picture>`。**懒加载的 hero 是自作自受**：在 LCP 元素上加
`loading="lazy"`，等于拖延那个唯一决定分数的资源的发现时机。**阻塞渲染的脚
本是带弯路的 LCP 税**：head 里一个同步的分析脚本，内容再没用也会拖住首次绘
制；`defer` 它，或者在 load 事件之后再加载它。

<figure>
<svg viewBox="0 0 680 250" role="img" aria-label="LCP 时间线对比：未优化的 fixture 在绘制前要经历 8.8 秒的阻塞渲染脚本、大字体下载和 2.2 MB 的 PNG；优化后的 fixture 1.1 秒完成绘制。" fill="none" stroke="currentColor" font-family="ui-monospace, monospace" font-size="11">
  <text x="40" y="18" fill="currentColor" stroke="none" font-size="12">未优化 fixture — LCP 8.8 s</text>
  <rect x="40" y="28" width="547" height="34" rx="4" fill="#0f766e" fill-opacity="0.08" stroke-width="1"/>
  <rect x="40" y="28" width="3" height="34" fill="#0f766e"/>
  <rect x="43" y="28" width="102" height="34" fill="#0f766e" fill-opacity="0.75"/>
  <rect x="145" y="28" width="266" height="34" fill="#0f766e" fill-opacity="0.5"/>
  <rect x="411" y="28" width="173" height="34" fill="#0f766e" fill-opacity="0.3"/>
  <rect x="584" y="28" width="3" height="34" fill="#0f766e" fill-opacity="0.9"/>
  <text x="49" y="82" fill="currentColor" stroke="none">TTFB 4 ms</text>
  <text x="150" y="82" fill="currentColor" stroke="none">CSS + 标签管理器阻塞 1.6 s</text>
  <text x="200" y="98" fill="currentColor" stroke="none">880 KB 字体换入</text>
  <text x="470" y="82" fill="#0f766e" stroke="none">hero 2.2 MB PNG</text>
  <line x1="196" y1="24" x2="196" y2="128" stroke="#0f766e" stroke-dasharray="3 3"/>
  <text x="152" y="140" fill="currentColor" stroke="none">2.5 s 阈值</text>

  <text x="40" y="180" fill="currentColor" stroke="none" font-size="12">优化后 fixture — LCP 1.1 s</text>
  <rect x="40" y="190" width="68" height="26" rx="4" fill="#0f766e" fill-opacity="0.08" stroke-width="1"/>
  <rect x="40" y="190" width="3" height="26" fill="#0f766e"/>
  <rect x="43" y="190" width="49" height="26" fill="#0f766e" fill-opacity="0.6"/>
  <rect x="92" y="190" width="13" height="26" fill="#0f766e" fill-opacity="0.3"/>
  <rect x="105" y="190" width="3" height="26" fill="#0f766e" fill-opacity="0.9"/>
  <text x="40" y="236" fill="currentColor" stroke="none">预加载 AVIF 25 KB · 系统字体 · 无阻塞渲染 JS</text>
</svg>
<figcaption>两次 LCP 的解剖图，大致按比例，数据来自 Lighthouse 报告：TTFB →
阻塞渲染 → 传输 → 绘制。虚线是 2.5 s 的「好」阈值。同一张照片、同一段正
文；3,258 KiB 对 105 KiB。</figcaption>
</figure>

## CLS：首次绘制之后还在动的每一个像素

CLS 惩罚的是*意外*，不是慢：每一次没有近期用户输入作为借口的布局偏移，都按
（影响面积 × 移动距离）累加。现实里几乎所有 CLS 都来自三个源头，我的两个
fixture 故意全带上。

**没有尺寸的图片。** 两个 fixture 的图片都没有 `width` 和 `height`，浏览器
不预留空间，字节到达时的重排就算偏移。每张图加一对属性——或者 CSS 里加
`aspect-ratio`——偏移在源头消失。

**注入的内容。** 差 fixture 的标签管理器在 load 时往文章上方插了一个 cookie
横幅，300 ms 后又插了一个「广告位」。Lighthouse 运行里，光是横幅就贡献了页
面唯一被计入的偏移：

```
layout-shifts    score 0.0958 | <p>
```

0.096 *技术上*在 0.1 阈值之内——这个 fixture 通过「横幅刚好矮了 10 个像素才
没失败」的方式通过了 CLS。那不是设计，是抛硬币。正确的做法是把空间预留出
来，或者等用户滚过横幅将要出现的位置之后再注入。

**字体换入。** 差 fixture 先用衬线后备字体绘制，再换入一个宽度完全不同的
880 KB 无衬线体。这里的数字很乱，所以原样给出：Lighthouse 的模拟运行记录
**CLS 0.096**，而我不限速的浏览器运行测到 **CLS 0.273**（差），最大的一次
偏移是 `h1` 在 499 ms 时重排：

```json
{"name":"CLS","value":0.2725941844516331,"rating":"poor",
 "target":"html>body>main.wrap>h1","shiftTime":499.5,"shiftValue":0.1449832352532281}
```

两个实验室工具差出 3 倍不是 bug，正是要点：它们加载页面的时钟不同，*哪些*
偏移落在视口内会逐运行变化。两者都不是裁判——CrUX 才是。修法倒是殊途同
归：系统字体栈（优化版 fixture 用的就是这个），或者一个子集化的 `woff2` 加
`font-display: optional`，让换入不产生任何偏移。

## INP：Lighthouse 在实验室里看不见的那个指标

INP 是用户与页面最差一次交互的延迟：从输入到下一帧绘制。Lighthouse 用 TBT
近似它——FCP 到 TTI 之间的主线程阻塞总时长——而这里的近似失败得很有教育意
义：差 fixture 的启动长任务发生在首次绘制*之前*，落在 TBT 窗口之外，于是
Lighthouse 报告：

```
total-blocking-time   0 ms   score 1
```

零。完美。然而点击 fixture 的演示按钮——一个朴素的「过滤」，每次点击重新扫
50 万条数据——在真实浏览器里用 `web-vitals` attribution 版本测出来是这样：

```json
{"name":"INP","value":416,"rating":"needs-improvement",
 "target":"html>body>main.wrap>div.newsletter>button",
 "inputDelay":0.4,"procDur":406.1,"presentDelay":9.5}
```

416 ms，全在事件处理器里（`procDur` 406 ms）：一个同步循环、一场重排风暴。
优化版 fixture 在空闲时预计算索引，同一个 harness 里它的点击处理器测到
**INP 16 ms**：

```json
{"name":"INP","value":16,"rating":"good",
 "target":"html>body>main.wrap>div.newsletter>button","procDur":0.3}
```

TBT 抓的是*启动*长任务，INP 抓的是*交互*长任务，绿的 TBT 说明不了你的点击
处理器任何问题。在静态站点上，修法很少需要花活：预计算、把工作移出点击路
径、用事件委托——如果这个任务非存在不可，就扔进 worker。

## 我实际上怎么测

命令行里的 Lighthouse 是主力。本文每个数字背后的确切运行方式——静态 fixture
跑在 `127.0.0.1:8099`，Lighthouse 12.8.2 + Chromium 139，移动预设（模拟慢速
4G：1.6 Mbps、150 ms RTT、4× CPU 限速），每个页面三次：

```console
$ CHROME_PATH=/ms-playwright/chromium-1181/chrome-linux/chrome \
  lighthouse http://127.0.0.1:8099/bad.html \
  --output=json --output-path=/tmp/lh-bad.json \
  --disable-full-page-screenshot \
  --only-audits="first-contentful-paint,largest-contentful-paint,cumulative-layout-shift,total-blocking-time,interactive,lcp-breakdown-insight" \
  --chrome-flags="--no-sandbox --headless=new"
LH:status Generating results...
```

留住 JSON：审计项的名字（`render-blocking-resources`、
`uses-responsive-images`、`unsized-images`、`lcp-lazy-loaded`）直接告诉你
按字节花费的顺序该修什么。现场数据我用浏览器里的 PageSpeed Insights，历史趋
势用 CrUX API（或 BigQuery）——三个月的 p75 数字胜过任何实验室数字，而有现场
数据的会议室里，谁也不该拿实验室数字争辩。想要自己的 INP，上面那段
`web-vitals` 只有 20 行，可以直接跑在生产环境。

还有 `curl -w`，因为 TTFB 的理智检查只要十秒：

```console
$ curl -s -o /dev/null -w "ttfb=%{time_starttransfer}s total=%{time_total}s size=%{size_download}B\n" \
    http://127.0.0.1:8099/good.html
ttfb=0.001113s total=0.001199s size=6164B
```

两个 fixture 都在 ~1 ms 内响应：瓶颈从来不是网络，是前端。这就是测量而不是
瞎猜的意义——在 localhost 上，58 分和 100 分的差距 100% 是你能控制的东
西。

## 前后对比

同样的正文、同一张照片，一边一个页面：

| | 未优化 | 优化后 |
|---|---|---|
| LCP | 8.8 s ❌ | 1.1 s ✅ |
| CLS | 0.096 ⚠️ | 0 ✅ |
| TBT | 0 ms | 10–120 ms（三次运行） |
| 实测 INP（web-vitals） | 416 ms ❌ | 16 ms ✅ |
| FCP / TTI | 5.9 s / 9.0 s | 0.6 s / 1.1 s |
| 页面重量 | 3,258 KiB，8 个请求 | 105 KiB，5 个请求 |
| Lighthouse 性能分 | 58 | 100 |
| Hero 图 | 2.27 MB PNG，懒加载，无尺寸 | 24.8 KB AVIF，预加载，有尺寸 |
| CSS | 53 KB 阻塞渲染 | 3 KB 内联 |
| 第三方 JS | 52 KB 同步标签管理器 | 无 |

## 我在以静态为主的站点上做什么，以及跳过什么

诚实的优先级，按「每小时换回的字节」排：

1. **服务器和 CDN 优先。** CDN 后面的静态 HTML 是你能买到的最便宜的 TTFB；
   没有任何前端工作能修复一个 900 ms 的源站。这也是我按[2026 年的静态站
   点](/zh/posts/static-sites-in-2026/)那一套做事的大部分理由。
2. **一条图片流水线。** 缩放到你实际展示的最大尺寸，AVIF 加 WebP 回退，真
   实的 `width`/`height`，hero 图 `fetchpriority="high"`，折叠以下才
   `loading="lazy"`。这几乎是所有内容站点上杠杆最大的一步。
3. **注入造成的布局为零。** 横幅和广告如果非存在不可，就给它预留格子。CLS
   是唯一一个纯粹靠纪律就能拿满的指标。
4. **JS 越少越好**——阅读路径上最好一个都没有。剩下的全部 `defer`、事件委
   托、预计算，因为 INP 量的是用户动手之后你做的事。

还有一批我已经不做的微优化，因为测过，全是噪音：给一个 3 KB 的样式表配
critical-CSS 工具链（直接内联就行）；对自己的源站 `preconnect`（同源连接本
来就是热的）；一个 webfont 都不发却折腾 `font-display`；给不用的域加
`dns-prefetch`；把固定宽栏位的图片拆成四个 srcset 候选而不是一张尺寸正确
的图；把 brotli 已经压过的东西再压一遍。fixture 的 CSS 原始 54,619 字节、
gzip 后 8,880——如果你的流水线连文本压缩都没有，先修它，再谈用调度器省
50 ms INP。

最后一条：不要追那些你搬不动的实验室分数。90 → 95 通常是三个小胜利加大量
仪式，而上面那个 58 → 100 来自四个结构性决定。想知道构建和页面到底在哪里
浪费时间，[为什么构建很慢](/zh/posts/why-builds-are-slow/) 是从另一头做的同
一个实验。

测量现场数据，修最大的那个问题，然后上线。这就是全部方法。
