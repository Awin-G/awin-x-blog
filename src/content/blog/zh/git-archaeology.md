---
title: "Git 考古学：如何查出某一行代码是何时、为何被改动的"
description: "一套可落地的 git archaeology 方法：用 git log -S（pickaxe）和 -G 找出某个字符串何时被改，用 git log -L 追踪单个函数的演变，正视 git blame 的局限（-w、-C），用 --follow 跨重命名，用 git bisect run 揪出引入回归的那一次提交——最后去读「为什么」，而不只是「改了什么」。"
pubDate: 2026-12-05
lang: zh
translationKey: git-archaeology
tags: [devops, linux]
featured: false
keywords:
  - git log -S
  - git blame
  - git bisect
  - git 考古
  - pickaxe
---

半年前有人改了一行代码，现在某处隐隐出错了。没有工单、没有注释、也没有明显的作者。这就是该做 **git 考古**（git archaeology）的时候：翻查历史，弄清某一行*何时*被改、*为什么*被改。好消息是 git 把一切都记了下来；坏消息是这些工具有一堆陷阱，而最流行的那一个——`git blame`——回答的根本不是你想问的问题。我通常的第一步根本不是 blame，而是 `git log -S`，也就是 pickaxe，去搜那个让我困惑的精确字符串。

下面是我实际会跑的工作流，跑在一个我临时搭的仓库上，所以下面每条命令都会打印真实输出。

## 一个藏着回归的小仓库

这个 demo 是一个订阅邮件摘要抓取器。它从一个单文件长成一个包，一个辅助函数在文件之间搬过家，然后在某一天，一次重构悄悄删掉了一个退避上限。历史长这样：

```text
* f227728 feat: render the digest as a plain-text report
* 94d0479 style: reflow core/ (trailing whitespace, no logic change)
* d3288d9 docs: note the API rate limit in the README
* 65b321f simplify backoff: the cap was never hit in practice   <-- the bug
* 389277e (tag: v0.2.0) extract retry_delay and clamp into core/util.py
* f291cea refactor: move digest.py under core/ to make room for more modules
* dfb797b (tag: v0.1.0) retry transient API failures with exponential backoff
* 542a97f init: fetch newsletter items from the API
```

八个提交。小到可以用肉眼看，这也正是它适合当教学例子的原因：在那个顶层摘要里，这个 bug 是隐形的，因为那条提交信息写得自信满满，而且具有误导性。

## `git log -S`：pickaxe 找出字符串何时改变

pickaxe 就是 `git log -S<字符串>`。它遍历历史，列出 `<字符串>` 的*出现次数*发生变化的每一次提交——新增它的提交，或删除它的提交，而不包括只是改动了周围措辞的提交。当你知道某个魔法常量、某个 flag 名、或某个 API 标识符，却不知道它从哪来时，这是 git 里最快的一问：

```console
$ git log -S 'BACKOFF_CAP' --oneline
65b321f simplify backoff: the cap was never hit in practice
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff
```

三次提交，三秒钟，这个常量的完整一生就摊在眼前：引入、搬移、删除。现在我知道那次删除是我的头号嫌疑人。加上 `--stat`（或 `-p`）会把每个命中变成一段 diff，于是我只看到*相关*的 hunk，而不是整个提交：

```console
$ git log -S 'BACKOFF_CAP' --stat
65b321f simplify backoff: the cap was never hit in practice
 core/util.py | 3 +--
 1 file changed, 1 insertion(+), 2 deletions(-)
```

如果这个字符串在文件之间搬了家，pickaxe 会免费跟着它走，因为它比较的是历史上每个分支的每一段 diff。而这恰恰是 `git blame` 处理不了的情况——下面细说。

## `-S` 与 `-G`：计数 vs 匹配 diff

有一个容易让人踩坑的姊妹 flag。`-S` 统计字面字符串的出现次数；`-G<正则>` 列出所有 diff 里存在匹配该正则的 `+` 或 `-` 行的提交。对同一个词，它们大多一致，但恰恰会在欺骗你的那些改动上分道扬镳：

```console
$ git log -S 'retry_delay' --oneline
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff

$ git log -G 'retry_delay' --oneline
94d0479 style: reflow core/ (trailing whitespace, no logic change)
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff
```

reflow 提交 `94d0479` 只加了行尾空白，所以 `retry_delay` 的*次数*没有变化，`-S` 正确地忽略了它。而 `-G` 看到了匹配的 `+`/`-` 行，就把它报了出来。经验法则：想找引入或删除某样东西的提交，用 `-S`；当字符串可能被原地改写、而你想看到所有动过它附近行的 diff 时，用 `-G`——同时接受 `-G` 会带回格式噪音。

## `git log -L`：追踪单个函数的演变

当问题关乎一个*函数*而不是一个字符串时，`-L` 读起来就像这个函数的剧本。它接受一个行区间，或者更好的是 `函数:文件` 这样的组合：

```console
$ git log -L ':retry_delay:core/util.py' --oneline -s
94d0479 style: reflow core/ (trailing whitespace, no logic change)
65b321f simplify backoff: the cap was never hit in practice
389277e extract retry_delay and clamp into core/util.py
```

每一条都是只限于该函数的 diff，所以我能看着 `min(2 ** attempt, BACKOFF_CAP)` 变成光秃秃的 `2 ** attempt`，而不必去读一行无关代码。`-L` 认识 Python、C、Go、Rust 等等——它用每种语言内置的正则按名字找到函数。

需要注意的是：`-L` 的作用域是某个文件里的某条路径。它不会跟着搬到另一个文件的函数走——把它和 `--follow` 一起用，git 会直接拒绝：

```console
$ git log --follow -L ':retry_delay:core/util.py' --oneline -s
fatal: --follow requires exactly one pathspec
```

所以对于一个搬过家的函数，我会对旧文件和新文件*各*跑一次 `-L`。旧位置显示它从哪来，新位置显示它后来发生了什么：

```console
$ git log -L ':retry_delay:core/digest.py' --oneline -s
389277e extract retry_delay and clamp into core/util.py
```

两条命令，一个故事：这个函数一直住在 `core/digest.py` 里，直到 `389277e` 把它抽出来放进 `core/util.py`。

## `git blame` 及其局限

`git blame` 会给每一行标注最后一次改动它的提交。它是所有人都会伸手去拿的命令，也是最爱撒谎的那一个，因为「最后被碰过」并不等于「被引入」。先看诚实的视角：

```console
$ git blame -L 8,15 core/util.py
389277e (DeepSeek 2026-10-01 10:20:00 +0800  8) def retry_delay(attempt):
94d0479 (DeepSeek 2026-10-18 19:30:00 +0800  9)     """Seconds to wait before retry `attempt` (zero-based)."""
65b321f (DeepSeek 2026-10-12 14:55:00 +0800 10)     return 2 ** attempt
...
94d0479 (DeepSeek 2026-10-18 19:30:00 +0800 13) def clamp(value, lo, hi):
```

第 10 行归咎于 bug 提交 `65b321f`，这是对的。但第 9 行和第 13 行归咎于那个*reflow* 提交，而它只改了空白——当你在搜寻含义时，这是条假线索。`-w` 让 blame 忽略纯空白改动，噪音就塌陷了：

```console
$ git blame -L 8,15 -w core/util.py
389277e (DeepSeek 2026-10-01 10:20:00 +0800  8) def retry_delay(attempt):
389277e (DeepSeek 2026-10-01 10:20:00 +0800  9)     """Seconds to wait before retry `attempt` (zero-based)."""
65b321f (DeepSeek 2026-10-12 14:55:00 +0800 10)     return 2 ** attempt
...
389277e (DeepSeek 2026-10-01 10:20:00 +0800 13) def clamp(value, lo, hi):
```

另一个局限是*复制*。blame 把功劳记给粘贴代码的那次提交，而不是写出代码的那次提交，所以一次复制粘贴式重构看起来就像全新的代码。`-C` 让 blame 去别处文件里寻找被复制的行（可以叠加——`-C -C -C` 搜得更狠）。这里有个辅助函数被原样粘进了 `core/report.py`：

```console
$ git blame -C -C -C --oneline core/report.py
f227728 core/report.py (DeepSeek 2026-10-20 13:12:00 +0800  1) """Render the fetched items as a plain-text report."""
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  4) def clamp(value, lo, hi):
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  5)     """Force `value` into the inclusive range [lo, hi]."""
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  6)     return max(lo, min(value, hi))
```

被复制的行现在指向它们在 `core/util.py` 里的真正源头，而不是那次粘贴。两个 flag——`-w` 和 `-C`——修好了 `git blame` 的大部分毛病。

## 用 `--follow` 跨重命名追踪文件

如果不主动要求 `--follow`，重命名会斩断历史。没有它，日志会停在创建*当前*路径的那次提交：

```console
$ git log --oneline -- core/digest.py
f227728 feat: render the digest as a plain-text report
389277e extract retry_delay and clamp into core/util.py
f291cea refactor: move digest.py under core/ to make room for more modules

$ git log --follow --oneline -- core/digest.py
f227728 feat: render the digest as a plain-text report
389277e extract retry_delay and clamp into core/util.py
f291cea refactor: move digest.py under core/ to make room for more modules
dfb797b retry transient API failures with exponential backoff
542a97f init: fetch newsletter items from the API
```

多出来的两个提交，是这个文件在旧名字 `digest.py` 下的一生。有两条规矩能让它保持诚实：`--follow` 只接受恰好一个路径（它是启发式，不是数据库）；在合并点上它可能选错父提交。对任何要紧的东西，都用 pickaxe 交叉验证一遍——pickaxe 不需要重命名检测，因为它扫描的是每一段 diff。这和我写在[单人开发者的 git 工作流](/zh/posts/git-for-solo-developers/)里的纪律是同一条：只有当你能读懂历史时，历史才值钱。

## 收窄日志：`--author`、`--since` 和 `-- path`

在开始读 diff 之前，先把草堆缩小。我最常用的三个过滤器：

```console
$ git log --oneline --since='2026-10-10'
f227728 feat: render the digest as a plain-text report
94d0479 style: reflow core/ (trailing whitespace, no logic change)
d3288d9 docs: note the API rate limit in the README
65b321f simplify backoff: the cap was never hit in practice

$ git log --oneline --since='2026-10-01' -- core/util.py
94d0479 style: reflow core/ (trailing whitespace, no logic change)
65b321f simplify backoff: the cap was never hit in practice
```

把 `--since`、`--until`、`--author` 和一个尾随的 `-- path` 组合起来，一段上千次提交的历史就能缩成你能真正读完的四条。在这些之上再加 `--oneline --graph --decorate`，就是我几乎每次调查的起点。

## `git bisect`：让机器找出那次破坏性的提交

过滤器告诉你*去哪找*；**git bisect** 告诉你*究竟是哪次提交把它弄坏了*。你给它一个已知好、一个已知坏的提交，它就在这段区间里二分搜索，每一步砍掉一半——一千次提交大约变成十次测试。

<figure>
  <svg viewBox="0 0 760 250" width="100%" role="img" aria-labelledby="bisect-title-zh" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="bisect-title-zh">git bisect 如何把搜索区间对半砍</title>
    <desc id="bisect-desc-zh">一段位于 good 与 bad 端点之间的提交区间在中点被切开，每次测试都丢弃一半，直到只剩一个提交。</desc>
    <text x="20" y="26" fill="currentColor" font-weight="600">good v0.2.0</text>
    <text x="640" y="26" fill="currentColor" font-weight="600">bad HEAD</text>
    <line x1="30" y1="46" x2="730" y2="46" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="30" cy="46" r="5" fill="#0f766e"/>
    <circle cx="730" cy="46" r="5" fill="currentColor"/>
    <text x="380" y="36" text-anchor="middle" fill="currentColor">区间内 5 个提交</text>
    <line x1="380" y1="46" x2="380" y2="96" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="86" text-anchor="middle" fill="#0f766e">测试中点</text>
    <text x="700" y="96" text-anchor="middle" fill="currentColor" font-size="12">f227728 bad</text>
    <line x1="30" y1="120" x2="380" y2="120" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="30" cy="120" r="5" fill="#0f766e"/>
    <text x="205" y="110" text-anchor="middle" fill="currentColor">左半：good → 丢弃右半</text>
    <line x1="205" y1="120" x2="205" y2="168" stroke="#0f766e" stroke-width="1.5"/>
    <text x="205" y="158" text-anchor="middle" fill="#0f766e">测试中点</text>
    <line x1="205" y1="182" x2="380" y2="182" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="300" cy="182" r="6" fill="#b91c1c"/>
    <text x="470" y="186" fill="currentColor">65b321f 第一个坏提交</text>
    <text x="20" y="234" fill="currentColor" font-size="12">每次测试砍掉一半。log₂(1000) ≈ 10 次测试就能锁定一个提交。</text>
  </svg>
  <figcaption>bisect 不读 diff；它在中点运行你的测试，只保留仍然失败的那一半，直到只剩一个提交。</figcaption>
</figure>

手动循环是 `git bisect start`、`git bisect bad`、`git bisect good <ref>`，然后手工把每次测试标成 `good`/`bad`。自动化才是重点：用 `bisect run` 传一条命令，让它靠退出码判断（0 = good，非 0 = bad）。我的复现脚本直接检查那个不变量，一旦上限没了就报失败：

```sh
#!/bin/sh
# Exit 0 while the backoff delay is capped, non-zero once the cap regresses.
exec python3 - <<'PY'
import importlib.util, os, sys
path = next((p for p in ["core/util.py", "core/digest.py", "digest.py"]
             if os.path.exists(p)), None)
spec = importlib.util.spec_from_file_location("mod", path)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
sys.exit(0 if mod.retry_delay(6) <= 30 else 1)
PY
```

```console
$ git bisect start
$ git bisect bad                 # HEAD is broken
$ git bisect good v0.2.0         # this tag was fine
$ git bisect run ./check_backoff.sh
running './check_backoff.sh'
Bisecting: 0 revisions left to test after this (roughly 0 steps)
[65b321f0c3e042d7c257e18c2b2ab4cbb6157f66] simplify backoff: the cap was never hit in practice
running './check_backoff.sh'
65b321f0c3e042d7c257e18c2b2ab4cbb6157f66 is the first 'bad' commit
...
bisect found first 'bad' commit
$ git bisect reset
```

在这个玩具仓库里只有三个提交，但括号里那个数字——*roughly N steps*——才是回报所在：对一段真正的上千次提交的区间，bisect 会跑大约十次测试，然后递给你一个 SHA。唯一值得投入的，是一份你信任的复现脚本；把它写对，bisect 就是确定性的，而不是靠聪明。

## 读「为什么」：`git show`、`git diff` 与提交信息

bisect 指出了那次提交；它并不解释它。这是下一步，也是大多数人过早停下的地方。`git show` 把提交、信息和 diff 一起打印出来：

```console
$ git show 65b321f
commit 65b321f...
    simplify backoff: the cap was never hit in practice

diff --git a/core/util.py b/core/util.py
@@ -3,12 +3,11 @@
 RETRIES = 5
-BACKOFF_CAP = 30  # seconds
 def retry_delay(attempt):
-    return min(2 ** attempt, BACKOFF_CAP)
+    return 2 ** attempt
```

那段信息正是陷阱。「这个上限实际上从来没被触发过」听起来很合理，而且就是全部的论证依据——但它是错的，因为这个上限的存在，恰恰是为了那个倒霉的日子：上游 API 挂了，重试循环否则会睡上几分钟。diff 展示的是*改了什么*；只有提交信息（在真实仓库里，还有它关联的 issue 或 PR）才能展示*为什么*——而这里的「为什么」只是一个后来被证明是回归的猜测。这就是考古的全部意义：把改动和它的理由分开，然后追问那个理由今天是否仍然成立。

当提交本身没带上故事时，issue 追踪器就是下一个挖掘点：顺着 `Fixes #1234` 这条尾巴找过去，读那场讨论，再核对当初促成这次改动的前提是否还成立。而如果你遇到的真正问题是还没读懂周围的代码，那是另一项技能——我用的方法写在[如何读懂一个不是你写的代码库](/zh/posts/reading-a-codebase/)里。

## 一份 git 考古清单

我大致按从最便宜到最贵的顺序去够这些工具：

1. **`git log -S '字符串'`** —— 当某个常量、flag 或名字变化时（pickaxe）。
2. **`git log -G '正则'`** —— 当某一行可能被原地改写时。
3. **`git log -L :func:file`** —— 当问题是一个函数的演变时。
4. **`git blame -w -C -C -C`** —— 当「谁最后碰了这里」仍有用时；先用它剥掉空白、追出复制。
5. **`git log --follow`** 加 `--since`/`--author`/`-- path` —— 当你要在读 diff 前缩小草堆时。
6. **`git bisect run`** —— 当你有可靠的复现、需要那个确切的提交时。
7. **`git show` 与关联的 issue** —— 永远留到最后，去读那个*为什么*。

这些没有一样是聪明的。本事在于挑出能回答当前那个问题的最便宜工具，并且拒绝单独相信 `git blame`。历史是唯一不会过期的文档；要做的工作，是学会读懂它，而不被那个仅仅格式化了你关心的那一行的提交带偏。
