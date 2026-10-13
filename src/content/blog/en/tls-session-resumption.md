---
title: "TLS session resumption: full handshake vs resumed, and TLS 1.3 0-RTT"
description: "What a full TLS handshake really costs in round trips and bytes, how session IDs and session tickets (TLS 1.2) and PSK tickets (TLS 1.3) let a reconnecting client skip most of the work, how to see it with openssl s_client -sess_out/-sess_in, nginx ssl_session_cache tuning, and the TLS 1.3 0-RTT replay tradeoff."
pubDate: 2027-01-15
lang: en
translationKey: tls-session-resumption
tags: [security, networking]
featured: false
keywords:
  - TLS session resumption
  - session ticket
  - TLS 1.3 0-RTT
  - openssl s_client
  - PSK
---

Every new TLS connection pays for a **full handshake** before a single byte of your
request moves. At hobby scale you never notice; at platform scale the tax is real —
extra round trips, certificate chains re-sent on every handshake, fresh
public-key crypto per connection. **TLS session resumption** is the answer:
a reconnecting client proves it was here before and skips most of the work.

I'll show what a full handshake costs, explain the two mechanisms — session IDs
and tickets in TLS 1.2, PSK tickets in TLS 1.3 — and prove each with real
`openssl s_client` output from a throwaway nginx lab. Then: nginx
`ssl_session_cache` tuning, and TLS 1.3 0-RTT — what it buys, and the replay bill
that comes with it. Handshake mechanics first? My [TLS 1.3 walk-through](/posts/tls-1-3-handshake/)
is the prerequisite.

## What a full handshake costs

Two costs: **latency** (round trips) and **crypto** (bytes + CPU).

- TLS 1.2 needs 2 RTTs: `ClientHello`, then
  `ServerHello`/`Certificate`/`ServerHelloDone`, then
  `ClientKeyExchange`/`ChangeCipherSpec`/`Finished` — and only now can
  application data flow.
- TLS 1.3 needs 1 RTT: `ClientHello` carrying a `key_share`, then
  `ServerHello`…`Finished`. Same round trips as resumed — savings are bytes and
  server CPU, not RTT count.

The crypto is the bigger story at scale: an ECDHE key exchange, a
certificate-chain transfer, and a signature verification **per connection**. On a
100 ms-RTT mobile link, a TLS 1.2 full handshake burns ~300 ms before your first
byte; TLS 1.3 ~100 ms. Multiply by a million connections and the server's crypto
budget feels it.

Real numbers from my lab — throwaway `nginx:1.27-alpine` (nginx 1.27.5,
OpenSSL 3.3.3), self-signed RSA-2048 certificate, two vhosts on 127.0.0.1
(TLS 1.3 and TLS 1.2):

| Handshake | Bytes read | Bytes written | Total |
|---|---|---|---|
| TLS 1.3 full | 1369 | 1631 | ≈ 3.0 KB |
| TLS 1.3 resumed | 245 | 1934 | ≈ 2.2 KB |
| TLS 1.2 full | 1466 | 1626 | ≈ 3.1 KB |
| TLS 1.2 resumed | 141 | 1776 | ≈ 1.9 KB |

Two things to notice. The resumed client writes *more* — its `ClientHello`
carries the PSK extension plus a fresh `key_share` — while the server's flight
shrinks because the **certificate chain stops being re-sent** (1369 → 245 bytes
read). Net: ~25–30% less on the wire, one fewer signature verify per connection.
On loopback both measured ~15 ms (process-startup bound); the latency win only
materialises when RTT is real.

## Two mechanisms: session IDs/tickets (TLS 1.2) vs PSK tickets (TLS 1.3)

**TLS 1.2** offers two ways to resume:

- **Session ID** — the server keeps full session state in its own memory, keyed
  by an ID sent in `ServerHello`; the client echoes it on reconnect. Simple, but
  state lives server-side: no horizontal scaling without a shared session cache.
- **Session ticket** (RFC 5077) — the server encrypts the session state into an
  AES blob and hands it to the client. The server stays stateless; the client
  presents the ticket next time. The catch: the ticket encryption key must be
  shared across nodes and rotated.

**TLS 1.3** (RFC 8446) drops session IDs entirely and uses **PSK tickets**. After
the handshake the server sends `NewSessionTicket` messages carrying an
encrypted pre-shared key; on reconnect the client puts that PSK in `ClientHello`'s
`pre_shared_key` extension — and crucially, TLS 1.3 still runs a **fresh
ECDHE** on top of the PSK. That is the security upgrade over TLS 1.2 resumption:
plain TLS 1.2 resumed sessions reuse the old master secret, while TLS 1.3
resumption keeps forward secrecy by always mixing traffic keys with a new
ephemeral exchange. My server sent two tickets per handshake, typical.

<figure>
<svg viewBox="0 0 780 372" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Message flow of a full TLS 1.3 handshake versus a resumed one, both one round trip">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <style>
    .lbl { font: 600 13px system-ui, sans-serif; fill: currentColor; }
    .sm { font: 12px system-ui, sans-serif; fill: currentColor; }
    .byte { font: 11px ui-monospace, SFMono-Regular, monospace; fill: #0f766e; }
    .acc { fill: #0f766e; }
  </style>

  <!-- Panel 1: full handshake -->
  <text class="lbl" x="20" y="26">Full handshake</text>
  <text class="sm" x="62" y="58">Client</text>
  <text class="sm" x="238" y="58">Server</text>
  <line x1="100" y1="70" x2="100" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="300" y1="70" x2="300" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="100" y1="118" x2="296" y2="118" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="110">ClientHello</text>
  <text class="byte" x="112" y="132">1 631 B written</text>
  <line x1="300" y1="182" x2="104" y2="182" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="174">ServerHello · Certificate · CertVerify · Finished</text>
  <text class="byte" x="112" y="196">1 369 B read</text>
  <path d="M 330 118 L 342 118 L 342 182 L 330 182" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text class="acc" x="350" y="153" style="font:600 12px system-ui,sans-serif">1 RTT</text>
  <line x1="100" y1="252" x2="296" y2="252" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="244">HTTP request (encrypted)</text>
  <line x1="300" y1="296" x2="104" y2="296" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="112" y="288">response</text>

  <!-- Panel 2: resumed handshake -->
  <text class="lbl" x="420" y="26">Resumed (session ticket)</text>
  <text class="sm" x="462" y="58">Client</text>
  <text class="sm" x="638" y="58">Server</text>
  <line x1="500" y1="70" x2="500" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="700" y1="70" x2="700" y2="330" stroke="currentColor" stroke-opacity=".35"/>
  <line x1="500" y1="118" x2="696" y2="118" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="110">ClientHello + PSK (ticket)</text>
  <text class="byte" x="512" y="132">1 934 B written</text>
  <line x1="700" y1="182" x2="504" y2="182" stroke="currentColor" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="174">ServerHello + Finished — no certificate</text>
  <text class="byte" x="512" y="196">245 B read</text>
  <path d="M 730 118 L 742 118 L 742 182 L 730 182" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text class="acc" x="748" y="153" style="font:600 12px system-ui,sans-serif">1 RTT</text>
  <line x1="500" y1="252" x2="696" y2="252" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="244">HTTP request (encrypted)</text>
  <line x1="700" y1="296" x2="504" y2="296" stroke="currentColor" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text class="sm" x="512" y="288">response</text>
  <text class="byte" x="420" y="352">≈27% fewer bytes, no certificate verify</text>
</svg>
<figcaption>A TLS 1.3 full handshake and a resumed one both cost 1 RTT — the win is bytes and server CPU, not round trips. Byte counts are from real <code>openssl s_client</code> output against nginx 1.27.5.</figcaption>
</figure>

## Seeing it yourself: `openssl s_client -sess_out` / `-sess_in`

`s_client` can save the session a server offers and feed it back next time.
Two commands:

Full handshake, saving the session to a file:

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -sess_out sess13.pem
...
SSL handshake has read 1369 bytes and written 1631 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 2048 bit
...
Early data was not sent
Verify return code: 18 (self-signed certificate)
```

`New` means a fresh session. Two lines matter for the 0-RTT discussion later:
`Early data was not sent` (this client did not attempt 0-RTT) and the
`NewSessionTicket` that arrives right after, visible with `-msg`:

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -msg
...
<<< TLS 1.3, Handshake [length 0109], NewSessionTicket
    04 00 01 05 00 01 51 80 83 e3 6c 85 08 00 00 00
...
<<< TLS 1.3, Handshake [length 0109], NewSessionTicket
```

Now reconnect **with** the saved session — same command, `-sess_in`:

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -sess_in sess13.pem
...
SSL handshake has read 245 bytes and written 1934 bytes
Verification error: self-signed certificate
---
Reused, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Early data was not sent
Verify return code: 18 (self-signed certificate)
```

That one word — **`Reused`** — is the whole story: the server accepted the PSK
from the ticket, skipped the certificate transfer, and read 245 bytes instead of
1369. The saved file shows what the client holds:

```
$ openssl sess_id -in sess13.pem -text
Protocol  : TLSv1.3
Cipher    : TLS_AES_256_GCM_SHA384
Session-ID: 73E27FCBAE2B6CBC52EC25696369A740607BF5CDEB21DB7FF8D6B9EAB40CD9BB
Resumption PSK: 2F516D2DD8B5235F991F6198648F426BF342C267093C96A86A29C4389626A298D31949367583537DFC859951352F0554
PSK identity: None
TLS session ticket lifetime hint: 86400 (seconds)
Max Early Data: 0
```

`Resumption PSK` is the derived pre-shared key; the `lifetime hint` of 86400
seconds is the server's `ssl_session_timeout` (24 h in my config) reported to
the client. `Max Early Data: 0` means this server is not offering 0-RTT — more
below.

For TLS 1.2 the same `-sess_out`/`-sess_in` flow resumes via the **session ID**
(or ticket, if the server offers one):

```
# TLS 1.2 vhost on 127.0.0.1:19444
$ openssl s_client -connect 127.0.0.1:19444 -sess_out sess12.pem
SSL handshake has read 1466 bytes and written 1626 bytes
New, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384

$ openssl s_client -connect 127.0.0.1:19444 -sess_in sess12.pem
SSL handshake has read 141 bytes and written 1776 bytes
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
```

The pattern: read collapses (1466 → 141) because the certificate chain stays
server-side; written grows slightly as the client echoes its session material.

## `-reconnect`: full vs resumed in one command

`s_client -reconnect` opens six connections back to back — a quick way to see
resumption behaviour. Against the TLS 1.2 vhost:

```
$ openssl s_client -connect 127.0.0.1:19444 -reconnect
New,    TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
Reused, TLSv1.2, Cipher is ECDHE-RSA-AES256-GCM-SHA384
```

The TLS 1.2 session ID travels *inside* `ServerHello`, so resumption kicks in
immediately. TLS 1.3 differs:

```
$ openssl s_client -connect 127.0.0.1:19443 -servername localhost -reconnect
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
```

All six are `New` — a real gotcha, not a lab artefact: TLS 1.3 tickets are
**post-handshake** messages, and `s_client -reconnect` drops each connection
before they land (I grepped the `-msg` trace: zero `pre_shared_key` extensions
in later `ClientHello`s). For TLS 1.3 use `-sess_out`/`-sess_in`; `-reconnect`
only demos resumption for TLS 1.2.

## Server-side: nginx `ssl_session_cache`, timeout, and tickets

My lab config, which produced all of the output above:

```nginx
# Shared in-memory session cache: 1 MiB ≈ 4000 sessions
ssl_session_cache shared:TLS:1m;
ssl_session_timeout 24h;
ssl_session_tickets on;
```

- **`ssl_session_cache shared:TLS:1m`** — one shared in-memory cache, 1 MiB,
  shared across workers. This is what makes TLS 1.2 session-ID resumption
  survive across workers. Without it (nginx default: `none`), TLS 1.2
  resumption falls back to whatever the client remembers — usually tickets,
  if on.
- **`ssl_session_timeout 24h`** — how long a session stays resumable (nginx
  default is 5 m). Clients see it as the ticket lifetime hint.
- **`ssl_session_tickets on`** — issue TLS 1.3 (and TLS 1.2) session tickets.
  On by default in modern nginx.

**The security note.** A session ticket is *encrypted state*, not plaintext:
the server seals the PSK into the blob with its ticket key, and the client
cannot read or tamper with it. But that key joins your trust boundary — anyone
who can read it can decrypt captured tickets; anyone who can write it can mint
resumable sessions. Share it only across fully trusted nodes, rotate it, protect
it like a private key. Disabling tickets (`ssl_session_tickets off`) is a
legitimate tradeoff if your threat model includes key compromise: clients fall
back to TLS 1.2 session-ID resumption against the shared cache, or full
handshakes. You lose stateless resumption and some resumption rate; you shrink
the key-management surface. And per the forward-secrecy point above: TLS 1.3
ticket resumption rides on fresh ECDHE, so enabling tickets does **not** weaken
per-connection forward secrecy the way old TLS 1.2 resumption could.

Verified so you don't have to: with `worker_processes 4`, resumption still
worked 12/12 — nginx shares the ticket key across workers, so
`ssl_session_ticket_key` is only for ancient versions or explicit key control.

## TLS 1.3 0-RTT: the free lunch with a replay bill

A TLS 1.3 ticket can authorise **early data**: the client puts application
data in the *same flight* as `ClientHello` + PSK, encrypted under keys derived
from the ticket. The server processes it immediately — **0 round trips**
instead of 1. On a 200 ms satellite link, the entire handshake is gone.

Two caveats — why 0-RTT is not on by default:

1. **Client support is limited over TCP.** Browsers do not send early data on
   TLS 1.3-over-TCP for ordinary browsing; where you see 0-RTT in the wild it
   is usually QUIC (see my [QUIC and HTTP/3](/posts/quic-and-http3/) post).
   nginx exposes it as `ssl_early_data on;`.
2. **Replay risk.** Early data is *not* replay-protected by the protocol. An
   attacker who captures a 0-RTT flight can replay it, and if the server
   accepts it twice, any side effect happens twice. Defences exist —
   single-use tickets, server-side replay caches (OpenSSL has one), nonces —
   but the robust operational rule is: only idempotent requests (safe `GET`s)
   belong in early data; anything with side effects waits for the full
   handshake. My lab capture said `Max Early Data: 0` — nginx was not offering
   early data at all, the safe posture.

So: 0-RTT is a genuine latency win for high-latency, request-response traffic
whose requests are replay-safe. Everything else stays on the 1-RTT resumed
handshake.

## When it matters vs when it doesn't

**Matters:** mobile and satellite clients (RTT dominates — resumption turns
TLS 1.2's 2-RTT handshake into 1, 0-RTT removes it entirely); TLS-terminating
proxies and load balancers at scale (fewer signature verifies, less CPU, and
with tickets no shared session cache to operate); constrained IoT devices
reconnecting.

**Doesn't matter:** LAN and datacenter traffic — my loopback numbers (~15 ms
for both) show nothing to win when RTT ≈ 0; long-lived keep-alive
connections — HTTP/2 and HTTP/3 multiplex over one session, so resumption
only pays at setup; clients that never reconnect (resumption is a *re*connection
optimization, after all).

## Summary

- A full handshake costs RTTs plus per-connection crypto; against my nginx 1.3
  vhost that was 3.0 KB on the wire and a certificate verify per connection.
- TLS 1.2 resumes via **session IDs** (server state) or **tickets** (encrypted,
  client-held state); TLS 1.3 resumes via **PSK tickets** from
  `NewSessionTicket`, always over fresh ECDHE.
- `openssl s_client -sess_out`/`-sess_in` makes resumption visible as
  `Reused`; `-reconnect` demos it for TLS 1.2 but races the TLS 1.3 ticket.
- nginx: `ssl_session_cache` for shared state, `ssl_session_timeout` for
  lifetime, `ssl_session_tickets on` for stateless PSK resumption — and treat
  the ticket key like the trust boundary it is.
- TLS 1.3 0-RTT eliminates the handshake RTT, but early data can be replayed:
  idempotent requests only.
