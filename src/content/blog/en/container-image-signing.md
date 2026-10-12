---
title: "Container supply-chain integrity: signing images with cosign, and why tags lie"
description: "Tags lie and digests don't. A hands-on guide to container supply-chain integrity: build a tiny image, sign it by image digest with cosign, verify before deploy, watch a silently moved tag fail verification, attach an SBOM, and gate the deploy. Real terminal output included."
pubDate: 2027-01-03
lang: en
translationKey: container-image-signing
tags: [security, devops]
featured: false
keywords:
  - cosign
  - image signing
  - container supply chain
  - image digest
  - SBOM
  - Sigstore
  - immutable tags
---

Most of us deploy containers we did not build line by line, and we identify them by a name we do not control. `nginx:1.27` is a *mutable label* — whoever can write to that repository can move it, so yesterday's `pull` can land a different image today. **Container supply-chain integrity** is the set of habits that make "what exactly am I running?" a cryptographic answer instead of a hopeful one. In this article I do the whole loop for real: build a tiny image, get an **image signing** keypair, sign it *by digest* with **cosign** (Sigstore's tool), verify it, then let a "compromised build" replace the image behind the same tag and watch verification fail. No sudo, no `--privileged`, one throwaway registry on localhost, and the actual terminal output.

<figure>
<svg viewBox="0 0 720 230" width="100%" role="img" aria-label="Three stages left to right. One, build: source code becomes a container image with a digest starting sha256:e61a44. Two, sign: cosign signs the digest with a private key and the signature is stored next to the image as a tag named sha256-e61a44-dot-sig. Three, verify before deploy: cosign checks the signature with the public key; a valid signature deploys, a missing one is blocked.">
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <path d="M214 100 h34" marker-end="url(#arr)"/>
    <path d="M454 100 h34" marker-end="url(#arr)"/>
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#0f766e" stroke="none"/>
      </marker>
    </defs>
  </g>
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.6">
    <rect x="24" y="44" width="190" height="120" rx="10"/>
    <rect x="264" y="44" width="190" height="120" rx="10"/>
    <rect x="504" y="44" width="190" height="120" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="119" y="26" text-anchor="middle" font-weight="600">1 · build</text>
    <text x="359" y="26" text-anchor="middle" font-weight="600">2 · sign</text>
    <text x="599" y="26" text-anchor="middle" font-weight="600">3 · verify before deploy</text>

    <text x="119" y="86" text-anchor="middle">source → image</text>
    <text x="119" y="106" text-anchor="middle">digest sha256:e61a44…</text>
    <text x="119" y="132" text-anchor="middle" fill="#0f766e">content-addressed bytes</text>

    <text x="359" y="86" text-anchor="middle">cosign sign --key …</text>
    <text x="359" y="106" text-anchor="middle">signature over the digest</text>
    <text x="359" y="132" text-anchor="middle" fill="#0f766e">stored as sha256-….sig</text>

    <text x="599" y="86" text-anchor="middle">cosign verify --key …</text>
    <text x="599" y="106" text-anchor="middle">valid → deploy</text>
    <text x="599" y="132" text-anchor="middle" fill="#0f766e">invalid → blocked, exit 10</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="360" y="196" text-anchor="middle">identity is the digest, never the tag</text>
    <text x="360" y="214" text-anchor="middle">a moved tag fails verification; swapped bytes fail it harder</text>
  </g>
</svg>
<figcaption>The loop that makes image identity verifiable instead of trusting a name: build produces content-addressed bytes, signing binds your key to that exact digest, and verification happens before anything reaches a host.</figcaption>
</figure>

## The problem: why image tags lie

A tag is a name in a namespace; `docker.io/library/nginx:1.27` is a pointer somebody can repoint. Four ways this bites:

- **Mutable tags.** `latest` is famous for it, but every tag is mutable unless the repository is marked immutable. Rebuilds and repushes move the pointer.
- **Typosquatting and lookalikes.** `nginxx`, `nglnx`, or a personal namespace that looks official. At 2 a.m., one wrong character in the name is indistinguishable from one wrong character of intent.
- **A compromised build.** If the build job or its token is compromised, the attacker gets the image *and* the tag. Everything downstream that trusts the tag inherits the compromise.
- **Pulling something you didn't build.** A shared Dockerfile, a vendored base image, a "trusted" internal cache that silently serves a rebuild. You know your *request*, not your *bytes*.

The demo that motivates everything else. I build a tiny Go program in a `FROM scratch` image, push it to a throwaway local registry, then "compromise the build" and push different bytes under the **same tag**:

```console
$ docker build -t signme:v1 . && docker push localhost:5000/signme:v1
v1: digest: sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 size: 535

# ... the build environment serves different bytes behind the same tag ...
$ docker tag signme:tampered localhost:5000/signme:v1 && docker push localhost:5000/signme:v1
v1: digest: sha256:f04d9db4ab9d519f224aa67ba7fb5735de7add3753b075bab421cd16b718b5a3 size: 535

$ docker run --rm localhost:5000/signme:v1
hello from build 2 (replaced behind the same tag)
```

Same tag, different digest, different content — and every deploy step that resolved `signme:v1` just ran attacker-controlled code with a straight face. (If the bytes themselves bother you more than their identity, that is a different problem: [container image size](/posts/container-image-size/).)

## Image digests: the immutable identity

The digest is the answer. It is `sha256:` over the image's **manifest** — the JSON naming the config blob and every layer. Change one byte of one layer and the manifest, and therefore the digest, changes. You cannot make new content match an old digest; that is the point of a hash:

```console
$ docker image inspect localhost:5000/signme:v1 --format '{{range .RepoDigests}}{{.}}{{end}}'
localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
```

Two properties matter. Digests are **immutable tags** in the truest sense — the mapping from digest to bytes can only be garbage-collected, never edited. But — and this is the part people miss — *a digest says what something is, not who made it*. The tampered image above also has a perfectly valid digest; a cryptographic name for attacker bytes is still attacker bytes. Identity is half the loop. The other half is a signature that binds a *key you trust* to a *digest you resolved*.

## Image signing with cosign: key-based and keyless

**Cosign**, from the Sigstore project, signs images and stores signatures in the registry itself — no side server, no new infrastructure. A signature is a small manifest attached to the repository as a pseudo-tag called `sha256-<digest>.sig`. I ran cosign v2.4.1 in a container (`ghcr.io/sigstore/cosign/cosign:v2.4.1`) against a `registry:2` on `127.0.0.1:5000`, so the host stayed clean.

**Key-based signing** is the offline-friendly mode: you hold the private key. Generating the pair is one command:

```console
$ export COSIGN_PASSWORD='…'
$ cosign generate-key-pair
Private key written to cosign.key
Public key written to cosign.pub
```

Now sign — and sign the **digest, not the tag**. Hand cosign a tag and it warns loudly, because "resolve the tag, sign whatever comes back" is exactly the race a compromised build wins:

```console
$ cosign sign --key cosign.key localhost:5000/signme:v1
WARNING: Image reference localhost:5000/signme:v1 uses a tag, not a digest, to identify the image to sign.
    This can lead you to sign a different image than the intended one. Please use a
    digest (example.com/ubuntu@sha256:abc123...) rather than tag
    (example.com/ubuntu:latest) for the input to cosign. The ability to refer to
    images by tag will be removed in a future release.

Pushing signature to: localhost:5000/signme
```

Signing by digest is quiet and vouches for nothing you did not ask:

```console
$ cosign sign --key cosign.key --tlog-upload=false \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Pushing signature to: localhost:5000/signme
$ curl -s http://127.0.0.1:5000/v2/signme/tags/list
{"name":"signme","tags":["sha256-e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6.sig","v1"]}
```

Read that tags list carefully: the signature is *itself* a tag named after the digest it covers, so it cannot be attached to different bytes. I disabled transparency-log upload (`--tlog-upload=false`) because there is no Rekor to talk to offline; in production leave it on.

**Keyless signing** is the Sigstore-native mode and the one to want: no long-lived key at all. The signer proves it ran inside a trusted CI job via OIDC, Fulcio issues a short-lived certificate, and both are recorded in the public transparency log — nothing to back up, nothing to leak, every signature publicly auditable. It works because CI systems can mint a genuine OIDC token:

```yaml
# keyless signing, inside a CI job that has an OIDC identity
- uses: sigstore/cosign-installer@v3.9.0
- run: cosign sign --yes localhost:5000/signme@${{ env.DIGEST }}
```

Verification then checks not just a key but *who* signed: `cosign verify --certificate-identity-regexp 'https://github.com/org/repo/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com …`. I could not demo keyless here — no OIDC provider, no Fulcio — so I will not pretend I did; the key-based flow above is the same math, offline.

## Verifying before you deploy: success and failure

Verification is the whole point, so here is the full transcript. Success against the signed digest:

```console
$ cosign verify --key cosign.pub --insecure-ignore-tlog=true \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
WARNING: Skipping tlog verification is an insecure practice that lacks transparency and auditability verification for the signature.

Verification for localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key

[{"critical":{"identity":{"docker-reference":"localhost:5000/signme"},"image":{"docker-manifest-digest":"sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6"},"type":"cosign container image signature"},"optional":null}]
```

Note the `docker-manifest-digest` in the payload: the signature contains the digest it vouches for. The `--insecure-ignore-tlog` flag is honest bookkeeping — my keyed signature has no transparency-log entry because I turned upload off, and without the flag verification fails for exactly that reason:

```console
$ cosign verify --key cosign.pub localhost:5000/signme:v1
Error: no matching signatures: signature not found in transparency log
```

Now the failure that matters: the same tag, after the compromised build moved the digest behind it. cosign resolves the tag to the *new* digest, finds no signature for those bytes, and exits non-zero:

```console
$ cosign verify --key cosign.pub --insecure-ignore-tlog=true localhost:5000/signme:v1
WARNING: Skipping tlog verification is an insecure practice that lacks transparency and auditability verification for the signature.
Error: no signatures found
$ echo $?
10
```

`Error: no signatures found`, exit code 10 — the tool's message is precise: *the tag now points at bytes nobody signed*. Meanwhile the old, signed digest still verifies. That is the whole design in one sentence: the signature follows the bytes, not the name.

## SBOMs, attestations, and what provenance actually says

A signature says *who approved these bytes*, never *what is inside*. That is the **SBOM** — a software bill of materials, usually SPDX or CycloneDX — and its natural home is an **attestation**: a signature over a statement ("here is the SBOM for digest X"), stored the same `.att` way next to the image.

I generated a real SBOM with syft (my `docker sbom` attempt fails on this box — plugin not installed — so the honest version is syft in a container):

```console
$ docker save signme:v1 -o signme-v1.tar
$ docker run --rm -v "$PWD":/w anchore/syft:latest docker-archive:/w/signme-v1.tar -o spdx-json
SPDXVersion: SPDX-2.3
packages: 3
  - command-line-arguments | UNKNOWN | NOASSERTION
  - stdlib | go1.27.2-X:nodwarf5 | NOASSERTION
  - /w/signme-v1.tar | sha256:e9ac134f…710f | NOASSERTION
```

Boring output is the goal: three packages, one binary, one Go stdlib. Attach it to the digest and read it back through verification:

```console
$ cosign attest --key cosign.key --type spdx --predicate sbom.spdx.json \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Using payload from: /logs/sbom.spdx.json
$ cosign verify-attestation --key cosign.pub --type spdx --insecure-ignore-tlog=true \
    localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
Verification for localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6 --
The following checks were performed on each of these signatures:
  - The cosign claims were validated
  - The signatures were verified against the specified public key
{"payloadType":"application/vnd.in-toto+json","payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjAuMSIs…
```

The registry now holds both proofs, both named after the same digest:

```console
$ curl -s http://127.0.0.1:5000/v2/signme/tags/list
{"name":"signme","tags":["sha256-e61a4440…af6.sig","v1","sha256-e61a4440…af6.att"]}
```

Where this heads at ecosystem level is **SLSA provenance**: an attestation stating *this build, from this source commit, by this builder, produced this digest*. You sign the image, attest the SBOM and provenance, and a consumer can later ask "built by my CI from my repo, or did it appear from nowhere?" — and get a cryptographic answer. The marching-orders version: sign images, attach SBOMs, get provenance attestations from your build system.

## Enforcement: a gate before deploy, and admission control after it

A signature nobody checks is paperwork. The minimum viable enforcement makes verification a precondition of deploy:

```sh
#!/bin/sh
# deploy-gate.sh — pull/deploy only what the trusted key signed
set -eu
REF="$1"
if cosign verify --key cosign.pub --insecure-ignore-tlog=true "$REF" >/dev/null 2>&1; then
    echo "DEPLOY ALLOWED: $REF is signed by the trusted key"
else
    echo "DEPLOY BLOCKED: $REF has no valid signature (cosign exit $?)"
    exit 1
fi
```

Against my registry it does what you would hope — the signed digest deploys, the moved tag is stopped:

```console
$ ./deploy-gate.sh localhost:5000/signme@sha256:e61a44408c9e15c44abb75630adf6bf3722ac358e67e535c74edb5032cd26af6
DEPLOY ALLOWED: localhost:5000/signme@sha256:e61a4440… is signed by the trusted key
$ ./deploy-gate.sh localhost:5000/signme:v1
DEPLOY BLOCKED: localhost:5000/signme:v1 has no valid signature (cosign exit 10)
```

At cluster scale the same check moves to the admission controller, so nothing unsigned starts no matter who types `kubectl apply`. With Kyverno (config, not something I ran — no cluster here):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-cosign-signatures
spec:
  validationFailureAction: Enforce
  rules:
    - name: images-must-be-signed
      match:
        any:
          - resources:
              kinds: [Pod]
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      …
                      -----END PUBLIC KEY-----
```

Every implementation has the same shape — cosign v3's own `verify --policy` mode included: *these image globs must carry a signature from this identity, matched against the digest, at admission time*. The detail that changes behavior: **the policy matches digests, never tags**, or you have rebuilt the tag race inside your own gate.

## The honest reality for a solo operator

I do not want to sell this as a religion. For one person running a handful of services, the full stack — Fulcio, Rekor, an admission controller, a provenance pipeline — is real work against a threat model you mostly do not face. What I actually do:

- **Pin digests.** In every Dockerfile and compose file: `FROM alpine:3.21@sha256:48b0…`. The single highest-value line in this article (I repeat it in [container security basics](/posts/container-security/)).
- **Build what you can.** The most trustworthy image is one you built from a Dockerfile you read; `FROM scratch` plus your own static binary is usually smaller *and* strictly more verifiable than any base you would have pulled.
- **Sign what matters.** Your own deployables, from your own CI, with cosign — keyless if CI gives you OIDC, key-based with the key in a real secret store if not. Ten minutes of setup that survives the day your registry credentials get stolen.
- **Verify at the gate, not in a report.** A script that refuses to pull an unsigned digest beats a dashboard nobody reads.
- **Do not over-engineer.** If nobody but you can write to your repositories, the main risk is your future self retagging something. Digests plus signed deployables cover essentially everything real; the SLSA attestation stack earns its keep when a *team* and a *CI you did not assemble* enter the picture.

The mental model I keep: a tag is a promise someone can break, a digest is a fingerprint nobody can fake, and a signature is the only thing that connects the two to a person or build system you decided to trust. Check the fingerprint against the signature right before the bytes execute, and "pull something you didn't build" stops being a category of outage.
