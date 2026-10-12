---
title: "静态加密：LUKS 和它的同伙，究竟帮你挡掉了什么"
description: "一篇务实且诚实的静态加密（encryption at rest）指南：先厘清真正的威胁模型（笔记本失窃、报废硬盘、云厂商访问），再看 LUKS 全盘加密到底覆盖什么、不覆盖什么，为什么口令才是薄弱点，TPM/clevis 与 crypttab 的解锁体验，以及在 VPS 上做 LUKS、加密 ZFS 数据集和加密备份的具体做法。"
pubDate: 2026-11-22
lang: zh
translationKey: encryption-at-rest
tags: [security, linux]
featured: false
keywords:
  - 静态加密
  - LUKS
  - 全盘加密
  - 威胁模型
  - TPM
---

「把全盘加密打开就行了。」这是继「用个密码管理器吧」之后被重复得最多的一句安全建议，
和那句一样：它对、有用，而且经常被误解。我见过有人加密了笔记本，就以为从此不怕一个被
攻陷的进程；也见过运维团队直接否掉静态加密，理由是「反正攻击者上了机器什么都能读」。
两边都抓错了重点。**静态加密（encryption at rest）** 不是一个运行中系统的属性，而是一块
**已经不在你手里** 的磁盘的属性——被偷、被报废、被打成快照，或者被一个不是你的人读走。
下面说说该怎么把 **LUKS**、加密 ZFS 和加密备份摆在正确的那一侧。

<figure>
<svg viewBox="0 0 640 230" width="100%" role="img" aria-label="左栏是静态加密能覆盖的威胁，右栏是它覆盖不了的威胁。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="12" y="14" width="290" height="200" rx="10"/>
    <rect x="338" y="14" width="290" height="200" rx="10"/>
    <line x1="12" y1="48" x2="302" y2="48"/>
    <line x1="338" y1="48" x2="628" y2="48"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="157" y="44" text-anchor="middle" font-size="14" font-weight="600">静态加密能覆盖</text>
    <text x="483" y="44" text-anchor="middle" font-size="14" font-weight="600">覆盖不了</text>
    <text x="40" y="85">失窃 / 丢失的笔记本或磁盘</text>
    <text x="40" y="120">报废或 RMA 的硬盘</text>
    <text x="40" y="155">云磁盘或快照</text>
    <text x="40" y="190">异地备份 blob</text>
    <text x="370" y="85">运行中、已解锁的机器</text>
    <text x="370" y="120">读取内存的恶意软件</text>
    <text x="370" y="155">一份未加密的副本</text>
    <text x="370" y="190">一个弱口令</text>
  </g>
</svg>
<figcaption>静态加密保护的是「介质离开你掌控」这一刻的数据。机器一旦开机、挂载、以你的身份运行，它就不起作用了。</figcaption>
</figure>

## 威胁模型：攻击者是谁，他在哪里？

先从**威胁模型**开始，因为其余一切都是由它推导出来的。静态加密针对的是一类无聊、
却极其常见的攻击者：一个在你机器**没有在运行**时拿着你的存储介质的人。

- **失窃或丢失的硬件。** 落在火车上的笔记本、一块 U 盘、一部手机。磁盘加密且处于关机
  状态时，小偷拿到的是一块只会亮登录提示的砖；没加密时，他拿到的是你的 SSH 密钥和
  浏览器 cookie。
- **报废或 RMA 的硬盘。** 这是最容易被忘掉的一类。没有加密时，「删除」只意味着「文件
  系统不再指向那些块」——当这块 SSD 退回给厂商时，那些字节仍然能被恢复工具读出来。
- **云厂商，或者任何运行着 hypervisor 的人。** 你的 VPS 服务商可以读取并给磁盘镜像打
  快照。加密不会让他们变得可信，但他们手上的那份快照变成了密文。

静态加密**不是**为对抗一个实时攻击者而设计的：机器只要开着并已解锁，密钥就在内存里，
文件系统就是明文挂载的。

## LUKS：全盘加密到底做了什么

在 Linux 上，**全盘加密（full disk encryption）** 几乎总是意味着 LUKS——Linux Unified
Key Setup。它保存一个带密钥槽（key slot）的头部，从你的口令派生出一把主密钥，再用这把
主密钥加密设备的每一个块（如今合理的默认是 AES-XTS，在 cryptsetup 里叫
`aes-xts-plain64`）。

最关键的设计是那层间接：**你的口令从不直接加密数据。** 口令只用来解锁某个密钥槽，槽里
存着主密钥的一份拷贝，真正加密块的是主密钥。所以改口令是瞬间完成的，所以一个卷可以有多
把口令或密钥文件，所以 LUKS 是一层包在纯 dm-crypt 设备外面的头部格式，而不是一个文件
系统。

```bash
# 用明确的 KDF 预算去格式化（1 GiB 的 KDF 内存：每次猜测都昂贵）
sudo cryptsetup luksFormat \
  --type luks2 --cipher aes-xts-plain64 --key-size 512 \
  --pbkdf argon2id --pbkdf-memory 1048576 --pbkdf-parallel 4 \
  /dev/nvme0n1p3

sudo cryptsetup open /dev/nvme0n1p3 cryptroot
sudo mkfs.ext4 /dev/mapper/cryptroot

# 备份头部：丢了它数据就没了，泄露了就等于泄露了 KDF 参数
sudo cryptsetup luksHeaderBackup /dev/nvme0n1p3 --header-backup-file luks-header.img
```

那份头部备份是个坑：它不含口令，却包含离线暴力破解主密钥所需的一切。把它当作磁盘本身
来对待——它保护一个秘密，它**就是**一个秘密，和我那篇
[secrets management](/zh/posts/secrets-management/) 里的纪律一样。

## 全盘加密 vs 卷加密 vs 应用层加密

这三个层次的取舍差别很大。

- **全盘加密（FDE）。** 除了引导加载器，整块设备都是密文，所以 swap、`/tmp` 和各种
  散落的文件都被覆盖。解锁只在开机时发生一次，之后下游的一切都被信任——这恰恰就是恶意
  软件利用的那条边界。
- **卷 / 文件系统加密。** 只有部分数据集被加密：一个数据分区、一个加密 ZFS 数据集、
  一个给单个服务挂载的 LUKS 卷。这在服务器上很有用，因为系统镜像是一次性的而 `/srv`
  不是；它也允许一台无头机器先启动、稍后再解锁数据。
- **应用层加密。** 应用在数据落盘之前就把字段加密。这是唯一能挺过**系统被攻陷**的一层：
  运行期间数据仍是密文，因为只有应用持有密钥。代价是：你没法 `grep` 它了。

我的原则：**全盘或卷加密用来对付「磁盘不见了」，应用层加密用来对付「机器被攻陷了」。**
大多数人需要的是前者，却以为自己做的是后者——这也正是为什么在一张加密磁盘上
[口令哈希](/zh/posts/password-hashing/) 依然重要。

## 密钥派生，以及为什么口令才是薄弱点

LUKS 没有削弱 AES；它让每一次**猜测**变贵，而最终结果还是由口令决定。头部里存着一个
**密钥派生函数（KDF）** 及其参数——内存、迭代次数、并行度——任何拿到你头部的人（来自
被偷的磁盘，或上面那份备份）都能离线、无限速地跑它。于是口令的熵就是全部的安全裕度。

这和 [口令哈希](/zh/posts/password-hashing/) 是同一套算术：KDF 只能拖慢猜解者，救不
了本就可猜的输入。一个四词 diceware 口令（约 52 bit）比人们实际会挑的那类短语强得多。
`argon2id` 配上一 GB 内存，让每次猜测都要付出大量内存——这是它能做到的极限；但它没法
让「password1」变安全。

## 解锁体验：口令、TPM/clevis、密钥文件、crypttab

每次开机都敲口令，对一台笔记本没问题，对一支机队就是折磨。

- **控制台口令。** 控制力最强，零自动化。对个人笔记本仍然是合适的默认。
- **TPM + clevis。** TPM 把密钥封存到机器的状态上（固件、Secure Boot、PCR），`clevis`
  把一个 LUKS 槽绑定到它，于是机器能自己解锁。方便，但这是有代价的：TPM 面对一个有物理
  接触且有时间的人，并不是一个保险柜；而如果你的启动链不可验证，一把被封存的密钥完全
  可能导致 evil-maid 攻击——再加上没有口令兜底，你等于悄悄放弃了口令保护。要把它和
  度量启动**一起**用，而不是用它去替代。
- **密钥文件。** 放在 U 盘或只读介质上、用来解锁某个卷的文件。在服务器上，密钥和磁盘
  分处两地，两者齐备才能解密——比 TPM 的说法实在得多。

```bash
# 密钥文件解锁：U 盘上的那个文件才是秘密，敲键盘只是图方便
sudo dd if=/dev/urandom of=/media/stick/cryptroot.key bs=512 count=8
sudo chmod 400 /media/stick/cryptroot.key
sudo cryptsetup luksAddKey /dev/nvme0n1p3 /media/stick/cryptroot.key
```

然后用 **crypttab** 把它接进启动流程，这样 initramfs 才知道哪个设备映射到哪个名字、
以及如何解锁：

```bash
# /etc/crypttab — 名字       源设备          密钥文件                   选项
cryptroot  UUID=9f1c-...   /media/stick/cryptroot.key  luks,discard,keyfile-timeout=10
```

## 服务器上的静态加密：VPS、ZFS、备份

无头机器必须先启动、**然后**才能解锁，服务器的一切决策都由此而来。

**在 VPS 上做 LUKS** 是个常见的需求，也是一个会「漏一半」的需求。你的服务商掌控着
hypervisor，原则上能窥探 guest 内存，所以加密保护的是快照和被盗镜像，而不是运行中的
guest 免于服务商。通常的做法是一小块未加密的 `/boot` 加上需要解锁的 root：你在服务商的
控制台上敲口令（initramfs 里的 dropbear，或 KVM 控制台）——或者把密钥放在宿主也拿得到
的地方，那不过是又去信任它一次。

在物理机上，**加密 ZFS 数据集**是我用过最干净的工具：

```bash
# 创建加密数据集；把密钥文件放在它所保护的池之外
sudo zfs create -o encryption=aes-256-gcm -o keyformat=raw \
  -o keylocation=file:///etc/zfs/keys/data.key rpool/data
sudo zfs load-key -a && sudo zfs mount rpool/data   # 先加载密钥，再挂载
```

如果密钥就放在它所保护的那个池上，你等于什么都没加密——把它放到 U 盘或加密的密钥存储里。

**加密备份**收益最高，也最常被跳过：备份在设计上就是要离开你掌控的，所以在它离开之前，
在客户端把它加密。

```bash
# restic：客户端加密、去重，密钥永不发给后端
export RESTIC_REPOSITORY=s3:s3.example.com/my-backups
export RESTIC_PASSWORD_FILE=/root/.config/restic/pw   # 0600，放在被备份目录之外
restic init && restic backup /srv /etc
```

「加密备份」的检验标准是：后端运营者也恢复不了它，而你不给口令同样恢复不了。把口令留在
备份之外，并且真的做一次恢复演练——见
[你恢复得了的备份](/zh/posts/backups-you-can-restore/)。

## 静态加密保护不了什么

磁盘一「不是静态」，加密就什么都保护不了：

- **运行中、已解锁的机器。** root 能读 `/dev/mapper/cryptroot` 以及每一个已挂载的文件。
  解锁之后的透明正是它的功能，也正是它的漏洞。
- **恶意软件，包括内存里的。** 一个能读实时内存的进程，可以在内核 keyring 里、或在那
  个持有字段密钥的应用里找到主密钥。
- **一份糟糕的备份。** 如果你把一个已挂载、已解密的目录树 `rsync` 到一个未加密的目的地，
  再强的加密也白搭。
- **一个弱口令。** 离线暴力破解只需要从那块失窃磁盘上取来的头部，根本不需要接触运行中
  的系统。
- **侧信道与元数据。** 写入的大小和时序即便在内容不可见时也会泄露。加密不是匿名化。

## 诚实的结论：它是为「磁盘不见了」准备的

用静态加密，并且想清楚**为什么**。你要防的是介质离开掌控的那一刻：失窃的笔记本、RMA 的
硬盘、服务商的快照、异地的备份。对这一刻而言它便宜、近乎完美、而且内建于 Linux——对于
任何便携的、任何会离开这栋楼的东西，默认就该加密。

别假装它能保护一台攻击者正坐着的机器。那是另一个问题——最小权限、打好补丁、不要明文环境
变量，也就是我那篇 [secrets management](/zh/posts/secrets-management/) 里的纪律。静态
加密只回答一个问题：*如果今晚这块磁盘消失了，一个陌生人能读出它吗？* 答案是「不能」，
它就在起作用。如果你指望它顺便拦住已经站在机器上的人，那你用错了工具。
