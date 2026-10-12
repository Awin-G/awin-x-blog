---
title: "How to reverse-engineer a private HTTP API: a method, not a trick"
description: "A repeatable methodology for HTTP API reverse engineering: observe before you act, map the auth flow, capture traffic with devtools and mitmproxy, replay with curl, detect request signing, and write it up as a state machine."
pubDate: 2026-10-19
lang: en
translationKey: reverse-engineering-a-private-api
tags: [reverse-engineering, networking, security]
featured: false
keywords:
  - reverse engineer API
  - HTTP API reverse engineering
  - mitmproxy
  - curl replay
  - request signing
---

Most "reverse engineer API" advice you find online is a bag of tricks: sniff a
token in devtools, copy it, paste it into a script, and hope it still works next
week. That is not a method, and it breaks the moment the token expires or the
server adds signing. What follows is the method I actually use for **HTTP API
reverse engineering** — a fixed sequence of observe, capture, replay, and only
then automate. It is boring on purpose. Boring is what survives a server update.

The goal is never to defeat anything. It is to understand a private interface
that you are authorised to call, so you can drive it from code instead of a
browser. That distinction matters, and I come back to it at the end.

## Observe before you act

Before you capture a single packet, answer three questions in plain language:

1. What am I trying to do, exactly — one action, not a category.
2. What is the smallest thing the browser does to achieve it.
3. What tells me the action succeeded.

The first rule of API reverse engineering is that you do the action by hand
first, in a real browser, and you watch. Do not guess endpoint names. Do not
invent fields. Let the application show you its own contract. If login is what
you need, log in manually once and watch the Network panel. If it is a search,
run a search and watch.

Concretely, the observation loop is: open devtools, Network tab, check **Preserve
log** so redirects are not lost, filter to **Fetch/XHR** for async calls or leave
it on All for server-rendered redirects, then note method, URL, `Content-Type`,
request body, status, and response body — in that order. Finally, reproduce the
action once more and diff the two requests. Fields that stay the same are
structure; fields that change are state.

That last step is the whole game. Anything that changes between two identical
actions — a session id, a timestamp, a nonce, a ticket — is part of the
lifecycle, and it is where naive scripts die.

## Map the auth flow

Authentication is the first thing to understand, because everything else hangs
off it. Private HTTP APIs almost always use one of a few shapes:

- **Cookie session.** The server sets a session cookie after login; every
  subsequent request carries it. Classic captive portals look like this, and I
  walked one in detail in
  [the Ruijie ePortal reverse-engineering writeup](/posts/ruijie-campus-portal-reverse-engineering/).
- **Bearer token.** A login call returns a token (JWT or opaque) that clients
  put in `Authorization: Bearer ...`.
- **Signed requests.** The token alone is not enough; each request carries a
  signature derived from the body plus a secret.

To map the flow, isolate the login exchange and treat it as its own state
machine. What request starts it? What does the response set? What gets sent on
the *next* request that could not have been sent before? That delta is the
credential.

Then find the **token or cookie lifecycle**:

- Where is it minted — which response sets it, in a header or a body?
- How long does it live? Watch the `Expires`/`Max-Age` on a cookie, or the `exp`
  claim in a JWT, and confirm by waiting for a 401.
- Does it rotate? Some APIs issue a short-lived access token plus a long-lived
  refresh token; the refresh call is part of the flow, not an edge case.
- What invalidates it — logout, a new login, an IP change, a server restart?

If a value cannot be reused across logins, do not hardcode it. Re-derive it
every run. This is the single most common mistake in first attempts.

## Capture with devtools and mitmproxy

Devtools is enough for browser-driven flows. For anything that is not in a
browser — a mobile app, an embedded device, a native client — you need a proxy
in the middle. **mitmproxy** is my default; Charles is a fine GUI alternative.

Set the client's HTTP and HTTPS proxy to the machine running mitmproxy, install
mitmproxy's CA certificate on the client, and stream requests live:

```bash
# interactive UI: inspect, filter, replay
mitmproxy

# or capture to disk in a machine-readable format
mitmproxy -w capture.flows
# and later, read it back and filter
mitmproxy --rfile capture.flows
```

What I look for in a capture is the same set as in devtools, but I write it down
as a table because a capture is data, not a feeling:

| Field | Why it matters |
| --- | --- |
| Method + path | The endpoint's identity |
| Headers | Auth, content type, custom signatures |
| Body shape | JSON keys and nesting |
| Status codes | Success, auth failure, validation failure |

Keep exactly one clean capture of a successful flow; it becomes your reference
when a replay breaks. And record certificates and redirects too: whether the
client validates the certificate (never disable that in production just to make
a capture work), and every 3xx hop verbatim — a redirect chain is a sequence of
state transitions your client will have to walk.

## Identify the JSON shape and semantics

Once you can see the traffic, treat the responses as a schema to be described:

- **Shape.** Which fields are always present, which are optional, which are
  null on success but populated on failure.
- **Identity.** Which field names the resource, and does it match the id in the
  URL or is it a different internal id?
- **Pagination.** Look for `page`/`offset`/`limit` or a `cursor`/`next` token.
  Cursor pagination cannot be guessed from a page number; you have to read the
  `next` value out of each response and feed it back.
- **Errors.** This is the part people skip. Send a deliberately bad request and
  read the error body. Does the API use HTTP status codes, an envelope with a
  numeric `code`, or both? Does a 200 with `{"error": ...}` mean failure? You
  cannot write a robust client until you can tell success from failure
  mechanically.

Write the schema down as a comment next to your client. It is the cheapest
documentation you will ever produce, and the API will change and prove you right
to have written it.

## Replay with curl

Before writing any code, prove you can reproduce one request with **curl
replay**. This is the reality check that separates understanding from
coincidence.

```bash
# Replay a captured GET, including auth headers, exactly as observed
curl -sS 'https://api.example.internal/v1/items?limit=20' \
  -H 'accept: application/json' \
  -H 'authorization: Bearer eyJhbGciOi...' \
  -H 'x-request-id: 3f2c1a' | jq .

# Replay a POST with a JSON body
curl -sS -X POST 'https://api.example.internal/v1/items' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer eyJhbGciOi...' \
  --data '{"name":"demo","tags":["a","b"]}'
```

If the curl succeeds, you have the contract. If it fails while the browser
succeeds, the difference is a header, a cookie, or a signature — diff the two
requests field by field until it reconciles. Then unwrap the pieces in order:
strip headers one at a time until something breaks, and note exactly what was
load-bearing.

For a longer flow, a shell script that logs in, extracts the token with `jq`,
and calls two endpoints is more valuable than a page of prose:

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1) log in and capture the token from the response body
TOKEN=$(curl -sS -X POST 'https://api.example.internal/v1/auth/login' \
  -H 'content-type: application/json' \
  --data '{"username":"'"$USER"'","password":"'"$PASS"'"}' \
  | jq -r '.access_token')

# 2) use it, and prove it works
curl -sS 'https://api.example.internal/v1/me' \
  -H "authorization: Bearer $TOKEN" | jq .
```

## Detect signing, timestamps, and nonces

If two identical replays fail but the browser keeps working, suspect **request
signing**. Signatures show up as a header whose value changes on every request
even when nothing else does. The common families are:

- **HMAC** over a canonical string (method, path, body hash, timestamp), keyed
  by a shared secret.
- **Timestamps** included in the signed string, often with a small validity
  window, which is why a captured request goes stale in seconds.
- **Nonces** — a one-time value the server remembers, so replaying the exact
  request twice fails even within the time window.

To reproduce signing you need two things: the algorithm, and the secret. The
algorithm is usually inferable from the client — a header name like
`x-signature`, a documented HMAC-SHA256 shape, a sorted parameter list. The
secret is the hard part, and it is exactly where the honest answer is often
"this is a client secret shipped in a binary." If the secret is not yours to
use, the methodology stops here. Do not go looking for ways to extract a
third party's key; that is not reverse engineering your own authorised access,
that is something else.

Where it is your interface, pushing the timestamp and nonce generation into your
client is trivial once you know the canonical string. Reproduce it, then verify
by sending one request the server accepts and one it rejects, so you know the
check is really happening.

## Handle rate limits and captchas honestly

The server will push back, and how you respond defines whether this is
engineering or abuse.

- **Rate limits.** Read the `429` and any `Retry-After` header. Back off
  exponentially and cap it. Never retry in a tight loop.
- **Captchas.** If a captcha appears, stop. A captcha is an explicit signal that
  automation is not wanted on that path. The correct behaviour is to fail loudly
  and let a human intervene, not to find a solver.
- **Account safety.** A wrong credential retried forever is how accounts get
  locked. Fail the attempt, back off, and surface the error.

I built this exact rule into the captive-portal client: it probes before acting,
refuses to loop when a captcha is demanded, and backs off exponentially on
failure. That conservatism is not politeness — it is what keeps a legitimate
automation from becoming a lockout.

## Write it up as a state machine, then a client

The deliverable is not a script that happens to work. It is a state machine you
can reason about, plus a small client that implements it.

Name the states: `probe`, `discover`, `authenticate`, `execute`, `verify`. Each
transition happens for a reason, and every state has a bounded number of tries.
Then write the client with three properties:

1. **Explicit failure.** Raise and stop rather than silently retry.
2. **Re-derivation.** Fetch tokens and challenges fresh on every run.
3. **Verification.** After acting, do the cheap check that proves the action
   landed.

For interfaces that redirect and negotiate, the broader picture of what a
captive portal actually is helps a lot; I covered that in
[what captive portals actually do](/posts/captive-portals-explained/), and it is
the same request-and-redirect reasoning applied to an HTTP API.

## Ethics and authorised use

State this plainly, because it is the part that matters:

- Reverse engineering an API you are authorised to call, to automate your own
  legitimate access, is normal engineering.
- Automating access you are not entitled to, bypassing payment, quotas, or
  access controls, or touching other people's accounts, is not.
- Do not point these tools at systems you do not own or have written permission
  to test.
- If the interface requires you to extract someone else's secret, or to defeat
  a captcha, stop — that is the boundary, not a puzzle to solve.
- Follow the terms of service and the law wherever you are.

The method above is deliberately indifferent to the target. It works on your own
gateway and on your own SaaS account. Keeping it aimed at things you are allowed
to touch is not a caveat bolted on the end; it is the premise the whole method
rests on.

## The short version

Observe before you act. Map the auth flow and the token lifecycle before you
write a line of code. Capture with devtools, reach for mitmproxy when the client
is not a browser. Describe the JSON shape, pagination, and error semantics.
Prove one request with curl replay, then strip headers until something breaks so
you know what was load-bearing. Detect signing by sending the same request
twice. Respect rate limits and stop at captchas. Then encode the whole thing as a
state machine and a small, boring client that re-derives its credentials and
verifies its own work. That is a method. It will outlive any token you could have
copy-pasted.
