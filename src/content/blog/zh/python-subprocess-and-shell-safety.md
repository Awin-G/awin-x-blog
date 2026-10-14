---
title: "Python subprocess 与 shell 注入防护：列表传参、真实攻击演示、真实堆栈"
description: "一份动手向的 Python 外部命令安全指南：为什么列表传参优于 shell=True，用真实可运行的注入示例讲解 shlex.quote，以及 check=True、capture_output、timeout、env 和 cwd 的用法。所有输出均为实际执行结果。"
pubDate: 2027-02-06
lang: zh
translationKey: python-subprocess-and-shell-safety
tags: [python, security]
featured: false
keywords:
  - Python subprocess
  - shell 注入
  - shell=True
  - subprocess.run
  - shlex.quote
---

任何需要和外部世界打交道的 Python 程序，迟早都要执行一条命令：`git`、`ffmpeg`、`openssl`，或者某个内部 CLI。接口只有一个函数——`subprocess.run`——而"方便"和"有漏洞"之间的差别，通常只是一个关键字：`shell=True`。这篇文章讲的就是这个差别，而且下面所有内容都是我在自己机器上真跑过的。Python 3.14.7，一个位于 `/tmp/opencode/work/subprocess` 的临时目录，以及一个只会打印的攻击载荷。

## 命令的两种形态

`subprocess.run` 接收命令的方式有两种。

第一种是**参数列表**。列表被直接交给内核成为 `argv`——一个列表项就是一条 `argv` 记录，中间不做任何解释。

```python
subprocess.run(["ls", "-l", "demo"])
```

第二种是**字符串**。字符串本身没有意义，必须有一个 shell 来解析它——所以 `shell=True` 会拉起 `/bin/sh -c "<字符串>"`。这个字符串会被重新解析：元字符被解释、引号被处理、展开被求值。

```python
subprocess.run(f"ls -l {base}/demo", shell=True)
```

这个"重新解析"步骤就是全部问题的所在。文件名是一个*值*；`ls -l <file>` 是*代码*。当你用 f-string 拼出这段代码时，你就是在把一个值拼进一段程序里。

规则只有一条，而且没有值得争辩的例外：**永远不要把不可信输入传给 `shell=True`；优先用列表。**

## 来真的：注入演示

下面这个实验是这样的。一个不可信的值——`hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it`——用四种方式传入。一切都留在我的临时目录里，载荷的 `echo` 是它唯一会做的事。

```python
name = "hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it"
```

脚本（`demo1_list_vs_shell.py`）：

```python
import subprocess
from pathlib import Path

base = Path("/tmp/opencode/work/subprocess")
(base / "demo").mkdir(exist_ok=True)
(base / "demo" / "hello.txt").write_text("hello\n")

subprocess.run(["ls", "-l", "demo"])                              # A：列表
subprocess.run(f"ls -l {base}/demo", shell=True)                  # B：字面量
subprocess.run(f"ls -l {base}/demo/{name}", shell=True)           # C：注入
subprocess.run(["ls", "-l", f"{base}/demo/{name}"])               # D：同样输入
```

真实输出：

```
=== A) list of args (recommended) ===
total 4
-rw-r--r-- 1 awinx awinx 6 Oct 14 13:33 hello.txt

=== C) shell=True with untrusted input ===
-rw-r--r-- 1 awinx awinx 6 Oct 14 13:33 /tmp/opencode/work/subprocess/demo/hello.txt
INJECTED-if-this-prints-the-shell-parsed-it

=== D) the SAME untrusted input, passed as a list ===
ls: cannot access '/tmp/opencode/work/subprocess/demo/hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it': No such file or directory
```

请把 C 段和 D 段并排读，因为它们就是整篇文章。

在 C 里，`/bin/sh -c "ls -l .../hello.txt; echo INJECTED..."` 执行的是**两条**命令。`ls` 列出了真实文件，然后分号结束了这条语句，注入的 `echo` 开始运行。程序是攻击者挑的，你的进程只是掏了执行它的权限。

在 D 里，同一个字符串作为单一的 `argv[2]` 进入 `execve`。链路里没有 shell，所以没有任何东西被解析。`ls` 收到一个恰好含有分号的文件名，然后诚实地报告找不到这个文件。载荷就此失效——不是被过滤掉的，而是*结构上*失效。安全性来自调用的形态，而不是来自对输入的检查。

这才是要内化的那个性质：用列表时，一个敌意文件名依然是敌意文件名，但它没法不再是一个文件名。

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="左路：三个参数组成的列表直接进入 execve，到达程序时成为 argv 0、argv 1 和 argv 2，敌意文件名保持完整。右路：一个 shell 字符串被 shell 解析，按元字符拆成两条独立命令。">
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="26" opacity="0.9">参数列表 → 每项各占一条 argv</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="44" width="150" height="52" rx="8"/>
    <rect x="186" y="44" width="150" height="52" rx="8"/>
    <rect x="356" y="44" width="264" height="52" rx="8"/>
    <path d="M166 70 h20" marker-end="url(#hfm1)"/>
    <path d="M336 70 h20" marker-end="url(#hfm1)"/>
  </g>
  <defs>
    <marker id="hfm1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="91" y="66">["ls", "-l",</text>
    <text x="91" y="86" opacity="0.75">三个列表项</text>
    <text x="261" y="66">"ls" "-l"</text>
    <text x="261" y="86" opacity="0.75">execve(argv)</text>
    <text x="488" y="66">"evil; echo INJECTED"</text>
    <text x="488" y="86" opacity="0.75">argv[2]——仅一个参数</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="140" opacity="0.9">shell 字符串 → 由 shell 重新解析</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.85">
    <rect x="16" y="156" width="150" height="52" rx="8"/>
    <rect x="186" y="156" width="150" height="52" rx="8"/>
    <rect x="356" y="156" width="128" height="52" rx="8"/>
    <rect x="500" y="156" width="120" height="52" rx="8"/>
    <path d="M166 182 h20" marker-end="url(#hfm2)"/>
    <path d="M336 182 h20" marker-end="url(#hfm2)"/>
    <path d="M484 182 h16" marker-end="url(#hfm2)"/>
  </g>
  <defs>
    <marker id="hfm2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="91" y="178">"ls -l evil;</text>
    <text x="91" y="198" opacity="0.75">echo INJECTED"</text>
    <text x="261" y="178">/bin/sh -c</text>
    <text x="261" y="198" opacity="0.75">切词</text>
    <text x="420" y="180">ls -l evil</text>
    <text x="560" y="180">echo INJECTED</text>
  </g>
</svg>
<figcaption>同一个不可信文件名，两种形态。列表让它保持一个参数；shell 字符串则把第二个命令交给了语法分析器。</figcaption>
</figure>

## 当 shell 确实必要：`shlex.quote`

有时候 shell 是躲不掉的——管道、通配符，或者某个库没有暴露的重定向。这时这个值必须按*面向 shell* 的方式加引号，而 `shlex.quote` 就是那个能正确干这件事的工具，而不是你写的那条正则。

```python
import shlex
import subprocess

name = "x; echo INJECTED"
subprocess.run(f"cat {base}/{shlex.quote(name)}", shell=True)
```

实际拼出来的东西是：

```
cat /tmp/opencode/work/subprocess/demo2/'x; echo INJECTED'
```

以及 `cat` 报告的内容——一个参数，分号原样保留，注入的 `echo` 从未执行：

```
=== A) shell=True, raw f-string ===
cat: /tmp/opencode/work/subprocess/demo2/x: No such file or directory
INJECTED

=== B) shell=True, shlex.quote(name) ===
cat: '/tmp/opencode/work/subprocess/demo2/x; echo INJECTED': No such file or directory
```

在 A 里，shell 把字符串拆开，`cat` 去访问并不存在的路径 `demo2/x`，然后 `echo INJECTED` 执行了。在 B 里，`shlex.quote` 加上的单引号告诉 shell 把这一整团东西当成一个词，于是注入悄悄变成了一个文件名。

`shlex.quote` 是正确解法，同时也是更弱的那个：它是给一个一开始就走错了的设计打的补丁。要*整段*加引号，绝不加一半，绝不要加完引号又重新拆开。如果你发现自己在给一条命令的多个片段分别加引号，那就是该把调用重写成列表的时刻。

## 错误处理：`check=True` 与 `CalledProcessError`

默认情况下 `subprocess.run` 返回一个带非零 `returncode` 的 `CompletedProcess`，什么也不说。沉默不等于成功——如果构建失败了而你继续往下走，你发布的就是一个旧产物。

```python
r = subprocess.run(["ls", "definitely-not-here"], check=True)
```

抛出：

```
Traceback (most recent call last):
  File "/tmp/opencode/work/subprocess/demo4_traceback.py", line 4, in <module>
    subprocess.run(["ls", "definitely-not-here"], check=True)
    ~~~~~~~~~~~~~~
  File "/usr/lib/python3.14/subprocess.py", line 578, in run
    raise CalledProcessError(retcode, process.args,
                             output=stdout, stderr=stderr)
subprocess.CalledProcessError: Command '['ls', 'definitely-not-here']' returned non-zero exit status 2.
```

`CalledProcessError` 带有 `cmd`、`returncode`，以及在你捕获了它们时的 `output` 和 `stderr`——所以处理函数可以记录下失败的那次调用，而不是一句干巴巴的"命令失败"。如果你确实需要容忍失败（检查版本、探测某个二进制），就显式 `check=False`，然后自己检查 `returncode`。

## 捕获输出：`capture_output=True` 与 `text=True`

不加捕获时，子进程的输出直接进你的终端，这对机器来说是没用的。`capture_output=True` 把两条流都接到管道里；`text=True` 把它们解码成 `str`，而不是留给你一堆 `bytes`。

```python
r = subprocess.run(["cat", "cfg.txt"], capture_output=True, text=True)
```

```
returncode=0
stdout='MODE=production\n'
stderr=''
```

有一个坑值得刻进脑子：**在没有 timeout、也没有线程读管道的情况下，绝不要去捕获一个长生命期或话痨进程的 stdout**——管道缓冲区一旦写满就会阻塞子进程，你的 `run()` 调用会跟着一起挂住。只捕获你真正会读的东西，并且及时取走。

## 超时：`timeout=` 与 `TimeoutExpired`

命令可能卡死：服务无响应、`git` 在等凭据输入、脚本堵在 stdin 上。`timeout` 就是安全带，到期就杀掉进程。

```python
subprocess.run(["python3", "-c", "import time; time.sleep(30)"], timeout=2)
```

```
caught: TimeoutExpired cmd=['python3', '-c', 'import time; time.sleep(30)'] timeout=2
```

注意 `TimeoutExpired` 与 `check` 无关，照样会抛；还要注意杀掉直接子进程并不会连带停掉它派生的孙进程——要对付进程树，请用 `start_new_session=True` 再杀进程组，或者交给 `timeout(1)` 这样的外层工具。

## `env=` 与 `cwd=`

`cwd` 设置工作目录；`env` 则是**整体替换**环境变量，而不是在原有基础上追加。这一点常让人吃惊：忘了 `PATH`，连 `git` 都会找不到。

```python
env = {"MODE": "staging", "PATH": "/usr/bin:/bin"}
subprocess.run(["python3", "tool.py"], env=env, cwd=base)
```

```
MODE   = staging
PATH   = /usr/bin:/bin
cwd    = /tmp/opencode/work/subprocess/demo3
```

对比默认继承的情况，`MODE` 根本不存在：

```
MODE   = None
PATH   = /home/awinx/.local/bin:...
```

所以"同一个世界，只多一个变量"的写法是 `env={**os.environ, "MODE": "staging"}`。而 `PATH` 是一个真实的攻击面：如果 `PATH` 可被攻击者控制，`subprocess.run(["git", ...])` 执行的就是攻击者的 `git`。对高权限调用方请使用绝对路径，或者把 `PATH` 重置为已知安全的前缀。

## 真实场景里的样子

一个具体的辅助函数。一个不可信的 ref 从 webhook 进来，必须送到 `git`。列表形态让这个不可信的值成为一条 `argv` 记录，然后由 `git` 自己拒绝它并记入日志。

```python
def show_file(ref: str) -> str:
    r = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref],
        cwd=repo, capture_output=True, text=True, timeout=10,
    )
    if r.returncode != 0:
        return f"error: {r.stderr.strip()}"
    return r.stdout.strip()
```

当 `ref = "main; echo INJECTED-VIA-SHELL"` 时：

```
1) safe: list form, untrusted ref
error: fatal: Not a valid object name main; echo INJECTED-VIA-SHELL
2) safe: list form, clean ref
notes.md
3) naive: shell=True with the same untrusted ref
fatal: Not a valid object name main
INJECTED-VIA-SHELL
4) lazy fix: shell=True + shlex.quote
stderr: fatal: Not a valid object name main; echo INJECTED-VIA-SHELL
```

同一个敌意字符串的三种处理方式，只有一种执行了载荷。另外注意这个分层的结果：即便是*安全*路径，也是让 `git` 来告诉你 ref 无效——校验发生在拥有语义的那个工具里，而不是在你的引号代码里。

## `subprocess` 对比 `os.system`，也对比库

`os.system` 永远走 shell，而且只返回退出状态——你无法捕获输出，也无法传列表。`os.popen` 同样永远拉起一个 shell，然后返回一个文件对象。两者都只是 `/bin/sh` 的薄封装，都让注入面永久敞开。如果在评审里看到它们，换掉。

```python
import os
os.system("echo os.system-said-hello")        # 只有返回码
with os.popen("echo os.popen-said-hello") as p:
    p.read()                                  # 永远是 shell
```

还有更老一些的 `Popen` 接口。它没问题，但 `run` 只是它的薄封装，95% 的代码写成 `run` 会更清楚。只有当你需要流式、交互或非阻塞读取时才伸手去拿 `Popen`。

而更资深一点的问题是：**到底该不该 shell out？** 如果某个库能做这件事，就用库。用正则解析 `git log` 比用 Git 库更糟；用正则解析 `ffprobe` 输出比用媒体探针更糟；shell 出去跑 `ls` 再字符串切分结果，比 `os.scandir` 更糟。原生 Python 在 Windows 上也能跑、抛的是结构化异常，而且根本不会注入任何东西。把 `subprocess` 留给那些没有等价库的 CLI 工具。

关于解析输出还有一点：如果你命令的输出有点像 shell 文本，请记住 [bash 自己有它的一套坑](/zh/posts/bash-strict-mode/)——花一个下午审计一下 Python 周围的工具链是值得的。而如果子进程在长时间运行中内存持续增长，[tracemalloc 工作流](/zh/posts/python-memory-leaks/) 解释了我是怎么不靠猜就找到它的。

## 检查清单

- [ ] 命令以**列表**传入；`shell=True` 只出现在 shell 确实必需的地方。
- [ ] 不可信输入作为单条 `argv` 记录抵达命令——绝不插值进字符串。
- [ ] 当 shell 绕不开时，每个插值片段都经过 `shlex.quote`。
- [ ] 任何失败要紧的命令都加 `check=True`（或显式检查 `returncode`）。
- [ ] 需要消费输出时用 `capture_output=True` 加 `text=True`；读走，不要留在管道里阻塞。
- [ ] `timeout=` 既要诚实到够用，也要短到有意义。
- [ ] `cwd` 与 `env` 显式指定；`PATH` 绝不从不可信调用方继承。
- [ ] 安全敏感的调用方使用二进制文件的绝对路径。
- [ ] 不用 `os.system`、不用 `os.popen`、不用不带列表的 `os.exec*`。
- [ ] 考虑过库方案，并把不用它的理由写下来。

## 授权使用说明

上面的一切都运行在我自己的一个临时目录里，注入载荷只打印了一行——它没有删除、写入或传输任何东西。读这篇文章是为了保护你有权测试的系统，至于那个破坏版的载荷，请把它留在脑子里，而不是留在别人的仓库里。
