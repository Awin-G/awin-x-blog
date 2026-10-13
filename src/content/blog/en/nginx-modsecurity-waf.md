---
title: "An nginx WAF for real: ModSecurity + OWASP CRS, tested against SQLi, XSS, and path traversal"
description: "A hands-on nginx WAF test: nginx + ModSecurity + OWASP CRS 4.30 blocking a real SQL injection, XSS, and path traversal with 403s and real audit-log rule IDs (942100, 941100, 930110) — plus DetectionOnly rollout, false positives, latency, and where a WAF actually fits."
pubDate: 2027-01-19
lang: en
translationKey: nginx-modsecurity-waf
tags: [security, nginx]
featured: false
keywords:
  - ModSecurity
  - OWASP CRS
  - WAF
  - nginx WAF
  - SQL injection
---

I put a **WAF** in front of nginx this week: **ModSecurity** with the
**OWASP Core Rule Set**, standing in front of a throwaway app bound to
`127.0.0.1`. Then I fired three classic attacks at it — a **SQL injection**,
an XSS payload, and a path traversal — and watched what happened. All three
came back `403`, and the audit log named the exact rule that caught each one.
This post is that run, the real output included, plus the part vendors bury:
the false positive it produced in the first five minutes, the latency it adds,
and why an **nginx WAF** is a mitigation, not a fix.

## What a WAF is — and what it is not

A **web application firewall** filters HTTP requests *before* your
application sees them. It sits in the request path — in nginx, as the
`modsecurity` module — inspects the method, URI, headers, arguments and body,
and returns `403` when a request looks like an attack. Two families of
detection matter here:

- **Signature-based**: match the request against known attack shapes, either
  by regex or by an engine like libinjection. This is what the CRS is.
- **Anomaly/scoring-based**: every match adds points; cross a threshold and
  the request is denied. The CRS is also this — the signatures feed the score.

What a WAF is **not**:

- **Not a fix for your app.** A blocked SQL injection against
  `?id=1' OR '1'='1` means one attack string was caught. The injection bug
  behind it is untouched.
- **Not a network firewall.** It speaks HTTP; it will not replace nftables,
  fail2ban, or a host that is actually patched.
- **Not magic.** Encoding tricks, multipart bodies, and rules tuned loose
  give bypasses. A WAF raises the cost of an attack; it does not end it.

<figure>
<svg viewBox="0 0 640 176" width="100%" role="img" aria-label="Request path: a client request enters nginx with ModSecurity and the OWASP CRS, whose rules add to an anomaly score. A score below five lets the request through to the app as a normal 200; a score of five or more is denied with 403 and written to the audit log.">
  <defs>
    <marker id="wafAr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="10" y="62" width="118" height="46" rx="8"/>
    <rect x="452" y="26" width="128" height="44" rx="8"/>
    <rect x="452" y="104" width="128" height="44" rx="8"/>
  </g>
  <g stroke="#0f766e" stroke-width="2" fill="none">
    <rect x="212" y="16" width="176" height="140" rx="8"/>
    <path d="M128 85 h76" marker-end="url(#wafAr)"/>
    <path d="M388 62 C418 62 424 48 448 48" marker-end="url(#wafAr)"/>
    <path d="M388 108 C418 108 424 124 448 126" marker-end="url(#wafAr)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="69" y="82">HTTP request</text>
    <text x="69" y="99" opacity="0.7" font-size="11">any client</text>
    <text x="300" y="44" font-weight="600">nginx</text>
    <text x="300" y="64">ModSecurity</text>
    <text x="300" y="84">OWASP CRS</text>
    <text x="300" y="110" opacity="0.75" font-size="11">942100 SQLi +5</text>
    <text x="300" y="126" opacity="0.75" font-size="11">941100 XSS +5</text>
    <text x="516" y="46">backend app</text>
    <text x="516" y="63" font-size="11" opacity="0.75">200, proxied</text>
    <text x="516" y="124">403 + audit log</text>
    <text x="516" y="141" font-size="11" opacity="0.75">949110, id, score</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" fill="#0f766e">
    <text x="418" y="42">score &lt; 5</text>
    <text x="418" y="140">score ≥ 5</text>
  </g>
</svg>
<figcaption>Every request runs through the CRS before the app is involved: signature hits accumulate into an anomaly score, a low score is proxied onward, and a score at or over the inbound threshold is denied and audited.</figcaption>
</figure>

## ModSecurity and the OWASP CRS

**ModSecurity** is the engine: `libmodsecurity3` plus an nginx connector. In
your config it is three lines — `modsecurity on;` in the server or http
block, a rules file, and `SecRuleEngine`:

```nginx
modsecurity on;
modsecurity_rules_file /etc/modsecurity.d/setup.conf;
```

The CRS is the rule pack that file points at. This is the real include chain
inside the container I used (modsecurity 3.0.17 rules-loader style):

```nginx
# /etc/modsecurity.d/setup.conf — inside the owasp/modsecurity-crs image
Include /etc/modsecurity.d/modsecurity.conf
Include /etc/modsecurity.d/modsecurity-override.conf
Include /etc/modsecurity.d/owasp-crs/crs-setup.conf
Include /etc/modsecurity.d/owasp-crs/rules/*.conf
```

`crs-setup.conf` is the policy: thresholds, paranoia level, scoring. The real
values in the run below (lines 280–341 of the shipped file):

```nginx
setvar:tx.critical_anomaly_score=5,
setvar:tx.error_anomaly_score=4,
setvar:tx.warning_anomaly_score=3,
setvar:tx.notice_anomaly_score=2
setvar:tx.inbound_anomaly_score_threshold=5,
setvar:tx.outbound_anomaly_score_threshold=4
```

So one CRITICAL rule hit (SQL injection) adds 5 and tips the request over the
threshold of 5 by itself; two WARNING hits would add 3 each and get there too.
Rules live in numbered attack-category files — the ones that matter for the
three classic attacks:

| Rule file | Family | What it catches |
|---|---|---|
| `REQUEST-942-...SQLI.conf` | 942100+ | SQL injection (regex + libinjection) |
| `REQUEST-941-...XSS.conf` | 941100+ | Cross-site scripting payloads |
| `REQUEST-930-...LFI.conf` | 930100+ | Local file inclusion / path traversal |
| `REQUEST-949-BLOCKING-EVALUATION.conf` | 949110 | The rule that actually denies |

Every rule carries a stable `[id]`, a `[msg]`, and tags including its
`paranoia-level`. **Paranoia levels** (PL) 1–4 decide how aggressive the pack
is: PL1 is the low-false-positive default, PL2 blocks significantly more and
costs you more tuning, PL3–PL4 are for APIs that can justify treating
innocent input as hostile. Raise the level only with an audit log in hand.

## The lab: what I actually ran

A docker network, a tiny Python echo app, and the official image. Only my own
machine — this is the authorised-use lab, permission to poke myself:

```bash
docker network create waf-lab

# tiny app: answers "app-200: <method> <path>" to everything
docker run -d --name backend --network waf-lab \
  -v $PWD/backend.py:/backend.py:ro \
  python:3-alpine3.23 python /backend.py

# nginx 1.30.5 + ModSecurity-nginx 1.0.4 (libmodsecurity3 3.0.17) + CRS 4.30.0
docker run -d --name waf-on --network waf-lab -p 127.0.0.1:8088:8080 \
  -e BACKEND='http://backend:8000' \
  -e MODSEC_RULE_ENGINE=on \
  -e MODSEC_AUDIT_ENGINE=RelevantOnly \
  -e MODSEC_AUDIT_LOG=/tmp/modsecurity/audit.log \
  -e MODSEC_AUDIT_LOG_FORMAT=Native \
  owasp/modsecurity-crs:4.30.0-nginx-202610051210
```

That `MODSEC_RULE_ENGINE=on` env var is what writes `SecRuleEngine on` into
the generated config — the same contrast the classic directive form gives
you: `SecRuleEngine On` denies, `SecRuleEngine DetectionOnly` only logs.

## A normal request passes through

```bash
$ curl -s 'http://127.0.0.1:8088/api/items?id=42'
app-200: GET /api/items?id=42 from 172.22.0.3
```

`200`, straight from the backend, in about 5 ms over loopback. The WAF adds
no visible behaviour to harmless traffic — by design, it should be invisible
here. (One nuance: the audit engine logged even this request, because a
harmless WARNING rule fired on it. More on that below.)

## Three real attacks, three 403s

Same WAF, same second, three payloads that every scanner on earth sends:

```bash
$ curl -s -G 'http://127.0.0.1:8088/api/items' \
    --data-urlencode "id=1' OR '1'='1" -o /dev/null -w '%{http_code}\n'
403

$ curl -s -G 'http://127.0.0.1:8088/search' \
    --data-urlencode "q=<script>alert(1)</script>" -o /dev/null -w '%{http_code}\n'
403

$ curl -s -G 'http://127.0.0.1:8088/download' \
    --data-urlencode "file=../../etc/passwd" -o /dev/null -w '%{http_code}\n'
403
```

The backend never saw them — its logs show only the benign request from
earlier. This is what a signature WAF is for: the boring, high-volume,
never-going-away attack patterns, caught in microseconds before the
application is involved.

## Reading the audit log: what the rule IDs tell you

Everything above is visible in the audit trail. One record looks like this
(the parts in braces are the longest regex lines, cut for width):

```
---YBrOqrfy---A--
[13/Oct/2026:00:49:45 +0000] 179185258531.775734 172.22.0.1 33924 172.22.0.3 8080
---YBrOqrfy---B--
GET /api/items?id=1%27+OR+%271%27%3D%271 HTTP/1.1
Host: 127.0.0.1:8088
User-Agent: curl/8.22.0
Accept: */*

---YBrOqrfy---H--
ModSecurity: Warning. detected SQLi using libinjection. [file "/etc/modsecurity.d/owasp-crs/rules/REQUEST-942-APPLICATION-ATTACK-SQLI.conf"] [line "46"] [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"] [data "Matched Data: s&sos found within ARGS:id: 1' OR '1'='1"] [severity "2"] [ver "OWASP_CRS/4.30.0"] ... [tag "paranoia-level/1"] [uri "/api/items"] [unique_id "179185258531.775734"]
ModSecurity: Access denied with code 403 (phase 2). Matched "Operator `Ge' with parameter `5' against variable `TX:BLOCKING_INBOUND_ANOMALY_SCORE' (Value: `8' ) [file "/etc/modsecurity.d/owasp-crs/rules/REQUEST-949-BLOCKING-EVALUATION.conf"] [line "222"] [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 8)"]

---YBrOqrfy---Z--
```

Section `A` is the transaction header, `B` the request line and headers,
`H` the messages — this is where rule IDs live — and `Z` closes the record.
The set of parts is configurable (this image logs `ABIJDEFHZ`).

The decisive line is **949110**: rule 942100 added 5 points to the inbound
score, the Host-header warning added 3 more, 8 ≥ 5, and the transaction was
denied in phase 2. Note which rules did the catching:

```text
$ grep -oE '\[id "[0-9]+"\] \[rev "[^"]*"\] \[msg "[^"]+"\]' audit.log | sort | uniq -c | sort -rn | head
     91 [id "920350"] [rev ""] [msg "Host header is a numeric IP address"]
      3 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 8)"]
      2 [id "942100"] [rev ""] [msg "SQL Injection Attack Detected via libinjection"]
      2 [id "930110"] [rev ""] [msg "Path Traversal Attack (/../) or (/.../)"]
      1 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 33)"]
      1 [id "949110"] [rev ""] [msg "Inbound Anomaly Score Exceeded (Total Score: 23)"]
      1 [id "941100"] [rev ""] [msg "XSS Attack Detected via libinjection"]
      1 [id "941110"] [rev ""] [msg "XSS Filter - Category 1: Script Tag Vector"]
      1 [id "941160"] [rev ""] [msg "NoScript XSS InjectionChecker: HTML Injection"]
      1 [id "941390"] [rev ""] [msg "Javascript method detected"]
      1 [id "930100"] [rev ""] [msg "Path Traversal Attack (/../) or (/.../)"]
      1 [id "930120"] [rev ""] [msg "OS File Access Attempt"]
      1 [id "932160"] [rev ""] [msg "Remote Command Execution: Unix Shell Code Found"]
```

The scores tell the story: the SQLi scored 8, the XSS stacked four XSS rules
(scores 23), the traversal tripped LFI *and* RCE rules (33). And that first
line — 91 hits on 920350 — is the tuning story.

## The false positive I found in the first five minutes

Not everything the CRS blocks is an attack. While probing for benign traffic
I sent a search string with comparison operators in it:

```bash
$ curl -s -G 'http://127.0.0.1:8088/search' \
    --data-urlencode "q=python3 < vs >" -o /dev/null -w '%{http_code}\n'
403
```

Audit log: rule **932260**, "Remote Command Execution: Direct Unix Command
Execution", CRITICAL, +5 — blocked. A user searching for `python3 < vs >`
gets a bare `403` page and no idea why. That is the everyday experience of
running a WAF at PL1 on a text-driven app: markdown posts, code snippets,
log lines, regex patterns in forms — real content looks like shell metacharacters.

My lab made it worse: I curled by IP, so the warning rule 920350 ("Host
header is a numeric IP address", +3) fired on *every* request, 91 times in
this log. Three free points on every transaction is three points closer to a
deny. On a real deployment with a real `server_name` that rule stays quiet —
but it demonstrates how warning-level noise accumulates into anomaly score.

## DetectionOnly: log first, block later

This is the rollout mode nobody should skip, and it is a one-line change:
`SecRuleEngine DetectionOnly` (in this image, `-e MODSEC_RULE_ENGINE=DetectionOnly`).
Rules execute, the audit log records the matched IDs and the score, and
nothing is ever denied. I ran the same three attacks against a second
container configured exactly that way:

```text
benign:     HTTP 200
sqli:       HTTP 200
xss:        HTTP 200
traversal:  HTTP 200

$ curl -s -G 'http://127.0.0.1:8089/api/items' --data-urlencode "id=1' OR '1'='1"
app-200: GET /api/items?id=1%27+OR+%271%27%3D%271 from 172.22.0.4
```

The SQL injection was **delivered to the application** — while the audit log
still shows 942100 and a score of 8:

```text
$ docker exec waf-detect grep -c "Access denied" /tmp/modsecurity/audit.log
0

$ grep 942100 audit.log | grep -oE '\[id "942100"\].*paranoia-level/1' | head -1
[id "942100"] ... [msg "SQL Injection Attack Detected via libinjection"] ... [tag "paranoia-level/1"]
```

That is the workflow: DetectionOnly, watch 949110 scores and 920xxx warnings
for a week, write exclusions for what your real traffic looks like, then flip
to `On`. Without this step you are gambling your traffic on rules written for
the whole internet.

## The honest costs

- **False positives that break legit requests.** The 932260 block above is
  trivial; in the wild it is search pages, rich-text editors, JSON APIs with
  `<` in values, and file uploads. Every false positive is a customer who
  cannot use your site and a support ticket you cannot explain.
- **The tuning burden never ends.** CRS releases move rule IDs, tighten
  regexes, and re-scored my log between versions (this run is 4.30.0).
  Upgrading means re-running DetectionOnly. Exclusion rules
  (`SecRuleRemoveById`, tag-based exclusions) are part-time work.
- **Latency.** On loopback with tiny requests, median over 50 runs: plain
  nginx proxy **1.06 ms**, DetectionOnly **2.80 ms**, blocking **2.74 ms**.
  Modest per request, but it doubles round-trips for trivial traffic, grows
  with body size (the whole body is buffered and scanned), and is CPU work
  on every single request.
- **Log volume.** That lab produced 132 KB of audit log across 90
  transactions — about 1.5 KB per request in `Native` format. With the
  default JSON format it is larger. For a busy site that is a logging
  pipeline decision, not an afterthought.
- **A mitigation, not a fix.** While the WAF blocks the payload, the
  injection remains in the app. Any bypass — a new encoding, an uncovered
  rule — reopens the hole. The WAF buys you time to fix it properly.

## Where a WAF fits for a small self-hoster

For a one-person homelab or a small VPS:

- **You are behind a CDN's managed WAF (Cloudflare and friends)?** You
  already have signature filtering at the edge. Bolt ModSecurity on only for
  what the CDN cannot see, which is usually little.
- **You run your own reverse proxy in front of dynamic apps (a blog with
  comments, a wiki, anything with a login)?** This is the sweet spot: CRS in
  DetectionOnly, then `On` after a week of clean logs, per-location where
  needed.
- **Your site is static?** Skip it. A static file server gains almost
  nothing from request inspection, and your effort is better spent on the
  response headers and origin lockdown I covered in
  [web security headers](/posts/web-security-headers/). The nginx mechanics
  — location matching, proxying, the `add_header` trap — are in my
  [nginx config cookbook](/posts/nginx-cookbook/).
- **Either way**, put the WAF where the logs land: the CRS audit log is the
  product, far more than the 403s are. A 403 in the access log only tells you
  an attack happened; the 949110 score tells you whether your rules still fit
  your traffic.

The whole lab ran on one box in under ten minutes: two containers, one
network, zero privileged ports. The 403s are real, the rule IDs are real,
and so is the `python3 < vs >` user who would have been blocked. Run it in
DetectionOnly first — the log will tell you what your traffic actually
looks like before you decide what to break.

*Everything above was tested only against my own throwaway containers on
`127.0.0.1`. Run attack traffic against systems you own or have written
permission to test.*
