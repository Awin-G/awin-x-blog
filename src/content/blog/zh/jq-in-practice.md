---
title: "jq 实战教程：命令行 JSON 处理手边书（附真实输出）"
description: "一份面向实际工作的 jq 教程：美化与紧凑输出、选取与 select、map 与 to_entries、// 默认值、slurp、--arg、-e 退出码、group_by、排序、unique 以及 --stream。文中每个 jq 命令都附带可直接复制的真实输出。"
pubDate: 2026-12-03
lang: zh
translationKey: jq-in-practice
tags: [linux, devops]
featured: false
keywords:
  - jq 教程
  - jq 命令
  - 命令行 JSON
  - jq 示例
  - select
---

我用 `jq` 的频率几乎比任何其他工具都高。每一个 API 响应、每一个 Kubernetes
对象、每一行 `journalctl -o json`，最后都会经过它。可每隔几周，我总会在同样几个
地方卡住：怎么让它是 slurp 而不是流式？为什么明明有值，`//` 默认值却生效了？为
什么 `jq` 什么都不打印？

这就是我想要的那份 jq 教程：一本我真正会用的 jq 命令手边书，每条命令都在小样本
文件上跑过，输出是真实的、直接贴进来的。不用翻 man page，不用猜。下面所有内容都
在 Linux 上用 **jq 1.8.2** 生成。

我假设你已经能敲 `jq` 了——用包管理器装上（`apt install jq`、`brew install
jq`），再跑 `jq --version` 确认一下。这篇文章的重点不是安装，而是那百分之二十的
语法，它能覆盖百分之九十五的实际工作：从 API 响应里取字段、重塑结构、再喂给管道
里的下一个命令。

全文只用两个小文件。`app.json`：

```json
{"name":"billing","version":"2.3.1","replicas":3,"env":{"REGION":"eu-west-1","DEBUG":false},"owners":["ana","bo"],"limits":{"cpu":"500m"}}
```

以及 `users.json`，一个记录数组：

```json
[
  {"id":1,"name":"ana","role":"admin","active":true,"logins":42},
  {"id":2,"name":"bo","role":"dev","active":false,"logins":7},
  {"id":3,"name":"cy","role":"dev","active":true,"logins":19},
  {"id":4,"name":"dee","role":"ops","active":true,"logins":7},
  {"id":5,"name":"eve","role":"dev","active":true}
]
```

## 美化输出与紧凑输出

这两个模式你会一直用到。默认的 `.` 会按两空格缩进重新排版，适合给人看、或者拿来
diff 两份文档。`-c` 则每个值输出一行，适合继续往 `grep`、`wc` 或别的程序里灌。
早点养成用 `-c` 的习惯能省掉很多困惑，因为下面大多数小节都输出紧凑格式，正是为了
让结果在终端里保持可读。

```bash
jq '.' app.json
```

```json
{
  "name": "billing",
  "version": "2.3.1",
  "replicas": 3,
  "env": {
    "REGION": "eu-west-1",
    "DEBUG": false
  },
  "owners": [
    "ana",
    "bo"
  ],
  "limits": {
    "cpu": "500m"
  }
}
```

```bash
jq -c '.' app.json
```

```
{"name":"billing","version":"2.3.1","replicas":3,"env":{"REGION":"eu-west-1","DEBUG":false},"owners":["ana","bo"],"limits":{"cpu":"500m"}}
```

## 选取：`.`、`.a.b`，以及用 `.[]` 遍历

`.field` 走一层，`.a.b` 可以链式深入；开头的 `.[]` 会把数组或对象展开成一个*流*，
每个值一行。

```bash
jq '.env' app.json
```

```json
{
  "REGION": "eu-west-1",
  "DEBUG": false
}
```

```bash
jq '.owners[]' app.json
```

```
"ana"
"bo"
```

加上 `-r` 引号就消失了——这是这个工具里最有用的一个开关：

```bash
jq -r '.env.REGION' app.json
```

```
eu-west-1
```

键不存在不会报错，而是返回 `null`。这算优点，直到你不小心依赖了它：

```bash
jq '.limits.memory' app.json
```

```
null
```

## 用 select 过滤

`select(expr)` 只保留 `expr` 为真的输入，其余全部变成空（也就是完全不输出）。它
最好接在 `.[]` 或 `map` 后面，并且能和 `and`、`or`、比较运算组合。正是这个构造让
`jq` 从格式化工具变成查询语言：与其用子串去 grep，不如对结构化值断言一个条件，
拿回你正好想要的那些对象。因为 `select` 本身就是个滤镜，你可以链好几个，或者接在
`map` 之后，每一级看到的是上一级产出的流。

```bash
jq -r '.[] | select(.role=="dev") | .name' users.json
```

```
bo
cy
eve
```

```bash
jq -r '.[] | select(.active and .logins > 10) | .name' users.json
```

```
ana
cy
```

## 用 map、to_entries、with_entries 做变换

`map(f)` 对每个元素跑一遍 `f` 再把结果收成数组——它是 `.[]` 的数组形态版本。
`to_entries` 把对象变成 `[{key,value}]`；`with_entries(f)` 等价于
`to_entries | map(f) | from_entries`，于是重命名或丢掉键都成了一行，而不用手写循环。
这三者合起来几乎覆盖你需要的所有重塑，因为几乎所有重塑要么是「改每个元素」，要么
是「改每个键」。

```bash
jq -c 'map(.name)' users.json
```

```
["ana","bo","cy","dee","eve"]
```

```bash
jq -c '.env | to_entries' app.json
```

```
[{"key":"REGION","value":"eu-west-1"},{"key":"DEBUG","value":false}]
```

```bash
jq -c '.env | with_entries(.key |= ascii_downcase)' app.json
```

```
{"region":"eu-west-1","debug":false}
```

只留下打开着的开关：

```bash
jq -c '.env | with_entries(select(.value == true))' app.json
```

```
{}
```

## 默认值与可选访问：`//` 和 `?`

`a // b` 在 `a` 为 `null` **或** `false` 时给出 `b`。第二种情况最容易坑人，记住：
`//` 是「假值」默认，不是「非 null」判断。结尾的 `?` 会在你试图遍历不可遍历的东西
时把报错吞掉；它把「这条路径不存在」从硬失败变成空流，这对一个必须容忍缺字段的
管道来说正是想要的。

```bash
jq '.limits.memory // "unset"' app.json
```

```
"unset"
```

```bash
jq -c '.env.DEBUG // "was false"' app.json
```

```
"was false"
```

这里 `.users` 不存在，于是对 `null` 做 `.[]` 会报错——但 `?` 能把错误变成空输出：

```bash
jq '.users[]' app.json
```

```
jq: error (at app.json:1): Cannot iterate over null (null)
```

```bash
jq '.users[]?' app.json
```

```
```

## 构造对象与数组

构造输出的方式和你写 JSON 一样，只是字段可以是任意表达式。用 `[...]` 把流包起来
就收成数组，`{n: .name, l: .logins}` 则按你选的键构造对象。这就是从冗长的 API 载
荷变成下游脚本真正需要的那两三个字段的办法，通常比在你熟悉的语言里做同样的重塑还
要短。

```bash
jq -c '[.[] | {n: .name, l: .logins}]' users.json
```

```
[{"n":"ana","l":42},{"n":"bo","l":7},{"n":"cy","l":19},{"n":"dee","l":7},{"n":"eve","l":null}]
```

## 值得记住的 jq 命令开关：-r、-c、-s、--arg、-e

有些管道活儿是滤镜语法干不了的：原始输出、紧凑输出、把流 slurp 成数组、传入参数，
以及把结果变成进程退出码。

`-s`（slurp）把整个输入当成单个数组读进来，而不是流。这就是把换行分隔的 JSON 变
成一个数组的办法。看 `events.ndjson`：

```
{"ts":"10:01","level":"info","svc":"api","msg":"start"}
{"ts":"10:02","level":"error","svc":"api","msg":"db timeout"}
{"ts":"10:03","level":"warn","svc":"web","msg":"slow"}
{"ts":"10:04","level":"error","svc":"web","msg":"500"}
```

```bash
jq -c -s 'length' events.ndjson
```

```
4
```

```bash
jq -r -s 'group_by(.level)[] | "\(.[0].level): \(length)"' events.ndjson
```

```
error: 2
info: 1
warn: 1
```

`--arg` 传字符串，`--argjson` 把值当 JSON 解析。两者都能让你远离 shell 引号地狱：

```bash
jq -c --arg region eu-west-1 '.env.REGION == $region' app.json
```

```
true
```

```bash
jq -c --argjson n 2 '.replicas * $n' app.json
```

```
6
```

`-e` 让结果决定退出码——`false`/`null` 为 `1`，无输出为 `4`，其余为 `0`。这才让
`jq -e` 成为脚本里真正的条件：`if jq -e '.ready' status.json > /dev/null; then ...`
直接读 JSON 并据此分支，一行解析代码都不用写。`4` 那种情况最常被忽略，因为「滤镜
什么都没匹配到」通常是个值得捕获的失败。

```bash
jq -e '.replicas > 99' app.json; echo "exit=$?"
```

```
false
exit=1
```

```bash
jq -e '.nope' app.json; echo "exit=$?"
```

```
null
exit=1
```

## 分组、排序、unique 与数学运算

`group_by` 和 `sort_by` 都会先排序，所以它们能干净地组合，通常不需要再来第二遍。
`unique` 不需要键，对任何值类型都管用。`add`、`length`、`max`、`min` 负责算术；
而且因为 `add` 把 `null` 当作单位元，对一个有时缺失的字段求和也能直接跑通。

```bash
jq -c 'group_by(.role) | map({role: .[0].role, n: length})' users.json
```

```
[{"role":"admin","n":1},{"role":"dev","n":3},{"role":"ops","n":1}]
```

```bash
jq -c 'map(.role) | unique' users.json
```

```
["admin","dev","ops"]
```

```bash
jq -c 'sort_by(.logins // 0) | reverse | map(.name)' users.json
```

```
["ana","cy","dee","bo","eve"]
```

对一个有时缺失的字段求和，null 会自动被忽略，因为 `null` 是加法的单位元：

```bash
jq -c 'map(.logins) | add' users.json
```

```
75
```

## 用 --stream 流式处理大文件

对一个大到装不进内存的文件，`--stream` 会在解析的同时吐出 `[path, value]` 对。常
用技巧是只保留叶子节点（`length==2`），这样整个文档永远不会被完整装进内存：

```bash
jq -c --stream 'select(length==2)' app.json | head -4
```

```
[["name"],"billing"]
[["version"],"2.3.1"]
[["replicas"],3]
[["env","REGION"],"eu-west-1"]
```

这些路径数组正是 `getpath` 和 `setpath` 认识的形式，所以一旦你用顺了 `--stream`，
就能在不把文档周边部分实体化出来的前提下，选中、丢弃或改写某个叶子。对于那个装不
进 RAM 的 10 GB 日志文件，这就是能跑通的命令和被 OOM 杀掉之间的区别。

## 把载荷变成一张表

快速扫一眼 API 响应最快的办法，就是把它拍平成一张表。`@tsv` 会替你转义制表符和换
行，所以结果可以安全地交给 `awk` 或 `cut`；`@csv` 同理，只是带正确的引号处理：

```bash
jq -r '.[] | [.name, .role] | @tsv' users.json
```

```
ana	admin
bo	dev
cy	dev
dee	ops
eve	dev
```

## 「我总是记不住」清单

- **没有 `-n` 就没有输出。** 不依赖输入的滤镜照样会去读 stdin。`jq -r '"hi"'
  </dev/null` 什么都不打印；`jq -nr '"hi"'` 打印 `hi`。
- **`-S` 对键排序**，让 diff 稳定；`-a` 只输出 ASCII；`--indent 4` 和 `--tab`
  改变缩进。
- **`keys_unsorted`** 保留原始顺序；普通的 `keys` 会排序。
- **`has("k")`** 在不遍历的情况下判断键是否存在。
- **`@csv`、`@tsv`、`@sh`** 把一个值格式化给别的工具用：
  `jq -r '.[] | [.name, .role] | @tsv' users.json`。
- **`getpath(["a","b"])`** 读取一条你以数据形式构造出来的路径。
- **`splits` 返回的是流**，所以要把它括起来：`jq -r -n '["a-b-c" |
  splits("-")][1]'` 打印 `b`。
- **`try ... catch`** 收敛错误：`jq -c 'try (.replicas / 0) catch "boom"' app.json`。
- **`-s` 会给输入再套一层数组**——把一个本来就是数组的文件喂给 `-s` 会得到
  `[[...]]`，从而让 `map(.field)` 失效。
- **`max`/`min` 会把 `null` 算进去**，而 `null` 排在数字前面，所以只要有记录缺了
  该字段，`map(.logins) | min` 就会返回 `null`。

这就是我日常真正在跑的那套循环：select、变换、默认、slurp、分组。想了解更宏观的
「为什么要用结构化数据」，我的[结构化日志那篇](/zh/posts/structured-logging/)是
配套读物；而管道本身出问题时，[strace 就是我查明原因的方式](/zh/posts/debugging-with-strace/)。
