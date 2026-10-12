---
title: "A practical curl tutorial: the flags I actually use (and what the output means)"
description: "The curl flags I use daily, explained with real output: -v/-i/-D to read requests, curl -w timing, -L and --max-redirs, --fail and exit codes, -d/--json/-F bodies, headers and auth, HTTP/2 and HTTP/3, --resolve for testing, and why -v beats guessing."
pubDate: 2026-12-03
lang: en
translationKey: curl-cookbook
tags: [linux, networking]
featured: false
keywords:
  - curl tutorial
  - curl flags
  - curl -w timing
  - debug HTTP requests
  - HTTP/2
---

I have typed `curl` more than any other command in my terminal. It is the first thing I run when an API misbehaves, the tool I use to prove what actually went over the wire, and the fastest way to stop guessing what a header, a redirect, or a timeout is doing. This is a practical **curl tutorial** — not the whole manual page (which is genuinely enormous), but the **curl flags** I actually use, what each one prints, and how to read the output when a request goes wrong. When the problem turns out to be below HTTP, the same request shows up in a packet capture: that is the [tcpdump and Wireshark walkthrough](/posts/reading-a-packet-capture/).

Every example below was run against a tiny Python server on `127.0.0.1:8731`, so the numbers are real and the output is trimmed rather than invented.

## Seeing the whole request: `-v`, `-i`, and `-D`

If you learn one flag, learn `-v`. It prints the connection, the request headers, and the response headers, each tagged so you always know which direction a line travelled:

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

Read the three prefixes: `*` is curl talking to you (connection setup, protocol, connection reuse), `>` is what curl *sent*, and `<` is what the server *sent back*. The blank `>` and `<` lines end each header block. Nine times out of ten the bug is visible here — a missing `Content-Type`, a `Host` that does not match your vhost, a `302` where you wanted a `200`.

When you only want the response, `-i` includes headers with the body, and `-D` writes headers to a file and leaves the body clean:

```bash
# -i: headers then body, straight to the terminal
curl -si http://127.0.0.1:8731/ | head -6

# -D: save headers to a file, body to another — easy to grep later
curl -sS -o body.txt -D headers.txt http://127.0.0.1:8731/
```

`-D` is my default in scripts: `grep -i 'cache-control\|etag' headers.txt` tells you instantly whether a response is cacheable and whether it has a validator, which is the whole game in [HTTP caching](/posts/http-caching/).

## curl -w timing: make curl report where the time went

`-w` ("write out") turns curl into a timing instrument. `%{time_total}` is the headline, but the split matters more: `time_namelookup` (DNS), `time_connect` (TCP), `time_starttransfer` (time to first byte), and the total.

```bash
$ curl -sS -o /dev/null \
    -w 'code=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
    http://127.0.0.1:8731/slow
code=200 ttfb=0.400861s total=0.400899s
```

The server deliberately sleeps 400 ms, and the split tells the story: TTFB and total are nearly identical, so all the time is server-side, not transport. If instead `time_connect` were large, you would suspect the network; if `time_namelookup` were large, DNS. That one line separates "my code is slow" from "the network is slow" before you reach for anything else.

Keep a reusable format string so you never retype it:

```bash
# -w @file reads the format from a file
printf 'http_code=%%{http_code} ttfb=%%{time_starttransfer}s total=%%{time_total}s\n' > wfmt.txt
curl -sS -o /dev/null -w @wfmt.txt http://127.0.0.1:8731/
```

## Redirects: `-L` and `--max-redirs`

curl does **not** follow redirects by default. Without `-L` you get the `3xx` and a `Location` header and nothing else:

```bash
$ curl -sS -o /dev/null -D - http://127.0.0.1:8731/redirect
HTTP/1.1 302 Found
Location: /
```

Add `-L` to follow, and `%{num_redirects}` to count the hops. The same URL, with and without:

```bash
$ curl -sSL -o /dev/null -w 'code=%{http_code} redirects=%{num_redirects}\n' \
    http://127.0.0.1:8731/redirect
code=200 redirects=1
```

`--max-redirs` caps the chain — useful when a redirect loop is eating your time, and it gives a clean exit code instead of hammering forever:

```bash
$ curl -sSL --max-redirs 0 -o /dev/null http://127.0.0.1:8731/redirect
curl: (47) Maximum (0) redirects followed
$ echo $?
47
```

## Errors and exit codes: `--fail`, `-o`, and `-sS`

By default curl exits `0` even on a `404` — it delivered bytes successfully, so from curl's point of view nothing failed. That is exactly wrong for a script. `--fail` makes a `4xx`/`5xx` a non-zero exit:

```bash
$ curl -sS -o /dev/null -w 'code=%{http_code}\n' http://127.0.0.1:8731/missing
code=404
$ echo $?          # curl is happy: it got a response
0

$ curl -sS --fail -o /dev/null http://127.0.0.1:8731/missing
curl: (22) The requested URL returned error: 404
$ echo $?
22
```

Exit codes are a whole API: `6` is "couldn't resolve host", `7` is "couldn't connect", `22` is "HTTP error with `--fail`", `28` is timeout, `47` is too many redirects. When a connection is refused you get it plainly:

```bash
$ curl -sS -o /dev/null http://127.0.0.1:9/
curl: (7) Failed to connect to 127.0.0.1 port 9: Could not connect to server
$ echo $?
7
```

Two habits make scripts safe. `-o FILE` sends the body to a file so you never mix progress or payload into stdout, and `-sS` means *silent but show errors* — no progress meter, but real failures still print. `-s` alone hides the error message too, which is how people end up staring at a `0`-byte file with no idea why.

## Methods and bodies: `-X`, `-d`, `--json`, and `-F`

`-d` sends a body and implies `POST`. For JSON, `--json` is shorter than hand-writing headers and it gets both parts right: it sets `Content-Type: application/json` and `Accept: application/json`.

```bash
$ curl -sS --json '{"hello":"world"}' http://127.0.0.1:8731/echo
{
  "received": "{\"hello\":\"world\"}",
  "content_type": "application/json",
  "user_agent": "curl/8.22.0"
}
```

For form uploads, `-F` builds a `multipart/form-data` body, including files:

```bash
curl -sS -F 'file=@report.pdf' -F 'note=hello' https://api.example.com/upload
```

Use `-X` only to override the method (`-X DELETE`, `-X PUT`). Do not write `-X POST` with `-d` — `-d` already implies it, and a manual `-X` can accidentally send a `GET` with a body.

## Headers: `-H`, `-A`, and `-e`

`-H` adds or replaces any header, and it is repeatable. `-A` sets the user agent and `-e` sets the `Referer`, both as short forms of `-H`:

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

To send an empty header (some servers need `Accept-Encoding:` with no value), use `-H 'Name;'` with a trailing semicolon.

## Auth: `-u` and `--netrc`

`-u user:pass` does HTTP Basic auth. curl turns it into a base64 `Authorization` header — which you can watch happen with `-v`:

```bash
$ curl -sv -u alice:s3cret http://127.0.0.1:8731/ 2>&1 | grep -i authorization
> Authorization: Basic YWxpY2U6czNjcmV0
```

Typing secrets on the command line leaks them into your shell history and `ps`. `--netrc` reads credentials from a file instead, and `--netrc-file` points at a specific one:

```bash
# ~/.netrc — chmod 600
machine api.example.com
  login alice
  password s3cret

curl -sS --netrc-file ~/.netrc https://api.example.com/private
```

## TLS, HTTP/2, and HTTP/3: `--http2`, `--http3`, `-k`, `--cert`

`curl -V` lists what your build can speak; mine advertises `HTTP2 HTTP3`:

```text
Features: alt-svc AsynchDNS brotli ... HTTP2 HTTP3 HTTPS-proxy ... TLS-SRP
```

`--http2` offers HTTP/2 via ALPN and falls back to HTTP/1.1 if the server declines; `--http3` uses QUIC over UDP. Both depend on the *server*, so against my HTTP/1.1 test server the negotiation simply lands on `HTTP/1.x` — noted in the `* using HTTP/1.x` line above. The flags change what curl *offers*, not what the server accepts.

`-k` (or `--insecure`) skips certificate verification. It is a debugging tool only: use it once to confirm a cert problem, then fix the trust chain. For client certificates, `--cert` and `--key`:

```bash
# Diagnose: is it TLS or is it the app?
curl -vk https://self-signed.local:8443/health

# Mutual TLS with a client cert
curl --cert client.pem --key client.key https://mtls.example.com/api
```

## Connection reuse and `--resolve` for testing

curl reuses connections within a single invocation. `--resolve host:port:ip` lets you point a hostname at an IP *without editing DNS or `/etc/hosts`* — the single most useful trick for testing a new backend before the record flips:

```bash
$ curl -sS --resolve demo.local:8731:127.0.0.1 \
    -w 'code=%{http_code} ip=%{remote_ip}:%{remote_port}\n' \
    http://demo.local:8731/
code=200 ip=127.0.0.1:8731
```

`%{remote_ip}` confirms curl connected where you told it to. This is how I verify TLS, vhosts, and a fresh deploy behind the real hostname while production traffic still goes elsewhere.

## Debug HTTP requests: why `-v` beats guessing

The reason to reach for `-v` first is that HTTP is a text protocol in a way that survives TLS: curl decrypts its own connection, so `-v` shows you the exact bytes of the request and response even over HTTPS. Guessing ("maybe it's the auth header", "maybe it cached") costs minutes; one `-v` costs seconds.

A rhythm that finds most bugs:

1. `curl -v` — is the request what you think it is? Right URL, method, headers, body?
2. Check the response line (`200`, `302`, `403`, `500`) and then the headers, especially `Location`, `Content-Type`, `Cache-Control`.
3. Add `-w '%{http_code} %{time_total}s\n'` — is it slow, and where?
4. Add `-L` if a redirect is involved; add `--fail` if you need scripts to care.
5. Only then reach for a packet capture, if the wire itself looks wrong.

## The short list

- `-v` for the request/response, `-i` for headers with the body, `-D` for headers to a file.
- `-w '%{time_total}s'` and friends to split DNS, connect, and TTFB.
- `-L` to follow redirects, `--max-redirs` to cap them.
- `--fail` so HTTP errors become non-zero exit codes; `-sS` for quiet-but-loud-on-error.
- `--json` for JSON, `-F` for multipart, `-d` for the rest.
- `-u` in a pinch, `--netrc-file` for anything real.
- `--resolve` to test a hostname against a specific IP without touching DNS.

None of these are exotic. They are the twenty flags that turn curl from "make a request" into "tell me exactly what happened" — and that is the whole point of reaching for it.
