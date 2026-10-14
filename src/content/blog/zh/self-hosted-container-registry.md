---
title: "自建容器镜像仓库：把 docker push 留在自己的机器上"
description: "用 registry:2 自建容器镜像仓库：真实的 docker push/docker pull 输出、裸手调 v2 API（catalog、tags、manifest）、htpasswd 认证、TLS 与垃圾回收，以及什么时候託管仓库才是更划算的选择。"
pubDate: 2027-02-03
lang: zh
translationKey: self-hosted-container-registry
tags: [self-hosting, devops]
featured: false
keywords:
  - 自建容器镜像仓库
  - docker push
  - registry:2
  - v2 API
  - htpasswd
---

你执行过的每一次 `docker push`，对话的对象都是一个镜像仓库（registry）。仓库不是一个产品，而是一个 HTTP API：存 **blob**（layer 压缩包和镜像 config）和 **manifest**（声明某个 tag 指向哪些 blob 的小 JSON 文档）。Docker Hub 只是其中一个仓库，你的 Docker 配置里默认的那一个；而**自建容器镜像仓库**就是把同一个 API 搬到自己的一台机器上：一个容器、一个卷，私有镜像不出家门。下面是我反复验证过的版本。所有实验都跑在一台临时机器上、用一次性的 `registry:2` 容器；每条命令、每一段输出都是真实跑出来的。

## 为什么值得自建镜像仓库

四种它确实划得来的场景：

- **私有镜像不用按席位付费。** 构建产物、内部基础镜像，任何不适合放公共仓库的东西。
- **没有拉取频率限制。** CI 集群和新机器想拉多少拉多少。
- **数据留在家中。** 涉及 NDA 或内网隔离时，仓库本身就是交付通道。
- **本地拉取缓存。** 指向 Docker Hub 作上游，内网里的冷节点也能拉得又快又热。

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="示意图：docker push 与 docker pull 通过 HTTP 与 5000 端口的仓库通信，仓库存两类对象，manifest 把 tag 映射到 blob 摘要，blob 以 sha256 文件形式存放 layer 与 config。">
  <g fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7">
    <rect x="16" y="70" width="120" height="80" rx="10"/>
    <rect x="200" y="70" width="130" height="80" rx="10" stroke="#0f766e" stroke-width="2"/>
    <rect x="392" y="20" width="150" height="64" rx="10"/>
    <rect x="392" y="136" width="150" height="64" rx="10"/>
    <path d="M136 96 H200"/><path d="M136 128 H200"/>
    <path d="M330 96 H392"/><path d="M330 128 H392"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="30" y="104">docker push</text><text x="30" y="122">docker pull</text>
    <text x="214" y="100">registry:2</text><text x="214" y="118" opacity="0.75">127.0.0.1:5000 /v2</text>
    <text x="406" y="46">manifest</text><text x="406" y="64" opacity="0.75">tag → digest JSON</text>
    <text x="406" y="162">blob</text><text x="406" y="180" opacity="0.75">layer、config sha256</text>
  </g>
</svg>
<figcaption>一个 HTTP API，两类对象：manifest 是极小的 JSON，blob 是字节本身，两者都以 sha256 寻址。</figcaption>
</figure>

## 最小运行：registry:2 一条命令

官方发行版镜像就是整个仓库。一个卷存状态，一个端口，收工：

```bash
docker run -d --name private-registry \
  -p 5000:5000 \
  -v /srv/registry/data:/var/lib/registry \
  registry:2
```

在我的机器上，日志像承诺的一样朴素（版本 2.8.3）：

```
level=info msg="using inmemory blob descriptor cache" ... version=2.8.3
level=info msg="Starting upload purge in 12m0s" ... version=2.8.3
level=info msg="listening on [::]:5000" ... version=2.8.3
```

API 在 `/v2/` 上应答——每个客户端首先要做的版本握手：

```bash
$ curl http://127.0.0.1:5000/v2/
{}
```

那个空 JSON 对象的意思是“v2 API，请进”。其余一切都是卷里的文件，这点我很快就证明给你看。在真实服务器上，我会把端口绑到内网地址，而不是 `0.0.0.0`。

## 真实的 docker push → docker pull 往返

先搞一个要推的小镜像——基于 alpine 的三行 Dockerfile：

```dockerfile
FROM alpine:3.20
RUN echo "hello from a private registry" > /message.txt
CMD ["cat", "/message.txt"]
```

构建时用完整的仓库地址：仓库主机名是镜像名的一部分，不是一个参数：

```bash
$ docker build -t 127.0.0.1:5000/tinydemo:v1 .
#5 [2/2] RUN echo "hello from a private registry" > /message.txt
#5 DONE 0.5s
#6 exporting to image
#6 exporting manifest sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 0.0s done
#6 naming to 127.0.0.1:5000/tinydemo:v1 done
#6 DONE 0.2s
```

`docker push` 只上传仓库还缺的 blob，并回一个 digest——manifest 的 sha256，也就是这个镜像的内容地址：

```bash
$ docker push 127.0.0.1:5000/tinydemo:v1
The push refers to repository [127.0.0.1:5000/tinydemo]
25f1d6b1951a: Pushed
44136fa355b3: Pushed
2bc0aae78406: Pushed
0e8447578a07: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

现在证明是仓库在提供服务，而不是我的本地缓存。彻底删掉镜像，再拉回来，跑一下：

```bash
$ docker rmi 127.0.0.1:5000/tinydemo:v1
Untagged: 127.0.0.1:5000/tinydemo:v1
Deleted: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6

$ docker pull 127.0.0.1:5000/tinydemo:v1
v1: Pulling from tinydemo
0e8447578a07: Download complete
2bc0aae78406: Pull complete
Digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
Status: Downloaded newer image for 127.0.0.1:5000/tinydemo:v1

$ docker run --rm 127.0.0.1:5000/tinydemo:v1
hello from a private registry
```

完整删除再拉回，digest 一模一样。这就是全部产品。

## 仓库只是磁盘上的文件：裸手调 v2 API

`curl` 就是个合格的仓库客户端，而裸手走一遍 **v2 API** 是看清它到底存了什么的最快路径。先是 catalog——实例上的全部仓库：

```bash
$ curl http://127.0.0.1:5000/v2/_catalog
{"repositories":["tinydemo"]}
```

然后是 manifest。它需要一个 `Accept` 头，而这里的现代 Docker 现场给我上了一课：我的镜像是以 OCI *index* 的形式推上去的（BuildKit 会附加 attestation manifest），所以直接要 Docker v2 manifest 类型会明确失败：

```bash
$ curl -s -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/v1
{"errors":[{"code":"MANIFEST_UNKNOWN","message":"OCI index found, but accept header does not support OCI indexes"}]}
```

要它真正拥有的东西——OCI index——tag 就解析成一组按平台分的 manifest 列表：

```bash
$ curl -s -H 'Accept: application/vnd.oci.image.index.v1+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/v1
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.index.v1+json",
  "manifests": [
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:d03f8ed413b2575d6179ed6adffdd7ffb8591e77a221231b2394ff29f8bdb987",
      "size": 669,
      "platform": { "architecture": "amd64", "os": "linux" }
    },
    {
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "digest": "sha256:df5906856c1361fa64146d1f608cd3490f6f5560402eb42c789aba22d0f0d1f8",
      "size": 836,
      "annotations": { "vnd.docker.reference.type": "attestation-manifest" }
    }
  ]
}
```

digest 同时也就是 manifest 的地址。每个镜像说到底就是这个文档：一个 config blob，加一组 layer blob：

```bash
$ curl -s -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    http://127.0.0.1:5000/v2/tinydemo/manifests/sha256:d03f8ed413b2575d6179ed6adffdd7ffb8591e77a221231b2394ff29f8bdb987
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    "digest": "sha256:4f0b7a7716fcdef4654b26d9af2b72eae84802e591c204bf7a84f7ecec6c3ace",
    "size": 1056
  },
  "layers": [
    { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471",
      "size": 3630321 },
    { "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:2bc0aae784062adbc2ee3316342803159e3c931362853fee074c86d5196cbd1e",
      "size": 132 }
  ]
}
```

`docker image inspect` 给出的是同一个对象的客户端视角：

```bash
$ docker image inspect 127.0.0.1:5000/tinydemo:v1 --format \
    'Digest: {{.RepoDigests}}
ID: {{.Id}}
Size: {{.Size}} bytes
Arch: {{.Architecture}}/{{.Os}}'
Digest: [127.0.0.1:5000/tinydemo@sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6]
ID: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
Size: 12110898 bytes
Arch: amd64/linux
```

现在见证结论的时刻：看看那个卷。仓库就是一目录按内容寻址的文件，外加一摞极小的 link 文件：

```bash
$ find /srv/registry/data/docker/registry/v2/repositories -type f
tinydemo/_manifests/tags/v1/current/link
tinydemo/_manifests/revisions/sha256/b7b67170.../link
tinydemo/_manifests/revisions/sha256/d03f8ed4.../link
tinydemo/_layers/sha256/25f1d6b1.../link
tinydemo/_layers/sha256/2bc0aae7.../link
...

$ cat .../repositories/tinydemo/_manifests/tags/v1/current/link
sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6
```

所谓 tag，就是一个内容为 digest 的文本文件。blob 住在
`blobs/sha256/<前两位十六进制>/<digest>/data`，而那个大的正好就是 manifest
里 3,630,321 字节的 layer：

```bash
$ ls -l .../blobs/sha256/25/25f1d6b1.../data
3630321 blobs/sha256/25/25f1d6b1.../data
```

备份这个目录，就等于备份了整个仓库。没有什么数据库需要导出。

## htpasswd：谁可以推镜像

上面那个仓库是大门敞开的——任何能连上这个端口的人都能推镜像，而你的 CI 之后会拉它们来跑。最快的锁是 htpasswd 基本认证。用一次性容器生成 bcrypt 条目；我从不在宿主机上装 Apache：

```bash
$ docker run --rm --entrypoint htpasswd httpd:2.4 -Bbn demo s3cret
demo:$2y$05$2YDFo9tp3TwgSR.z4O...
```

起第二个仓库，挂上这个文件并打开认证：

```bash
docker run -d --name auth-registry -p 5001:5000 \
  -v /srv/registry/auth-data:/var/lib/registry \
  -v /srv/registry/htpasswd:/auth/htpasswd:ro \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=basic-realm \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  registry:2
```

匿名访问当场死在大门口：

```bash
$ curl -sI http://127.0.0.1:5001/v2/
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Docker-Distribution-Api-Version: registry/2.0
```

不带凭据的 `docker push` 同样失败——它连仓库名都解析不出来：

```bash
$ docker push 127.0.0.1:5001/tinydemo:v1
tag does not exist: 127.0.0.1:5001/tinydemo:v1
```

登录之后，同样的推送就通过了。注意 Docker 自己的警告：基本认证凭据以明文躺在 `~/.docker/config.json` 里，这是“带认证的仓库必须待在 TLS 后面”的又一条理由：

```bash
$ docker login 127.0.0.1:5001 -u demo -p s3cret
WARNING! Using --password via the CLI is insecure. Use --password-stdin.
WARNING! Your credentials are stored unencrypted in '/home/awinx/.docker/config.json'.
Login Succeeded

$ docker push 127.0.0.1:5001/tinydemo:v1
The push refers to repository [127.0.0.1:5001/tinydemo]
2bc0aae78406: Pushed
44136fa355b3: Pushed
25f1d6b1951a: Pushed
0e8447578a07: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

htpasswd 基本认证对单团队仓库够用。但它*不是*真实部署跑的东西：生产仓库用 **token 认证**——客户端先通过身份验证，再由仓库发一个由 token 服务器签过名的 JWT，凭据不会被每次 blob 上传重放一遍。当“所有人共用一个账号”变得不可接受时，就该转向 registry 中间件、托管私有仓库，或者 Harbor。

## TLS：出了本机就不要再用明文 HTTP

守护进程把回环地址（`127.0.0.1`、`localhost`）的仓库当作隐式不安全：它会回退到明文 HTTP，也会接受自签名证书。换任何其他地址，它都坚持 HTTPS。先拿之前那个明文 HTTP 的仓库，通过它的非回环网桥地址 `172.17.0.1:5000` 访问：

```bash
$ docker push 172.17.0.1:5000/tinydemo:v1
failed to do request: Head "https://172.17.0.1:5000/v2/tinydemo/blobs/sha256:0e8447578a071c4873d45dcf9d8405abbe8cf27014df2ec12243717423667b99": EOF
```

守护进程对着一个 HTTP 监听拨了 `https://`，连接直接死掉。解法是 TLS。一张自签名证书只要一条 openssl 命令：

```bash
$ openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout domain.key -out domain.crt \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
$ openssl x509 -in domain.crt -noout -subject -dates
subject=CN=127.0.0.1
notBefore=Oct 14 04:40:39 2026 GMT
notAfter=Oct 16 04:40:39 2026 GMT
```

仓库用两个环境变量直接提供 TLS——它自己的日志可以作证：

```bash
docker run -d --name tls-registry -p 5002:5000 \
  -v /srv/registry/tls:/certs:ro \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  registry:2
```

```
level=info msg="restricting TLS version to tls1.2 or higher" ... version=2.8.3
level=info msg="listening on [::]:5000, tls" ... version=2.8.3
```

curl 在你把 CA 文件交给它之前拒绝信任自签名证书；有了 `--cacert`（自签名证书自己是自己的 CA），API 就应声而答：

```bash
$ curl --cacert domain.crt https://127.0.0.1:5002/v2/
{}

$ curl https://127.0.0.1:5002/v2/
curl: (60) SSL certificate OpenSSL verify result: self-signed certificate (18)
```

而 docker 在回环地址上，零配置就接受了同一个仓库：

```bash
$ docker tag 127.0.0.1:5000/tinydemo:v1 127.0.0.1:5002/tinydemo:v1

$ docker push 127.0.0.1:5002/tinydemo:v1
The push refers to repository [127.0.0.1:5002/tinydemo]
2bc0aae78406: Pushed
44136fa355b3: Pushed
v1: digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6 size: 855
```

在笔记本上很方便——而这恰恰说明它不是生产姿态。为了精确钉住边界，我又签了*第二张*自签名证书，CN 和 SAN 都针对那个网桥地址，然后把一模一样的仓库跑在那里：

```bash
$ openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
    -keyout ext.key -out ext.crt \
    -subj "/CN=172.17.0.1" -addext "subjectAltName=IP:172.17.0.1"

docker run -d --name tls-registry-ext -p 172.17.0.1:5003:5000 \
  -v /srv/registry/tls:/certs:ro \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/ext.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/ext.key \
  registry:2
```

拿到 CA 文件的 curl 很满意——仓库和证书都没问题：

```bash
$ curl --cacert ext.crt https://172.17.0.1:5003/v2/_catalog
{"repositories":[]}
```

docker 守护进程不满意。同一个二进制、同一张证书，只差离开回环一跳：

```bash
$ docker push 172.17.0.1:5003/tinydemo:ext
failed to do request: Head "https://172.17.0.1:5003/v2/tinydemo/blobs/sha256:25f1d6b1951ac8eb3740558fe94cb83d377bdadf95fd9f98b50d2e1b96130471": EOF
```

生产答案，按优先级排序：

1. **真证书。** 用 nginx 或 Caddy 在仓库前面终结 TLS，用客户端本来就信任的证书——仓库可达就用公共 CA，局域网用内部 PKI。
2. **把 CA 分发到每个客户端。** 把 CA 文件放到每台要拉镜像的机器的
   `/etc/docker/certs.d/<host:port>/ca.crt`，然后重启守护进程。
3. **`/etc/docker/daemon.json` 里的 `insecure-registries`**——给指定主机开放明文 HTTP 的官方逃生门：

```json
{
  "insecure-registries": ["172.31.0.9:5000"]
}
```

选项 3 同时会关掉对该主机的证书校验，所以它只配待在实验 VLAN 里：它把“加密传输、证书可疑”降级成了“明文外加一把基本认证凭据”。

## 垃圾回收：没人排进日程的税

放任不管，仓库会永远长大。每个运维都会撞上两个意外：

**一：`docker rmi` 不会从仓库删掉任何东西。** 客户端删的是自己的本地副本；服务器上的副本会一直留着，直到你显式删除它。实验里我推了一个略有不同的构建作为 `v2`，然后把 DELETE API 指向 v1 的 manifest——摘要先从 `Docker-Content-Digest` 头解析出来，因为仓库只按 digest 删除，从不按 tag：

```bash
$ curl -sI -u demo:s3cret -H 'Accept: application/vnd.oci.image.index.v1+json' \
    http://127.0.0.1:5001/v2/tinydemo/manifests/v1 | grep -i docker-content-digest
Docker-Content-Digest: sha256:b7b67170a70ad8573367a5d872505896f113372f1a5668cb17468181b0577ab6

$ curl -s -u demo:s3cret -X DELETE \
    http://127.0.0.1:5001/v2/tinydemo/manifests/sha256:b7b67170... -o /dev/null -w '%{http_code}\n'
405
```

405：不带上 `REGISTRY_STORAGE_DELETE_ENABLED=true` 启动仓库，删除就是禁用的。带它重启之后，同一个请求被接受，tag 从列表里消失：

```bash
$ curl -s -u demo:s3cret -X DELETE \
    http://127.0.0.1:5001/v2/tinydemo/manifests/sha256:b7b67170... -o /dev/null -w '%{http_code}\n'
202

$ curl -s -u demo:s3cret http://127.0.0.1:5001/v2/tinydemo/tags/list
{"name":"tinydemo","tags":["v2"]}
```

**二：删 tag 不会释放字节。** 摘掉 manifest 的链接着 blob 还在原地，只有垃圾回收器能收回它们。它的标记遍历会显示什么还可达：

```bash
$ docker exec auth-registry registry garbage-collect /etc/docker/registry/config.yml
tinydemo: marking manifest sha256:4ba92a42...
tinydemo: marking blob sha256:25f1d6b1...
...
```

在我这个仓库上，磁盘上的 blob 文件数从 14 变成 13，第二遍就再无东西可收：

```
13 blobs marked, 0 blobs and 0 manifests eligible for deletion
```

残留是怎么回事：被删镜像的 manifest *revision* 还链在
`_manifests/revisions` 下，而 revision 会让它引用的 blob 保持可达——跑回收要跑到它报告“无可回收”为止，实践中这意味着一条 cron，而不是一次性命令。看起来很方便的 `--delete-untagged` 参数对 index 型镜像是个坑；我信任它之前先跑了 dry-run：

```bash
$ docker exec auth-registry registry garbage-collect --delete-untagged --dry-run \
    /etc/docker/registry/config.yml
blob eligible for deletion: sha256:2306693e...
blob eligible for deletion: sha256:47c9af74...
blob eligible for deletion: sha256:1fadcff3...
```

那些是我还在对外服务的 v2 镜像的 config 和 layer——打了 tag 的 OCI index 底下的子 manifest，在回收器眼里“没有 tag”。真跑一次，我就会删掉一个还在用的镜像。一切都要先 dry-run。

## 诚实的账单

跑 `registry:2` 本身真的简单。活儿全在它旁边：

- **备份。** 卷就是数据。用 restic 或 rsync 拷走，并且演练一次恢复——这条规矩我整体照搬自自建 Git 服务器：[真正恢复过的备份](/zh/posts/self-hosted-git/)才算数。
- **按日程跑 GC**，外加盯一眼 `du`。存储增长是缓慢、无声的，且总在最糟的时刻被发现。
- **升级。** 一个你的工具都在对它的 API 说话的有状态服务：给卷打快照、读 changelog、再动版本。
- **访问控制本身是个项目。** htpasswd 只是共用一个登录。Token 认证、按团队授权、漏洞扫描、镜像签名各是一套系统——如果这些要紧，就该看 Harbor 或托管仓库，而不是 DIY。

还有诚实的出口：如果需求只是“有个私密的地方推点个人项目镜像”，托管私有仓库（GHCR、GitLab）不花钱，还白送别人的可用性保障。如果你的镜像能从 Dockerfile 可复现地构建出来，那一个 Git 仓库加 CI 可能才是你真正需要的“仓库”——把你可能已经在跑的[自建 Git 服务器](/zh/posts/self-hosted-git/)和产出镜像的构建步骤连起来即可。只有当镜像本身才是资产时，才值得自建仓库：重新构建太慢、含有不能公开的二进制、或者要放进隔离网络。

如果你真的跑了一个，安全话题就在*另一侧*延续——基础镜像里装了什么，和它存在哪里同样重要；这方面我记在[容器安全](/zh/posts/container-security/)里。

## 我会塞给同事的清单

1. `registry:2` 加命名卷；端口绑到内网地址。
2. TLS 用真证书，或把你的 CA 分发到每个客户端。
3. 前面挡一层认证——至少 htpasswd，超过一个团队就上 token 认证。
4. `REGISTRY_STORAGE_DELETE_ENABLED=true`，GC 上 cron，磁盘加告警。
5. 备份那个卷；测试恢复。
6. 按 digest 删除，再跑 GC，最后用 `/v2/_catalog` 核对。

仓库是少有的这样一种自建服务：真正的风险不在软件，而在自己掌握存储所带来的运维债。审慎地对待这笔债，私有镜像就安静而便宜地属于你。
