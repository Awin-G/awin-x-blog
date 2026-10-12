---
title: "独立开发者的功能开关：不用 SaaS 也能做好的 feature flags"
description: "功能开关能把「部署」和「发布」解耦，给你一个紧急开关和渐进式灰度发布——而且不必买 LaunchDarkly。一套极简自托管方案：一个配置文件、一个环境变量覆盖、按请求求值、默认失败关闭，以及一条会在开关过期前就把它删掉的生命周期。"
pubDate: 2026-11-29
lang: zh
translationKey: feature-flags
tags: [devops, self-hosting]
featured: false
keywords:
  - 功能开关
  - 特性开关
  - 紧急开关
  - 灰度发布
  - 部署与发布分离
---

**功能开关（feature flags）**是分离「部署代码」和「发布行为」最便宜的手段，而且你根本不需要 SaaS。我的开关就跑在一个随应用一起发布的配置文件里，再加一个应急用的环境变量。这就够支撑一个紧急开关（kill switch）、一次渐进式灰度发布和一次 A/B 实验了——而且小到我真的会在用完之后把它删掉。功能开关最难的部分从来不是「求一个布尔值」这件事，而是围绕它的生命周期，而这恰好是重量级厂商帮不了你的地方。

## 功能开关是干什么的——以及它们会变成什么

用一个开关的理由是**部署与发布分离**。部署是把字节放上服务器，发布是改变用户看到的东西。把两者绑在一起，就意味着每次发布都是一次部署、每次部署都是一次风险。开关切断了这条链：让代码先暗着上线，等你准备好了再打开。

一个开关能做好的四件事：

- **把「部署」和「决定要不要上」拆开。** 新编辑器先合并进来、先关着，等周二上午十点我还醒着能盯着看的时候再打开。
- **紧急开关。** 一个布尔量，在高负载下关掉某个子系统——改一次配置就行，而不是回滚。这是唯一真正意义上长期存在的开关类型。
- **渐进式灰度发布。** 先给 1% 的用户，再 10%、50%、最后全量——一旦错误率动了就提前刹车。
- **A/B 实验。** 两个变体、一个指标、最后做一个决定。

然后是最常见的失败模式，比上面四种用途加起来还普遍：**永远不删的开关**。一个发布开关挂了一年是永久的 `if`；再叠加 `&&`，你就得到了一团**「if 意大利面」**——代码真实的运行行为是一堆没人能在脑子里装下的状态矩阵。僵尸开关比没有开关更糟：它的「关闭」分支根本没测过，还早晚会有人去拨一个早就没用的开关。每个开关都以工具的身份出生，最后以**技术债**的身份死去——除非你在第一天就为它的删除做好安排。

## 四种特性开关：发布开关、紧急开关、实验开关、权限开关

最有用的一个习惯，是给每个开关贴上类型标签，因为类型本身就告诉你它应该活多久。

| 类型 | 存活时间 | 缺失时的默认值 | 何时删除 |
| --- | --- | --- | --- |
| 发布开关 | 数天–数周 | 关 | 新路径成为唯一路径 |
| 运维/紧急开关 | 永久（设计如此） | 开（运维上倾向于放行） | 该子系统被移除 |
| 实验开关 | 直到出结果 | 关 | A/B 实验有了结论 |
| 权限开关 | 数月 | 关 | 演进成真正的权限系统 |

「存活时间」这一列才是重点。没被删掉的发布开关是一颗定时炸弹；而长期存在的权限开关本身没问题——*前提是*它被正确地建模。把这两种东西混在一堆没有区分的布尔量里，就是你后来什么都删不掉的原因。

## 极简自托管方案：配置文件、环境变量覆盖、按请求求值

我用的设计只有三条规则：

1. **开关是数据，不是代码。** 它们活在一个文件里——默认值提交进仓库，线上值挂载在服务器上。改开关就是改数据，所以它不需要部署。
2. **单一事实来源，单一覆盖入口。** 文件是事实，每个开关对应一个环境变量，只为了让我在事故中能从 shell 强制取值，而不用改任何文件。
3. **按请求求值，在内存里做。** 文件只解析一次，变化时热重载。开关查找从不在请求热路径上发起网络调用。

整个系统就是一个配置文件：

```yaml
# flags.yaml —— 这就是全部的「功能开关服务」
version: 1
flags:
  new_editor:                 # 发布开关：短命
    type: release
    enabled: true
    rollout: 25               # 命中主体（subject）的百分比
    default: false            # 缺失时调用方拿到的值
    owner: deepseek
    created: 2026-11-01
    remove_by: 2026-12-15     # 过了这天 CI 会失败

  checkouts_paused:           # 运维 / 紧急开关
    type: ops
    enabled: false            # 关闭 = 正常路径
    default: false

  recommendations_v2:         # 实验开关：需要一个结论
    type: experiment
    enabled: true
    rollout: 50
    default: false

  team_sso:                   # 权限开关：白名单
    type: permission
    enabled: true
    allow: [team-alpha, team-beta]
    default: false
```

`remove_by` 这个字段不是装饰品——一个小 CI 检查会读它，日期一过就构建失败。这是我找到的唯一能可靠地「杀掉」开关、而不让它老成一根承重 `if` 的办法。

## 安全地给默认值：失败关闭，并给开关标类型

两条规则能让一套自制的开关系统不至于变成故障来源。

**失败关闭（fail closed）。** 如果配置文件缺失、损坏，或者开关名未知，答案就是「关」——绝不在请求路径上抛异常，也绝不意外地「开」。功能开关应当能够被删除，并把系统带回它之前的行为。唯一的例外是运维开关：那里由你刻意决定「失败放行」是否更安全；对大多数紧急开关来说，只有当该功能确实可选时，「松开刹车」才是正确的默认。

**给查询标类型。** 让每个调用点都显式带上默认值，而不是依赖配置文件里碰巧写了什么。一个缺失的开关配上一个有类型的默认值，是一种接近编译期的承诺；一个缺失就抛异常的开关，是一通凌晨三点的电话。

```python
import hashlib, json, os

_config: dict = {}

def load(path: str = "flags.json") -> None:
    global _config
    try:
        with open(path) as f:
            _config = json.load(f).get("flags", {})
    except (OSError, ValueError):
        _config = {}          # 失败关闭：文件读不出来 => 所有开关都关

def enabled(name: str, subject: str = "", default: bool = False) -> bool:
    # 用调用方显式传入的默认值，而不是文件里恰好写了什么
    flag = _config.get(name)
    if flag is None:
        return default
    # 来自 shell 的应急覆盖：FLAG_NEW_EDITOR=1
    if os.environ.get(f"FLAG_{name.upper()}") in ("1", "true"):
        return True
    if not flag.get("enabled", False):
        return False
    if "allow" in flag:                       # 权限开关
        return subject in flag["allow"]
    pct = flag.get("rollout")
    if pct is None:
        return True                           # 全量开启
    # 稳定的分桶：同一个主体永远落在同一个桶里
    h = hashlib.sha1(f"{name}:{subject}".encode()).hexdigest()
    return int(h[:8], 16) % 100 < pct
```

两个细节撑起了全部重量。**稳定分桶**——对 `name:subject` 做哈希——意味着 25% 里的用户在下一个请求里还在这个组里，于是灰度是一个队列，而不是一次抛硬币。而**调用方的默认值**意味着，一个已经从文件里删掉的开关会退化成安全行为，而不是崩溃。

## 生命周期：创建 → 灰度发布 → 移除

每个开关都有生日，也都有忌日。跳过忌日，就是整场病的根源。

<figure>
<svg viewBox="0 0 700 150" width="100%" role="img" aria-label="功能开关的生命周期：带着移除日期创建，从百分之一到百分之五十渐进式灰度发布，全量开启，然后删除开关和它对应的死代码分支。">
  <defs>
    <marker id="ff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="10" y="46" width="138" height="60" rx="9"/>
    <rect x="186" y="46" width="138" height="60" rx="9"/>
    <rect x="362" y="46" width="138" height="60" rx="9"/>
    <rect x="538" y="46" width="138" height="60" rx="9" stroke-dasharray="5 4"/>
    <path d="M148 76 H186" marker-end="url(#ff-arrow)"/>
    <path d="M324 76 H362" marker-end="url(#ff-arrow)"/>
    <path d="M500 76 H538" marker-end="url(#ff-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="79" y="70">创建</text>
    <text x="79" y="88" font-size="11" opacity="0.75">类型 + 默认值</text>
    <text x="79" y="102" font-size="11" opacity="0.75">+ remove_by</text>
    <text x="255" y="70">灰度发布</text>
    <text x="255" y="88" font-size="11" opacity="0.75">1% → 10% → 50%</text>
    <text x="431" y="70">100%</text>
    <text x="431" y="88" font-size="11" opacity="0.75">开关现在</text>
    <text x="431" y="102" font-size="11" opacity="0.75">就是唯一路径</text>
    <text x="607" y="70">移除</text>
    <text x="607" y="88" font-size="11" opacity="0.75">删掉开关</text>
    <text x="607" y="102" font-size="11" opacity="0.75">+ 死分支</text>
  </g>
  <text x="350" y="134" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.75">过期的开关是 bug，不是遗留物</text>
</svg>
<figcaption>生命周期本身就是这个功能。没有安排移除时间的开关，是一根你要永远测下去的永久分支。</figcaption>
</figure>

落到实践里，这几步长这样：

1. **创建。** 加上配置行：类型、负责人、一个安全的 `default`、一个 `remove_by` 日期。把代码提交到 `if enabled("new_editor", user.id)` 背后。
2. **灰度发布。** 用几天把 `rollout` 往上翻，盯着错误率和延迟。出问题就设成 `0`——这就是紧急开关，而且因为不涉及部署，几秒钟就生效。要是整个功能都坏了，`enabled: false` 就是回滚。
3. **移除。** 当灰度到 100%、旧路径成了死代码时，在一次提交里同时删掉配置里的开关*和*它守护的分支。退役的是代码，不只是那个开关。

之所以要用机械手段强制执行第 3 步，是因为人在这件事上普遍不可靠。留一个开关就有两种行为，两种都得测；四个开关就要测十六种。这个数是**指数级**的，而唯一常数时间的解药就是删除。这也是我把过期开关和失败的测试同等对待的原因：构建先停下，直到它被清掉。

如果这篇你只带走一句话，那就是：**在创建开关的时候就把移除排上日程**，然后让 CI 去做那个记得住的人。

## 什么时候开关是错的工具

开关很诱人，所以值得点名它在哪些场合是错误答案：

- **当它其实是用户配置时。** 如果该由人来选主题、选偏好，那是一张设置表，不是功能开关。开关是给**你**控制的，而且是临时的；设置是给**他们**的，而且是永久的。
- **当它其实是长期权限时。** 按套餐分级的限额、角色、配额，属于权限（entitlement）或授权模型，而不是一份越来越长的开关白名单。一个已经变成你授权层的开关系统，永远删不掉。
- **当它在掩盖一次坏掉的部署时。** 如果你不靠一个开关守着就没法安全上线，那 bug 在部署路径上。去修那条路——[原子符号链接与蓝绿部署](/zh/posts/zero-downtime-deploys/)解决的正是这些机制，好让开关不必去扛它们。
- **用于 schema 变更时。** 数据库迁移要的是向前/向后兼容的方案，不是一个布尔量。你没法用一个开关消掉一个已经不存在的列。
- **当你永远不会删它、而分支本来也便宜时。** 五行函数里的一个布尔量是合理的常量，五十个就不是了。

功能开关是一件带小契约的小工具：把部署和发布解耦，给自己一个紧急开关和一次灰度发布，然后清理干净。自托管那部分几乎是顺带的——一个文件、一次哈希、一个环境变量覆盖——而恰恰是这一点让它可存活。它和我[在 2026 年自托管的东西](/zh/posts/what-i-self-host-2026/)是同一种哲学：一个你完全理解的、无聊的本地版本，胜过你租来之后就忘了的托管版本。

写下开关，标上它的死期，然后按时删掉。这就是全部的纪律，也是任何厂商替你做不了的那部分。
