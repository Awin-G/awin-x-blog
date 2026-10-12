---
title: "Secrets management for a one-person ops setup: sops, age, LoadCredential"
description: "Practical secrets management for a solo operator: the real threat model (accidental commits, logs, backups, laptop theft, agent access), the tiers from dotenv to an encrypted store, a concrete sops age setup wired to systemd LoadCredential, and pre-commit scanning for rotation and blast radius."
pubDate: 2026-10-29
lang: en
translationKey: secrets-management
tags: [security, self-hosting, devops]
featured: false
keywords:
  - secrets management
  - sops age
  - systemd LoadCredential
  - dotenv
  - secret rotation
---

Every **secrets management** post opens with a diagram of a corporate secrets
vault, an approval workflow and an audit trail. None of that is my problem. I run
one VPS, a couple of self-hosted services, and a build pipeline that I am also
the only reviewer of. My realistic failure mode is not a nation-state exfiltrating
my database password; it is me committing `.env` at 1 a.m., or a backup tarball
quietly carrying a private key to object storage, or an AI agent I pointed at the
repo reading every token it can find. This is the threat model I actually plan
against, and the tiers I use to shrink it — ending with the one win that matters
most: **don't commit them in the first place**.

## The real threat model for a solo operator

Enterprise "secret sprawl" is thousands of secrets across hundreds of teams with
no inventory. Mine is the opposite: a handful of secrets, a single human, and a
lot of automation touching both. That shifts the threats almost completely toward
mistakes rather than malice.

- **Accidental commits.** The classic. A `.env`, an `id_ed25519`, a kubeconfig, a
  token pasted into a config "just to test". Once it is in git history, it is
  public forever — rotating is the only fix, and you must rotate even if you
  `git rm` the file in the next commit. History is not a place secrets die.
- **Logs.** This one bites harder and less obviously. A failing command that
  echoes its arguments, a debug print of `os.environ`, an HTTP client logging the
  `Authorization` header, a CI runner that prints the environment on error.
  Secrets reach logs far more often than they reach git, and logs get shipped,
  rotated into archives, and grepped by accident.
- **Backups.** You backed up `/etc`, `/srv`, and the home directory — which
  included `.netrc`, `.pgpass`, `~/.aws` and a plaintext `.env`. Now your
  encrypted offsite archive is only as strong as its passphrase, sitting next to
  the keys it was supposed to protect. Back up data, config and secrets as three
  different things, and encrypt the secret path explicitly.
- **Laptop theft.** The workstation holds the deploy keys, the SSH agent, the
  browser sessions, the vault unlock. Full-disk encryption is table stakes; the
  real question is what a stolen unlocked laptop (or a `sudo`-happy malware
  process) can reach without a second factor.
- **Agent and tool access.** The new one. A coding agent or shell tool running
  with your environment inherits every exported secret: if it can read the repo,
  it can read `.env`; if it can run commands, it can call any API your tokens
  permit. An agent's blast radius is the union of every credential it can read.

Enterprise tools solve coordination and audit; my problem is containment. Smaller
toolbox, different shape.

## The tiers, from dotenv to a real manager

There is no single right answer, only a ladder. Climb as far as your threat
justifies — not as far as a blog post says.

### Tier 0: hardcoded values and shell history

An API key in source, or `export API_KEY=...` typed at a prompt — which also
lands in `~/.bash_history`. This is where most solo setups live, and the tier to
leave first. `HISTCONTROL=ignoreboth` helps, but habits beat config: never type
the secret, always read it from a file.

### Tier 1: dotenv files with tight permissions

A `.env` read by the app, owned by the service user, mode `600`, and
**gitignored**. For a lot of small services this is genuinely enough.

```bash
# The app reads this at startup; the gitignore keeps it out of history
install -m 600 -o appuser -g appuser /dev/null /etc/myapp/myapp.env
printf 'DATABASE_URL=postgres://app:pw@localhost/myapp\n' \
  | sudo tee /etc/myapp/myapp.env >/dev/null
sudo chmod 600 /etc/myapp/myapp.env

# Prove it: no world/group read, and it is not tracked by git
sudo stat -c '%A %U:%G %n' /etc/myapp/myapp.env
git check-ignore -v /etc/myapp/myapp.env 2>/dev/null || true
```

The catch with **dotenv** is everything downstream of the file: `.env` files get
committed by mistake, copied into images, read by tools that also print them, and
inherited by every child process. `600` stops other users on the box, not your
own process tree. Which is exactly why the next tier exists.

### Tier 2: an encrypted file (sops + age)

Encrypt the secret at rest so the file is safe to commit or back up. **sops age**
is my default now: `age` gives you a tiny, modern keypair, and `sops` encrypts
only the *values* in a YAML/JSON/ENV file while leaving the keys readable, so
diffs stay sane and you can still see structure in git.

### Tier 3: a real manager (Vaultwarden, Bitwarden, Vault)

When you have more than a few services, other humans, or rotation that must be
enforced, use a real store. **Vaultwarden** (a lightweight Bitwarden server) is
the sweet spot for one person: a web UI, mobile clients and a CLI for the
human-facing secrets you occasionally read. It is not a daemon's runtime backend —
that is what SOPS files and systemd credentials are for. Vault for humans,
encrypted files for machines.

## A concrete setup: sops age plus systemd LoadCredential

Here is the setup I actually run. The secret lives encrypted in git, decrypted at
deploy time, and is handed to the service through the kernel — never through a
world-readable unit file and never through shell history.

First, the encrypted source of truth:

```bash
# One-time: create an age keypair; the private key stays off the server
age-keygen -o ~/.config/sops/age/keys.txt
# -> public key: age1qz...

# Encrypt a secrets file. Values are encrypted, keys stay visible.
sops --encrypt --age age1qz... \
  --encrypted-regex '^(data|stringData|.*token.*|.*password.*|.*key.*)$' \
  myapp.secrets.yaml > myapp.secrets.enc.yaml

# Edit later through the same envelope; never a plaintext copy on disk
sops myapp.secrets.enc.yaml
```

Then wire it to the daemon with **systemd LoadCredential**. This is the part that
ends the "secrets sit in a world-readable unit" problem: `LoadCredential=` places
the file in a root-owned, per-service runtime directory that only the service can
read, and exposes the path in `$CREDENTIALS_DIRECTORY`.

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=My app
After=network-online.target

[Service]
Type=simple
User=appuser
# ExecStartPre decrypts sops -> a 0600 file in a tmpfs dir, then systemd
# copies it into the credential dir and the plaintext copy is removed.
ExecStartPre=+/usr/local/bin/sops-exec-secret myapp
ExecStart=/usr/local/bin/myapp
# systemd only hands the service a path; the value is not in the unit or env
LoadCredential=database-url:/run/credentials-seed/myapp/database-url
# Lock it down so a compromised service cannot see the rest of the box
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/myapp
```

The app then reads `$CREDENTIALS_DIRECTORY/database-url` at startup instead of
`process.env`. There is no exported variable for an agent or a log line to catch,
and the unit file in git contains a path, not a password. This is the whole point
of the tier: the secret exists in cleartext only inside the running process.

## Rotation and blast radius

Two numbers decide how much a leak costs you: how long the secret lives, and how
much it can do. You control both.

- **Rotation** is only real if it is cheap. If rotating a database password means
  editing five services by hand, you will never do it — write the rotation as a
  script, store the new value through `sops`, and redeploy. Prefer credentials you
  can mint and revoke on demand (short-lived tokens, per-service database users)
  over one immortal root password.
- **Blast radius** is what a single stolen credential can touch. A token scoped to
  one bucket and read-only is a bad day; a personal access token with `repo` and
  `admin:org` is an incident. Give every service its own identity, the narrowest
  scope that works, and never reuse your human account's credentials for a daemon.

A useful habit: after you create any secret, ask "if this leaks tonight, what do I
do tomorrow?" If the answer is more than "revoke it and rotate," the scope is too
wide.

## Keeping secrets out of git: pre-commit scanning

Assume a secret will eventually be staged and pretend the only defense is a gate
before it lands. A **pre-commit** hook that scans for high-entropy strings and
known key formats is cheap and catches the mistake at the one moment it is still
free to fix.

```bash
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
```

```bash
pre-commit install            # wire the hook into this clone
pre-commit run --all-files    # scan the whole tree once, on purpose
git check-ignore -v .env      # confirm your ignore rules actually match
```

Two caveats. Scanners miss secrets that do not look like secrets (a bare password
in a YAML value), so pair the hook with a `gitignore` covering `.env*`, `*.pem`,
`*.key`, `id_*` and `*.secrets.yaml` by default. And they cannot help with a
secret that is already pushed: once history has it, the only correct response is
to **rotate** — rewriting history is cleanup, rotation is the fix.

This is also where the ops discipline from [hardening a public server](/posts/hardening-a-public-server/)
pays off: a box where only one named user can read `/etc/myapp` and where the
firewall is default-deny makes a leaked credential much less useful to whoever
holds it.

## Match the tool to the threat (and start with the cheap win)

The honest summary, after running all of this for a while:

- **The first win is simply not committing secrets.** Every tier below that —
  encryption, credentials, a manager — only matters after the file is out of
  plaintext git. Gitignore and a pre-commit scanner get you 80% of the way for
  almost no effort.
- **Then stop the leak paths you forgot about:** logs, backups, `ps` output,
  shell history, and environment variables inherited by agents. Encrypt backups,
  and prefer a credential file over an env var.
- **Then tighten blast radius:** per-service users, narrow tokens, cheap rotation.
- **Only then add the heavy tooling.** A real manager, a policy engine, an audit
  trail. If your threat model is "one person and a few services," SOPS+age and
  systemd credentials will hold for years. If it is "a team, compliance, humans
  sharing secrets," pay for the vault — and remember that no tool compensates for
  committing a secret you then never rotate.

Programs do not fail because the vault was the wrong brand. They fail because a
`.env` got committed, nobody rotated it, and the token was still valid nine months
later. Start with the boring wall: keep secrets out of git, out of logs, and out
of the environment. Everything else is hardening on top of that.

For the surrounding picture, my [self-hosting without Docker](/posts/self-hosting-without-docker/)
post covers how these services are laid out in the first place — a smaller,
simpler surface is the cheapest risk reduction there is.