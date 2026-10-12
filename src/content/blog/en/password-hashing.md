---
title: "Password hashing in 2026: argon2 vs bcrypt vs scrypt (and why md5 is a crime)"
description: "Password storage in 2026: what hashing must resist, why md5 and SHA-256 are a category error, how salt and memory-hard functions change the economics, argon2 vs bcrypt vs scrypt vs pbkdf2, how to pick Argon2id parameters, peppering, and rehash on login without locking users out."
pubDate: 2026-11-16
lang: en
translationKey: password-hashing
tags: [security, devops]
featured: false
keywords:
  - password hashing
  - argon2 vs bcrypt
  - memory-hard
  - password storage
  - salt
---

I review a lot of **password hashing** code, and the failure always has the same
shape. Someone pragmatic and otherwise security-aware hands me a login
system that stores `sha256(password + salt)` — or, worse, a bare MD5 — and asks
whether the **argon2 vs bcrypt** debate really matters "for a small app". It does,
and not because of fashion. Fast hashes exist to be fast, and a login is the one
place where speed is the enemy: whoever steals your database gets to run the same
function billions of times, offline, with no rate limit. So: what password hashing
must resist, why salted **memory-hard** functions change the economics, and how to
do real **password storage** in 2026 without locking a single user out.

## What password hashing must resist

The threat model is not "someone guesses the password on the login page"; it is
"someone walks off with a copy of your `users` table" — a leaked backup, a SQL
injection, a stolen replica. Once the attacker holds the digests, they guess
against their own hardware, offline, for as long as they like.

- **Offline brute force.** No rate limit, no lockout, no CAPTCHA. A dictionary, then
  mangling rules, then mask patterns, each candidate checked against every account
  at once. Your only lever is how expensive one guess is.
- **GPU and ASIC attacks.** A modern GPU runs SHA-256 at tens of billions of hashes
  per second; a purpose-built ASIC far more. A scheme is safe only if its cost
  *per guess* survives that parallelism.
- **Rainbow tables.** Precomputed `hash → plaintext` tables let an attacker look a
  digest up instead of computing it — because the same password yields the same
  digest everywhere.

Speed makes all three cheap, so the entire job of a password hash is to be slow —
and *memory*-expensive, a different and stronger kind of slow.

## Why fast hashes are wrong (md5, sha-1, sha-256 is a crime)

MD5, SHA-1, and SHA-256 were designed for integrity, not secrecy, so they are
*deliberately* cheap: one pass, a few dozen ALU ops per block, tiny state. Perfect
for hashing a 4 GB file; fatal for a password. Rough rates on one high-end GPU:

- MD5: ~10<sup>11</sup> guesses/second.
- SHA-1 / SHA-256: ~10<sup>10</sup>/s, more with tuning.
- bcrypt (cost 12): ~10<sup>4</sup>–10<sup>5</sup>/s.
- Argon2id (64 MiB, t=3): ~10<sup>2</sup>–10<sup>3</sup>/s, and memory-bound.

Six to eight orders of magnitude — "cracked before lunch" versus "not in your
lifetime". An eight-character password spans roughly 10<sup>12</sup>–10<sup>15</sup>
candidates; a fast hash sweeps it in hours, a memory-hard function in centuries.

### "But I add a salt"

A salt is necessary and not sufficient, and the two get confused.
`sha256(salt + password)` is salted, unique per user, and still a crime: the GPU
still runs the function at 10<sup>10</sup>/s per candidate. The salt fixes rainbow
tables and identical digests; it does nothing about raw speed.

## Salt and memory-hard functions: the two ideas that work

<figure>
<svg viewBox="0 0 610 156" width="100%" role="img" aria-label="A password and a random salt are fed into a memory-hard function such as Argon2id; the resulting digest and its parameters are what the database stores.">
  <defs>
    <marker id="hf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="10"  y="18" width="152" height="42" rx="8"/>
    <rect x="10"  y="96" width="152" height="42" rx="8"/>
    <rect x="224" y="32" width="190" height="92" rx="10"/>
    <rect x="466" y="50" width="134" height="56" rx="8"/>
    <path d="M162 39 H224" marker-end="url(#hf-arrow)"/>
    <path d="M162 117 H224" marker-end="url(#hf-arrow)"/>
    <path d="M414 78 H466" marker-end="url(#hf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="86"  y="44"  text-anchor="middle">password</text>
    <text x="86"  y="122" text-anchor="middle">random salt (16 B)</text>
    <text x="319" y="66"  text-anchor="middle">Argon2id</text>
    <text x="319" y="86"  text-anchor="middle" font-size="12" opacity="0.8">memory-hard function</text>
    <text x="319" y="104" text-anchor="middle" font-size="12" opacity="0.8">m, t, p</text>
    <text x="533" y="74"  text-anchor="middle">digest</text>
    <text x="533" y="92"  text-anchor="middle" font-size="12" opacity="0.8">+ params in DB</text>
  </g>
</svg>
<figcaption>The salt and the parameters travel with the digest and are not secret. The only thing that must stay expensive to guess is the function itself.</figcaption>
</figure>

A **salt** is a random value (16 bytes is plenty) generated when the password is
set and stored *in cleartext* beside the digest. It is not a secret. It makes precomputation useless, makes identical passwords produce different
digests, and forces the attacker to attack one account at a time, forever. Use a
unique random salt per user from a CSPRNG — never global, never the username.

A **memory-hard** function forces every guess to allocate and touch a large working
set — tens of megabytes — so throughput is bounded by memory bandwidth, not by ALU
count. That is why Argon2id and scrypt stay slow on the hardware that made SHA-256
trivially parallel. Memory-hard,
salted, and with a tunable time cost is the baseline; anything missing one of the
three is a rounding error in 2026.

## argon2 vs bcrypt vs scrypt (and pbkdf2 for FIPS)

Four functions are worth knowing: the modern default, a fine legacy fallback, a
reasonable alternative, and the compliance one.

### Argon2id — the default I recommend

Argon2 won the Password Hashing Competition in 2015 and is standardized in RFC 9106.
Of its three variants — `argon2d` (data-dependent, leakier on shared hardware),
`argon2i` (data-independent, side-channel resistant), and **`argon2id`** — the
hybrid is the right default for passwords: it resists GPU attacks while staying
hardened against side channels. Its parameters are explicit: memory `m` in KiB,
time cost `t`, parallelism `p`. OWASP's floor is
`m=19 MiB, t=2, p=1`; RFC 9106 suggests `m=64 MiB, t=3, p=4` and a high-memory
`m=2 GiB, t=1, p=4`.

### bcrypt — still fine, and everywhere

bcrypt (from 1999) is not going anywhere: a real work factor, implemented in every
language and framework, and a cost of 12 is still a serious wall for a GPU. Two
caveats: it is **not memory-hard**, so FPGAs and ASICs get more of an edge than they
do against Argon2id, and it silently **truncates the password at 72 bytes**. Inherit
a bcrypt database? Keep it, raise the cost factor, migrate lazily. Choosing today?
Choose Argon2id.

### scrypt — memory-hard, and a fine older option

scrypt (2009) was memory-hard before the term was fashionable: parameters `N`
(cost), `r` (block size), and `p` (parallelism), with a footprint of roughly
`128 · N · r` bytes; `N=2^17, r=8, p=1` is about 128 MiB. Solid, but Argon2id offers
the same protection with simpler parameters and better side-channel behaviour.

### pbkdf2 — when FIPS matters

PBKDF2 is old, ubiquitous, FIPS-approved, and the weakest of the four: CPU-iterated
only, not memory-hard, so GPUs love it. OWASP currently suggests around 600,000
iterations of PBKDF2-HMAC-SHA256. Use it only when a FIPS 140-3 validation or a
regulated client *requires* it; otherwise reach for Argon2id first.

| Function | Memory-hard | Typical 2026 params | Use when |
| --- | --- | --- | --- |
| Argon2id | yes | m=64 MiB, t=3, p=4 | default for new code |
| bcrypt | no | cost 12 | you inherited it |
| scrypt | yes | N=2^17, r=8, p=1 | ecosystem already uses it |
| PBKDF2 | no | 600k iterations SHA-256 | FIPS / compliance |

## Picking parameters: memory, time, and how to choose them

The rule is the same for all of them: **benchmark on the machine that will do the
work**, raise the cost until one hash takes roughly 250–500 ms at your expected
login concurrency, and stop before logins become a denial-of-service vector. Don't
copy a blog's numbers onto a different-sized box.

Prefer **memory over iterations**. Memory shrinks how many guesses fit in the
attacker's fast cache and raises the ASIC bar; extra iterations mostly just burn
your own CPU. Reserve a budget per concurrent login — 64 MiB is a fine start — pick
`m` so `m × concurrent_logins` fits, then tune `t` to hit the latency target.

```bash
# Benchmark on the box that will run the login, not on your laptop.
# argon2 -m <log2 KiB> -t <passes> -p <lanes>; 2^16 KiB = 64 MiB
for m in 15 16 17; do
  for t in 2 3 4; do
    /usr/bin/time -f "m=2^${m} t=${t} p=4 -> %e s" \
      argon2 -m "$m" -t "$t" -p 4 -l 32 -e \
      -s "$(head -c 16 /dev/urandom | base64)" <<< "benchmark" >/dev/null
  done
done
```

Here is a concrete Argon2id hash in Python, with the parameters that benchmark
landed on for my login server:

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# 64 MiB, 3 passes, 4 lanes — tuned for ~250 ms per hash on the login host.
ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4,
                    hash_len=32, salt_len=16)

digest = ph.hash("correct horse battery staple")
print(digest)
# $argon2id$v=19$m=65536,t=3,p=4$<base64 salt>$<base64 digest>
#  ^scheme   ^ver  ^parameters
#  Everything a verifier needs lives inside the string — scheme and params included.
```

## Peppering: a secret your database never holds

A **pepper** is a secret key mixed into the password before hashing and stored
somewhere other than the password database — an application config value, a systemd
credential, a KMS. If the database leaks but the app server does not, the attacker
cannot verify guesses at all. Unlike a salt it is secret and shared per deployment,
so treat it as a key, not a field.

The simplest correct pattern is to HMAC first, then hash:

```python
import hmac, hashlib
from argon2 import PasswordHasher

ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)

def hash_with_pepper(password: str, pepper: bytes) -> str:
    # The pepper never reaches the database; argon2id still does the hard work.
    pre = hmac.new(pepper, password.encode(), hashlib.sha256).digest()
    return ph.hash(pre)
```

Two caveats: a pepper is only as good as its storage — keep it in a credential
store, not the same repo as the schema, which is the discipline in
[secrets management](/posts/secrets-management/) — and rotating it means re-hashing
every password, so version it and treat a rotation as a migration, not a config
change.

## Migrating to Argon2id: rehash on login without locking users out

You do not need a flag day. Argon2id digests are self-describing — scheme, version,
and parameters all live in the stored string — so you can upgrade users one
successful login at a time.

<figure>
<svg viewBox="0 0 648 150" width="100%" role="img" aria-label="On each successful login the stored digest is verified; if it uses a weak or legacy scheme it is re-hashed with Argon2id and the row is updated.">
  <defs>
    <marker id="hf-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8" y="52" width="112" height="44" rx="8"/>
    <rect x="156" y="42" width="176" height="64" rx="8"/>
    <polygon points="392,73 432,43 472,73 432,103"/>
    <rect x="500" y="48" width="140" height="52" rx="8"/>
    <path d="M120 74 H156" marker-end="url(#hf-arrow2)"/>
    <path d="M332 74 H392" marker-end="url(#hf-arrow2)"/>
    <path d="M472 73 H500" marker-end="url(#hf-arrow2)"/>
    <path d="M432 103 V126" marker-end="url(#hf-arrow2)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="64"  y="78" text-anchor="middle">login</text>
    <text x="244" y="68" text-anchor="middle">verify with stored</text>
    <text x="244" y="88" text-anchor="middle">digest + params</text>
    <text x="432" y="78" text-anchor="middle" font-size="12">weak?</text>
    <text x="486" y="66" text-anchor="middle" font-size="11" opacity="0.8">yes</text>
    <text x="570" y="70" text-anchor="middle" font-size="12">rehash with</text>
    <text x="570" y="88" text-anchor="middle" font-size="12">Argon2id, UPDATE</text>
    <text x="432" y="142" text-anchor="middle" font-size="11" opacity="0.8">no — user is already current</text>
  </g>
</svg>
<figcaption>Rehash on login: verify with whatever scheme the row still uses, and only rewrite it when it falls below the target. Users on the old scheme keep working until the next successful sign-in.</figcaption>
</figure>

The technique is **rehash on login**:

1. Read the scheme from the stored digest's prefix.
2. Verify the submitted password with **that** scheme.
3. On success, if the scheme or parameters are below target, compute a fresh
   Argon2id digest and overwrite the row.
4. Return success — the user notices nothing.

Accounts that never log in keep their old digest, which is fine: an unused
credential is not the one leaking. Just make sure account recovery that bypasses
verification writes an Argon2id digest too.

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

TARGET = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)

def check_and_upgrade(user, password, db):
    stored = user.password_hash

    if stored.startswith("$argon2"):
        try:
            TARGET.verify(stored, password)
        except VerifyMismatchError:
            return False
        # Weak Argon2 params (e.g. m=19456,t=2) are upgraded transparently.
        if TARGET.check_needs_rehash(stored):
            db.set_password_hash(user.id, TARGET.hash(password))
        return True

    # Legacy bcrypt / pbkdf2 / sha256: verify with the old code, then upgrade.
    if Legacy.verify(stored, password):
        db.set_password_hash(user.id, TARGET.hash(password))
        return True
    return False
```

If your old scheme is a *fast* hash with no salt, treat those accounts as
compromised rather than migrated — force a reset on next login instead of silently
re-hashing a credential the attacker likely already has.

## The operational side: rate limiting and breach checks

Hashing protects the snapshot; it does nothing about live guessing at your login
form. Those are separate controls, and you need both.

- **Rate limiting and lockout.** Per-account and per-IP limits, exponential backoff,
  a short lockout after repeated failures, and MFA on anything sensitive — the same
  defense-in-depth posture as
  [hardening a public server](/posts/hardening-a-public-server/).
- **Breach checks at signup and login.** Reject passwords already known breached.
  The Have I Been Pwned range API checks without sending the password, using
  k-anonymity: send the first five hex characters of the SHA-1 and match the rest
  locally.

```python
import hashlib, urllib.request

def breach_count(password: str) -> int:
    sha1 = hashlib.sha1(password.encode()).hexdigest().upper()
    prefix, suffix = sha1[:5], sha1[5:]
    # Only a 5-char prefix leaves this process; the password itself never does.
    body = urllib.request.urlopen(
        f"https://api.pwnedpasswords.com/range/{prefix}", timeout=3
    ).read().decode()
    for line in body.splitlines():
        digest, count = line.split(":")
        if digest == suffix:
            return int(count)
    return 0
```

## Password storage in 2026: what I actually do

- **Reach for Argon2id for anything new.** 64 MiB, t=3, p=4 as a starting point,
  tuned on your hardware to ~250–500 ms. Salt every password, always.
- **Never choose md5, sha-1, or bare sha-256 for password storage.** Fast hashes are
  a category error, and a salt does not rescue them.
- **Rehash on login.** Self-describing digests turn migration into a background
  process, not a maintenance window. Never lock users out to change algorithms.
- **Add a pepper if you can store it separately**, and never verify a password
  without rate limiting and a breach check behind it.
- **Re-check your parameters yearly.** A setting safe in 2023 is cheaper in 2026;
  re-run the benchmark, raise the cost, and let rehash on login carry it out.
