---
title: "awk 与 sed 实用手册：不离开 shell 完成文本处理"
description: "一份带真实输出的 awk 教程与 sed 教程：字段选择、求和与平均值、BEGIN/END、分组计数、sed replace、捕获组、行范围、带备份的原地替换，以及何时该停手改用 jq 或 Python。"
pubDate: 2026-12-25
lang: zh
translationKey: awk-and-sed
tags: [linux]
featured: false
keywords:
  - awk 教程
  - sed 教程
  - awk 示例
  - sed 替换
  - 文本处理
---

每次我打开一个文件瞅一眼，然后为了对它做点微不足道的事而启动一个语言运行时，我都会浪费五分钟，外加一点自尊。想过滤的一行日志、想求和的 CSV 列、在二十个文件里被改掉的某个配置值——这些都不需要一个解释器和一个 virtualenv。它们需要的是 `sed` 和 `awk`，系统里本来就有，启动只需毫秒。

这是一本手册，不是参考文档。下面所有内容都是我在临时目录里创建的文件跑出来的真实输出：一个小 `access.csv` 和一个 `app.log`。如果你正对着终端读这篇，可以逐条跟着敲。

## 心智模型：sed 编辑流，awk 读取记录

最值得内化的一点是：两者并不通用。

- **`sed`** 是*流编辑器*。它逐行读取输入，对每一行施加一段脚本——通常是“找到这个，替换掉”。它按**行**思考。它的超能力是*原地编辑文件*，以及*不关心*行的结构。
- **`awk`** 是*记录与字段*语言。它也逐行读取，但会用分隔符把每行切成**字段**（`$1`、`$2`……），而且它有变量、算术、条件、循环和关联数组。它按**列和聚合状态**思考，所以它能*求和*、*求平均*、*分组*、*计数*。

我实际用的经验法则：如果答案只取决于当前这一行，用 `sed`；如果取决于某个字段、一个累计值或一个分组键，用 `awk`。当你开始在 bash 里写带计数器的 `while read` 循环时，那就是 `awk` 在提醒你停手。

## sed 教程：核心招式

这是我准备折腾的样例日志：

```
2026-12-01T08:00:01Z INFO  api boot complete pid=4821
2026-12-01T08:00:02Z INFO  request id=1 path=/api/users status=200 ms=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 ms=1330
```

### 替换命令

主力是 `s/find/replace/`。不加 `g` 时，它只替换每行的**第一个**匹配：

```console
$ sed 's/ERROR/ERR/' app.log | head -4
2026-12-01T08:00:01Z INFO  api boot complete pid=4821
2026-12-01T08:00:02Z INFO  request id=1 path=/api/users status=200 ms=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:04Z ERR request id=3 path=/api/orders status=500 ms=1330
```

这就是 “sed 替换” 的全部故事，浓缩成一行。当一行里可能出现多次该模式时，再加上 `/g`。

### 捕获组用来重排，而不只是替换

`sed` 配合扩展正则（`-E`）用 `(...)` 捕获，用 `\1`、`\2` 还原。这里我把 ISO 时间戳改成日/月/年：

```console
$ echo '2026-12-01T08:00:02Z INFO request id=1' \
    | sed -E 's#([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})#\3/\2/\1 \4#'
01/12/2026 08:00:02Z INFO request id=1
```

我用 `#` 而不是 `/` 作为分隔符，这样替换结果里的斜杠就不用转义。换分隔符是 `sed` 里性价比最高的习惯之一——尤其面对路径，里面全是 `/`。

### 地址、范围，以及 `-n` + `p`

默认情况下 `sed` 会打印每一行。`-n` 会抑制打印，而 `p` 只打印你指定的部分。这就把 `sed` 变成了过滤器：

```console
$ sed -n '/WARN/p' app.log
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:07Z WARN  slow downstream id=6 service=billing ms=920
```

地址也可以是行号或范围。`4,6p` 打印第 4 到第 6 行（含两端）：

```console
$ sed -n '4,6p' app.log
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 ms=1330
2026-12-01T08:00:05Z INFO  request id=4 path=/api/orders status=200 ms=118
2026-12-01T08:00:06Z ERROR db timeout id=5 pool=primary waited=2500
```

范围也可以是*模式*地址——`/BEGIN/,/END/`——这通常是从大文件里捞出一段堆栈或配置块的写法。

### 按模式删行

`d` 删除。这是你在阅读某物之前先去掉噪音的方式：

```console
$ sed '/boot complete/d' app.log | wc -l
9
```

十行的日志回来了九行——启动那行没了。关键在于原文件没被动过，因为我没用 `-i`。

### `-i`：原地编辑，带备份，且在副本上操作

`-i` 直接改文件而不是打印到 stdout。**一定给它一个后缀，让它写出备份。** 我在副本上操作，因为我舍不得样例文件：

```console
$ cp app.log app.copy
$ sed -i.bak 's/pool=primary/pool=replica/' app.copy
$ grep replica app.copy
2026-12-01T08:00:06Z ERROR db timeout id=5 pool=replica waited=2500
$ grep -c primary app.copy.bak
1
```

改过的文件里是 `replica`；`app.copy.bak` 里仍是原来的 `primary`。那个备份就是你的撤销键。

### 多条表达式，以及多个文件

`-e` 串联表达式。这里我一趟把日志级别补齐，并重命名 `ms=` 字段：

```console
$ sed -e 's/INFO/INFO /' -e 's/ms=/latency=/' app.log | sed -n '2,4p'
2026-12-01T08:00:02Z INFO   request id=1 path=/api/users status=200 latency=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing latency=880
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 latency=1330
```

而且 `sed` 乐于一次接收多个文件，这才是人们爱用它在配置迁移上的真正原因。假设两个配置文件都指向同一个旧上游：

```console
$ cat cfg/one.conf cfg/two.conf
upstream api = http://10.0.0.5:8080
retries = 3
upstream api = http://10.0.0.5:8080
timeout = 30
$ sed -i.bak 's#http://10\.0\.0\.5:8080#https://api.internal:443#' cfg/*.conf
$ cat cfg/one.conf cfg/two.conf
upstream api = https://api.internal:443
retries = 3
upstream api = https://api.internal:443
timeout = 30
```

一条命令、两个文件、两份 `.bak` 备份、零手工编辑。注意被转义的圆点（`10\.0\.0\.5`）——正则里的 `.` 匹配任意字符，而你想要它匹配字面意义的点。

### 多行，简略一提

`sed` 面向行，这也是它开始难受的地方。要把匹配行的下一行合并进来，需要 `N` 命令把下一行拉进模式空间：`sed '/^START/{N;s/\n/ /}'`。如果你的问题真的是关于段落或跨行 JSON，那已经到 `sed` 舒适区的边缘了——该用 `awk` 的记录，或 `jq`。JSON 那一侧我写过一篇
[jq 实战](/zh/posts/jq-in-practice/)。

## awk 教程：字段、记录与 `BEGIN`/`END`

现在轮到更有意思的工具。`awk` 把每个输入行切成字段。整个 CSV 长这样：

```
ts,status,method,path,bytes,ms
2026-12-01T08:00:01Z,200,GET,/api/users,1203,42
2026-12-01T08:00:02Z,200,GET,/api/orders,8842,118
2026-12-01T08:00:03Z,404,GET,/api/nope,210,9
```

### 用 `$1..$NF` 伸手取列

特殊变量 `NF` 是字段数量，所以 `$NF` 是*最后*一个字段。这是最常用的 `awk` 惯用法：

```console
$ awk -F, '{print $1, $4, $NF}' access.csv | head -4
ts path ms
2026-12-01T08:00:01Z /api/users 42
2026-12-01T08:00:02Z /api/orders 118
2026-12-01T08:00:03Z /api/nope 9
```

`-F,` 设置字段分隔符。`$1` 是时间戳，`$4` 是路径，`$NF` 是延迟。

### `NR`、`NF`，以及一条命令跳过表头

`NR` 是当前记录（行）号。它也是你跳过表头而不抓狂的方式：

```console
$ awk -F, 'NR<=3 {print NR": NF="NF" path="$4}' access.csv
1: NF=6 path=path
2: NF=6 path=/api/users
3: NF=6 path=/api/orders
```

每一行都有六个字段，表头也不例外。`NR>1` 就是我之后每个求和里用来跳过表头的模式。

### BEGIN、END，以及算个总和

`BEGIN` 在任何输入之前运行；`END` 在最后一行之后运行。两者合起来正是 `awk` 像一门小型语言的全部理由：

```console
$ awk -F, 'NR>1 {s+=$5} END {print "total bytes:", s}' access.csv
total bytes: 31825
```

没有循环、没有计数器样板：`s+=$5` 在 `awk` 读取时累加，`END` 只打印一次。

### 平均值，配合 `printf`

累计和加上行计数器就得到平均值。`printf` 让你控制小数位：

```console
$ awk -F, 'NR>1 {s+=$6; n++} END {printf "avg ms: %.1f over %d rows\n", s/n, n}' access.csv
avg ms: 298.8 over 12 rows
```

注意这个平均值包含两个耗时 1330 ms 和 1490 ms 的请求，这恰恰是快速平均值想要暴露的东西。

### 条件，以及 `BEGIN`/`OFS`

像 `$2>=500` 这样的模式就是条件。而你可以用 `BEGIN` 设置输出分隔符 `OFS`：

```console
$ awk -F, 'BEGIN {OFS=" | "} NR>1 {print $2, $3, $4}' access.csv | head -3
200 | GET | /api/users
200 | GET | /api/orders
404 | GET | /api/nope
$ awk -F, '$2>=500 {print $1, $2, $4}' access.csv
ts status path
2026-12-01T08:00:05Z 500 /api/orders
2026-12-01T08:00:23Z 500 /api/orders
```

## awk 示例：分组与计数

关联数组是 `awk` 把 `sed` 远远甩开的地方。`c[$4]++` 意思是“把以第 4 字段为下标的计数器加一”。然后 `END` 遍历键。

### 按键计数

```console
$ awk -F, 'NR>1 {c[$4]++} END {for (p in c) print c[p], p}' access.csv | sort -rn
5 /api/orders
4 /api/users
1 /old
1 /api/nope
1 /admin
$ awk -F, 'NR>1 {c[$2]++} END {for (s in c) printf "%s %d\n", s, c[s]}' access.csv | sort
200 7
301 1
403 1
404 1
500 2
```

第二条是状态码直方图，也是 `awk` 成为我“这文件里有什么”默认工具的原因。关于如何让这些计数在重启和聚合之间留存，见我写的
[结构化日志](/zh/posts/structured-logging/)。

### 从非结构化文本里抽取 `key=value` 字段

`app.log` 不是列式的，但它的字段是空格分隔的 `key=value` 对。遍历字段、找到你要的那个、剥掉前缀：

```console
$ awk '{for (i=1;i<=NF;i++) if ($i ~ /^path=/) {sub("path=","",$i); print $i}}' app.log
/api/users
/api/orders
/api/orders
/api/users
/admin
/api/users
```

### 类 join 的富化

`awk` 能在内存里同时持有两个文件。`NR==FNR` 惯用法把第一个文件载入数组，第二趟再去查它。这里我用同文件的查找把每个请求路径标记为 `known` 或 `new`（把它想象成一张路由表即可）：

```console
$ awk -F, 'NR==FNR {if (FNR>1) load[$4]++; next} {print $1, $4, (load[$4]?"known":"new")}' access.csv access.csv | head -3
ts path new
2026-12-01T08:00:01Z /api/users known
2026-12-01T08:00:02Z /api/orders known
```

那个 `NR==FNR {...; next}` 的形状，就是你不离开 shell 所能得到的最接近 SQL join 的东西。

## 同一件事三种做法：awk vs sed vs 一行流

统计 `500` 行能清楚看出取舍。三种都正确：

```console
$ grep -c ',500,' access.csv
2
$ sed -n '/,500,/p' access.csv | wc -l
2
$ awk -F, '$2==500' access.csv | wc -l
2
```

- `grep` 最短、敲起来最快，但它是子串匹配：藏在路径或字节数里的 `500` 也会被算进去。
- `sed -n` 需要接管道到 `wc`，因为它没有“计数”的概念。
- `awk` 最啰嗦，却是唯一*字段感知*的——`$2==500` 永远不会被别的列里的 `500` 骗到。当答案必须精确时，多敲的那些字符值回票价。

## 什么时候该停手，改用 Python 或 jq

我时刻在用 `awk`/`sed`，但有三种情况会停：

1. **数据是 JSON。** 别用正则手撕 JSON。用 `jq`；那本来就是它存在的意义。
2. **逻辑需要真正的函数、日期或类型。** 如果我在做日期运算、浮点货币，或需要某个会复用的辅助函数，`awk` 就开始变成一段值得写测试的程序。用 Python 写。
3. **一行流已经变成脚本。** 当我需要 `-v` 变量、引号体操和一个 shell 包装才让 `awk` 程序可读时，它就不再是一行流了，可维护性的天平倒向 Python。

`awk` 的巅峰是对一两个字段做一两次操作。再往前，你就是在调试一门没有调试器的语言。

## 可移植性：GNU 与 BSD 的 `sed -i`

经典陷阱。在 Linux（GNU `sed`）上，`-i` 可选地带一个后缀：

```console
$ sed --version | head -1
sed (GNU sed) 4.10
$ sed -i.bak 's/foo/bar/' file      # GNU：后缀，生成备份
```

在 macOS 和 BSD 上，`-i` **要求**一个参数，若不想备份就传空字符串：

```sh
sed -i '' 's/foo/bar/' file         # BSD/macOS：空后缀，直接覆盖
sed -i '.bak' 's/foo/bar/' file     # BSD/macOS：备份
```

可移植的习惯是永远显式传后缀，这样同一行在两边都能用；只有当你确实需要 `\b`、前瞻或其他 `awk`/`sed` 没有的 PCRE 特性时，才转向 `perl -pi -e`。其他值得知道的小差异：GNU `sed` 的正则支持 `\t` 和 `-E`；BSD 历史上要用 `-r`（现代也支持 `-E` 了）；macOS 上的 `awk` 是 one-true-awk 而不是 GNU `awk`，所以 `gensub()` 和 `\s` 可能缺失。Linux 上 `gawk` 还是 `mawk` 也有讲究——`mawk` 更快，但扩展更少。

## 小结

`sed` 是面向行的流编辑器，杀手锏是 `s///` 和原地编辑。`awk` 是面向字段的记录处理器，有变量、`BEGIN`/`END` 和关联数组，杀手锏是对列的聚合与运算。`sed` 这侧学会 `s///`、地址和 `-n p`；`awk` 这侧学会 `$1..$NF`、`NR`/`NF`、`-F` 和 `c[$k]++`。这就是日常文本处理的九成，处处可跑，而且它启动得比你的解释器还快。
