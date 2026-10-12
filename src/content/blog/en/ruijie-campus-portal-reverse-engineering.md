---
title: "Reverse-engineering a Ruijie ePortal captive portal: headless campus auto login with CAS SSO"
description: "How I reverse-engineered a Ruijie ePortal captive portal and its CAS single sign-on flow to build a headless Python auto-login daemon that reconnects a campus uplink in about 16 seconds."
pubDate: 2026-10-13
lang: en
translationKey: ruijie-campus-portal-reverse-engineering
tags: [networking, reverse-engineering, python, security]
featured: false
keywords:
  - Ruijie ePortal auto login
  - campus network captive portal
  - CAS SSO reverse engineering
  - headless network login
  - Python daemon
---

Every campus network eventually hands you a web page and calls it security. You
open a browser, get bounced to a captive portal, type a username and password,
and land on a page that says you are online. That is fine until the machine that
needs the network has no browser: a router, a headless box, a build runner behind
NAT. Then the login page stops being a formality and becomes an obstacle.

Our lab uplink is authenticated by a Ruijie ePortal captive portal fronted by a
CAS single sign-on flow. I wanted **campus network auto login** that needs no
person, no browser and no display — a headless Python program that walks the same
request sequence Chromium walks, plus a systemd unit that keeps it alive. This is
how reverse engineering by observation turned the portal into a state machine,
and how the daemon gets back online about **16 seconds** after a forced
disconnect.

## The old API everyone writes about — and why it 404s here

Most "campus network auto login" scripts you find target the classic Ruijie
endpoint: `/eportal/InterFace.do?method=login`. You POST a handful of form fields
and the gateway lets you through. There are mature projects built entirely around
that contract.

On our gateway, that endpoint returns **404**. This is the newer Ruijie ESS
portal, where the actual authentication is delegated to a central authentication
service and the browser is redirected through a CAS handshake. The portal pages
even carry the marker `__PLATFORM_SSO__='cas-sso'`. No amount of fiddling with
the old parameters helps, because the login surface is simply different.

I checked the existing landscape first. Tools like
[`lololowe/ruijie-auto-login`](https://github.com/lololowe/ruijie-auto-login)
implement the old three-state machine well but do not speak this dialect.
`Polnareff258/openwrt-campus-auth` targets the same new-style Portal + CAS shape
and was a genuinely useful reference for the SSO idea, but it is bound to one
university and written for OpenWrt/ash. Nothing dropped in, so I re-derived the
flow against our own gateway and reimplemented it with the Python standard
library (plus the `openssl` CLI for AES).

## Reverse engineering by observation

The method is deliberately boring: let the browser do the login once, capture
every hop, then replay it from a script and fix what breaks. Six hops matter.

1. **Probe an external URL.** While unauthenticated, the BRAS intercepts the
   HTTP request and returns a small script that redirects to the ePortal — an
   `index.jsp` URL carrying the client IP and the access-controller name.
2. **Follow the entry.** `GET /eportal/index.jsp?...` answers with a 302 to
   `/portal/portal-main?...`, and the query string carries a fresh `sessionId`,
   `userIp`, `nasIp`, `customPageId` and terminal info. That `sessionId` is
   minted by the BRAS per authentication and **cannot be reused**, so the program
   always probes first, then logs in.
3. **Fetch the CAS challenge.** `GET /cas-sso/login?flowSessionId=...` returns
   the login page. Two elements matter: the one with id `login-page-flowkey`
   (the CAS execution token) and the one with id `login-croypto` (a
   base64-encoded 16-byte AES key, generated per page load).
4. **Submit credentials.** The form POSTs to `/cas-sso/login` with
   `type=UsernamePassword`, `_eventId=submit`, the `execution`, the `croypto`,
   the username in the clear, and the password encrypted with **AES-128-ECB**
   under that key (PKCS7-padded, then base64). Success is a 302 toward an
   auth-success page; failure returns the page with an error code.
5. **Walk the workflow.** SSO success is not always the end. The portal then
   asks the client to finish a small workflow: `POST
   /eportal/workFlow/getCurrentNode` returns the current node path, and
   depending on it the client posts to `/eportal/network/deviceAuthentication`,
   polls `/eportal/network/deviceAuthResult`, and at a `serviceSelection` node
   picks a carrier service (`ctcc`, `cmcc` or `unicom`) before calling
   `/eportal/network/serviceLogin`.
6. **Verify.** Re-probe the external URL. If the interception page is gone, we
   are online.

This is classic black-box reverse engineering: no decompilation, no fuzzing the
gateway — just reading redirect chains and form bodies until the shape is
obvious, then encoding that shape as data.

## The CAS SSO details that actually matter

A few honest notes about the CAS leg, because it is where most ports go wrong:

- **The AES key is not a secret.** `login-croypto` is generated per page load
  and shipped to the client in the HTML. Encrypting the password stops a
  trivially replayable plaintext credential; it is not transport encryption. The
  username is still sent in clear, and the key itself is readable from the page.
  This is why the whole thing only makes sense over the portal's own channel.
- **The challenge is stateful.** `execution` and `croypto` belong to one page
  load. If you fetch the page once and retry the POST later, the execution is
  stale and CAS rejects it — so the client re-fetches the challenge for every
  attempt.
- **There is a captcha gate.** Before submitting, the client asks a
  `captchaCount/validate` endpoint whether a captcha is required. In our
  deployment normal password auth never triggers it, but the check exists so the
  daemon fails loudly instead of hammering the portal in a loop.
- **No browser is required.** `urllib` plus `http.cookiejar` is enough for
  cookies and redirects; AES comes from `openssl enc -aes-128-ecb`. That keeps
  the dependency list at zero third-party packages.

## The state machine

I did not want a linear script that assumes each step succeeds. The client is a
state machine with an explicit "am I online?" probe at the top of every loop:

- **probe** → online? sleep, heartbeat, repeat. offline → discovery.
- **discover** → capture `sessionId`, `userIp`, `nasIp`, `customPageId`.
- **cas** → fetch the challenge, encrypt, submit; a 3xx means accepted.
- **workflow** → loop `getCurrentNode` for a bounded number of hops,
  dispatching device and service nodes until the path reaches `finish`.
- **verify** → probe again; if still offline, treat the whole attempt as failed.

Bounded loops and explicit failure are not paranoia. An unbounded retry loop
against a portal that wants a captcha is exactly how an account gets locked.

```bash
# 1) discovery only — never sends credentials, safe to run any time
$ sudo python3 ruijie_login.py --capture
{
  "sessionId": "…",
  "userIp": "10.19.x.x",
  "nasIp": "10.254.x.x",
  "customPageId": "…"
}

CAS login page: http 200, 48xxx bytes
login-page-flowkey: <execution token> …
login-croypto     : <base64-encoded 16-byte AES key>

# 2) one real login attempt, then exit
$ sudo python3 ruijie_login.py --once
[…] captive sessionId=… userIp=… nasIp=…
[…] CAS accepted (302 -> /portal/assets/auth-success.html?ticket=ST-…)
[…] workflow node: serviceSelection
[…] serviceSelection candidates: ['ctcc', 'cmcc', 'unicom']
[…] workflow node: finish
[…] LOGIN OK - now online
```

Note the `--capture` verb. Having a mode that walks discovery and prints the
challenge without ever sending a credential is worth the ten lines it costs: it
is how you debug a changed portal safely, and how you confirm you are reading the
right page.

## Deploying it as a systemd service

The client is a single file with `--status`, `--capture`, `--dry-run`, `--once`,
`--logout` and a daemon mode. Deployment is a tiny unit:

```ini
[Unit]
Description=Ruijie ePortal auto-login (campus network keep-alive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/ruijie-login/ruijie_login.py \
          --config /etc/ruijie-login/config.json
Restart=always
RestartSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

The daemon behaviour is deliberately conservative. It heartbeats every 20
seconds and only ever attempts a real login when the probe says it is offline —
it will not tear down a working session. On failure it backs off exponentially
(30s → 60s → … capped at 30 minutes) so a wrong password does not lock the
account. The config lives at `0600` because it holds a plaintext campus password.
Logs go to the journal, and a mobile control script lets me stop or restart the
service from a phone over the overlay network when I want to use my own account
in the lab.

## The 16-second reconnect

A daemon that claims to reconnect has to be tested against a *real* disconnect.
I forced one the honest way: change the campus uplink interface's WAN MAC.

That invalidates the MAC binding on the BRAS, the router picks up a new campus
IP, and the gateway drops it to the captive state. The service then logs,
roughly:

```text
[0] status before: ONLINE
[1] new WAN MAC -> new campus IP, binding invalid -> offline
    captive sessionId=… userIp=10.19.x.x nasIp=10.254.x.x
    CAS accepted (302 -> /portal/assets/auth-success.html?ticket=ST-…)
    workflow node: serviceSelection
    serviceSelection candidates: ['ctcc', 'cmcc', 'unicom']
    workflow node: finish
    LOGIN OK - now online
```

End to end: about **16 seconds** from the forced disconnect to being back online.
That number is not a magic constant — it is the next 20-second check tick plus the
login round-trips, with the node service selection pinned to `ctcc` in config so
the workflow never stalls waiting for input. If you leave `service` empty, the
client simply takes the first candidate the portal offers.

## The ethics, stated plainly

This automates **my own authenticated access** to a network I am entitled to use,
with the same credentials I would type into the browser. It does not bypass
payment, quota or any access control, and it does not touch anyone else's account
or the gateway beyond the endpoints the browser itself calls. It refuses to run
without credentials, refuses to loop when a captcha is demanded, and probes
before it acts. If your campus policy forbids unattended clients or MAC changes,
follow the policy. Do not point tools like this at networks you do not own or are
not authorised to use.

## What I would tell the next person

If `/eportal/InterFace.do?method=login` returns 404, stop debugging your
parameters — you are on the SSO variant and the old contract does not exist.
Read the redirect chain instead. Treat the `sessionId` as ephemeral and re-derive
it every time. Build the "am I online?" probe first, because everything else
hangs off it. And write the discovery-only mode before the login mode; you will
use it more.

The infrastructure around this — the self-hosted Git forge, the overlay network,
the machine that builds and serves this site — is the subject of
[how this blog ships itself](/posts/how-this-blog-ships-itself/), which is the
right place to start if you want the wider picture. A headless login daemon is
just one more service in
[that same pipeline](/posts/how-this-blog-ships-itself/): read, run, verify,
repeat.
