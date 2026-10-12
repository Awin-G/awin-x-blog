---
title: "SSH certificates: stop managing authorized_keys"
description: "authorized_keys sprawl breaks the moment you hire someone or rotate a key. SSH certificates fix it: one SSH CA signs user certs with principals and expiry, host certificates kill the TOFU prompt, and short-lived credentials remove the need for revocation. Copyable ssh-keygen -s and sshd config."
pubDate: 2026-11-24
lang: en
translationKey: ssh-certificates
tags: [security, networking, linux]
featured: false
keywords:
  - SSH certificates
  - SSH CA
  - TrustedUserCAKeys
  - host certificate
  - principals
---

Every server I run still has a `~/.ssh/authorized_keys`, and for years that file was how I granted access: paste a public key, close the ticket, move on. It works for one laptop on one box. It stops working the moment there are two of either — two people, two servers, or one person with two devices. **SSH certificates** are how I fixed that. Instead of a growing list of keys on every host, a single **SSH CA** signs small blobs of data that say "this key belongs to this person, for these roles, until this time," and every server just has to trust the CA. The setup is smaller than people expect: one extra file on the server and a `ssh-keygen -s` invocation per person.

If the client side is still a mystery, read my [advanced SSH](/posts/advanced-ssh/) post first — keys, `ssh-agent` and `~/.ssh/config`. And keep the [server hardening checklist](/posts/hardening-a-public-server/) open too, because certificates change *how* you authorize, not the rest of the door.

## The pain of authorized_keys sprawl

Let me be concrete about the failure mode, because for a long time I thought `authorized_keys` was fine:

- **Adding a person is a fan-out.** A new teammate needs their key in `/home/deploy/.ssh/authorized_keys` on every host they can reach, plus `root`'s file, plus the backup box you forgot about. N hosts, N edits, N chances to typo an IP and paste into the wrong server.
- **Removing a person is worse.** You have to find *every* copy of the key. The one you miss is the one that matters. There is no central "who has access to what" that is actually true.
- **Rotation has no deadline.** A key copied to a laptop in 2021 is still valid in 2026 unless someone remembers to delete it. `authorized_keys` has no expiry field, so the default lifetime of a key is "forever, until someone cleans up."
- **No scope.** A key is all-or-nothing for the account it sits in. You cannot say "this key may open a shell on the web servers but not the database" without inventing a second Unix user and a set of file permissions.
- **No audit trail.** The file tells you a key exists, not who holds it or when it was issued.

None of this is a crisis at three servers. It becomes a monthly chore at ten, and a genuine audit finding at fifty. The annoying part is that the fix is not a product — it is a mode that `ssh` and `sshd` have had for years.

## How an SSH CA works: certs, principals, validity

An SSH certificate is not X.509. It is a small, fixed-format blob, signed by a CA key, that wraps either a user's public key or a host's public key. `ssh-keygen` produces it, `ssh` and `sshd` verify it, and the format has only a handful of fields you care about:

- **The CA's public key** — the only thing servers have to distribute. If your signature verifies against it, the certificate is trusted.
- **Key ID (`-I`)** — a human label that shows up in logs, e.g. `deepseek@laptop-2026`. Not a security control, but the reason logs become readable.
- **Principals (`-n`)** — the names this cert is allowed to log in as. `-n deploy` means this key may authenticate as the `deploy` account. A cert for `-n deploy,admin` grants both, checked against the target username at login time.
- **Validity (`-V`)** — an explicit start and end. `-V +8h` is a workday; `-V +52w` is a year. This is the field `authorized_keys` never had.
- **Critical options (`-O`)** — enforced by the server: `force-command`, `source-address`, `no-port-forwarding` and friends. If a server does not understand a critical option, it must reject the cert, which is how the format stays safe to extend.

<figure>
<svg viewBox="0 0 660 300" width="100%" role="img" aria-label="A single SSH CA signs two kinds of certificate: a user certificate wrapping a user key, and a host certificate wrapping a server host key. Servers verify user certificates against the CA public key via TrustedUserCAKeys; clients verify host certificates against the same public key via an at-cert-authority line in known_hosts.">
  <defs>
    <marker id="sshc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="54" width="146" height="46" rx="7"/>
    <rect x="16" y="200" width="146" height="46" rx="7"/>
    <rect x="246" y="116" width="168" height="68" rx="8"/>
    <rect x="468" y="54" width="176" height="46" rx="7"/>
    <rect x="468" y="200" width="176" height="46" rx="7"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="162" y1="77" x2="244" y2="130" marker-end="url(#sshc-arrow)"/>
    <line x1="162" y1="223" x2="244" y2="170" marker-end="url(#sshc-arrow)"/>
    <line x1="414" y1="130" x2="466" y2="77" marker-end="url(#sshc-arrow)"/>
    <line x1="414" y1="170" x2="466" y2="223" marker-end="url(#sshc-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="89" y="74" text-anchor="middle">user key</text>
    <text x="89" y="90" text-anchor="middle">id_ed25519</text>
    <text x="89" y="220" text-anchor="middle">host key</text>
    <text x="89" y="236" text-anchor="middle">ssh_host_ed25519_key</text>
    <text x="330" y="142" text-anchor="middle" font-size="13">SSH CA</text>
    <text x="330" y="160" text-anchor="middle" font-size="11">offline, passphrase</text>
    <text x="556" y="74" text-anchor="middle">id_ed25519-cert.pub</text>
    <text x="556" y="90" text-anchor="middle">-n principals  -V +8h</text>
    <text x="556" y="220" text-anchor="middle">host-cert.pub</text>
    <text x="556" y="236" text-anchor="middle">-h -n web-01</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="330" y="202" text-anchor="middle">signs</text>
    <text x="330" y="278" text-anchor="middle">servers and clients only ever need the CA public key</text>
  </g>
</svg>
<figcaption>One SSH CA signs two kinds of certificate. Servers verify user certs against the CA's public key with `TrustedUserCAKeys`; clients verify host certs against the same key with a `@cert-authority` line in `known_hosts`.</figcaption>
</figure>

The important asymmetry: user certs are checked by the **server** via `TrustedUserCAKeys`, host certs are checked by the **client** via `@cert-authority` in `known_hosts`. Same mechanism, opposite directions, solving two different problems.

## Setting up a CA and signing your first user certificate

I generate two CA keys: one for users, one for hosts. Keep the user CA offline if you can — a USB stick or an air-gapped machine — because whoever holds that private key can mint a login as anyone.

```bash
# One-time: create the user CA (ed25519, passphrase-protected). Keep it offline.
ssh-keygen -t ed25519 -f ~/.ssh/ca_user -C "team user CA 2026"

# Sign a user's public key into a certificate.
#   -I  key id shown in logs
#   -n  principals: which accounts this cert may log in as
#   -V  validity window (+8h, +52w, or explicit 20261124:20261201)
ssh-keygen -s ~/.ssh/ca_user \
  -I deepseek@laptop-2026 \
  -n deploy,admin \
  -V +8h \
  ~/.ssh/id_ed25519.pub
# -> writes ~/.ssh/id_ed25519-cert.pub next to the key
```

`ssh` picks up a certificate automatically when it sits next to the private key under the same name plus `-cert.pub`. Inspect it any time with `-L`, which prints the principals, validity and critical options:

```bash
ssh-keygen -L -f ~/.ssh/id_ed25519-cert.pub
# Type: ssh-ed25519-cert-v01@openssh.com user certificate
# Public key: ED25519 ...
# Valid: from 2026-11-24T09:00:00 to 2026-11-24T17:00:00
# Principals: deploy, admin
# Critical Options: (none)
```

To restrict a cert further, add `-O` flags while signing. These are the ones I reach for:

```bash
# only from the office/VPN range, no forwarding, one forced command
ssh-keygen -s ~/.ssh/ca_user -I ci-runner -n deploy -V +1h \
  -O source-address=203.0.113.0/24 \
  -O no-port-forwarding -O no-agent-forwarding \
  -O force-command='/usr/local/bin/backup.sh' \
  ~/.ssh/id_ed25519.pub
```

A certificate is public data — it is safe to paste into a chat, hand to a teammate, or commit to a provisioning repo. Only the CA private key is secret. That single sentence is why certificates scale.

## Trusting the CA on the server: TrustedUserCAKeys

On the server, one line points `sshd` at the CA's *public* key. Any cert signed by that CA is then accepted, subject to its principals and validity:

```sshdconfig
# /etc/ssh/sshd_config
TrustedUserCAKeys /etc/ssh/user_ca.pub

# optional: where per-user allowed principals live
AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u

# optional: put key id and principals in the auth log
LogLevel VERBOSE
```

```bash
# install the CA public key once, on every server, with your config tool
sudo install -m 0644 -o root -g root ~/.ssh/ca_user.pub /etc/ssh/user_ca.pub
sudo sshd -t && sudo systemctl reload sshd
```

The `.pub` certificate is what gets used when the agent holds it. Add the private key and the cert together so the agent offers both:

```bash
eval "$(ssh-agent -s)"
ssh-add -t 8h ~/.ssh/id_ed25519           # picks up the matching -cert.pub
# or be explicit
ssh-add ~/.ssh/id_ed25519 ~/.ssh/id_ed25519-cert.pub
ssh-add -L | head -2                       # the second line is the certificate
```

`AuthorizedPrincipalsFile` is the piece that replaces per-host `authorized_keys` for role control: `deploy` can only get in with a cert that carries the `deploy` principal, while you keep a hand-written `authorized_keys` for the one legacy account that needs it. During migration, `TrustedUserCAKeys` and `authorized_keys` coexist — I have shipped both for months.

## Host certificates: kill the TOFU prompt

The first time you connect to a new server, `ssh` prints a fingerprint and asks you to type `yes`. That is TOFU — trust on first use — and across a fleet it is where you train people to ignore the exact warning that matters. Host certificates remove it: the same CA signs the server's *host* key, and every client that already trusts the CA accepts the connection with no prompt.

```bash
# On the host CA (can live on a build box or your laptop)
ssh-keygen -t ed25519 -f ~/.ssh/ca_host -C "team host CA 2026"

# Sign the server's host key. -h marks it a host certificate;
# -n lists the names clients will use to reach it.
ssh-keygen -s ~/.ssh/ca_host -I web-01 -h \
  -n web-01.example.com,10.0.0.5,web-01 \
  -V +52w \
  /etc/ssh/ssh_host_ed25519_key.pub
# -> /etc/ssh/ssh_host_ed25519_key-cert.pub
```

```sshdconfig
# /etc/ssh/sshd_config
HostKey /etc/ssh/ssh_host_ed25519_key
HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub
```

On every client, one line in `known_hosts` — no per-host entries to chase:

```text
@cert-authority *.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... host-ca
```

Now `ssh web-01.example.com` validates the host key against the CA, including the name it matched. If someone MITMs you with a key that was never signed, the client refuses without asking — which is what the `yes` prompt was always failing to do. Rotating the host's key later is just signing the new key; clients never see a scary-change warning.

## Short-lived credentials for teams

The genuinely transformative part is a short validity window. My default is eight hours for interactive logins and fifteen minutes for automation, because a credential that expires cannot be forgotten:

- **Joiners** get a cert. No step touches fifty servers, because the servers only ever trusted the CA.
- **Leavers** need nothing done to them. Their cert expires; their key is worthless. The offboarding panic disappears.
- **Compromise** is bounded. A stolen laptop yields an 8-hour window, not permanent access — and if you log the key ID, you can see exactly which cert to be angry about.
- **Rotation** becomes automatic: issue, use, expire, repeat. There is nothing to delete.

In practice you stop hand-running `ssh-keygen -s` and put a small signer behind your identity provider: an internal command, a web form, or a CA implementation such as step-ca or Vault. The signer checks who you are, then issues `-V +8h` with the right `-n` principals. The servers never change again.

## Revocation without CRLs

You *can* revoke a certificate, using a **KRL** (key revocation list) generated by `ssh-keygen -k` and referenced from `sshd_config` via `RevokedKeys`. It works, and it is worth knowing, but I reach for it rarely:

```bash
# list what to revoke, then compile a KRL
ssh-keygen -k -f /etc/ssh/revoked_keys \
  -s /etc/ssh/revoked_keys.serial ~/.ssh/to-revoke.pub
```

```sshdconfig
RevokedKeys /etc/ssh/revoked_keys
```

The reason I rarely need it: the KRL has to be pushed to every server, which is the same distribution problem `authorized_keys` had. **Short lifetimes are the revocation mechanism.** If the worst-case window is one workday, "revoke" becomes "wait until 17:00." Reserve the KRL for cases where even that window is unacceptable — an active incident, a lost hardware token — and treat it as an emergency tool, not daily hygiene.

## When plain keys are still fine

Certificates are not a religion. I still use plain keys in several places:

- **A single personal server with one or two of my own devices.** One `authorized_keys` line per laptop, no team, no rotation pressure. The CA is ceremony.
- **The first key on a brand-new box.** You need a way in before you can trust a CA; a raw key is that way in.
- **`authorized_keys` as a migration ramp.** Keeping it alongside `TrustedUserCAKeys` for the legacy account is the pragmatic path, not a failure.
- **Hardware keys with a tiny blast radius.** An `ed25519-sk` key on one laptop for one host needs no expiry to be safe.

The rule I use: reach for a **CA** when the number of *humans times servers* is large enough that you cannot list the access in your head, or when you need a real expiry. Below that threshold the sprawl is cheap and the CA is a new thing to secure — a CA private key is a high-value secret you now have to store, rotate and protect. Do not sign up for that on a single box.

## Closing

**SSH certificates** are not a new protocol; they are an old one that `ssh` has quietly supported the whole time. The migration is three moves: create a CA, point `sshd` at its public key with **`TrustedUserCAKeys`**, and hand out short-lived certs instead of growing a file. Add a **host certificate** and the TOFU prompt goes away too. Once that is done, "who can log in where" is one file you control and one expiry you can read off a log line — a much better place to be than a directory full of `authorized_keys` you have not audited since the last time someone quit.
