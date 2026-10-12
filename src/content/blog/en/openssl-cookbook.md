---
title: "The openssl cookbook: inspect and verify certificates with openssl commands"
description: "A practical set of openssl commands to inspect a certificate, verify a certificate chain, and check a live TLS server with openssl s_client. Real output from x509, req, verify, and pkcs12, plus PEM vs DER vs PKCS#12 conversion and the leaf-vs-chain and key-vs-cert confusions."
pubDate: 2026-12-04
lang: en
translationKey: openssl-cookbook
tags: [security, linux]
featured: false
keywords:
  - openssl commands
  - openssl s_client
  - inspect certificate
  - verify certificate chain
  - x509
---

I debug TLS for a living, and the number of times a full incident turns out to be one wrong byte in a certificate chain still surprises me. The good news is that you rarely need a fancy tool to find it: **openssl commands** will show you the subject, the issuer, the expiry, the SAN list, and whether the chain actually links up. This is the cookbook I keep coming back to — how to **inspect a certificate**, **verify a certificate chain**, and point **openssl s_client** at a live server, with real output from every command.

If you want the *why* behind the errors you are about to see, read [TLS errors explained](/posts/tls-errors-explained/) first, and if you are already comfortable with X.509 you can skim it. For the SSH-flavored sibling of all this, see [SSH certificates](/posts/ssh-certificates/).

Everything below runs on a throwaway key I generated in `/tmp`; no third-party hosts, no sudo, no installs.

## Know which openssl you are running

Before anything else, check the version — because the modern `openssl` command is really two tools wearing the same name.

```console
$ openssl version
OpenSSL 3.6.5 29 Sep 2026 (Library: OpenSSL 3.6.5 29 Sep 2026)

$ openssl version -a
built on: Tue Sep 29 15:51:51 2026 UTC
platform: linux-x86_64
OPENSSLDIR: "/etc/ssl"
```

The divide that bites people is **3.x versus 1.1.1**:

- **3.x names the key tool differently.** `openssl genrsa` is deprecated; use `openssl genpkey`. Both still exist, but only one is the future.
- **`-nodes` became `-noenc`.** "Don't encrypt the private key" is now spelled `-noenc`; `-nodes` still works but prints as deprecated.
- **Providers replaced engines.** `openssl list -providers` shows the `default` provider; algorithms that are no longer blessed (MD5, RC4, old ciphers) live in a separate `legacy` provider you must load explicitly.
- **Error lines changed shape.** 3.x prints `error:0A000197:SSL routines:...` with new reason codes, so old grep patterns miss.

1.1.1 is end-of-life since 2023, so if you are on it, treat that as a finding in itself.

## Make a throwaway key and certificate

I never debug against production material. One self-signed cert is enough to practice on:

```console
$ openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out leaf.key
$ openssl req -new -x509 -key leaf.key -days 30 \
    -subj "/CN=test.awin-x.local" \
    -addext "subjectAltName=DNS:test.awin-x.local,DNS:localhost,IP:127.0.0.1" \
    -out leaf.crt
```

Two details worth knowing: `genpkey -algorithm` is the 3.x spelling, and `-addext` (added in 1.1.1) injects the SAN without a config file. Note that `req -x509` marks the result as a CA by default — fine for a test, wrong for a real server cert. For a proper chain I also made a tiny CA and signed a leaf with it, which is what the next sections use.

## Inspect a certificate: x509 -text -noout

The single most useful command in the toolbox. `-noout` suppresses the base64 blob so you only get the human-readable fields:

```console
$ openssl x509 -in leaf.crt -text -noout
Certificate:
    Data:
        Version: 3 (0x2)
        Signature Algorithm: sha256WithRSAEncryption
        Issuer: CN=test.awin-x.local
        Validity
            Not Before: Oct 12 08:43:38 2026 GMT
            Not After : Nov 11 08:43:38 2026 GMT
        Subject: CN=test.awin-x.local
        Subject Public Key Info:
            Public Key Algorithm: rsaEncryption
                Public-Key: (2048 bit)
        X509v3 extensions:
            X509v3 Basic Constraints: critical
                CA:TRUE
            X509v3 Subject Alternative Name:
                DNS:test.awin-x.local, DNS:localhost, IP Address:127.0.0.1
```

Read it top-down: who issued it, how long it lives, who it is for, what key it carries, and which extensions constrain it. Most of the time you only want a slice, so use the one-line extractors:

```console
$ openssl x509 -in leaf.crt -noout -subject -issuer -dates -ext subjectAltName
subject=CN=test.awin-x.local
issuer=CN=test.awin-x.local
notBefore=Oct 12 08:43:38 2026 GMT
notAfter=Nov 11 08:43:38 2026 GMT
X509v3 Subject Alternative Name:
    DNS:test.awin-x.local, DNS:localhost, IP Address:127.0.0.1
```

That block is the one I paste into tickets. To answer "does it expire soon?" scriptably, use `-checkend`:

```console
$ openssl x509 -in leaf.crt -noout -checkend 86400 && echo "valid for 24h more"
Certificate will not expire
valid for 24h more
```

`-checkend` exits non-zero when the cert will expire within the window, which makes it perfect for monitoring. Watch the SAN, not the CN: browsers stopped trusting CN-only certificates years ago, so a cert with a correct `CN` and a missing `DNS:` entry is a common and infuriating failure.

## Verify a certificate chain

**Verifying a certificate chain** is a separate job from reading it. A leaf cert is only trusted if it links to a root that is *in your trust store* — and if somebody forgot to send the intermediate, it will not link.

```console
$ openssl verify -CAfile ca.crt srv.crt
srv.crt: OK

$ openssl verify -show_chain -CAfile ca.crt srv.crt
srv.crt: OK
Chain:
depth=0: CN=api.awin-x.local (untrusted)
depth=1: CN=awin-x test CA, O=awin-x
```

`-CAfile` is the trust anchor. `-untrusted` is different: it supplies intermediates the peer did not hand you, but does **not** trust them. Run verify with the intermediate alone and it fails exactly the way a real server does when it forgets the middle of the chain:

```console
$ openssl verify -untrusted ca.crt srv.crt
CN=awin-x test CA, O=awin-x
error 19 at 1 depth lookup: self-signed certificate in certificate chain
error srv.crt: verification failed
```

"Self-signed certificate in certificate chain" almost always means: the server sent its own intermediate, or the leaf is self-signed, or the root is missing. The fix is on the server, not the client — send the intermediates (but never the root). The `subject_hash` of a CA equals the `issuer_hash` of its leaf, which is exactly how OpenSSL finds parents in a hashed directory:

```console
$ openssl x509 -in ca.crt -noout -subject_hash
4688f5f1
```

## Check a live server with openssl s_client

`openssl s_client` is the client-side counterpart: it opens a TCP connection, completes a handshake, and prints what the server presented. Always pass `-servername` (SNI), or you will inspect the wrong certificate on shared hosting:

```console
$ openssl s_server -accept 127.0.0.1:8446 \
    -cert srv.crt -cert_chain ca.crt -key srv.key -www &

$ echo | openssl s_client -connect 127.0.0.1:8446 \
    -servername api.awin-x.local -showcerts -CAfile ca.crt
Certificate chain
 0 s:CN=api.awin-x.local
   i:CN=awin-x test CA, O=awin-x
 1 s:CN=awin-x test CA, O=awin-x
   i:CN=awin-x test CA, O=awin-x
Verification: OK
Verify return code: 0 (ok)
```

The `Certificate chain` table is the whole story: entry 0 is the leaf, each `s:` is a subject and each `i:` is its issuer. If entry 0's issuer never appears as a subject below it, the server is not sending the intermediate — the classic mistake. `-showcerts` dumps the PEM of everything the server sent so you can inspect it offline.

To make `s_client` actually *fail the process* on a bad chain (useful in scripts and CI), add `-verify_return_error`. Without a trust anchor it refuses instead of printing a warning and carrying on:

```console
$ echo | openssl s_client -connect 127.0.0.1:8446 \
    -servername api.awin-x.local -verify_return_error
verify error:num=20:unable to get local issuer certificate
Verify return code: 20 (unable to get local issuer certificate)
```

`s_client` is a *passive* check: it negotiates TLS and hangs up. It does not log in or send data beyond the handshake (the `echo |` just closes stdin), so it is safe to run against your own hosts. Do not point it at systems you do not own.

## Convert formats: PEM, DER, and PKCS#12

Three container formats cause most of the confusion. **PEM** is base64 text between `-----BEGIN ...-----` lines; **DER** is the same data in raw binary; **PKCS#12** (`.p12`/`.pfx`) is a password-protected bundle of key plus certificates.

```console
$ openssl x509 -in srv.crt -outform DER -out srv.der      # PEM -> DER
$ file srv.der
srv.der: Certificate, Version=3
$ openssl x509 -in srv.der -inform DER -out srv-from-der.pem   # DER -> PEM
```

The one rule: if `openssl` says "unable to load certificate," you forgot `-inform DER`. Make a **PKCS#12** bundle (what Windows and many appliances want) with:

```console
$ openssl pkcs12 -export -inkey srv.key -in srv.crt -certfile ca.crt \
    -name "api.awin-x.local" -passout pass:changeit -out srv.p12
$ openssl pkcs12 -in srv.p12 -passin pass:changeit -info -noout
MAC: sha256, Iteration 2048
PKCS7 Encrypted data: PBES2, PBKDF2, AES-256-CBC, Iteration 2048
Certificate bag
Certificate bag
Shrouded Keybag: PBES2, PBKDF2, AES-256-CBC, Iteration 2048
```

## Extract a key from a PKCS#12 file

The reverse trip is where people get stuck, because a `.p12` holds several objects and you must name the one you want. To pull the private key out unencrypted:

```console
$ openssl pkcs12 -in srv.p12 -passin pass:changeit \
    -nocerts -nodes -out extracted.key
$ head -1 extracted.key
Bag Attributes
```

`-nocerts` takes only keys, `-nodes` skips re-encrypting the output, and note the `Bag Attributes` header lines — that is your sign the extraction worked and the file is still valid PEM underneath. For the certificate instead of the key, swap in `-clcerts -nokeys`:

```console
$ openssl pkcs12 -in srv.p12 -passin pass:changeit \
    -clcerts -nokeys -out extracted.crt
$ openssl x509 -in extracted.crt -noout -subject
subject=CN=api.awin-x.local
```

## Generate and sign a CSR

A **CSR** is a public key plus the names you want, signed by the matching private key so the CA knows you hold it. You build one with `req -new`:

```console
$ openssl req -new -key srv.key -subj "/CN=blog.awin-x.local" -out blog.csr
$ openssl req -in blog.csr -noout -verify -subject
Certificate request self-signature verify OK
subject=CN=blog.awin-x.local
```

`req -noout -verify` checks the self-signature — a fast way to catch a corrupted or mismatched CSR before it reaches the CA. The CA then signs it (`x509 -req`), copying the extensions you asked for:

```console
$ openssl x509 -req -in blog.csr -CA ca.crt -CAkey ca.key \
    -CAcreateserial -days 90 -copy_extensions copy -out blog.crt
Certificate request self-signature ok
subject=CN=blog.awin-x.local
```

## Fingerprints and hashes

A **fingerprint** pins one exact certificate — a hash of the DER bytes, not the subject. You want SHA-256, never SHA-1:

```console
$ openssl x509 -in srv.crt -noout -fingerprint -sha256
sha256 Fingerprint=BC:12:24:B5:2E:43:1B:F6:63:33:61:05:EE:4D:C2:60:6E:98:78:BF:D3:A4:60:E0:13:2E:9C:3D:8E:45:A4:7A
```

Remember two things. First, a fingerprint changes when anything changes — a renewal produces a new one, so pinning a leaf breaks on every rotation; pin the CA/public key instead. Second, the fingerprint is over the **certificate**, not the key, so it is not a key fingerprint and cannot be checked against a private key file. For that, compare public keys directly:

```console
$ openssl x509 -in srv.crt -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 5c03e514747a9ef4cca158a2a57fa11043d9c9ec5140b301cfff61132fc6a367
$ openssl pkey -in srv.key -pubout -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 5c03e514747a9ef4cca158a2a57fa11043d9c9ec5140b301cfff61132fc6a367
```

Matching hashes mean the key and cert belong together.

## Common confusions: leaf vs chain, key vs cert

Three mixes cost me the most time over the years:

- **Leaf vs chain.** The leaf is one cert; the chain is leaf plus intermediates. A server must send the intermediates and the client must already have the root. One cert file on the server is the #1 cause of "works in curl, fails in Java."
- **Key vs cert.** The `.key` is secret and never sent; the `.crt` is public and sent on every handshake. Point a tool at the wrong one and it fails loudly — `openssl x509 -in srv.key` says `Could not find certificate`, and `openssl pkey -in srv.crt` says `Could not find private key`. That is not corruption; it is the wrong file type.
- **Subject vs SAN.** Identity lives in `subjectAltName` now. The CN is decoration.

And a format mix: PEM versus DER. Text starting `-----BEGIN` is PEM; a file that starts with a `0x30` byte is DER. When in doubt, `openssl x509 -in file -noout -subject` will tell you if it loaded at all.

Pin these six and you can diagnose almost any TLS problem from a shell: `version`, `x509 -text -noout`, `verify -CAfile`, `s_client -connect -servername -showcerts`, `pkcs12`, and `x509 -fingerprint -sha256`. Once the inspection is second nature, the errors in [TLS errors explained](/posts/tls-errors-explained/) stop being scary and start being a checklist.
