---
title: "逐层拆解容器镜像体积：从 1.35 GB 缩到 8 MB"
description: "我用五种方式在同一台机器上构建同一个 Go 小服务——单阶段 golang、多阶段 distroless/alpine/scratch、以及一个臃肿的 Debian 层堆栈——并逐层贴出真实的 docker images 与 docker history 数字。还包括 COPY 顺序、构建缓存命中、.dockerignore，以及 20 MB 镜像未必更好的时候。"
pubDate: 2026-12-19
lang: zh
translationKey: container-image-size
tags: [devops]
featured: false
keywords:
  - 容器镜像体积
  - 多阶段构建
  - distroless
  - docker history
  - .dockerignore
---

我拿一个很小的 Go 服务——一个健康检查接口，两个很小的依赖——在同一台机器上用五种方式构建，然后用 `docker images` 和 `docker history` 逐一量了它们的体积。最差的是 **1.35 GB**，最好的是 **7.95 MB**。同一个程序、同样的功能、同一台宿主。**容器镜像体积**就是那种你不去管它就没事、直到某次部署从三秒变成九分钟的数字。所以这篇就是逐层的账本：这些兆字节到底从哪来，**多阶段构建**究竟丢掉了什么，`distroless`、`alpine`、`scratch` 各自怎么取舍，以及怎么从 **docker history** 里把这一切读出来。

## 为什么容器镜像体积很重要

有四项成本会随镜像变大，其中只有一项是磁盘：

- **拉取时间。** 在 20 Mbit/s 下，1.35 GB 意味着容器跑起来之前要先花大约九分钟下载；8 MB 只要三秒多一点。共享层能帮忙，但只对节点上已经有的层有效。
- **冷启动与自动扩缩容。** 新节点必须先拉完才能响应。如果你的自动扩缩容要 90 秒才能真正干活，那原因往往就是这个镜像。
- **攻击面。** 基础镜像里的每一个包，都是你发布出去、并且今后要跟着打补丁的代码。光是 `golang:1.23` 这个基础镜像解压后就有 927 MB，带着 shell、包管理器、编译器和 C 工具链——而一个正在运行的 Go 二进制一个都不需要。
- **存储与带宽。** 镜像仓库按存储计费，每个拉取的节点都要付带宽。把 1.35 GB 乘以每天十次部署和一个小机群。

## 这些字节到底从哪来

先看最朴素的 Dockerfile：单阶段，全都发出去。

```dockerfile
FROM golang:1.23          # docker images 报告 1.24 GB
WORKDIR /src
COPY . .
RUN go build -o /app ./...
CMD ["/app"]
```

```console
$ docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep sizedemo
sizedemo:naive        1.35GB
sizedemo:multistage   14.1MB
sizedemo:alpine       21.8MB
sizedemo:scratch      7.95MB
sizedemo:layers-bad   572MB
sizedemo:layers-good  537MB
```

`docker history` 把 1.35 GB 的位置指得清清楚楚：

```console
$ docker history sizedemo:naive
IMAGE          CREATED          CREATED BY                                       SIZE      COMMENT
50b707acd047   12 minutes ago   /bin/sh -c #(nop)  CMD ["/app"]                  0B
078f104cfbcd   12 minutes ago   /bin/sh -c #(nop)  EXPOSE 8080                   0B
9b07b4f3180c   12 minutes ago   |1 GOPROXY=https://goproxy.cn,direct /bin/sh…    92.1MB
c1f7af6a6cc0   13 minutes ago   /bin/sh -c #(nop) COPY dir:2c88684b0f50c202f…    24.6kB
a4a8e2d02a18   13 minutes ago   /bin/sh -c #(nop) WORKDIR /src                    8.19kB
60deed95d388   14 months ago    WORKDIR /go                                      4.1kB     buildkit.dockerfile.v0
...
```

肥胖有三个彼此独立的来源，全都藏在这六行里：

- **臃肿的基础镜像。** `WORKDIR /go` 下面那十一层就是 `golang:1.23`——927 MB 的工具链，被一路发到了生产环境。
- **构建工具链和它的缓存挤在同一层里。** 那个 92.1 MB 的 `RUN go build` 层并不是二进制本身。二进制只有 5.5 MB，其余都是 Go 的构建缓存（`/root/.cache/go-build`），`go build` 把它写进了这一层，之后你删不掉。
- **一个 `RUN` 一层，而删除删不掉。** 层是不可变的。你在一个 `RUN` 里装了东西、在下一个 `RUN` 里 `rm` 掉，字节依然留在更早的那一层。换成 Debian 是同一个道理：

```dockerfile
# 差：在后面的层里才清理
FROM debian:bookworm-slim
RUN apt-get update
RUN apt-get install -y --no-install-recommends build-essential
RUN rm -rf /var/lib/apt/lists/*
```

```dockerfile
# 好：装和清放在同一个 RUN 里
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
```

```console
$ docker history sizedemo:layers-bad
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
c5f17e613c10   8 minutes ago   /bin/sh -c rm -rf /var/lib/apt/lists/*            20.5kB
7b414c164866   8 minutes ago   /bin/sh -c apt-get install -y --no-install-r…    319MB
ee94f9007749   9 minutes ago   /bin/sh -c apt-get update                        19.8MB
7c7b2c966bc9   7 days ago      # debian.sh --arch 'amd64' out/ 'bookworm' …     85.3MB    debuerreotype 0.17

$ docker history sizedemo:layers-good
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
a0d01049fd3f   5 minutes ago   /bin/sh -c apt-get update  && apt-get instal…    319MB
7c7b2c966bc9   7 days ago      # debian.sh --arch 'amd64' out/ 'bookworm' …     85.3MB    debuerreotype 0.17
```

那个“清理”层只有 20.5 kB——一个 whiteout 标记——而它删掉的 19.8 MB `apt-get update` 元数据，仍然留在它上面那层里。`docker images` 也同意：差版本 572 MB，好版本 537 MB。包一样，差 35 MB。

## 多阶段构建：构建时胖，发布时瘦

**多阶段构建**让 builder 阶段想多胖就多胖，然后只把产物拷进最终镜像。builder 阶段永远不会进镜像仓库。

```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

```console
$ docker history sizedemo:multistage
IMAGE          CREATED         CREATED BY                                       SIZE      COMMENT
b06b0fe9bf91   6 minutes ago   /bin/sh -c #(nop)  ENTRYPOINT ["/app"]           0B
4b61455d93d7   6 minutes ago   /bin/sh -c #(nop)  USER nonroot:nonroot          0B
1b3aafa8afee   6 minutes ago   /bin/sh -c #(nop)  EXPOSE 8080                   0B
e2fc9ebc7585   6 minutes ago   /bin/sh -c #(nop) COPY file:6e308bbd6fccc620…    5.51MB
afa5c872c891   N/A             bazel build //common:cacerts_debian12_amd64_…   319kB
<missing>      N/A             bazel build //common:os_release_debian12         16.4kB
<missing>      N/A             bazel build //static:nsswitch                    12.3kB
<missing>      N/A             bazel build @bookworm//tzdata/amd64:data_sta…    4.24MB
...
```

这就是整个镜像：一个 5.51 MB 的二进制拷贝，压在约 5.4 MB 的 distroless 层之上。`-ldflags="-s -w"` 会剥掉符号表和 DWARF，`-trimpath` 则把本地路径从二进制里去掉。

> **关于这些数字。** 这台机器跑的是 Docker 29 + containerd 镜像存储，它会把压缩后的 blob 和解压后的层都算进去，所以 `docker images` 读出来大约是 `docker history` 之和的 1.3–1.4 倍。我用一个只装了一个 1 MiB 不可压缩文件的 scratch 镜像验证过：`docker images` 说 2.1 MB，`docker history` 说 1.05 MB。在传统的 overlay2 宿主上，你看到的大致就是下面 `docker history` 那一列。但比值——也就是整件事的重点——两种算法完全一致。

| 构建方式 | `docker images` | `docker history` 之和 |
| --- | --- | --- |
| 单阶段 `golang:1.23` | 1.35 GB | 1019 MB |
| 多阶段 → `distroless/static` | 14.1 MB | 11.0 MB |
| 多阶段 → `alpine:3.20` | 21.8 MB | 15.4 MB |
| 多阶段 → `scratch` | 7.95 MB | 5.5 MB |

## 怎么选基础镜像：debian-slim、alpine、distroless 还是 scratch

builder 丢掉不心疼；运行时的基础镜像才是真正要长期承受的选择。

| 基础镜像 | 解压后 | libc | shell / 包管理器 | 说明 |
| --- | --- | --- | --- | --- |
| `golang:1.23` | 927 MB | glibc | 有 / apt | 只做构建阶段 |
| `debian:bookworm-slim` | 85 MB | glibc | 有 / apt | 最稳妥的“常规”运行时 |
| `alpine:3.20` | 8.5 MB | musl | busybox sh / apk | 极小，但用的是 musl |
| `distroless/static` | 约 5.4 MB | 无 | 无 | 带 ca-certs 和 tzdata，非 root 用户 |
| `scratch` | 0 | 无 | 无 | 一切自理，证书也得自己加 |

- **glibc 还是 musl。** Alpine 是 musl。静态链接的二进制不在乎，但如果你用 `cgo`，或者依赖 glibc 的 NSS 解析行为（某些 LDAP / mDNS 场景），Alpine 就会给你意外。`debian-slim` 和 `distroless` 给你 glibc。
- **shell 是调试工具。** `distroless` 和 `scratch` 没有 shell：

```console
$ docker run --rm --entrypoint /bin/sh gcr.io/distroless/static-debian12:nonroot -c 'echo hi'
docker: Error response from daemon: ... exec: "/bin/sh": stat /bin/sh: no such file or directory

$ docker run --rm --entrypoint /bin/sh sizedemo:scratch -c 'echo hi'
docker: Error response from daemon: ... exec: "/bin/sh": stat /bin/sh: no such file or directory

$ docker run --rm --entrypoint /bin/sh sizedemo:alpine -c 'echo hi'
hi
```

- **`scratch` 意味着什么都没有。** 没有 CA 证书、没有 `/etc/passwd`、没有时区数据；而且除非你 `USER` 一个数字 uid，否则你就是以 root 跑的。`distroless` 是务实的中间路线：它就是 `scratch` 加上上面这几样东西，而且默认已经非 root。

<figure>
<svg viewBox="0 0 760 340" width="100%" role="img" aria-label="同一个 Go 服务的三种层堆栈。左：单阶段镜像 1.35 GB，927 MB 的 golang 工具链基础层与 92 MB 的 RUN 层（二进制加 Go 构建缓存）一起发布。中：多阶段构建到 distroless 运行时，14.1 MB，6.2 MB 的基础层加二进制。右：scratch 镜像，7.95 MB，只装二进制。">
  <g font-family="system-ui, sans-serif" fill="currentColor">
    <text x="105" y="22" text-anchor="middle" font-size="13" font-weight="600">单阶段</text>
    <text x="105" y="38" text-anchor="middle" font-size="11" opacity="0.65">一个镜像，全都发出去</text>
    <text x="395" y="22" text-anchor="middle" font-size="13" font-weight="600">多阶段 → distroless</text>
    <text x="395" y="38" text-anchor="middle" font-size="11" opacity="0.65">builder 被丢弃</text>
    <text x="675" y="22" text-anchor="middle" font-size="13" font-weight="600">多阶段 → scratch</text>
    <text x="675" y="38" text-anchor="middle" font-size="11" opacity="0.65">builder 被丢弃</text>

    <rect x="40" y="95" width="130" height="185" fill="currentColor" opacity="0.10" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="40" y1="130" x2="170" y2="130" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="165" x2="170" y2="165" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="200" x2="170" y2="200" stroke="currentColor" opacity="0.18"/>
    <line x1="40" y1="235" x2="170" y2="235" stroke="currentColor" opacity="0.18"/>
    <text x="105" y="178" text-anchor="middle" font-size="11" opacity="0.85">golang:1.23</text>
    <text x="105" y="194" text-anchor="middle" font-size="11" opacity="0.85">工具链基础层</text>
    <text x="105" y="210" text-anchor="middle" font-size="11" opacity="0.6">927 MB</text>

    <rect x="40" y="76.6" width="130" height="18.4" fill="#0f766e" opacity="0.9"/>
    <text x="105" y="89" text-anchor="middle" font-size="10" fill="#ffffff">92 MB</text>
    <line x1="172" y1="86" x2="206" y2="86" stroke="currentColor" opacity="0.5"/>
    <text x="212" y="83" font-size="10" opacity="0.8">一个 RUN 层</text>
    <text x="212" y="96" font-size="10" opacity="0.8">二进制 + 构建缓存</text>

    <rect x="330" y="270" width="130" height="5" fill="currentColor" opacity="0.14" stroke="currentColor" stroke-opacity="0.5"/>
    <rect x="330" y="275" width="130" height="5" fill="#0f766e" opacity="0.9"/>
    <line x1="395" y1="264" x2="395" y2="270" stroke="currentColor" opacity="0.4"/>
    <text x="395" y="246" text-anchor="middle" font-size="10" opacity="0.85">distroless 基础层 6.2 MB</text>
    <text x="395" y="259" text-anchor="middle" font-size="10" opacity="0.85">+ 二进制 5.5 MB</text>

    <rect x="610" y="272" width="130" height="8" fill="#0f766e" opacity="0.9"/>
    <text x="675" y="253" text-anchor="middle" font-size="10" opacity="0.85">二进制 5.5 MB</text>

    <line x1="24" y1="280" x2="736" y2="280" stroke="currentColor" stroke-width="1" opacity="0.35"/>

    <g font-size="11" font-weight="600" fill="#0f766e">
      <text x="105" y="298" text-anchor="middle">1.35 GB</text>
      <text x="395" y="298" text-anchor="middle">14.1 MB</text>
      <text x="675" y="298" text-anchor="middle">7.95 MB</text>
    </g>
    <g font-size="10" opacity="0.65">
      <text x="105" y="313" text-anchor="middle">解压后 1019 MB</text>
      <text x="395" y="313" text-anchor="middle">解压后 11.0 MB</text>
      <text x="675" y="313" text-anchor="middle">解压后 5.5 MB</text>
    </g>
    <text x="380" y="332" text-anchor="middle" font-size="10" opacity="0.55">纵向约 0.2 px/MB；不足 6 px 的柱按 6 px 画，好让细堆栈仍可见</text>
  </g>
</svg>
<figcaption>
  同一个 Go 服务，三种构建策略。单阶段镜像把 927 MB 的工具链基础层和一个
  92 MB 的 RUN 层（5.5 MB 二进制加约 86 MB 的 Go 构建缓存）一起发出去；
  多阶段变体只发一个很小的基础层和二进制。数字来自 <code>docker images</code>
  与 <code>docker history</code>。
</figcaption>
</figure>

## 指令顺序会同时改变 docker history 和构建缓存

同样的指令换个顺序，缓存能复用的程度就完全不同。把 `COPY . .` 放在 `go mod download` 前面，意味着任何源码改动——哪怕只是改个 README——都会让下载层一起失效：

```dockerfile
# 缓存不友好
COPY . .
RUN go mod download
RUN go build -o /app ./...
```

```dockerfile
# 缓存友好
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /app ./...
```

两个都构建一遍，然后改 `README.md` 再重建。友好版本：

```console
Step 4/7 : COPY go.mod go.sum ./
 ---> Using cache
Step 5/7 : RUN go mod download
 ---> Using cache
Step 6/7 : COPY . .
 ---> dcfa290888f3
Step 7/7 : RUN CGO_ENABLED=0 go build ...
 ---> Running in ac7b2a5acc56
```

不友好版本，同样的改动：

```console
Step 4/6 : COPY . .
 ---> 67f4c393ba1a
Step 5/6 : RUN go mod download
 ---> Running in 593cf506afae
Step 6/6 : RUN CGO_ENABLED=0 go build ...
 ---> Running in 1eedbea7f723
```

两个教训。第一，把依赖清单拷在源码前面，这样昂贵的“拉依赖”步骤能挺过日常改动。第二，`docker history` 和构建缓存读的是同一张层图，所以能把镜像缩小的顺序，通常也正是缓存命中良好的顺序。

## .dockerignore 是性价比最高的一招

`COPY . .` 会把整个构建上下文都拷进去——包括你根本没打算发布的东西。一个 43 MB 的上下文，里面混了一个 `debug.log` 和一个 `node_modules/`：

```console
$ du -sh ctx
43M	ctx

$ docker build -f Dockerfile.ctx -t szprobe:ctx-raw ctx      # COPY . /
$ docker build -f Dockerfile.ctx -t szprobe:ctx-ignored ctx  # 带 .dockerignore

$ docker history szprobe:ctx-raw     | head -1
3433821b1065   ...   /bin/sh -c #(nop) COPY dir:...   44.1MB
$ docker history szprobe:ctx-ignored | head -1
4dd05186d44a   ...   /bin/sh -c #(nop) COPY dir:...   12.3kB
```

`.dockerignore` 里写上 `debug.log` 和 `node_modules/`，拷贝出来的层就从 44.1 MB 变成了 12.3 kB。永远把 `.git`、`node_modules`、构建产物、本地环境文件和日志忽略掉。它还能加快构建：上下文在一切开始之前就要被送到 daemon。

## 一句实话：一个你没法调试的 20 MB 镜像

最小的镜像并不自动就是最好的。`scratch` 和 `distroless` 没有 shell、没有 `ps`、没有 `curl`、没有 `nc`。出了事故你没法 `docker exec` 进去东看看西看看；你只能准备一个仅用于调试的变体（`distroless:debug`），或者一个带工具的 sidecar。这个成本是字节计数器看不到的。用 `-s -w` 剥掉符号表，也会让堆栈信息变得更差，除非你另外留着未剥符号的二进制用来做符号化。

我的原则是：发布 `distroless`（如果二进制是静态的、运行时什么都不需要，就用 `scratch`），但为同一次构建留一个 debug 镜像标签；绝不用你真在用的可观测性，去换那些你根本不会注意到的兆字节。一个你没法调试的 20 MB 镜像，并不比一个你能调试的 60 MB 镜像更好。

如果花时间的其实是构建流程本身，[Docker Compose 实战手册](/zh/posts/docker-compose-cookbook/)讲了周边的工程实践；如果你精简镜像是为了安全而不是体积，[容器保护了什么、又没保护什么](/zh/posts/container-security/)是有用的对照——更小的镜像是更小的攻击面，但它并不是一条安全边界。
