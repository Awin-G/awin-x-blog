---
title: "How WireGuard works under the hood: the crypto, briefly"
description: "A concise tour of how WireGuard works under the hood: the design philosophy of no negotiation, the primitives Curve25519, ChaCha20-Poly1305, BLAKE2s and HKDF, the Noise_IK handshake, forward secrecy, the time-based rekey, roaming, and why AllowedIPs is cryptographic routing."
pubDate: 2026-11-19
lang: en
translationKey: wireguard-internals
tags: [networking, security]
featured: false
keywords:
  - how WireGuard works
  - WireGuard handshake
  - ChaCha20-Poly1305
  - Curve25519
  - Noise protocol
---

**WireGuard** is the rare protocol you can understand completely in an afternoon — not because it is shallow, but because it is small on purpose. To answer **how WireGuard works**, you do not need a spec full of options; you need four cryptographic primitives and one handshake pattern. The whole thing is **Curve25519** for agreeing on secrets, **ChaCha20-Poly1305** for encrypting packets, **BLAKE2s** for hashing, and **HKDF** for turning a shared secret into the several independent keys the protocol actually needs. Every decision below — nothing to negotiate, no certificate authority, no session state you tune — follows from refusing to add a fifth primitive to those four.

## The design philosophy: small, opinionated, no negotiation

WireGuard is a few thousand lines of C in the Linux kernel, against hundreds of thousands for OpenVPN or a full TLS stack. That smallness is not an accident of scope; it *is* the design. The protocol fixes one cryptographic suite and offers no way to change it. There is no `--cipher` flag, no cipher-suite list, no version negotiation, no downgrade path. When there is exactly one acceptable answer, an attacker cannot talk you into a weaker one, and nobody can paste a config from 2014 into production.

The other opinion is that **a peer is a public key** — not an IP address, not a certificate, not a username. That collapses identity, routing, and access control into the same 32 bytes, and it is what makes roaming and `AllowedIPs` work the way they do. WireGuard is a data plane: it moves packets between keys, and leaves membership, discovery, and policy to somebody else.

## The primitives: Curve25519, ChaCha20-Poly1305, BLAKE2s, HKDF

Four primitives do all the work.

### Curve25519 for the key exchange

**Curve25519** (specifically X25519) is an elliptic-curve Diffie–Hellman function. Each side has a private scalar and a public point; you combine your private value with the other side's public value and get the same shared secret they get, while an eavesdropper who sees only the two public values learns nothing. It is why a 32-byte key can stand in for a certificate.

Two details matter. The *static* keypair is your long-term identity; the *ephemeral* keypair is generated fresh for each handshake, using the same math. And X25519 is key agreement, not signing: WireGuard authenticates by proving you can compute a shared secret, not by checking a signature. There is no signature algorithm anywhere in the protocol.

### ChaCha20-Poly1305 for the data

**ChaCha20-Poly1305** is an AEAD — authenticated encryption with associated data — and it protects every transport packet. ChaCha20 is the stream cipher that encrypts; Poly1305 is the authenticator that proves the ciphertext was not altered. Because they are one combined operation, the receiver either decrypts a packet that is genuine or drops it. There is no state in which you read tampered plaintext.

It is also fast in pure software and constant-time by construction, which matters on devices that lack AES hardware acceleration. But the stronger reason WireGuard chose it over AES-GCM is that ChaCha20-Poly1305 has no weak variants to accidentally select.

### BLAKE2s and HKDF: hashing and key derivation

**BLAKE2s** is the hash. It underwrites the handshake's keyed hashes and MACs and is fast on both 32-bit and 64-bit CPUs.

**HKDF** is the quieter primitive. A Diffie–Hellman exchange gives you *one* shared secret; a working tunnel needs *several* independent keys — one per direction, separate keys per session. HKDF (RFC 5869) expands a secret into as many independent keys as you name, each separated by a text label so a key derived for one purpose can never be confused with another. WireGuard never uses a raw DH output as a key; it always runs it through HKDF first.

<figure>
  <svg viewBox="0 0 760 420" width="100%" role="img" aria-labelledby="wg-kd-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="wg-kd-title">WireGuard key derivation</title>
    <g fill="none" stroke="#0f766e" stroke-width="1.5">
      <rect x="60" y="40" width="280" height="42" rx="8"/>
      <rect x="420" y="40" width="280" height="42" rx="8"/>
      <rect x="60" y="94" width="280" height="42" rx="8"/>
      <rect x="420" y="94" width="280" height="42" rx="8"/>
    </g>
    <g fill="currentColor" text-anchor="middle">
      <text x="200" y="66">Curve25519 DH: s_i × s_r</text>
      <text x="560" y="66">Curve25519 DH: s_i × e_r</text>
      <text x="200" y="120">Curve25519 DH: e_i × s_r</text>
      <text x="560" y="120">Curve25519 DH: e_i × e_r</text>
    </g>
    <line x1="200" y1="136" x2="200" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="560" y1="136" x2="560" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="160" x2="560" y2="160" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="380" y1="160" x2="380" y2="180" stroke="#0f766e" stroke-width="2"/>
    <polygon points="380,190 373,176 387,176" fill="#0f766e"/>
    <rect x="230" y="192" width="300" height="46" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="220" text-anchor="middle" fill="currentColor">chaining key ck (mixed with BLAKE2s)</text>
    <line x1="380" y1="238" x2="380" y2="256" stroke="#0f766e" stroke-width="2"/>
    <polygon points="380,266 373,252 387,252" fill="#0f766e"/>
    <rect x="270" y="268" width="220" height="42" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="294" text-anchor="middle" fill="currentColor">HKDF(ck, label)</text>
    <line x1="380" y1="310" x2="380" y2="330" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="330" x2="560" y2="330" stroke="currentColor" stroke-opacity="0.5"/>
    <line x1="200" y1="330" x2="200" y2="346" stroke="#0f766e" stroke-width="2"/>
    <polygon points="200,356 193,342 207,342" fill="#0f766e"/>
    <line x1="560" y1="330" x2="560" y2="346" stroke="#0f766e" stroke-width="2"/>
    <polygon points="560,356 553,342 567,342" fill="#0f766e"/>
    <rect x="60" y="358" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <rect x="420" y="358" width="280" height="44" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="200" y="385" text-anchor="middle" fill="currentColor">K1: initiator → responder</text>
    <text x="560" y="385" text-anchor="middle" fill="currentColor">K2: responder → initiator</text>
  </svg>
  <figcaption>From shared secrets to transport keys: four Curve25519 exchanges feed a BLAKE2s chaining key, and HKDF expands it into one independent ChaCha20-Poly1305 key per direction.</figcaption>
</figure>

## The WireGuard handshake: Noise_IK in one round trip

WireGuard's handshake is an instance of the **Noise protocol** framework, pattern `Noise_IKpsk2`. Read the name as a sentence about who knows what. `K` means the initiator already knows the responder's static public key before the first byte is sent. `I` means the initiator sends its own static public key in the first message. `p` and `s2` are WireGuard's additions: an optional pre-shared key and BLAKE2s as the hash. In practice, `IK` is why both ends list each other's public key in their config — each side knows who it is talking to before it starts.

The entire **WireGuard handshake** is one round trip, two messages.

<figure>
  <svg viewBox="0 0 760 400" width="100%" role="img" aria-labelledby="wg-hs-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="wg-hs-title">The WireGuard handshake</title>
    <desc id="wg-hs-desc">Initiator and responder exchange ephemeral and static keys in one round trip, then derive transport keys.</desc>
    <text x="140" y="26" text-anchor="middle" fill="currentColor" font-weight="600">Initiator</text>
    <text x="620" y="26" text-anchor="middle" fill="currentColor" font-weight="600">Responder</text>
    <line x1="140" y1="42" x2="140" y2="252" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="620" y1="42" x2="620" y2="252" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <line x1="148" y1="124" x2="610" y2="124" stroke="#0f766e" stroke-width="2"/>
    <polygon points="618,124 604,117 604,131" fill="#0f766e"/>
    <text x="384" y="90" text-anchor="middle" fill="currentColor">1) ephemeral public key, static public key (encrypted),</text>
    <text x="384" y="106" text-anchor="middle" fill="currentColor">timestamp, MACs</text>
    <line x1="612" y1="200" x2="150" y2="200" stroke="#0f766e" stroke-width="2"/>
    <polygon points="142,200 156,193 156,207" fill="#0f766e"/>
    <text x="384" y="176" text-anchor="middle" fill="currentColor">2) ephemeral public key, MACs</text>
    <rect x="60" y="272" width="640" height="48" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="292" text-anchor="middle" fill="currentColor">both sides run HKDF over the Curve25519 Diffie-Hellman chain</text>
    <text x="380" y="310" text-anchor="middle" fill="#0f766e" font-weight="600">→ two transport keys, one per direction</text>
    <rect x="60" y="336" width="640" height="48" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="380" y="356" text-anchor="middle" fill="currentColor">data: ChaCha20-Poly1305 with a 64-bit counter nonce</text>
    <text x="380" y="376" text-anchor="middle" fill="currentColor" font-size="12">rekeyed on a timer; old keys destroyed</text>
  </svg>
  <figcaption>Noise_IK in one round trip: message 1 carries the initiator's ephemeral and static keys, message 2 the responder's ephemeral, and both sides derive independent transport keys with HKDF.</figcaption>
</figure>

On the wire:

```text
Initiator                                   Responder
  e_i = fresh ephemeral keypair
  m1: e_i, encrypted(s_i), timestamp, MACs  ─────────────►
                                              e_r = fresh ephemeral keypair
  ◄───────────── m2: e_r, encrypted(empty), MACs
  both sides: HKDF over the DH chain → two transport keys
  data: ChaCha20-Poly1305, 64-bit counter nonce
```

### Static keys authenticate, ephemeral keys give forward secrecy

Two kinds of keys, two jobs. The **static** keys are long-term and prove *who* you are: only the holder of the private half can compute the shared secret that decrypts the first message, so identity is not claimed, it is demonstrated. The **ephemeral** keys are generated per handshake, used, and wiped. They are what buys **forward secrecy**: the session's transport keys come from Diffie–Hellman involving ephemeral secrets, so even if an attacker records all your traffic *and* later steals your static private key, they still cannot decrypt yesterday's session — the ephemeral private keys no longer exist in memory.

Keep the intuition clean: your long-term key signs off on the session, but it does not encrypt your data. The data is protected by a secret that nobody kept.

The optional pre-shared key adds a second layer: mixed into the handshake, it means an attacker must break both an ephemeral secret and the PSK to decrypt a captured session — the usual hedge against a future quantum computer.

### The timer that replaces renegotiation

Because there is nothing to negotiate, rekeying is not a conversation — it is a clock. WireGuard redoes the handshake on a timer or after enough data, always started by whichever side began the session. The constants are short and public:

```c
#define REKEY_AFTER_TIME     120            /* rekey after this many seconds   */
#define REKEY_AFTER_MESSAGES (1ULL << 60)   /* ...or this many messages        */
#define REJECT_AFTER_TIME    180            /* hard key expiry                 */
#define REKEY_TIMEOUT        5              /* retry a lost handshake          */
```

Old keys are kept briefly so packets already in flight are not lost, then destroyed. The hard expiry means a peer that goes silent cannot hold a session open forever. There is no hello and no capability exchange — just a timer both sides already agree on.

## Roaming and keepalive: the endpoint is not an identity

When a peer moves — a laptop from Wi-Fi to cellular, a phone from tower to tower — its source address changes. WireGuard does not drop the session, because it never keyed the session to an address. It keyed it to a static public key. The moment a valid, authenticated packet arrives from a new `IP:port`, WireGuard updates the endpoint it will reply to, because only the real peer holds the key that authenticates the packet. Roaming is a consequence of identity being cryptographic, not a feature bolted on.

This is also why a server has no `Endpoint` for a client that dials in — it learns it from the first authenticated packet. The client has one because it initiates.

Keepalive is the small companion to this. A NAT device forgets a UDP mapping after a while; when it does, the server can no longer reach the client. `PersistentKeepalive = 25` sends an authenticated empty packet every 25 seconds to keep that mapping warm. It is not NAT traversal and it does not create a path — it only stops an existing one from expiring. Set it on the side behind NAT; leave it off elsewhere, since it is periodic traffic that keeps radios awake.

## AllowedIPs is cryptographic routing

`AllowedIPs` is a routing decision and an authentication decision fused together. Outbound, it is a routing table: a packet destined for an address inside a peer's `AllowedIPs` is handed to that peer. Inbound, it is a source filter evaluated *after* the packet is authenticated by the peer's key — a packet from that peer is accepted only if its source address is also inside `AllowedIPs`.

Because the check runs on an authenticated packet, address spoofing is not a misconfiguration you can make; it is structurally impossible. The corollary — the part that trips people up — is that the two sides must agree: widen a peer's `AllowedIPs` to exactly what that peer is allowed to originate, and no more. The failure modes are in [WireGuard from scratch](/posts/wireguard-from-scratch/).

## The honest limits

Everything above is the protocol being small and doing its one job well. The same minimalism produces four real boundaries, and knowing them saves weeks:

- **No dynamic key distribution.** No directory, no control plane, no "join the network" step: a new peer is a config stanza by hand, and rotating a key means touching every peer that references it.
- **No NAT traversal.** It will not discover peers, punch holes, or relay, and has no STUN client or rendezvous. Two peers behind symmetric NAT simply never meet — see [NAT traversal, explained](/posts/nat-traversal-explained/).
- **UDP only.** No TCP mode, no port 443 fallback. On networks that block UDP — some hotels, some corporate networks — plain WireGuard is unusable.
- **No users, only keys.** No SSO, per-user ACL, revocation list, or audit log. `wg` reports handshake age and byte counts, and that is the whole observability story.

None of these are bugs to patch; they are the boundary of a data plane. Everything above the wire — discovery, membership, policy, revocation — is a second product layered on top.

## A minimal config

The smallest honest example: a public server and one client. Note what the crypto decides for you — no endpoint for the client on the server side, and identity is just public keys.

```ini
# server: /etc/wireguard/wg0.conf
[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <server.key>

[Peer]                        # the laptop
PublicKey = <client.pub>      # identity, not an address
AllowedIPs = 10.9.0.2/32      # routing + source filter, together

# client: /etc/wireguard/wg0.conf
[Interface]
Address = 10.9.0.2/24
PrivateKey = <client.key>

[Peer]
PublicKey = <server.pub>
Endpoint = 203.0.113.10:51820
AllowedIPs = 10.9.0.0/24
PersistentKeepalive = 25
```

## The short version

WireGuard is four primitives and one idea. Curve25519 agrees on a secret; HKDF splits it into independent keys; ChaCha20-Poly1305 turns those into authenticated packets; BLAKE2s ties the handshake together. The handshake is Noise_IK in one round trip — static keys prove identity, ephemeral keys give forward secrecy, and a timer replaces renegotiation. Roaming and `AllowedIPs` fall out of the same choice: a peer *is* a public key, so the address it happens to be using is just where to send the reply.

What you get is a very small, fast, hard-to-misconfigure tunnel. What you do not get — discovery, key distribution, NAT traversal, TCP fallback, users — is the honest boundary, and everything that fills it lives above the protocol, not inside it.
