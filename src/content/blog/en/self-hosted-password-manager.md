---
title: "Self-hosting a password manager with Vaultwarden: a security-first guide"
description: "A security-first guide to running a self-hosted password manager: why to own your password vault and the responsibility it brings, Vaultwarden vs KeePassXC, a safe deployment (HTTPS, reverse proxy, admin token, no signups, backups, 2FA), an honest threat model, and disaster recovery."
pubDate: 2026-12-02
lang: en
translationKey: self-hosted-password-manager
tags: [self-hosting, security, devops]
featured: false
keywords:
  - self-hosted password manager
  - Vaultwarden
  - Bitwarden
  - password vault
  - end-to-end encryption
---

A **self-hosted password manager** is the one piece of self-hosting where the
stakes are not "my blog is down for an hour" but "someone now has every credential
I own." That is exactly why I think it is worth doing — and exactly why it deserves
more care than the average `docker compose up`. This guide is how I run my own
**password vault**: **Vaultwarden** as a lightweight, Bitwarden-compatible server,
with the security posture I would want if a stranger were reading over my shoulder.

## Why self-host a password manager (and the responsibility you take on)

The case for self-hosting is straightforward. **Control:** the vault lives on
hardware I own, in a jurisdiction I chose, on a disk I can inspect. **No
subscription:** Bitwarden's cloud is cheap and good, but "free forever, on my box"
beats "free until the pricing page changes." **Offline access:** my devices hold a
full encrypted copy, so a dead internet connection or a dead server does not lock
me out of my own logins.

That last point is the whole architecture, so internalize it now: a good self-hosted
**password vault** is *not* a web service you depend on. It is a sync service for
encrypted blobs that already live on your devices. The server is a convenience, not
the source of truth.

And here is the responsibility, stated without decoration. When you move to a
**self-hosted password manager**, *you* become the custodian of the crown jewels.
A vendor has a security team, an on-call rotation and a breach-response plan. You
have a VPS, a compose file, and a backup script you wrote on a Tuesday. If your
server is compromised and your vault is exfiltrated, the blast radius is your email,
your bank, your domain registrar, and every account that resets via those. That is
a real trade, and you should make it with your eyes open.

## The options: Vaultwarden, KeePassXC + sync, and friends

There are two philosophies here, and picking one is the real decision.

- **Vaultwarden** (formerly bitwarden_rs) is a community, Rust reimplementation of
  the Bitwarden server API. It speaks the Bitwarden protocol, so it works with the
  official **Bitwarden** browser extensions, desktop apps and mobile apps — you
  just point them at your own URL. It is a single binary in one container, backed
  by SQLite or Postgres, and idles in tens of megabytes of RAM. That is the appeal:
  real clients, tiny server, no vendor account.
- **KeePassXC + sync** is the no-server alternative. Your vault is a single
  encrypted `.kdbx` file; KeePassXC opens it locally. "Sync" is whatever you
  already trust to move a file around — Syncthing, a git repo, a cloud drive. There
  is no server to breach because there is no server. The cost is clunkier sharing
  and the risk of file-conflict merges if two devices edit at once.
- **Others** in the same family: **Bitwarden** itself (self-hostable via the
  official `bitwarden/server`, but far heavier — ~2 GB of RAM, multiple services
  and MSSQL — which is why Vaultwarden exists), **Padloc**, **Passbolt** (team-first,
  GPG-based), and plain **age**/`gpg` encrypted files if you are a masochist. The
  `secrets-management` post I linked covers the file-based tier for machine
  secrets; a password manager is for *human* logins.

If you want the official clients with the smallest possible server, Vaultwarden is
the pragmatic default. If you want zero network attack surface, KeePassXC wins.
Everything below assumes Vaultwarden, but the backup and threat-model reasoning
applies to both.

## The vault is end-to-end encrypted — understand that first

<figure>
<svg viewBox="0 0 640 250" width="100%" role="img" aria-label="Client encrypts the vault with a key derived from the master password; the server only ever stores ciphertext; devices decrypt locally.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="16" y="26" width="180" height="198" rx="10"/>
    <rect x="444" y="26" width="180" height="198" rx="10"/>
    <rect x="252" y="70" width="136" height="110" rx="10"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="106" y="50" font-size="14" font-weight="600">your device</text>
    <text x="106" y="78">master password + 2FA</text>
    <text x="106" y="102">key derived locally (KDF)</text>
    <text x="106" y="126">vault decrypted here</text>
    <text x="106" y="160" font-weight="600">plaintext never leaves</text>
    <text x="320" y="94" font-size="14" font-weight="600">your server</text>
    <text x="320" y="120">store ciphertext only</text>
    <text x="320" y="144">sync + attachments</text>
    <text x="534" y="50" font-size="14" font-weight="600">other device</text>
    <text x="534" y="78">same master password</text>
    <text x="534" y="102">decrypts locally</text>
    <text x="534" y="126">no server can read</text>
    <text x="534" y="160" font-weight="600">sees only ciphertext</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" marker-end="url(#a)">
    <line x1="196" y1="120" x2="250" y2="120"/>
    <line x1="388" y1="120" x2="442" y2="120"/>
  </g>
  <defs>
    <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6" fill="none" stroke="currentColor" stroke-width="1.5"/>
    </marker>
  </defs>
</svg>
<figcaption>Your master password derives the vault key on the client. The server only
ever holds ciphertext, so a database dump is not a plaintext vault.</figcaption>
</figure>

**End-to-end encryption** is the reason self-hosting a vault is survivable at all.
The client derives the vault key from your master password (via a KDF) and does all
the cryptography locally. What lands in the server's database is ciphertext. That
does not make the server unimportant — a compromised server can still serve you a
malicious web vault, tamper with client updates, or leak metadata — but it means the
worst-case "database is stolen" is not automatically "all my passwords are public."
Hold onto that, because it shapes everything in the threat model below.

## A safe Vaultwarden deployment

The order of operations matters: terminate TLS at a reverse proxy, keep the container
off the public network, and turn on every gate the project gives you.

### 1. HTTPS is mandatory, not optional

Never expose Vaultwarden over plain HTTP. The web vault and the API both depend on a
secure origin, and browsers will refuse to use the crypto APIs otherwise. Terminate
TLS at a reverse proxy — Caddy gets you certificates automatically:

```Caddyfile
# Caddyfile — vault.example.com behind automatic HTTPS
vault.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

If you prefer nginx, the shape is the same: a `server` block with a valid
certificate, `proxy_pass http://127.0.0.1:8080;`, and the usual forwarding headers.
The container itself should bind to loopback only — never publish port 8080 to the
world.

### 2. The compose file

```yaml
# docker-compose.yml — Vaultwarden, loopback only, data outside the container
services:
  vaultwarden:
    image: vaultwarden/server:latest
    container_name: vaultwarden
    restart: unless-stopped
    environment:
      DOMAIN: "https://vault.example.com"
      SIGNUPS_ALLOWED: "false"          # no public registration
      INVITATIONS_ALLOWED: "false"
      ADMIN_TOKEN: "${VW_ADMIN_TOKEN}"  # long random value, argon2 hashed
      WEBSOCKET_ENABLED: "true"
      # SMTP omitted for brevity — needed for email 2FA and invites
    volumes:
      - ./vw-data:/data               # the encrypted DB lives here
    ports:
      - "127.0.0.1:8080:80"           # never 0.0.0.0
```

Three settings carry their weight. **`SIGNUPS_ALLOWED: "false"`** closes the door
after you create your one account — an open registration endpoint on a password
server is an invitation. **`ADMIN_TOKEN`** must be a long random string; Vaultwarden
hashes it with Argon2 on startup, so a weak token is the one thing standing between
an attacker and the admin panel. **`DOMAIN`** must be the real HTTPS URL or clients
will authenticate against the wrong origin.

### 3. Backups of the encrypted database

The `/data` directory *is* your server's state: the SQLite database, the RSA keys,
attachments, and configuration. Back it up on a schedule and encrypt the backup in
flight. A Vaultwarden-aware backup must quiesce the DB first:

```bash
#!/usr/bin/env bash
# /usr/local/bin/vw-backup.sh — consistent, encrypted Vaultwarden backup
set -euo pipefail
DEST=/srv/backups/vaultwarden
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$DEST"

# Use the built-in SQLite dump so the copy is transactionally consistent.
docker exec vaultwarden sqlite3 /data/db.sqlite3 ".backup '/data/db.backup'"
docker cp vaultwarden:/data/db.backup "$DEST/db-$STAMP.sqlite3"
rm -f "$DEST"/*.backup

# Encrypt immediately — never let a plaintext DB touch offsite storage.
tar -C "$DEST" -czf - "db-$STAMP.sqlite3" \
  | age -r "$(cat /etc/vaultwarden-backup.pub)" \
  > "$DEST/db-$STAMP.tar.gz.age"
rm -f "$DEST/db-$STAMP.sqlite3"
```

A systemd timer fires it nightly, and a second job ships the `.age` files offsite:

```ini
# /etc/systemd/system/vw-backup.timer
[Unit]
Description=Nightly Vaultwarden backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Test the restore, not just the backup. A vault you cannot restore is not a backup —
the [backups you can restore](/posts/backups-you-can-restore/) post is the discipline
that matters here, and encrypting the data at rest is covered in
[encryption at rest](/posts/encryption-at-rest/). For how I handle machine secrets
around this stack, see [secrets management](/posts/secrets-management/).

### 4. Two-factor authentication on the account

Turn on 2FA for your own account and keep a way back in. WebAuthn/FIDO2 or a TOTP
app is fine; store the **recovery code offline**. Vaultwarden's email 2FA needs a
working SMTP relay, which is its own tarpit — a TOTP app avoids that dependency
entirely. The point is that your master password alone should never be enough to
reach the vault.

## The threat model, honestly

Two very different attacks get flattened into "self-hosting is risky." Keep them
separate.

- **A compromised server.** If someone roots the box, they can read the SQLite
  database — but it is ciphertext, so they get metadata (usernames, sync times,
  counts) rather than passwords. They can, however, serve a tampered **web vault**:
  the web vault is JavaScript you download and execute in your browser, which makes
  it an XSS surface. An attacker who controls the server can inject script that
  steals the vault *after you decrypt it*. This is why I treat the browser web vault
  as a convenience and the native apps as the trusted path — and why "an attacker
  owns the server" is never fully safe for a web-delivered client.
- **A compromised client.** The real crown-jewel event. Malware on an unlocked
  laptop, a keylogger, a malicious browser extension — any of these can read the
  vault once it is open, because that is where the plaintext lives by definition.
  E2E encryption does nothing against a compromised endpoint; a good master password
  and a locked vault (short auto-lock, lock on sleep) are your only defenses.

The honest summary: **the encrypted DB makes a stolen server survivable; nothing
makes a stolen device survivable.** Size your effort accordingly. Generate the
master password with high entropy and never reuse it, because it is the single key
that unlocks everything downstream.

## Client setup

Point the **Bitwarden** clients at your server and let the sync do the rest:

1. Install the official Bitwarden extension and desktop/mobile apps.
2. On the login screen, open the gear/region selector and choose **Self-hosted**,
   then enter `https://vault.example.com`. Set the same server on every device so
   the accounts line up.
3. Log in with your email and master password, complete 2FA, and let the first sync
   pull the vault down. Confirm the vault opens offline with airplane mode on.
4. Set a short auto-lock timeout and lock-on-sleep. Keep the vault locked when you
   are not using it.

## Disaster recovery: when the server dies

This is the part people skip, and it is where self-hosting actually pays off. Your
devices hold a full encrypted copy of the vault. If the VPS disappears tomorrow:

- **You still have your passwords.** Open Bitwarden (or KeePassXC) in airplane mode
  and the vault unlocks from local storage. You have lost *sync*, not *access*.
- **Export before you rebuild.** From an unlocked client, export the vault
  (encrypted JSON or `.kdbx`) and keep it somewhere safe before you touch the
  server — never rely on the dying box.
- **Rebuild from the backup.** Restore `db-<stamp>.sqlite3` into a fresh container's
  `/data`, start it with the same `DOMAIN`, and your clients re-sync. Rotate the
  admin token and the RSA keys if you suspect the old host was compromised.
- **The last resort.** If *everything* — server and devices — is gone, the only way
  back into a Bitwarden vault is the master password and the **emergency export** you
  kept offline. If you have neither, the vault is, by design, unrecoverable.

That asymmetry is the whole deal: the encryption that makes your vault safe from
your server is also the encryption that makes it safe from *you* if you lose every
copy of the key. Keep the vault on your devices, keep an offline export, keep an
offline copy of the backup and the recovery code, and a dead server is an
inconvenience instead of a catastrophe.

## The bottom line

A **self-hosted password manager** is worth running if you accept the custody that
comes with it. Pick **Vaultwarden** for real Bitwarden clients on a tiny server, or
**KeePassXC + sync** if you would rather have no server at all. Terminate HTTPS at a
reverse proxy, disable signups, set a strong admin token, turn on 2FA, and back up
the encrypted database on a schedule you have actually tested a restore from. Then
trust the architecture: the vault is **end-to-end encrypted**, the server holds
ciphertext, and your devices are the real copy. Guard the master password like the
single point of failure it is, and self-hosting your passwords stops being reckless
and starts being the responsible default.
