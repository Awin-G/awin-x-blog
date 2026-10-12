---
title: "Running your own Git server properly: Gitea and Forgejo in production"
description: "When a self-hosted Git server earns its keep, when a hosted forge is fine, and how to run Gitea or Forgejo without the sharp edges: install options, SSH vs HTTPS clone URLs, reverse proxy and TLS, webhook reachability, mail, upgrades, and a backup you have actually restored."
pubDate: 2026-12-01
lang: en
translationKey: self-hosted-git
tags: [self-hosting, devops, nginx]
featured: true
keywords:
  - self-hosted Git
  - Gitea
  - Forgejo
  - git server
  - reverse proxy
  - backup
  - webhook
---

I moved my repositories onto a **self-hosted Git** server years ago and never went
back. Not because GitHub is evil, but because I wanted to stop renting the one
place where all my work lives. This is the version of that decision I would make
again: what a **Gitea** or **Forgejo** box actually buys you, when a hosted forge
is the smarter call, and — the part most posts skip — the half-dozen things that
bite you *after* `git push` works the first time.

A **git server** is not a hard service. It is a web app, a database, and a
directory of bare repositories. The hard part is everything around it: certificates,
proxy headers, reachable webhooks, mail, and a restore you have rehearsed. Get
those right and it is one of the calmest things you will ever run.

## When self-hosted Git actually makes sense

Self-hosting a forge is not a purity test. It pays off in four concrete situations:

- **Privacy and data residency.** Your code, issues, and CI logs sit on a machine
  you control, in a jurisdiction you chose. For client work under NDA, or anything
  with credentials baked into history, that is the whole argument.
- **No rate limits, no surprise bills.** CI minutes, LFS bandwidth, API calls and
  "you have exceeded your Actions quota" emails all stop existing. Your runner
  builds as long as your CPU is warm.
- **CI and hooks on your terms.** A runner on the same box as the database can
  talk to internal services directly. Need a webhook that hits a private
  LAN address? On a hosted forge that is a firewall problem you cannot solve.
- **Control over the lifecycle.** Features you depend on never get deprecated out
  from under you, and you decide when an upgrade happens. Forgejo is a good
  argument for this by itself: it is a community fork of Gitea under a foundation,
  so the governance story is different.

## When a hosted forge is fine (and better)

Be honest about the trade. A hosted forge gives you, for free, a team of people
whose only job is uptime, an off-site copy of your code, and zero patching. Choose
it without guilt when:

- You are a solo developer with a handful of public repos and no secrets in them.
- You would not actually test your own backups — an untested self-hosted backup is
  *worse* than a hosted one, because it feels like safety.
- You have no second machine. A forge on the only box you own is one disk failure
  from a very bad week.
- You value contributors more than control — the network effect of a big forge is
  real for open source.

My rule: run both. Mirror the important repos to a self-hosted forge for
ownership, and keep a public mirror where the people are. If you want the
one-person workflow that goes with this, read
[Git workflows for a solo developer](/posts/git-for-solo-developers/).

## Install options: pick one and move on

There are three sane ways to install Gitea or Forgejo. They are all fine; mixing
them is what causes trouble.

### Binary + systemd

The official static binary is one file and has no runtime dependencies beyond a
database. This is my default on a plain VPS.

```bash
# As an unprivileged user; the binary is self-contained.
sudo useradd --system --home /var/lib/gitea --shell /usr/sbin/nologin git
sudo install -o git -g git -m 0750 -d /var/lib/gitea/{data,log,custom,conf}
curl -L -o /tmp/gitea \
  https://dl.gitea.com/gitea/1.22.6/gitea-1.22.6-linux-amd64
sudo install -o git -g git -m 0755 /tmp/gitea /usr/local/bin/gitea
```

A unit that keeps it alive and restarts it when it dies:

```ini
# /etc/systemd/system/gitea.service
[Unit]
Description=Gitea
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=git
Group=git
WorkingDirectory=/var/lib/gitea
ExecStart=/usr/local/bin/gitea web --config /var/lib/gitea/conf/app.ini
Restart=on-failure
RestartSec=5
Environment=USER=git HOME=/var/lib/gitea
# Keep the web app from fighting the kernel for RAM.
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### Container

If you already run containers, the image is the least-effort path. Bind-mount the
data and config, and never let the database live inside the container's writable
layer.

```yaml
# compose.yaml — the database and repos are on named volumes, not the layer.
services:
  gitea:
    image: gitea/gitea:1.22
    restart: unless-stopped
    environment:
      - GITEA__database__DB_TYPE=postgres
      - GITEA__database__HOST=db:5432
      - GITEA__server__SSH_PORT=2222
      - GITEA__server__DOMAIN=git.example.com
      - GITEA__server__ROOT_URL=https://git.example.com/
    volumes:
      - ./data:/data
      - ./config:/etc/gitea
    ports: ["127.0.0.1:3000:3000", "2222:22"]
    depends_on: [db]
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      POSTGRES_USER: gitea
      POSTGRES_DB: gitea
volumes: { pgdata: {} }
```

### Package

On Debian/Ubuntu, `apt install gitea` (from the upstream repo) or Forgejo's own
packages give you a hardened unit, a system user, and config in `/etc/gitea`.
Great when a distro you already trust is doing the upgrade path for you. Whichever
you choose: **one** installation per host, and one database. Two half-configured
installs sharing a data directory is a support ticket you wrote for yourself.

<figure>
<svg viewBox="0 0 640 220" width="100%" role="img" aria-label="Traffic flow: browsers and git clients reach nginx over 443 and 22, nginx proxies to the Gitea web app on localhost, and Gitea talks to PostgreSQL and the on-disk repositories.">
  <g fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.7">
    <rect x="16" y="70" width="120" height="80" rx="10"/>
    <rect x="200" y="70" width="130" height="80" rx="10"/>
    <rect x="392" y="20" width="150" height="64" rx="10"/>
    <rect x="392" y="136" width="150" height="64" rx="10"/>
    <path d="M136 96 H200"/><path d="M136 128 H200"/>
    <path d="M330 96 H392"/><path d="M330 128 H392"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="30" y="108">browser + git</text><text x="30" y="126">clients</text>
    <text x="214" y="100">nginx</text><text x="214" y="118" opacity="0.75">:443 / :22 TLS</text>
    <text x="406" y="46">Gitea web app</text><text x="406" y="64" opacity="0.75">127.0.0.1:3000</text>
    <text x="406" y="162">PostgreSQL</text><text x="406" y="180" opacity="0.75">repos on disk</text>
  </g>
</svg>
<figcaption>The only ports exposed to the world are nginx's. Gitea and the database
stay on loopback.</figcaption>
</figure>

## The things that bite after the first push

### Back up the database *and* the repositories

The repositories are files on disk; the *metadata* — users, issues, pull requests,
webhooks, tokens — lives in the database. A backup that grabs only `repositories/`
restores a forge that runs but remembers nobody. A backup that grabs only the
database restores a forge full of empty projects. You need both, consistently.

### SSH vs HTTPS clone URLs

Gitea exposes SSH on its own port (often `2222`), while your system SSH is on
`22`. Set `SSH_PORT` and a `SSH_DOMAIN`, or every clone URL you print will be
wrong:

```ini
# /var/lib/gitea/conf/app.ini
[server]
DOMAIN           = git.example.com
ROOT_URL         = https://git.example.com/
SSH_DOMAIN       = git.example.com
SSH_PORT         = 2222          ; the container/app port, not nginx
START_SSH_SERVER = false         ; false = use the host sshd, which is better
HTTP_PORT        = 3000
```

With `START_SSH_SERVER = false` the app relies on the host's `sshd` and the `git`
user. That means the `git` account needs a shell (`git-shell`) and its keys, and
the firewall must actually open `2222`. HTTPS clone URLs, meanwhile, are the
easiest for CI and for people behind corporate firewalls — support both, and test
both. A clone URL is a promise; make sure it resolves.

### Reverse proxy and certificate

Terminate TLS at nginx and pass the real host and scheme through, or Gitea will
generate `http://` links and break webhooks and OAuth redirects:

```nginx
# /etc/nginx/sites-available/git.example.com
server {
    listen 443 ssl http2;
    server_name git.example.com;

    ssl_certificate     /etc/letsencrypt/live/git.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/git.example.com/privkey.pem;

    client_max_body_size 512M;      # otherwise large pushes 413
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For the certificate, run `certbot --nginx -d git.example.com` and let it renew on
a timer. The one gotcha: renewals reload nginx, so make sure the reload actually
succeeds in a test, not at 3 a.m. in the middle of a deploy.

### Webhook reachability

Webhooks fail silently, and that is the problem. Two things break most of them:

- **The URL is unreachable from the Gitea container.** `localhost` from inside a
  container is the container, not your CI host. Use a real name or the LAN IP.
- **Private IPs are blocked.** Gitea refuses to deliver to `127.0.0.1` and `10.0.0.0/8`
  by default to stop SSRF. If your CI runner really is on the LAN, allow exactly
  that range in `[webhook]` and nothing wider.

```ini
[webhook]
ALLOWED_HOST_LIST = private, git.example.com, 127.0.0.1
```

Then watch deliveries in **Repo → Settings → Webhooks → Recent Deliveries**. If
you cannot see the request there, no amount of guessing at your CI will help. Test
webhooks before you need them, and have Gitea notify on failure.

### Mail for notifications

Password resets, new-user confirmations and issue notifications all go through the
forge's mailer. Get it out of the "no mail configured" state on day one:

```ini
[mailer]
ENABLED  = true
PROTOCOL = smtp+starttls
SMTP_ADDR = smtp.example.com
SMTP_PORT = 587
FROM     = forge@example.com
USER     = forge@example.com
PASSWD   = __use_a_secret_store__
```

Use a dedicated SMTP relay with a real reputation; a transactional provider is
fine and beats running your own MTA. If mail silently disappears into a spam
folder, users assume the forge is broken.

## Auth: local users, OAuth, and SSH keys

Start with local users for the first two accounts, then decide deliberately:

- **Local users** are simplest and work offline. Good for a small team; annoying
  the moment you have more than a handful of people.
- **OAuth / OIDC** (via an identity provider) means you never manage passwords,
  and disabling someone centrally actually disables them. Worth it as soon as
  there is more than one human.
- **SSH keys** are for humans pushing code; **deploy keys** are read-only (or
  single-repo write) keys for servers and CI. Never reuse a personal key as a
  deploy key, and never give a deploy key more scope than one repository.

Disable open registration (`DISABLE_REGISTRATION = true`) once your own accounts
exist, and turn off password login for anyone who can use a key. An open
registration page on a public forge is an invitation.

## Running it on a small box

Gitea/Forgejo is genuinely light: a **1 vCPU / 1 GB** instance comfortably serves
a small team. If you run your own CI runner on the same host, go to 2 GB, or your
builds will OOM the forge itself. A few concrete knobs:

- Keep the database local, on SSD, and back it up — do not put it on NFS.
- Set `LFS_JWT_SECRET` and a real `SECRET_KEY` in `app.ini` so sessions survive
  restarts and signed URLs stay valid.
- Let git do the work: `gc` and packfiles are handled, but turn on the built-in
  housekeeping so large repos get `git gc` on a schedule.
- Watch disk: repositories grow quietly, and LFS objects grow loudly.

For the server-side fundamentals — firewall, unattended upgrades, log rotation —
my [self-hosting without Docker](/posts/self-hosting-without-docker/) guide is the
companion to this post.

## Upgrades: read the migration notes

Never skip upgrade notes, and never cross a major version blind. Gitea and Forgejo
both run database migrations on startup, and they are one-way. The safe ritual:

```bash
# 1. Back up first (see below). A migration with no backup is gambling.
# 2. Stop, replace the binary, start, watch the log for migration errors.
sudo systemctl stop gitea
sudo install -o git -g git -m 0755 /tmp/gitea-1.23.0-linux-amd64 /usr/local/bin/gitea
sudo -u git /usr/local/bin/gitea --version
sudo systemctl start gitea
sudo journalctl -u gitea -f     # read it; do not just check "active"
```

Read the release notes for the version you are moving *to* and every version in
between for `[security]`, config renames, and "migration requires". Do it on a
staging copy of the database first if you can. Because migrations are one-way,
the rollback is *the backup*, not the old binary.

## A backup and restore that actually works

Back up the database, the repositories, and the config — together, on a timer,
with verification. This is the short version; the full discipline is in
[a backup you can restore](/posts/backups-you-can-restore/).

```bash
#!/usr/bin/env bash
# /usr/local/bin/backup-gitea.sh — run from a systemd timer as root.
set -euo pipefail
DEST=/srv/backup/gitea/$(date +%F)
install -d -m 0700 "$DEST"

# 1. Database dump (Postgres). Use --clean so it restores over an existing DB.
sudo -u postgres pg_dump --clean --if-exists gitea | gzip > "$DEST/gitea.sql.gz"

# 2. Config and secrets (app.ini holds DB creds and JWT secrets).
tar -czf "$DEST/conf.tar.gz" -C /var/lib/gitea conf custom

# 3. Repositories + LFS + attachments. Stop writes or use a snapshot for this.
sudo -u git tar -czf "$DEST/data.tar.gz" \
  -C /var/lib/gitea data/repositories data/lfs data/attachments

# 4. Verify: non-empty, and the dump at least lists tables.
test -s "$DEST/gitea.sql.gz" && test -s "$DEST/data.tar.gz"
zcat "$DEST/gitea.sql.gz" | grep -q 'CREATE TABLE'
echo "backup ok: $DEST"
```

Restore is the part that proves it. On the target box:

```bash
sudo systemctl stop gitea
sudo -u postgres createdb gitea                      # fresh, empty
zcat "$DEST/gitea.sql.gz" | sudo -u postgres psql -d gitea
sudo tar -xzf "$DEST/conf.tar.gz" -C /var/lib/gitea  # app.ini back in place
sudo tar -xzf "$DEST/data.tar.gz" -C /var/lib/gitea  # repos, lfs, attachments
sudo chown -R git:git /var/lib/gitea
sudo systemctl start gitea
```

Do this drill on a throwaway VM at least once a quarter. The night you need it is
the wrong night to discover the `git` user cannot read its own data directory.

## The honest summary

A self-hosted forge is one web app, one database, and a folder of bare repos. The
service is easy; the operations around it — TLS, proxy headers, reachable
webhooks, mail, one-way migrations, and a rehearsed restore — are the actual work.
Get those right, run both a self-hosted forge and a public mirror, and you own
your code without it owning your evenings.
