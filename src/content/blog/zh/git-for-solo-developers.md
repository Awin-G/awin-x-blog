---
title: "单人开发者的 Git 工作流：你不需要 Git Flow"
description: "Git Flow 和重 PR 的流程是为了协调团队而存在的。如果你就是唯一的提交者，它们全是纯开销。这是我实际在用的 git workflow：以 main 为主干、短生命周期分支甚至直接提交、用 tag 发布、严格的提交习惯、几个 pre-commit 钩子，以及用 bisect 和 reflog 做安全网。"
pubDate: 2026-11-08
lang: zh
translationKey: git-for-solo-developers
tags: [devops, linux]
featured: false
keywords:
  - git workflow
  - 单人开发者
  - git 分支策略
  - pre-commit
  - bisect
---

每一篇讲分支模型的教程都以同一张图开头：`develop`、`feature/*`、`release/*`、
`hotfix/*`，箭头到处飞。那张图是为了解决一个我没有的问题而画的。作为单人开发者，
我的 git workflow 不过是十条左右的习惯加几个钩子——没有发布列车，没有强制 PR，
也没有哪个分支能活过一下午。下面就是我在用的版本，以及为什么在你就是整个团队时，
那些面向团队的建议几乎全是仪式感。

## 为什么团队分支模型对一个人来说是纯开销

Git Flow 不是软件定律，它是一套协作协议。里面每个分支的存在，都是为了处理*人与人
之间某个具体的冲突*：

- `develop` 存在，是因为发布列车需要让 `main` 保持稳定，而没做完的活儿得在别处堆积。
- `feature/*` 分支存在，是为了让两个人能并行改同一批文件。
- `hotfix/*` 存在，是因为修紧急问题的人，并不是拥有发布分支的人。
- PR 存在，是为了强行让另一双眼睛看一遍改动，并给这次合并留下记录。

当提交者只有一个时，这些冲突一个都不存在。但你保留了它们的成本：忘了删的陈年分支、
毫无意义的「把 release 合并进 develop」提交、因为把自己的工作拆成三条长期分支而
凭空造出的冲突，以及一个严格大于仓库本身的心智模型。一个你自己开、又自己合的 PR，
无非是带上了延迟、一次网络往返和一个绿色按钮的 `git commit`。

如果某个流程增加了一步，那这一步就必须换来点什么。对一个人来说，它通常什么都换不来。

## 我实际在用的 git 分支策略

我的整套策略就四条规则：

1. **`main` 就是主干，永远处于可发布状态。** `main` 上的任何内容都应能在任意时刻
   部署。这个博客每次推送到 `main` 就自动发布，所以这条规则是自我强制的——参见
   [这个博客如何发布它自己](/zh/posts/how-this-blog-ships-itself/)。
2. **小改动直接进 `main`。** 改个错字、升级个依赖、调个配置：提交、推送。这时候
   开分支纯属自找麻烦。
3. **任何可能要花一小时以上、或者可能中途放弃的事，才开一条短生命周期分支。** 分支
   是草稿纸，不是流程里的一个阶段。它唯一的作用，就是把没做完的活儿挡在 `main`
   之外，直到它做完。
4. **发布是 tag，不是分支。** 我从不留一条 `release-1.x` 分支苟活。交付物就是那个
   附注 tag。

就这些。日常循环长这样：

```bash
# 80% 的情况：直接在 main 上干。
git switch main
git pull --ff-only
$EDITOR some/file
git add -p                      # 只暂存属于这次提交的内容
git commit -m "clamp retry backoff to 30s"
git push

# 20% 的情况：一个可能活不过来的实验。
git switch -c try/new-parser
# ... 干活，边走边提交 ...
git switch main
git merge --ff-only try/new-parser   # 只有在能保持直线历史时才这么做
git branch -d try/new-parser
```

打一个发布就一条命令，而且 tag 里带着说明，`git describe` 和 `git log` 都还能用：

```bash
git tag -a v1.4.0 -m "esptool support, fix captive-portal detection"
git push origin v1.4.0
git describe --tags            # -> v1.4.0-3-gabc1234
```

如果我需要给旧版本打补丁，就*从 tag 切分支*，修好，再打一个 tag。没有常驻的
`hotfix` 分支，也不需要往任何地方合并回去。

## 提交习惯：历史就是你的更新日志

没有队友可问的时候，git log 就是「代码为什么长成这样」唯一的文档。我因此认真对待它。

- **一次提交只做一件事。** 如果一句话说不清这次提交，还得用「并且」，那它就是两次
  提交。`git add -p` 的存在，正是为了让你能暂存一个文件的一部分。
- **祈使句主语，约 50 字符以内。** 「fix: reject zero-length reads」，而不是
  「fixed some stuff」。
- **正文解释为什么，而不是做了什么。**

这差别不是装饰性的。十八个月后你盯着 `git blame` 时，提交信息是你仅剩的上下文：

```text
# 差——说的都是你在 diff 里本来就能看到的东西：
wip
fix bug
more changes

# 好——正文承载了代码里没有的推理：
reject responses whose Content-Length is zero

The CDN returns 200 with an empty body during a purge. We treated that as
a valid empty document and cached deleted content. Treating a zero-length
body as a retryable error fixes it.
```

推送前清理本地历史可以随意重写——那是*你自己的*历史，没人拥有它：

```bash
git commit --amend                 # 改掉上一条信息或内容
git rebase -i HEAD~5               # 压缩、改词、调序、丢弃
git config --global rebase.autosquash true
git commit --fixup <sha>           # 再用 rebase -i --autosquash 折叠进去
```

## 值得拥有的 pre-commit 钩子

钩子是一条由机器而不是由你的记忆来执行的规则，这正是折腾它的全部理由。你不需要一
大堆，三个就够本：

1. **跑测试和 linter。** 每次提交都跑快的那些，这样坏代码永远到不了 `main`。慢的
   测试套件留给 CI。
2. **一个内容 / 格式检查。** 在这个博客里，就是校验每个 Markdown 文件能被解析、
   且 frontmatter 含有 schema 要求的字段。换到别的仓库，就是 `gofmt -l` 或检查
   行尾空格。格式漂移是最慢的一种腐烂。
3. **密钥扫描。** 唯一一个你不能省的钩子。一个泄漏的密钥一旦被推送，就是一次轮换
   事故；而且一旦公开，「删掉那次提交」并不能撤销它。

[`pre-commit`](https://pre-commit.com) 框架把这三样接进一个放在仓库里的配置文件：

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-yaml
      - id: end-of-file-fixer
      - id: trailing-whitespace
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
  - repo: local
    hooks:
      - id: tests
        name: fast tests
        entry: make test-fast
        language: system
        pass_filenames: false
```

```bash
pip install pre-commit
pre-commit install          # 写入 .git/hooks/pre-commit
pre-commit run --all-files  # 对整个仓库跑一次
```

两个注意事项。钩子活在你的工作副本里，所以 `git commit --no-verify` 就能绕过它，
而且新克隆的仓库在跑 `pre-commit install` 之前一个钩子都没有——永远不要把钩子当成
闸门。在 CI 里也跑同样的检查，让钩子只是那道闸门的本地快速镜像，而不是闸门本身。

## 当你真的开始协作

一旦出现第二个提交者，分支就变得值得了——规则也随之改变：

- **feature 分支回来了**，因为现在两个人真的*会*同时碰同一个文件。切分支、推送、
  开 PR。
- **rebase 你自己的分支，永远别 rebase 别人的。** 想让一条过期的 feature 分支跟上
  进度，就把它 rebase 到 `main` 上，换来干净的线性历史。一旦分支是共享的、别人
  已经在上面继续干了，rebase 就会重写他们早就拉下来的提交——这时应该把 `main`
  合并进它。

```bash
# 本地、未共享的分支：用 rebase 换直线历史。
git switch feature/login
git fetch origin
git rebase origin/main
git push --force-with-lease     # 安全的 force：上游动过就拒绝

# 共享分支，或发布分支：合并，别 rebase。
git switch feature/login
git merge origin/main
```

- **保持 PR 小而单一。** 一个 900 行的 PR 得到的是橡皮图章，不是评审。一个 90 行的
  PR 才会被真正读一遍。
- **给 `main` 开分支保护。** 哪怕只有两个人，「谁都不许直接推 `main`」也是唯一一条
  值得留下的流程规则。

`--force-with-lease` 是大家最容易搞错的细节。裸的 `--force` 会毫不犹豫地覆盖队友的
推送；`--force-with-lease` 在你上次拉取之后远端动过时就会拒绝。每一次都用它。

## bisect 和 reflog：安全网

让单人工作流变得安全的这两条命令，恰恰是大家最后才学会的。

**`git bisect` 用二分查找定位引入 bug 的那次提交**——一千次提交变成大约十次测试。
写个脚本自动化它，然后放手让它跑：

```bash
git bisect start
git bisect bad                 # 当前 HEAD 是坏的
git bisect good v1.3.0         # 这个 tag 是好的
git bisect run ./scripts/repro.sh   # 退出码 0 = 好，非 0 = 坏
git bisect reset
```

`git bisect run` 会在脚本退出码翻转的那一刻跳出循环，报出有问题的那次提交，并清理
现场。一个你能信得过的复现脚本，就是全部投入。

**`git reflog` 是其他一切的撤销键。** reset、rebase、删分支都看似「永久」，直到你
想起 HEAD 一直在记录每一次移动：

```bash
git reflog                          # 找到你丢掉的那次提交
git switch -c rescue HEAD@{3}       # 切个分支回到它
git reset --hard HEAD@{1}           # 撤销你刚做出的那次 reset
```

我用它几秒钟内救回过一次搞砸的交互式 rebase，还有一次在错误目录里执行的
`reset --hard`。因为有 reflog，git 里几乎没有什么东西会真的丢失好几个星期——所以
尽管大胆实验、频繁推送。

## 几个配置上的小甜头

设一次，默认行为就不再跟你作对：

```bash
git config --global init.defaultBranch main
git config --global pull.rebase true        # pull = fetch + rebase，没有合并气泡
git config --global rebase.autosquash true
git config --global fetch.prune true        # 清掉远端已删除的分支
git config --global merge.conflictstyle zdiff3   # 显示共同祖先
git config --global rerere.enabled true     # 记住冲突的解决方式
git config --global diff.algorithm histogram
git config --global alias.lg "log --oneline --graph --decorate"
git config --global alias.amend "commit --amend --no-edit"
```

`merge.conflictstyle zdiff3` 值得单独一提：让冲突标记里显示出共同祖先，你就能看到
*每一方各自改了什么*，把猜谜变成一次决策。而 `rerere` 会在同一次 rebase 里同一个
冲突再次出现时，重放你已经做过的解决。

这些都不惊艳，而这正是重点。对单人开发者来说，最好的 git workflow 就是那种把你的
注意力花在代码上、同时在你搞错时留一条退路的工作流：一条 `main` 主干、用 tag 发布、
能读得懂的提交、两三个钩子，以及放在口袋里的 `bisect` 和 `reflog`。

支撑这个仓库的基础设施也是同一套思路——一台机器、几个单元、不用 docker——我把
它写在了[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)里。
