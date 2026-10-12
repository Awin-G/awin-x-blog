---
title: "把对象存储搬回家：用 MinIO 搭一套自己的 S3-compatible storage"
description: "对象存储（object storage）到底怎么运作：扁平命名空间、整对象写入、为什么 S3 API 会胜出，以及如何在本机跑 MinIO。含真实命令与输出：建 bucket、上传下载、bucket policy、presigned URL、versioning、lifecycle 规则，以及用 S3 SDK 从代码访问——外加它的真实边界和适用场景。"
pubDate: 2026-12-17
lang: zh
translationKey: minio-and-s3
tags: [self-hosting, devops, nginx]
featured: false
keywords:
  - MinIO
  - S3-compatible storage
  - object storage
  - presigned URL
  - bucket policy
  - 版本控制
  - S3 SDK
---

对象存储（object storage）是少数几个即便你从不租用云服务也值得学的云原语之一。几乎每个应用迟早都会攒下一堆既不是数据库里的一行、也不是工作磁盘上一个文件的字节：用户上传、媒体、备份、日志、模型产物。**对象存储**就是这堆字节想要的形状，而 **S3-compatible storage** 是你在自己硬件上得到这个形状的方式。我在自己的机器上跑 **MinIO**，一个小巧的 S3 兼容服务器。这篇就是我当初最想先读到的内容。

于是我起了一个用完即弃的 MinIO 在 `127.0.0.1` 上，把整条链路走了一遍：建 bucket、上传、逐字节校验的下载、**bucket policy**、**presigned URL**、**versioning**、一条 lifecycle 规则，再用 Python 配合 **S3 SDK** 把同样的操作重做一次。下面每一段都是那次运行的真实输出。

## 什么是对象存储（object storage）

先把「文件夹」放一放。对象存储是一个扁平命名空间的 **bucket**，每个 bucket 内部又是一个扁平命名空间的 **object**。一个对象由三部分拼成：**key**（它的名字，一个字符串）、**value**（字节），以及一小包 **metadata**（content type、大小、ETag，以及你附加的任何东西）。

扁平就是它的全部设计：API 里没有嵌套目录。当你看到 `app-backups/2026-12-17/db.dump`，那是一个 key；斜杠只是客户端用来「画出」层级的约定，服务端并不存储层级。换来的好处很直接——按前缀列举、把命名空间分片、从任意节点提供任意 key，全都变得平凡，因为 key 是唯一的身份。

另一半在于怎么写。你不会 seek 到对象中间改 30 个字节；你是上传并替换整个对象。写入在 key 级别是原子的——读的人要么看到旧版本，要么看到新版本，永远看不到写了一半的。对不可变的东西（一张照片、一份数据库 dump、一段日志）极好，对需要原地编辑的东西（一个 SQLite 文件、一个你反复重写的 Git pack）就别扭。

## 它和文件系统、块设备有什么不同

这三层经常被混为一谈。

- **块设备**是裸存储：按编号寻址的定长块，完全不知道「文件」是什么。文件系统或数据库坐在它上面，决定这些块的含义。最低、最快、最危险——必须有人负责布局。
- **文件系统**（ext4、ZFS、APFS）在块设备上放一棵文件和目录的树，带权限、`fsync`、随机访问和原地编辑。它说 POSIX，进程默认它存在。
- **对象存储**是故意把这些全扔掉：没有部分写、没有文件句柄、没有 `seek`、没有 rename。换来的是一套 HTTP API、近乎无限的规模，以及没有 inode 会用完。

<figure>
<svg viewBox="0 0 640 190" width="100%" role="img" aria-label="客户端对着 S3 HTTP API 说话，API 再把对象存进 bucket。对象由 key 寻址；key 里的斜杠只是一个标签，不是真正的目录。">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="14" y="66" width="126" height="56" rx="8"/>
    <rect x="238" y="66" width="150" height="56" rx="8"/>
    <rect x="486" y="24" width="140" height="52" rx="8"/>
    <rect x="486" y="104" width="140" height="52" rx="8"/>
    <path d="M140 94 h90" marker-end="url(#a)"/>
    <path d="M388 82 h60 l0 -32 h30" marker-end="url(#a)"/>
    <path d="M388 106 h60 l0 24 h30" marker-end="url(#a)"/>
  </g>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="77" y="90">客户端</text>
    <text x="77" y="108" opacity="0.75">SDK / mc / curl</text>
    <text x="313" y="90">S3 API</text>
    <text x="313" y="108" opacity="0.75">PUT · GET · LIST (HTTP)</text>
    <text x="556" y="45">bucket: app-backups</text>
    <text x="556" y="63" opacity="0.75">2026-12-17/db.dump</text>
    <text x="556" y="125">bucket: media</text>
    <text x="556" y="143" opacity="0.75">uploads/avatar.png</text>
  </g>
</svg>
<figcaption>一套 HTTP API、扁平的 bucket、key 是唯一的身份。斜杠只是一个标签，不是目录树。</figcaption>
</figure>

## 为什么 S3 的 API 成了标准

Amazon 在 2006 年发布 S3，这套 API 随后渗得到处都是。今天「S3 兼容」是几十款产品上的一个勾选项——MinIO、Ceph RGW、SeaweedFS、Garage、Cloudflare R2、Backblaze B2，以及每一朵大云里的对象存储。它们在线路协议上达成一致（动词、签名、错误 XML），所以同一份客户端代码能对它们所有人说话。

这份一致关乎的是可移植性，而不是品牌。当你的应用用 **S3 SDK** 对着一个 S3 endpoint 说话，endpoint 只是一个你能改的 URL：在笔记本上对着 MinIO 开发，部署时对着你服务器上的 MinIO，明年迁移到云上的 bucket 而不用动存储层。厂商花了很多年推销自己的私有 SDK；市场选择了那个无聊但开放的。

## 在自己的机器上跑 MinIO

MinIO 是一个 Go 写的单一二进制，会讲 S3 API，把对象存到本地磁盘。在笔记本上，它就是一个容器的安装：

```bash
docker run -d --name minio \
  -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin123 \
  -v "$PWD/data:/data" \
  elestio/minio:latest server /data --console-address ":9001"
```

端口 `9000` 是 S3 API，`9001` 是浏览器控制台。把 MinIO 客户端 `mc` 指过去，它会告诉你它是什么：

```console
$ mc alias set local http://127.0.0.1:9000 minioadmin minioadmin123
Added `local` successfully.

$ mc admin info local
●  127.0.0.1:9000
   Uptime: 4 minutes
   Version: 2025-09-07T16:13:09Z
   Network: 1/1 OK
   Drives: 1/1 OK
   Pool: 1
   ...
1 drive online, 0 drives offline, EC:0
```

那个 `EC:0` 不是错误——它是单盘、单节点部署的诚实真相，后面还会回来。注意镜像名：2026 年 MinIO 的社区版转为「仅源代码」，`minio/minio` 这个 Docker 镜像也从 Docker Hub 被撤下。像 `elestio/minio` 这样的重新打包镜像（货真价实的 MinIO，一个冻结的 release）仍然可用，你也可以从源码构建——但请有意识地选镜像源，并锁定 digest。

它适合放在哪？对象存储永远适合的三个地方：**备份**（restic 或 rclone 的目标，也是 [3-2-1 方案](/zh/posts/backups-you-can-restore/) 里异地的那一份）、**媒体**（照片、音频、视频，由你的应用经 CDN 提供），以及**应用 blob**（用户上传、导出、任务产物）。日志和 ML 数据集也同样适合。这些都不需要 Docker——见[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)。

## 建一个 bucket，传几个对象，走一次往返

建 bucket、放文件进去、列出来、再拉回来：

```console
$ mc mb local/app-backups
Bucket created successfully `local/app-backups`.

$ mc cp db.dump local/app-backups/2026-12-17/db.dump
`db.dump` -> `local/app-backups/2026-12-17/db.dump`
┌──────────┬─────────────┬──────────┬─────────────┐
│ Total    │ Transferred │ Duration │ Speed       │
│ 4.00 KiB │ 4.00 KiB    │ 00m00s   │ 63.38 KiB/s │
└──────────┴─────────────┴──────────┴─────────────┘

$ mc ls --recursive local/app-backups
[2026-12-12 17:51:40 CST] 4.0KiB STANDARD 2026-12-17/db.dump
[2026-12-12 17:51:40 CST]    44B STANDARD 2026-12-17/schema.sql

$ mc stat local/app-backups/2026-12-17/db.dump
Name      : db.dump
Size      : 4.0 KiB
ETag      : fa17670e005793d1d9286e6c92a90417
Type      : file
Metadata  :
  Content-Type: application/octet-stream
```

`mc cp --recursive` 拉回磁盘，再对原文件 `cmp`——逐字节一致，这是唯一算数的恢复测试。

## 访问控制：bucket policy 与 presigned URL

bucket 默认是私有的；授权有两种方式。**bucket policy** 是挂在 bucket 上的一份 JSON 文档，持久地说明谁能做什么。**presigned URL** 则是一次性的、会过期的能力——一个普通 URL，带上签名，让任何持有它的人取到某一个对象，而无需看到你的凭据。

这是一个公开只读的 policy，就是 MinIO 报告的确切 JSON：

```console
$ mc anonymous set download local/app-backups
Access permission for `local/app-backups` is set to `download`

$ mc anonymous get-json local/app-backups
{"Statement":[{"Action":["s3:GetBucketLocation","s3:ListBucket"],"Effect":"Allow","Principal":{"AWS":["*"]},"Resource":["arn:aws:s3:::app-backups"]},{"Action":["s3:GetObject"],"Effect":"Allow","Principal":{"AWS":["*"]},"Resource":["arn:aws:s3:::app-backups/*"]}],"Version":"2012-10-17"}

$ curl -s http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql
CREATE TABLE users (id bigint primary key);
```

把 policy 改回私有，同一个 URL 就被拒绝：

```console
$ mc anonymous set none local/app-backups
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql
403
<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied.</Message><Key>2026-12-17/schema.sql</Key>...
```

现在看 presigned URL。不改 policy、不做公开 bucket——只是一条会过期的签名链接：

```console
$ mc share download --expire 2h local/app-backups/2026-12-17/schema.sql
Share: http://127.0.0.1:9000/app-backups/2026-12-17/schema.sql?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=minioadmin%2F20261212%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261212T095141Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=host&X-Amz-Signature=b4d6727750e6fee37d7a65017553d287102704f603eee1589e729c44a08f2962

$ curl -s -o /dev/null -w '%{http_code}\n' "$SHARE_URL"
200
```

签名是用你的密钥、对请求、过期时间和方法计算出来的。任何拿到这个 URL 的人，在过期前只能做那一件事；篡改它、或等过 `X-Amz-Expires`，你就会拿到 403。这正是「下载这份报告」链接背后的做法：应用签一个 URL 丢给浏览器，而不是替你代理字节或暴露凭据。

## versioning 与 lifecycle 规则

**versioning** 把覆盖变成新版本。开启它，覆盖一个 key，两份都还在：

```console
$ mc version enable local/app-backups
local/app-backups versioning is enabled

$ mc ls --versions local/app-backups/2026-12-17/schema.sql
[2026-12-12 17:51:41 CST] 56B STANDARD 055952a6-8aab-4ff2-afe4-8de90a20756a v2 PUT schema.sql
[2026-12-12 17:51:40 CST] 44B STANDARD null v1 PUT schema.sql
```

然后 **lifecycle 规则**按计划清理，让 versioning 不会无限增长：

```console
$ mc ilm rule add --expire-days 30 --prefix app-backups/2026-12-17/ local/app-backups
Lifecycle configuration rule added with ID `db6arbboe50boqrrig0g` to local/app-backups.

$ mc ilm rule ls local/app-backups
┌──────────────────────┬─────────┬─────────────────────────┬──────┬────────────────┐
│ ID                   │ STATUS  │ PREFIX                  │ TAGS │ DAYS TO EXPIRE │
├──────────────────────┼─────────┼─────────────────────────┼──────┼────────────────┤
│ db6arbboe50boqrrig0g │ Enabled │ app-backups/2026-12-17/ │ -    │             30 │
└──────────────────────┴─────────┴─────────────────────────┴──────┴────────────────┘
```

versioning 加 lifecycle 就是完整的保留策略：保留每一次改动、让旧的过期、不再为它付费。

## 用 S3 SDK 从代码里访问

**S3 SDK** 讲的是同一个 endpoint。Python（`boto3`）里：

```python
import boto3, urllib.request
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="http://127.0.0.1:9000",
    aws_access_key_id="minioadmin",
    aws_secret_access_key="minioadmin123",
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)

print("buckets:", [b["Name"] for b in s3.list_buckets()["Buckets"]])
s3.put_object(Bucket="app-backups", Key="2026-12-17/app.log",
              Body=b'{"level":"info","msg":"hello from boto3"}\n')
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "app-backups", "Key": "2026-12-17/app.log"},
    ExpiresIn=3600,
)
print(url)
print(urllib.request.urlopen(url).read().decode())
```

```console
buckets: ['app-backups']
put app.log
      42  2026-12-17/app.log
    4096  2026-12-17/db.dump
      56  2026-12-17/schema.sql
presigned url:
  http://127.0.0.1:9000/app-backups/2026-12-17/app.log?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=minioad...
GET via presigned url -> 200 {"level":"info","msg":"hello from boto3"}
content-type: binary/octet-stream | etag: "37e784f64107305eac5ea5f9ced3e43a"
```

把 `endpoint_url` 一换，同一份代码就对着云上的 bucket 跑。这就是可移植性兑现时的那一行。

## 诚实的边界

这些失败模式是可预期的，只要你把它们点出来：

- **它不是 POSIX 文件系统。** 没有部分写、没有 `seek`、没有原子 rename、没有文件锁。把它挂载成「磁盘」（s3fs、JuiceFS）能用，但会把这种错配泄漏成延迟和一致性上的意外。
- **它不是数据库。** 没有查询、没有事务、没有对你字节的索引。结构化数据放真数据库；blob 放对象存储。
- **单节点不是高可用。** 一个磁盘上跑一个 MinIO，就是单点故障：停掉容器，一切下线；丢了磁盘，一切消失。做缓存或可重建的副本可以，但它本身不是备份。
- **纠删码需要磁盘。** 只有当它有多块盘来展开数据和校验时，MinIO 才开始容忍故障。单节点四块盘会报告 `EC:2`：可以消失两块而数据存活。一块盘报告 `EC:0`——也就是零冗余：

  ```console
  4 drives online, 0 drives offline, EC:2
  ```

- **API 有锋利的边角。** 在巨大的前缀上列举很贵；一次覆盖会重写整个对象，除非你用 multipart 上传；每请求和小对象的开销会累积；一致性在各家 S3 兼容后端之间也并非完全一致。

## 什么时候该用它

当数据满足这些时，就上 S3 兼容的对象存储：

- **大、且基本一次写完** —— 照片、视频、音频、PDF、归档。
- **通过 HTTP 提供** —— 任何该由浏览器或 CDN 按 URL 取的东西。
- **被备份或复制的** —— 备份方案里异地/第三份的那条腿。
- **只追加或需要版本化** —— 日志、事件、模型 checkpoint、导出。
- **临时或可再生的** —— 缓存、构建产物、草稿空间。

不要把它当数据库、当工作文件系统，或当作任何东西的唯一副本——这三个同样的错误，就是烧掉周末的原因。

我总是一次次回到对象存储，因为这个抽象小而诚实：bucket 和 key、一套 HTTP API、一个可移植的客户端。MinIO 让我在能掌控的硬件上拿到它，同时保留一条随时走向云 bucket 的路——以及随时走回来的路。如果你还没试过，起一个、把一份 dump 放进 bucket、再拉回来验证往返。那十五分钟的测试，胜过任何架构图。
