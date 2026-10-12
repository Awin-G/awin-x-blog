---
title: "搭建一个不说谎的 status page"
description: "status page 是一句关于可用性与 incident communication 的承诺，而不是一盏绿灯。如何搭一个独立于被监控系统之外的状态页：静态页面加 checker 的极简设计、一份 status JSON schema，以及尊重误报的诚实 uptime monitoring。"
pubDate: 2026-11-28
lang: zh
translationKey: status-page
tags: [devops, self-hosting]
featured: false
keywords:
  - status page
  - uptime monitoring
  - incident communication
  - health check
  - dead man's switch
---

**status page** 是一句承诺：这是此刻谁在线，这是哪里坏了，这是我们什么时候知道的。大多数状态页都违背了这句承诺。它们是被自己声称要监控的系统渲染出来的一盏绿灯，由一个从未被告知「你可能会错」的存活检查来翻转。一旦真出事，页面要么变黑，要么一直绿着，要么悄悄停止更新——然后所有人就学会了无视它。诚实的 **uptime monitoring** 和 **incident communication** 是修复方案的两半，而这两半都比大多数团队装的那个小控件要难。

我在一台 VPS 上跑着这个博客和一小撮服务。给自己搭状态页时我只立了一条规矩：它必须是这台机器上最后一个倒下的东西，而且即使机器烧起来了，它也得说真话。下面这个设计，是经受过现实检验后活下来的版本。

## status page 是干什么的——以及大多数状态页实际是什么

只有两件事，且只有这两件：

- **可用性**——每个服务当前、真实的状态。在线、降级、宕机。一句你能被验证的断言。
- **incident communication**——影响了什么、从什么时候开始、你在做什么、以及大家最近一次听到消息是什么时候。看页面的人需要一条时间线，不是一个颜色。

就这些。状态页不是营销素材，不是 Grafana 看板，也不是用来把一次小故障藏在一片让人安心的绿色后面的地方。如果你是冲着「显得一切正常」去用它，那你早就输掉了人心。

而大多数状态页实际是什么：一条由返回 200 的 `curl` 驱动的、「所有系统正常运行」的静态横幅，托管在同一套基础设施里，由同一台机器上的任务来更新。那台机器一死，页面要么跟着一起死（没人会注意到「更新停止了」），要么永远显示最后一次已知的正常状态（一个看起来像平静的谎言）。绿灯之所以是错的，是因为它回答的是错误的问题。「我的监控任务能连上服务吗」并不是「服务在线吗」。

## 托管 vs 自托管 status page

第一个岔路口。

**托管方案**（Statuspage、Better Stack、Instatus 之类）买到的是一个真正在你爆炸半径之外的域名、别人的可用性、短信和订阅通知，以及一个发故障更新的 UI。对一个要面对客户、要守 **SLA** 的团队，这往往是对的选择：你的 VPS 挂的那天，他们的状态页还活着，因为它不是你的。代价是月费、一个现在知道你全部故障史的第三方，以及一种会把你往同一个省事的谎言上推的设计——一个开关，一个绿点。

**自托管方案**（Uptime Kuma、Gatus、Cachet，或者你自己写的页面）给你控制权、不花钱，但把整个练习里最难的问题甩回给你：*页面必须跑在被监控对象之外的某个地方。* 一台跑在被监控 VPS 上的自托管状态页，是场表演。只有当它住在第二台主机、另一个服务商、或者至少另一个故障域里时，它才是真的。

我选自托管，因为它逼我去解决那个真问题，而不是把信任外包出去。但不管你选哪个，解耦才是重点，而这恰恰是托管厂商隐含地卖给你的东西。

## 最难的部分：页面必须比它监控的东西活得更久

这是把真状态页和装饰性状态页区分开来的那个想法，值得直白地说清楚。

- 状态页必须住在与它所报告的服务**不同的故障域**里。不同主机，最好不同服务商。
- 它必须在**它所监控的一切都宕机时**仍然可用——包括连到页面自己后端的网络路径被切断的时候。
- 它必须在**系统已经宕机时仍被更新**，这意味着这个更新不能依赖那个挂掉的系统还有足够健康度去推送更新。

常见的错误是：在被监控的那台机器上跑一个拉取模型。解法是把方向倒过来：让一个小小的 **checker** 跑在中立的地方，通过网络去探测服务，然后写下一个状态文件。静态页面只是这个文件的读取者。checker 与页面解耦，页面与服务解耦。链条上没有任何一环依赖它正在度量的那个东西。

## 极简设计：静态页面 + checker + 人工故障记录

下面是全部架构，它是刻意保持小的。

<figure>
<svg viewBox="0 0 660 220" width="100%" role="img" aria-label="一条解耦的状态页流水线：跑在中立主机上的 checker 探测 VPS 上的服务，把状态 JSON 文件写进另一台主机上的 status store；一个从该 store 提供服务的静态页面读取 JSON 并渲染；人手工把故障记录写进同一个 store。">
  <defs>
    <marker id="sp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="70" width="130" height="60" rx="8"/>
    <rect x="265" y="70" width="130" height="60" rx="8"/>
    <rect x="522" y="70" width="130" height="60" rx="8"/>
    <rect x="265" y="12" width="130" height="40" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="138" y1="100" x2="263" y2="100" marker-end="url(#sp-arrow)"/>
    <line x1="395" y1="100" x2="520" y2="100" marker-end="url(#sp-arrow)"/>
    <line x1="330" y1="52" x2="330" y2="68" marker-end="url(#sp-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="73" y="105" text-anchor="middle">checker</text>
    <text x="330" y="105" text-anchor="middle">status store</text>
    <text x="587" y="105" text-anchor="middle">static page</text>
    <text x="330" y="37" text-anchor="middle">你（故障记录）</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="73" y="145" text-anchor="middle">中立主机，</text>
    <text x="73" y="160" text-anchor="middle">通过网络探测</text>
    <text x="330" y="145" text-anchor="middle">独立的一台主机</text>
    <text x="330" y="160" text-anchor="middle">存放 status.json</text>
    <text x="587" y="145" text-anchor="middle">只读文件，</text>
    <text x="587" y="160" text-anchor="middle">自身没有任何逻辑</text>
    <text x="330" y="200" text-anchor="middle" opacity="0.9">链条上没有任何一环依赖它正在度量的东西</text>
  </g>
</svg>
<figcaption>checker、store、page 是三个独立的故障域。页面是刻意「笨」的——store 说什么它就渲染什么，哪怕那是关于托管这份数据那台机器的坏消息。</figcaption>
</figure>

三块，每一块都刻意无趣：

1. **checker**，跑在中立主机上——第二台 VPS、一台便宜的小机器，甚至一个 CI 定时任务。它探测服务，写下唯一一个文件。
2. **status store**——一个小仓库、一个对象存储桶，或者一个 git 分支。它存放 `status.json` 和故障历史。它必须能独立于被监控的服务被访问到。
3. **静态页面**——读取 JSON 并渲染的 HTML。没有服务端逻辑，没有数据库，被监控机器上也没有管理面板。静态文件不可能跟着你的数据库一起挂，而且它能在 CDN 上被轻松缓存。

数据模型小到可以手写：

```json
{
  "updated": "2026-11-28T09:41:00Z",
  "overall": "degraded",
  "components": [
    { "id": "blog",   "name": "博客",         "state": "operational", "checked": "2026-11-28T09:40:52Z" },
    { "id": "gitea",  "name": "Git 托管",     "state": "operational", "checked": "2026-11-28T09:40:55Z" },
    { "id": "vpn",    "name": "Overlay 网络", "state": "degraded",    "checked": "2026-11-28T09:40:58Z" }
  ],
  "incidents": [
    {
      "id": "2026-11-28-vpn",
      "title": "Overlay 网络延迟升高",
      "state": "investigating",
      "impact": "degraded",
      "started": "2026-11-28T09:12:00Z",
      "resolved": null,
      "updates": [
        { "at": "2026-11-28T09:20:00Z", "text": "节点 eu-2 延迟升高，正在排查。" }
      ]
    }
  ]
}
```

组件的 `state` 取值为 `operational`、`degraded`、`down`、`maintenance` 之一。一次故障也有自己的 `state`——`investigating`、`identified`、`monitoring`、`resolved`——而这个字段正是 **incident communication** 的全部意义所在：它告诉读者你到底知道多少。

## 自动检查会朝两个方向说谎

checker 不是真相的来源。它是一种*证据*的来源，而证据有时是错的。

- **误报（false positive）**——检查失败但服务其实没事。丢一个包、一次慢的 TLS 握手、你的监控主机自己抽风的 DNS、因为你探测太频繁而触发的限流。如果这一下就把页面自动翻成「宕机」，你就教会了用户这个页面爱喊狼来了，等真出故障时他们不会再信。
- **漏报（false negative）**——检查通过但服务对其他人来说是坏的。一个在后面数据库不可达时仍然返回 200 的 health endpoint。一个你连得上但整个区域都连不上的 CDN 边缘。应用丢了数据之后登录页返回的 `200 OK`。这个绿点技术上为真，同时完全误导。

解法不是做一个更好的检查，而是**克制**。

不要在服务恢复时太急于把它自动翻回 `operational`。要求连续 N 次成功才清除一个失败状态，这样一次抖动就不会造成一次戏剧性的「已恢复」——那其实只是噪声。并且把*进入坏状态*和*回到好状态*区别对待：单次失败检查可以立刻定为 `degraded`，因为早点预警是便宜且诚实的；但清除它应该需要一段持续的好检查，因为过早宣告一切正常，是最伤信誉的那一个谎。

凡是后果真实的地方——任何带 **SLA** 的、任何牵扯钱的——都根本不要让自动信号去改动对外的说法。可以让 checker 翻转组件颜色，但故障文案要由人来负责。自动化负责把人叫醒；它不负责写那份认罪书。

## 完整版：藏在定时器里的 checker

checker 就是定时器上跑的一个脚本。下面是它的形状——探测、跟上一个状态对比，只在真的有变化时才写回：

```python
#!/usr/bin/env python3
# /usr/local/bin/status-check.py —— 跑在中立主机上，不是被监控的那台机器
import json, time, urllib.request, datetime, sys

TARGETS = {
    "blog":  "https://blog.example.com/healthz",
    "gitea": "https://git.example.com/api/healthz",
}
STATE = "/srv/status/status.json"
CONFIRM = 2  # 清除一次失败需要连续几次好检查

def probe(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False

now = datetime.datetime.now(datetime.timezone.utc).isoformat()
doc = json.load(open(STATE))

for comp in doc["components"]:
    ok = probe(TARGETS[comp["id"]])
    fail_streak = comp.get("fail_streak", 0) + (0 if ok else 1)
    ok_streak   = comp.get("ok_streak", 0) + (1 if ok else 0)
    # 预警要快，清除要慢
    if not ok:
        comp["state"] = "down"
    elif ok_streak >= CONFIRM:
        comp["state"] = "operational"
    comp["fail_streak"], comp["ok_streak"] = fail_streak, ok_streak
    comp["checked"] = now

doc["updated"] = now
doc["overall"] = ("down" if any(c["state"] == "down" for c in doc["components"])
                  else "degraded" if any(c["state"] == "degraded" for c in doc["components"])
                  else "operational")

# 原子写入，页面永远读不到写了一半的文件
tmp = STATE + ".tmp"
json.dump(doc, open(tmp, "w"), indent=2)
import os; os.replace(tmp, STATE)
```

还有让它保持诚实的定时器——外加那个盯着「盯梢者」的检查：

```ini
# /etc/systemd/system/status-check.timer
[Unit]
Description=探测服务并更新 status store

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

微妙的部分在最后一公里。如果 checker 自己死了，页面不会变红——它只是冻住了。还在写着「operational」的过期数据，就是一个谎言。所以要把*新鲜度*当作一等信号：

```bash
# dead man's switch：如果 store 很久没被刷新，就大声说出来
AGE=$(( $(date +%s) - $(date -d "$(jq -r .updated /srv/status/status.json)" +%s) ))
[ "$AGE" -lt 600 ] || echo "status store stale: ${AGE}s"
```

这就是一个 **dead man's switch**。更新的缺失本身就是一次故障，页面此时应该渲染「状态未知」，而不是一个它无法担保的绿点。一句诚实的「未知」，永远胜过一句自信的错误答案。

## 信任规则

上面这一切都只是四条规则的脚手架。违反任何一条，这个页面都比没有更糟。

- **只说你知道的。** 只报告检查真正观察到的东西。不要从沉默中推断出「operational」，也不要在证据说话之前把 `degraded` 升级成 `operational`。
- **在你知情的那一刻就说。** 一个一小时后才更新的状态页是 changelog。哪怕还没有根因，也要在 `investigating` 时就发出故障——「我们知道了，正在看」是你将发布的最有价值的一句话。
- **不要失联。** 一次缓慢、局部的更新好过沉默。没有新消息时，就说没有新消息。「仍在排查，暂无新信息」是一次正当且诚实的更新，远好过停在最后一条坏消息上的时间线。
- **绝不让页面对一个正在对它撒谎的系统显示绿色。** 如果健康检查和页面都能由那个出故障的系统产出，那你搭的不是状态页，而是一面镜子。

## 闭环

整个设计就一句话：**一个 checker 和一个不同故障域里的页面、它们之间的一个 store，以及一个写下真相的人。** 把解耦做对，页面就能在它本就为描述而存在的那场故障里继续工作。把克制做对，页面就不再喊狼来了。把信任规则做对，在它变红的时候人们会信。

如果你要把这套东西跟其余的小型基础设施一起立起来，就按你跑其他所有东西的方式去跑它——一个服务只管一件事。我关于 [监控一支小舰队](/zh/posts/monitoring-a-small-fleet/) 的笔记讲的是可观测性那一半；而故障结束之后，[撰写 postmortem](/zh/posts/writing-postmortems/) 才是把状态页那条时间线变成一次真正落地的修复的方式。一个没人信的状态页，不过是一盏带着借口的绿灯；而一个说真话的状态页，是一句你守得住的承诺。
