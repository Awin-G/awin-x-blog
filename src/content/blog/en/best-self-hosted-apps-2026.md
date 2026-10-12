---
title: "The best self-hosted apps I actually recommend in 2026 (and what to skip)"
description: "The self-hosted software I actually recommend in 2026: one app per job — Vaultwarden, Gitea, Syncthing, Jellyfin and more — each with a one-line why, a rough footprint note, and what it replaces, plus the self-hosting tools that are overhyped and the rule for choosing well."
pubDate: 2026-10-24
lang: en
translationKey: best-self-hosted-apps-2026
tags: [self-hosting, homelab, devops]
featured: true
keywords:
  - best self-hosted apps
  - self-hosted software 2026
  - self-hosting
  - self-hosted alternatives
  - homelab
---

Every few months the internet produces another "200 best self-hosted apps"
list, and every one of them is a trap. They are lists of *installable* software,
not *runnable* software, and the difference is a weekend you never get back.
This is the other list: the **best self-hosted apps** I actually recommend in
2026, grouped by the job they do and capped at **one pick per job** — and, just
as useful, the **self-hosting** projects I would tell you to skip. No version
numbers. No forty-container dashboard. No hype.

Two disclaimers, because they matter. First, every footprint note here is
qualitative on purpose — "tiny", "a few hundred MB" — because exact memory use
depends on your instance: your database, your data size, how many people log in,
whether you transcode. Anyone quoting you a precise RAM figure for *your* homelab
is guessing. Second, the picks are vendor-neutral: this is what I would run, not
what pays me.

## The best self-hosted apps in 2026, judged by one rule

I have a single rule for whether an app earns a permanent slot: **can I back it
up, upgrade it, and explain it in one sentence?** If any of those three is hard,
the app is not ready for *my* box, no matter how good the demo is.

From that rule, three preferences fall out:

- **One job per service.** A tool that does six things is a tool whose failure
  takes out six things. I would rather run four small processes than one large
  platform.
- **Boring storage.** SQLite or plain files on disk beat a database cluster I
  have to operate. The data must be readable without the app.
- **A single binary or a small dependency tree.** If installing it means owning a
  build pipeline, I have already lost.

This is not a personality. It is the difference between a homelab you maintain
and a homelab that maintains you.

## Self-hosted software 2026: one pick per job

Each entry is one tool, one line on *why*, a rough *footprint*, and what it
*replaces*. Footprints vary with instance size — treat them as
order-of-magnitude.

### Password and secret management: Vaultwarden

- **Why:** a lightweight, Bitwarden-compatible vault means my browser extension
  and my phone speak a standard protocol while the data stays on my disk. For
  machine secrets, pair it with `age`/SOPS in Git instead of a plaintext `.env`.
- **Footprint:** small — a modest process, plus backups.
- **Replaces:** 1Password, LastPass, hosted Bitwarden.
- **The catch:** the backup *is* the product. An untested vault backup is a
  lockout you built yourself.

### File sync: Syncthing

- **Why:** peer-to-peer sync with no central server, no account, no vendor —
  devices on my private overlay keep folders identical directly between them.
- **Footprint:** a few hundred MB per node.
- **Replaces:** Dropbox, Google Drive, iCloud Drive (the sync half).
- **The catch:** conflict files. When two devices edit offline you resolve them,
  like an adult.

### Git: Gitea

- **Why:** a forge that runs inside my trust boundary — repos, issues, webhooks,
  CI triggers — on a box I control, with SQLite if I want zero database surgery.
- **Footprint:** a few hundred MB.
- **Replaces:** GitHub, hosted GitLab, Bitbucket.
- **The catch:** self-hosted CI is a separate job. Firing a webhook is easy;
  *being* a build farm is not.

### Notes: Memos

- **Why:** fast, single-binary, Markdown-ish quick capture — the thing that
  competes with your phone's Notes app, not with a wiki.
- **Footprint:** small to a few hundred MB.
- **Replaces:** Apple Notes, Google Keep, the quick-capture half of Notion.
- **The catch:** it is capture, not a knowledge base. If you need backlinks and
  long-form graph-think, that is a different job with a different tool.

### Media: Jellyfin

- **Why:** the fully open media server, un-bundled from a paid tier, that lets
  me own both the library and the metadata.
- **Footprint:** a few hundred MB for the server; the real cost is CPU/GPU if you
  transcode, plus disk for the library.
- **Replaces:** a Plex subscription, an ad-supported streaming box, a shelf of
  ripped discs.
- **The catch:** transcoding is the bottleneck, not the app. Direct play is
  cheap; convert-on-the-fly is where the hardware goes.

### Analytics: GoAccess

- **Why:** it reads the access logs my web server *already writes* and turns them
  into a report — no JavaScript, no cookie banner, nothing running in a reader's
  browser.
- **Footprint:** megabytes.
- **Replaces:** Google Analytics, Matomo, the tracker you never wanted.
- **The catch:** it cannot see clicks, scroll depth, or funnels. It answers "what
  brought a stranger in", and only that.

### Dashboards: Homepage

- **Why:** one static start page for every service I run, with live status tiles
  — it replaces my browser bookmarks folder and is the first thing I open.
- **Footprint:** tiny — megabytes.
- **Replaces:** a bookmarks bar, a spreadsheet of URLs, a wiki page of links.
- **The catch:** a dashboard is a map, not monitoring. When you genuinely need
  metrics, add a metrics store deliberately — not because the dashboard looks
  empty.

### Backup: restic

- **Why:** encrypted, deduplicated, versioned snapshots to storage I do not own —
  the tool that makes self-hosting a bet worth taking.
- **Footprint:** a tiny client; the storage is the whole point.
- **Replaces:** rsync scripts with no history, "the cloud has my stuff", hope.
- **The catch:** a backup is only real after a restore. Schedule both.

### Mail: Stalwart

- **Why:** a modern all-in-one mail server — SMTP, IMAP, JMAP — in one service
  you can actually run, for the mailbox you want on your own disk.
- **Footprint:** a few hundred MB, and it only ever grows.
- **Replaces:** Google Workspace / Fastmail (the mailbox half).
- **The catch:** the mailbox is self-hostable; the *sending reputation* is not.
  Relay outbound. Mail is the heaviest thing on this list and the first I would
  drop.

## The whole list on one table

| Job | Pick | Why in one line | Replaces |
| --- | --- | --- | --- |
| Password / secrets | Vaultwarden | Bitwarden-compatible vault on your disk | 1Password, hosted Bitwarden |
| File sync | Syncthing | Peer-to-peer, no central server | Dropbox, Drive |
| Git | Gitea | Forge inside your trust boundary | GitHub, GitLab |
| Notes | Memos | Single-binary quick capture | Apple Notes, Keep |
| Media | Jellyfin | Own the library, no paid tier | Plex, streaming boxes |
| Analytics | GoAccess | Reads the logs you already have | Google Analytics |
| Dashboards | Homepage | One start page for every service | Bookmarks folder |
| Backup | restic | Encrypted, deduplicated, offsite | rsync scripts, hope |
| Mail | Stalwart | Own the mailbox, not the reputation | Google Workspace |

## Overhyped or skip: the self-hosting traps

The flattering lists never tell you what to avoid. Here is what I would skip, and
why — none of it is bad software, it is just over-scoped for a homelab.

- **Kubernetes / k3s at home.** Unless you are learning it *because it is your
  job*, it is a fleet orchestrator for a fleet of one. You will spend weekends on
  the control plane and never touch the apps. A few `systemd` units read better
  at 3am.
- **Nextcloud as a kitchen sink.** Nextcloud is excellent at the one thing you
  installed it for and mediocre at the fifteen it also contains. If all you need
  is file sync, Syncthing does it with a fraction of the surface area. Install
  the platform when you actually need the suite — not before.
- **A full Prometheus + Grafana + Loki stack for one box.** This is observability
  cosplay. One server does not generate the signal volume to justify a metrics
  pipeline. `journalctl`, `systemctl status` and a log reader cover a homelab.
- **A self-hosted identity provider for five services.** Authentik or Keycloak in
  front of everything is a *lockout risk* when it is the only way in — centralize
  only once your service count genuinely outgrows a password manager.
- **Self-hosted object storage (MinIO) you do not need.** A homelab rarely
  produces S3-shaped work. restic writes to storage you do not run; you do not
  need to run a storage cluster to back up.
- **A web admin panel exposed to the internet.** Portainer and its cousins are
  convenient, and they are also a control plane for your control plane. Bind them
  to loopback or the overlay, never the public port.

The pattern: this is how a self-hosting hobby quietly turns into unpaid
employment.

## How to choose: fewer services you understand beats many you do not

The single most useful **self-hosting** rule I know: **optimize for the number
of services you can operate, not the number you can install.** Ten services you
do not understand are a liability; three you can back up, restore and debug are
an asset.

Before you install *anything*, answer three questions:

1. **What does this replace, exactly?** If you cannot name the thing it replaces,
   you are installing a demo.
2. **Where does its backup go, and have I restored it?** The answer must include
   a copy that lives *off* the box.
3. **What breaks if it dies tonight?** If the answer is "I lose access to the
   tools I would use to fix it", do not run it.

A small audit keeps me honest — and it is the only footprint measurement that
means anything, because it is *yours*:

```bash
# What is actually running, and what does it cost on THIS box?
systemctl list-units --type=service --state=running --no-pager
# RSS per process, largest first: your numbers, not a blog's
ps -eo rss,comm --sort=-rss | head -n 15
```

And the backup path, spelled out, because "I have backups" is not a plan:

```bash
# Encrypted, deduplicated snapshots to storage you do not own.
restic -r s3:s3.example.net/bucket backup /srv /etc /var/lib
restic -r s3:s3.example.net/bucket snapshots
# The only test that counts:
restic -r s3:s3.example.net/bucket restore latest --target /tmp/restore-drill
```

Run the restore drill. A snapshot you have never restored is a wish.

All of this only works on top of a setup you already trust: one public front
door, services bound to loopback, and a backup that leaves the machine. That
shape is in [what I self-host in 2026](/posts/what-i-self-host-2026/), and the
nuts and bolts — nginx, systemd, no containers — are in
[self-hosting without Docker](/posts/self-hosting-without-docker/).

The **best self-hosted apps** are not the ones with the longest feature page.
They are the ones you can name in a sentence, back up in an evening, and restore
without a spreadsheet. Fewer services you understand. That is the whole
strategy. Install less, operate more.
