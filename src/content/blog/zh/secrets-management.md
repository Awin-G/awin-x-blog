---
title: "个人运维的 secrets management：sops age 与 systemd LoadCredential"
description: "写给一个人的 secrets management 实战：先厘清真正的威胁模型（误提交、日志、备份、笔记本失窃、agent/工具访问），再从 dotenv、受限权限文件、加密存储一路讲到 Vaultwarden/Bitwarden 这类管理器；一套 sops age 加 systemd LoadCredential 的具体做法；rotation 与 blast radius；以及怎样用 pre-commit 把密钥挡在 git 之外。"
pubDate: 2026-10-29
lang: zh
translationKey: secrets-management
tags: [security, self-hosting, devops]
featured: false
keywords:
  - secrets management
  - sops age
  - systemd LoadCredential
  - dotenv
  - 密钥轮换
---

几乎每一篇讲 **secrets management** 的文章，都从一张企业级密钥库的架构图开始：审批
流程、审计日志、权限矩阵。这些都不是我的问题。我跑一台 VPS、几个自建服务，以及一条
我本人是唯一 reviewer 的构建流水线。我真实的失败场景，从来不是某个国家级黑客组织窃取
我的数据库口令；而是凌晨一点我自己把 `.env` 提交上去，或者一个备份压缩包悄悄把私钥
带到了对象存储，又或者我随手丢给某个 AI agent 的仓库被它读走了所有能读到的 token。
下面是我真正据以防御的威胁模型，以及我用来缩小它的那几个档位——最后落在最重要的一条
胜利上：**一开始就别把它们提交上去**。

## 一个人运维真正的威胁模型

企业的「密钥泛滥」是成百上千个团队散落着成千上万个没人清点的密钥。我的恰好相反：密钥
没几个，人只有一个，而自动化却两头都碰。这几乎把威胁完全推向了失误，而不是恶意。

- **误提交。** 经典场景。一个 `.env`、一把 `id_ed25519`、一个 kubeconfig、一个「先
  塞进配置里测一下」的 token。一旦进了 git 历史，它就永远公开了——唯一的补救是
  轮换密钥，而且就算你在下一个 commit 里 `git rm` 掉文件，也必须轮换。历史不是密钥
  死去的地方。
- **日志。** 这一类更隐蔽也更咬人。一条失败的命令回显了它的参数、一句把 `os.environ`
  打印出来的 debug、一个把 `Authorization` 头写进日志的 HTTP 客户端、一个出错时把
  环境变量整段吐出来的 CI runner。密钥到达日志的频率远高于到达 git 的频率，而日志会
  被采集、被轮转进归档、被顺手 grep。
- **备份。** 你备份了 `/etc`、`/srv` 和家目录——里面顺手带上了 `.netrc`、`.pgpass`、
  `~/.aws` 和一个明文 `.env`。于是你加密的异地归档，强度只剩下它自身的口令，而它正
  好躺在它本该保护的那些密钥旁边。数据、配置、密钥要当作三样不同的东西分别备份，而且
  密钥那条路径必须显式加密。
- **笔记本失窃。** 你的工作机上放着部署密钥、SSH agent、浏览器会话、密钥库的解锁口令。
  全盘加密只是入场券；真正的问题是，一台失窃且已解锁的笔记本（或一个乐于 `sudo` 的
  恶意进程）在不做二次验证的前提下能够到多少东西。
- **agent 与工具的访问。** 这是新的那一条。一个带着你的环境变量运行的编码 agent 或
  shell 工具，会继承你导出的每一个密钥：它能读仓库就能读 `.env`，它能跑命令就能调用
  你 token 允许的任何 API。一个 agent 的 blast radius，就是它能读到的全部凭据的并集。

企业的工具解决的是协作与审计；我的问题是隔离与卫生。形状不同，工具箱更小。

## 从 dotenv 到真正的管理器：那几个档位

没有唯一正确答案，只有一架梯子。按你的威胁爬到你该到的位置——而不是爬到某篇博客
说的位置。

### 第 0 档：写死在代码里和 shell 历史里

密钥直接写进源码，或者在提示符下敲 `export API_KEY=...`——后者还会落进
`~/.bash_history`。绝大多数单人环境就停在这一档，而它也是第一个该离开的档位。
`HISTCONTROL=ignoreboth` 有点用，但习惯胜过配置：永远不要手敲密钥，永远从文件里读。

### 第 1 档：权限收紧的 dotenv 文件

一个由本服务用户拥有、权限 `600`、并且**被 gitignore** 的 `.env`，应用启动时读它。
对很多小服务来说，这已经真的够用了。

```bash
# 应用启动时读它；gitignore 保证它不进历史
install -m 600 -o appuser -g appuser /dev/null /etc/myapp/myapp.env
printf 'DATABASE_URL=postgres://app:pw@localhost/myapp\n' \
  | sudo tee /etc/myapp/myapp.env >/dev/null
sudo chmod 600 /etc/myapp/myapp.env

# 验证一下：没有 world/group 读权限，且未被 git 跟踪
sudo stat -c '%A %U:%G %n' /etc/myapp/myapp.env
git check-ignore -v /etc/myapp/myapp.env 2>/dev/null || true
```

**dotenv** 的坑在于文件下游的一切：`.env` 会被误提交、会被拷进镜像、会被顺手打印
它的工具读取、会被每个子进程继承。`600` 挡得住机器上的其他用户，挡不住你自己的进程
树——这正是一档更深的方案存在的理由。

### 第 2 档：加密文件（sops + age）

把密钥在静态时加密，这样文件就能安全地提交和备份。**sops age** 现在是我的默认：`age`
给你一对极小、现代的密钥，`sops` 只加密 YAML/JSON/ENV 文件里的**值**而保留键名可读，
于是 diff 保持清晰，你在 git 里依然能看出结构。

### 第 3 档：真正的管理器（Vaultwarden、Bitwarden、Vault）

当服务不止几个、有你自己以外的人、或者轮换必须被强制时，用一个真正的存储。
**Vaultwarden**（一个轻量的 Bitwarden 服务端）是单人场景的甜点：网页 UI、移动端
客户端，以及一个 CLI，用来放你偶尔需要读一眼的人用密钥。它不是守护进程的运行时
后端——那是 SOPS 文件和 systemd 凭据的事。人用密钥库，机器用加密文件。

## 一套具体做法：sops age 加 systemd LoadCredential

下面是我真正在跑的方案。密钥以加密形态放在 git 里，部署时解密，经由内核交给服务——
既不经过 world-readable 的 unit 文件，也不经过 shell 历史。

先是加密的唯一真源：

```bash
# 一次性：生成 age 密钥对；私钥留在服务器之外
age-keygen -o ~/.config/sops/age/keys.txt
# -> 公钥：age1qz...

# 加密一个密钥文件。值被加密，键名保持可见
sops --encrypt --age age1qz... \
  --encrypted-regex '^(data|stringData|.*token.*|.*password.*|.*key.*)$' \
  myapp.secrets.yaml > myapp.secrets.enc.yaml

# 之后通过同一个信封编辑；磁盘上不留明文副本
sops myapp.secrets.enc.yaml
```

然后用 **systemd LoadCredential** 接到守护进程上。这一段终结了「密钥躺在
world-readable 的 unit 里」的问题：`LoadCredential=` 把文件放进一个 root 拥有、
每服务独立的运行时目录，只有该服务能读，并把路径暴露在 `$CREDENTIALS_DIRECTORY`。

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My app
After=network-online.target

[Service]
Type=simple
User=appuser
# ExecStartPre 解密 sops -> 在 tmpfs 目录里放一个 0600 文件，systemd
# 随后把它复制进凭据目录，明文本体被删除
ExecStartPre=+/usr/local/bin/sops-exec-secret myapp
ExecStart=/usr/local/bin/myapp
# systemd 只把路径交给服务；值不在 unit 里，也不在环境变量里
LoadCredential=database-url:/run/credentials-seed/myapp/database-url
# 锁紧它，让被攻陷的服务看不到机器上的其余部分
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/myapp
```

应用启动时读 `$CREDENTIALS_DIRECTORY/database-url`，而不是 `process.env`。没有导出
的环境变量可供 agent 或日志行捕获，而 git 里的 unit 文件里只有一个路径，没有口令。
这就是整个档位的意义：明文只存在于正在运行的进程内部。

## Rotation 与 blast radius

两个数字决定一次泄露要你花多大代价：密钥活多久，以及它能做多少事。这两样你都能控制。

- **Rotation（轮换）** 只有在它便宜的时候才算数。如果轮换一个数据库口令意味着手工改
  五个服务，你永远不会去做——把轮换写成脚本，把新值经由 `sops` 存进去，然后重新部署。
  优先选择那种你能随用随发、随时吊销的凭据（短时效 token、每服务独立的数据库用户），
  而不是一个长生不老的 root 口令。
- **Blast radius（影响半径）** 是一把被盗凭据能碰到的东西。一个只对单个 bucket 只读的
  token 只是倒霉一天；一个带 `repo` 和 `admin:org` 的个人访问令牌就是一次事故。给每个
  服务各自的身份、能工作的最小权限范围，而且绝不要拿你人类账号的凭据去喂守护进程。

一个好用的习惯：创建完任何密钥，问一句「如果它今晚泄露了，我明天要做什么？」如果答案
不只是「吊销并轮换」，那范围就太宽了。

## 把密钥挡在 git 之外：pre-commit 扫描

假设密钥终究会被 stage 上去，然后就当唯一的防线是它落地之前的那道闸门。一个扫描高熵
字符串和已知密钥格式的 **pre-commit** 钩子很便宜，而且能在还来得及免费修正的那一刻
抓住失误。

```bash
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
```

```bash
pre-commit install            # 把钩子接入这个 clone
pre-commit run --all-files    # 有意地把整棵树扫一遍
git check-ignore -v .env      # 确认忽略规则真的匹配上了
```

两个前提。扫描器会漏掉那些「看起来不像密钥」的密钥（比如 YAML 值里的一句裸口令），
所以要配上一条默认忽略 `.env*`、`*.pem`、`*.key`、`id_*` 和 `*.secrets.yaml` 的
`gitignore`。而且它对已经推上去的密钥无能为力：一旦历史里有它，唯一正确的回应是
**轮换**——改写历史只是打扫，轮换才是修复。

这也正是 [加固公网服务器](/zh/posts/hardening-a-public-server/) 那套运维纪律派上用场
的地方：一台只有某个具名用户能读 `/etc/myapp`、防火墙默认拒绝的机器，会让一把泄露的
凭据对持有者来说没那么好用。

## 让工具去匹配威胁（并且从最便宜的那一步开始）

跑了一段时间之后，诚实的总结是这样：

- **第一场胜利就是干脆不提交密钥。** 它下面每一档——加密、凭据、管理器——都只有在
  文件离开了明文 git 之后才有意义。gitignore 加一个 pre-commit 扫描器，用几乎为零的
  成本带你走完 80% 的路。
- **然后堵住你忘了的泄漏路径：** 日志、备份、`ps` 输出、shell 历史，以及被 agent
  继承的环境变量。给备份加密，并且宁可要凭据文件也不要环境变量。
- **再收紧 blast radius：** 每服务独立用户、最小权限 token、便宜的轮换。
- **最后才上重型工具。** 真正的管理器、策略引擎、审计链路。如果你的威胁模型是「一个
  人加几个服务」，SOPS+age 和 systemd 凭据能撑很多年。如果是「一个团队、合规、多人
  共享密钥」，那就为密钥库付费——同时记住，没有任何工具能弥补「提交了密钥却永不轮换」
  这件事。

程序出事，从来不是因为选错了密钥库的品牌，而是因为一个 `.env` 被提交了、没人轮换它、
而那个 token 九个月后依然有效。从最无聊的那堵墙开始：把密钥挡在 git 之外、日志之外、
环境变量之外。其余的一切，都是在这之上的加固。

想看清周围的全貌，我那篇 [不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)
讲的是这些服务最初是怎么摆的——更小、更简单的暴露面，永远是最便宜的风险削减。
