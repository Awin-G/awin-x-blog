---
title: "Linux 权限手册：不止 rwx（chmod、umask、setfacl、setgid）"
description: "一份带真实终端输出的 Linux 权限实战指南：文件和目录上的 rwx 分别是什么意思、umask 如何决定默认权限、setuid/setgid/sticky bit 的真实演示、用 setfacl 配 ACL 与默认 ACL、那些经典错误，以及一份安全检查清单。"
pubDate: 2026-12-24
lang: zh
translationKey: linux-permissions
tags: [linux, security]
featured: false
keywords:
  - Linux 权限
  - chmod
  - setfacl
  - umask
  - setgid
---

权限大概是我讲过最多、也踩坑最多的那部分 Linux。`rwx` 这三个字母看着简单，直到某个服务读不了一个明明“属于它”的文件、某个共享目录里新文件老是落在错误的组里，或者一次 `chmod -R 777` 的“修复”把网站根目录变成了谁都能写的靶子。这篇是一本 **Linux 权限**手册：先讲心智模型，再讲真正重要的四个工具——`chmod`、`chown`/`chgrp`、`umask`、`setfacl`——而且每条结论都配我自己机器上的真实输出。单用户示例以普通账号在宿主机上运行；多用户示例（setuid、setgid、sticky、ACL 实际生效）放在一个用完即弃的容器里跑，所以那些 `Permission denied` 是真报错，不是我编的。如果你要加固一台机器而不只是排查它，那篇[服务器加固清单](/zh/posts/hardening-a-public-server/)和[systemd 沙箱笔记](/zh/posts/systemd-hardening/)是本文的配套。

## Linux 权限模型：文件和目录不是一回事

每个文件都带三组权限位：属主（owner）、属组（group）、其他人（other）。`stat` 会把符号和八进制两种写法都打出来：

```text
$ stat -c "%A  %a  %n" file.txt dir .
-rw-r--r--  644  file.txt
drwxr-xr-x  755  dir
drwxr-xr-x  755  .
```

`%A` 是符号形式，`%a` 是八进制。`644` 就是 `rw- r-- r--`：属主可读可写，属组和其他人只能读。`755` 就是 `rwx r-x r-x`。真正的坑在于：`r`、`w`、`x` 在目录上的含义完全不同：

<figure>
<svg viewBox="0 0 660 214" width="100%" role="img" aria-label="同样的 rwx 位对普通文件和目录含义不同。对文件：r 读内容、w 写内容、x 执行。对目录：r 列出名字、w 增删改名条目、x 穿越到某个条目。">
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <rect x="8" y="8" width="316" height="198" rx="10"/>
    <rect x="336" y="8" width="316" height="198" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="14">
    <text x="28" y="34" font-weight="600">普通文件</text>
    <text x="356" y="34" font-weight="600">目录</text>
    <g font-family="ui-monospace, monospace" font-size="15" opacity="0.9">
      <text x="28" y="72">r</text><text x="28" y="118">w</text><text x="28" y="164">x</text>
      <text x="356" y="72">r</text><text x="356" y="118">w</text><text x="356" y="164">x</text>
    </g>
    <g opacity="0.85">
      <text x="52" y="72">读取内容</text>
      <text x="52" y="118">写入内容</text>
      <text x="52" y="164">执行它</text>
      <text x="380" y="72">列出里面的名字</text>
      <text x="380" y="118">增删 / 改名条目</text>
      <text x="380" y="164">穿越到某个条目</text>
    </g>
  </g>
</svg>
<figcaption>同样三个位，两种完全不同的含义。在目录上，<code>x</code> 是最容易被忽略的那一个——没有它，<code>r</code> 只给你一堆用不了的名字。</figcaption>
</figure>

对**文件**，`x` 表示“可以执行”。对**目录**，`x` 表示“可以穿越进去”——按已知名字打开、`stat` 某个条目，或者 `cd` 进去。这条区别解释了绝大多数权限 bug，也顺带给出那条迟早都得记住的规则：

> 删除或重命名一个文件，取决于**目录的写位和执行位**，而不是文件自身的权限。

只要你对父目录有 `wx`，就能删掉一个只读文件；反过来，父目录不允许时，一个“所有人可写”的文件也删不掉。

## 目录上的 `x` 到底意味着什么

下面是一个 `400`（`r--`）的目录——能读，但不能穿越：

```text
$ chmod 400 d1
$ ls d1            # r 让我们读到名字列表
file
$ ls -l d1         # -l 需要对每个条目 stat()，那需要 x
ls: cannot access 'd1/file': Permission denied
$ cat d1/file      # 要够到文件，需要 x 穿越 d1
cat: d1/file: Permission denied
$ cd d1
cd: d1: Permission denied
```

`ls` 打出了名字，因为读目录只是列出名字；但每个条目都显示成 `?????????`，既打不开也进不去。再换成 `100`（`--x`）——能穿越，不能读：

```text
$ chmod 100 d1
$ ls d1            # x 并不让你列出内容
ls: cannot open directory 'd1': Permission denied
$ cat d1/file      # 但一个你已经知道的名字是够得到的
topsecret
$ cd d1 && ls
ls: cannot open directory '.': Permission denied
```

所以：只有 `r` 没有 `x`，你拿到的是用不了的名字；只有 `x` 没有 `r`，你能访问那些你本来就发现不了的路径。几乎每个 Web 服务器都这么工作：`nginx` 对通往某个文件的各级目录只需要 `x`，不需要 `r`。

## umask：默认权限从哪来

新建文件和目录并不是从 `777` 起步。内核从一个基准值开始——文件是 `666`，目录是 `777`——再减去 **umask**：

```text
$ umask
0022
$ umask -S
u=rwx,g=rx,o=rx
```

`022` 清掉了属组写位和其他人写位，所以 `touch` 出来是 `644`、`mkdir` 出来是 `755`。改了 umask，默认值随之改变：

```text
$ (umask 027; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw-r----- 640 f
drwxr-x--- 750 d
$ (umask 077; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw------- 600 f
drwx------ 700 d
$ (umask 002; touch f; mkdir d; stat -c '%A %a %n' f d)
-rw-rw-r-- 664 f
drwxrwxr-x 775 d
```

`022` 是桌面默认。`027`（`640`/`750`）是我在服务器上设的值，因为文件仍可被同组读取，但对外人关闭。`077` 用于任何私密内容。`002` 在一些发行版里是刻意设置的，方便共享组协作，但它同时意味着“其他人”也能读。把 umask 写进 `/etc/profile` 或 systemd 单元里（`UMask=0027`），别只在一个你会忘记的交互式 shell 里设。

## chmod、chown 与 chgrp 实战

`chmod` 支持符号形式和八进制形式；符号形式更好审查，因为它把意图说清楚了：

```text
$ chmod u+x report.sh;      stat -c '%A %a %n' report.sh
-rwxr--r-- 744 report.sh
$ chmod g-w,o-rwx report.sh; stat -c '%A %a %n' report.sh
-rwxr----- 740 report.sh
$ chmod a+r report.sh;      stat -c '%A %a %n' report.sh
-rwxr--r-- 744 report.sh
$ chmod 640 report.sh;      stat -c '%A %a %n' report.sh
-rw-r----- 640 report.sh
```

属主/属组和权限模式是两回事。`chgrp` 可以把文件移到一个你所属的组；而改**属主**只有 root 能做：

```text
$ chgrp video shared.txt
$ stat -c '%A %a %U:%G %n' shared.txt
-rw-r--r-- 644 awinx:video shared.txt
$ chown nobody shared.txt
chown: changing ownership of 'shared.txt': Operation not permitted
```

在容器里以 root 运行时，同样的 `chown` 会成功——这正是 `chown` 是一条权限边界的原因，也是 `CAP_CHOWN` 值得挡在容器之外的原因。`chmod --reference=other` 和 `find . -type d -exec chmod 755 {} +` 是我最常用的两个变体。

## 特殊位：setuid、setgid 与 sticky bit

在常规的九位之上还有三位，每一位都在特定场景下改变行为。本节所有内容都以 root 在一个用完即弃的容器里运行，用户是 `alice`（1001）、`bob`（1002）、`carol`（1003）。

**setuid（`4`）** 加在一个可执行文件上，会让它以文件属主的身份运行。一个三行 C 程序就能证明：

```text
$ chmod 4755 /vol/work/who
-rwsr-xr-x 4755 root:root /vol/work/who
$ su alice -c /vol/work/who
real uid=1001  effective uid=0
$ chmod 0755 /vol/work/who
$ su alice -c /vol/work/who
real uid=1001  effective uid=1001
```

`ls` 里显示成 `rws`——本该是属主 `x` 的位置变成了 `s`。`passwd`、`sudo`、`mount` 就是这么干活的；也正因如此，它是需要审计的那一位：一个你没装过的 setuid 程序，就是一个有完美不在场证明的后门。在目录上，Linux 会忽略 setuid。

**setgid（`2`）** 加在*目录*上，正好解决经典的共享目录问题：里面新建的文件会继承目录的属组，而不是创建者的属组：

```text
$ chmod 2775 /vol/work/proj
drwxrwsr-x 2775 carol:dev /vol/work/proj
$ su alice -c "touch /vol/work/proj/alice.txt"
$ stat -c '%A %a %U:%G %n' /vol/work/proj/alice.txt
-rw-r--r-- 644 alice:dev /vol/work/proj/alice.txt
```

alice 的文件落在 `dev` 组里，而不是 `alice`，因为 setgid 目录提供了这个组。没有 setgid 时，同样的命令会得到 `alice:alice`——这就是为什么共享目录里的两个人会突然看不到彼此的文件。加在可执行文件上时，setgid 对属组做的是 setuid 对属主做的那件事。

**sticky bit（`1`）** 加在一个所有人可写的目录上，会限制谁能删除条目：只有文件属主、目录属主或 root：

```text
$ stat -c '%A %a %U:%G %n' /vol/work/shared
drwxrwxrwt 1777 carol:carol /vol/work/shared
$ su bob -c "echo tampered >> /vol/work/shared/carol.txt"   # 改内容：允许
$ su bob -c "rm /vol/work/shared/carol.txt"                  # 删除：禁止
rm: cannot remove '/vol/work/shared/carol.txt': Operation not permitted
```

注意 sticky **不做**什么：它并不阻止 bob 改写一个 `666` 文件的内容，只阻止他删除或重命名这个条目。这也是 `/tmp` 是 `1777` 的原因，也是为什么一台普通机器上的 setuid 程序值得列一列：

```text
$ ls -ld /tmp
drwxrwxrwt 33 root root 2980 Oct 12 18:51 /tmp
$ find /usr/bin /bin -maxdepth 1 -perm -4000 -printf '%M %p\n' | head -4
-rwsr-xr-x /usr/bin/chsh
-rwsr-xr-x /usr/bin/umount
-rwsr-xr-x /usr/bin/passwd
-rwsr-xr-x /usr/bin/pkexec
```

## setfacl：当一个组不够用时（ACL）

Unix 给一个文件只能有一个属主和一个属组。当你需要“`video` 组*以及*用户 1001 都能读”时，就需要 ACL 了。`setfacl` 添加条目，`getfacl` 查看条目：

```text
$ stat -c '%A %a %U:%G %n' deploy.conf
-rw-r----- 640 awinx:video deploy.conf
$ setfacl -m u:1001:rw deploy.conf
$ getfacl deploy.conf
# file: deploy.conf
# owner: awinx
# group: video
user::rw-
user:1001:rw-
group::r--
mask::rw-
other::---
$ ls -l deploy.conf
-rw-rw----+ 1 awinx video 8 Oct 12 18:51 deploy.conf
```

`ls -l` 末尾那个 `+` 就是“存在 ACL”的信号。`mask::` 那行是大家最容易忽略的：它一次性限制所有具名用户、具名组以及属组。

```text
$ setfacl -m m::r deploy.conf
$ getfacl -e deploy.conf
user::rw-
user:1001:rw-   #effective:r--
group::r--      #effective:r--
mask::r--
other::---
```

`-e` 打印经过 mask 之后的*有效*权限。普通的 `chmod` 也会改写 mask（而不是具名条目），这就是“我明明配了 ACL，后来又不生效了”的常见来源。在容器里，ACL 确实能给一个不属于任何共享组的用户开通访问：

```text
$ getfacl -c /vol/work/acl_demo
user::rw-
user:alice:rw-
group::r--
mask::rw-
other::---
$ su alice -c "echo hi-from-alice >> /vol/work/acl_demo"
$ su bob   -c "echo hi-from-bob >> /vol/work/acl_demo"
sh: 1: cannot create /vol/work/acl_demo: Permission denied
```

**默认 ACL**（`setfacl -d`）让目录里新建的条目自动继承这些权限——这是搭一个“投放箱”目录的干净做法：

```text
$ setfacl -d -m u:1001:rwx -m g:video:rx shared
$ getfacl -p shared
user::rwx
group::r-x
other::r-x
default:user::rwx
default:user:1001:rwx
default:group::r-x
default:group:video:r-x
default:mask::rwx
default:other::r-x
$ touch shared/newfile
$ getfacl -p shared/newfile
user::rw-
user:1001:rwx   #effective:rw-
group::r-x      #effective:r--
mask::rw-
other::r--
```

`default:` 那一块会被复制到新文件上；`#effective:` 注释则显示 mask 把每个条目裁剪成创建程序真正请求的样子。默认 ACL 让你无需逐个碰文件，就能把一整棵树授权给某个组——也正因为它们存在扩展属性里，所以特别容易丢。

## 那些经典错误

**`chmod -R 777`。** 这是最典型的错误“修复”。递归下去，它让每个文件都可执行、每个目录都可写：

```text
$ chmod -R 777 app
drwxrwxrwx 777 app
-rwxrwxrwx 777 app/run.sh
-rwxrwxrwx 777 app/notes.txt
$ find app -perm -o+w -printf '%M %p\n'
drwxrwxrwx app
-rwxrwxrwx app/notes.txt
-rwxrwxrwx app/run.sh
```

现在每个普通文件都成了一个谁都能改的脚本。去修真正的原因——属主错了、组缺了、某个目录少了个 `x`——而不是这样一刀切。

**所有人可写的文件与目录。** `find / -xdev -type f -perm -0002` 会列出任何人都能改写的文件；正常情况下只该出现极少数刻意为之的结果。对目录再用 `-o+w` 跑一遍，你就有了真正重要的那份审计。

**目录上少了个 `x`。** 这是上一个 bug 的反面：文件明明是 `644`、可读，某个服务却仍然拿到 `Permission denied`，因为某个父目录缺了 `x`。用 `namei -l /path/to/file` 一次把整条路径检查完。

**复制时悄悄丢掉的 ACL。** ACL 存在 `system.posix_acl_access` 扩展属性里，而普通的 `cp` 不会保留它：

```text
$ getfacl -c src.conf
user::rw-
user:1001:r--
group::r--
mask::r--
other::r--
$ cp src.conf dst.conf;      getfacl -c dst.conf
user::rw-
group::r--
other::r--
$ cp -a src.conf dst_a.conf; getfacl -c dst_a.conf
user::rw-
user:1001:r--
group::r--
mask::r--
other::r--
```

用 `cp -a`（或 `--preserve=all`）、`rsync -A` 和 `tar --acls`。一次“恢复成功”但把 ACL 丢掉的备份，下周会以同样的方式再挂一次。

## 我真正会跑的权限检查清单

- 服务器 umask 设成 `027`（单元里写 `UMask=0027`），别用 `022`。
- 进程要穿越某个目录，就给它 `x`；永远不要靠加 `777` 去“修”一个读取错误。
- 共享目录用 `setgid`（`2775`）让属组固定下来；很多人往里写时再加 sticky bit（`1777`）。
- 只为一个文件授权时，优先 `setfacl`，而不是把所有人都加进某个组。
- 用 `find / -xdev -perm -4000 -type f` 审计 setuid，用 `find / -xdev -type f -perm -0002` 审计所有人可写的文件。
- 复制和备份时保留权限与 ACL：`cp -a`、`rsync -A`、`tar --acls`。
- 甩锅给文件之前，先用 `namei -l` 把整条路径复查一遍。

权限不是装饰，它是所有上层东西下面的那层访问控制。把模型弄对——目录上的 `r`/`w`/`x`、一个组加上 ACL、三个特殊位——剩下的系统都会跟着简单起来。下一步自然是把它们用到一台加固过的服务上，那正是[服务器加固清单](/zh/posts/hardening-a-public-server/)和[systemd 沙箱笔记](/zh/posts/systemd-hardening/)接手的地方。
