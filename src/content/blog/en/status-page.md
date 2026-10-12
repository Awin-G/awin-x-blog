---
title: "Building a status page that doesn't lie"
description: "A status page is a promise about availability and incident communication, not a green light. How to build one that lives apart from the system it watches, with a minimal static-page-plus-checker design, a status JSON schema, and honest uptime monitoring that respects false positives."
pubDate: 2026-11-28
lang: en
translationKey: status-page
tags: [devops, self-hosting]
featured: false
keywords:
  - status page
  - uptime monitoring
  - incident communication
  - health check
  - dead man's switch
---

A **status page** is a promise: this is what is up right now, this is what broke, and this is when we knew. Most status pages break that promise. They are a green light rendered by the very system they claim to monitor, flipped by a liveness check that has never once been told it might be wrong. The moment things actually fail, the page goes dark, stays green, or quietly stops updating — and everyone learns to ignore it. Good **uptime monitoring** and honest **incident communication** are the two halves of the fix, and both are harder than the widget that most teams install.

I run this blog and a small fleet of services on one VPS. When I set out to build my own page, I had one rule: it must be the last thing on the box to go down, and it must tell the truth even when the box is on fire. This is the design that survived contact with reality.

## What a status page is for — and what most of them are

Two jobs, and only two:

- **Availability** — the current, honest state of each service. Up, degraded, down. A claim you can verify.
- **Incident communication** — what is affected, since when, what you are doing about it, and when you last heard something. The humans reading it need a timeline, not a color.

That is it. A status page is not a marketing asset, not a Grafana dashboard, and not a place to hide a mild outage behind a reassuring green. If you are reaching for it to look calm, you have already lost the room.

What most status pages actually are: a static "All systems operational" banner driven by a `curl` that returns 200, hosted inside the same infrastructure, updated by a job that runs on the same box. When that box dies, the page either dies with it (nobody notices the absence of an update) or keeps showing the last known-good state forever (a lie that looks like calm). The green light is wrong because it answers the wrong question. "Is my monitoring job able to reach the service?" is not "is the service up?"

## Hosted vs self-hosted status pages

The first fork in the road.

**Hosted** (Statuspage, Better Stack, Instatus, and friends) buys you a domain that is genuinely outside your blast radius, someone else's uptime, subscription and SMS notifications, and a UI to post incident updates. For a team with customers and an SLA to honor, this is often the right call: the day your VPS dies, their status page is still up because it is not yours. The costs are a monthly bill, a third party who now knows your incident history, and a design that nudges you toward the same easy lie — one toggle, one green dot.

**Self-hosted** (Uptime Kuma, Gatus, Cachet, or a page you write yourself) gives you control and no bill, but hands you the hardest problem in the whole exercise: *the page must run somewhere other than the thing it monitors.* A self-hosted status page on the same VPS it monitors is theater. It is only real if it lives on a second host, a different provider, or at minimum a different failure domain.

I take the self-hosted route because it forces me to solve the actual problem rather than outsource the trust. But whichever you pick, the decoupling is the point, and it is the part that hosted vendors sell you implicitly.

## The hard part: the page must outlive what it watches

This is the idea that separates a real status page from a decorative one, so it is worth stating plainly.

- The status page must live in a **different failure domain** than the services it reports on. Different host, ideally different provider.
- It must keep working **when everything it monitors is down** — including when the network path to your page's own backend is severed.
- It must be **updated even when things are down**, which means the update cannot depend on the failing system being healthy enough to push an update.

The usual failure is a pull model that runs on the box being watched. The fix is to invert the direction: a small **checker** that runs somewhere neutral, pings the services over the network, and writes a status file. The static page is just a reader of that file. The checker is decoupled from the page, and the page is decoupled from the services. Nothing in the chain depends on the thing it is measuring.

## A minimal design: static page + checker + manual incident notes

Here is the whole architecture, and it stays small on purpose.

<figure>
<svg viewBox="0 0 660 220" width="100%" role="img" aria-label="A decoupled status page pipeline: a checker running on a neutral host probes the services on the VPS and writes a status JSON file to a status store on a separate host; a static page served from that store reads the JSON and renders it; a human writes incident notes into the same store by hand.">
  <defs>
    <marker id="sp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="70" width="130" height="60" rx="8"/>
    <rect x="265" y="70" width="130" height="60" rx="8"/>
    <rect x="522" y="70" width="130" height="60" rx="8"/>
    <rect x="265" y="12" width="130" height="40" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" color="currentColor">
    <line x1="138" y1="100" x2="263" y2="100" marker-end="url(#sp-arrow)"/>
    <line x1="395" y1="100" x2="520" y2="100" marker-end="url(#sp-arrow)"/>
    <line x1="330" y1="52" x2="330" y2="68" marker-end="url(#sp-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="73" y="105" text-anchor="middle">checker</text>
    <text x="330" y="105" text-anchor="middle">status store</text>
    <text x="587" y="105" text-anchor="middle">static page</text>
    <text x="330" y="37" text-anchor="middle">you (incident notes)</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="73" y="145" text-anchor="middle">neutral host,</text>
    <text x="73" y="160" text-anchor="middle">probes over network</text>
    <text x="330" y="145" text-anchor="middle">a separate host</text>
    <text x="330" y="160" text-anchor="middle">holds status.json</text>
    <text x="587" y="145" text-anchor="middle">reads the file,</text>
    <text x="587" y="160" text-anchor="middle">no logic of its own</text>
    <text x="330" y="200" text-anchor="middle" opacity="0.9">nothing in the chain depends on the thing it measures</text>
  </g>
</svg>
<figcaption>The checker, the store, and the page are three separate failure domains. The page is dumb on purpose — it renders whatever the store says, even if that is bad news about the machine hosting the data.</figcaption>
</figure>

Three pieces, each boring on purpose:

1. **A checker** on a neutral host — a second VPS, a cheap box, even a CI cron. It probes the services and writes one file.
2. **A status store** — a small repo, an object-storage bucket, or a git branch. It holds `status.json` and the incident history. It must be reachable independently of the services.
3. **A static page** — HTML that reads the JSON and renders it. No server-side logic, no database, no admin panel on the monitored box. A static file cannot go down with your database, and it is trivially cacheable at a CDN.

The data model is small enough to write by hand:

```json
{
  "updated": "2026-11-28T09:41:00Z",
  "overall": "degraded",
  "components": [
    { "id": "blog",   "name": "Blog",           "state": "operational", "checked": "2026-11-28T09:40:52Z" },
    { "id": "gitea",  "name": "Git hosting",    "state": "operational", "checked": "2026-11-28T09:40:55Z" },
    { "id": "vpn",    "name": "Overlay network", "state": "degraded",    "checked": "2026-11-28T09:40:58Z" }
  ],
  "incidents": [
    {
      "id": "2026-11-28-vpn",
      "title": "Overlay network latency",
      "state": "investigating",
      "impact": "degraded",
      "started": "2026-11-28T09:12:00Z",
      "resolved": null,
      "updates": [
        { "at": "2026-11-28T09:20:00Z", "text": "Higher latency on node eu-2; investigating." }
      ]
    }
  ]
}
```

`state` on a component is one of `operational`, `degraded`, `down`, `maintenance`. An incident has a `state` too — `investigating`, `identified`, `monitoring`, `resolved` — and that field is the whole point of **incident communication**: it tells a reader how much you actually know.

## Automated checks lie in both directions

The checker is not the source of truth. It is a source of *evidence*, and evidence is wrong sometimes.

- **False positives** — the check fails but the service is fine. A dropped packet, a slow TLS handshake, your monitoring host's own DNS blip, a rate limit you tripped by probing too often. If this auto-flips the page to "down", you have taught your users that the page cries wolf, and they will stop believing the real outage.
- **False negatives** — the check passes but the service is broken for everyone else. A health endpoint that returns 200 while the database behind it is unreachable. A CDN edge you can reach but a whole region cannot. A `200 OK` from a login page after the app has lost its data. The green dot is technically true and completely misleading.

The fix is not a better check. It is **restraint**.

Do not auto-flip a component to `operational` too eagerly. Require N consecutive successes before you clear a failure, so a single blip does not cause a dramatic "recovered" that is really just noise. And treat a *crossing into the bad state* differently from a *return to good*: a single failed check can justify `degraded` immediately, because warning earlier is cheap and honest; but clearing it should need a sustained run of good checks, because a premature all-clear is the one lie that costs you credibility.

Where consequences are real — anything with an **SLA**, anything involving money — do not let an automated signal change the public story at all. Let the checker flip component colors, but let a human own the incident text. Automation runs the pager; it does not write the confession.

## The checker in a timer, in full

The checker is a script on a timer. Here is the shape of it — probe, compare against the previous state, and only write when something actually changed:

```python
#!/usr/bin/env python3
# /usr/local/bin/status-check.py — runs on a NEUTRAL host, not the monitored box
import json, time, urllib.request, datetime, sys

TARGETS = {
    "blog":  "https://blog.example.com/healthz",
    "gitea": "https://git.example.com/api/healthz",
}
STATE = "/srv/status/status.json"
CONFIRM = 2  # consecutive good checks required to clear a failure

def probe(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False

now = datetime.datetime.now(datetime.timezone.utc).isoformat()
doc = json.load(open(STATE))

for comp in doc["components"]:
    ok = probe(TARGETS[comp["id"]])
    fail_streak = comp.get("fail_streak", 0) + (0 if ok else 1)
    ok_streak   = comp.get("ok_streak", 0) + (1 if ok else 0)
    # warn fast, clear slow
    if not ok:
        comp["state"] = "down"
    elif ok_streak >= CONFIRM:
        comp["state"] = "operational"
    comp["fail_streak"], comp["ok_streak"] = fail_streak, ok_streak
    comp["checked"] = now

doc["updated"] = now
doc["overall"] = ("down" if any(c["state"] == "down" for c in doc["components"])
                  else "degraded" if any(c["state"] == "degraded" for c in doc["components"])
                  else "operational")

# write atomically so the page never reads a half-written file
tmp = STATE + ".tmp"
json.dump(doc, open(tmp, "w"), indent=2)
import os; os.replace(tmp, STATE)
```

And the timer that keeps it honest — plus the check that watches the watcher:

```ini
# /etc/systemd/system/status-check.timer
[Unit]
Description=Probe services and update the status store

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

The subtle part is the last mile. If the checker itself dies, the page does not go red — it just freezes. Stale data that still says "operational" is a lie. So make *freshness* a first-class signal:

```bash
# dead man's switch: if the store has not been refreshed, say so loudly
AGE=$(( $(date +%s) - $(date -d "$(jq -r .updated /srv/status/status.json)" +%s) ))
[ "$AGE" -lt 600 ] || echo "status store stale: ${AGE}s"
```

That is a **dead man's switch**. The absence of an update is itself an incident, and the page should render "status unknown" rather than a green dot it cannot vouch for. An honest "unknown" beats a confident wrong answer every single time.

## The trust rules

Everything above is scaffolding for four rules. Break any of them and the page is worse than nothing.

- **Say what you know.** Report only what the check actually observed. Do not infer "operational" from silence, and do not upgrade a `degraded` to `operational` until the evidence says so.
- **Say it when you know it.** A status page that updates an hour later is a changelog. Post the incident at `investigating` even with no root cause — "we know, we are looking" is the most valuable sentence you will ever publish.
- **Do not go dark.** A slow, partial update beats silence. When you have nothing new, say that. "Still investigating, no new information" is a legitimate and honest update, and it is far better than a timeline that stops at the last bad thing.
- **Never let the page show green for a system that is lying to it.** If the health check and the page can both be produced by the failing system, you have not built a status page; you have built a mirror.

## Closing the loop

The whole design is one sentence: **a checker and a page in different failure domains, a store between them, and a human who writes the truth.** Get the decoupling right and the page keeps working during the outage it exists to describe. Get the restraint right and the page stops crying wolf. Get the trust rules right and people believe it when it goes red.

If you are standing this up next to the rest of your small infrastructure, run it the way you run everything else — one service per concern. My notes on [monitoring a small fleet](/posts/monitoring-a-small-fleet/) cover the observability side, and when the incident is over, [writing postmortems](/posts/writing-postmortems/) is how the status page's timeline turns into a fix that sticks. A status page nobody trusts is just a green light with an excuse; one that tells the truth is a promise you can keep.
