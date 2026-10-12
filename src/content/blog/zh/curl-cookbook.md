---
title: "一份实用的 curl 教程：我真正在用的 flags，以及输出到底在说什么"
description: "一份实用的 curl 教程，讲清我日常真正在用的 curl flags：用 -v/-i/-D 读请求与响应，用 curl -w timing 里的 %{time_total} 拆分耗时，-L 与 --max-redirs，--fail 与 exit codes，-d/--json/-F 发请求体，-H/-A/-e 设置请求头，-u/--netrc 做认证，HTTP/2 与 HTTP/3，用 --resolve 做本地测试，以及调 HTTP 请求时为什么 -v 远比瞎猜管用。"
pubDate: 2026-12-03
lang: zh
translationKey: curl-cookbook
tags: [linux, networking]
featured: false
keywords:
  - curl 教程
  - curl flags
  - curl -w timing
  - 调试 HTTP 请求
  - HTTP/2
---

在我终端里，`curl` 是我敲得最多的命令，没有之一。API 一抽风，第一个跑的是它；部署要不要验一下，最后一个跑的也是它；想向自己证明“线上到底传了什么”，靠的还是它。这是一份实用的 **curl 教程**——不是那本厚到离谱的 man page，而是我真正在用的 **curl flags**、每个 flag 会打印什么，以及请求出问题时该怎么读输出。如果问题其实在 HTTP 之下，那同一个请求会出现在抓包里：那就是[读懂 tcpdump 与 Wireshark](/zh/posts/reading-a-packet-capture/)。

下面每个例子都真实跑在一个 `127.0.0.1:8731` 的小 Python 服务上，所以数字都是真的，输出只是做了裁剪，没有编造。

## 看清整个请求：`-v`、`-i` 与 `-D`

如果只能学一个 flag，就学 `-v`。它会打印连接过程、请求头和响应头，并且每一行都带了前缀，让你永远知道数据往哪个方向走：

```text
$ curl -sv http://127.0.0.1:8731/
*   Trying 127.0.0.1:8731...
* Established connection to 127.0.0.1 (127.0.0.1 port 8731)
* using HTTP/1.x
> GET / HTTP/1.1
> Host: 127.0.0.1:8731
> User-Agent: curl/8.22.0
> Accept: */*
>
< HTTP/1.1 200 OK
< Content-Type: text/plain
< Content-Length: 36
< X-Demo: curl-cookbook
<
hello from the curl cookbook server
* Connection #0 to host 127.0.0.1:8731 left intact
```

看三种前缀：`*` 是 curl 在跟你说话（连接建立、协议、连接复用），`>` 是 curl *发出去*的，`<` 是服务端*返回*的。空的 `>` 和 `<` 行表示这一段 header 结束。十次里有九次，bug 就摆在这儿——少了个 `Content-Type`、`Host` 跟 vhost 对不上、本该 `200` 却来了个 `302`。

只想要响应时，`-i` 会把响应头和 body 一起打印，而 `-D` 把响应头写进文件、让 body 保持干净：

```bash
# -i：先头后体，直接打到终端
curl -si http://127.0.0.1:8731/ | head -6

# -D：头存一个文件、体存另一个，之后好 grep
curl -sS -o body.txt -D headers.txt http://127.0.0.1:8731/
```

脚本里我默认用 `-D`：`grep -i 'cache-control\|etag' headers.txt` 立刻告诉你这个响应能不能被缓存、有没有校验器——这正是 [HTTP 缓存](/zh/posts/http-caching/)的全部关键。

## curl -w timing：让 curl 告诉你时间花在哪

`-w`（write out）能把 curl 变成一个计时器。`%{time_total}` 是最抢眼的那个，但真正有用的是拆分：`time_namelookup`（DNS）、`time_connect`（TCP）、`time_starttransfer`（首字节时间，TTFB）和总时间。

```bash
$ curl -sS -o /dev/null \
    -w 'code=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
    http://127.0.0.1:8731/slow
code=200 ttfb=0.400861s total=0.400899s
```

服务端故意睡了 400 毫秒，这个拆分就讲清了故事：TTFB 和 total 几乎一样，说明时间全在服务端，跟传输无关。反过来，如果 `time_connect` 很大，你就该怀疑网络；如果 `time_namelookup` 很大，那就是 DNS。这一行，在你伸手去拿别的工具之前，就已经把“我的代码慢”和“网络慢”分开了。

把格式串存下来，省得每次重敲：

```bash
# -w @file 从文件里读格式串
printf 'http_code=%%{http_code} ttfb=%%{time_starttransfer}s total=%%{time_total}s\n' > wfmt.txt
curl -sS -o /dev/null -w @wfmt.txt http://127.0.0.1:8731/
```

## 重定向：`-L` 与 `--max-redirs`

curl **默认不跟随重定向**。不加 `-L`，你只会拿到那个 `3xx` 和一个 `Location` 头，别的什么都没有：

```bash
$ curl -sS -o /dev/null -D - http://127.0.0.1:8731/redirect
HTTP/1.1 302 Found
Location: /
```

加上 `-L` 才会跟着跳，再用 `%{num_redirects}` 数一下跳了几次。同一个 URL，加与不加：

```bash
$ curl -sSL -o /dev/null -w 'code=%{http_code} redirects=%{num_redirects}\n' \
    http://127.0.0.1:8731/redirect
code=200 redirects=1
```

`--max-redirs` 给跳转链设一个上限——当重定向循环正在吃你时间时特别有用，它会给一个干净的 exit code，而不是无限地打下去：

```bash
$ curl -sSL --max-redirs 0 -o /dev/null http://127.0.0.1:8731/redirect
curl: (47) Maximum (0) redirects followed
$ echo $?
47
```

## 错误与 exit codes：`--fail`、`-o` 与 `-sS`

默认情况下，哪怕返回 `404`，curl 也是退出 `0`——它成功地把字节送到了，所以在 curl 眼里什么都没失败。对脚本来说，这恰恰是错的。`--fail` 会把 `4xx`/`5xx` 变成一个非零退出码：

```bash
$ curl -sS -o /dev/null -w 'code=%{http_code}\n' http://127.0.0.1:8731/missing
code=404
$ echo $?          # curl 很满意：它拿到响应了
0

$ curl -sS --fail -o /dev/null http://127.0.0.1:8731/missing
curl: (22) The requested URL returned error: 404
$ echo $?
22
```

exit codes 本身就是一套 API：`6` 是“域名解析不了”，`7` 是“连不上”，`22` 是“配了 `--fail` 的 HTTP 错误”，`28` 是超时，`47` 是重定向太多。连接被拒时会直白地告诉你：

```bash
$ curl -sS -o /dev/null http://127.0.0.1:9/
curl: (7) Failed to connect to 127.0.0.1 port 9: Could not connect to server
$ echo $?
7
```

两个习惯能让脚本安全。`-o FILE` 把 body 送进文件，这样进度条或载荷永远不会混进 stdout；`-sS` 表示*silent 但保留错误*——不要进度条，但真实失败照常打印。单用 `-s` 会把错误信息也一起藏掉，这正是人们最后盯着一个 0 字节文件、完全不知道为啥的原因。

## 方法与请求体：`-X`、`-d`、`--json` 与 `-F`

`-d` 发送请求体并隐含 `POST`。发 JSON 时，`--json` 比手写 header 更短，而且它把两件事都做对了：设置 `Content-Type: application/json` 和 `Accept: application/json`。

```bash
$ curl -sS --json '{"hello":"world"}' http://127.0.0.1:8731/echo
{
  "received": "{\"hello\":\"world\"}",
  "content_type": "application/json",
  "user_agent": "curl/8.22.0"
}
```

表单上传用 `-F`，它会构造 `multipart/form-data`，文件也能带上：

```bash
curl -sS -F 'file=@report.pdf' -F 'note=hello' https://api.example.com/upload
```

`-X` 只在需要覆盖方法时才用（`-X DELETE`、`-X PUT`）。别写 `-X POST` 配 `-d`——`-d` 已经隐含它了，而手动 `-X` 有可能让你意外发出一个带 body 的 `GET`。

## 请求头：`-H`、`-A` 与 `-e`

`-H` 能加或替换任意 header，并且可以重复。`-A` 设置 user agent、`-e` 设置 `Referer`，两者都是 `-H` 的简写：

```bash
$ curl -sv -H 'X-Trace: abc123' -A 'cookbook/1.0' \
    -e 'https://blog.awin-x.top/' http://127.0.0.1:8731/ 2>&1 | grep '^> '
> GET / HTTP/1.1
> Host: 127.0.0.1:8731
> User-Agent: cookbook/1.0
> Accept: */*
> Referer: https://blog.awin-x.top/
> X-Trace: abc123
```

想发一个空 header（有些服务端需要没有值的 `Accept-Encoding:`），用带结尾分号的 `-H 'Name;'`。

## 认证：`-u` 与 `--netrc`

`-u user:pass` 走 HTTP Basic 认证。curl 会把它变成一个 base64 的 `Authorization` 头——你可以用 `-v` 亲眼看到它发生：

```bash
$ curl -sv -u alice:s3cret http://127.0.0.1:8731/ 2>&1 | grep -i authorization
> Authorization: Basic YWxpY2U6czNjcmV0
```

把密钥写在命令行上，会泄漏进 shell history 和 `ps`。`--netrc` 改成从文件读凭据，`--netrc-file` 可以指定具体哪个文件：

```bash
# ~/.netrc — chmod 600
machine api.example.com
  login alice
  password s3cret

curl -sS --netrc-file ~/.netrc https://api.example.com/private
```

## TLS、HTTP/2 与 HTTP/3：`--http2`、`--http3`、`-k`、`--cert`

`curl -V` 列出你这套构建能讲哪些协议；我这边印着 `HTTP2 HTTP3`：

```text
Features: alt-svc AsynchDNS brotli ... HTTP2 HTTP3 HTTPS-proxy ... TLS-SRP
```

`--http2` 通过 ALPN 提议 HTTP/2，服务端不接受就退回 HTTP/1.1；`--http3` 走 UDP 上的 QUIC。两者都取决于*服务端*，所以对着我这个 HTTP/1.1 测试服务，协商结果就是落在 `HTTP/1.x`——就是上面那行 `* using HTTP/1.x`。这些 flag 改的是 curl *提议*什么，不是服务端接受什么。

`-k`（或 `--insecure`）跳过证书校验。它只是调试工具：用它确认一次是不是证书问题，然后回去修信任链。客户端证书用 `--cert` 和 `--key`：

```bash
# 排查：到底是 TLS 的问题，还是应用的问题？
curl -vk https://self-signed.local:8443/health

# 双向 TLS，带客户端证书
curl --cert client.pem --key client.key https://mtls.example.com/api
```

## 连接复用与 `--resolve` 测试

curl 在同一次调用里会复用连接。`--resolve host:port:ip` 让你把某个主机名指向某个 IP，而*不用改 DNS 或 `/etc/hosts`*——在解析记录切换之前测试新后端，这是最有用的一招：

```bash
$ curl -sS --resolve demo.local:8731:127.0.0.1 \
    -w 'code=%{http_code} ip=%{remote_ip}:%{remote_port}\n' \
    http://demo.local:8731/
code=200 ip=127.0.0.1:8731
```

`%{remote_ip}` 会确认 curl 确实连到了你指定的地方。我就是在生产流量还指向别处时，用真实主机名去验证 TLS、vhost 和一次全新部署的。

## 调试 HTTP 请求：为什么 `-v` 比瞎猜管用

值得第一个伸手去拿 `-v`，是因为 HTTP 在某种意义上是一种能穿透 TLS 的文本协议：curl 自己解密自己的连接，所以即使走 HTTPS，`-v` 也能让你看到请求和响应确切的字节。瞎猜（“是不是认证头的问题”“是不是被缓存了”）要花好几分钟；一次 `-v` 只要几秒。

一个能发现大多数 bug 的节奏：

1. `curl -v`——请求是不是你以为的样子？URL、方法、headers、body 对不对？
2. 看响应行（`200`、`302`、`403`、`500`），然后看 headers，尤其是 `Location`、`Content-Type`、`Cache-Control`。
3. 加上 `-w '%{http_code} %{time_total}s\n'`——是不是慢？慢在哪？
4. 涉及重定向就加 `-L`；需要脚本在意结果就加 `--fail`。
5. 只有当线路本身看着不对劲时，才去抓包。

## 一张速查表

- `-v` 看请求/响应，`-i` 连头带体，`-D` 把头写进文件。
- `-w '%{time_total}s'` 以及它的兄弟们，用来拆分 DNS、连接和 TTFB。
- `-L` 跟随重定向，`--max-redirs` 给它设限。
- `--fail` 让 HTTP 错误变成非零退出码；`-sS` 安静，但出错时照喊。
- `--json` 发 JSON，`-F` 发 multipart，其余的用 `-d`。
- 应急用 `-u`，正经事用 `--netrc-file`。
- `--resolve` 把主机名指到指定 IP 测试，不碰 DNS。

这些都不冷门。它们就是那二十来个 flag，把 curl 从“发个请求”变成“把到底发生了什么，一字不差地告诉我”——而这，正是我们伸手去拿它的全部意义。
