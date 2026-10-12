---
title: "gRPC vs REST：一次诚实的对比，附真实调用"
description: "我把一个一次性的 gRPC 服务和一个等价的 REST 接口并排跑起来，然后量了线上真实的数据：grpcurl 调用与反射、HTTP/2 分帧、protobuf 与 JSON 的字节数、四种流式调用、以及 deadline 超时——最后写下 gRPC 与 REST 各自到底在哪里赢、代价又在哪里。"
pubDate: 2026-12-22
lang: zh
translationKey: grpc-vs-rest
tags: [networking, devops]
featured: false
keywords:
  - gRPC vs REST
  - gRPC
  - protobuf
  - grpcurl
  - HTTP/2
  - 流式 RPC
  - 代码生成
---

关于 **gRPC vs REST** 的争论，通常是用形容词打的：gRPC “现代”，REST “简单”，而没有人给你看一个数据包。所以这次我在 Docker 里起了一个一次性的 **gRPC** 服务并打开反射（reflection），又写了一个返回同样数据的 REST 接口，然后去测量，而不是去争论。下面所有内容都是我在一台机器上、走 127.0.0.1 真实拿到的输出。

短版本：gRPC 不是“更快的 REST”，它是另一份契约。它把工作量从运行时挪到构建时，从人眼挪到 schema，而这个取舍正是它在服务网格内部很好用、在浏览器里很别扭的原因。

## gRPC 到底是什么：HTTP/2、protobuf 与代码生成

把品牌包装去掉，gRPC 就是三块普通东西拼起来：

- **HTTP/2** 作为传输层——一条连接、多个并发流，以及响应末尾的 **trailers**（尾部头）。
- **protobuf** 作为线上格式——由 `.proto` schema 驱动的紧凑、强类型的二进制编码。
- 从该 schema 做 **代码生成（codegen）**——`protoc` 用你的语言生成客户端 stub 和服务端接口。

schema 是重心。这就是整个演示服务：

```proto
syntax = "proto3";
package hello;

service HelloService {
  rpc SayHello      (HelloRequest) returns (HelloResponse);
  rpc LotsOfReplies (HelloRequest) returns (stream HelloResponse);
}

message HelloRequest  { string greeting = 1; }
message HelloResponse { string reply    = 1; }
```

`protoc` 由此生成类型和 stub。这正是任何 REST 框架给不了的东西：契约是一个编译产物，而不是一条约定。

## 一次真实的 gRPC 调用：反射 + grpcurl

我起了一个测试服务端（`moul/grpcbin`）并开启反射，然后用 **grpcurl**——gRPC 世界的 `curl`——在客户端本地没有任何 `.proto` 文件的情况下调用它。反射让 grpcurl 能向服务端索要 schema：

```console
$ grpcurl -plaintext grpcbin:9000 list
addsvc.Add
grpc.gateway.examples.examplepb.ABitOfEverythingService
grpc.reflection.v1alpha.ServerReflection
grpcbin.GRPCBin
hello.HelloService
```

现在是 unary 调用，用 verbose 模式，这样你能看到 payload 周围都走了什么：

```console
$ grpcurl -plaintext -v -d '{"greeting":"Hello, DeepSeek"}' \
    grpcbin:9000 hello.HelloService/SayHello

Resolved method descriptor:
rpc SayHello ( .hello.HelloRequest ) returns ( .hello.HelloResponse );

Response headers received:
content-type: application/grpc

Response contents:
{
  "reply": "hello Hello, DeepSeek"
}

Response trailers received:
(empty)
Sent 1 request and received 1 response
```

两点值得注意。路径是 `hello.HelloService/SayHello`——方法在 URL 里，但没有动词，也没有资源建模。而响应头只有 `content-type: application/grpc`；真正的状态稍后才到，在 **trailers** 里，以 `grpc-status` 的形式出现。

第一条命令还是个小安全教训：我在实验环境里开着反射，但在生产环境里，它会把你的整个 schema 交给任何提问的人。多数团队会关掉它，改为带外把 `.proto` 文件发给客户端。

## 底下的 HTTP/2 帧

`grpcurl` 把帧藏起来了，所以我写了一个小 `h2` 客户端，发出同一个调用，并打印它看到的每一帧：

```console
$ python probe.py
payload on the wire: 22 bytes  (5-byte gRPC prefix + 17 protobuf)
00 <- RemoteSettingsChanged stream=- len=
01 <- SettingsAcknowledged stream=- len=
02 <- WindowUpdated stream=0 len=
03 <- PingReceived stream=- len=
04 <- ResponseReceived stream=1 len=
      {':status': '200', 'content-type': 'application/grpc'}
05 <- DataReceived stream=1 len=28
      hex: 00 00 00 00 17 0a 15 68 65 6c 6c 6f 20 48 65 6c 6c 6f 2c 20 44 65 65 70 53 65 65 6b
06 <- TrailersReceived stream=1 len= end_stream
      {'grpc-status': '0', 'grpc-message': ''}
07 <- StreamEnded stream=1 len=
total frames observed: 8
```

这就是被剥光的 gRPC。响应是一个 `HEADERS` 帧、一个 `DATA` 帧，以及一个携带 `grpc-status: 0` 的 `TRAILERS` 帧。那个 DATA 载荷以五个字节开头——`00 00 00 00 17`——一个压缩标志加上 4 字节大端长度前缀（`0x17` = 23）。后面全是原始 protobuf，不是文本。

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="左侧：一次走 HTTP/2 的 gRPC 调用，包含一个 HEADERS 帧、一个携带 5 字节长度前缀和二进制 protobuf 的 DATA 帧，以及一个携带 grpc-status 的 TRAILERS 帧。右侧：一次走 HTTP/1.1 的 REST 调用，包含文本头部块和人类可读的 JSON 主体。">
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="currentColor">
    <text x="20" y="20" font-size="13">gRPC over HTTP/2</text>
    <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.85">
      <rect x="20" y="32" width="300" height="30" rx="6"/>
      <rect x="20" y="68" width="300" height="34" rx="6"/>
      <rect x="20" y="108" width="300" height="30" rx="6"/>
    </g>
    <text x="32" y="52">HEADERS  content-type: application/grpc</text>
    <text x="32" y="89">DATA    |00 00 00 00 17| 0a 15 68 65 …</text>
    <text x="32" y="128">TRAILERS  grpc-status: 0</text>
    <text x="20" y="182" font-size="11" opacity="0.75">5 字节长度前缀 + 二进制 protobuf</text>

    <text x="380" y="20" font-size="13">REST over HTTP/1.1</text>
    <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.85">
      <rect x="380" y="32" width="300" height="66" rx="6"/>
      <rect x="380" y="104" width="300" height="34" rx="6"/>
    </g>
    <text x="392" y="52">GET /hello/DeepSeek HTTP/1.1</text>
    <text x="392" y="70">Host: …  Accept: */*</text>
    <text x="392" y="88">Cache-Control: public, max-age=60</text>
    <text x="392" y="126">{"reply": "hello DeepSeek"}</text>
    <text x="380" y="156" font-size="11" opacity="0.75">文本头、文本体，肉眼可读</text>
    <text x="380" y="176" font-size="11" opacity="0.75">状态就在第一行的 200 OK</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <path d="M20 208 H660" stroke-dasharray="4 4"/>
    <rect x="20" y="220" width="300" height="24" rx="6"/>
    <rect x="380" y="220" width="300" height="24" rx="6"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="11.5" fill="currentColor">
    <text x="32" y="236">协议 → 代码生成 → 强类型 stub（构建时）</text>
    <text x="392" y="236">手写客户端，运行时解析 JSON</text>
  </g>
</svg>
<figcaption>同样的数据，两条线。gRPC 把状态拆到 trailers，并把载荷藏在一个长度前缀和一种二进制编码之后；REST 把所有东西都放进你能用 `od` 直接读的文本里。哪个都不“更好”——一个是机器优先，一个是人优先。</figcaption>
</figure>

## protobuf 究竟省了多少带宽

这是个大家反复引用却从不给数字的论点，所以我用 `protoc --encode` 量了它。先看上面那个小载荷：请求是 **17 字节** protobuf，等价 JSON 是 **30 字节**；响应是 **23** 对 **33**。再看一个更真实的，50 条用户记录：

```console
$ python measure.py
payload: 50 records, each {name,email,id,active,tags:[beta,eu-west]}
protobuf bytes : 2650
JSON bytes     : 5186
JSON/protobuf  : 1.96x
```

这里 protobuf 大约只有一半大小。这是真的，但要注意它**不是**什么：它不是白省的带宽，因为对 JSON 体做 gzip 能补上很大一段差距；它本身也不代表“更快”——收益出现在大载荷、高请求速率和移动网络上，而不是一个 30 字节的 hello 上。

## gRPC 的优势

- **一份被强制执行的 schema。** `.proto` 就是契约，像代码一样版本化、在编译期检查。你不可能不小心把字符串发到期望数字的地方。
- **代码生成。** 跑一次 `protoc`，你就拿到各语言的强类型 stub：

```console
$ python -m grpc_tools.protoc -I. --python_out=gen --grpc_python_out=gen hello.proto
$ ls -l gen
-rw-r--r-- 1 root root 1872 hello_pb2.py
-rw-r--r-- 1 root root  589 hello_pb2.pyi
-rw-r--r-- 1 root root 8462 hello_pb2_grpc.py
```

- **流式是 schema 里的一等关键字**（`stream`），而不是事后拼上的协议。
- **二进制效率**——上面量到的约 2 倍。
- **会传播的 deadline。** 这一点被低估了。gRPC 调用携带一个 deadline；超时时，客户端放弃，**同时服务端也会被告知**。我把客户端指向一个 sleep 5 秒的服务端，只给它 1 秒：

```console
$ grpcurl -plaintext -max-time 1 -d '{"greeting":"DeepSeek"}' \
    grpc-tools:9090 hello.HelloService/SayHello
ERROR:
  Code: DeadlineExceeded
  Message: context deadline exceeded
  Sent 1 request and received 0 responses
# exit code 68
```

你拿到的是一个强类型状态码（`DEADLINE_EXCEEDED`，在 gRPC 的映射里对应 HTTP 504），而不是一个卡死的 socket。状态是结构化的，不是字符串：`OK`、`NOT_FOUND`、`INVALID_ARGUMENT`、`UNAVAILABLE` 等十来个，每个都有固定名字供客户端 switch。

## gRPC 的代价

- **没法纯手工调试。** 下面是 `curl` 发同样的调用——它能对 gRPC 端点说 HTTP/2，但回来的东西是不透明的：

```console
$ curl --http2-prior-knowledge -H 'content-type: application/grpc' -H 'te: trailers' \
    --data-binary @reqframe.bin http://grpcbin:9000/hello.HelloService/SayHello | od -An -tx1 -v
HTTP/2 200
content-type: application/grpc
grpc-status: 0
grpc-message:
 00 00 00 00 17 0a 15 68 65 6c 6c 6f 20 48 65 6c 6c 6f 2c 20 44 65 65 70 53 65 65 6b
```

没有 `grpcurl` 和 schema，那串十六进制就是噪声。`jq` 用不上，终端里也读不出来。
- **浏览器不能直接调。** gRPC 需要 HTTP/2 trailers 和 `fetch()` 不暴露的细粒度分帧；你需要 grpc-web 加一个代理（`envoy`，或 grpc-web 网关）来翻译。那是你新要运维的真实基础设施。
- **工具链和基础设施滞后。** 代理、CDN、负载均衡器、可观测性工具历史上都假设 HTTP/1.1 和 JSON；现在支持是有了，但配置更多，出错的地方也更多。
- **状态码不能干净地映射到 HTTP。** `grpc-status` 在 trailers 里，所以即使调用失败，一个懂 HTTP 的中间件看到的仍是 `200 OK`。你需要能理解第二个状态的工具，否则你的指标会撒谎。
- **schema 治理成了新工作。** 你现在要拥有一个注册中心、向后兼容规则，以及“永远不重排字段编号”的纪律。这是实打实的工作量。
- **缓存变难**——正好是 [HTTP 缓存](/zh/posts/http-caching/) 那篇的主题。gRPC 是 POST 形态的，所以缓存基本都躲开了。

## 诚实地看 REST 与 JSON

REST 的优势几乎是镜像。它跑在任何会说 HTTP 的东西上：任意机器上的 `curl`、浏览器、移动端 SDK、shell 脚本。

```console
$ curl -v http://127.0.0.1:18080/hello/DeepSeek
> GET /hello/DeepSeek HTTP/1.1
< HTTP/1.1 200 OK
< Content-Type: application/json
< Content-Length: 27
< Cache-Control: public, max-age=60
{"reply": "hello DeepSeek"}
```

一切都清晰可读，状态在第一行，`Cache-Control` 对 CDN 或浏览器真的有意义。没有代码生成步骤，也就没有构建步骤、没有要提交的生成文件、没有客户端与服务端之间的 schema 漂移——好处坏处都在这里。代价是：没有强制契约（漂移是你自己的问题）、载荷更大、流式更弱、没有标准的 deadline 机制——超时得自己发明并手动传播。幂等与重试语义也得靠设计而非声明，这正是 [幂等键](/zh/posts/idempotency-keys/) 要解决的问题。

## 流式模式

gRPC 命名了四种形态，`grpcurl` 对同一个服务把它们全展示了：

```console
# server streaming：一个请求，一串回复（共 10 条）
$ grpcurl -plaintext -d '{"greeting":"DeepSeek"}' grpcbin:9000 hello.HelloService/LotsOfReplies
{ "reply": "hello DeepSeek" }
... 10 messages total

# client streaming：多个请求，一个回复
$ grpcurl -plaintext -d '{"greeting":"one"}{"greeting":"two"}{"greeting":"three"}' \
    grpcbin:9000 hello.HelloService/LotsOfGreetings
{ "reply": "hello one, two, three" }

# bidi streaming：双向交错
$ grpcurl -plaintext -d '{"greeting":"alpha"}{"greeting":"beta"}' grpcbin:9000 hello.HelloService/BidiHello
{ "reply": "hello alpha" }
{ "reply": "hello beta" }
```

server streaming 在 REST 里对应的是分块传输的换行分隔 JSON——能用，但那是你自己搭出来的约定，不是协议原语。client streaming 和 bidi 在 REST 里根本没有自然的形态；你最后会落到 WebSocket 或 SSE 上，而它们各自又是一个要学和要代理的协议。

## gRPC vs REST：并排对比

| | gRPC | REST / JSON |
|---|---|---|
| 传输 | HTTP/2（必须有 trailers） | HTTP/1.1 或 HTTP/2，都行 |
| 载荷 | 二进制 protobuf | 文本 JSON |
| 契约 | `.proto` schema，编译进产物 | 约定；除非你额外加 OpenAPI |
| 客户端代码 | 由 schema 生成 | 手写 |
| 浏览器支持 | 需要 grpc-web + 代理 | 原生 `fetch()` |
| 能否手工调试 | 不能（需 `grpcurl` + schema） | 能（`curl`、`jq`） |
| 流式 | unary、server、client、bidi | 请求/响应；流要 SSE 或 WS |
| 缓存 | 基本没有（POST 形态） | 核心能力（`Cache-Control`、ETag） |
| Deadline | 内建且会传播 | 得自己实现 |
| 最合适 | 系统内部服务间调用 | 公开的、面向浏览器的 API |

## 我的决策清单

- 公开 API、浏览器客户端，或我控制不了的第三方 → **REST/JSON**。绝不要逼外人装一套代码生成工具链。
- 同一个系统内部的服务间调用，两端都由我发版 → **gRPC**。schema 和生成的 stub 立刻回本。
- 真正双向或长连接的流式 → **gRPC**。别用轮询假装。
- 事故时半夜里会有人用 `curl` 去戳的东西 → **REST**。可调试性是一种特性。
- 大载荷，或在窄链路上的极高调用速率 → **gRPC**，并且要测量。我的约 2 倍不是你的 2 倍。
- 只有一个端点的小服务 → **REST**。代码生成是你赚不回来的开销。

**gRPC vs REST** 不是一场要分出胜负的比赛，而是一道关于“由谁承担复杂度”的选择题。gRPC 把复杂度放进构建流水线，交给你一份强类型、可流式、高效的契约；REST 把复杂度放进运行时，交给你一个地球上任何工具都能说的东西。选那个你更愿意承担其代价的。
