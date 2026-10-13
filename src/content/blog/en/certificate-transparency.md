---
title: "Certificate Transparency: how mis-issued certificates get caught"
description: "How Certificate Transparency works in practice: real SCTs decoded from a live certificate with openssl, which CT logs signed them, how Chrome enforces SCTs, and how to query public CT logs to catch mis-issued certificates for your own domains."
pubDate: 2027-01-21
lang: en
translationKey: certificate-transparency
tags: [security, networking]
featured: false
keywords:
  - Certificate Transparency
  - SCT
  - CT log
  - crt.sh
  - mis-issued certificate
---

I work in security, so I tend to trust the padlock at face value — which is
exactly the wrong instinct. A padlock is only worth the certificate behind it,
and a certificate is only worth the CA that vouched for it. A bank certificate
signed by a CA that was hacked or just sloppy is a **mis-issued certificate**,
and for most of the web's history the domain owner was the last to find out.
Certificate Transparency (CT) changed that: every publicly-trusted certificate
today is published to public **CT logs**, and the certificate carries receipts
— **SCTs** — proving it was published. Here I'll pull real **SCT** data out of
a live certificate with `openssl`, name the **CT logs** that signed it, show
how browsers enforce all this, and then do the thing CT exists for: query
public log data to see every certificate ever issued for a name. For protocol
background see my [TLS 1.3 handshake walkthrough](/posts/tls-1-3-handshake/);
for the `openssl` basics, my [openssl cookbook](/posts/openssl-cookbook/).

## What Certificate Transparency actually is

Before CT, the web PKI had one nasty gap: **any** trusted CA could issue a
certificate for **any** domain. If a CA was compromised or made a validation
error, a valid certificate for `your-bank.com` could appear in the wild,
browsers would accept it, and nobody would know — audits reviewed process, not
individual certificates.

CT closes that hole with one idea: **make issuance public**. Every certificate
a CA wants browsers to accept is submitted to independent, append-only,
cryptographically verifiable public logs. In exchange the log returns a
**Signed Certificate Timestamp (SCT)** — a signed receipt saying "I added a
promise-of-issuance for this certificate at time T." The CA embeds the SCTs
into the final certificate, and browsers refuse to trust a certificate whose
SCTs don't check out. The asymmetry is the point: an attack still gets you one
certificate, but that certificate is broadcast to the world within seconds,
forever, with no take-backs.

## The CT log and Merkle tree model, in one page

A **CT log** is not a JSON feed you can quietly subtract from. It is a
**Merkle tree** data structure with a few crucial properties:

- **Append-only.** Each certificate (technically a precertificate — keep
  reading) is hashed into one leaf; rewriting history is practically impossible.
- **Root hash, publicly signed.** The log periodically publishes a **signed
  tree head (STH)**: tree size, timestamp, and root hash, signed with the
  log's private key — anyone can verify it.
- **Proofs of inclusion.** Given a certificate, the log can produce an O(log n)
  proof — a few hashes showing "this leaf is in the tree with root hash R" —
  so a log cannot deny having logged a certificate it did log.
- **Consistency proofs.** A tree head at size N can be proven *consistent*
  with an earlier head at size M: nothing was ever rewritten. This is how
  external **monitors** hold logs honest.

That's where the numbers get impressive — the signed tree heads of the three
logs that signed the certificate I examine next:

```console
$ curl -s https://wyvern.ct.digicert.com/2026h2/ct/v1/get-sth
{"tree_size":2157457519,"timestamp":1791860261426,"sha256_root_hash":"CzdmdaW0nk69cMWhv5IsYmdNz70aQGaQyHV4zx60Dso=","tree_head_signature":"BAMARzBFAiBB..."}

$ curl -s https://ct.googleapis.com/logs/us1/argon2026h2/ct/v1/get-sth
{"tree_size":3428898386,"timestamp":1791860182121,"sha256_root_hash":"BJbjdk+rCIvv5HZTGa+9jqkLLsBUXNUVqsO1ncxQXmE=","tree_head_signature":"BAMASDBGAiEAlrXI..."}

$ curl -s https://sphinx.ct.digicert.com/2026h2/ct/v1/get-sth
{"tree_size":2126174254,"timestamp":1791860263063,"sha256_root_hash":"WEJcjf1SqrAmTPtUXYV7K9+ACBOEIYLMrhDBrIVpMQs=","tree_head_signature":"BAMASDBGAiEAzl9wG..."}
```

2.1 billion certificates in Wyvern, 3.4 billion in Argon, 2.1 billion in
Sphinx — all reachable by anyone on the internet, at 3 a.m., without an
account.

<figure>
  <svg viewBox="0 0 760 200" width="100%" role="img" aria-labelledby="ct-flow-title" xmlns="http://www.w3.org/2000/svg" style="font-family:inherit;color:currentColor;background:none">
    <title id="ct-flow-title">A CA submits a precertificate to CT logs, gets back SCTs embedded in the final certificate, and anyone monitors the public log for unexpected certificates.</title>
    <defs>
      <marker id="ct-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#0f766e"/>
      </marker>
    </defs>
    <g fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="12" y="62" width="120" height="76" rx="8"/>
      <rect x="233" y="40" width="140" height="120" rx="8"/>
      <rect x="490" y="62" width="120" height="76" rx="8"/>
      <rect x="640" y="62" width="108" height="76" rx="8"/>
    </g>
    <g stroke="#0f766e" stroke-width="2" fill="none">
      <path d="M132 100 H225" marker-end="url(#ct-arrow)"/>
      <path d="M373 100 H482" marker-end="url(#ct-arrow)"/>
      <path d="M610 100 H632" marker-end="url(#ct-arrow)"/>
      <path d="M694 62 V28 H60 V62" stroke-dasharray="5 4" marker-end="url(#ct-arrow)"/>
    </g>
    <g fill="currentColor" font-size="13" text-anchor="middle">
      <text x="72" y="86">CA</text>
      <text x="72" y="106" font-size="10">validates domain,</text>
      <text x="72" y="120" font-size="10">builds precert</text>
      <text x="303" y="66">CT log (public,</text>
      <text x="303" y="84" font-size="10" text-anchor="middle">Merkle tree,</text>
      <text x="303" y="98" font-size="10" text-anchor="middle">append-only</text>
      <text x="303" y="120" font-size="11" text-anchor="middle" fill="#0f766e">signs an SCT</text>
      <text x="303" y="136" font-size="10" text-anchor="middle">+ timestamp</text>
      <text x="550" y="86">Certificate</text>
      <text x="550" y="106" font-size="10">with SCTs</text>
      <text x="550" y="120" font-size="10">embedded</text>
      <text x="694" y="86">Monitor /</text>
      <text x="694" y="104" font-size="10">domain owner</text>
      <text x="694" y="122" font-size="10">watches logs</text>
    </g>
    <g fill="#0f766e" font-size="10.5" text-anchor="middle">
      <text x="178" y="92">precert</text>
      <text x="427" y="92">SCTs</text>
      <text x="377" y="22">read entries: get-sth / get-entries</text>
    </g>
  </svg>
  <figcaption>The CT lifecycle: the CA's precertificate goes into public logs, the returned SCTs are embedded in the final certificate, and anyone can watch the same public log data for certificates they did not issue.</figcaption>
</figure>

## From CA to SCT: how the receipt gets into the certificate

The mechanics, in order:

1. The CA builds a **precertificate**: the certificate it intends to issue,
   plus a critical "poison" extension that makes it *unusable* as a real
   certificate, so a precert can never float around as a valid cert.
2. The CA submits the precert to several CT logs (modern CAs use five or more).
3. Each log validates it, appends it to its Merkle tree, and returns an **SCT**:
   its log ID, a millisecond timestamp, and a signature over the log entry.
4. The CA issues the *final* certificate with the SCT list embedded, in the
   X.509v3 extension with OID `1.3.6.1.4.1.11129.2.4.2` (an RFC 6962
   `SignedCertificateTimestampList`, TLS-encoded).

An **SCT** can travel three ways, and browsers accept all of them: **embedded**
in the certificate (what you'll see below — the common case), **stapled over
TLS** (the server sends the SCT list in the handshake via the
`signed_certificate_timestamp` extension), or **stapled over OCSP** (deprecated
in Chrome from version 148). openssl can request and *verify* the TLS-stapled
kind — you just have to hand it the logs' public keys first, in a small CONF
file built from Chrome's official log list:

```console
$ echo | openssl s_client -connect www.cloudflare.com -servername www.cloudflare.com \
    -ct -ctlogfile ctlogs.cnf 2>/dev/null
...
SCTs present (2)
SCT validation status: valid
Signed Certificate Timestamp:
    Version   : v1 (0x0)
    Log       : TrustAsia HETU2027
    Log ID    : ED:DA:EB:81:5C:63:21:34:49:B4:7B:E5:07:79:05:AB:
                D0:D9:31:47:C2:7A:C5:14:6B:3B:C5:8E:43:E9:B6:C7
    Timestamp : Oct 12 21:43:39.679 2026 GMT
...
```

Cloudflare staples two SCTs, and openssl pulls the HETU2027 log's key from the
config and confirms the signature. (The second SCT stays "unknown log": the
config lacks that log's key. "Unknown" means "not in my config", never
"invalid".) With SCTs in hand the certificate is valid — exactly what the
browser checks next.

## Seeing the SCTs in a real certificate

This blog's own certificate is a perfect lab rat:

```console
$ echo | openssl s_client -connect blog.awin-x.top:443 -servername blog.awin-x.top -showcerts 2>/dev/null
CONNECTED(00000003)
---
Certificate chain
 0 s:CN=blog.awin-x.top
   i:C=CN, O=TrustAsia Technologies, Inc., CN=TrustAsia DV TLS RSA CA 2025
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug 17 00:00:00 2026 GMT; NotAfter: Nov 14 23:59:59 2026 GMT
```

Now dump the CT extension (OID `1.3.6.1.4.1.11129.2.4.2`):

```console
$ openssl x509 -in cert00 -noout -text | sed -n '/CT Precertificate SCTs/,/Signature Algorithm: sha256/p'
            CT Precertificate SCTs:
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : C2:31:7E:57:45:19:A3:45:EE:7F:38:DE:B2:90:41:EB:
                                C7:C2:21:5A:22:BF:7F:D5:B5:AD:76:9A:D9:0E:52:CD
                    Timestamp : Aug 17 01:11:10.280 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : D7:6D:7D:10:D1:A7:F5:77:C2:C7:E9:5F:D7:00:BF:F9:
                                82:C9:33:5A:65:E1:D0:B3:01:73:17:C0:C8:C5:69:77
                    Timestamp : Aug 17 01:11:10.245 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
                Signed Certificate Timestamp:
                    Version   : v1 (0x0)
                    Log ID    : 94:4E:43:87:FA:EC:C1:EF:81:F3:19:24:26:A8:18:65:
                                01:C7:D3:5F:38:02:01:3F:72:67:7D:55:37:2E:19:D8
                    Timestamp : Aug 17 01:11:10.311 2026 GMT
                    Extensions: none
                    Signature : ecdsa-with-SHA256
```

Three SCTs, embedded, all `ecdsa-with-SHA256`. Notice the timestamps:
01:11:10.245, .280 and .311 GMT — **66 milliseconds apart**. That is the CA
fanning the precertificate out to three logs in parallel; it cannot finalize
the certificate until the SCTs are back. Also note the lifetime: Aug 17 to
Nov 14 2026 is 89 days, which matters in a moment.

## Naming the CT logs behind those IDs

A raw log ID is useless without a mapping — it is just the SHA-256 of the
log's public key. The official mapping is published by Chrome
(`https://www.gstatic.com/ct/log_list/v3/all_logs_list.json`, base64-encoded,
refreshed daily). I matched the three IDs against it:

```console
$ curl -s https://www.gstatic.com/ct/log_list/v3/all_logs_list.json -o logs.json
$ # decode each base64 log_id to hex and search for our three IDs:
C2317E57...0E52CD => DigiCert  / DigiCert 'Wyvern2026h2' | https://wyvern.ct.digicert.com/2026h2/
D76D7D10...8C56977 => Google    / Google 'Argon2026h2' log | https://ct.googleapis.com/logs/us1/argon2026h2/
944E4387...372E19D8 => DigiCert  / DigiCert 'Sphinx2026h2' | https://sphinx.ct.digicert.com/2026h2/
```

So this certificate is published in **two DigiCert logs and one Google log**,
minutes after its notBefore time — three independent witnesses that this exact
certificate exists.

## How browsers enforce CT

An SCT is only a deterrent if lacking one costs something — and it does:
**Chrome and Safari hard-require CT compliance for publicly-trusted
certificates** (both since 2018, progressively stricter since). A
non-compliant certificate gets a hard certificate error (net error
`ERR_CERTIFICATE_TRANSPARENCY_REQUIRED`), not a click-through warning. Chrome's
rule is a small table worth memorizing:

| Certificate lifetime | SCTs required, from distinct CT logs |
|---|---|
| ≤ 180 days | 2 |
| > 180 days | 3 |

Plus, for **embedded SCTs**: at least one must come from a log that was
`Qualified`, `Usable`, or `ReadOnly` **at the time of check** (Chrome stops
enforcing CT entirely if its log list goes stale for 70 days), and **at least
two must come from distinct CT log operators** — which is why a CA does not
just pepper one operator's logs. Our cert: 89 days, 3 SCTs, 3 distinct logs,
two operators (DigiCert ×2, Google ×1). Compliant, with room to spare.

But enforcement is only half the story. Because the log holds the
precertificate, a rogue-CA certificate issued to an attacker is visible in
public data within seconds — and that public visibility is the part you can
watch.

## Querying real CT log data

The logs speak an HTTP JSON API (RFC 6962). Two endpoints matter: `get-sth`
(the signed tree head, shown earlier) and `get-entries`, which returns raw
leaves. Here are two leaves from the Wyvern log, decoded — each with its
version, type, timestamp, and the extra data that binds the entry to its
issuer:

```console
$ curl -s "https://wyvern.ct.digicert.com/2026h2/ct/v1/get-entries?start=2157429203&end=2157429204" | \
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d).entries;
      for(const en of e){const l=Buffer.from(en.leaf_input,"base64");
        console.log("leaf_input=" + l.length + "B version=" + l[0] + " leaf_type=" + l[1] +
          " entry_type=" + l.readUInt16BE(10) + " timestamp=" + new Date(Number(l.readBigUInt64BE(2))).toISOString() +
          " extra_data=" + Buffer.from(en.extra_data,"base64").length + "B");}})'
leaf_input=1178B version=0 leaf_type=0 entry_type=1 timestamp=2026-10-13T02:39:30.244Z extra_data=3584B
leaf_input=1392B version=0 leaf_type=0 entry_type=1 timestamp=2026-10-13T02:39:30.256Z extra_data=4044B
```

Reading TLS-encoded bytes feels arcane, but look at what it says: two
precertificates hammered into the tree 12 milliseconds apart, each with its
own timestamp and issuer-key hash. `entry_type=1` means "precertificate" — the
same shape of object that produced my blog's three SCTs. API-visible,
timestamped, signed entries: no black box, which is how mis-issuance gets
caught. Searching by subject across all logs is what a monitoring service
provides; Cert Spotter exposes a public API, so an incident check is one curl:

```console
$ curl -s "https://api.certspotter.com/v1/issuances?domain=blog.awin-x.top&expand=dns_names"
[
	{
		"id": "16554053467",
		"tbs_sha256": "94c4fd813544972b48510491240905f85b13bafb29b996cdb509ca12d0b426c5",
		"cert_sha256": "6a9836bd7e1ffa266112e611449147b2fff3f211e91e40ec7979f9b661bfc135",
		"dns_names": ["blog.awin-x.top"],
		"pubkey_sha256": "6ca6e7bbf6a404fd7aa215aae7e449d1cfee480ad3e7456b8b95e63f418eae3a",
		"not_before": "2026-08-17T00:00:00Z",
		"not_after": "2026-11-14T23:59:59Z",
		"revoked": false
	}
]
```

A mis-issued certificate against your domain shows up here — every name in
its SAN, its issuer, its validity window. The search UI everyone reaches for
first is **crt.sh** (https://crt.sh, same data, JSON endpoint:
`?q=domain&output=json`) — but build a fallback into your automation: on my
test machine crt.sh returned `502 Bad Gateway` to every request while the log
APIs above answered in milliseconds. Multiple data sources is the whole
spirit of CT.

## Monitoring your own domain: a periodic CT watch

A watch is 25 lines of shell. The one non-obvious detail: **compare public-key
hashes, not certificate hashes**. The `cert_sha256` of `6a9836bd...` above is
the *precertificate* hash; live server-side fingerprints are taken on the final
cert (here `f4319141...`), so cert hashes never line up. Public-key hashes do —
`6ca6e7bb...` matched the SPKI of the certificate my server presents:

```console
$ openssl x509 -in cert00 -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256
SHA2-256(stdin)= 6ca6e7bbf6a404fd7aa215aae7e449d1cfee480ad3e7456b8b95e63f418eae3a
```

So: baseline every public-key hash you legitimately own, then alert on
anything new:

```bash
#!/usr/bin/env bash
# ct-watch.sh DOMAIN — alert on new certificates for a domain, from public CT data.
set -euo pipefail
DOMAIN="${1:?usage: ct-watch.sh example.com}"
STATE="$HOME/.ct-watch/$DOMAIN.json"
mkdir -p "$(dirname "$STATE")"

TMP=$(mktemp)
curl -sf --max-time 20 \
  "https://api.certspotter.com/v1/issuances?domain=$DOMAIN&expand=dns_names" -o "$TMP.new" || true

# new SPKI = a certificate we have not seen before (expected: new key you just deployed)
now=$(jq -r '.[].pubkey_sha256' "$TMP.new" | sort -u)
if [[ -f "$STATE" ]]; then
  joined=$(comm -13 <(sort -u "$STATE") <(printf '%s\n' "$now"))
  [[ -n "$joined" ]] && notify-send "CT watch: $DOMAIN has NEW public keys" "$joined"
fi
printf '%s\n' "$now" > "$STATE"

# SAN lists (useful for scope + subdomain discovery)
jq -r '.[].dns_names[]' "$TMP.new" | sort -u | tee "$HOME/.ct-watch/$DOMAIN.san.txt"
```

Run it daily from a timer (systemd, cron, CI). What to alert on,
in order of severity:

1. **A new public key or issuer you did not authorize** — the classic
   mis-issue signal. Verify, then ask the CA to get it revoked.
2. **A name in the SAN you do not own yet** — a CA validation error, or
   someone probing you; either way the CA will want to know.

That's the incident-detection half. The opportunistic half: CT is also the
best subdomain discovery tool ever shipped — which brings us to the tradeoff
everyone eventually hits.

## The privacy tradeoff: CT leaks hostnames

The uncomfortable corollary of "publish everything" is "everything is public."
CT logs contain the full SAN list of every certificate issued, so anyone can
enumerate `vpn.`, `staging.`, `admin.`, `gitlab.` subdomains for a target name
in about one `curl`. This is not a bug, it's the deal: transparency *is* the
detection mechanism. Practically:

- **Never assume "hidden by obscurity" names are hidden.** `staging.corp.example.com`
  with a publicly-trusted certificate is globally discoverable the moment it's
  issued. Assume the name is public; harden the host instead.
- **Use a private PKI or plain self-signed certs for truly internal names**,
  so they never touch public CT logs.
- **For sensitive deployments**, lean on the same feed: the CT data that
  exposes your subdomains also tells you, within seconds, when someone issued
  one.

## What I actually take away from this

Certificate Transparency is the rare control that is both cheap and
self-enforcing: CAs must log, browsers must reject unloved certificates, and
the cost of a mis-issued certificate stops being "days before someone notices"
and becomes "seconds, in public, forever." Watch the SCTs with `openssl` next
time you debug TLS ([cookbook here](/posts/openssl-cookbook/), [handshake
mechanics here](/posts/tls-1-3-handshake/)), then watch the logs themselves for
your domains. The data is public and the receipts are cryptographic — the
mis-issued certificate is now the thing that gets caught.