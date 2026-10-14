---
title: "systemd-creds：把密钥交给服务，而不落到磁盘上"
description: "systemd-creds 把密钥加密绑定到本机（或 TPM），只有 systemd 才能在服务启动时解密。LoadCredentialEncrypted= 通过私有 tmpfs 的 $CREDENTIALS_DIRECTORY 把明文交给服务——明文不上磁盘、不进环境变量、不进 /proc。真实输出，诚实标注局限。"
pubDate: 2027-02-09
lang: zh
translationKey: systemd-creds-encrypted-secrets
tags: [systemd, security]
featured: false
keywords:
  - systemd-creds
  - LoadCredential
  - 服务密钥
  - CREDENTIALS_DIRECTORY
  - TPM
---

我跑着几个自托管服务，每一个都需要密码、令牌或密钥。把密钥交给服务的常见
方式都 quietly 糟糕：环境变量会出现在 `/proc/<pid>/environ` 里，任何本地进程
都能读；明文文件一直躺在磁盘上，直到备份把它带走；`docker inspect` 则把整
个环境变量以明文打印出来。我在[密钥管理](/zh/posts/secrets-management/)里已经讲过
更广的密钥全景——sops、age、dotenv、轮换；这里我想讲的是 systemd 原生、不需要
外部工具的那一块：**systemd-creds** 和 `LoadCredential=` 这一族指令。

思路很小，却改变了威胁模型。你把密钥**加密绑定到本机**（或它的 TPM），只有
拥有本机的那个 systemd 实例才能解密。服务启动时，systemd 解密这个 blob，把
明文放进一个只有该服务能读的私有 tmpfs。明文从不接触真实磁盘，从不成
为环境变量，服务重启后也随之消失。本文是 [systemd-unit-cookbook](/zh/posts/systemd-unit-cookbook/)
的姊妹篇，我聚焦凭据机制，并展示自己机器上的真实输出。

## 问题：环境变量、文件与 `docker inspect`

先看失败场景。服务从环境变量读密钥。任何本地进程——包括另一个用户的脚本，
或是我指给机器的 agent——都能读到它：

```console
$ tr '\0' '\n' < /proc/<pid>/environ | grep -i token
TOKEN=supersecret
```

不需要特殊权限：`/proc/<pid>/environ` 对同用户进程是 world-readable 的，内核
并不隐藏它。用**文件**，密钥就落到真实文件系统上，权限模式全凭我记得设置，
而且一直待在那儿——在备份里，在调试时的 `cat` 里，在意外里。用
**Docker**，`docker inspect` 乐呵呵地把每个环境变量以明文打印：

```console
$ docker inspect --format='{{json .Config.Env}}' myapp
["TOKEN=supersecret","PATH=/usr/bin"]
```

（最后这一段是对泄露形状的示意性格式化，不是我在本次抓到的输出——`/proc` 和
systemd-creds 的命令我是在自己机器上真跑的，几处跑不了的地方我会诚实标注。）

## systemd-creds 到底是什么

`systemd-creds` 是一个加解密**凭据**的小 CLI。加密后的凭据是一个自描述的
blob：它带有凭据名、可选的时间戳与过期时间，以及绑定到某个密钥的密文。钥
可以是：

- `host` —— 每主机一份的密钥，位于 `/var/lib/systemd/credential.secret`，
  由 `systemd-creds setup` 一次性生成（仅 root）。只有本机的 systemd 能解密。
- `tpm2` —— 密封到 TPM 的 PCR，只有在同一套固件+内核启动状态下才能解密。
  比 host key 更强。
- `host+tpm2` —— 两者兼顾，纵深防御。
- `null` —— 完全不用钥。在哪都能跑，但**不提供**任何机密性。工具会大声警告
  你。

我这个构建包含 TPM2 支持：

```console
$ systemd-creds --version
systemd 262 (262-1-arch)
+PAM +AUDIT -SELINUX +APPARMOR ... +TPM2 +BZIP2 +LZ4 +XZ +ZLIB +ZSTD ...
```

## 哪些能加密、哪些不能（真实输出）

我在开发机上以非特权身份试了各条加密路径，下面就是实际发生的事。**默认**
（`--with-key=auto`，优先用 host key）失败，因为没有 host key，且从容器里
够不到系统凭据服务：

```console
$ systemd-creds encrypt --name=demo secret.txt demo.cred
Failed to encrypt: io.systemd.System

$ systemd-creds encrypt --with-key=host --name=demo secret.txt demo-host.cred
Failed to encrypt: org.varlink.service.PermissionDenied

$ systemd-creds encrypt --with-key=tpm2 --name=demo secret.txt demo-tpm.cred
Failed to encrypt: io.systemd.System

$ ls /var/lib/systemd/credential.secret
ls: cannot access '/var/lib/systemd/credential.secret': No such file or directory

$ systemd-creds setup
Failed to setup credentials host key: Permission denied
```

TPM 路径需要系统凭据服务和可用的 TPM 证明，这个容器两者都没有，尽管设备节点
存在（`/dev/tpm0`、`/dev/tpmrm0`）。所以**系统级 host 和 TPM 加密就是我以非
特权身份跑不了的部分**——在一台 systemd 作为 PID 1、并跑过一次 `sudo systemd-creds setup`
的真实 VPS 上，你会用 `--with-key=host` 和 `--with-key=host+tpm2`。

有两条路径**确实能跑**。`null` 钥在哪都能加密（伴随响亮的"不提供机密性"警告），
而**用户级** host key 能跑，因为我的 user manager 正在运行：

```console
$ systemd-creds encrypt --with-key=null --name=demo secret.txt demo-null.cred
Using a null key for encryption and signing. Confidentiality or authenticity will not be provided.

$ systemd-creds encrypt --user --with-key=host --name=demo secret.txt demo-user.cred
（无输出；exit 0）
```

用户级路径是我能端到端验证的那条，对于服务跑在自己的 user manager 下、而非以
root 运行的自托管机器来说，它也是正确的模型。

## 加密 blob 不是明文

凭据文件是 base64 编码的密文——`file` 称之为 ASCII text，字节显然不是密钥本身：

```console
$ file demo-null.cred demo-user.cred
demo-null.cred: ASCII text
demo-user.cred: ASCII text

$ xxd demo-user.cred
00000000: 4b68 2b48 656b 4a31 5178 717a 2b65 3066  Kh+HekJ1Qxqz+e0f
00000010: 5859 396d 4153 4141 4141 4142 4141 4141  XY9mASAAAAABAAAA
00000020: 4441 4141 4142 4141 4141 426a 6c55 7a56  DAAAABAAAABjlUzV
00000030: 5336 3758 3741 7631 4b63 4941 4141 4141  S67X7Av1KcIAAAAA
```

看不到 `hunter2` 的影子。明文被封在里面。

## 往返：一个用 `LoadCredentialEncrypted=` 的 `--user` 单元

这才是要紧的部分。我写了一个小小的用户服务，加载加密凭据并把它复制出来，以
证明内容成功穿过了解密：

```ini
[Service]
ExecStart=/bin/sh -c 'cp "$CREDENTIALS_DIRECTORY/demo" /tmp/opencode/work/systemd-creds/cred-dump.bin; echo "copied; src size=$(wc -c < "$CREDENTIALS_DIRECTORY/demo")"'
LoadCredentialEncrypted=demo:/tmp/opencode/work/systemd-creds/demo-user.cred
```

reload 并启动：

```console
$ systemctl --user daemon-reload && systemctl --user start creds-demo.service
（exit 0）

$ journalctl --user -u creds-demo.service --no-pager
systemd[905]: Starting creds-demo.service...
systemd[905]: Started creds-demo.service.
sh[1266628]: copied; src size=20
```

服务跑起来了。user manager 在启动时解密了 blob，把明文放到
`$CREDENTIALS_DIRECTORY/demo`。目录本身就是整个安全故事：

```console
$ systemctl --user show creds-demo.service -p LoadCredentialEncrypted
LoadCredentialEncrypted=[unprintable]

$ findmnt -T /run/user/1000/credentials -o TARGET,FSTYPE,OPTIONS
/run/user/1000  tmpfs  rw,nosuid,nodev,relatime,...,mode=700,uid=1000,gid=1000,...
```

`$CREDENTIALS_DIRECTORY` 是 `/run/user/1000/credentials/creds-demo.service`——
一个私有 tmpfs，mode 700，属主是我的用户，而加密值在 `systemctl show` 里被
屏蔽为 `[unprintable]`。复制出来的内容正是加密前的内容：

```console
$ xxd cred-dump.bin
00000000: 6875 6e74 6572 322d 6465 6d6f 2d73 6563  hunter2-demo-sec
00000010: 7265 740a                                ret.
```

`hunter2-demo-secret`——20 字节，穿过 host key 完成往返。作为对比，**非加密**
的 `LoadCredential=plain:/path/secret.txt` 也能跑（它服务了 `correct horse battery
staple`），但那会直接从磁盘读明文文件，于是密钥在整个生命周期里都在真实文
件系统上。加密变体才是把明文挪出磁盘的那个。

我在信任它之前先验证了单元格式良好：

```console
$ systemd-analyze verify ~/.config/systemd/user/creds-demo.service
（exit 0；无诊断）
```

一个诚实的缺口：独立的 `systemd-creds decrypt` CLI 在我的环境里**没能**往返。
系统级 decrypt 以 `io.systemd.System` 失败，用户级 decrypt 拒绝了文件名
（`Name in credential doesn't match expectations`），因为 CLI 要求输出文件名与
内嵌凭据名一致。所以我通过生产里真正要紧的那条路径——管理器在启动时解密
——证明了解密，而不是通过这个临时 CLI。在普通主机上 CLI 能用；我只是在这里
没能完整演练它。

<figure>
<svg viewBox="0 0 900 250" width="100%" role="img" aria-label="明文密钥文件经 systemd-creds encrypt 变成绑定到 host key 的 base64 密文 blob；服务启动时 systemd 解密 blob，把明文放进挂载在 CREDENTIALS_DIRECTORY 的私有 tmpfs，只有该服务能读；明文从不接触真实磁盘。">
  <defs>
    <marker id="sc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="8" y="14">你的终端</text>
    <text x="330" y="14">systemd-creds encrypt</text>
    <text x="660" y="14">服务启动时</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <rect x="8" y="40" width="180" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="20" y="66" font-family="ui-monospace, monospace" font-size="11">secret.txt</text>
    <text x="20" y="86" font-family="ui-monospace, monospace" font-size="10" opacity="0.7">hunter2-demo-secret</text>
    <text x="20" y="104" font-size="10" opacity="0.6">明文，在磁盘上</text>
    <line x1="196" y1="75" x2="320" y2="75" stroke="#0f766e" stroke-width="1.5" marker-end="url(#sc-arrow)"/>
    <rect x="330" y="40" width="200" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="342" y="66" font-family="ui-monospace, monospace" font-size="11">demo.cred</text>
    <text x="342" y="86" font-family="ui-monospace, monospace" font-size="9" opacity="0.7">Kh+HekJ1Qxqz+e0f…</text>
    <text x="342" y="104" font-size="10" opacity="0.6">绑定到 host / TPM 密钥</text>
    <line x1="538" y1="75" x2="650" y2="75" stroke="#0f766e" stroke-width="1.5" marker-end="url(#sc-arrow)"/>
    <rect x="660" y="40" width="220" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <text x="672" y="66" font-family="ui-monospace, monospace" font-size="11">$CREDENTIALS_DIRECTORY</text>
    <text x="672" y="86" font-family="ui-monospace, monospace" font-size="10" opacity="0.7">/run/user/1000/credentials/…</text>
    <text x="672" y="104" font-size="10" opacity="0.6">私有 tmpfs，mode 700</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="10" opacity="0.65">
    <text x="330" y="150">systemd 用 host key（或 TPM）解密——只能在本机、只能在启动时。</text>
    <text x="330" y="168">明文从不接触真实磁盘，从不成环境变量，从不进 /proc。</text>
    <text x="330" y="186">服务停止即消失。轮换就是重新加密并重启。</text>
  </g>
</svg>
<figcaption>加密凭据进，tmpfs 密钥出。明文只存在于 per-service 凭据 tmpfs 里，该 tmpfs 由 systemd 在服务生命周期内挂载、卸载。</figcaption>
</figure>

## 指令：`LoadCredential=`、`LoadCredentialEncrypted=`、`SetCredential=`

三条指令覆盖整个空间，区别正是要点：

- **`LoadCredential=name:path`** —— 把 `path` 的明文文件加载到
  `$CREDENTIALS_DIRECTORY/name`。文件全程留在磁盘上。适合配置文件，不适合
  你想挪出磁盘的密钥。
- **`LoadCredentialEncrypted=name:path`** —— 在启动时解密 blob（host / TPM
  钥），以同样方式提供明文。这才是消除磁盘明文的那一条。
- **`SetCredentialEncrypted=name:value`** —— 同样的解密，但 blob 内联在单元或
  drop-in `.conf` 里，因此你不用单独管理一个文件。（其姊妹 `SetCredential=` 是
  内联明文形式。）

无论用哪条指令，服务读密钥的方式都一样——它就是打开
`$CREDENTIALS_DIRECTORY/name`：

```ini
[Service]
ExecStart=/usr/bin/myapp --token-file=%d/token
```

`%d` 是 systemd 对凭据目录的specifier。因为目录是私有 tmpfs，该文件只能被服务的
用户读取，停止后即消失。`systemd-creds list` 印证了这个模型——没有服务凭据的
shell 什么也看不到：

```console
$ systemd-creds list
No credentials passed. (i.e. $CREDENTIALS_DIRECTORY not set.)
```

## 与替代方案的对比

我用 sops + age 管理 git 里的密钥，更大的 setup 用 Vault 式存储（见
[密钥管理](/zh/posts/secrets-management/)）。systemd-creds 不能替代它们，它是最后
一公里。对小型自托管机器而言，有意义的对比是：

- **普通环境变量** —— 经 `/proc/<pid>/environ` 和 `docker inspect` 泄露。对
  任何真东西都弃用。
- **root 属主文件，mode 0400** —— 比环境变量好：不在 `/proc`，不在 `docker
  inspect`。但它躺在真实磁盘上，于是跟着备份走，任何 root 进程（或备份作业）
  都能读。它是地板，不是天花板。
- **密钥管理器（Vault / sops / age）** —— 当你需要轮换、审计和多主机分发时的正
  确答案。当你只有三个密钥一台主机时，它过度设计且引入新的失败模式。
  sops/age 把密钥*送进*主机；systemd-creds 把密钥*送进服务*而不经过明文停
  靠。
- **systemd-creds** —— 原生的最后一公里。没有新守护进程、没有网络、没有外部存
  储。密钥在主机上静态加密，只在启动时被 systemd 解密到一个只有服务能读的
  tmpfs。

诚实的说法是：密钥管理器缩小*谁能在静态和 git 里读密钥*；systemd-creds
缩小*明文在运行时究竟存在于哪里*。二者互补——sops/age 把加密 blob 送到主
机，`LoadCredentialEncrypted=` 把它送到服务。

## 诚实的局限

- **绑定主机意味着不可移植。** 加密到 `--with-key=host` 的凭据只能用那台
  `/var/lib/systemd/credential.secret` 密封它的机器解密。把文件挪到另一台主机
  它就是死密文。对单台 VPS 这是特性（偷走的备份在主机外无用）；对可迁移容器
  则是死路。这不是密钥管理器替代品的主要原因。
- **TPM 比 host key 更强。** `--with-key=tpm2` 密封到 PCR，所以 blob 只能在同
  一套启动状态下的固件+内核上解密。如果你能用它，就用——但它恰恰是容器里我
  演练不了的那条路径，而且把密钥绑死在一台机器的启动状态上。
- **它不能防 root。** Root 能读 host key，能在服务 chroot 前 attach 上去，能
  在服务运行中读那个 tmpfs。systemd-creds 缩小的是*磁盘*和 *proc* 的泄露面；
  它不是 root 边界。这里的威胁模型是"密钥在磁盘/环境/备份里"，而不是"root 是
  恶意的"。
- **`null` 钥不是加密。** 它是一个不提供机密性的可移植信封——适合测试管道，绝
  不适合真正的密钥。

## 小型自托管服务的实用配方

合在一起，我会真正部署到单主机的设置：

1. **一次性生成 host key**（root，一次）：
   ```console
   $ sudo systemd-creds setup
   ```
   在 systemd 256+ 上，user manager 也能按用户作用域生成密钥
   （`systemd-creds encrypt --user --with-key=host …`），这正是我在这里非特权
   测试的那条路径。
2. **把密钥加密到本机（或 TPM）：**
   ```console
   $ systemd-creds encrypt --with-key=host+tpm2 --name=token secret.txt token.cred
   ```
   把 `token.cred` 留在磁盘上——它是密文。完成后删掉明文 `secret.txt`。
3. **把单元接上**，让它加载并指向凭据目录：
   ```ini
   [Service]
   ExecStart=/usr/bin/myapp --token-file=%d/token
   LoadCredentialEncrypted=token:/etc/myapp/token.cred
   ```
4. **验证并启动：**
   ```console
   $ systemd-analyze verify /etc/systemd/system/myapp.service
   $ systemctl daemon-reload && systemctl restart myapp
   ```
5. **轮换**就是重新加密并重启。旧明文从不在磁盘上，所以轮换只是换一个新 blob
   加一次 reload。

整个系统就这样。没有 agent、没有 sidecar、没有外部存储——明文只存在 systemd
挂载 tmpfs 所需的几毫秒里，之后就只有该拿它的进程够得着。

## 这里跑不了的部分

为保持诚实：**系统级**的 `--with-key=host` 和 `--with-key=tpm2` 加密在我的
容器里失败（没有 host key、够不到系统凭据服务），因此我演示了**用户级** host
key 路径，而那也是服务跑在自己 user manager 下的自托管机器的正确模型。我也
没能在这里完成独立的 `systemd-creds decrypt` CLI 往返；我通过服务启动时的
`LoadCredentialEncrypted=` 证明了解密——反正那才是真正的使用场景。在以
systemd 为 PID 1、跑过一次 `sudo systemd-creds setup` 的普通主机上，系统级路径
如文档所述可用。
