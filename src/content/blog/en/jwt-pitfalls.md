---
title: "JWT pitfalls for backend developers: signing, algorithm confusion, and revocation"
description: "A practical tour of JWT pitfalls: signed is not encrypted, why a JWT is not a session store, algorithm confusion (RS256 to HS256), alg none, trusting exp/aud/iss, the missing revocation story, long expiry, localStorage vs httpOnly cookies, and a simple refresh-token design."
pubDate: 2026-11-18
lang: en
translationKey: jwt-pitfalls
tags: [security, devops]
featured: false
keywords:
  - JWT pitfalls
  - JWT vs session
  - algorithm confusion
  - JWT security
  - refresh token
---

I have debugged enough auth systems to say this plainly: the **JWT security** bugs that bite are rarely broken cryptography. They are places where someone trusted a token more than it deserved. A JWT looks authoritative — three tidy base64url segments and a signature — and that appearance is the trap. It is a set of signed claims, not a bag of verified facts, and definitely not a session. Most **JWT pitfalls** come down to confusing those three things, plus the **JWT vs session** decision nobody made before the first token was minted. Here is what a JWT really is, the mistakes I keep finding, a simple refresh-token design, and when the honest answer is to skip JWT entirely.

## What a JWT actually is — and what it is not

A JWT is three base64url strings joined by dots: `header.payload.signature`.

- **Header** — JSON, usually `{"alg":"RS256","typ":"JWT"}`. It *names* the algorithm; it does not prove it.
- **Payload** — the claims: `sub`, `exp`, `aud`, `iss`, and anything else you put there.
- **Signature** — computed over the first two segments with a key only the issuer has.

<figure>
<svg viewBox="0 0 660 200" width="100%" role="img" aria-label="A JWT is three base64url parts separated by dots: header, payload, and signature. The header and payload are readable by anyone; only the signature is checked against the issuer's public key.">
  <defs>
    <marker id="jwt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="24" width="148" height="96" rx="8"/>
    <rect x="170" y="24" width="160" height="96" rx="8"/>
    <rect x="344" y="24" width="150" height="96" rx="8"/>
    <rect x="420" y="150" width="220" height="42" rx="8"/>
    <path d="M419 120 V150" marker-end="url(#jwt-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="82"  y="48"  text-anchor="middle">header</text>
    <text x="82"  y="70"  text-anchor="middle" font-size="12" opacity="0.8">alg, typ</text>
    <text x="82"  y="98"  text-anchor="middle" font-size="11" opacity="0.7">readable by anyone</text>
    <text x="250" y="48"  text-anchor="middle">payload</text>
    <text x="250" y="70"  text-anchor="middle" font-size="12" opacity="0.8">sub, exp, aud, iss</text>
    <text x="250" y="98"  text-anchor="middle" font-size="11" opacity="0.7">readable by anyone</text>
    <text x="419" y="48"  text-anchor="middle">signature</text>
    <text x="419" y="70"  text-anchor="middle" font-size="12" opacity="0.8">HMAC or RSA</text>
    <text x="419" y="98"  text-anchor="middle" font-size="11" opacity="0.7">the only secret</text>
    <text x="160" y="80"  text-anchor="middle" font-size="22" opacity="0.6">.</text>
    <text x="334" y="80"  text-anchor="middle" font-size="22" opacity="0.6">.</text>
    <text x="530" y="176" text-anchor="middle">verify with issuer's public key</text>
  </g>
</svg>
<figcaption>Three base64url parts. The header and payload are readable by anyone who holds the token — only the signature protects them from being altered.</figcaption>
</figure>

Two properties decide almost everything downstream:

1. **Signed ≠ encrypted.** The signature proves *who wrote the claims and that they are unmodified*. It says nothing about secrecy. Anyone holding the token — a browser extension, a log line, a proxy — can read every claim. Base64 is not a lock.
2. **A JWT is not a session store.** A server-side session can be invalidated by deleting a row. A JWT cannot be un-issued: it is valid until it expires, wherever it is presented. That is the core of the **JWT vs session** trade-off — JWT buys stateless verification and pays for it with revocation.

Once you accept those, the classic mistakes stop looking like edge cases and start looking like their obvious consequence.

## Algorithm confusion and the other classic JWT pitfalls

### `alg: none`

Some libraries historically accepted a header of `{"alg":"none"}`, meaning "no signature — just trust the payload." Every version of this bug lets an attacker mint any identity by editing the payload and deleting the signature. This is why you never, ever let the *token* choose its own verification algorithm.

### Algorithm confusion: RS256 → HS256

This is the one that keeps landing in CVE lists. The server signs with **RS256** and publishes its RSA public key at `/.well-known/jwks.json`. The naive verifier reads `alg` from the token and passes that public key to the library — but the attacker has flipped the header to `{"alg":"HS256"}` (HMAC). HMAC treats the key as a shared secret, and the RSA *public* key is public, so the attacker can compute a valid HMAC signature. The verifier, following the token's own instruction, accepts a forged token.

The fix is one line, repeated in every language: **pin the algorithm on the verify call and never read it from the header.**

```python
# WRONG — the token picks the algorithm, so the attacker does too.
jwt.decode(token, PUBLIC_KEY, algorithms=["HS256", "RS256"])

# RIGHT — one algorithm, chosen by the server, checked against the header.
jwt.decode(token, PUBLIC_KEY, algorithms=["RS256"])
```

### Not verifying the signature at all

The subtler sibling of `alg: none`: decoding without verifying. `jwt.decode(token, options={"verify_signature": False})` is legitimate only inside a test or a pure-inspection tool. In a request path it means "trust whatever JSON arrives," which is the same as having no auth. Grep your codebase for that string; I have found it in production more than once.

### Trusting `exp`, `aud`, and `iss` blindly

Verifying the signature but ignoring the claims is *almost* safe and still wrong:

- **`exp`** must be required and checked. A library that verifies but does not require `exp` will happily accept a token that never expires.
- **`aud`** (audience) stops a token minted for your billing service from being replayed against your admin API. If you run more than one service, check it.
- **`iss`** (issuer) stops a token from *someone else's* identity provider being accepted because it happens to share a key.
- **`nbf`** (not before) and clock skew: allow a few seconds of leeway, not minutes.

```python
import jwt

PUBLIC_KEY = open("/etc/jwt/public.pem").read()

def verify(token: str) -> dict:
    return jwt.decode(
        token,
        PUBLIC_KEY,
        algorithms=["RS256"],              # pinned by the server
        audience="https://api.awin-x.top",  # required: reject other services
        issuer="https://auth.awin-x.top",   # required: reject other issuers
        options={"require": ["exp", "iat", "aud", "iss"]},
        leeway=30,                          # tolerate small clock skew only
    )
```

### Secrets and PII in the payload

Because the payload is readable, everything in it leaks the moment the token leaks — via a Referer header, a mislogged request, a shared screenshot. Do not put API keys, internal IDs you would not disclose, or personal data there. A secret you would be embarrassed to see in a log line will be in a log line.

### No revocation story

A signature-only JWT cannot be revoked. "Log out" that just deletes the token locally does nothing to a copy the attacker already captured. If you need revocation — and for anything with money, admin rights, or a real user expectation of "sign out everywhere" you do — you need server-side state. The cheap version is a denylist of `jti` values until their `exp`, which is exactly the session table you were trying to avoid, just worse.

### Expiry too long

A long `exp` is the most common way teams paper over revocation pain. A 30-day access token is a 30-day liability. Keep access tokens to five or fifteen minutes and solve re-login with refresh tokens, not a long-lived bearer credential.

### localStorage vs httpOnly cookie

Where the token lives decides what an XSS bug costs you.

- **`localStorage`** is readable by any JavaScript on the page. One injected script, one malicious dependency, one bad `npm` transitive — and the token walks out. Convenient for SPAs; a standing bet that you will never have XSS.
- **`httpOnly` + `Secure` + `SameSite` cookie** is invisible to JavaScript, so XSS cannot read it directly. The trade is CSRF: a cookie is sent automatically, so you add `SameSite=Lax/Strict` and, for state-changing routes, a CSRF token. That is a bounded, well-understood problem; "never have XSS" is not.

If you store an access token in memory and put the refresh token in an `httpOnly` cookie, you get most of both worlds — which is where the next section lands.

## Decode and inspect before you trust

Inspection and verification are different operations, and conflating them is how bad tokens get through. Decoding is free and safe; anyone can do it.

```bash
# Inspection only. Anyone can run this; it proves nothing about authenticity.
TOKEN="$1"
hdr=$(echo "$TOKEN" | cut -d. -f1 | tr '_-' '/+' )
pay=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' )
printf '%s' "$hdr" | base64 -d 2>/dev/null | jq .
printf '%s' "$pay" | base64 -d 2>/dev/null | jq '{sub, exp, aud, iss, scope}'
```

```python
import base64, json

def decode_part(part: str) -> dict:
    # base64url has no padding; add it back before decoding.
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))

header, payload, _sig = token.split(".")
print(decode_part(header))   # -> {"alg": "RS256", "typ": "JWT"}
print(decode_part(payload))  # readable by anyone — so put nothing secret here
```

Use this to debug and to check `exp`, `aud`, and `iss` by eye. Do not use it to authorize anything. Only the signed verify path authorizes a request.

## Refresh tokens, done simply

The point of a refresh token is to keep access tokens short without making users log in every ten minutes. A refresh token is **not** a JWT you stuff in the same place — it is an opaque, random, single-use credential the server looks up, which is what gives you revocation for free.

- **Opaque and random** — 32 bytes from a CSPRNG, not a self-contained token.
- **Hashed at rest** — store a hash, exactly as you would a password (see [password hashing](/posts/password-hashing/)); a leaked DB should not hand over live sessions.
- **Rotated on every use** — the client gets a new refresh token each time and the old one is burned.
- **Reuse detection** — if a *used* token is presented again, that means it was stolen; kill the entire rotation family.

```sql
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  token_hash bytea NOT NULL,          -- sha256 of the opaque token, never the token
  family_id  uuid NOT NULL,           -- one family per login, for reuse detection
  expires_at timestamptz NOT NULL,
  used_at    timestamptz              -- a second use of a used row = theft
);
```

The flow: log in, return a short access token plus a refresh token in an `httpOnly` cookie. On expiry, the client calls `POST /auth/refresh`; the server hashes the presented token, finds a live unused row, marks it used, issues a new pair in the same family. Access tokens stay stateless; only the refresh path touches the database, once every fifteen minutes per user — cheap. And because it is state-changing, the refresh endpoint is a good place for [idempotency keys](/posts/idempotency-keys/) when a flaky client retries.

## When to skip JWT and use opaque sessions

**JWT vs session** is not a religion; it is a trade of statelessness against revocability, and if you do not need the statelessness, a session wins outright.

Choose **opaque server-side sessions** when:

- You have one backend and a database on every request anyway. A random cookie plus a `sessions` table is simpler than a JWT and revokes instantly.
- "Sign out all devices," admin bans, or password-change invalidation are requirements. Sessions do this with a `DELETE`; JWTs need a denylist that reintroduces the state you avoided.
- You want the simplest thing that is secure. Opaque sessions have fewer sharp edges and fewer footguns.

Choose **JWT** when its specific strength is real: many independent services verifying tokens without a shared session lookup, short-lived credentials handed to third parties, or a stateless edge that cannot reach your database. Even then, keep them short-lived and pair them with opaque, revocable refresh tokens.

## If you must use JWT: a checklist

- Pin the algorithm **on the server**, one value, and never read `alg` from the header.
- Reject `alg: none` and reject any token whose header algorithm does not match what you expect.
- Require `exp`, `aud`, and `iss`, and verify all three. Allow seconds of clock skew, not minutes.
- Never put secrets or PII in the payload. It is readable; say it out loud during review.
- Keep access tokens to minutes. Put the refresh token in an `httpOnly`, `Secure`, `SameSite` cookie, rotate it, and detect reuse.
- Have a revocation path — a `jti` denylist at minimum, opaque refresh rows in practice.
- If your "log out" only deletes client-side state, you do not have revocation.
- If you have one service and a database, seriously ask whether an opaque session would just be better.

None of this is exotic — the same handful of decisions, made once, deliberately. The teams that get JWT right are not the ones with clever crypto; they are the ones that never let the token decide what to trust.
