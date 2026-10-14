---
title: "容器镜像层与摘要：镜像里面到底是什么"
description: "容器镜像是一个有序的文件系统层栈加上一个配置文件。了解 Dockerfile 如何映射到层、层的顺序为何影响缓存复用，以及标签与摘要的区别。"
pubDate: 2027-01-29
lang: zh
translationKey: container-image-layers-and-digests
tags: [devops]
featured: false
keywords:
  - 容器镜像层
  - 镜像摘要
  - docker history
  - 层缓存
  - docker save
---

# 容器镜像层与摘要：镜像里面到底是什么

## 引言

当你拉取一个容器镜像时，你下载的并不是一个单一的整体文件。你获取的是一个有序的文件系统层栈——每一层都是以某种方式改变文件系统的 diff——加上一个将它们串联在一起的小型 JSON 配置文件。理解这一结构是构建更小镜像、调试构建失败、以及理解你的构建为什么快（或慢得痛苦）的关键。

我之前写过关于[保持容器镜像小巧](/zh/posts/container-image-size/)和[为供应链安全对镜像签名](/zh/posts/container-image-signing/)的文章。这篇帖子深入一层：镜像里面到底是什么、Dockerfile 如何映射到层、以及标签和摘要之间的区别为什么在生产环境中很重要。

## 镜像是一个有序层栈 + 配置

让我从一个最小的 Dockerfile 开始：

```dockerfile
FROM alpine:3.20
RUN echo "layer 1: base packages" > /tmp/layer1.txt
RUN echo "layer 2: dependencies" > /tmp/layer2.txt
RUN echo "layer 3: application code" > /tmp/layer3.txt
```

当我构建这个镜像时，Docker 创建了四层：一层来自基础镜像，每层 `RUN` 指令各一层。每一层都是一个文件系统 diff——相对于下面一层的一组文件添加、修改和删除。这些层按顺序堆叠，结果就是你运行容器时看到的最终文件系统。

这是 `docker history` 对这个镜像显示的内容：

```
IMAGE                                                                     CREATED         CREATED BY                                                                     SIZE      COMMENT
sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e   6 seconds ago   RUN /bin/sh -c echo "layer 3: application code" > /tmp/layer3.txt # buildkit   12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 seconds ago   RUN /bin/sh -c echo "layer 2: dependencies" > /tmp/layer2.txt # buildkit       12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 seconds ago   RUN /bin/sh -c echo "layer 1: base packages" > /tmp/layer1.txt # buildkit      12.3kB    buildkit.dockerfile.v0
<missing>                                                                 6 months ago    CMD ["/bin/sh"]                                                                0B        buildkit.dockerfile.v0
<missing>                                                                 6 months ago    ADD alpine-minirootfs-3.20.10-x86_64.tar.gz / # buildkit                       8.47MB    buildkit.dockerfile.v0
```

每一行是一个层。`CREATED BY` 列显示创建它的指令。`SIZE` 列显示该层增加了多少磁盘空间。基础镜像层（alpine minirootfs 的 `ADD`）是 8.47 MB；我的每个 `RUN` 层增加约 12.3 kB。

但 `docker history` 是一个高层视图。要查看实际的层标识符，我需要使用 `docker inspect`：

```json
["sha256:08bc4e534116aa76b16015484b82eac51f9a593416feae9296c8a2d4bb7aa4a2","sha256:15557c6af6d921a21adddf322fc6ff6af50bcb44c297284f1c97eed5b618320c","sha256:6c478fc0094f343465131e664ccd4f63ae420e7d6fb45e1ee18a41ec3de78008","sha256:5568d20119c078835bdbf777e6a55eca93e3ee7962654058a9bbd362df1f7b87"]
```

这些是 `diff_ids`——每一层的内容寻址标识符。每一个都是该层未压缩 tar 包的 SHA-256 哈希。如果内容改变，哈希就会改变。这就是层不可变且可缓存的原因。

<figure>
<svg viewBox="0 0 420 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="容器镜像层栈示意图">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="39" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">config.json</text>
  <line x1="180" y1="52" x2="180" y2="66" stroke="#0f766e" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="40" y="68" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="91" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 3: app code</text>
  <text x="330" y="91" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:5568…</text>
  <rect x="40" y="112" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="135" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 2: dependencies</text>
  <text x="330" y="135" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:6c47…</text>
  <rect x="40" y="156" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="179" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">layer 1: base packages</text>
  <text x="330" y="179" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:1555…</text>
  <rect x="40" y="200" width="280" height="36" rx="4" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="180" y="223" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="currentColor">base: alpine:3.20</text>
  <text x="330" y="223" text-anchor="start" font-family="ui-monospace, monospace" font-size="10" fill="#0f766e">sha256:08bc…</text>
</svg>
<figcaption>图 1 — 容器镜像是一个有序的层栈，每层由摘要进行内容寻址，加上一个将它们串联在一起的配置。</figcaption>
</figure>

## Dockerfile 如何映射到层

经验法则是：**一条指令 ≈ 一层**。每个 `RUN`、`COPY`、`ADD` 和 `WORKDIR` 指令都会创建一个新层。但也有例外：

- `FROM` 不创建层——它引用基础镜像的层。
- `ENV`、`LABEL`、`EXPOSE`、`CMD`、`ENTRYPOINT` 不创建文件系统层——它们只修改镜像配置。
- 多阶段构建让你可以将文件从一个阶段复制到另一个阶段，创建一个只包含复制文件的新层。

关键洞察是层是 **文件系统 diff**。修改文件的 `RUN` 指令会创建一个包含这些修改的层。`COPY` 指令会创建一个包含复制文件的层。只设置元数据的指令根本不创建文件系统层。

## 层的顺序为何影响层缓存复用

Docker 基于指令及其下面的层来缓存层。如果你改变一个指令，该层和所有后续层都会被重建。这就是为什么 Dockerfile 中指令的顺序如此重要。

让我来演示。我再次构建镜像——这次，所有层都命中缓存：

```
#5 [2/4] RUN echo "layer 1: base packages" > /tmp/layer1.txt
#5 CACHED

#6 [3/4] RUN echo "layer 2: dependencies" > /tmp/layer2.txt
#6 CACHED

#7 [4/4] RUN echo "layer 3: application code" > /tmp/layer3.txt
#7 CACHED
```

现在我改变第二条指令并重新构建：

```dockerfile
FROM alpine:3.20
RUN echo "layer 1: base packages" > /tmp/layer1.txt
RUN echo "layer 2: CHANGED dependencies" > /tmp/layer2.txt
RUN echo "layer 3: application code" > /tmp/layer3.txt
```

```
#5 [2/4] RUN echo "layer 1: base packages" > /tmp/layer1.txt
#5 CACHED

#6 [3/4] RUN echo "layer 2: CHANGED dependencies" > /tmp/layer2.txt
#6 DONE 0.3s

#7 [4/4] RUN echo "layer 3: application code" > /tmp/layer3.txt
#7 DONE 0.4s
```

第一层仍然命中缓存。第二层因为指令改变而重建。第三层也被重建——即使它的指令没有改变——因为它位于一个改变了的层之上。这就是经典的缓存失效级联。

实用规则：**将指令从最少改变到最多改变排序**。把稳定的指令（基础镜像、系统包）放在顶部，把易变的指令（应用代码、配置）放在底部。这样，当你改变代码时，只有顶部层会重建。

## 标签是可变指针，摘要是不可变的

像 `layerdemo:1.0` 这样的标签只是指向镜像摘要的指针。摘要是镜像清单的 SHA-256 哈希——一个列出层和配置的 JSON 文件。当你按标签拉取时，Docker 将标签解析为摘要，然后下载层。

这是 `docker images --digests` 显示的内容：

```
REPOSITORY   TAG       DIGEST                                                                    IMAGE ID       CREATED          SIZE
layerdemo    1.1       sha256:93e5d1a900d1b55462a5aa647321faf68bd172474d495487fc203f7adf79b2aa   93e5d1a900d1   17 seconds ago   12.1MB
layerdemo    1.0       sha256:5da614f4ff00d3b0f8cc63f87287a7101f3f6b314c21998b3bb4d64e396d44f2   5da614f4ff00   47 seconds ago   12.1MB
```

两个标签指向不同的摘要。如果我将 `layerdemo:1.0` 重新标记为指向 `1.1` 镜像，标签会移动但摘要保持不变。摘要是不可变的——它是内容的哈希。标签是可变的——它只是一个标签。

这就是为什么你应该在生产环境中固定摘要：

```dockerfile
# 不要这样：
FROM alpine:3.20

# 应该这样：
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
```

当你固定摘要时，你是在说"我要的是确切的这个镜像，而不是标签当前指向的任何镜像"。这可以保护你免受有人推送具有相同标签的新镜像时意外变更的影响。

## 使用 docker history 和 docker inspect 检查层

`docker history` 给你一个人类可读的层视图。`docker inspect` 给你原始数据。这是 `docker inspect` 显示的镜像 ID、摘要和大小：

```
Id: sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e
RepoDigests: [layerdemo@sha256:e6a754da7a55583f89156772e9c6e9df6b7fbb5102f99f8a19181ecb7ccfc63e]
RepoTags: [layerdemo:1.0]
Created: 2026-10-14T10:23:53.661439017+08:00
Size: 12140611
Architecture: amd64
Os: linux
```

`Id` 是镜像摘要。`RepoDigests` 显示带有仓库名称的摘要。`RepoTags` 显示标签。`Size` 是所有层的总大小。

## 经典的 apt-get 陷阱

最著名的层缓存陷阱是 `apt-get update` 和 `apt-get install` 模式。考虑这个 Dockerfile：

```dockerfile
# 不好——可能使用过期的包列表
FROM alpine:3.20
RUN apk update
RUN apk add curl
```

如果 `apk update` 层被缓存，但包列表自构建以来已经改变，`apk add` 层将使用过期的列表。这可能导致"Unable to locate package"或"Hash sum mismatch"等错误。

修复方法是将它们合并在一个 `RUN` 中：

```dockerfile
# 好——总是使用最新的包列表
FROM alpine:3.20
RUN apk update && apk add curl
```

现在当 `apk add` 运行时，包列表总是最新的，因为它们在同一个层中。如果任一命令失败，整个层都会失败——没有过期缓存。

这是不好模式构建时的输出：

```
#5 [2/3] RUN apk update
#5 0.236 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz
#5 1.009 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz
#5 1.661 OK: 24171 distinct packages available
#5 DONE 1.8s

#6 [3/3] RUN apk add curl
#6 0.593 (1/10) Installing ca-certificates (20260413-r0)
#6 1.911 (2/10) Installing brotli-libs (1.1.0-r2)
#6 14.57 (3/10) Installing c-ares (1.33.1-r0)
#6 17.73 (4/10) Installing libunistring (1.2-r0)
#6 37.08 (5/10) Installing libidn2 (2.3.7-r0)
#6 39.51 (6/10) Installing nghttp2-libs (1.62.1-r0)
#6 42.13 (7/10) Installing libpsl (0.21.5-r1)
#6 43.86 (8/10) Installing zstd-libs (1.5.6-r2)
#6 55.38 (9/10) Installing libcurl (8.14.1-r2)
#6 68.51 (10/10) Installing curl (8.14.1-r2)
#6 75.04 OK: 13 MiB in 24 packages
#6 DONE 75.1s
```

好的模式：

```
#5 [2/2] RUN apk update && apk add curl
#5 0.213 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz
#5 0.928 fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz
#5 1.480 OK: 24171 distinct packages available
#5 1.877 (1/10) Installing ca-certificates (20260413-r0)
#5 2.431 (2/10) Installing brotli-libs (1.1.0-r2)
#5 2.633 (3/10) Installing c-ares (1.33.1-r0)
#5 2.724 (4/10) Installing libunistring (1.2-r0)
#5 2.897 (5/10) Installing libidn2 (2.3.7-r0)
#5 2.991 (6/10) Installing nghttp2-libs (1.62.1-r0)
#5 3.086 (7/10) Installing libpsl (0.21.5-r1)
#5 3.174 (8/10) Installing zstd-libs (1.5.6-r2)
#5 3.291 (9/10) Installing libcurl (8.14.1-r2)
#5 3.404 (10/10) Installing curl (8.14.1-r2)
#5 3.536 OK: 13 MiB in 24 packages
#5 DONE 3.7s
```

好的模式也更快——3.7 秒 vs 75.1 秒——因为它只有一层而不是两层。

## docker save 和层 tar 包

当你用 `docker save` 保存镜像时，你会得到一个包含层、配置和清单的 tar 包。让我保存镜像并查看内部：

```bash
$ docker save layerdemo:1.0 -o layerdemo.tar
$ tar -tf layerdemo.tar
blobs/
blobs/sha256/
blobs/sha256/0a7b9a4bc63fd1d622ecd987daffa9d4b4a6eb89f62300a5bdc7d3e95188d57a
blobs/sha256/25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471
blobs/sha256/295ba08d54c41bf5b2044e3b768dd31ca4a80e9b2b7ff2583f0d7a8c0d891fbe
blobs/sha256/44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
blobs/sha256/4f0e48994f944df6fa91399f5b8e9991154d0708da055ffbae4142c8b6b4ca14
blobs/sha256/5da614f4ff00d3b0f8cc63f87287a7101f3f6b314c21998b3bb4d64e396d44f2
blobs/sha256/607546c4c2b137ab9a3b55fde920524631254e2d20087b109aeba194076e2734
blobs/sha256/7d8a5cda0a0bac9c4e32c7456caaf800f714a019c3b5675d78af3af2b200fc00
blobs/sha256/bb567b26d20069c7a83b69f7d738ed78b061520aa0b079a7a5560276ef28192d
blobs/sha256/ffae3594a09779c9cde72982cdf2c63f9d22786b6f3477bca4f4202328e6dfbf
index.json
manifest.json
oci-layout
```

`blobs/sha256/` 目录包含实际的层 tar 包和配置。`manifest.json` 将它们映射在一起：

```json
[
    {
        "Config": "blobs/sha256/ffae3594a09779c9cde72982cdf2c63f9d22786b6f3477bca4f4202328e6dfbf",
        "RepoTags": [
            "layerdemo:1.0"
        ],
        "Layers": [
            "blobs/sha256/25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471",
            "blobs/sha256/bb567b26d20069c7a83b69f7d738ed78b061520aa0b079a7a5560276ef28192d",
            "blobs/sha256/0a7b9a4bc63fd1d622ecd987daffa9d4b4a6eb89f62300a5bdc7d3e95188d57a",
            "blobs/sha256/607546c4c2b137ab9a3b55fde920524631254e2d20087b109aeba194076e2734"
        ]
    }
]
```

`Config` 是镜像配置 JSON。`Layers` 是按顺序排列的层 tar 包。每个层 tar 包包含该层的文件系统 diff。

## 实用规则

基于以上内容，以下是处理容器镜像层的实用规则：

1. **将指令从最少改变到最多改变排序。** 稳定的指令放在顶部，易变的放在底部。这最大化缓存复用。

2. **在生产环境中固定摘要。** 使用 `image@sha256:...` 而不是 `image:tag`，以确保你总是得到你期望的确切镜像。

3. **保持层小巧。** 每层都会增加最终镜像的大小。在创建临时文件的同一个 `RUN` 指令中清理它们。

4. **合并相关命令。** 在一个 `RUN` 中使用 `apt-get update && apt-get install` 避免过期缓存陷阱并减少层数。

5. **使用多阶段构建。** 在一个阶段中构建，只将制品复制到最终阶段。这保持最终镜像小巧。

6. **推送前检查。** 在推送镜像到仓库之前，使用 `docker history` 和 `docker inspect` 了解镜像中的内容。

## 结论

容器镜像不是一个黑盒。它是一个有序的文件系统层栈，每层由摘要进行内容寻址，由一个配置串联在一起。理解这一结构帮助你构建更小的镜像、更快地调试构建失败、以及更好地决定缓存和固定策略。下次运行 `docker build` 时，记住：每条指令是一个层，每层有一个摘要，顺序很重要。
