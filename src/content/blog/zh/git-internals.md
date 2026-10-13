---
title: "Git 内部原理：对象、引用与 packfile（git 是个小型数据库）"
description: "动手拆解 Git 内部原理：blob、tree、commit 与 tag 组成一个内容寻址的对象库，引用与 HEAD 只是指向提交的文件，再看 git gc 如何把松散对象打包。附带真实的 git cat-file、ls-tree、verify-pack 输出。"
pubDate: 2027-01-19
lang: zh
translationKey: git-internals
tags: [devops]
featured: false
keywords:
  - Git 内部原理
  - git 对象
  - blob tree commit
  - packfiles
  - git cat-file
---

大多数时候，git 给人的感觉就是一个"带撤销按钮"的文本文件夹。但在这层友好的界面之下，**Git 内部原理**远比它的命令集更简单、也更优雅：它是一个内容寻址的键值存储。你提交、切分支、回滚的一切，归根到底只是四种 **git 对象** 之一——**blob tree commit**（外加 tag）——每一种都以自身内容的 SHA-1 作为地址存放。像 `HEAD`、`refs/heads/main` 这样的**引用**不过是保存了一个哈希值的文件，而随着时间推移，**packfile** 会把整张图压缩落盘。这篇文章里，我会用真实的 `git cat-file` 输出掀开引擎盖，证明 git 确实就是一个小型数据库。

下面所有内容都来自我用 git 2.56.0 新建的一个仓库。没有花招，没有删改——这就是真实的输出。

## Git 内部原理：一个内容寻址存储里的四种对象

从初始化一个空仓库、看看 git 创建了什么开始：

```sh
$ git init demo
Initialized empty Git repository in .../demo/.git/
$ ls .git
config
description
HEAD
hooks
info
objects
refs
```

几乎所有有意思的东西都在 `.git/objects` 里。git 把 **git 对象**存放在那里，总共恰好四种：

- **blob**——文件的原始内容，没有名字、没有路径，只有字节。
- **tree**——一个目录清单，把名字（连同模式位）映射到一个 blob 或另一棵树。
- **commit**——指向一棵树的指针，再加上父提交、作者和提交信息。
- **tag**——一个指向其他对象的附注标签对象。

"内容寻址"是核心思想。你从不要求 git 保存"app.py 的第 3 版"；你把字节交给 git，git 回给你这些字节的 SHA-1，那个哈希**就是**地址。造一个 blob，看它出现：

```sh
$ echo 'print("hello")' > app.py
$ git hash-object -w app.py
11b15b1a4584b08fa423a57964bdbf018b0da0d5
$ git cat-file -t 11b15b1
blob
```

`-w` 才是真正把对象写进 `.git/objects` 的开关。没有它，`hash-object` 只打印哈希然后把字节丢掉。现在问 git 每个对象是什么类型，很明显它们是同一个存储里的平级成员：

```sh
$ git cat-file -t f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
commit
$ git cat-file -t 7298c20ec158c1e9064e11c7035956f883e41270
tree
$ git cat-file -t 6844eb30b360b3756885d1ad0cfc2a8f32c876bc
tag
```

因为地址由内容推导而来，仓库里——乃至地球上——两个完全相同的文件会产生同一个 blob，只存一份。这就是 git 内建的去重，而且是哈希带来的免费赠品。

## blob、tree、commit 构成的对象图

正是这一块让"git 是个数据库"豁然开朗。提交 `app.py`、`src/util.py` 和 `README.md` 之后，根目录的 tree 长这样：

```sh
$ git ls-tree HEAD
100644 blob 03d17bd48c75430987a9b01b9b296f20d50ec6d8	README.md
100644 blob b9f2c3c96ec0e97ab1791c1625d124218ab38fba	app.py
040000 tree 42ee7f3c96dc32b419752107861a6d3bf3842216	src
```

仔细读。tree 就是一张 `模式 类型 SHA 名字` 的扁平表。`100644` 是普通文件，`040000` 是子目录，它指向的是另一棵**树**对象（`42ee7f3c…`），而不是 blob。所以 `src/` 是递归的：

```sh
$ git ls-tree HEAD src/
100644 blob 312b477d18e86322d223001d940fc5a0b3758fc0	src/util.py
```

而一个 commit 只是一个指向顶层树及其父提交的短文本文件：

```sh
$ git cat-file -p HEAD
tree 7298c20ec158c1e9064e11c7035956f883e41270
parent 5db046419edc9c7477c9e50d9983f3be14ac36c9
author DeepSeek <deepseek@awin-x.top> 1767664800 +0800
committer DeepSeek <deepseek@awin-x.top> 1767664800 +0800

Update app and util
```

把整张图拼起来，它朴素得惊人——一条 **blob tree commit** 链：commit 指向 tree，tree 指向 blob 和 subtree，而 commit 又指回它的父提交：

<figure>
<svg viewBox="0 0 660 232" width="100%" role="img" aria-labelledby="gi-t gi-d" style="max-width:660px;height:auto;font-family:ui-monospace,monospace">
  <title id="gi-t">一个 commit 指向根 tree，根 tree 再指向若干 blob 与 subtree</title>
  <desc id="gi-d">提交 f5ef823 指向根树 7298c20。该树列出 app.py blob b9f2c3c、README blob 03d17bd，以及 src 树 42ee7f3c，后者又列出 util.py blob 312b477。</desc>
  <defs>
    <marker id="gi-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"></path>
    </marker>
  </defs>
  <!-- commit -->
  <rect x="16" y="88" width="140" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="30" y="110" font-size="12" fill="#0f766e">commit</text>
  <text x="30" y="126" font-size="12" fill="currentColor">f5ef823</text>
  <!-- root tree -->
  <rect x="216" y="88" width="150" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="230" y="110" font-size="12" fill="#0f766e">tree (root)</text>
  <text x="230" y="126" font-size="12" fill="currentColor">7298c20</text>
  <!-- connectors -->
  <line x1="156" y1="112" x2="210" y2="112" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></line>
  <path d="M366,112 L452,46" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <line x1="366" y1="112" x2="446" y2="98" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></line>
  <path d="M366,112 L452,150" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <!-- app.py blob -->
  <rect x="452" y="24" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="42" font-size="10" fill="#0f766e">100644 blob</text>
  <text x="464" y="58" font-size="11" fill="currentColor">app.py → b9f2c3c</text>
  <!-- README blob -->
  <rect x="452" y="76" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="94" font-size="10" fill="#0f766e">100644 blob</text>
  <text x="464" y="110" font-size="11" fill="currentColor">README.md → 03d17bd</text>
  <!-- src tree -->
  <rect x="452" y="128" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="146" font-size="10" fill="#0f766e">040000 tree</text>
  <text x="464" y="162" font-size="11" fill="currentColor">src → 42ee7f3c</text>
  <!-- util.py blob -->
  <path d="M550,172 L550,182" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <rect x="452" y="184" width="196" height="36" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="206" font-size="11" fill="currentColor">util.py → 312b477</text>
</svg>
<figcaption>一个 commit 指向一棵根 tree；tree 指向 blob（文件）与 subtree（目录）。每一条箭头都是一个按内容哈希存储的硬链接。</figcaption>
</figure>

这就是 git 历史"可证伪篡改"的原因。改动 `app.py` 的一个字节，blob 就换一个新的 SHA——这会改变 tree，因为 tree 现在命名的是不同的哈希——于是 commit 也跟着变。commit 的 SHA 由它自身内容算出，其中就包括那个 tree 指针，所以它同样会变，而其后每个子孙提交都指向一个已经不同的父提交。你不可能悄悄改写历史中间的文件而不改变它之后所有东西的 SHA。这条哈希链正是让人津津乐道的完整性保障，而且它并不是外加的特殊功能——它是"用内容地址寻址对象"的自然结果。

还要注意：tree 是不可变且共享的。如果 `README.md` 在两个提交间没变，那两棵根 tree 列的都是*同一个* blob `03d17bd`。git 只存一份 blob，两棵树引用它。任何东西都不会被就地修改；新提交指向新对象，旧对象原封不动地留着，直到垃圾回收来清理它们。

## 引用与 HEAD：分支只是带 SHA 的文件

如果说对象构成数据库，那么**引用**就是指针，而分支实际上就是一个写着 40 个十六进制字符的文件。直接从 `.git` 里看：

```sh
$ cat .git/HEAD
ref: refs/heads/main
$ cat .git/refs/heads/main
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ git rev-parse HEAD
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
```

`HEAD` 通常含有一个符号引用（`ref: refs/heads/main`），意思是"当前 `main` 指向的那个提交"。分支不是提交的容器；它是一张写着单个 SHA 的便利贴。这就是全部心智模型。附注标签也是一个引用，但它解析到一个 tag *对象*，而不是直接到提交：

```sh
$ git cat-file -p v1.0
object f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
type commit
tag v1.0
tagger DeepSeek <deepseek@awin-x.top> 1767747600 +0800

Release 1.0
```

有个细节：在打包过的仓库里，你可能根本找不到 `.git/refs/heads/main`。git 可以把松散引用合并进单个文件，避免"每个分支一个文件"的膨胀：

```sh
$ cat .git/packed-refs
# pack-refs with: peeled fully-peeled sorted
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc refs/heads/main
```

同一个道理，只是换了个架子：分支依然只是一个把名字映射到哈希的文件。

## git log 与 git diff 如何从对象图中自然导出

一旦对象是图、引用是指针，`log` 和 `diff` 就不再是特殊机制——它们只是遍历。`git log` 从 `HEAD` 解析出的提交开始，打印它，顺着 `parent` 指针走到父提交，打印，如此往复，别无其他：

```sh
$ git log --oneline
f5ef823 Update app and util
5db0464 Add app and util
```

两个提交之间的 `git diff` 只是加载各自的 tree，并行遍历两棵树，报告 blob 哈希在哪里分叉。因为内容是哈希化的，比较文件的两个版本就是比较哈希——哈希不同才需要逐字节 diff，而且 tree 只会重新 diff 真正变化的路径：

```sh
$ git diff 5db0464 HEAD
diff --git a/app.py b/app.py
index 11b15b1..b9f2c3c 100644
--- a/app.py
+++ b/app.py
@@ -1 +1,2 @@
-print("hello")
+print("hello v2")
+print("second line")
diff --git a/src/util.py b/src/util.py
index 4693ad3..312b477 100644
--- a/src/util.py
+++ b/src/util.py
@@ -1,2 +1,2 @@
-def add(a, b):
-    return a + b
+def sub(a, b):
+    return a - b
```

看到 `index 11b15b1..b9f2c3c` 那行了吗？那就是两个 blob 的哈希。`README.md` 不在其中，因为它在两棵树里的 blob 完全相同，git 干脆跳过对它的比较。你读到的统一 diff 只是表现层；关于*该展示什么*的决定，早就通过比较 tree 里的哈希做出了。

## 松散对象 vs packfile，以及 git gc 做了什么

新写入的对象是**松散的**：每个都是 `.git/objects/` 下一个小的 zlib 压缩文件，一个对象一个文件，以哈希命名。这又快又安全，但对大型历史很浪费。打包之前先数一下对象：

```sh
$ git count-objects -v
count: 11
size: 44
in-pack: 0
packs: 0
size-pack: 0
```

十一个独立的松散对象。跑一下垃圾回收，它们就坍缩成一个 **packfile**：

```sh
$ git gc
$ git count-objects -v
count: 0
size: 0
in-pack: 11
packs: 1
size-pack: 2
```

松散对象归零，十一个打包进一个文件，磁盘占用从 44 KiB 掉到 2 KiB。`.pack` 文件把对象存成一个有序流，彼此之间做 delta 压缩——所以 `app.py` 在两版之间那点小改动不会把整个文件存两遍，只存差异。看看真实的包：

```sh
$ git verify-pack -v .git/objects/pack/*.pack
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc commit 228 157 12
5db046419edc9c7477c9e50d9983f3be14ac36c9 commit 177 124 169
03d17bd48c75430987a9b01b9b296f20d50ec6d8 blob   32 35 293
b9f2c3c96ec0e97ab1791c1625d124218ab38fba blob   39 45 328
312b477d18e86322d223001d940fc5a0b3758fc0 blob   32 42 373
7298c20ec158c1e9064e11c7035956f883e41270 tree   101 110 415
...
non delta: 11 objects
.git/objects/pack/pack-eed3fc9e8a33ebbd0b5eb63284fb47393ab5ef25.pack: ok
```

每一行是 `<sha> <类型> <大小> <打包后大小> <偏移>`。伴随的 `.idx` 文件让 git 能按 SHA 在包里二分查找，所以随机访问依然很快。注意 `git gc` 其实也跑了 `pack-refs`，这就是上一节里松散的 `.git/refs/heads/main` 为何消失、跑进了 `packed-refs`。松散还是打包纯粹是存储优化；对象图在两种形态下一模一样。

## 这些原理如何解释日常的 git

几乎每一个让人觉得"神奇"的 git 操作，都只是在这个存储里挪动一个指针。

**`git reset` 移动一个引用。** `reset --hard HEAD~1` 并不删除最新提交；它把 `.git/refs/heads/main` 改写为指向早一个提交，并更新工作区以匹配。旧提交和它独有的 blob 依然在对象库里——这正是 `reset` 很轻、`git reflog` 还能找回它的原因：

```sh
$ cat .git/refs/heads/main           # before
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ git reset --hard HEAD~1
$ cat .git/refs/heads/main           # after
5db046419edc9c7477c9e50d9983f3be14ac36c9
$ git cat-file -t f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
commit                              # 还在，只是不再被引用
```

**rebase 会重写提交。** rebase 创建一批全新的 commit 对象，带有新的父指针，再把你的分支重新指向新的顶端。旧提交不是被编辑——它们被弃用了，因为 commit 的 SHA 由父提交的 SHA 推导，换到不同的基底上重放，不可避免地会产生新哈希。这也正是你不该对已推送的历史做 rebase 的原因：你和协作者会为"同一批"改动各自拥有两套不同的提交对象。

**分离头指针不过是一个指向提交的引用。** 当你检出一个原始 SHA，git 直接把该 SHA 写进 `.git/HEAD`，而不是写 `ref: refs/heads/…`：

```sh
$ git checkout f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ cat .git/HEAD
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
```

此时此刻 `HEAD` 不再是符号引用，新提交找不到可以更新的分支，于是再切到别的分支时它们就成了"分离"状态（只能靠 reflog 找回）。这就是一个文件里的一行字而已，整个现象不过如此。

下次某个 git 操作让你意外时，别去背什么咒语——先问：它创建了什么对象、移动了哪个引用。这几乎总能得到答案，因为在底层 git 并不是"带数据模型的版本控制系统"，而是一个小巧的、内容寻址的数据库，外面恰好包了几个友好的命令。

如果你喜欢把玩这些真实的对象转储，我关于翻阅 git 历史的走查——[Git 考古](/zh/posts/git-archaeology/)——是自然的下一篇；而关于不带仪式感的日常单人工作流，见 [写给独立开发者的 git](/zh/posts/git-for-solo-developers/)。
