---
title: "一份实用的 regex 教程：别再怕正则表达式"
description: "一份实用的 regex 教程，帮你把正则真正想通：它只是一个小小的模式匹配器而非一门语言，以及各种原子、捕获组、贪婪与懒惰量词、交替与优先级、真实模式里的词边界、灾难性回溯为什么会发生，还有怎样拿真实输入去测试 regex examples。"
pubDate: 2026-12-05
lang: zh
translationKey: regex-in-practice
tags: [linux, devops]
featured: false
keywords:
  - regex 教程
  - 正则表达式
  - regex examples
  - 灾难性回溯
  - 捕获组
---

我见过同事从工单里复制一条正则，改一个字符，然后开始祈祷。我自己也干过这事。但正则表达式并不是一门你得当成 C 或 Python 去学的语言——它其实是一个极小的模式匹配器，能动的零件也就十来个。一旦你看清这些零件，恐惧基本就散了，剩下的是一个找文本、改文本的很好用的工具。

这是一份实用的 **regex 教程**：先说清心智模型，再讲各种原子、常见的坑，以及我真正会去用的那些 **regex examples**。下面每一个输出都是真的——我在同一个 shell 里用 Python 3 和 `grep -P` 跑过，把返回结果原样贴出来。如果你也想在代码上养成这种“看真实输出、别瞎猜”的习惯，可以配合[我是怎么读一个代码库的](/zh/posts/reading-a-codebase/)和[怎么写一份 README](/zh/posts/writing-a-readme/)——这两件事本质上都是在练习“看清页面上到底写了什么”。

## 正则是一个模式匹配器，不是一门语言

最关键的一次认知转变是这个：正则描述的是一种文本的*形状*，引擎拿着这个形状沿着你的输入滑动，找一个能套上去的位置。它不是一段带循环和变量的程序，它是一块镂空模板。

大多数困惑都来自忘了这一点，把正则当成故事从左到右读。引擎可不是那么读的。它会从第一个字符试着匹配，不行就退到第二个，以此类推——除非你把它锚定住。脑子里一直装着“模板”这个画面，下面讲的一切都只是“怎么描述一个更大的形状”。

有个让新正则变得可读的小窍门：把它用大白话，从左到右念出来。`\d{4}-\d{2}-\d{2}` 就是“四位数字，一个横杠，两位数字，一个横杠，两位数字”。如果你没法顺畅地念出来，那这条正则多半一次干的事太多了，拆成两条更小的模式会更好调。正则很不擅长组合；短的组合起来才漂亮。

还有一点值得知道：“regex” 不是一个东西。Python、Perl、PCRE（也就是 `grep -P` 用的）、JavaScript 和 Go 讲的都是各自的方言，它们在基础部分一致，在边缘处分歧——后行断言、命名分组的语法、以及 `.` 怎么对待换行，通常是分歧点。所以当你熟悉的语言里能用的模式在另一种里失败时，先查方言，别怀疑自己。

## 原子：字面量、`.`、字符类、锚点、量词

字面量匹配它自己。`.` 匹配任意单个字符（默认不含换行）。字符类 `[...]` 匹配集合里的一个字符。锚点不消耗任何东西——它断言的是*位置*。

```text
$ python3 -c 'import re; print(re.findall(r"\d+", "order 42 shipped 2026-12-05"))'
['42', '2026', '12', '05']
```

`\d` 是 `[0-9]` 的简写，`+` 表示“一个或多个”。量词是最容易让人一开始就猜错的地方，因为它们默认是**贪婪**的——尽可能多拿，只有在被逼无奈时才还回去。

```text
$ python3 -c 'import re; print(re.findall(r"colou?r", "color colour"))'
['color', 'colour']
```

`?` 表示“零个或一个”，这就是你写可选字母的方式。锚点 `^` 和 `$` 匹配的是一行（或整个字符串）的开头和结尾——具体是哪种，看下面那个坑。

## 分组与捕获

括号干两件事：把一段子模式分组，并把它*捕获*下来，好让你读回去。捕获从左到右编号，从 1 开始；`group(0)` 永远是整个匹配。在真实代码里，命名分组几乎总值得用，因为 `group("year")` 能扛住后续编辑，而 `group(3)` 扛不住。

```text
$ python3 -c 'import re; m=re.search(r"(\d{4})-(\d{2})-(\d{2})", "date 2026-12-05 ok"); print(m.group(0), m.group(1), m.group(2), m.group(3))'
2026-12-05 2026 12 05

$ python3 -c 'import re; m=re.search(r"(?P<y>\d{4})-(?P<m>\d{2})", "2026-12-05"); print(m.group("y"), m.group("m"))'
2026 12
```

反向引用匹配的是*某个分组此前匹配到的同一段文本*，找重复词简直完美。`\1` 指的就是第 1 组：

```text
$ python3 -c 'import re; print(re.findall(r"(\w+)\s+\1", "the the cat sat sat down"))'
['the', 'sat']
```

反向引用要少用——它通常意味着你本可以用两遍处理解决——但对于“同一个词出现两次”这种，它是最干净的工具。

## 交替与优先级

`|` 表示“或”，它结合得很松。`cat|dog` 匹配 `cat` 或 `dog`。经典错误是忘了交替只在“能讲得通的最小单位”处停止，所以当你想让两个分支共享上下文时，必须加括号：

```text
$ python3 -c 'import re; print(re.findall(r"gr(a|e)y", "gray grey"))'
['a', 'e']
```

它返回的是被捕获的那个字母，而不是 `gray`/`grey`，因为 `findall` 在有分组时返回的是分组内容。真正的坑是 `^cat|dog$`：它*不*表示“一整行是 cat 或 dog”。它表示“以 cat 开头，或者以 dog 结尾”。

```text
$ python3 -c 'import re; print(re.search(r"^(cat|dog)$", "catfish"))'
None
```

把交替括起来，才能让两个锚点同时作用到两个分支上。

## 绊住所有人的四件事

### 贪婪的 `.*` 与懒惰的 `.*?`

`.*` 会一路吃到行尾，然后只被迫退回必要的那么多。在一个带两个标签的字符串上，这可不是你想要的：

```text
$ python3 -c 'import re; s="<b>bold</b> and <b>more</b>"; print(re.search(r"<b>.*</b>", s).group(0))'
<b>bold</b> and <b>more</b>
$ python3 -c 'import re; s="<b>bold</b> and <b>more</b>"; print(re.search(r"<b>.*?</b>", s).group(0))'
<b>bold</b>
```

在量词后面加个 `?` 就让它变**懒惰**：尽可能少拿。贪婪与懒惰，是“匹配得太多”最常见的根源。

### `^` 和 `$` 会随标志改变含义

默认情况下 `^` 是“字符串开头”，而不是“每一行开头”。打开多行模式，它就变成按行：

```text
$ python3 -c 'import re; print(re.findall(r"^\w+", "first line\nsecond line"))'
['first']
$ python3 -c 'import re; print(re.findall(r"^\w+", "first line\nsecond line", re.M))'
['first', 'second']
```

`$` 同理。当一条正则在单行上好好的、到整个文件上却莫名其妙失效时，这个标志是你第一个怀疑对象。

### 转义

`.` 表示“任意字符”，所以字面意义上的点需要反斜杠。元字符——`. * + ? ( ) [ ] { } | ^ $ \`——当你想表达它们本身时，全都要转义：

```text
$ python3 -c 'import re; print(re.findall(r"\.", "a.b.c vs abc"))'
['.', '.']
```

像 `/posts/\d+` 这样的路径，能把字面部分和可变部分干净地拆开：

```text
$ python3 -c 'import re; print(re.search(r"/posts/\d+", "/posts/42 and /posts/999").group(0))'
/posts/42
```

### 词边界

`\b` 断言的是一处词字符与非词字符之间的边界，且不消耗任何东西。它就是用来阻止 `cat` 匹配到 `category` 内部的。这是次要关键词，回报却极大：

```text
$ python3 -c 'import re; print(re.findall(r"\bcat\b", "cat category concatenate cat."))'
['cat', 'cat']
$ python3 -c 'import re; print(re.findall(r"\bPYTHON\b", "PYTHON PYTHONIC python", re.I))'
['PYTHON', 'python']
```

## 值得留下来的实用模式

**邮箱和 URL：做到“够用”，别追求完美。** 一条完全正确的邮箱正则臭名昭著地难写，你不该去试。下面这条能抓到真实地址、放过明显垃圾：

```text
$ python3 -c 'import re; print(re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", "mail me at ada+notes@example.co.uk or x@y.io"))'
['ada+notes@example.co.uk', 'x@y.io']
```

URL 也是同样的道理；在空白和引号处停下，你就能拿到 95% 的价值：

```text
$ python3 -c 'import re; print(re.findall(r"https?://[^\s<>\"]+", "see https://blog.awin-x.top/posts/x and http://x.io/a?b=1"))'
['https://blog.awin-x.top/posts/x', 'http://x.io/a?b=1']
```

**日志行。** 命名分组能把一行非结构化文本变成你能推理的字段：

```text
$ python3 -c 'import re
p = r"^(?P<ts>\S+)\s+(?P<lvl>\w+)\s+(?P<svc>\S+)\s+(?P<status>\d{3})\s+(?P<method>\w+)\s+(?P<path>\S+)\s+(?P<ms>\d+)ms$"
m = re.search(p, "2026-12-05T10:22:01Z INFO  api  200 GET /posts 18ms")
print(m.groupdict())'
{'ts': '2026-12-05T10:22:01Z', 'lvl': 'INFO', 'svc': 'api', 'status': '200', 'method': 'GET', 'path': '/posts', 'ms': '18'}
```

而 `grep -P` 能给你同样的词边界，放在 shell 管道里看着也顺眼：

```text
$ grep -Pno '\bGET\b' access.log
1:GET
```

## 灾难性回溯

这是唯一一种“不是答错、而是把进程挂住”的失败。当嵌套量词能用许多不同方式匹配同一段文本时，引擎一旦匹配失败，就会去试每一种组合。我给经典反派 `(a+)+$` 掐了表，拿一串 `a` 后跟一个不匹配字符去试：

```text
$ python3 -c 'import re, time
bad = re.compile(r"(a+)+$")
for n in (22, 24, 26):
    s = "a"*n + "!"
    t = time.time(); bad.search(s)
    print(f"n={n:>2}  {(time.time()-t)*1000:9.1f} ms")'
n=22      690.1 ms
n=24     3221.0 ms
n=26    11155.4 ms
```

每多一个字符，耗时大约翻三倍——这是指数级的，而 30 个字符的输入就足以构成一次拒绝服务。解法是消除歧义。`a+$` 匹配同样的语言，却是线性的：

```text
$ python3 -c 'import re, time
bad = re.compile(r"(a+)+$"); good = re.compile(r"a+$")
for n in (22, 24, 26):
    s = "a"*n + "!"
    t = time.time(); bad.search(s); tb = (time.time()-t)*1000
    t = time.time(); good.search(s); tg = (time.time()-t)*1000
    print(f"n={n:>2}  bad={tb:9.1f} ms  good={tg:8.4f} ms")'
n=22  bad=    690.1 ms  good=  0.0079 ms
n=24  bad=   3221.0 ms  good=  0.0103 ms
n=26  bad=  11155.4 ms  good=  0.0079 ms
```

几条经验法则：永远不要把量词嵌进另一个匹配同一批字符的量词里；尽量用显式字符类（`[^<>]` 而不是 `.*`），让每个位置只有一种匹配方式；给模式加锚点，免得引擎从每个偏移量重新扫描；如果实在简化不掉，就在匹配前限制输入长度。更新的引擎还提供占有量词（`a++`）和原子组，能彻底掐断回溯。

## 一个测试习惯：拿真实输入去跑

最后一个习惯，才是真正终结恐惧的那个：**在信任一条正则之前，永远拿真实字符串测它。** 不是测一个例子——要测该匹配的、该失败的，以及那条丑陋的真实日志行。`python3 -c` 和 `grep -P` 就在手边，根本没有什么构建流程要跑。

我为那些会复用的模式，专门留了一个小小的草稿文件，存输入和期望结果。当一条正则在生产里开始作妖，我就把那行失败输入贴进去，看它炸、修它、再看它过。正则并不可怕，不是因为它难——它可怕，是因为我们把没测过的正则直接发了出去。像测其它任何东西一样去测它，它就只是又一个你会不假思索拿起来的趁手工具。

一个好习惯是每次都测三个输入，而不是一个。第一，那个*应该*匹配的输入，确认模式没过期。第二，一个应该失败的输入，确认你没造出一个什么都匹配的东西。第三，你能找到的最恶心的真实日志行——多几个空格、结尾多个斜杠、或者中间夹了个引号的那种。生产里的大多数 bug 就藏在这第三种情况里，而试一下只要十秒钟。
