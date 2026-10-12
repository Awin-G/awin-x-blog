---
title: "Cookie-less analytics you can self-host: GoAccess and the log-based route"
description: "Why client-side tracking is a privacy and performance tax, how the self-hosted analytics spectrum runs from GoAccess over server logs to GoatCounter, Umami and Plausible, and a concrete GoAccess setup — plus the honest limits of log-based measurement. The rule: measure what changes your decisions."
pubDate: 2026-10-20
lang: en
translationKey: self-hosted-analytics
tags: [self-hosting, devops, nginx]
featured: false
keywords:
  - self-hosted analytics
  - Google Analytics alternative
  - GoAccess
  - cookie-less analytics
  - privacy-friendly analytics
---

I run **self-hosted analytics** on this blog, and the whole thing is about forty
lines of config and a systemd timer. No JavaScript in the page, no cookie banner,
no third-party script phoning home while your reader waits for text. If you are
looking for a **Google Analytics alternative**, the honest answer is that most of
us do not need a tracking platform at all — we need a log reader. This post is
the spectrum of **cookie-less analytics** options I have actually run, why
**GoAccess** over server logs is enough for a site like this, and exactly where
the log-based route stops being enough.

The framing throughout: measure what changes your decisions, and nothing else.

## Why client-side tracking is a privacy *and* a performance problem

Client-side analytics means a `<script>` in your page that runs in your reader's
browser. That is two problems wearing one coat.

The **privacy** half is obvious once you say it plainly: a third-party beacon
lets someone else observe your readers across every site that embeds the same
script, and cookies exist precisely to stitch those observations into a profile.
Even a "privacy-friendly" vendor still means your readers' IP addresses and
pageviews leave your server for somebody else's. The cookie banner, the consent
string, the data-processing agreement — that whole apparatus exists to make a
choice you did not have to make.

The **performance** half is quieter and, for me, more decisive. Every tracker is:

- a **render-blocking or at least network-blocking** request on the critical
  path, competing with your CSS, fonts and images for the same connection;
- a **third-party DNS lookup + TLS handshake** to a domain you do not control,
  on hardware you cannot fix;
- **bytes of JavaScript** parsed and executed on a phone that is already warm,
  for a report you will look at once a month.

A blog post that is 30 KB of text should not ship a tracker heavier than itself.
And there is a philosophical tax on top: the script runs in the reader's browser,
so *any* client-side option — even self-hosted — is code you are executing on
someone else's machine. Log-based analytics never does that.

## The spectrum of self-hosted analytics

There is no single "best" tool; there is a spectrum from "reads files I already
have" to "a full product-analytics platform." Here is how the options I have run
actually compare.

| Option | Data source | What it is good at | The cost |
| --- | --- | --- | --- |
| **GoAccess** | nginx/Apache server logs | Zero JS, zero DB, instant, one binary | Coarse; blind to client-side events |
| **GoatCounter** | Tiny JS beacon | Single Go binary, private, reasonable UI | Still a script; needs a DB |
| **Umami** | JS beacon | Sessions, events, funnels, clean UI | Node + database to run and back up |
| **Plausible** | JS beacon (proxy-able) | Polished, GA-like, EU-hosted ethos | More moving parts; paid if hosted |
| **Matomo** | JS beacon | Everything GA has, plus reports | PHP + MySQL; the heaviest to own |

The pattern is simple: **the more you move left, the less you run and the less
you measure; the more you move right, the more you get and the more you babysit.**
Plausible and Matomo are the right answers when you need funnels, goals,
campaigns and per-user journeys. GoatCounter and Umami are the right answers when
you want a nice dashboard and a lightweight script. GoAccess is the right answer
when you want the question "what brought a stranger in, and which pages do people
actually read?" answered without adding one line of code to the page.

Two of these are not like the others. GoatCounter, Umami, Plausible and Matomo
are all **beacon-based**: they inject a script and receive an event. GoAccess is
**log-based**: it parses the access log your web server was already writing for
your own troubleshooting. That distinction is the whole argument.

## Log-based server-side vs JS beacons: the tradeoff is real

Neither side wins outright. Here is the honest ledger, because a "privacy
analytics" post that pretends logs are free is just a different ad.

**What log-based wins:**

- **Nothing runs in the reader's browser.** No script, no cookies, no consent
  banner, no third-party connection. Your pages get faster because you removed
  weight, not added it.
- **Nothing new to run or secure.** The log already exists. No database, no
  admin panel, no session store, no schema migrations on a Tuesday.
- **It is un-blockable.** Ad blockers and privacy extensions have nothing to
  block; you are not distinguishable from any other request.
- **It is cheap enough to not think about.** One binary over a file.

**What log-based loses:**

- **No client-side events.** You cannot see a button click, a scroll depth, a
  form abandonment, or a JS error. You see requests, and only requests.
- **No session duration for a static site.** A reader who opens one page and
  reads it for nine minutes looks identical to a reader who bounced in two
  seconds. GoAccess can show *time served* per request from `$request_time`, but
  that is server time, not attention.
- **No identity, by design.** Returning visitors are inferred from IP (imprecise
  behind NAT, mobile networks, privacy VPNs). You will never know "this person
  came back."
- **Rail noise.** Bots, scanners, preview fetchers, and referrer spam all hit the
  log. You get better at filtering, but you never get to zero.

If you genuinely need the left column, run a beacon tool. If you are a blog,
docs site or storefront whose decisions are "write more of this topic," the left
column is the whole job, and the right column is overhead.

## A concrete GoAccess setup

This is the actual setup on my nginx box. It assumes a `vcombined` log format —
nginx's `combined` plus the virtual host — so one report can cover several sites.

First, the log format in nginx. `vcombined` matches GoAccess's built-in
`VCOMBINED` parser, so you do not have to hand-write the format string.

```nginx
# /etc/nginx/nginx.conf (http context)
log_format vcombined '$remote_addr - $remote_user [$time_local] '
                     '"$request" $status $body_bytes_sent '
                     '"$http_referer" "$http_user_agent" "$host"';
access_log /var/log/nginx/access.log vcombined;
```

Then the report itself. GoAccess reads the log, applies filters, and writes a
self-contained HTML page you can serve statically — no backend, no database.

```bash
# Build the report by hand, to prove it works
goaccess /var/log/nginx/access.log \
  --log-format=VCOMBINED \
  --output=/var/www/analytics/index.html \
  --ignore-crawlers \
  --anonymize-ip
```

`--ignore-crawlers` drops obvious bot user-agents. `--anonymize-ip` truncates the
last octet so even the report cannot leak a full address. To keep stats across
rotations instead of starting fresh each run, add `--persist --restore`.

Now run it on a timer, single-flight, so a slow report cannot stack on itself:

```ini
# /etc/systemd/system/goaccess-report.service
[Unit]
Description=Build the GoAccess HTML report
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /run/goaccess.lock \
  /usr/bin/goaccess /var/log/nginx/access.log \
  --log-format=VCOMBINED \
  --output=/var/www/analytics/index.html \
  --ignore-crawlers --anonymize-ip --persist --restore
```

```ini
# /etc/systemd/system/goaccess-report.timer
[Unit]
Description=Rebuild the analytics report every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true
[Install]
WantedBy=timers.target
```

Enable it once (a plain `systemctl enable --now` job, no `flock` needed for that
part), and the report refreshes itself forever. To keep it off the public
internet, either bind it behind the overlay or gate it in nginx:

```nginx
location /analytics/ {
    allow 10.144.144.0/24;   # the private overlay
    deny all;
}
```

That is the entire system: one binary, one timer, one gated path. It fits in a
laptop's worth of RAM and it never touches the reader.

## What log-based analytics honestly cannot do

I would rather name the limits than let you discover them after a migration.

- **It cannot measure attention.** Bounce rate, scroll, reading time, funnels —
  none of it. For a static site there is no second event to compare against. If
  "how long did they stay" is a real decision input for you, logs cannot answer
  it, and no amount of clever parsing will.
- **Bot traffic is permanent.** `--ignore-crawlers` removes the dumb ones. The
  rest — headless browsers, AI crawlers, link-preview fetchers, uptime monitors —
  inflate your numbers, and some lie about their user-agent. Treat raw counts as
  directional, not exact.
- **Referral data is noisy.** Privacy proxies strip the `Referer` header,
  in-app browsers send nothing, and some sites send self-referrals. "Direct"
  traffic is a bucket, not a truth. Your real referral insight often comes from
  one or two sources you care about, not the long tail.
- **Uniqueness is a guess.** IP-based counting over-counts shared networks and
  under-counts people who move between Wi-Fi and mobile. Good enough for
  "roughly how many", wrong for "exactly how many".
- **CDNs and caches hide requests.** If a CDN serves your static assets, a lot of
  traffic never reaches your origin, so the log sees less than the whole. That is
  fine — it just means the log is a sample, not a census.

None of these are fatal for a blog, and all of them are fatal for the belief
that a log report is a precise funnel tool. It is not, and it was never meant to
be.

## The rule: measure what changes your decisions

The reason I can live with coarse numbers is that I only act on two of them:
*which post brought a new reader*, and *which posts get read at all*. Everything
else — time on page, scroll depth, device breakdown to the pixel — has never once
changed a thing I did. A hundred failed experiments later, the only metrics that
have ever moved this site are the ones that told me what to write next.

So the bar for any **privacy-friendly analytics** setup is not "does it match GA
feature-for-feature." It is "does it tell me something I will act on, without
costing my reader privacy, speed, or a cookie banner." GoAccess over the logs
clears that bar with room to spare. If your site grows goals, funnels and a team
that needs shared dashboards, graduate to Umami or Plausible — deliberately, for
a reason, not by default.

If you want the rest of the box this runs on, the front door and TLS are in
[self-hosting without Docker](/posts/self-hosting-without-docker/), and where
this fits in the bigger picture is in
[what I self-host in 2026](/posts/what-i-self-host-2026/).

Measure less. Act more.
