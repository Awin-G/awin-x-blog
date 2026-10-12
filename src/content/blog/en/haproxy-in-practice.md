---
title: "HAProxy in practice: the load balancer that never surprises you"
description: "A hands-on HAProxy guide: the HAProxy config model (defaults, frontend, backend), mode http vs mode tcp, roundrobin vs leastconn, active health checks that eject a dead backend live, timeouts and retries, and the stats page — reproduced on haproxy 3.0 with real output."
pubDate: 2027-01-05
lang: en
translationKey: haproxy-in-practice
tags: [devops, nginx]
featured: false
keywords:
  - HAProxy
  - HAProxy config
  - health check
  - load balancing
  - mode tcp
---

**HAProxy** is the proxy I reach for when the job is "balance these TCP or HTTP backends and never surprise me." It is not the feature-rich Swiss army knife that nginx or Envoy are, and it does not try to be. What it is: a fast L4/L7 load balancer with, in my experience, the best **health check** story of any proxy I have operated. This piece is a working walkthrough — every command and every line of output below comes from a throwaway `haproxy:3.0-alpine` container in front of two tiny backends, torn down the moment I was done. If you want the deeper nginx mechanics, they live in my [nginx config cookbook](/posts/nginx-cookbook/); for an edge-proxy comparison in the other direction, I have [Caddy vs nginx](/posts/caddy-vs-nginx/).

```
$ docker exec hap haproxy -v
HAProxy version 3.0.29-de0ed89 2026/09/28 - https://haproxy.org/
Status: long-term supported branch - will stop receiving fixes around Q2 2029.
```

## The setup: two tiny backends behind one proxy

To make the demos concrete, the backends have to answer honestly: they identify themselves, fail their health endpoint on command, and can be made slow or silent. A tiny Python origin does all three, so that is what I put behind HAProxy. Each response carries `X-Backend`, slow requests sleep, and `/healthz` returns `503` until I heal it — that last one is what lets me demo health checks without killing processes.

```python
# server.py — the throwaway backend (run one per host)
NAME = os.environ["NAME"]; SLEEP_MS = int(os.environ.get("SLEEP_MS", "400"))
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Backend", NAME)          # who am I
        self.send_header("Connection", "close")       # fresh conn per request
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path.split("?")[0]
        if   p == "/healthz": self._send(200 if HEALTHY else 503, b"ok\n")
        elif p == "/slow":   time.sleep(SLEEP_MS/1000); self._send(200, b"slow\n")
        elif p == "/hang":   time.sleep(15)          ; self._send(200, b"hang\n")  # > timeout server
        elif p == "/down":   HEALTHY=False; self._send(200, b"healthz -> 503\n")
        elif p == "/up":     HEALTHY=True ; self._send(200, b"healthz -> 200\n")
        else:                self._send(200, ("hello from "+NAME+"\n").encode())
ThreadingHTTPServer(("0.0.0.0", 80), H).serve_forever()
```

`be1` runs with `SLEEP_MS=4000` (deliberately slow `/slow`) and `be2` with `SLEEP_MS=400` — that asymmetry is what makes the later algorithm comparison visible. On a user-defined network with static IPs so no name ever has to be re-resolved:

```bash
$ docker network create --subnet 172.31.0.0/24 hbnet
$ docker run -d --name be1 --network hbnet --ip 172.31.0.11 \
      -e NAME=be1 -e SLEEP_MS=4000 -v "$PWD/server.py":/srv/server.py:ro \
      python:3.12-alpine python3 /srv/server.py
$ docker run -d --name be2 --network hbnet --ip 172.31.0.12 \
      -e NAME=be2 -e SLEEP_MS=400  -v "$PWD/server.py":/srv/server.py:ro \
      python:3.12-alpine python3 /srv/server.py
```

## The HAProxy config model: defaults, frontend, backend, listen

The whole **HAProxy config** is four kinds of block, and that smallness is the point. `defaults` holds what is shared — timeouts, logging, `mode`, `retries`. A `frontend` binds a port and decides where traffic goes; a `backend` holds the pool of `server`s and the balancing policy; a `listen` is a frontend and backend fused for self-contained jobs like the stats page. Here is the entire config driving every demo below:

```haproxy
global
    log stdout format raw local0
    stats socket /run/haproxy.sock mode 660 level admin   # CLI admin: show stat, etc.

defaults
    mode http
    log global
    option httplog
    timeout connect 2s
    timeout client  30s
    timeout server  30s
    retries 2
    option redispatch

listen stats                       # /stats page + admin socket
    bind 0.0.0.0:9000
    stats enable
    stats uri /stats
    stats auth DemoUser:DemoPass

frontend rr_in
    bind 0.0.0.0:8080
    default_backend be_rr

backend be_rr
    balance roundrobin
    option httpchk GET /healthz          # active L7 check
    http-check expect status 200
    timeout server 3s                    # short, to demo a 504
    server be1 172.31.0.11:80 check fall 3 rise 2 inter 2s
    server be2 172.31.0.12:80 check fall 3 rise 2 inter 2s
```

Two habits pay off immediately. Point `server`s at stable IPs (or pin `init-addr`) so a backend restart never forces HAProxy to gamble on a DNS answer mid-flight; and validate before you reload — `haproxy -c -f haproxy.cfg` exits `0` silently when the parse is clean, and a live `docker kill -HUP hap` prints `Loading success.` with zero dropped connections.

## Load balancing with roundrobin: the simplest baseline

`balance roundrobin` is the default: hand out one connection, move the pointer, repeat. With both origins up, six requests alternate cleanly, and each response names the server that served it:

```text
$ for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:8080/; done
hello from be2
hello from be1
hello from be2
hello from be1
hello from be2
hello from be1
```

Round-robin balances *connections*, not load. It has no idea whether a request will take 4 ms or 4 s. That single sentence explains most of why other algorithms exist.

## The health check story: watching a backend die and come back

This is the part that keeps me coming back. Every `server` line has `check ... inter 2s` — that is an *active* check, issued from the frontend side every 2 s. Because I used `option httpchk GET /healthz`, it is a real HTTP probe that must return `200`; because I did not, the `mode tcp` pool below only checks that a TCP connect completes. Now I stop `be2` and immediately fire eight requests:

```text
$ docker stop be2 && for i in $(seq 8); do curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:8080/fast; done; echo
200 200 200 200 200 200 200 200
$ for i in $(seq 8); do curl -s http://127.0.0.1:8080/fast; done | sort | uniq -c
      8 hello from be1
```

Not one failed request, and every one landed on `be1`. During the seconds before the checks fail, `be2` is still a *candidate*: round-robin aims at it, the connect is refused, and `retries 2` + `option redispatch` quietly re-dispatches the request to `be1`. Once three checks miss (`fall 3`), it is ejected outright. The connect itself is what times out here — and notice it costs exactly our `timeout connect 2s`:

```text
$ printf 'show stat' | socat - UNIX-CONNECT:/run/haproxy.sock      # be2 after ejection
pxname srv   status check_st code desc
be_rr  be1   UP     L7OK      200  Layer7 check passed
be_rr  be2   DOWN   L4TOUT         Layer4 timeout
```

```
$ docker logs hap | grep -i down
Server be_rr/be2 is DOWN, reason: Layer4 timeout, check duration: 2001ms. 1 active and 0 backup servers left.
```

`2001ms` is `timeout connect 2s` doing its job: HAProxy tried to open a TCP connection to a dead IP, gave up after two seconds, and marked the server down. Start it again and it is welcomed back the moment checks pass:

```text
$ docker start be2   # (it pins back to 172.31.0.12)
Server be_rr/be2 is UP, reason: Layer7 check passed, code: 200. 2 active and 0 backup servers online.
```

<figure>
<svg viewBox="0 0 880 330" width="100%" role="img" aria-label="A client sends requests into an HAProxy frontend on ports 8080, 8081 and 9443. The frontend load-balances and health-checks two backends: be1 at 172.31.0.11:80 is UP with a Layer7 check returning 200, while be2 at 172.31.0.12:80 is DOWN with a Layer4 timeout, drawn dashed and muted as it is ejected from rotation.">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.8">
    <rect x="18" y="128" width="140" height="72" rx="10"/>
    <line x1="158" y1="164" x2="232" y2="164"/>
    <path d="M226 159 L236 164 L226 169" fill="currentColor" stroke="none"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="88" y="158" text-anchor="middle">client</text>
    <text x="88" y="176" text-anchor="middle" font-size="11" opacity="0.7">curl · browser</text>
  </g>
  <rect x="248" y="104" width="196" height="120" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="13.5" text-anchor="middle">
    <text x="346" y="132">HAProxy frontend</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11" text-anchor="middle">
    <text x="346" y="156">:8080 :8081 :9443</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.8">
    <text x="346" y="176">balance + health check</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.4" fill="none">
    <line x1="444" y1="146" x2="516" y2="118"/>
    <path d="M510 113 L522 116 L513 124" fill="#0f766e" stroke="none"/>
  </g>
  <g stroke="currentColor" stroke-width="1.3" fill="none" opacity="0.45">
    <line x1="444" y1="182" x2="516" y2="232" stroke-dasharray="5 4"/>
    <path d="M510 223 L522 233 L510 238" fill="currentColor" stroke="none"/>
  </g>
  <rect x="526" y="52" width="336" height="86" rx="10" fill="none" stroke="#0f766e" stroke-width="2"/>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5">
    <text x="546" y="78">backend be1   172.31.0.11:80</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">
    <text x="546" y="100">UP  · L7OK 200 · check 2s (fall 3 / rise 2)</text>
    <text x="546" y="120" opacity="0.75">/slow = 4s (slow on purpose)</text>
  </g>
  <rect x="526" y="198" width="336" height="86" rx="10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="6 5" opacity="0.5"/>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="12.5" opacity="0.7">
    <text x="546" y="224">backend be2   172.31.0.12:80</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" opacity="0.65">
    <text x="546" y="246">DOWN · L4TOUT (timeout connect 2s = 2001ms)</text>
    <text x="546" y="266">ejected from rotation · requests redispatch to be1</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.6">
    <text x="18" y="312">solid = healthy and serving · dashed = removed by the health check · arrows are the active probes</text>
  </g>
</svg>
<figcaption>One frontend, two backends. HAProxy isn't routing "where I edit" — it is routing by observed health. When a probe fails enough times (<code>fall 3</code>), the server leaves rotation and the load balancer keeps serving without a human.</figcaption>
</figure>

The reason this matters operationally: it is what makes [zero-downtime deploys](/posts/zero-downtime-deploys/) possible. Drain a server, let the checks notice, restart it, let the checks re-welcome it — the pool tolerates it because the balancer, not a person, is tracking state.

## roundrobin vs leastconn: where the algorithm actually matters

If round-robin ignores load, what fixes that? `balance leastconn` picks the server with the fewest *active sessions*. The difference only shows under unequal work, so here is the cleanest test: hold one server busy with a single long `/slow` request, then fire ten instant `/fast` requests. I verified the live algorithm with `show stat` before each run (`be_lc` was toggled between `leastconn` and `roundrobin` with a full reload).

```text
# leastconn, verified live algo = leastconn
held /slow is active on be1;  /fast x10 ->   10  be2        # all to the idle one

# roundrobin, verified live algo = roundrobin
held /slow is active on be1;  /fast x10 ->    5 be1   5 be2  # rotates onto the busy one anyway
```

That is the whole idea, reproduced. While `be1` is tangled up in a 4 s request, leastconn sends every new connection to `be2`; round-robin sends half of them back to `be1` regardless. When backends are identical and fast, the two are indistinguishable — and I'd be lying if I claimed otherwise — but the moment requests cost different amounts, leastconn keeps tail latency down. (The third common choice, `balance source`, hashes the client to a fixed backend for session stickiness.)

## Timeouts and retries: defaults that keep the blast radius small

HAProxy will not let one slow backend hold a client hostage. The `defaults` above set `timeout connect 2s`, `timeout client 30s`, `timeout server 30s`, `retries 2`, and `option redispatch`. The `be_rr` pool overrides `timeout server` down to `3s` so `/hang` — which sleeps 15 s upstream — trips it:

```text
$ curl -s -o /dev/null -w 'HTTP %{http_code} in %{time_total}s\n' http://127.0.0.1:8080/hang
HTTP 504 in 3.002041s
$ docker logs hap | tail -1
172.31.0.1:41316 [...] rr_in be_rr/be2 0/0/0/-1/3001 504 198 - - sH-- 1/1/0/0/0 0/0 "GET /hang HTTP/1.1"
```

`504` at `3.002s`, and the log confirms it: the `3001` is the server time bleeding to the `timeout server 3s` wall, and `sH--` is a stalled server. `timeout connect` bounds the TCP handshake (that `2001ms` earlier was exactly this), `timeout server` bounds the backend's response, and `timeout client` bounds a slow client you don't want hogging a slot. Tuning these to your real backend profile is the difference between one slow endpoint and a pile of 504s.

## The stats page: one URL, the whole truth

A single `listen stats` gives you a web page *and* the CLI admin socket, which is where I pulled every status above. The page:

```text
$ curl -s -u DemoUser:DemoPass http://127.0.0.1:9000/stats | grep -i -m1 title
<html><head><title>Statistics Report for HAProxy on <worker-id></title>
```

and the socket, tidied to the columns I care about:

```text
$ printf 'show stat' | socat - UNIX-CONNECT:/run/haproxy.sock
pxname srv    status check_st code desc
be_rr  be1    UP     L7OK      200  Layer7 check passed
be_rr  be2    UP     L7OK      200  Layer7 check passed
be_lc  be1    UP     L7OK      200  Layer7 check passed
be_lc  be2    UP     L7OK      200  Layer7 check passed
be_tcp be1    UP     L4OK            Layer4 check passed
be_tcp be2    UP     L4OK            Layer4 check passed
```

`show stat`, `show info`, and `show servers state` turn a mystery ("why is it slow?") into two greps. Scrape `/stats;csv` into Prometheus and the same socket lets `set server be_rr/be2 state maint` drain a box on purpose.

## mode http vs mode tcp: what HAProxy can and cannot see

`mode http` parses the request: it can match paths and headers (ACLs), inject `X-Forwarded-For`, and run an L7 health check that reads a real `200`. `mode tcp` forwards bytes and knows none of that — which is exactly what you want for MySQL, Redis, or a websocket tunnel. The contrast between the two health checks is the most useful thing on this page. HTTP works through the tcp tunnel just fine (my backend is oblivious):

```text
$ curl -s -D - http://127.0.0.1:9443/fast | grep -iE '^HTTP|^X-Backend'   # :9443 is mode tcp
HTTP/1.1 200 OK
X-Backend: be1
```

Now I make `be1`'s application report unhealthy — `/healthz` starts returning `503` — and watch the two backends that point at the *same* origin disagree:

```text
be_rr  be1    DOWN   L7STS   503  Layer7 wrong status
be_lc  be1    DOWN   L7STS   503  Layer7 wrong status
be_tcp be1    UP     L4OK          Layer4 check passed      # blind to the 503
```

The log names it plainly: `Server be_rr/be1 is DOWN, reason: Layer7 wrong status, code: 503, info: "Service Unavailable"`. A `mode tcp` check only confirms the port opens, so it reports `L4OK` and keeps routing to an app that is on fire. Choose `mode http` when the health of the *application* matters and `mode tcp` when the *connection* is all there is — and if you do pick `mode tcp`, consider `option tcp-check` to at least speak a tiny protocol handshake.

ACLs are the last L7 tool worth knowing. A few lines route by content instead of by port:

```haproxy
frontend web
    bind :80
    acl is_api path_beg /api
    acl is_static path_end .css .js .png
    use_backend api    if is_api
    use_backend assets if is_static
    default_backend web
```

## HAProxy vs nginx vs Envoy: a fair comparison

I run all three, and the honest split is by shape, not by leaderboards. **nginx** is the versatile web server and reverse proxy — huge ecosystem, best docs on earth; its [cookbook](/posts/nginx-cookbook/) runs deep. **Envoy** is the dynamic, programmable L7 proxy: xDS-driven, service-mesh native, with retries, timeouts, fault injection, and rich observability built in. **HAProxy**'s lane is the fastest, most boring L4/L7 balancer: connection-based algorithms, first-class active health checks, and a single binary whose behaviour you can predict line by line. For terminating plain HTTP with caching controls I'll take nginx; for a mesh that reconfigures itself, Envoy; for in front of a database, a Redis, or a fleet of app workers who must be evicted within seconds, I keep choosing HAProxy.

## The bottom line

HAProxy earns "never surprises you" the way a plain good tool does: a four-block **HAProxy config**, **health check**s that reason about real server state, and **timeouts** that contain failures instead of amplifying them. It is the **load balancing** I hand to production when I want to sleep. Round-robin, `leastconn`, `mode tcp`, `retries`, the admin socket — none of it is clever for its own sake, and all of it, as shown above, behaves exactly as the file says.
