---
title: "mTLS in practice: the handshake, the commands, and the footguns"
description: "Build a tiny PKI with openssl, make nginx demand a client certificate with ssl_verify_client, verify it from curl and openssl s_client, then avoid the EKU, SAN, chain, and revocation footguns that break real mutual TLS deployments."
pubDate: 2026-12-13
lang: en
translationKey: mtls-in-practice
tags: [security, networking, nginx]
featured: false
keywords:
  - mTLS
  - mutual TLS
  - client certificate
  - ssl_verify_client
  - EKU clientAuth
---

I run a small private API reachable by only a handful of machines, and I did not
want to hand out bearer tokens that can be copied off a disk. Mutual TLS
(**mTLS**) closes that gap: the server still proves its identity, and the client
proves its identity to the server with a **client certificate**. The mechanism is
an ordinary TLS handshake plus one extra exchange, which makes it cheap to add and
expensive to debug if the certificate extensions are wrong. Below I build a
throwaway CA with `openssl`, make **nginx** require client certs with
**`ssl_verify_client`**, and paste the real handshakes — success, failure, and
inspection. For the base protocol read [the TLS 1.3
handshake](/posts/tls-1-3-handshake/); keep [the openssl
cookbook](/posts/openssl-cookbook/) open for the key and certificate mechanics.

## What mutual TLS adds over the padlock you already have

Everyday TLS is **one-directional**: the server presents a certificate, your
client checks it, and the server has no idea who you are until you send a password
or token. **Mutual TLS** closes that loop, authenticating both ends at the
transport layer before any application bytes are parsed. In TLS 1.3 the server
adds one message, `CertificateRequest` (curl prints it as `Request CERT (13)`),
and the client answers with its own `Certificate` and a `CertificateVerify`
signature proving it holds the key.

That buys three things tokens cannot. Identity is bound to a **private key**, not a
copyable string. There is no shared secret to phish — a stolen token replays, but
a stolen client cert without its key is useless. And authentication lives inside
TLS, so it protects protocols that have no auth story of their own.

<figure>
<svg viewBox="0 0 720 344" width="100%" role="img" aria-label="A lab CA signs two certificates: a server certificate with SAN localhost and EKU serverAuth, and a client certificate with SAN device-42 and EKU clientAuth. In the handshake below, the curl client and nginx server exchange ClientHello, ServerHello with Certificate and CertificateRequest, and the client Certificate plus Finished, with both sides verifying the peer chain against the CA.">
  <defs>
    <marker id="mtls-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="mtls-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="20" y="24" width="176" height="60" rx="7"/>
    <rect x="272" y="20" width="176" height="68" rx="8"/>
    <rect x="524" y="24" width="176" height="60" rx="7"/>
    <rect x="20" y="248" width="176" height="76" rx="7"/>
    <rect x="524" y="248" width="176" height="76" rx="7"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="272" y1="54" x2="200" y2="50" marker-end="url(#mtls-arrow-accent)"/>
    <line x1="448" y1="54" x2="520" y2="50" marker-end="url(#mtls-arrow-accent)"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none">
    <line x1="196" y1="272" x2="520" y2="272" marker-end="url(#mtls-arrow)"/>
    <line x1="524" y1="294" x2="196" y2="294" marker-end="url(#mtls-arrow)"/>
    <line x1="196" y1="316" x2="520" y2="316" marker-end="url(#mtls-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">
    <text x="36" y="46">server.crt</text>
    <text x="36" y="62">SAN DNS:localhost, IP:127.0.0.1</text>
    <text x="36" y="78">EKU serverAuth</text>
    <text x="288" y="46">awin-x lab CA</text>
    <text x="288" y="64">basicConstraints CA:TRUE</text>
    <text x="288" y="80">ca.key offline</text>
    <text x="540" y="46">client.crt</text>
    <text x="540" y="62">SAN DNS:device-42</text>
    <text x="540" y="78">EKU clientAuth</text>
    <text x="36" y="290">curl  (client)</text>
    <text x="36" y="310">--cert client.crt --key client.key</text>
    <text x="540" y="290">nginx  (server)</text>
    <text x="540" y="310">ssl_verify_client on</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">
    <text x="236" y="40" text-anchor="middle">signs</text>
    <text x="484" y="40" text-anchor="middle">signs</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.85">
    <text x="360" y="262" text-anchor="middle">ClientHello</text>
    <text x="360" y="284" text-anchor="middle">ServerHello + Certificate + CertificateRequest</text>
    <text x="360" y="306" text-anchor="middle">Client Certificate + Finished</text>
  </g>
  <g fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">
    <text x="360" y="340" text-anchor="middle">both sides verify the peer chain against the CA's public key</text>
  </g>
</svg>
<figcaption>One CA signs both identities. In the handshake, the server asks for a client certificate, the client presents one, and each side verifies the other's chain against the CA's public key.</figcaption>
</figure>

## The PKI pieces: a CA, two certificates, and the extensions that matter

mTLS needs exactly three things: a **CA** both ends trust, a **server certificate**
it signs, and a **client certificate** it signs. The CA key can mint identities, so
it stays offline or in an HSM and only its public certificate is distributed. Two
extensions do the work, and both are easy to get wrong. **EKU
(`extendedKeyUsage`)** declares what a certificate may do — a server cert needs
`serverAuth`, a client cert needs **`clientAuth`**, and verifiers that check
purpose reject a wrong one. **SAN (`subjectAltName`)** is where modern tooling
looks for identity: for a server it must hold the DNS name (and/or IP) clients
connect to.

## Generate a tiny PKI with openssl

The CA needs `basicConstraints CA:TRUE` (it may sign) and `keyUsage
keyCertSign,cRLSign` (it may sign certs and revocation lists). Note `pathlen:0`
here — correct for a root that signs only leaves, and I will show what it breaks
later.

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=awin-x lab CA/O=awin-x" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt

openssl x509 -in ca.crt -noout -subject
# subject=CN=awin-x lab CA, O=awin-x
```

Each leaf carries its own SAN and EKU; get the EKU direction backwards and nothing
verifies.

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -new -key server.key -subj "/CN=localhost/O=awin-x lab" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 90 -sha256 \
  -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n") -out server.crt
# ...and the same for client.key / client.crt, with:
#   extendedKeyUsage=clientAuth    subjectAltName=DNS:device-42
```

Confirm what actually landed in each file; never assume `-extfile` applied:

```text
$ openssl x509 -in server.crt -noout -ext subjectAltName,extendedKeyUsage
X509v3 Extended Key Usage: TLS Web Server Authentication
X509v3 Subject Alternative Name: DNS:localhost, IP Address:127.0.0.1
$ openssl x509 -in client.crt -noout -ext extendedKeyUsage
X509v3 Extended Key Usage: TLS Web Client Authentication
```

## Require client certificates in nginx with ssl_verify_client

Four directives. `ssl_client_certificate` is the CA nginx uses to *verify clients*
— it is not the server's own certificate.

```nginx
server {
  listen 8443 ssl;
  ssl_certificate     /pki/server.crt;
  ssl_certificate_key /pki/server.key;
  ssl_client_certificate /pki/ca.crt;   # CAs allowed to verify clients
  ssl_verify_client      on;            # on | optional | optional_no_ca
  ssl_verify_depth       2;             # root -> intermediate -> leaf
  location / {
    default_type text/plain;
    return 200 "hello\nclient_dn=$ssl_client_s_dn\nverify=$ssl_client_verify\n";
  }
}
```

`on` rejects any request without a valid client cert; `optional` asks without
requiring; `optional_no_ca` accepts an unverified cert you must validate yourself —
rarely wise. In the app, `$ssl_client_s_dn` holds the verified identity and
`$ssl_client_verify` is `SUCCESS` or an error.

## Verify from the client: curl --cert and openssl s_client

A client holding the cert and key gets in (`--cacert` is how curl trusts the
*server*):

```bash
$ curl -sS --cacert ca.crt --cert client.crt --key client.key https://localhost:8443/
hello
client_dn=O=awin-x lab,CN=device-42
verify=SUCCESS
```

Without one, nginx refuses with an HTTP `400` body — in TLS 1.3 the client
certificate is the *last* flight, so the application layer is the first place it
can complain:

```bash
$ curl -sS --cacert ca.crt https://localhost:8443/
<head><title>400 No required SSL certificate was sent</title></head>
```

`curl -v` shows the extra exchange between the normal handshake messages:

```bash
$ curl -v --cert client.crt --key client.key --cacert ca.crt https://localhost:8443/ 2>&1 | grep TLS
* TLSv1.3 (IN), TLS handshake, Request CERT (13):
* TLSv1.3 (OUT), TLS handshake, Certificate (11):
* TLSv1.3 (OUT), TLS handshake, CERT verify (15):
* TLSv1.3 (OUT), TLS handshake, Finished (20):
```

For more detail, `openssl s_client`. Add `-cert`/`-key`, and read the
**`Acceptable client certificate CA names`** block — that is how the server says
which CA it accepts, and how a client picks the right cert from a store:

```bash
$ openssl s_client -connect 127.0.0.1:8443 -servername localhost \
    -CAfile ca.crt -cert client.crt -key client.key </dev/null 2>&1
 0 s:CN=localhost, O=awin-x lab
   i:CN=awin-x lab CA, O=awin-x
Acceptable client certificate CA names
CN=awin-x lab CA, O=awin-x
Protocol: TLSv1.3
Verify return code: 0 (ok)
```

To inspect the **peer** certificate the server sent, pipe that output into `x509` —
my first move when a chain "looks wrong":

```bash
$ openssl s_client ... 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName
subject=CN=localhost, O=awin-x lab
issuer=CN=awin-x lab CA, O=awin-x
X509v3 Subject Alternative Name: DNS:localhost, IP Address:127.0.0.1
```

## Checking the pieces with openssl verify

Verify certificates on their own before blaming TLS. `openssl verify` walks the
chain and can enforce a **purpose** — exactly what a TLS server does:

```bash
$ openssl verify -CAfile ca.crt server.crt client.crt
server.crt: OK
client.crt: OK
$ openssl verify -CAfile ca.crt -purpose sslclient client.crt
client.crt: OK
$ openssl verify -CAfile ca.crt -purpose sslclient bad-eku.crt
error 26 at 0 depth lookup: unsuitable certificate purpose
error bad-eku.crt: verification failed
```

`-purpose sslclient` is the offline equivalent of nginx with your
`ssl_client_certificate` bundle, and the fastest way to catch an EKU bug without
touching the server.

## Revocation, and why short-lived certs beat CRLs

The classical answer when a client key leaks is a **CRL**: the CA publishes a
signed list of revoked serials. Revoke, then sign the list:

```bash
$ openssl ca -config openssl-ca.cnf -revoke client.crt -keyfile ca.key -cert ca.crt
Revoking Certificate 15D7D16F84A29F40799C99925FDD22621E900D99.
$ openssl ca -config openssl-ca.cnf -gencrl -keyfile ca.key -cert ca.crt -out ca.crl
```

If the verifier actually checks it, revocation bites:

```bash
$ openssl verify -CAfile ca.crt -CRLfile ca.crl -crl_check client.crt
error 23 at 0 depth lookup: certificate revoked
error client.crt: verification failed
$ openssl verify -CAfile ca.crt client.crt      # no -crl_check
client.crt: OK
```

That last pair is the trap: **a CRL does nothing unless someone checks it.** My
nginx kept accepting the revoked client cert (`verify=SUCCESS`) until I added
`ssl_crl /pki/ca.crl;`, after which it answered `400 The SSL certificate error`.
That is why I prefer **short-lived certificates** for mTLS. A CRL is a pull
mechanism every verifier must fetch, cache, and judge "fresh enough" — miss one
refresh and revocations silently stop. A cert with a 24-hour lifetime needs no
revocation story: it is dead by tomorrow anyway, and you revoke by not renewing.

```bash
# Renew hourly; the client hot-reloads the files.
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 2 -sha256 -extfile <(printf "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n") \
  -out client.crt.new && mv client.crt.new client.crt
```

## The footguns that cost me an afternoon

Each of these bit me while writing this, and each has a distinct error:

- **Wrong or missing EKU `clientAuth`.** A client cert with only `serverAuth` is
  refused (`400 The SSL certificate error`; offline, `error 26 unsuitable
  certificate purpose`). The nastier case is **no EKU at all**: OpenSSL treats it
  as "any purpose" and accepts it (`bad-eku-free.crt: OK`), so mTLS works and you
  never notice the certificate is over-broad.
- **SAN mismatch.** If the name you connect to is not in the server's SAN, clients
  reject it: `error 62 hostname mismatch`. `CN` is not a substitute in modern
  verifiers.
- **The chain is not sent.** A server that sends only its leaf fails clients that
  hold only the root: `error 20 unable to get local issuer certificate`. Bundle
  every intermediate (`ssl_certificate` must point at `cat leaf.crt intermediate.crt`).
- **`pathlen:0` on a CA that signs intermediates.** My root had `pathlen:0` and a
  two-level chain gave `error 25 path length constraint exceeded` — the setting
  meant to stop a *sub*-CA also stops your own.
- **Revocation never wired.** A revoked cert keeps working until `ssl_crl` is set;
  revocation is inert by default.
- **A proxy eating the client cert.** When a load balancer terminates TLS, *it*
  verifies the client and your backend sees only the proxied request. Forward
  `$ssl_client_s_dn` / `$ssl_client_verify` as headers and validate at the edge, or
  you have mTLS at the proxy and anonymous HTTP behind it.
- **PEM vs DER, and `--key`.** curl and nginx want PEM; some SDKs emit DER
  (`openssl x509 -in cert.der -inform DER -out cert.pem`). Send a cert without its
  key and you get a signature failure, not a clear error.

## When mTLS is worth it — and when a token is better

mTLS earns its keep where you control both ends and want identity bound to a key:
service-to-service calls, device or agent fleets, internal admin endpoints, any
zero-trust path where network location must not imply trust. It authenticates the
channel itself, so it protects non-HTTP protocols too. It is the wrong tool when
the other end is a **browser** or a third party you do not administer — users will
not install client certs, and distributing and revoking them across an untrusted
population is its own project. There, OAuth or short-lived JWTs give faster
revocation with no key distribution. The two compose: terminate mTLS at the edge
for machine identity, carry the human's JWT as an application-layer token.

## What I actually check

1. `curl -v --cert ... --key ... --cacert ...` and look for `Request CERT (13)`;
   if it is absent, the server never asked for a client cert.
2. `openssl s_client -cert ... -key ...` to read `Acceptable client certificate CA
   names` and `Verify return code`.
3. `openssl verify -CAfile ca.crt -purpose sslclient client.crt` to separate an EKU
   or chain problem from a TLS problem.
4. Confirm the server sends its intermediates and the client trusts the same root
   the server was signed under.
5. Only then look at revocation and lifetimes.

mTLS is not complicated — a CA and two certificates with the right extensions. The
complexity is in the footguns, and each one now surfaces as a specific error code
you can read.
