---
title: "用 binwalk 做固件分析：提取固件、猎捕硬编码凭据"
description: "一篇面向自有设备的固件分析实战：从哪里拿到厂商或 OTA 固件镜像，binwalk 如何识别 squashfs、cramfs、jffs2 与 uImage，如何用 binwalk -e 与 unsquashfs 提取固件，以及如何用 strings 与 grep 猎捕硬编码凭据、私钥和 API token。"
pubDate: 2026-11-11
lang: zh
translationKey: firmware-secrets-and-binwalk
tags: [reverse-engineering, security, embedded]
featured: false
keywords:
  - 固件分析
  - binwalk
  - 提取固件
  - 硬编码凭据
  - squashfs
---

大多数人第一次接触**固件分析**，是在意识到桌上那台路由器、走廊里那台 IP 摄像头，
或者那台扫地机器人，都带着一个没人审计过的网页的那一天。厂商 App 非要你注册云账号；
升级地址是明文 HTTP；管理员密码就印在贴纸上。这些单独看都不是漏洞，但叠在一起，就是
一个值得看看里面有什么的理由。本文记录的，就是我在自己拥有的硬件上、用 **binwalk**、
`strings` 和一个文件系统做这件事的过程——目的是理解它，并在必要处把它报出去。

方法很短：拿到镜像，认出容器，**提取固件**，挂载它，然后开猎。真正有意思的东西很少是
加密的——它往往是一个没有哈希的 `/etc/shadow`、一个带着 API token 的 JSON 配置，或者
一个以全局可读权限发布的 `RSA PRIVATE KEY`。这些就是我们要找的**硬编码凭据**，而找到
它们通常只差一次 `grep`。

## 固件镜像从哪来

分析不了你手里没有的东西，所以第一步是合法地拿到镜像。三个来源，按省事的程度排序：

1. **厂商支持页面。** 很多厂商把完整固件作为 `.bin`、`.img` 或一个 zip 发布。下载和
   设备正在运行的同版本，好让偏移量和文件路径对得上。
2. **OTA 更新本身。** 如果设备去检查一个已知 URL，就抓下这个请求（和[读一份抓包](/zh/posts/reading-a-packet-capture/)
   同一套纪律），直接把产物拉下来。
3. **一个你有权构建的文件系统镜像。** 对开放平台（OpenWrt、Buildroot、Yocto）来说，
   镜像是可复现的；如果你只需要结构，下载那个确切的构建，而不是设备上的那个。

当升级地址不是秘密时，把那个被广而告之的更新拉下来只要一行：

```bash
# 拉取设备自己会去下载的那个 OTA 产物。
curl -O https://firmware.example.net/device/v2.4.1/image.bin

# 留个哈希，让你分析的版本就是你要报告的版本。
sha256sum image.bin | tee image.bin.sha256
```

把哈希记下来。如果你之后要提交报告，厂商需要准确知道你到底解包的是哪个构建。

## 动手提取之前，先认出容器

厂商的 `.bin` 不是单一的文件系统。它通常是一个小 bootloader 加一个内核，再加一个或多
个压缩文件系统，在固定偏移处拼接起来。**binwalk** 把文件当成原始字节来读，匹配每一段
开头的魔数，所以它不需要数据手册就能告诉你手里是什么：

```bash
$ binwalk image.bin

DECIMAL       HEXADECIMAL     DESCRIPTION
--------------------------------------------------------------------------------
0             0x0             uImage header, header size: 64 bytes
                              image name: "Linux-2.6.31"
                              load address: 0x80008000
                              created: 2026-03-14
64            0x40            LZMA compressed data
1572864       0x180000        Squashfs filesystem, little endian,
                              version 4.0, size: 6291456 bytes
8519680       0x820000        JFFS2 filesystem, little endian
```

这份输出就是一张地图。**uImage** 头是 U-Boot 的内核包装——一个 `0x27051956` 魔数、一个
加载地址、一个名字。**Squashfs** 是几乎每一台消费级设备都在用的只读根文件系统：压缩、
按块、构建便宜。**cramfs** 是它更老、更小的表亲。**JFFS2** 是可写的 flash 文件系统，
通常挂在 `/overlay` 或 `/data`，设备把允许改动的部分存在那里。分清哪个是哪个，你就知道
有价值的配置在哪：squashfs 里是出厂默认值，JFFS2 里是设备的运行态。

## 用 binwalk -e 提取固件

`binwalk` 能替你把镜像里每一个识别出的段都切出来。`-e` 提取已知签名，`-M` 递归进入它
发现的内容，`-r` 删掉它无法分类的切出文件：

```bash
# 提取每个签名，并递归进入嵌套镜像。
binwalk -eM image.bin

# 签名镜像：告诉 binwalk 忽略哪些包装。
binwalk -e --dd='.*' image.bin

# 你会得到一个以文件名加上 ".extracted" 命名的目录。
ls _image.bin.extracted/
# 40  40.lzma  180000.squashfs  820000.jffs2
```

如果自动遍历漏掉了某一段——非标准头、加密块——你可以手动按偏移切出来。先在十六进制
转储里找到魔数，再从那里切：

```bash
# 找到 squashfs 的魔数（hsqs），从它的偏移处切。
grep -abo $'\x68\x73\x71\x73' image.bin
dd if=image.bin of=rootfs.squashfs bs=1 skip=$((0x180000))
```

## 解包并挂载文件系统

解 Squashfs 不需要 `binwalk`；`unsquashfs` 是为它量身定做的，会完整保留属主和权限——
当你检查一个权限过宽的密钥文件时，这一点很重要：

```bash
# 解包到 ./squashfs-root，保留权限。
unsquashfs -d squashfs-root 180000.squashfs

# 或者只读挂载，如果你更愿意就地浏览。
sudo mkdir -p /mnt/fw
sudo mount -t squashfs -o loop,ro 180000.squashfs /mnt/fw

# JFFS2 镜像需要通过一个内存块做 MTD 风格的挂载。
sudo modprobe mtdram total_size=131072 erase_size=128
sudo modprobe mtdblock
sudo dd if=820000.jffs2 of=/dev/mtdblock0 bs=1M
sudo mount -t jffs2 /dev/mtdblock0 /mnt/data
```

两个习惯：永远不要读写挂载（你是在检查，不是重建），并保留解包后的目录树，好让你之后
能对两个固件版本做 diff。

## 用 strings 猎捕硬编码凭据

现在进入真正的狩猎。`strings` 会把任何文件里的可打印片段转储出来，包括二进制和压缩块，
而几个 `grep` 模式就能覆盖那些反复出现的惯犯。这是整个审查的核心：

```bash
# 大大方方摆在明面上的密码、密钥与 token。
strings -n 8 squashfs-root/bin/* | grep -Ei 'password|passwd|secret|token|apikey|api_key'

# 设备出厂自带的账号与 shell。
cat squashfs-root/etc/passwd
cat squashfs-root/etc/shadow

# 把配置和硬件黏在一起的脚本，是默认值的金矿。
grep -RIn --exclude-dir=node_modules \
  -Ei 'password|token|secret|BEGIN .*PRIVATE KEY' squashfs-root/etc/
```

真正要紧的发现：

- **带真实哈希的 `/etc/shadow`。** 一个跨整条产品线复用的默认 `root` 密码是经典案例。
  哈希并不总能被破解，但一个空字段或一个已知的厂商哈希就是一个发现。
- **随设备一起发布的私钥。** 找 `BEGIN RSA PRIVATE KEY` 或 `BEGIN PRIVATE KEY`。一台
  和其他每一台都共用同一把私钥的设备，守不住任何 TLS 秘密。
- **带 API token 的配置文件。** 联网设备会把一个共享 token 贴进 `/etc/config`、JSON
  块，或者那些向家里打电话的 shell 脚本里。
- **升级 URL 与预发布主机。** 一个明文 HTTP 的升级地址，或者一个解析到内部预发布服务器
  的主机名，就是设备可能在传输途中被劫持的方式。

## 值得反复 grep 的那些模式

做过几个镜像之后，你就不再是读文件，而是开始读形状。下面四种反复出现，每一种都值得
专门搜一次：

```bash
# 1. TLS 材料：哪些设备共用一把密钥，它的权限又是什么？
find squashfs-root -name '*.key' -o -name '*.pem' -o -name '*.crt' | xargs -r ls -l
openssl rsa -in squashfs-root/etc/ssl/private/server.key -check -noout 2>&1

# 2. Web UI 资源里写死的管理员默认值。
grep -RIn -Ei 'admin|root' squashfs-root/www/ | grep -Ei 'default|password'

# 3. 设备向哪里回连，以及用什么协议。
grep -RIn -Ei 'https?://[a-z0-9.-]+' squashfs-root/etc/ squashfs-root/usr/sbin/ \
  | grep -viE 'localhost|127\.0\.0\.1|example\.com'

# 4. 会解锁调试控制台的启动脚本。
grep -RIn -Ei 'telnetd|dropbear|/bin/sh' squashfs-root/etc/init.d/
```

`openssl rsa -check` 那一行，是确认一把私钥真实且未加密最快的方式。如果它打印出
`RSA key ok` 而没要口令，那这把密钥在保护的东西，实际上什么都没保护。

## 有了发现该做什么：报告，而不是利用

两条规则，让这份工作站得住脚。

第一，**授权使用的边界**。它只适用于你拥有的硬件，或者一个明确处在某个项目范围之内的
目标——厂商的漏洞赏金、一份委托书、一场 CTF。你自己的设备，你自己的工作台，你自己的
报告。拿 `strings` 去扫邻居的摄像头，或者一台没人授权给你的公司路由器，那不是「研究」，
那是未授权访问，而上面这些命令，和攻击者用的完全无法区分。范围，是区分它们的唯一东西。

第二，**负责任披露**。当你发现一把硬编码密钥或一个默认凭据，有用之举不是去演示影响——
而是清楚地告诉厂商：

- 哪个构建（第一步记下的哈希）、哪个文件、哪一行。
- 这个问题打开了什么，用一句话说清。
- 一个最小复现，以及如果可能的话，一个修复——轮换密钥、在首次启动时生成每台设备独有的
  秘密、升级强制走 HTTPS。
- 一条私有渠道，以及一个你愿意守住的披露期限。

在写任何公开内容之前，给他们时间去轮换密钥并发布更新。适用于[加固一台公网服务器](/zh/posts/hardening-a-public-server/)
的那套纪律，在这里从另一侧同样成立：你是在从源头上减少那些可以从设备上被顺手提走的共享
秘密。而当设备是一台 BLE 小玩意而不是路由器时，这些技能也能干净地迁移——当初驱动
[逆向一台 BLE 设备](/zh/posts/reverse-engineering-a-ble-device/) 的那份耐心，正是让你
一直读一棵 squashfs 树、直到那个 token 掉出来的东西。

## 一份简短清单

- 从厂商页面或 OTA URL 拿到镜像；记录它的哈希。
- 提取之前，先跑 `binwalk image.bin` 并读懂那张地图。
- `binwalk -eM` 切出各段；`unsquashfs` 解包根文件系统。
- 用 `strings` 加上有针对性的 `grep`，找密码、token 和私钥。
- 检查 `/etc/shadow`、`/etc/config`、Web 资源和启动脚本。
- 用 `openssl` 确认密钥材料；记下文件权限。
- 通过私有渠道报告，并附上可复现的构建引用。

**固件分析**的意义，不在于证明你能闯进去。而在于具体地知道，你自己的设备身上都带着
什么——并把这知识变成一个修复，而不是一件新鲜事。提取固件，读文件系统，grep 出那些
没人打算发布的秘密，然后把你的发现报出去。
