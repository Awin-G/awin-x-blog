---
title: "find 命令与 ripgrep：搞定一切的两条命令"
description: "一份实用的 find 命令与 ripgrep 指南，把 ripgrep 当作 grep replacement 来用：按名字、类型、大小、mtime、属主与权限搜索文件；为什么 -print0 和 xargs -0 非用不可；ripgrep 的智能过滤、ignore 文件与二进制识别如何工作；fd 作为更好用的 find；以及查大文件、查最近改动、列出唯一匹配等真实 recipe。"
pubDate: 2026-12-25
lang: zh
translationKey: find-and-ripgrep
tags: [linux, devops]
featured: false
keywords:
  - ripgrep
  - find 命令
  - grep replacement
  - 搜索文件
  - fd
  - xargs -0
  - -print0
---

我在服务器上做的几乎所有事情，最后都会归结为两类问题。**“这是哪个文件，它又是什么？”是文件系统问题，**find 命令**负责回答。“这段文字在哪？”是内容问题，而 **ripgrep** 就是我用来替代 `grep -r` 的 **grep replacement**。这两条命令合起来，覆盖了我**搜索文件**时绝大多数场景。这篇是我希望早点有人塞给我的版本：真实的命令、真实的输出，以及那些能让一次搜索不至于变成一次误删的安全规则。

下面每条命令，都是在我临时目录里搭出的一棵一次性小树上跑的——里面放了 Python、Rust、JS、Markdown、日志、一个二进制文件、一个 6 MB 的 dump，还有几个带空格的文件名。输出是裁剪过的，但没有编造。等你需要理解**找到的**那段代码时，那是下一步：[读懂一个代码库](/zh/posts/reading-a-codebase/)。等你需要知道是谁改的，那就是[Git 考古](/zh/posts/git-archaeology/)。

## find 与 ripgrep：元数据 vs 内容

分界线很简单，值得在敲命令之前先刻进脑子里：

- **`find` 遍历的是文件系统。** 它知道名字、类型、大小、时间戳、属主和权限。除非你明确让它打开文件，否则它**不**读文件内容。
- **`rg` 遍历的是内容。** 它读字节、匹配模式，而对一个文件的大小或 mtime 一无所知。

所以“删掉所有一年以上的文件”是 `find`；“告诉我 `SESSION_TTL` 在哪定义”是 `rg`。用 `grep -r` 找内容没问题，直到你发现它会一头扎进 `.git`、`node_modules` 和各种二进制 blob——而这恰恰是 ripgrep 默认跳过的活。

<figure>
<svg viewBox="0 0 640 210" role="img" aria-label="决策示意图：要文件系统元数据用 find，要文件内容用 ripgrep" fill="none" stroke="currentColor" font-family="ui-monospace, monospace">
  <rect x="230" y="12" width="180" height="42" rx="8" stroke-width="1.5"/>
  <text x="320" y="38" text-anchor="middle" font-size="14" fill="currentColor" stroke="none">我要什么？</text>
  <line x1="270" y1="54" x2="140" y2="96" stroke-width="1.5"/>
  <line x1="370" y1="54" x2="500" y2="96" stroke-width="1.5"/>
  <text x="185" y="80" font-size="11" fill="currentColor" stroke="none">名字 / 大小 / 时间</text>
  <text x="420" y="80" font-size="11" fill="currentColor" stroke="none">文字 / 模式</text>
  <rect x="50" y="96" width="180" height="46" rx="8" stroke-width="1.5"/>
  <text x="140" y="115" text-anchor="middle" font-size="13" fill="currentColor" stroke="none">find</text>
  <text x="140" y="132" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">遍历目录树</text>
  <rect x="410" y="96" width="180" height="46" rx="8" stroke-width="1.5"/>
  <text x="500" y="115" text-anchor="middle" font-size="13" fill="currentColor" stroke="none">rg</text>
  <text x="500" y="132" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">遍历字节</text>
  <text x="320" y="190" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">问题两者都涉及，就把它们接起来用</text>
</svg>
<figcaption>两个工具，两个名词：文件系统，以及文件里的内容。</figcaption>
</figure>

## 安全规则：`-print0`、`-0`，以及 `rm $(find ...)` 为什么会咬人

这个错误已经让不少人赔上了整个目录。对 find 结果采取动作最直观的方式，是命令替换：

```bash
rm $(find . -name "*.log")
```

看着无害，其实不然。`find` 每行打印一个路径，shell 随后按空白把这个输出切开。一个名为 `log file with spaces.log` 的文件，会变成四个独立的参数。我用一条无害的命令来证明，而不是拿 `rm` 来试：

```bash
$ find . -name "*.txt" | xargs -n1 printf "[%s] "
[./backup/old] [report] [2024.txt]
```

一个真实文件，被拆成了三个畸形的参数。如果这里把 `printf` 换成 `rm`，你就会删掉恰好名叫 `old`、`report` 或 `2024.txt` 的东西。修法是别再拿路径当文本传。`find -print0` 用一个 NUL 字节分隔路径，而 `xargs -0` / `grep -Z` 读的就是这个 NUL：

```bash
$ find . -name "*.txt" -print0 | xargs -0 -n1 printf "[%s] "
[./backup/old report 2024.txt]
```

有三条规则我会无条件遵守：

1. **绝不**写 `rm $(find ...)`。用 `-print0 | xargs -0`，或者更好：`-exec ... {} +`。
2. **给 glob 加引号。** `find . -name "*.log"`——不加引号的话，shell 会在 `find` 运行之前，先拿**当前**目录展开 `*.log`。
3. **毁之前先预览。** 把 `rm` 换成 `ls` 或 `echo` 跑一遍，然后再真正执行。

## find 命令真正重要的那些谓词

`find` 的价值，大半来自五个谓词。以下在原样的 demo 树上运行，未经修饰：

```bash
$ find . -name "*.py"
./src/utils/strings.py
./src/api/errors.py
./src/api/routes.py
./src/auth/session.py
./src/auth/login.py

$ find . -type f -name "*.log"
./logs/app.old.log
./logs/app.log
./backup/log file with spaces.log

$ find . -size +1M
./assets/old/dump.bin

$ find . -mtime -7 -type f
./logs/app.log
./docs/guide.md
./src/auth/session.py
...
```

- `-name` / `-iname` 匹配基名（带 `i` 则忽略大小写）。
- `-type f`（`d`、`l`）过滤普通文件、目录、符号链接。
- `-size +1M`——`+` 是“大于”，`-` 是“小于”，后缀很关键（`c` 字节、`k`、`M`、`G`）。
- `-mtime -7` 是“最近 7 天内修改过”；`-mtime +365` 是“一年以上”。想要真实日期时，用 `-newermt "2026-10-01"`。
- `-user`、`-group` 和 `-perm` 处理属主与权限位。`-perm -u+x` 表示“属主可执行位已置位”（注意开头的 `-`）。

还有两个值得记住：`-maxdepth 2` 阻止遍历继续加深，在超大目录树上能实实在在省时间；`-newer file` 表示“比那个文件改得更新”。

## 把 find 和 `-exec`、`xargs -0` 结合起来

拿到结果集之后，有两种方式对它采取动作。`-exec` 从 `find` 内部直接调用命令：

```bash
$ find . -type f -size +1M -exec ls -lh {} +
-rw-r--r-- 1 awinx awinx 5.8M 10月12日 18:41 ./assets/old/dump.bin

$ find . -type f -name "*.log" -exec wc -l {} +
  3 ./logs/app.old.log
  3 ./logs/app.log
  1 ./backup/log file with spaces.log
  7 总计
```

`{} +` 这种形式，会在一次命令行能塞下的范围内，把尽可能多的路径一起传进去——比 `{} \;` 快得多，因为后者每个文件都要起一个进程。`-exec` 也不需要什么引号技巧，因为 `find` 会把每个路径当作独立参数传过去；空格从结构上就是安全的。

`xargs -0` 是基于管道的等价物，当文件列表来自别处、或你想把它插进管道中段时，就该用它：

```bash
$ find . -type f -name "*.txt" -print0 | xargs -0 ls -l
-rw-r--r-- 1 awinx awinx 24 2021年 6月 1日 ./backup/old report 2024.txt
```

心智模型是：`-exec` 是 find 原生且安全的，`-print0 | xargs -0` 是可组合且安全的。永远不要把一根光秃秃的 `|` 混进一条会删除或移动的命令里。

## ripgrep：那个跳过你不想看的东西的 grep replacement

`rg` 是我每台机器都会装的**grep replacement**。语法很熟悉：

```bash
$ rg -n "login" src/
src/api/routes.py:11:@app.route("/login", methods=["POST"])
src/api/routes.py:12:def login():
```

它和 `grep -r` 的分歧，在于它**拒绝**搜索什么。默认情况下，ripgrep 跳过隐藏文件，并遵循 `.gitignore`、`.ignore` 和 `.rgignore`——但这里有个我必须亲自验证而不能想当然的细节：ignore 文件只在 **git 仓库内部** 才生效。在我的树里，`git init` 之前，`rg` 搜了 2300 个文件，包括 `node_modules`；`git init` 之后，同样的命令只搜了 2000 个，把被忽略的目录整个跳过了：

```bash
$ rg --stats "login" .      # 在 git 仓库内
2000 files searched
6357768 bytes searched
0.022445 seconds total
```

真正的优势是这种过滤，而不是裸速度。在一棵小小的、缓存已热的树上，`grep -rn` 和 `rg` 老实说是旗鼓相当；ripgrep 的优势会在它得以“**不去读**”某个 vendored 目录时不断叠加。若想无论如何都看全部，`rg -uu` 会同时关掉 ignore 文件和隐藏过滤：

```bash
$ rg "SECRET"          # 隐藏文件，被跳过
$ rg --hidden "SECRET"
.hidden/env:SECRET=notreally
```

二进制的处理同样是有意为之。ripgrep 一见到 NUL 字节就判定该文件为二进制，随后拒绝把乱码泼到你的终端上：

```bash
$ rg "login" vendor/secret.bin
binary file matches (found "\0" byte around offset 6)

$ rg -a "login" vendor/secret.bin | cat -v
header^@^@login payload inside binary^@
```

`-a` 强制搜索，`-uuu` 也一样。我真正在用的 flags，大致按使用频率从高到低：

- `-t py` / `-t rust`——只搜某语言类型的文件；`-T json` 则是排除。
- `-g "*.md"` / `--glob "!vendor/**"`——按 glob 包含或排除。
- `-l` 只列文件名；`-c` 统计每个文件的匹配数；`-o` 只打印匹配到的那段。
- `-i` 忽略大小写，`-w` 全词匹配，`-F` 按字面固定字符串。
- `-A2 -B1 -C3` 追加后文/前文/上下文行。
- `-U` 开启多行搜索，让你能跨行边界匹配。
- `--json` 每个事件输出一个结构化对象——做脚本的绝配。

上下文与多行，跑在真实文件上：

```bash
$ rg "hash_password" -A2 -B1 src/auth/login.py

def hash_password(raw: str, salt: bytes) -> str:
    digest = hashlib.sha256(salt + raw.encode()).hexdigest()
    logger.info("hashed password for user")
--
    # TODO: use constant-time comparison
    return hash_password(raw, salt) == expected

$ rg -U -n "def login\(\):[\s\S]*?return jsonify" src/api/routes.py
12:def login():
13:    payload = request.get_json()
14:    return jsonify(user=payload.get("user"))
```

## fd：一个更好用的 find（在装得上的时候）

`fd` 是一个现代的 `find` 替代品，默认就讲道理：开箱即用遵循 `.gitignore`、带颜色，还能直接吃正则，而不是那一堆谓词。这台机器上它没装：

```bash
$ command -v fd || echo "fd: not installed on this box"
fd: not installed on this box
```

我不会假装我跑过它。不过心智映射很直接——`fd PATTERN` 约等于 `find . -iname "*PATTERN*"`，而 `fd -e py` 约等于 `find . -name "*.py"`。当 `fd` **可用**时，我用它做交互式的“帮我把那个文件找出来”，而任何要进脚本的地方仍留给 `find`，因为 `find` 是 POSIX 基础，`fd` 不是。顺带一句建议：如果你的脚本要通过 shell 调 `fd` 或 `rg`，就给它们配一句清晰的报错信息，在二进制缺失时说出来，就像上面那行一样。

## 真实 recipe

以下是我敲得最频繁的几条。全部输出都来自那棵 demo 树。

### 找出吃你磁盘的大文件

```bash
$ find . -type f -size +1M -printf "%s\t%p\n" | sort -rn
6000000	./assets/old/dump.bin

$ find / -xdev -type f -size +500M -printf "%s\t%p\n" 2>/dev/null | sort -rn
```

带 `%s` 的 `-printf` 比 `-exec ls -l` 干净，而 `-xdev` 让你留在同一个文件系统里，不会一头扎进别的挂载点。

### 找出最近改过什么

```bash
$ find . -type f -newermt "2026-10-01" ! -newermt "2026-10-08" -printf "%TY-%Tm-%Td %p\n" | sort
2026-10-05 ./src/api/routes.py
```

这就是那个“这次部署到底碰了什么？”的问题，用真实日期回答，而不是 mtime 整数。

### 只在某一棵特定的树里搜索

```bash
$ rg -t py "import" src/
src/auth/login.py:import hashlib
src/auth/login.py:import logging
src/auth/session.py:import secrets
src/api/routes.py:from flask import Flask, request, jsonify
```

限定路径，而不是跟模式较劲。`rg -t py` 意思是“只要 Python”，当你心里有好几种扩展名时，它比 `-g "*.py"` 既更快又更少杂音。

### 按文件类型 grep

```bash
$ rg -t rust "user"
src/api/handler.rs:    let user = req.query("user");
src/api/handler.rs:    Response::ok(format!("hello {user}"))
```

如果 `rg` 不认识某个类型，`-g` 可以兜住；`rg --type-list` 会打印出它能识别的所有类型。

### 列出唯一匹配

```bash
$ rg -o --no-filename "user=\w+" logs/ | sort | uniq -c
      2 user=alice
      2 user=bob

$ rg -o --no-filename -t py "def \w+" src/ | sort -u
def hash_password
def health
def __init__
def is_expired
def login
def new_token
def slugify
def truncate
def verify
```

`-o` 只打印匹配到的那段文本，`--no-filename` 去掉路径前缀，接着就是普通的 Unix 管道活。我就是这样，一行之内从一个代码库里抽出所有函数名、所有事故编号、所有错误码。

## 我什么时候用哪个

当答案是一个文件时，先用 `find`；当答案是一行文本时，先用 `rg`。两者是可以组合的：`find` 按元数据收窄集合，`rg` 在集合内部读取，而 `xargs -0` 或者一个 `while IFS= read -r -d ''` 循环，负责把集合安全地传过去。唯一会咬人的地方，就是两者之间的衔接——所以永远 `-print0` 接 `-0`，永远给 glob 加引号，永远把破坏性管道先干跑一遍。做到这些，这两条命令真的就会成为搞定一切的两条命令。
