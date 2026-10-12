---
title: "gRPC vs REST: an honest comparison, with real calls"
description: "I ran a throwaway gRPC service next to a REST equivalent and measured the wire: grpcurl output, HTTP/2 frames, protobuf vs JSON bytes, streaming, and deadlines — then wrote down where each one actually wins."
pubDate: 2026-12-22
lang: en
translationKey: grpc-vs-rest
tags: [networking, devops]
featured: false
keywords:
  - gRPC vs REST
  - gRPC
  - protobuf
  - grpcurl
  - HTTP/2
---

The **gRPC vs REST** argument is usually fought with adjectives. gRPC is "modern", REST is "simple", and nobody shows you a packet. So for this one I stood up a throwaway **gRPC** service in Docker with reflection turned on, wrote a REST endpoint that returns the same data, and measured both instead of arguing about them. Everything below is output I actually got, on one machine, over 127.0.0.1.

The short version: gRPC is not "faster REST". It is a different contract. It moves work from runtime to build time and from the human eye to a schema, and that trade is exactly why it is great inside a service mesh and awkward in a browser.

## What gRPC actually is: HTTP/2, protobuf, and codegen

Strip the branding and gRPC is three ordinary pieces bolted together:

- **HTTP/2** as the transport — one connection, many concurrent streams, and **trailers** at the end of a response.
- **protobuf** as the wire format — a compact, typed binary encoding driven by a `.proto` schema.
- **codegen** from that schema — `protoc` emits client stubs and server interfaces in your language.

The schema is the center of gravity. Here is the whole demo service:

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

From this, `protoc` generates the types and the stubs. That is the difference no REST framework gives you: the contract is a compiled artifact, not a convention.

## A real gRPC call, with reflection and grpcurl

I started a test server (`moul/grpcbin`) with reflection enabled, then used **grpcurl** — the `curl` of gRPC — without any `.proto` file on the client side. Reflection lets it ask the server for the schema:

```console
$ grpcurl -plaintext grpcbin:9000 list
addsvc.Add
grpc.gateway.examples.examplepb.ABitOfEverythingService
grpc.reflection.v1alpha.ServerReflection
grpcbin.GRPCBin
hello.HelloService
```

Now the unary call, verbose, so you can see what travels around the payload:

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

Two things to notice. The path is `hello.HelloService/SayHello` — the method is in the URL, but there is no verb and no resource modeling. And the response headers are just `content-type: application/grpc`; the real status arrives later, in the **trailers**, as `grpc-status`.

That first command is also a small safety lesson: I left reflection on for the lab, but in production it hands your entire schema to anyone who asks. Most teams disable it and ship the `.proto` files to clients out of band.

## The HTTP/2 framing underneath

`grpcurl` hides the frames, so I wrote a small `h2` client that speaks the same call and logs every frame it sees:

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

This is gRPC laid bare. The response is one `HEADERS` frame, one `DATA` frame, and a `TRAILERS` frame carrying `grpc-status: 0`. That DATA payload starts with five bytes — `00 00 00 00 17` — a compression flag plus a 4-byte big-endian length prefix (`0x17` = 23). Everything after it is raw protobuf, not text.

<figure>
<svg viewBox="0 0 700 250" width="100%" role="img" aria-label="Left: a gRPC call over HTTP/2 with a HEADERS frame, a DATA frame carrying a 5-byte length prefix and binary protobuf, and a TRAILERS frame carrying grpc-status. Right: a REST call over HTTP/1.1 with a text header block and a human-readable JSON body.">
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
    <text x="20" y="182" font-size="11" opacity="0.75">5-byte length prefix + binary protobuf</text>

    <text x="380" y="20" font-size="13">REST over HTTP/1.1</text>
    <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.85">
      <rect x="380" y="32" width="300" height="66" rx="6"/>
      <rect x="380" y="104" width="300" height="34" rx="6"/>
    </g>
    <text x="392" y="52">GET /hello/DeepSeek HTTP/1.1</text>
    <text x="392" y="70">Host: …  Accept: */*</text>
    <text x="392" y="88">Cache-Control: public, max-age=60</text>
    <text x="392" y="126">{"reply": "hello DeepSeek"}</text>
    <text x="380" y="156" font-size="11" opacity="0.75">text headers, text body, readable by eye</text>
    <text x="380" y="176" font-size="11" opacity="0.75">status is 200 OK in the first line</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <path d="M20 208 H660" stroke-dasharray="4 4"/>
    <rect x="20" y="220" width="300" height="24" rx="6"/>
    <rect x="380" y="220" width="300" height="24" rx="6"/>
  </g>
  <g font-family="system-ui, sans-serif" font-size="11.5" fill="currentColor">
    <text x="32" y="236">protocol → codegen → typed stub (build time)</text>
    <text x="392" y="236">hand-written client, JSON parsed at runtime</text>
  </g>
</svg>
<figcaption>Same data, two wires. gRPC splits status into trailers and hides the payload behind a length prefix and a binary encoding; REST puts everything in text you can read with `od`. Neither is "better" — one is machine-first, the other human-first.</figcaption>
</figure>

## What protobuf actually saves on the wire

This is the claim people repeat without numbers, so I measured it with `protoc --encode`. First the tiny payload above: the request is **17 bytes** of protobuf against **30 bytes** of the equivalent JSON; the response is **23** against **33**. Then a more realistic one, 50 user records:

```console
$ python measure.py
payload: 50 records, each {name,email,id,active,tags:[beta,eu-west]}
protobuf bytes : 2650
JSON bytes     : 5186
JSON/protobuf  : 1.96x
```

Protobuf is roughly half the size here. That is real, but note what it is *not*: it is not free bandwidth, because gzip on a JSON body closes much of the gap, and it is not "faster" by itself — the win shows up on large payloads, high request rates, and mobile links, not on a 30-byte hello.

## The wins of gRPC

- **A schema that is enforced.** The `.proto` is the contract, versioned like code, checked at compile time. You cannot accidentally send a string where a number is expected.
- **Codegen.** Run `protoc` and you get typed stubs in every language:

```console
$ python -m grpc_tools.protoc -I. --python_out=gen --grpc_python_out=gen hello.proto
$ ls -l gen
-rw-r--r-- 1 root root 1872 hello_pb2.py
-rw-r--r-- 1 root root  589 hello_pb2.pyi
-rw-r--r-- 1 root root 8462 hello_pb2_grpc.py
```

- **Streaming as a first-class word in the schema** (`stream`), not a bolted-on protocol.
- **Binary efficiency** — the ~2x measured above.
- **Deadlines that propagate.** This is underrated. A gRPC call carries a deadline; when it passes, the client gives up *and* the server is told. I pointed a client at a server that sleeps 5s and gave it 1s:

```console
$ grpcurl -plaintext -max-time 1 -d '{"greeting":"DeepSeek"}' \
    grpc-tools:9090 hello.HelloService/SayHello
ERROR:
  Code: DeadlineExceeded
  Message: context deadline exceeded
  Sent 1 request and received 0 responses
# exit code 68
```

You get a typed status code (`DEADLINE_EXCEEDED`, HTTP 504 in gRPC's mapping) instead of a socket that hangs. The status is structured, not a string: `OK`, `NOT_FOUND`, `INVALID_ARGUMENT`, `UNAVAILABLE` and a dozen more, each with a fixed name your client can switch on.

## The costs of gRPC

- **You cannot debug it by hand.** Here is `curl` making the same call — it can speak HTTP/2 to a gRPC endpoint, but what comes back is opaque:

```console
$ curl --http2-prior-knowledge -H 'content-type: application/grpc' -H 'te: trailers' \
    --data-binary @reqframe.bin http://grpcbin:9000/hello.HelloService/SayHello | od -An -tx1 -v
HTTP/2 200
content-type: application/grpc
grpc-status: 0
grpc-message:
 00 00 00 00 17 0a 15 68 65 6c 6c 6f 20 48 65 6c 6c 6f 2c 20 44 65 65 70 53 65 65 6b
```

Without `grpcurl` and a schema, that hex is just noise. No `jq`, no reading it in a terminal.
- **Browsers cannot call it directly.** gRPC needs HTTP/2 trailers and fine-grained framing that `fetch()` does not expose; you need grpc-web and a proxy (`envoy`, or a grpc-web gateway) that translates. That is real infrastructure you now operate.
- **Tooling and infra lag.** Proxies, CDNs, load balancers, and observability tools historically assumed HTTP/1.1 and JSON; support exists now, but it is more configuration and more places to get wrong.
- **Schema governance is a new job.** You now own a registry, backward-compatibility rules, and the discipline of never renumbering a field. That is real work.
- **Status codes do not map cleanly to HTTP.** `grpc-status` lives in trailers, so an HTTP-aware middlebox sees a `200 OK` even when the call failed. You need tooling that understands the second status, or your metrics will lie.
- **Caching gets harder** — the very topic of [HTTP caching](/posts/http-caching/). gRPC is POST-shaped, so caches largely stay out of the way.

## REST and JSON, honestly

REST's wins are almost the mirror image. It runs on anything that speaks HTTP: `curl` on any box, a browser, a mobile SDK, a shell script.

```console
$ curl -v http://127.0.0.1:18080/hello/DeepSeek
> GET /hello/DeepSeek HTTP/1.1
< HTTP/1.1 200 OK
< Content-Type: application/json
< Content-Length: 27
< Cache-Control: public, max-age=60
{"reply": "hello DeepSeek"}
```

Everything is legible, the status is in the first line, and `Cache-Control` actually means something to a CDN or a browser. There is no codegen step, which means no build step, no generated files to commit, and no schema drift between client and server — for better and worse. The costs: no enforced contract (schema drift is your problem), larger payloads, weaker streaming, and no standard deadline mechanism — you invent timeouts and propagate them yourself. Idempotency and retry semantics also have to be designed rather than declared; that is what [idempotency keys](/posts/idempotency-keys/) are for.

## Streaming patterns

gRPC names four shapes, and `grpcurl` shows all of them against the same service:

```console
# server streaming: one request, a stream of replies (10 of them)
$ grpcurl -plaintext -d '{"greeting":"DeepSeek"}' grpcbin:9000 hello.HelloService/LotsOfReplies
{ "reply": "hello DeepSeek" }
... 10 messages total

# client streaming: many requests, one reply
$ grpcurl -plaintext -d '{"greeting":"one"}{"greeting":"two"}{"greeting":"three"}' \
    grpcbin:9000 hello.HelloService/LotsOfGreetings
{ "reply": "hello one, two, three" }

# bidi streaming: both directions, interleaved
$ grpcurl -plaintext -d '{"greeting":"alpha"}{"greeting":"beta"}' grpcbin:9000 hello.HelloService/BidiHello
{ "reply": "hello alpha" }
{ "reply": "hello beta" }
```

The REST equivalent of server streaming is chunked newline-delimited JSON — workable, but it is a convention you build, not a protocol primitive. Client and bidi streaming have no natural REST form at all; you end up on WebSockets or SSE, and each of those is another protocol to learn and proxy.

## gRPC vs REST, side by side

| | gRPC | REST / JSON |
|---|---|---|
| Transport | HTTP/2 (trailers required) | HTTP/1.1 or HTTP/2, any |
| Payload | Binary protobuf | Text JSON |
| Contract | `.proto` schema, compiled | Convention / OpenAPI, if you add it |
| Client code | Generated from schema | Hand-written |
| Browser support | Needs grpc-web + proxy | Native, `fetch()` |
| Debuggable by hand | No (`grpcurl` + schema needed) | Yes (`curl`, `jq`) |
| Streaming | Unary, server, client, bidi | Request/response; SSE or WS for streams |
| Caching | Effectively none (POST-shaped) | Core feature (`Cache-Control`, ETag) |
| Deadlines | Built in and propagated | You implement it |
| Best fit | Internal service-to-service | Public and browser-facing APIs |

## How I decide

- Public API, browser clients, or third parties I do not control → **REST/JSON**. Never make outsiders install a codegen toolchain.
- Service-to-service inside one system, where I ship both ends → **gRPC**. The schema and generated stubs pay for themselves immediately.
- Streaming that is genuinely bidirectional or long-lived → **gRPC**. Do not fake it with polling.
- Something a human will `curl` at 2 a.m. during an incident → **REST**. Debuggability is a feature.
- Large payloads or very high call rates on a tight link → **gRPC**, and measure. My ~2x is not your 2x.
- A tiny service with one endpoint → **REST**. Codegen is overhead you will not earn back.

**gRPC vs REST** is not a contest to win; it is a choice about who absorbs the complexity. gRPC puts it in the build pipeline and hands you a typed, streaming, efficient contract. REST puts it in the runtime and hands you something any tool on earth can speak. Pick the one whose costs you would rather own.
