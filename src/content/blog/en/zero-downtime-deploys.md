---
title: "Zero-downtime deploys on one box: atomic symlink, blue-green, and graceful reload"
description: "How I run zero-downtime deploys on a single server: the atomic symlink swap for static sites, blue-green deployment behind nginx, health-gated cutover, connection draining, nginx reload vs restart, fast rollback, and the failure modes that actually cause outages."
pubDate: 2026-11-09
lang: en
translationKey: zero-downtime-deploys
tags: [devops, self-hosting, nginx]
featured: false
keywords:
  - zero-downtime deploy
  - blue-green deployment
  - atomic symlink
  - graceful reload
  - rollback
---

You do not need Kubernetes to avoid a "maintenance window". A **zero-downtime deploy** on one machine is a solved problem, and the solution is boring on purpose: build the new thing somewhere off to the side, prove it is healthy, flip a single pointer, and let the old thing finish its in-flight requests. One box, one nginx, one systemd unit. This is the shape I use for this blog — the same static pipeline described in [how this blog ships itself](/posts/how-this-blog-ships-itself/) — and the same shape I use for a couple of small services sitting behind the same reverse proxy.

## Why downtime is avoidable

Downtime on a deploy usually is not a hard requirement of the software. It is a side effect of deploying *in place*: you stop the process, overwrite its files, start it again. In that window the process is not listening, so requests fail. Almost every deploy that feels like it needs an outage is really just doing those three steps in the wrong order.

For **static sites** it is even clearer: the web server never needs to stop at all, because the files it serves are just files. The question is only whether a request can land between "old content gone" and "new content present". If you make that transition a single atomic operation, the window is zero — not small, zero. That is the whole idea behind the **atomic symlink** swap.

For **most services**, the same reasoning holds. If the app can start a second copy alongside the first, or reload its config without dropping its listening socket, then a deploy is a cutover event, not a stop-and-start event. The catch is not the server; it is the *state* the app depends on — a database schema, a session store, a cache. That is where I actually spend my worry.

## Atomic symlink: zero-downtime deploy for static sites

The pattern: never write new files over the live directory. Write them into a fresh, versioned directory, then change a symlink that points at it. A symlink swap is atomic on POSIX filesystems because `rename(2)` is atomic within a directory — readers see either the old target or the new one, never a half-written mix.

```text
/var/www/blog/
├── releases/
│   ├── 2026-11-08T21-40-12/   # previous build, still reachable
│   └── 2026-11-09T09-12-03/   # the build we are flipping to
│       ├── index.html
│       └── assets/
└── current -> releases/2026-11-08T21-40-12   # nginx serves this
```

nginx serves `/var/www/blog/current`. To deploy, build into `releases/<timestamp>`, verify it, then swap:

```bash
# run as the deploy user; CURRENT and NEW are absolute paths
ln -sfn "$NEW" /var/www/blog/current.tmp
mv -T /var/www/blog/current.tmp /var/www/blog/current
```

`mv -T` on the temp symlink is the rename that makes the swap atomic. Do not use `ln -sfn` directly on `current` — some shells and older `ln` implementations will resolve through the existing symlink and write *into* the release it points at, which is exactly the bug you are trying to avoid.

Because both releases stay on disk, **rollback** is another one-line swap back to the previous release directory. No rebuild, no re-upload. Keep the last two or three and prune the rest.

## Blue-green deployment behind a reverse proxy

A static site can be served from two directories, but a running service needs two *processes*. That is **blue-green deployment**: run the current version (blue) while you start the new version (green) next to it, on a different port or socket, then move traffic over.

I do not run a full orchestrator for this. Two systemd units and an nginx upstream is enough:

```ini
# /etc/systemd/system/api-blue.service  (green is identical with its own port)
[Service]
ExecStart=/opt/api/releases/blue/bin/api --listen 127.0.0.1:9001
Restart=on-failure
```

```nginx
# nginx upstream points at whichever colour is live
upstream api {
    server 127.0.0.1:9001;   # blue; switch to 9002 for green
    keepalive 32;
}
```

The switch itself is a config change plus `nginx -s reload`. But the ordering is not "reload then pray" — see the next two sections, because the good part is the discipline around the flip, not the flip.

If the app holds real state, blue-green gets harder: both colours write to the same database, so the schema must be compatible with both versions at once. That is the half-migrated-database failure mode, and it is the real cost of blue-green.

## Graceful reload of the app

Before nginx swings traffic, the *app* deserves the same treatment. A **graceful reload** means: start the new version, let the old version finish the requests already in flight, then stop it — without dropping the listening socket if possible. systemd makes the parts you can control explicit:

```ini
# /etc/systemd/system/api.service
[Service]
ExecStart=/opt/api/current/bin/api --listen 127.0.0.1:9001
KillSignal=SIGTERM
TimeoutStopSec=30          # give in-flight requests 30s to finish
KillMode=mixed             # signal the main process, then the group
```

The app should treat `SIGTERM` as "stop accepting, drain, exit", not "die now". A well-behaved Go or Node server does this out of the box; a Python WSGI app usually needs a config flag (for example `gunicorn --graceful-timeout 30`). If your app treats `SIGTERM` as instant death, a reload becomes an outage no matter how clever the reverse proxy is.

The key property is a **long-lived listening socket**: if the new process can inherit the socket while the old one drains, there is never a moment when nothing is listening. systemd socket activation gets you that. Without it, keep the drain short and accept a few milliseconds of refusal.

## The order that matters: build, health-check, flip, reload nginx

The sequence is the deploy. Get it wrong and you will cut over to a process that has not finished booting, or reload nginx before the new upstream exists.

1. **Build off to the side.** New release directory or new port. Nothing public touches it yet.
2. **Start the new process** (blue-green) or finish the build (static). It is running but not receiving traffic.
3. **Health-check it.** Poll an endpoint that proves the app can actually serve — not just that the port is open. A process that is up but cannot reach its database is *not* healthy.
4. **Flip the pointer.** Atomic symlink swap, or nginx upstream change.
5. **Reload nginx** (`nginx -s reload`), then reload/retire the old app instance once its connections drain.

Step 3 before step 4 is the whole thing. A health check that returns 200 only when the app can do real work turns "did the deploy work?" from a guess into a gate.

```bash
#!/usr/bin/env bash
# deploy-api.sh — skeleton, not a product
set -euo pipefail

NEW_PORT=9002
HEALTH_URL="http://127.0.0.1:${NEW_PORT}/healthz"

# 1. stage the new release (pulled/built off to the side)
systemctl start api-green.service

# 2. health-gate: fail loudly and never flip if it is not ready
for i in {1..30}; do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null; then ready=1; break; fi
  sleep 1
done
[ "${ready:-0}" = 1 ] || { echo "green unhealthy, aborting"; systemctl stop api-green.service; exit 1; }

# 3. flip nginx upstream to green, reload, then drain blue
sed -i 's/9001/9002/' /etc/nginx/conf.d/api-upstream.conf
nginx -t && nginx -s reload

# 4. let blue finish in-flight work, then retire it
sleep 30
systemctl stop api-blue.service
```

That `sed` is crude — in practice I template the upstream file. The shape is what matters: health first, flip second, drain third.

## reload vs restart: the nginx note

`systemctl reload nginx` sends `SIGHUP`. The master process re-reads its config and starts fresh workers, then **gracefully shuts down the old workers once their connections close**. Existing requests complete on the old workers; there is no dropped connection. This is why a deploy reloads nginx and almost never restarts it.

`systemctl restart nginx` stops the master entirely and starts a new one. Listening sockets drop, in-flight requests die, and a bad config takes the whole server down instead of failing to reload. Use restart when you are upgrading the binary, not when you are cutting over traffic.

The one discipline: **always `nginx -t` before reloading.** A config with a typo will be rejected by the reload and the old workers keep serving — which is exactly what you want. Reload without testing, on a setup where reload errors are ignored, and you will eventually reload into a broken state.

## Rollback: make it a re-flip

Rollback should never be a rebuild. Because every step above is a pointer swap, the fast path is the reverse swap:

- **Static:** `mv -T` the `current` symlink back to the previous release directory.
- **Blue-green:** point nginx back at the old colour and reload; the old process is still running if you have not stopped it yet.

Keep the previous release around for a window — an hour, a day — precisely so rollback is instant. The expensive part of a bad deploy is the time before you notice, so alert on the health check *after* cutover too, not just during it.

## Failure modes that actually cause outages

- **Half-migrated database.** Blue-green against one database means both versions run against one schema. Any migration must be backward-compatible: add columns first, deploy code that uses them, and only later remove the old columns. Never drop or rename in the same deploy that switches code.
- **Sticky sessions.** If sessions live in process memory and users are pinned to a colour, flipping to green logs everyone out or, worse, spreads one user across two processes. Move sessions to Redis or a signed cookie before you attempt blue-green.
- **Long-lived connections.** WebSockets, SSE, and long-polling do not drain on a normal reload cadence. Cap their lifetime, or the old worker never exits and your "graceful" reload leaks processes for hours.
- **Cache invalidation.** An atomic symlink changes the directory, not the URLs users already have. Cache-bust asset filenames (content hashes) rather than deleting cache entries, and remember that a CDN or browser cache in front of the swap can serve the old page for minutes regardless.
- **The health check lies.** A `/healthz` that returns 200 because the HTTP server is up, while the database pool is empty, gates nothing. Test the dependencies that matter.

## Match the complexity to the blast radius

The last thing, and the one I actually care about: **deploy complexity should match your blast radius.** A static blog does not need green processes and connection draining; it needs an atomic symlink and a rollback that is one `mv`. A payment service with a database does not get to skip those things. I use one box for both, with the right number of moving parts for each — small static swaps stay trivial, and the two services that can lose money get health gates and a drain window.

If you are starting from nothing, start with the symlink swap. It gives you a zero-downtime deploy and a one-line rollback for free, and it is the mental model every fancier scheme is built on. If your TLS is hand-managed, fix that first — see [automated TLS at scale](/posts/automated-tls-at-scale/) — because a deploy that races a certificate renewal is a self-inflicted outage.
