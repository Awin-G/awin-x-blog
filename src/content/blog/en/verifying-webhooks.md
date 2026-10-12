---
title: "Verifying webhooks: HMAC signatures, replay attacks, and the mistakes everyone makes"
description: "How to verify webhooks properly: HMAC-SHA256 over the raw body with a timestamp, a replay window, constant-time comparison, secret rotation, fast 2xx acks, and idempotent handlers — with real signatures, real rejections, and the timing leak that shows why == is not enough."
pubDate: 2026-12-23
lang: en
translationKey: verifying-webhooks
tags: [security, devops]
featured: false
keywords:
  - verify webhooks
  - HMAC signature
  - webhook security
  - replay attack
  - constant-time comparison
---

Webhooks are the one kind of request you must trust and cannot: they **arrive from the internet with no session**. No cookie, no bearer token, no logged-in user — just a POST to a URL that is, by definition, publicly reachable. The only thing separating your endpoint from anyone who learns that URL is an **HMAC signature** over the payload. If you do not **verify webhooks**, every forged `invoice.paid` is indistinguishable from the real one. That is not a hypothetical class of **webhook security** bug; it is the default state of an unsigned endpoint, and it is one line away from a **replay attack**. Here is the canonical scheme I use, the mistakes I keep finding in review, and working code that rejects tampered, forged, and replayed deliveries.

<figure>
<svg viewBox="0 0 780 300" width="100%" role="img" aria-label="A sender computes an HMAC-SHA256 signature over the timestamp and raw body and attaches it as a header. The payload crosses an untrusted network where an attacker may tamper with it. The receiver recomputes the HMAC and compares in constant time: a valid, fresh signature is accepted, a tampered one is rejected.">
  <defs>
    <marker id="wh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" opacity="0.5" stroke-width="1.5">
    <rect x="10" y="70" width="216" height="150" rx="10"/>
    <rect x="556" y="46" width="214" height="206" rx="10"/>
    <path d="M226 122 H300" marker-end="url(#wh-arrow)"/>
    <path d="M432 122 H556" marker-end="url(#wh-arrow)"/>
    <path d="M366 34 V96" marker-end="url(#wh-arrow)" stroke-dasharray="5 4"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="118" y="94"  text-anchor="middle" font-weight="600">Sender</text>
    <text x="118" y="118" text-anchor="middle" font-size="12">holds secret K</text>
    <text x="118" y="142" text-anchor="middle" font-size="11" opacity="0.8">HMAC-SHA256(K, ts + "." + body)</text>
    <text x="118" y="168" text-anchor="middle" font-size="11" opacity="0.8">X-Timestamp: 1791801138</text>
    <text x="118" y="188" text-anchor="middle" font-size="11" opacity="0.8">X-Signature-256: sha256=…</text>

    <text x="366" y="26" text-anchor="middle" font-size="11" opacity="0.85">attacker: 4200 → 420000</text>
    <text x="366" y="122" text-anchor="middle" font-size="12" opacity="0.85">network</text>
    <text x="366" y="140" text-anchor="middle" font-size="11" opacity="0.65">(untrusted)</text>

    <text x="663" y="70"  text-anchor="middle" font-weight="600">Receiver</text>
    <text x="663" y="94"  text-anchor="middle" font-size="11" opacity="0.8">recompute over ts + "." + RAW body</text>
    <text x="663" y="114" text-anchor="middle" font-size="11" opacity="0.8">hmac.compare_digest(…)</text>
    <text x="663" y="134" text-anchor="middle" font-size="11" opacity="0.8">abs(now - ts) ≤ 300s</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="12">
    <rect x="576" y="150" width="174" height="34" rx="6" stroke="#0f766e" fill="none"/>
    <text x="663" y="172" text-anchor="middle" fill="#0f766e" font-weight="600">202 accepted, queued</text>
    <rect x="576" y="196" width="174" height="34" rx="6" stroke="currentColor" fill="none" opacity="0.6"/>
    <text x="663" y="218" text-anchor="middle" fill="currentColor" opacity="0.8">401 tampered / stale</text>
  </g>
</svg>
<figcaption>The whole scheme in one picture: sign the timestamp and the raw body, ship the signature as a header, and on the other side recompute it in constant time and check the clock. An attacker without the secret cannot produce a signature that survives the recomputation.</figcaption>
</figure>

## Why webhooks need signing — there is no session to lean on

Every other authenticated request in your system has a context: a session cookie, an `Authorization` header, mTLS, an IP allow-list. A webhook has none of it. The provider is not your user; it cannot log in. The endpoint must be reachable from the public internet, so "who is calling" is unknown by construction.

If you skip verification, the attack is trivial and needs no skill: read the URL from a log or a misconfigured dashboard, then POST `{"event":"invoice.paid","amount":999999,"id":"evt_forged"}`. Your handler cannot tell it apart from the real thing. Signing replaces "trust the caller" with "trust a secret only the provider and I hold" — and that is the entire security model. When I was [reverse-engineering a private API](/posts/reverse-engineering-a-private-api/), the fast path to understanding any integration was watching what it trusted; an unsigned webhook endpoint is the loudest example there is.

## How to verify webhooks with an HMAC signature over the raw body

The scheme I use everywhere is a single line of HMAC-SHA256:

```
signed_payload = str(timestamp) + "." + raw_body
signature      = HMAC_SHA256(secret, signed_payload)      # 32 bytes, sent hex
X-Timestamp:    1791801138
X-Signature-256: sha256=4c52fba9b7349d46f88d63a27636f4b7ba3feb70e1effb9b8339dceea0a358d7
```

The receiver recomputes exactly that and compares. A receiver that does only this is already safe against forgery and tampering. Here is real output from a sender that signs and a verifier that checks:

```python
import hmac, hashlib, json, time

SECRET = b"whsec_local_demo_9f2c4a1e"

def sign(secret, timestamp, body):
    return hmac.new(secret, str(timestamp).encode() + b"." + body,
                    hashlib.sha256).hexdigest()

body = json.dumps({"event": "invoice.paid", "id": "evt_7Qa2",
                   "amount": 4200, "currency": "usd"},
                  separators=(",", ":")).encode()
ts = int(time.time())

print("body           :", body.decode())
print("X-Timestamp    :", ts)
print("X-Signature-256: sha256=" + sign(SECRET, ts, body))
```

```text
body           : {"event":"invoice.paid","id":"evt_7Qa2","amount":4200,"currency":"usd"}
X-Timestamp    : 1791801126
X-Signature-256: sha256=12a461c94d2e77437f16c90561d3e1ac3a757043b668069bb92b3687eed8c5c0
```

### Hash the raw bytes, not re-serialized JSON

This is the mistake everyone makes, and it is invisible until production. Your framework parses the JSON into a dict, and then your verifier does `json.dumps(parsed)` before hashing. But `json.dumps` is not the inverse of the sender's serializer: it reorders or drops whitespace, changes number formatting, escapes `/` differently. The same JSON *value* becomes different *bytes*, so the HMAC differs and you reject valid traffic — or worse, you "fix" it by disabling verification.

```python
raw = b'{"amount": 4200, "currency": "usd", "id": "evt_7Qa2"}'   # exactly what arrived
sent_sig = sign(SECRET, ts, raw)

reserialized = json.dumps(json.loads(raw), separators=(",", ":")).encode()
print("raw wire bytes   :", raw)
print("re-serialized    :", reserialized)
print("match re-serialized?", hmac.compare_digest(sent_sig, sign(SECRET, ts, reserialized)))
print("match raw?          ", hmac.compare_digest(sent_sig, sign(SECRET, ts, raw)))
```

```text
raw wire bytes   : b'{"amount": 4200, "currency": "usd", "id": "evt_7Qa2"}'
re-serialized    : b'{"amount":4200,"currency":"usd","id":"evt_7Qa2"}'
match re-serialized? False
match raw?           True
```

The rule is absolute: capture the **raw body** before any parser touches it. In Express, mount the raw-body middleware for the webhook route *before* `express.json()`. In FastAPI/Starlette, read `await request.body()`. In frameworks that only give you a parsed object, check that the raw bytes are still exposed — and if they are not, that is a reason to change frameworks, not to weaken the check.

## The replay attack that signing the body alone does not stop

Signing only the body is deterministic: the same body yields the same signature forever. That is fine for integrity, useless for freshness. An attacker who captures one valid request — from a shared log, a proxy, a buggy client — can resend those exact bytes a thousand times, and every one passes a body-only check. That is a **replay attack**, and the mitigation is to put a timestamp inside the signed payload and enforce a window:

```
if abs(now - timestamp) > 300: return 401      # 5-minute replay window
```

Because the timestamp is part of the signature, an attacker cannot edit it forward without invalidating the HMAC. Real rejections, including a perfectly-signed but ten-minute-old request:

```text
verify(secret, ts, body, sig)                 -> True   # accepted: signature valid, timestamp fresh
verify(secret, ts, tampered, sig)             -> False  # rejected: signature mismatch
verify(attacker_secret, ts, body, sig)        -> False  # rejected: signature mismatch
verify(secret, old_ts, body, old_sig)         -> False  # rejected: timestamp 1791800526 outside 300s window
```

Keep the window tight — 5 minutes is generous; Stripe's default is 5 minutes too. A window is a *limit*, not a guarantee: within it, a captured request can still be replayed, which is exactly why the handler must also be idempotent (below). If you want strict freshness, add a `nonce` to the signed payload and reject values you have seen, but a shared cache grows fast — the event id dedupe usually makes it unnecessary.

## Constant-time comparison, or your comparison leaks the secret

`expected_signature == received_signature` looks harmless and is a side channel. String equality short-circuits at the first differing byte, so a comparison that matches 60 of 64 hex characters takes measurably longer than one that diverges at the first. With enough samples an attacker can recover a valid signature byte by byte without ever holding the secret. I measured it on this machine with a naive byte loop versus `hmac.compare_digest`:

```text
naive  ==  differs at byte 0 :   496.9 ns/op
naive  ==  differs at byte 63:  4169.5 ns/op   (early-exit leaks the match length)
compare_digest byte 0       :   173.5 ns/op
compare_digest byte 63      :   174.4 ns/op   (flat: no timing signal)
```

An 8× difference is not a rounding error; it is a signal. `hmac.compare_digest` compares in time proportional only to length, so the same comparison always costs the same. Use it — or the equivalent `crypto.timingSafeEqual` in Node, `subtle.ConstantTimeCompare` in Go — everywhere you compare a MAC, a token, or a password hash. Never `==`, never `strcmp`, never `.equals()` on a secret.

## Secret management and rotation

The secret is the entire security model, so treat it like one:

- **One secret per endpoint (and per provider environment).** Sharing a secret across integrations means a leak in one grants forgery in all of them.
- **32 bytes from a CSPRNG**, hex or base64. Never a passphrase, never derived from the URL.
- **Never in code or git.** Load from the environment or a secret manager at boot. Logs are the usual leak: never log the `Authorization`, the `X-Signature-256` value, or the secret itself.
- **Rotation with overlap.** A rotation that swaps the key instantly drops in-flight deliveries. Support *two* active secrets: verify against both, sign outbound with the new one, and retire the old one after the provider's retry window closes (a day is safe). Stripe lets you see both the new and the old secret for exactly this reason.

## Respond fast: verify, enqueue, ack

Webhook senders have short timeouts and retry on anything that is slow or non-2xx. If your handler calls three APIs and writes to two databases before replying, a slow dependency turns one delivery into a retry storm — and retries are duplicates. Do the minimum on the request path:

1. **Verify** the signature and the timestamp.
2. **Dedupe** on the event id (idempotency).
3. **Enqueue** the payload to a queue or a jobs table.
4. **Ack** with `2xx` immediately; do the real work asynchronously.

If verification fails, return `401` and do *not* process — but be deliberate: a `4xx` tells the sender this delivery is doomed and stops retries, which is what you want for a forged or stale request. Here is a real round-trip against a local verifier:

```text
valid request                      -> 202 accepted evt_7Qa2, queued
tampered body                      -> 401 bad signature
replay (10 min old)                -> 401 stale timestamp
duplicate delivery (same id)       -> 200 duplicate evt_7Qa2 ignored

queue after all four: ['evt_7Qa2']
```

Notice the queue holds exactly one event after four deliveries: enforcement happened at the edge, and the expensive work ran once.

## Idempotency: webhooks are delivered more than once

Webhook delivery is **at-least-once**, by design. Providers retry on timeouts, on non-2xx, and sometimes on their own internal hiccups, so the same event will reach you twice. Your handler must make the second delivery a no-op. The simplest reliable key is the provider's event id: keep a table of processed ids and skip any you have seen. Scope it to the endpoint, give it a TTL longer than the retry window (24 hours is a fine default), and make the insert itself the lock so two simultaneous deliveries cannot both proceed. This is the same reasoning as [idempotency keys](/posts/idempotency-keys/), applied to an inbound stream you do not control.

## A checklist and a reference verify function

Before you ship a webhook endpoint:

- Sign `timestamp + "." + raw_body` with HMAC-SHA256; send it as `X-Signature-256: sha256=<hex>` plus `X-Timestamp`.
- Hash the **raw bytes**; never re-serialize the JSON before verifying.
- Enforce a **replay window** on the signed timestamp (≤ 300 s) and allow only seconds of clock skew.
- Compare with a **constant-time** function; never `==`.
- Keep the secret out of code and logs; support **two active secrets** for rotation.
- **Verify → dedupe → enqueue → ack 2xx** in that order; do real work off the request path.
- Make the handler **idempotent** on the event id; store it with a TTL.
- Reject bad signatures loudly (`401`) and count them — a spike is an attack, not noise.

The reference implementation I keep in my head, in Python:

```python
import hmac, hashlib, time

def verify_webhook(secret: bytes, raw_body: bytes, headers,
                   window: int = 300, now: int | None = None) -> bool:
    now = int(time.time()) if now is None else now
    ts_header = headers.get("X-Timestamp")
    sig_header = headers.get("X-Signature-256", "")
    if not ts_header or not sig_header:
        return False
    try:
        ts = int(ts_header)
    except ValueError:
        return False
    if abs(now - ts) > window:                       # replay window
        return False
    expected = hmac.new(secret, str(ts).encode() + b"." + raw_body,
                        hashlib.sha256).hexdigest()
    received = sig_header.removeprefix("sha256=")    # tolerate / require the prefix
    return hmac.compare_digest(expected, received)   # constant time
```

And the same thing in pseudo-code, framework-agnostic:

```
verify(secret, request):
    ts  = request.header["X-Timestamp"]
    sig = request.header["X-Signature-256"] strip "sha256="
    if ts is missing or sig is missing: return REJECT(400)
    if abs(now() - int(ts)) > 300:        return REJECT(401)   # replay
    body = request.raw_body                                    # NOT parsed
    expected = hex(HMAC_SHA256(secret, str(ts) + "." + body))
    if not constant_time_equal(expected, sig): return REJECT(401)
    if event_id_already_seen(body):  return ACK(200, "duplicate")
    remember(event_id_of(body), ttl=24h)
    enqueue(body)
    return ACK(202, "accepted")
```

## What I do now

- Every webhook endpoint verifies an HMAC signature over `timestamp + "." + raw_body`, with the raw bytes captured before any parser runs.
- A 5-minute replay window on the signed timestamp, and only seconds of clock skew.
- Constant-time comparison everywhere a MAC, token, or hash meets a value — no exceptions.
- One 32-byte secret per endpoint, loaded from a secret manager, rotatable with two active keys.
- Verify, dedupe on the event id, enqueue, and ack `2xx` in milliseconds; the heavy work runs elsewhere.
- Handlers written to be idempotent because delivery is at-least-once and always will be.

None of this is exotic. An unsigned webhook is an unauthenticated write to your system, and the fix is a few lines of code most teams skip because it "works" in the happy path. Sign the raw bytes, check the clock, compare in constant time, and ack fast — and the whole class of forged and replayed webhooks stops being possible.
