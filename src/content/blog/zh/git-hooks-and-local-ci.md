---
title: "Git Hooks：你可以纳入版本控制的本地 CI"
description: "Git hooks 是在 git 生命周期关键节点自动执行的脚本。本文介绍 pre-commit、commit-msg 和 pre-push hook 的用法，core.hooksPath 如何解决克隆问题，以及服务端 hook 如何执行客户端 hook 无法强制的规则。"
pubDate: 2027-02-02
lang: zh
translationKey: git-hooks-and-local-ci
tags: [devops]
featured: false
keywords: [git hooks, pre-commit hook, core.hooksPath, commit-msg, pre-push]
---

Git hooks 是大多数开发者从未接触过的内置扩展机制——这是个遗憾。它们是你会运行的最廉价的 CI：在 git 工作流的精确时刻自动执行的脚本，在代码推送到远程之前就把关。本文我会逐一讲解真正有用的 hook，展示每个的真实输出，并解释如何用 `core.hooksPath` 让它们进入版本控制，使整个团队共享同一套守卫。

假设你已经熟悉基本的 git 操作。如果你想了解 git 的内部原理或单人开发工作流，我另有文章：[单人开发者的 git](/zh/posts/git-for-solo-developers/) 和 [git 内部原理](/zh/posts/git-internals/)。

## Hooks 到底是什么

Git hook 就是一个脚本——任何可执行文件——git 会在提交、推送或检出生命周期的特定节点自动运行它。Git 自带一组默认 hook 名称（都以 `.sample` 结尾）。当你把 sample 改名去掉 `.sample` 后缀并赋予执行权限时，git 就会开始运行它。

大多数人关心的客户端 hook 有：

- `pre-commit` — 在提交创建之前运行。非零退出码中止提交。
- `commit-msg` — 在消息编辑器关闭后、提交最终确定之前运行。非零退出码拒绝该消息。
- `pre-push` — 在向远程推送之前运行。非零退出码阻止推送。
- `post-checkout` — 在检出之后运行。适合重新生成文件或设置分支状态。

服务端 hook（在裸仓库上）：

- `pre-receive` — 在服务端任何引用更新之前运行一次。
- `update` — 对每个被更新的引用各运行一次。

下图展示了每个 hook 的触发位置：

<figure>
<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Git 生命周期 hook 节点">
  <!-- Timeline -->
  <line x1="40" y1="110" x2="680" y2="110" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <!-- Nodes -->
  <circle cx="80" cy="110" r="8" fill="#0f766e"/>
  <text x="80" y="145" text-anchor="middle" font-size="12" fill="currentColor">编辑</text>

  <circle cx="180" cy="110" r="8" fill="#0f766e"/>
  <text x="180" y="145" text-anchor="middle" font-size="12" fill="currentColor">git add</text>

  <circle cx="280" cy="110" r="10" fill="#0f766e"/>
  <text x="280" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-commit</text>
  <text x="280" y="145" text-anchor="middle" font-size="12" fill="currentColor">git commit</text>

  <circle cx="380" cy="110" r="10" fill="#0f766e"/>
  <text x="380" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">commit-msg</text>
  <text x="380" y="145" text-anchor="middle" font-size="12" fill="currentColor">消息</text>

  <circle cx="480" cy="110" r="10" fill="#0f766e"/>
  <text x="480" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-push</text>
  <text x="480" y="145" text-anchor="middle" font-size="12" fill="currentColor">git push</text>

  <circle cx="600" cy="110" r="10" fill="#0f766e"/>
  <text x="600" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-receive</text>
  <text x="600" y="145" text-anchor="middle" font-size="12" fill="currentColor">裸仓库</text>
</svg>
<figcaption>Git 生命周期中的 hook 节点。客户端 hook（pre-commit、commit-msg、pre-push）在你的机器上运行；服务端 hook（pre-receive）在远程运行。</figcaption>
</figure>

## 一个真正能阻止提交的 pre-commit hook

最常见的用法：拒绝不符合标准的提交。下面是一个最小的 `pre-commit`，扫描暂存文件中的 `TODO` 标记，发现就拒绝提交：

```sh
#!/bin/sh
# .git/hooks/pre-commit
if git diff --cached --name-only | xargs grep -n "TODO" 2>/dev/null; then
  echo "ERROR: TODO found in staged files. Remove it before committing." >&2
  exit 1
fi
```

我在一个临时仓库中测试了它。我暂存了一个包含 `# TODO: fix this` 的文件然后尝试提交：

```console
$ git commit -m "add bad file"
1:# TODO: fix this
ERROR: TODO found in staged files. Remove it before committing.
$ echo $?
1
$ git log --oneline
16fc42f initial commit
$ git status --short
A  bad.py
```

注意三点：hook 打印了违规行、以退出码 `1` 退出、**提交没有被创建**——`git log` 仍只有初始提交，文件仍在暂存区。这就是核心机制：非零退出码中止操作。

## commit-msg：强制消息格式

`commit-msg` 接收一个包含提交消息的临时文件路径作为参数。如果它非零退出，提交被中止。团队可以用它强制 [Conventional Commits](https://www.conventionalcommits.org/) 或任何格式：

```sh
#!/bin/sh
# .git/hooks/commit-msg
commit_msg_file="$1"
commit_msg=$(cat "$commit_msg_file")
pattern='^(feat|fix|docs|style|refactor|test|chore)(\([a-z-]+\))?: .+'
if ! echo "$commit_msg" | grep -qE "$pattern"; then
  echo "ERROR: Commit message does not follow Conventional Commits format." >&2
  echo "Expected: type(scope): subject  (e.g. feat(auth): add login)" >&2
  echo "Got: $commit_msg" >&2
  exit 1
fi
```

同仓库中一个被拒绝的消息和一个被接受的消息：

```console
$ git commit -m "just some random message"
ERROR: Commit message does not follow Conventional Commits format.
Expected: type(scope): subject  (e.g. feat(auth): add login)
Got: just some random message
$ echo $?
1

$ git commit -m "feat(core): add new feature module"
[master 651ab1b] feat(core): add new feature module
 1 file changed, 1 insertion(+)
 create mode 100644 feature.txt
$ echo $?
0
```

## pre-push：推送前运行快速测试

`pre-push` 在向远程发送任何对象之前运行。它适合放置快速冒烟测试——几秒钟内能跑完的，不是几分钟。下面是一个推送前运行 Python 语法检查的示例：

```sh
#!/bin/sh
# .git/hooks/pre-push
echo "Running pre-push tests..."
for f in $(git diff --name-only HEAD~1 HEAD 2>/dev/null | grep '\.py$'); do
  python3 -m py_compile "$f" 2>/dev/null || {
    echo "ERROR: Python syntax error in $f" >&2
    exit 1
  }
done
echo "All tests passed."
```

我提交了一个含语法错误的文件并推送到一个临时裸仓库：

```console
$ git push origin master
Running pre-push tests...
ERROR: Python syntax error in broken.py
错误：无法推送一些引用到 '../bare-repo.git'
$ echo $?
1
```

推送在代码离开机器之前被阻止了。注意中文错误信息——我的 git 的 `LC_MESSAGES` 设为 `zh_CN.UTF-8`，所以 git 自己本地化了"无法推送"的消息。关键是 hook 的英文错误信息。

## 克隆问题——以及 core.hooksPath 解决方案

客户端 hook 有个陷阱：**它们存储在 `.git/hooks/` 中，这个目录不被 git 跟踪，也不会被克隆。** 当同事克隆你的仓库时，他们得不到你的任何 hooks。每个开发者必须手动安装，漂移不可避免。

解决方案是把 hooks 放在仓库内被跟踪的目录（习惯上用 `.githooks/`），然后用 `core.hooksPath` 指向它：

```sh
$ git config core.hooksPath .githooks
$ git config core.hooksPath
.githooks
```

现在我可以把 `.githooks/` 提交到仓库中。克隆后 `.githooks/` 目录是存在的，但在你执行那条 config 命令之前是**未激活**的：

```console
$ git clone bare-repo.git fresh-clone
$ cd fresh-clone
$ ls .githooks/
pre-commit
$ git config --get core.hooksPath
(exit: 1 — not set)
```

所以新同事的工作流是：克隆，然后执行一次 `git config core.hooksPath .githooks`。之后 hooks 就像在你机器上一样运行。我端到端验证了这一点——设置配置后，包含 `FIXME` 标记的提交被拒绝了：

```console
$ git config core.hooksPath .githooks
$ echo "# FIXME test2" > test-fixme2.txt
$ git add test-fixme2.txt
$ git commit -m "feat: test hook after config"
[.githooks/pre-commit] Running versioned pre-commit hook...
test-fixme2.txt
ERROR: FIXME marker found. Clean up before committing.
$ echo $?
1
```

## --no-verify：合法的绕过方式

每个 hook 都可以用 `git commit --no-verify`（或 `-n`）跳过。滥用它是危险的，但有时你*确实需要*提交一个 WIP、合并冲突解决方案或临时调试标志。关键是 `--no-verify` 是显式且可见于 reflog 的——不是静默的失败模式。

```console
$ git commit --no-verify -m "feat: add hack file"
[master da1df6c] feat: add hack file
 1 file changed, 1 insertion(+)
 create mode 100644 hack.txt
$ echo $?
0
```

我的经验法则：`--no-verify` 用于本地 WIP 提交（之后会 squash）是可以的，但绝不要用它推送到共享分支。如果你经常需要 `--no-verify`，说明你的 hooks 太严格或太慢了。

## 服务端 hook：真正的执行点

客户端 hook 只是建议。任何人都能用 `--no-verify` 绕过，而且在配置之前它们不存在。**裸仓库上的服务端 hook 才是真正的执行点**——它们在服务端运行，不受任何客户端行为影响。

下面是一个裸仓库的 `pre-receive` hook，拒绝包含超过 1 MB 文件的推送：

```sh
#!/bin/sh
# hooks/pre-receive in the bare repo
while read oldrev newrev refname; do
  if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
  if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
    files=$(git ls-tree -r --name-only "$newrev")
  else
    files=$(git diff --name-only "$oldrev" "$newrev")
  fi
  for file in $files; do
    size=$(git cat-file -s "$newrev:$file" 2>/dev/null || echo 0)
    if [ "$size" -gt 1048576 ]; then
      echo "ERROR: '$file' is $size bytes (max 1MB). Push rejected." >&2
      exit 1
    fi
  done
done
```

我提交了一个 3 MB 的文件并尝试推送：

```console
$ git push origin master
remote: ERROR: 'huge.bin' is 3145728 bytes (max 1MB). Push rejected.
To ../bare-repo.git
 ! [remote rejected] master -> master (pre-receive hook declined)
错误：无法推送一些引用到 '../bare-repo.git'
$ echo $?
1
$ git ls-remote origin
b5d969af5a170aa1a4f5e2dcf0f84291b55a2010	HEAD
b5d969af5a170aa1a4f5e2dcf0f84291b55a2010	refs/heads/master
```

`remote:` 前缀表示错误来自服务端而非本地 hook。远程仍指向旧引用——什么都没更新。`update` 类似但对每个引用各运行一次，这在单次推送更新多个分支时有区别。

## 与完整 CI 的关系

Hooks 和 CI 不是竞争对手——它们是不同层次。**pre-commit hook** 在 1 秒内运行，捕捉明显的遗留：调试标记、语法错误、格式违规。**pre-push hook** 运行单元测试套件——仍在本地，仍较快，但更重。远程 **CI 流水线** 是最终权威：它对每个分支的每次推送运行、无法用 `--no-verify` 绕过、能访问 secrets 和干净环境。

实际分工：

- **Hooks**：快速反馈，在错误离开机器之前捕捉。守护常见情况。
- **CI**：权威、运行所有测试、与代码评审集成。在这里执行 hooks 不能或不应该执行的内容。

单人开发者可能止步于 hooks——一个编写良好的运行测试套件的 `pre-push` 通常就够了。团队在此基础上加 CI，这样无论本地 hook 如何配置，没有人能在构建不通过的情况下合并代码。

## 单人开发者的最小化设置

如果你想一个人工作，想要版本控制的 hooks 又不想搞复杂，这是我的起步方案：

1. **创建 `.githooks/` 目录**放在仓库里，把 hooks 放进去。
2. **设置 `core.hooksPath`**，每个克隆执行一次：`git config core.hooksPath .githooks`。
3. **编写 `pre-commit`** 运行 linter 或 formatter。控制在 2 秒内。
4. **编写 `commit-msg`** 强制你的消息格式。即使宽松的正则也比没有格式强。
5. **编写 `pre-push`** 运行测试套件。这是代码推送到远程之前的最后一道防线。

就这样。没有依赖、没有 `npm install`、没有框架。只是 git 已经知道如何共享的目录中的 shell 脚本。整个设置大概 30 行 shell，它把 git 从哑文件跟踪器变成一个自动执行你标准的开发工作流。

Git hooks 的美妙之处在于它们已经在那里了——已安装、有文档、在等待。唯一的问题是你是否使用它们。
