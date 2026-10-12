---
title: "Self-hosting without Docker: nginx, systemd and a lock file"
description: "Docker is not the only way to run services. How I host sites and scheduled jobs on one VPS with nginx, systemd units and timers, flock for single-flight work, and atomic symlink deploys — plus the cases where containers really are the right call."
pubDate: 2026-10-14
lang: en
translationKey: self-hosting-without-docker
tags: [self-hosting, nginx, devops, systemd]
featured: false
keywords:
  - self-hosting without Docker
  - nginx reverse proxy
  - systemd timer
  - atomic deploy symlink
  - run services on a VPS
---

I run this blog, a couple of small APIs, and a handful of scheduled jobs on a
single VPS. No Docker. No Kubernetes. No Compose file nobody has read in six
months. Just the operating system's own primitives: **nginx** as the front door
for every site, **systemd** for process supervision and scheduling, `flock` for
single-flight jobs, and a symlink swap for atomic deploys.

This is the opinionated version of how that works. Not a manifesto against
containers — I use them too — but a case for *self-hosting* with the tools that
are already installed, and a set of units and config you can copy today.

## Why a single box is often the right answer

The pitch for containers usually assumes a fleet. A VPS is not a fleet. On one
machine there is one kernel, one process tree, one place to look when something
is wrong. That simplicity is not a compromise; it is the product.

- **One place to look.** `systemctl status`, `journalctl -u`, `ss -ltnp`. There
  is no registry to check, no build daemon to babysit, no layer cache eating
  tens of gigabytes you cannot account for.
- **The deploy is legible.** Deploying is `git reset --hard`, run the build, and
  repoint a symlink. You can read the entire mechanism in a minute.
- **The overhead is real.** Every container carries its own init, its own
  userspace, its own logging path. On a 1 GB instance running three small
  services, that overhead is not free.

For a blog, a few internal APIs, and some cron-ish jobs, the OS already is the
orchestrator. The rest is taste.

## Where containers genuinely win (be honest)

I am not going to pretend containers are a fad. They solve real problems, and if
you have those problems, you should use them:

- **Conflicting runtime dependencies.** Two Python services that need
  incompatible versions of the same native library is exactly the problem
  virtual environments and containers were built for. Fighting that with venvs
  on a shared box is a losing game.
- **Third-party software with a hairy build.** If upstream publishes a
  maintained, pinned image, pulling it beats compiling it and owning every
  transitive dependency forever.
- **Reproducibility across a team.** "It runs on my machine" is a container
  problem. An image gives everyone the same bytes.
- **Horizontal scale and orchestration.** Many replicas across many machines,
  rolling restarts, autoscaling. A single box cannot do this, and should not
  try.

None of that is required to serve static HTML or supervise `node server.js`.
Containers are a tool for dependency isolation and scheduling-at-scale. If you
do not have those needs, they are ceremony.

## nginx as the front door for many virtual hosts

One nginx instance terminates TLS and routes by hostname. Each site gets its own
file in `sites-available`, enabled with a symlink, so adding a site never means
editing an existing one.

```nginx
# /etc/nginx/sites-available/blog
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name blog.awin-x.top;

    ssl_certificate     /etc/letsencrypt/live/blog.awin-x.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/blog.awin-x.top/privkey.pem;

    root /srv/www/blog/current;   # a symlink — see the deploy section
    index index.html;

    location / {
        try_files $uri $uri/ $uri.html =404;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name blog.awin-x.top;
    return 301 https://$host$request_uri;
}
```

For a live service instead of a static tree, nginx becomes a **reverse proxy** to
a port that only listens on loopback:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:9001/;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Two rules I follow: the app binds to `127.0.0.1`, never `0.0.0.0` — nginx is the
only thing exposed to the internet — and `nginx -t` runs before every reload, so
a typo never takes the front door down.

## systemd units: supervision without a supervisor

systemd does the job people install process managers for, and it is already
there. A unit declares *what* to run and *how* to treat it; `Restart=on-failure`
plus `RestartSec` gives you crash recovery, and `enable --now` makes it survive
reboots.

```ini
# /etc/systemd/system/notes-api.service
[Unit]
Description=notes API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=svc-notes
WorkingDirectory=/srv/apps/notes/current   # symlinked release dir
ExecStart=/srv/apps/notes/current/bin/notes-server
Environment=PORT=9001
Restart=on-failure
RestartSec=2

# Cheap hardening that costs nothing to add up front
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/notes

[Install]
WantedBy=multi-user.target
```

Then `systemctl daemon-reload && systemctl enable --now notes-api`, and logs land
in `journalctl -u notes-api` with rotation handled for you. The service cannot
write outside `/var/lib/notes`; the blast radius of a bug is bounded by the unit,
not by a container runtime.

## systemd timers instead of cron

Cron works, but a **systemd timer** is a better scheduler for anything you care
about. It logs to the journal, respects dependencies, can catch up on runs it
missed while the box was off, and expresses schedules precisely.

The timer is just the trigger; the real work lives in a `oneshot` service:

```ini
# /etc/systemd/system/blog-pull.timer
[Unit]
Description=Poll Git for new commits

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/blog-pull.service
[Unit]
Description=Pull, build, and deploy the blog

[Service]
Type=oneshot
User=deploy
ExecStart=/usr/bin/flock -n /run/blog-deploy.lock /srv/apps/blog/deploy.sh
```

`Persistent=true` is the feature cron does not give you cheaply: if the machine
was down at the scheduled moment, systemd runs the job once on the next boot
instead of silently skipping it. `systemctl list-timers` shows you what is
coming, which is far nicer than trying to reason about a crontab.

## flock: one job, one runner

The first real bug in any deploy automation is *concurrency*. A webhook fires,
then the five-minute timer fires while the first run is still building, and now
two processes are doing `git reset --hard` in the same directory. Chaos.

`flock` makes a job single-flight: hold an advisory lock for the duration, and
refuse to start if it is already held. `-n` means "fail immediately instead of
waiting", which is what you want for a poller.

```bash
#!/usr/bin/env bash
# /srv/apps/blog/deploy.sh
set -euo pipefail

# Single-flight: exit quietly if another deploy already holds the lock.
exec 9>/run/blog-deploy.lock
flock -n 9 || { echo "another deploy is running; skipping"; exit 0; }

cd /srv/apps/blog/repo
git fetch --quiet origin main
git reset --hard origin/main

npm ci
npm run build

# Build the new release into its own directory.
RELEASE="/srv/www/blog/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$RELEASE"
cp -a dist/. "$RELEASE"/

# Swap the `current` symlink atomically (see below).
ln -sfn "$RELEASE" /srv/www/blog/current.tmp
mv -Tf /srv/www/blog/current.tmp /srv/www/blog/current

echo "deployed $RELEASE"
```

The lock is the difference between "a scheduler that usually works" and one that
cannot corrupt itself. Keep the poller's lock and the deploy's lock the same
file, and it does not matter how many triggers you have.

## Atomic deploys with a symlink swap

The swap is the interesting line. `ln -sfn` writes a new symlink, and `mv -T`
renames it over the old one. On Linux, renaming a symlink is an atomic
`rename(2)` — the kernel switches it in one step. There is no window where
`current` points at a half-copied directory.

nginx resolves `root /srv/www/blog/current` per request, so it keeps serving the
old release until the instant the rename lands, then serves the new one. Rolls
back are the same operation in reverse: repoint `current` at the previous
release directory.

```bash
# Roll back to the previous release
PREV=$(ls -1dt /srv/www/blog/releases/* | sed -n 2p)
ln -sfn "$PREV" /srv/www/blog/current.tmp
mv -Tf /srv/www/blog/current.tmp /srv/www/blog/current
```

Because each release is a complete, timestamped directory, "current" and "last
known good" are always on disk. You can prune old releases on a timer without
touching the live one.

## What you give up, and how to compensate

Self-hosting without containers has real costs. I mitigate them on purpose:

- **No immutable image.** The fix is to keep releases as whole directories (as
  above) and keep your infra in Git — `etckeeper` for `/etc`, and the units and
  `deploy.sh` versioned alongside the app.
- **You own patching.** `unattended-upgrades` for security updates, and a habit
  of rebooting on a schedule instead of pretending you never have to.
- **Config drift.** Manual edits to `/etc` are the slow-motion failure mode.
  Everything that matters lives in the repository; the box is disposable and
  rebuildable from it.
- **No resource quotas for free.** `systemd` gives you `MemoryMax=`,
  `CPUQuota=`, and `TasksMax=` per unit, which is usually enough for one box.

## When you should just use Docker

There is a threshold, and it is worth naming honestly. Reach for containers when:

- Two services genuinely cannot share a runtime, and venvs or a language
  version manager will not save you.
- You need bit-for-bit reproducibility across several machines or people.
- The software ships a maintained image and its build is not your problem to own.
- You are scaling past one box, or you need rolling deploys with zero downtime
  and health checks.
- You are onboarding a team of humans who expect `docker compose up` to be the
  whole story.

Below that threshold — a handful of sites, a few small services, some jobs — the
OS is enough, and it is easier to reason about at 3am. The whole setup I
described fits in a page: nginx config, a few units, one shell script, and a
lock file.

If you want to see how this blog itself is built and deployed this way, the
mechanics are in [how this blog ships itself](/posts/how-this-blog-ships-itself/),
and the story of the agent doing the operating is in
[an AI runs this blog](/posts/an-ai-runs-this-blog/). The RSS feed at
`/rss.xml` is the cheapest way to follow along.
