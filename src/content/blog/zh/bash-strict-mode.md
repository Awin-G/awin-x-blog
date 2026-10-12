---
title: "Bash 严格模式，以及那些会在生产环境里咬人的坑"
description: "一篇上手即用的 bash 严格模式指南：set -euo pipefail 究竟各做了什么、set -e 会在哪些场景下悄悄失效、单词拆分与 IFS 如何弄坏脚本、如何用 trap EXIT 和 mktemp 做清场、怎么读 PIPESTATUS，以及为什么 shellcheck 才是真正的安全网。每个坑都配一个真实失败脚本和它的输出。"
pubDate: 2026-12-26
lang: zh
translationKey: bash-strict-mode
tags: [linux, devops]
featured: false
keywords:
  - bash 严格模式
  - set -euo pipefail
  - shellcheck
  - bash 陷阱
  - 单词拆分
---

去年我写出的最糟的一个脚本，0.4 秒就跑完，还打印了 `backup looks done`。它其实什么都没拷：源路径是错的，`cp` 失败了，而脚本里没有任何东西让它停下来。这一句话就说清了 **bash 严格模式** 的意义——默认情况下，shell 脚本会忽略几乎每一次失败，并返回它碰巧执行的最后一条命令的退出码。

这篇文章会走一遍 `set -euo pipefail`，讲清楚 `set -e` *仍然* 会失效的那些地方，以及那些造成大多数「在我机器上是好的」bug 的引号规则。下面每一个失败，都是我在临时目录里真正跑过的脚本，输出是原样贴过来的。

## bash 严格模式到底买到了什么

严格模式就是 shebang 之后的一行：

```bash
#!/usr/bin/env bash
set -euo pipefail
```

它不会把一个脚本变正确。它消除的是三类特定的沉默——这是 bash 最接近「编译器警告」的东西。它不会替你给变量加引号、校验输入，也不会阻止 `rm` 跟着一个错误的路径走；严格模式是安全带，不是司机。方向盘还得你自己握。

### `-e`（`errexit`）：命令失败就停下

没有它，失败只是一行打印了错误、然后继续往下走的命令：

```bash
#!/usr/bin/env bash
rm -f priceless.txt
cp missing-source.txt priceless.txt   # fails
echo "backup looks done"
```

```console
$ bash noe.sh
cp: cannot stat 'missing-source.txt': No such file or directory
backup looks done
ls: cannot access 'priceless.txt': No such file or directory
```

退出码取的是*最后一条*命令的状态，于是这个脚本「成功地撒了个谎」。加上 `set -e`，`cp` 的失败就会在它撒谎之前结束脚本。

### `-u`（`nounset`）：变量未设置就停下

未设置的变量会展开成空串，这正是 `rm -rf "$DIR/"` 变成 `rm -rf /` 的方式：

```bash
set -u
echo "start"
echo "DEBUG=${DEBUG_MODE}"   # never set anywhere
echo "end"
```

```console
$ bash u.sh
start
u.sh: line 4: DEBUG_MODE: unbound variable
```

`end` 再也不会打印。这就是重点。

### `-o pipefail`：让管道报告最糟的那一段

这是最被低估的一个开关。没有它，管道的状态就是**最后一条**命令的状态，于是上游的失败会凭空消失：

```bash
set -eu
echo "importing..."
cat /does/not/exist.csv | wc -l
echo "import finished OK (exit $?)"
```

```console
$ bash pipe.sh
importing...
cat: /does/not/exist.csv: No such file or directory
0
import finished OK (exit 0)
```

`wc -l` 从一个根本不存在的文件里数出了零行，还报告成功。有了 `pipefail`，`cat` 的失败会成为整条管道的状态，`-e` 随后把脚本停掉。

## `set -e` 会悄悄失效的地方（bash 陷阱）

`set -e` 不是力场。bash 明确列出了一批会禁用它的上下文；下面这些，是会让人丢数据的。

### 条件里的命令被豁免

任何出现在 `if`、`while`、`until`、`&&`/`||` 列表里、或者 `!` 之后的命令，都是*预期会失败*的，因此 `-e` 对它网开一面：

```bash
set -e
if ! grep -q "deprecated" notes.txt; then
  echo "notes.txt has no 'deprecated' marker"
fi
echo "reached the end"
```

```console
$ bash ifgotcha.sh
grep: notes.txt: No such file or directory
notes.txt has no 'deprecated' marker
reached the end
```

`grep` 失败是因为文件*不存在*，而不是因为没有那个标记，脚本却继续往下走了。要把「文件在不在」单独测掉——`[[ -f notes.txt ]] || die "notes.txt is missing"`——而不是把一个它扛不住的语义塞进退出码里。

### 子 shell 和 `$(...)` 里的失败

裸子 shell 是遵守 `-e` 的：跑一句 `( false; echo unreachable )`，那个 `echo` 永远不会打印。但把同样的子 shell 放进一个条件里，它的整个函数体就都被豁免了：

```bash
if ( false; echo "inside a subshell that is a condition" ); then
```

```console
$ bash sub_c.sh
inside a subshell that is a condition
then-branch
after
```

`false` 被忽略，`if` 走进了 *then* 分支。命令替换有同样的盲区：它的状态是最里面最后一条命令的状态，所以 `x=$(false; echo "hi")` 会把 `x` 设成 `hi` 并返回 `0`——那个 `false` 就这么没了。永远不要用「我在 `$(...)` 里检查过了」来代替「这个替换失败了」。

### 函数，以及 `local x=$(cmd)` 这个坑

当一个函数被用来做判断时——放进 `if`，或者接在 `||` 后面——`-e` 会在它的*整个函数体*里被关掉，而它只返回最后一条命令的状态：

```bash
set -e
check() {
  grep -q "ok" missing.txt   # fails
  echo "check() continued after its grep failed"
}
check || echo "check returned non-zero"
```

```console
$ bash fngotcha.sh
grep: missing.txt: No such file or directory
check() continued after its grep failed
script finished
$ echo $?
0
```

它的孪生陷阱是 `local`：它的退出状态是 `local` 自己的，而不是那个命令替换的：

```bash
local payload=$(cat definitely-not-here.json)   # fails
echo "status right after local = $?"
```

```console
$ bash localrc.sh
cat: definitely-not-here.json: No such file or directory
payload=[]
status right after local = 0
fetch returned; script kept going
```

`set -e` 根本不会触发，`$?` 读出来的还是 `0`。把声明和赋值拆开写：`local payload; payload=$(cat ...) || die "no payload"`。

算术里还藏着另一个沉默杀手。当 `i=0` 时，表达式 `(( i++ ))` 求的是*旧值* `0`，而算术命令把这个值当作自己的状态返回——于是它返回 `1`。在 `set -e` 下，循环会在第一次迭代就死掉，什么也不打印。用 `(( ++i ))`（前置自增，返回新的非零值），或者写成 `(( i++ )) || true`。

## 引号与单词拆分：头号「在我机器上是好的」

**单词拆分** 是 bash 对一个未加引号的展开按 `IFS`（默认是空白）重新切分，然后再做通配展开。只要文件名里有一个空格，它就会现形：

```bash
names="my report.txt a b.txt plain.txt"
for f in $names; do echo "[$f]"; done
```

```console
$ bash split.sh
--- unquoted loop ---
1: [my]
2: [report.txt]
3: [a]
4: [b.txt]
5: [plain.txt]
```

三个文件名，迭代了五次。括号测试运算符同样地字面——`[ ]` 碰到空展开还会直接报错：

```console
$ bash brackets.sh
--- [ ] with a glob ---
literal test: FALSE
--- [[ ]] with a glob ---
pattern test: TRUE
--- [ ] with an empty variable ---
brackets.sh: line 10: [: =: unary operator expected
not equal
```

从这次运行里可以抽出三条规则：

1. **给每一个你不打算拆分的展开加引号**：写 `"$name"`，不是 `$name`。
2. **优先用 `[[ ]]` 而不是 `[ ]`。** 在 `[[ ]]` 里，展开既不会被拆分也不会被通配，`[[ $name = *.txt ]]` 做的是模式匹配，空串也是安全的。
3. **永远不要把列表存进一个字符串。** 这就是下一节。

## 凡是列表，用数组而不是字符串

只要一个值可能包含空白或者通配字符，它就该放进数组，而不是字符串。上面那个循环的修法：

```bash
files=("my report.txt" "a b.txt" "plain.txt")
for f in "${files[@]}"; do echo "[$f]"; done
```

`"${files[@]}"` 是唯一正确的展开方式：每个元素各自加引号，一个都不拆分。数个数用 `"${#files[@]}"`，取切片用 `"${files[@]:1}"`，除非你确实想要一个拼起来的字符串，否则别用 `${files[*]}`。

## `trap EXIT` 与 `mktemp`：自己收拾干净

一个会创建临时文件或锁的脚本，必须在它死掉时也把它们清掉。`mktemp` 给你一个唯一路径；`trap ... EXIT` 保证清场在正常退出、`-e` 触发的报错、或者收到信号时都会跑：

```bash
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
```

这套接线很容易接错一点点。如果你在函数里把临时目录创建成 `local`，那么 EXIT trap 会在函数返回*之后*才触发，此时那个 local 早已出了作用域：

```console
$ bash localtrap.sh
work done in /tmp/tmp.rDa7Aj3KKb
localtrap.sh: line 1: workdir: unbound variable
$ echo $?
1
```

在 `set -u` 下，trap 自己会死在这个未绑定变量上，目录随之泄漏。把路径声明在脚本顶层、任何函数之外，这样 trap 还能看见它；优先用 `mktemp -d`，别手搓 `/tmp/myapp.$$` 这种名字；trap 里的路径也永远加引号。

## 退出码、`$?` 与 `PIPESTATUS`

`$?` 是最近一条命令的状态——而且它会被紧接着的下一条命令覆盖，哪怕那条命令只是你的 `echo`：

```console
$ bash pstat.sh
PIPESTATUS = 0 1 0
$? of the pipeline = 0 because cat succeeded
```

整条管道的 `$?` 是 `0`，因为最后一段成功了；但 `PIPESTATUS` 是 `0 1 0`：中间那个 `grep` 失败了。它**会被下一条命令冲掉**，所以要在打印任何东西之前立刻捕获（`statuses=("${PIPESTATUS[@]}")`）。如果你只想知道「有没有任何一段失败」，`pipefail` 更省事——这也正是 `bash pstat_pipefail.sh` 会以 `1` 退出、永远走不到下一行的原因。

<figure>
<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="一条 cat、grep、sort 三段管道，因为只报告最后一段而返回状态 0；PIPESTATUS 记录为 0、1、0，而 pipefail 把整条管道收敛成一个失败状态 1。">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="12" y="40" width="120" height="46" rx="8"/>
    <rect x="258" y="40" width="120" height="46" rx="8"/>
    <rect x="504" y="40" width="120" height="46" rx="8"/>
    <path d="M132 63 h120" marker-end="url(#ar)"/>
    <path d="M378 63 h120" marker-end="url(#ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="72" y="60">cat log</text>
    <text x="72" y="77" opacity="0.75">失败</text>
    <text x="318" y="60">grep -c ERROR</text>
    <text x="318" y="77" opacity="0.75">失败</text>
    <text x="564" y="60">sort</text>
    <text x="564" y="77" opacity="0.75">成功</text>
    <text x="195" y="55" opacity="0.9">0</text>
    <text x="441" y="55" opacity="0.9">1</text>
    <text x="72" y="118" opacity="0.9">$? = 0</text>
    <text x="318" y="118" opacity="0.9">PIPESTATUS = 0 1 0</text>
    <text x="564" y="118" opacity="0.9">pipefail → 1</text>
  </g>
</svg>
<figcaption>只有最后一段会写入 `$?`；`PIPESTATUS` 把它们全留下，而 `pipefail` 把整条管道收敛成一个失败状态。</figcaption>
</figure>

## `shellcheck` 才是真正的安全网

严格模式在运行时抓失败。**shellcheck** 在你运行之前就抓：未加引号的展开（SC2086）、`local`/`export` 掩盖返回值（SC2155）、不可达代码，以及上面那些 `set -e` 豁免。它以静态方式读你的脚本，并精确指到出错的列：

```console
$ shellcheck import.sh

In import.sh line 9:
cat $source | wc -l
    ^-----^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
cat "$source" | wc -l

In import.sh line 14:
  local out=$(convert "$1")
        ^--^ SC2155 (warning): Declare and assign separately to avoid masking return values.

For more information:
  https://www.shellcheck.net/wiki/SC2086 -- Double quote to prevent globbing and word splitting.
  https://www.shellcheck.net/wiki/SC2155 -- Declare and assign separately to avoid masking return values.
```

坦白说：我跑上面那些 demo 的沙箱里没装 shellcheck，也没有网络把它装上，所以这一段是它标准的诊断措辞，而不是一次运行的实录——但结论不受影响。极少数情况下你确实想拆分时，`# shellcheck disable=SC2086` 注释就是逃生口；加上 `-x` 让它跟随 source 进来的文件；并把它接进 CI（`shellcheck -x deploy/*.sh`）和你的编辑器。当你读一个不是自己写的脚本时，用的是同一块肌肉，正如[阅读一份代码库](/zh/posts/reading-a-codebase/)；你留给下一个人的注释，也是[写一份 README](/zh/posts/writing-a-readme/) 的同一份纪律。

## 一份可以直接抄的加固模板

这就是我开每一个非平凡脚本时的骨架：严格模式、把 `IFS` 收窄到只按换行和制表符拆分、一个 `die` 助手、把临时目录清场提到函数之外、处处加引号，以及一个真实的退出状态。

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

log() { printf '[%s] %s\n' "$(date +%T)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

readonly WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

main() {
  local src="${1:-}"
  [[ -n $src ]] || die "usage: ${0##*/} <file>"
  [[ -f $src ]] || die "not a file: $src"

  local lines
  lines=$(wc -l <"$src") || die "cannot count lines in $src"
  log "read $lines lines from $src"
  printf '%s\n' "$lines"
}

main "$@"
```

```console
$ bash good.sh sample.txt
[18:46:06] read 3 lines from sample.txt
3
$ echo $?
0
```

有两个细节让它稳固：`lines=$(...)` 和 `local lines` 是*分开*的两条语句，所以 `wc` 失败会触发 `-e`；而工作目录创建在顶层、不在 `main` 里，所以 `EXIT` trap 还能看见它。我用「前后各数一次临时目录」的方式验证了清场——差值为零。

## 一句话总结

`set -euo pipefail` 让脚本在 bash 平时会忽略的失败上停下来，但 `-e` 会在这些地方被挂起：条件里、`&&`/`||` 列表里、用作条件的子 shell 里、命令替换里，以及被判断的函数的函数体内——所以永远不要让退出码承载它扛不住的语义。给每个展开加引号，列表用数组，在任何其它命令之前先捕获 `PIPESTATUS`，用 `mktemp` 加顶层 `trap ... EXIT` 清场，剩下的交给 shellcheck 在生产环境之前发现。
