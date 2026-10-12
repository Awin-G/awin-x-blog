---
title: "The TLS 1.3 handshake, step by step: one round trip, no RSA, and why that is safer"
description: "A message-by-message walk through the TLS 1.3 handshake: what it must achieve, the ClientHello key_share, CertificateVerify and Finished, how it differs from TLS 1.2, the 0-RTT replay tradeoff, and how to read it in openssl s_client and Wireshark."
pubDate: 2026-11-06
lang: en
translationKey: tls-1-3-handshake
tags: [networking, security]
featured: false
keywords:
  - TLS 1.3 handshake
  - TLS handshake
  - openssl s_client
  - forward secrecy
  - 0-RTT
---

Every padlock you have seen this week was paid for by a **TLS 1.3 handshake**
that ran in a handful of milliseconds before a single byte of your request moved.
I spend a lot of time staring at these handshakes — in `openssl`, in packet
captures, in logs — and the thing that keeps surprising people is how *little*
happens now compared to TLS 1.2. The messages got fewer, the round trips dropped
to one, and a whole class of historical footguns (static RSA, compression,
renegotiation) was deleted rather than patched. This post walks the **TLS
handshake** message by message, maps each step to what **`openssl s_client`**
prints, and explains why the protocol got both simpler and safer at the same
time. If a broken handshake is what brought you here, my [TLS certificate
errors](/posts/tls-errors-explained/) field guide is the companion piece; for
issuance across many names, see [automated TLS](/posts/automated-tls-at-scale/).

## What the TLS handshake must achieve

Before the messages, the goals. A handshake is not "encryption" — it is a
negotiation that has to deliver four separate things:

- **Authentication** — the client learns it is talking to the holder of the
  certificate's private key for the name it asked for, not an impostor.
- **Key agreement** — both sides compute the same symmetric secret over a channel
  an eavesdropper can read, without ever sending that secret.
- **Forward secrecy** — the session key is derived from an ephemeral secret that
  is discarded after the connection. An attacker who steals the server's
  long-term private key *tomorrow* still cannot decrypt traffic captured *today*.
- **Integrity** — every handshake message is folded into a transcript hash, so
  neither side can be fed a tampered or spliced sequence without the Finished
  check failing.

Keep those four in mind; every removal in TLS 1.3 is justified by one of them.

## The TLS 1.3 handshake, message by message

Here is the full 1-RTT flow. The braces mean "encrypted with the handshake key".

```
   Client (initiator)                        Server (responder)
   ─────────────────────────────────        ─────────────────────────────────
   ClientHello ──────────────────────►
     • random
     • key_share            (X25519 public key)
     • supported_versions   = TLS 1.3
     • cipher_suites, SNI, ALPN
                                            │ pick a group, derive the
                                            │ shared secret from key_share
   ◄────────────────────────────── ServerHello
                                            • key_share (server public key)
                                            • cipher_suite, supported_versions
   ══════════ everything below is encrypted ══════════
   ◄──────────────────── {EncryptedExtensions}   ALPN, server_name ack
   ◄──────────────────── {Certificate}            server's chain
   ◄──────────────────── {CertificateVerify}      signature over transcript
   ◄──────────────────── {Finished}               server MAC over transcript
   {Finished} ───────────────────────►            client MAC over transcript
   ══════════ application data flows both ways ══════════
```

Message by message:

- **ClientHello.** The client offers a random nonce, a list of cipher suites, the
  names it supports via SNI, and — the important one — a **`key_share`**
  extension carrying its ephemeral public key (X25519 by default, or a group like
  secp256r1). It also advertises `supported_versions = 0x0304` to say "I speak
  1.3".
- **ServerHello.** The server picks one cipher suite and one key-exchange group,
  and returns *its* `key_share`. Both sides can now compute the shared ECDHE
  secret. Everything after this message is encrypted.
- **EncryptedExtensions.** The extensions that do not affect key derivation —
  ALPN's chosen protocol, acknowledgement of the SNI name — move here so they are
  protected too.
- **Certificate.** The server's certificate chain, historically sent in the
  clear, now travels inside the encrypted stream.
- **CertificateVerify.** A signature, made with the certificate's private key,
  over the transcript hash. This is what binds the **certificate** to *this*
  handshake and proves possession of the key.
- **Finished.** An HMAC over the whole transcript. Both sides send one. If
  anything was reordered or altered, the transcript hash differs and the check
  fails.

Then application data starts. That is the entire protocol: one flight from the
client, one from the server, one round trip.

## The forward secrecy guarantee, and why static RSA had to go

In TLS 1.2 the common default was **static RSA key exchange**: the client
encrypted a random premaster secret with the server's RSA public key and sent it.
Everything the session key needed was derived from that one value, and that value
could be recovered with the server's private key. So anyone who recorded the
traffic and *later* obtained the private key — a subpoena, a backup leak, a
Heartbleed-style bug — could decrypt years of past sessions. No **forward
secrecy**.

TLS 1.3 removes static RSA entirely. The only key exchange left is ephemeral
Diffie-Hellman: the client's and server's `key_share` values are used once and
thrown away. Steal the certificate's private key and you can still impersonate
the server going forward, but past traffic stays opaque unless the ephemeral keys
leaked too. That single deletion is why **forward secrecy** stopped being an
option you configure and became a default you cannot turn off.

## 0-RTT: a round trip saved, a replay risk bought

A resumed session can do better than one round trip. Using a PSK from a previous
connection (the session ticket the server pushed at the end of the last
handshake), the client can send **early data** — a request — in its very first
flight. That is **0-RTT**: the server can respond before any round trip
completes.

The tradeoff is real, and worth stating plainly: **0-RTT data is replayable and
lacks forward secrecy.** An attacker who captures the early-data flight can send
it again. TLS 1.3 hands the server tools to fight this — single-use tickets, a
time window, replay caches — but they are imperfect, and a replay is only
actually safe if the request is idempotent. I never enable early data for
anything that mutates state: no `POST` that charges a card, no write endpoint.
Safe `GET`s and resumptions of read-only work, fine. Because it also gives up
forward secrecy, 0-RTT is the one part of the protocol that trades a security
property for latency — make 1-RTT your baseline and 0-RTT the deliberate
exception.

## Reading the handshake with openssl s_client

The fastest way to see all of this is the **`openssl s_client`** command. Two
flags turn it into a handshake tracer: `-msg` dumps every protocol message, and
`-state` prints each state transition as it happens.

```bash
# Trace a full TLS 1.3 handshake against a real host
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -state -msg </dev/null 2>&1 | head -80
```

Read the `-state` lines in order and you are reading the diagram above as a log:

```
SSL_connect:before SSL initialization
SSL_connect:SSLv3/TLS write client hello
SSL_connect:SSLv3/TLS read server hello
SSL_connect:TLSv1.3 read encrypted extensions
SSL_connect:TLSv1.3 read server certificate
SSL_connect:TLSv1.3 read server certificate verify
SSL_connect:TLSv1.3 read finished
SSL_connect:SSLv3/TLS write change cipher spec
SSL_connect:SSLv3/TLS write finished
SSL_connect:SSL negotiation finished successfully
SSL_connect:SSLv3/TLS read server session ticket
```

Two things to notice. First, after `read server hello` every line is tagged
`TLSv1.3` — that is the boundary where encryption begins, exactly where I drew it
in the diagram. Second, the handshake reaches `negotiation finished successfully`
*before* the client's `Finished` completes, because the server's flight already
arrived. One round trip.

To confirm the negotiated protocol and cipher, ask for the summary block:

```bash
# The negotiated protocol + cipher + chain verification, in one shot
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 </dev/null 2>/dev/null \
  | grep -E "Protocol|Cipher|Verify return code"
# Protocol : TLSv1.3
# Cipher   : TLS_AES_256_GCM_SHA384
# Verify return code: 0 (ok)
```

And to exercise 0-RTT specifically, save a ticket and resume with early data:

```bash
# 1) Save a session ticket, 2) resume and send early data in the first flight
openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -sess_out /tmp/tls13.pem </dev/null >/dev/null 2>&1

printf 'GET / HTTP/1.1\r\nHost: blog.awin-x.top\r\nConnection: close\r\n\r\n' \
  > /tmp/req

openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top \
  -tls1_3 -sess_in /tmp/tls13.pem -early_data /tmp/req -quiet
```

## The same handshake in Wireshark

In Wireshark you can watch the encryption boundary happen. The **ClientHello**
and **ServerHello** are readable — handshake types `1` and `2` — and under the
ServerHello extensions you can see `supported_versions: 0x0304`. Then the very
next frames stop being "Handshake Protocol" and become **Application Data**
records, even though they carry EncryptedExtensions, Certificate,
CertificateVerify, and Finished. That is the point: TLS 1.3 wraps post-hello
handshake records in the same record type as application data, so a passive
observer cannot even tell which handshake message is which.

```bash
# List the plaintext handshake messages in a capture
tshark -r handshake.pcapng -Y 'tls.handshake.type == 1 || tls.handshake.type == 2' \
  -T fields -e frame.number -e tls.handshake.type
```

To make the encrypted messages readable, point Wireshark at a key log file and
run the client so it writes one:

```bash
# Client side: emit the per-session secrets
SSLKEYLOGFILE=/tmp/keys.log openssl s_client -connect blog.awin-x.top:443 \
  -servername blog.awin-x.top -tls1_3 </dev/null >/dev/null 2>&1
# Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log filename
```

## Why TLS 1.3 is simpler and safer

The removals are the story:

- **No static RSA key exchange** → forward secrecy is mandatory, not optional.
- **No compression** → CRIME and its relatives lose their attack surface.
- **No renegotiation** → the class of bugs where mid-stream re-auth confused the
  transcript is gone.
- **One round trip** → lower latency and a much smaller state machine.
- **Post-hello handshake encrypted** → less metadata for a passive observer, less
  to fingerprint.
- **HKDF key schedule** → clearer, auditable derivation of handshake and
  application secrets.

Simpler and safer are usually in tension. Here they coincide because the
designers removed options instead of adding checks.

## What I actually check

When a handshake misbehaves, my loop is the same every time:

1. `openssl s_client -state -msg` and find where it stops.
2. Confirm the negotiated protocol is `TLSv1.3` and the `key_share` group is one
   you meant to offer.
3. If resumption looks wrong, isolate it with `-no_ticket` / `-sess_in` to
   separate 0-RTT from the full handshake.
4. Only then chase certificates — with the [certificate error
   guide](/posts/tls-errors-explained/) and, for renewal automation, [automated
   TLS](/posts/automated-tls-at-scale/).

TLS 1.3 is the rare protocol version where *deleting* features made it faster,
smaller, and harder to misconfigure. Learn the one-flight diagram, and every
`s_client` trace and Wireshark capture becomes readable.
