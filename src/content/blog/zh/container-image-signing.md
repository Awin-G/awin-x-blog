---
title: "容器供应链完整性：用 cosign 签名镜像，以及标签为什么会骗人"
description: "标签会说谎，摘要不会。一篇动手向的容器供应链完整性指南：构建一个极简镜像、按镜像摘要用 cosign 签名、部署前用 cosign verify 拦截，亲眼看着被悄悄挪走的标签验证失败（退出码 10），再附加 SBOM 与来源证明，并把签名做成部署门禁——全部真实终端输出，也说清单人运维者做到哪一步就够。"
pubDate: 2027-01-03
lang: zh
translationKey: container-image-signing
tags: [security, devops]
featured: false
keywords:
  - cosign
  - 镜像签名
  - 容器供应链
  - 镜像摘要
  - SBOM
  - Sigstore
  - 不可变标签
---

我们部署的容器，大多不是自己一行行构建出来的；而我们用来标识它们的方式，是一个自己控制不了的名字。`nginx:1.27` 是一个**可变标签**——谁能往那个仓库里写，谁就能挪动它，于是昨天的 `pull` 今天可能拉到完全不同的镜像。**容器供应链**完整性的价值，就是把“我到底在跑什么？”这个问题的答案，从“但愿没事”变成“密码学保证”。这篇文章里我把整个流程真实跑了一遍：构建一个极简镜像、生成**镜像签名**密钥对、按**镜像摘要**用 **cosign**（Sigstore 的工具）签名、部署前验证，然后让一次“被入侵的构建”把同一个标签后面的镜像换掉，看验证如何失败。全程不用 sudo、不用 `--privileged`，只有一个跑在 localhost 上的一次性仓库，以及真实的终端输出。

<figure>
<svg viewBox="0 0 720 230" width="100%" role="img" aria-label="三个阶段从左到右。一，构建：源码变成容器镜像，摘要以 sha256:e61a44 开头。二，签名：cosign 用私钥对摘要签名，签名以名为 sha256-e61a44-sig 的标签形式存在镜像旁边。三，部署前验证：cosign 用公钥检查签名；签名有效则放行，缺失则拦截。">
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <path d="M214 100 h34" marker-end="url(#arr)"/>
    <path d="M454 100 h34" marker-end="url(#arr)"/>
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#0f766e" stroke="none"/>
      </marker>
    </defs>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <rect x="24" y="44" width="190" height="120" rx="10"/>
    <rect x="264" y="44" width="190" height="120" rx="10"/>
    <rect x="504" y="44" width="190" height="120" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="119" y="26" text-anchor="middle" font-weight="600">1 · 构建</text>
    <text x="359" y="26" text-anchor="middle" font-weight="600">2 · 签名</text>
    <text x="599" y="26" text-anchor="middle" font-weight="600">3 · 部署前验证</text>

    <text x="119" y="86" text-anchor="middle">源码 → 镜像</text>
    <text x="119" y="106" text-anchor="middle">摘要 sha256:e61a44…</text>
    <text x="119" y="132" text-anchor="middle" fill="#0f766e">内容寻址的字节</text>

    <text x="359" y="86" text-anchor="middle">cosign sign --key …</text>
    <text x="359" y="106" text-anchor="middle">对摘要本身的签名</text>
    <text x="359" y="132" text-anchor="middle" fill="#0f766e">存为 sha256-….sig</text>

    <text x="599" y="86" text-anchor="middle">cosign verify --key …</text>
    <text x="599" y="106" text-anchor="middle">有效 → 放行</text>
    <text x="599" y="132" text-anchor="middle" fill="#0f766e">无效 → 拦截，退出码 10</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="360" y="196" text-anchor="middle">身份永远是摘要，而不是标签</text>
    <text x="360" y="214" text-anchor="middle">被挪走的标签会验证失败；被换掉的字节失败得更彻底</text>
  </g>
</svg>
<figcaption>让镜像身份可验证、而不是信任一个名字的闭环：构建产出内容寻址的字节，签名把你的密钥绑定到这份确切的摘要上，而验证发生在任何字节抵达主机之前。</figcaption>
</figure>

## 问题所在：镜像标签为什么会骗人

标签只是命名空间里的一个名字；`docker.io/library/nginx:1.27` 是一个谁都可以重新指向的指针。四种坑，每一类都值得说：

- **可变标签。** `latest` 名声在外，但只要仓库没标记为不可变，每一个标签都是可变的。重新构建、重新推送，指针就会动。
- **抢注和仿冒。** `nginxx`、`nglnx`，或者一个看起来像官方账号的个人命名空间。凌晨两点粘贴命令时，名字里差一个字符和意图上差一个字符，肉眼分不出来。
- **构建被入侵。** 一旦构建作业或它的 token 被拿下，攻击者同时拿到镜像和标签。所有信任这个标签的下游，一起继承这次入侵。
- **拉到自己没构建过的东西。** 一份共享的 Dockerfile、一个 vendored 的基础镜像、一个“可信”内部缓存悄悄发给你的重构建。你知道自己*请求*了什么，不知道自己*拿到*了什么字节。

演示来了。我用 `FROM scratch` 构建一个极小的 Go 镜像，推到一个临时本地仓库，然后“入侵构建”，把不同的字节推到**同一个标签**后面：

```console
$ docker build -t signme:v1 . && docker push localhost:5000/signme:v1
v1: digest: sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 size: 535

# ... 构建环境在同一个标签后面换成了别的字节 ...
$ docker tag signme:tampered localhost:5000/signme:v1 && docker push localhost:5000/signme:v1
v1: digest: sha256:f04d9db4ab9d519f224aa67ba7fb5735de7add3753b075bab421cd16b718b5a3 size: 535

$ docker run --rm localhost:5000/signme:v1
hello from build 2 (replaced behind the same tag)
```

同一个标签、不同的摘要、不同的内容——所有在部署时解析 `signme:v1` 的环节，都面不改色地运行了攻击者控制的代码。（如果你更在意镜像字节本身而不是它的身份，那是另一个话题：[容器镜像体积](/zh/posts/container-image-size/)。）

## 镜像摘要：不可变的身份

答案就是摘要。摘要是对镜像 **manifest** 的 `sha256:` 哈希——那份列出 config blob 和每一个 layer blob 的 JSON 文档。改掉任何一个 layer 的一个字节，manifest 就变，摘要就变。你无法让新内容匹配一个旧摘要，这正是哈希的意义：

```console
$ docker image inspect localhost:5000/signme:v1 --format '{{range .RepoDigests}}{{.}}{{end}}'
localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
```

有两个性质值得刻进脑子。第一，摘要是最真实意义上的**不可变标签**：摘要到字节的映射只能被垃圾回收，无法被编辑。但——这也是最容易漏的一点——*摘要说明某样东西是什么，不说明它是谁做的*。上面那个被换过的镜像，同样有一个完全有效的摘要；给攻击者的字节一个密码学上强的名字，它依然是攻击者的字节。身份只是闭环的一半；另一半，是把你信任的*密钥*和你解析出的*摘要*绑在一起的一份签名。

## 用 cosign 做镜像签名：密钥模式与无密钥模式

**Cosign** 是 Sigstore 项目里的镜像签名工具，签名就存在镜像仓库自身——没有旁路服务器、没有新基础设施。签名是一个小 manifest，以 `sha256-<digest>.sig` 这个伪标签的形式挂在同一个仓库里。我这次把 cosign v2.4.1 跑在容器里（`ghcr.io/sigstore/cosign/cosign:v2.4.1`），对着 `127.0.0.1:5000` 上的一次性 `registry:2`，宿主机保持干净。

**密钥模式**是对离线友好的方式：私钥由你自己持有。生成密钥对只要一条命令：

```console
$ export COSIGN_PASSWORD='…'
$ cosign generate-key-pair
Private key written to cosign.key
Public key written to cosign.pub
```

现在签名——签的是**摘要，不是标签**。把标签交给 cosign，它会大声警告，因为“解析标签，再签 whatever 回来”恰好就是被入侵的构建会赢的那场赛跑：

```console
$ cosign sign --key cosign.key localhost:5000/signme:v1
WARNING: Image reference localhost:5000/signme:v1 uses a tag, not a digest, to identify the image to sign.
    This can lead you to sign a different image than the intended one. Please use a
    digest (example.com/ubuntu@sha256:abc123...) rather than tag
    (example.com/ubuntu:latest) for the input to cosign. The ability to refer to
    images by tag will be removed in a future release.

Pushing signature to: localhost:5000/signme
```

按摘要签名则安静得多，也不会替你担保你没要求的字节：

```console
$ cosign sign --key cosign.key --tlog-upload=false \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Pushing signature to: localhost:5000/signme
$ curl -s http://127.0.0.1:5000/v2/signme/tags/list
{"name":"signme","tags":["sha256-e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6.sig","v1"]}
```

仔细读这个标签列表：签名*本身*就是一个以它所覆盖的摘要命名的标签，所以它不可能被贴到别的字节上。我关掉了透明日志上传（`--tlog-upload=false`），因为离线环境里没有 Rekor 可说话；生产环境要打开。

**无密钥模式**是 Sigstore 的原生方式，也更值得追求：根本没有长期密钥。签名者通过 OIDC 证明自己跑在一个可信 CI 作业里，Fulcio 签发短期证书，两者同时记入公共透明日志——没什么要备份、没什么会泄露、每次签名都公开可审计。它能成立，是因为 CI 系统能拿到真实的 OIDC token：

```yaml
# 无密钥签名，跑在具备 OIDC 身份的 CI 作业里
- uses: sigstore/cosign-installer@v3.9.0
- run: cosign sign --yes localhost:5000/signme@${{ env.DIGEST }}
```

对应的验证检查的不只是密钥，还有*是谁*签的：`cosign verify --certificate-identity-regexp 'https://github.com/org/repo/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com …`。这里我没法演示无密钥模式——没有 OIDC 提供方、没有 Fulcio——所以我不打算假装演示过；上面那套密钥流程，是同一套数学在离线环境下的诚实版本。

## 部署前验证：成功与失败

验证才是重点，所以这里是完整实录。对已签名的摘要，验证成功：

```console
$ cosign verify --key cosign.pub --insecure-ignore-tlog=true \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
WARNING: Skipping tlog verification is an insecure practice that lacks transparency and auditability verification for the signature.

Verification for localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key

[{"critical":{"identity":{"docker-reference":"localhost:5000/signme"},"image":{"docker-manifest-digest":"sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6"},"type":"cosign container image signature"},"optional":null}]
```

注意签名 payload 里的 `docker-manifest-digest`：签名里就包含着它担保的那个摘要。`--insecure-ignore-tlog` 是诚实的记账——我的密钥签名没有透明日志条目，因为我关掉了上传，而不带这个参数，验证正是因此失败：

```console
$ cosign verify --key cosign.pub localhost:5000/signme:v1
Error: no matching signatures: signature not found in transparency log
```

然后是真正要紧的失败场景：被入侵的构建把摘要换掉之后的同一个标签。cosign 解析标签得到*新*摘要，发现这些字节没有签名，然后以非零码退出：

```console
$ cosign verify --key cosign.pub --insecure-ignore-tlog=true localhost:5000/signme:v1
WARNING: Skipping tlog verification is an insecure practice that lacks transparency and auditability verification for the signature.
Error: no signatures found
$ echo $?
10
```

`Error: no signatures found`，退出码 10——工具给出的信息很精确：*这个标签现在指向没人签过的字节*。而与此同时，那个旧的、被签过名的摘要依然验证通过。整个设计用一句话说完：签名跟着字节走，不跟着名字走。

## SBOM、证明，以及来源信息到底说了什么

签名说明*谁批准了这些字节*，完全没说明*里面有什么*。这是 **SBOM**——软件物料清单，通常是 SPDX 或 CycloneDX——的用武之地，而它天然的归宿是**证明（attestation）**：对一条声明（“这是摘要 X 的 SBOM”）的签名，以同样的 `.att` 方式存在镜像旁边。

我用 syft 生成了真实的 SBOM（我这台机器上 `docker sbom` 用不了——插件没装——所以诚实的做法是用容器跑 syft）：

```console
$ docker save signme:v1 -o signme-v1.tar
$ docker run --rm -v "$PWD":/w anchore/syft:latest docker-archive:/w/signme-v1.tar -o spdx-json
SPDXVersion: SPDX-2.3
packages: 3
  - command-line-arguments | UNKNOWN | NOASSERTION
  - stdlib | go1.27.2-X:nodwarf5 | NOASSERTION
  - /w/signme-v1.tar | sha256:e9ac134f…710f | NOASSERTION
```

无聊的输出正是目标：三个包、一个二进制、一个 Go 标准库。把它附加到摘要上，再通过验证读回来：

```console
$ cosign attest --key cosign.key --type spdx --predicate sbom.spdx.json \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Using payload from: /logs/sbom.spdx.json
$ cosign verify-attestation --key cosign.pub --type spdx --insecure-ignore-tlog=true \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Verification for localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjAuMSIs…
```

此刻仓库里存着两份证明，都以同一个摘要命名：

```console
$ curl -s http://127.0.0.1:5000/v2/signme/tags/list
{"name":"signme","tags":["sha256-e61a4440…af6.sig","v1","sha256-e61a4440…af6.att"]}
```

这套东西在生态层面的演进方向是 **SLSA provenance**：一条 attestation 声明*这次构建、来自这个源码提交、由这个构建器、产出这个摘要*。你签镜像、附加 SBOM 和来源证明，消费方日后就能问“这个镜像是我的 CI 从我的仓库构建的，还是凭空冒出来的？”——并且得到密码学答案。落到行动上的版本：签镜像、附 SBOM、让构建系统产出来源证明。

## 落地执行：部署门禁，以及准入控制

没人检查的签名只是文书工作。最小可行的强制方式，是把验证变成部署的前置条件：

```sh
#!/bin/sh
# deploy-gate.sh —— 只拉取/部署可信密钥签过名的东西
set -eu
REF="$1"
if cosign verify --key cosign.pub --insecure-ignore-tlog=true "$REF" >/dev/null 2>&1; then
    echo "DEPLOY ALLOWED: $REF is signed by the trusted key"
else
    echo "DEPLOY BLOCKED: $REF has no valid signature (cosign exit $?)"
    exit 1
fi
```

在我的仓库上，它的行为正如预期——签过名的摘要放行，被挪走的标签被拦下：

```console
$ ./deploy-gate.sh localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
DEPLOY ALLOWED: localhost:5000/signme@sha256:e61a4440… is signed by the trusted key
$ ./deploy-gate.sh localhost:5000/signme:v1
DEPLOY BLOCKED: localhost:5000/signme:v1 has no valid signature (cosign exit 10)
```

到了集群规模，同样的检查前移到准入控制器，这样无论多少人敲 `kubectl apply`，未签名的工作负载都起不来。Kyverno 里大致是这样（这是配置，不是我跑的——这里没有集群）：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-cosign-signatures
spec:
  validationFailureAction: Enforce
  rules:
    - name: images-must-be-signed
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      …
                      -----END PUBLIC KEY-----
```

各种实现的形状都一样——cosign v3 自己的 `verify --policy` 模式也包括在内：*这些镜像通配必须携带来自这个身份、按摘要匹配的签名，在校验准入时检查*。真正改变行为的那一点：**策略匹配的是摘要，永远不是标签**，否则你只是在自家门禁里重建了那场标签赛跑。

## 一个单人运维者的诚实现实

我不想把这件事讲成宗教。对一个人跑少量服务来说，全套栈——Fulcio、Rekor、准入控制器、provenance 流水线——是为一个你基本不面对的威胁模型做的真实工程。我实际做的只有这些：

- **钉死摘要。** 每一个 Dockerfile 和 compose 文件里都写 `FROM alpine:3.21@sha256:48b0…`。这也是本文性价比最高的一行（在[容器安全基础](/zh/posts/container-security/)里我又强调了一次）。
- **能自己构建的就自己构建。** 最可信的镜像，是你亲手从一个读过的 Dockerfile 构建出来的那个；`FROM scratch` 加上你自己的静态二进制，通常比任何你要拉的基础镜像都更小，*而且*更可验证。
- **只签重要的东西。** 签自己的部署产物，从自己的 CI，用 cosign——CI 给 OIDC 就用无密钥模式，不给就把密钥放进正经的机密存储用密钥模式。十分钟的设置；它撑得过仓库凭证被盗的那天。
- **在门禁处验证，而不是在报告里。** 一个拒绝拉取未签名摘要的脚本，胜过一个没人看的面板。
- **不要过度工程。** 如果你的仓库除了你没人能写，风险主要来自你未来的自己给什么东西换了标签。摘要加上签名的部署产物，几乎覆盖了所有真实场景；当*团队*和*一条不是你亲手搭的 CI*进入等式时，SLSA 证明体系才开始值回票价。

我从这一切里保留的心智模型：标签是一个别人可以违背的承诺，摘要是没人能伪造的指纹，而签名是唯一能把这两者连到某个你决定信任的人或构建系统上的东西。就在字节执行前，拿指纹对签名——“拉到自己没构建过的东西”就不再是一类故障。
