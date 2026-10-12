---
title: "What I self-host in 2026: the awin-x self-hosted stack"
description: "The self-hosted stack I actually run in 2026 — one public VPS at the front door, a private overlay network behind it, plus Gitea, log-based analytics, file sync, a password vault and mail — with an honest RAM/effort/sanity note for each, the services I refuse to self-host, and what beginners should skip on day one."
pubDate: 2026-10-15
lang: en
translationKey: what-i-self-host-2026
tags: [self-hosting, homelab, devops, nginx]
featured: true
keywords:
  - what I self-host
  - self-hosted stack 2026
  - homelab
  - self-hosting on a VPS
  - nginx automated TLS
---

People ask what I self-host, and the honest answer is not a list of forty
containers. It is one public VPS at the front door, a private overlay network
behind it, and a handful of services that each earn the RAM they take. This is
the **self-hosted stack** I run in 2026 on what is really a **homelab** of one
box plus a mesh — and, just as important, the short list of things I refuse to
**self-host** even though I could.

The "what I self-host" genre is usually either a dashboard nobody can reproduce
or a manifesto. This is the middle version: what each service is actually for,
roughly what it costs, and whether I would set it up again. No precise version
numbers — those rot within a week. The shape is what matters.

## The shape of the setup: one box at the front, an overlay behind it

The whole design comes down to one rule: **exactly one machine has a public
port.** Everything else is reachable only over a private overlay.

```text
             public internet
                    │  :80 / :443
             ┌──────▼───────┐
             │    TOWER     │   nginx · automatic TLS · many vhosts
             │   (public)   │   systemd units · one IP · one cron
             └──────┬───────┘
                    │  private overlay (EasyTier, 10.144.144.0/24)
        ┌───────────┼──────────────────┐
        ▼           ▼                  ▼
     Gitea      dev box        file-sync / vault
   (git forge)  (editing)       (peers, no public port)
```

TOWER is the only thing on the internet. nginx terminates TLS and routes by
hostname; every application behind it binds to `127.0.0.1`, not `0.0.0.0`. That
one rule is what makes the rest of the stack safe to run: the Git forge, the sync
peers, the password vault — none of them has an open port for a scanner to find.

## What I actually self-host

Each entry gets the same three notes: *why* I run it, roughly what it costs in
RAM and effort, and whether it is *worth it*. Footprints are deliberately vague —
"small", "a few hundred MB" — because yours will differ and mine change with
every restart.

### nginx as the front door, with automatic TLS

One nginx instance terminates TLS and routes by `server_name`. Each site gets its
own file in `sites-available`, enabled with a symlink, so adding a site never
means editing an existing one. Certificates come from ACME (certbot or lego) and
renew on a **systemd timer** — issue on boot, renew twice a day, reload only when
something actually changed.

- **Why:** it is the front door *and* the reverse proxy for every self-hosted
  service. One process, one config format, one place to add headers.
- **Footprint:** tiny — tens of MB, the cheapest thing on the box. Effort is
  front-loaded: an afternoon to learn, then adding a vhost is copy-paste.
- **Worth it?** Yes, unconditionally. This is the least debatable line in the
  whole stack.

The pattern, units included, is in
[self-hosting without Docker](/posts/self-hosting-without-docker/).

### A private overlay instead of open ports

Behind TOWER there is no classic hub-and-spoke VPN. I run a mesh overlay
(EasyTier): a network is a *name* and a *secret*, nodes live on one flat L3
subnet, and each pair tries to punch a direct P2P path, falling back to a relay
only when NAT refuses.

- **Why:** it turns "expose a port and hope" into "join the private network".
  Gitea, the dev box and the sync peers can all talk to each other and to TOWER
  with zero public listeners.
- **Footprint:** small per node; the effort is an afternoon to get it right and
  then it is invisible. The sanity cost is that **the secret is the whole
  perimeter** — leak it and the entire overlay is open, so treat it like an SSH
  key.
- **Worth it?** Yes, and it is what makes the rest of this list low-stress. The
  walk-through lives in
  [building a private mesh VPN with EasyTier](/posts/private-mesh-with-easytier/).

### A self-hosted Git forge

Source control, issues and webhooks live on Gitea, on the overlay — not the
public internet. This is what lets the blog build itself: a push lands, a webhook
fires over the overlay, TOWER pulls and deploys.

- **Why:** I want the repository and the CI trigger inside my trust boundary,
  not on someone else's runner.
- **Footprint:** a couple hundred MB with SQLite, low effort day to day.
- **Worth it?** Yes — but only with a **backup that leaves the box**: the SQLite
  database plus the repositories, dumped and shipped offsite on a timer.

### Analytics that read logs, not people

Instead of a JavaScript tracker I run a small server-side analyzer over the same
nginx access logs. It sees requests, paths, referrers and rough geography, and
nothing about you — no script in the page, no cookie in your browser.

- **Why:** I need one answer — which topic brought a stranger in — and nothing
  more. That answer does not require tracking anyone.
- **Footprint:** megabytes; effort near zero; no cookie banner, ever.
- **Worth it?** Yes. The tradeoff is honesty about what it is: coarse,
  log-shaped, and blind to anything client-side.

### File sync, peer to peer

Syncthing, syncing directly between devices over the overlay with no central
server in the middle — notes, config, screenshots, the occasional large file.

- **Why:** it is the least fussy way I have found to keep a folder identical on
  three machines I own.
- **Footprint:** a couple hundred MB per node; low effort.
- **Worth it?** Yes, with the honest tax: **conflict files.** When two devices
  edit offline, you get a disputed copy, and you have to resolve it like an
  adult instead of pretending it did not happen.

### Password and secret management

A self-hosted, Bitwarden-compatible vault (Vaultwarden) for passwords, plus a
lighter scheme for machine secrets: encrypted with `age`/SOPS and checked into
Git, never a plaintext `.env` in a repository.

- **Why:** my password database should not depend on a vendor account I cannot
  self-host, and my services should not read secrets out of a file that a
  `git add -A` could leak.
- **Footprint:** small for the vault itself, and the effort to *run* it is low —
  the real effort is in backups.
- **Worth it?** Yes, **but only if** you have an encrypted offsite copy and a
  restore you have actually performed. A vault with an untested backup is a trap
  you built yourself.

### Mail: the mailbox, not the reputation

Mail is the one service here I describe cautiously. I self-host IMAP, submission
and webmail for my own domains, with the mailbox itself on the overlay. What I do
**not** self-host is the sending reputation: outbound goes through a relay.

- **Why:** I want my archives and aliases on my own disk. I do not want to fight
  Gmail's spam heuristics with one IP and a weekend.
- **Footprint:** the heaviest item on this list — a few hundred MB of processes
  and disk that only ever grows.
- **Worth it?** Honestly: only if mail is a hobby you enjoy. It is the highest
  effort and the most fragile thing I run, and it is the first thing I would drop.

## The whole stack on one table

| Service | What it does | Rough footprint | Worth it? |
| --- | --- | --- | --- |
| nginx | Front door, TLS, vhost routing | Tens of MB | Yes, always |
| EasyTier overlay | Private L3 mesh, no open ports | Small per node | Yes, foundational |
| Gitea | Git, issues, webhooks | A few hundred MB | Yes, with offsite backup |
| Log analytics | Cookie-less traffic insight | Megabytes | Yes, cheap |
| Syncthing | Peer-to-peer file sync | A few hundred MB | Yes, mind conflicts |
| Vaultwarden | Password vault | Small (plus backups) | Only if you restore-test |
| Mailbox | IMAP/submit/webmail | A few hundred MB | Only if you enjoy it |

## What I deliberately do NOT self-host

Self-hosting is a bet that you can run something more reliably than a paid
service. That bet is good for a blog and a Git forge. It is a *bad* bet for a
specific few things, and naming them is more useful than another tutorial.

- **Authoritative DNS.** Managed, not self-hosted. This is the one that scares
  me: if DNS dies, the whole stack disappears from the internet — the site, the
  mail, the certificate renewals. The correct fix (redundant nameservers in more
  than one place) is exactly what one box cannot do. Do not make your single
  failure domain the thing that resolves everything else.
- **Offsite backups.** The box cannot be its own backup. Follow 3-2-1: three
  copies, two media, one **offsite and not self-hosted**, at a different provider
  with different credentials. A backup on the machine it protects is not a
  backup; it is a copy waiting to die with its original.
- **Outbound mail reputation.** A fresh IP from a VPS provider has no reputation,
  and reputation is not something you can install. My mail goes out through a
  relay; I only own the mailbox.
- **Object storage and a CDN for static assets.** One box has one uplink. Serving
  large static files from wherever the reader happens to be is a solved,
  near-free problem I have no reason to re-solve badly.
- **Anything whose failure mode is a lockout.** A single public identity provider
  for my whole digital life, for example. If it is down or I lock myself out, I
  lose access to the tools I would use to fix it.

The pattern in all five: I self-host things where the worst case is "a service is
down for an evening". I do not self-host things where the worst case is "I
cannot recover, at all".

## What a beginner should not run on day one

If you are starting a **homelab in 2026**, the temptation is to install
everything at once. The services that punish a beginner hardest are predictable:

1. **Mail.** Not on day one, not on day ninety. The receiving side is fussy, the
   sending side is reputation you do not have, and the failure mode is silently
   lost messages.
2. **Anything holding the only copy of irreplaceable data.** Photo archives,
   the password vault, the document store. Get a tested offsite backup *first*,
   then move the data.
3. **An open DNS resolver or an open mail relay.** These are how a quiet weekend
   project becomes an abuse-report generator.
4. **Every admin panel straight onto the internet.** Bind services to loopback,
   or behind the overlay. Not to port 8080 of your public IP.
5. **Ten services before one restore.** A backup you have never restored is a
   wish, not a plan.

Start with the boring pair: **nginx, one static site, and automatic TLS that
actually renews.** Confirm the renewal timer fired. Then add *one* service
behind the overlay, confirm you can back it up, restore it, and only then add the
next.

## The rules I keep on the public box

Two habits, enforced by the OS rather than by memory. First, only the ports that
must be public are public:

```bash
# TOWER: the internet can reach SSH and the web. Nothing else.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
```

Second, every application binds to loopback, and nginx is the only thing facing
the world:

```ini
# /etc/systemd/system/notes-api.service (excerpt)
[Service]
User=svc-notes
Environment=HOST=127.0.0.1
Environment=PORT=9001
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
```

Together, those two rules mean a vulnerability in any service behind nginx is not
automatically a public vulnerability. The rest of the stack — units, timers, lock
files — is in [how this blog ships itself](/posts/how-this-blog-ships-itself/).

## The one-sentence summary

The self-hosted stack works because it is *small and deliberately incomplete*: one
public door, a private network, a set of services I can back up, restore and
explain — and a short list of things I pay someone else to run because their
failure mode is worse than the bill.

If you want the deeper mechanics, the mesh is in
[the EasyTier walk-through](/posts/private-mesh-with-easytier/), the front door
is in [self-hosting without Docker](/posts/self-hosting-without-docker/), and the
pipeline that ties it together is in
[how this blog ships itself](/posts/how-this-blog-ships-itself/).
