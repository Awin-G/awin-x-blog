---
title: "Alertmanager in practice: routing, grouping, and silencing alerts without the noise"
description: "Alertmanager in practice from a throwaway Prometheus + Alertmanager lab: the config tree, alert routing and grouping, inhibition, silences with amtool, and real webhook payloads for firing and resolved alerts."
pubDate: 2027-01-17
lang: en
translationKey: alertmanager-in-practice
tags: [devops, self-hosting]
featured: false
keywords:
  - Alertmanager
  - alert routing
  - alert grouping
  - silence
  - inhibition
  - Prometheus rules
  - webhook receiver
---

Most people meet **Alertmanager** the day their alert channel becomes unusable: somebody's `up == 0` rule fires on fifty hosts, the notification count hits triple digits, and somebody "fixes" it by disabling the alert. I did the opposite: I booted a throwaway **Prometheus** and **Alertmanager** stack in Docker on `127.0.0.1`, broke a target on purpose, and watched what came out the other end. This is **alert routing**, **alert grouping**, **inhibition**, and **silence** proven with real webhook JSON — not a diagram of what ought to happen. Every block below is copied from the lab, unedited.

## The split of duties: Prometheus evaluates, Alertmanager decides

Two processes, one job each. Prometheus evaluates your **Prometheus rules** on an interval and POSTs the result to Alertmanager. Alertmanager does everything that is *not* "is this condition true": deduplication, grouping, routing, inhibition, silencing, retries, and the resolved notification.

The handoff is a few lines in `prometheus.yml`, and it is the only place Prometheus knows Alertmanager exists:

```yaml
# prometheus.yml (excerpt)
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["am-am:9093"]

rule_files:
  - /etc/prometheus/rules.yml
```

Which rules exist is a separate question — I covered them in [Prometheus in practice](/posts/prometheus-in-practice/). Here is the rule set that produced every alert in this post:

```yaml
# rules.yml
groups:
  - name: availability
    rules:
      - alert: TargetDown
        expr: up == 0
        for: 10s
        labels:
          severity: page
          team: infra

  - name: billing-symptoms
    rules:
      - alert: BillingErrorRateHigh
        expr: demo_app_error_rate > 0.2
        for: 20s
        labels: { severity: warning, service: billing }

      - alert: BillingLatencyHigh
        expr: demo_app_p95_latency_seconds > 0.5
        for: 20s
        labels: { severity: warning, service: billing }

      - alert: SharedDependencyDown
        expr: demo_switch_up == 0
        for: 10s
        labels: { severity: critical, service: billing }
```

The lab itself is five containers on one network, nothing privileged, nothing on a public port:

```bash
$ docker network create am-net
$ docker run -d --name am-node --network am-net \
    -v "$PWD/textfile:/textfile:ro" \
    prom/node-exporter:latest --collector.textfile.directory=/textfile
$ docker run -d --name am-app-exporter --network am-net prom/node-exporter:latest
$ docker run -d --name am-webhook --network am-net \
    -v "$PWD/webhook.py:/webhook.py:ro" python:3.13-alpine python3 /webhook.py 19195
$ docker run -d --name am-prom --network am-net -p 127.0.0.1:19190:9090 \
    -v "$PWD/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/rules.yml:/etc/prometheus/rules.yml:ro" prom/prometheus:latest
$ docker run -d --name am-am --network am-net -p 127.0.0.1:19193:9093 \
    -v "$PWD/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    prom/alertmanager:latest
```

Two targets, both real exporters; I stop one of them later. The symptom metrics come from node_exporter's textfile collector — a `.prom` file on disk that the collector re-reads on every scrape. I will be straight about that: the mechanism is real, the number is mine. I did it that way on purpose, and §Inhibition explains why.

Validate both halves before you trust them. A typo in either file is otherwise a container that starts and silently does nothing:

```text
$ docker exec am-am amtool check-config /etc/alertmanager/alertmanager.yml
Checking '/etc/alertmanager/alertmanager.yml'  SUCCESS
Found:
 - global config
 - route
 - 1 inhibit rules
 - 3 receivers
 - 0 templates

$ docker exec am-prom promtool check rules /etc/prometheus/rules.yml
Checking /etc/prometheus/rules.yml
  SUCCESS: 4 rules found
```

## The config tree: alert routing, `match` vs `matchers`, receivers, and the timing knobs

An Alertmanager config is a **tree**, and the tree is the whole product. Every alert enters at the root `route` and walks down until a route matches. First match wins unless a child sets `continue: true`; if nothing matches, the root's own `receiver` catches it — so the root must name a receiver, or the alert goes nowhere.

Each node can override the timing knobs, and the overrides are where the noise is actually controlled:

- **`group_by`** — the labels that define a *notification bucket*. The single most important field in the file.
- **`group_wait`** — how long to hold a *new* group before sending it, so a burst of alerts arriving together becomes one message.
- **`group_interval`** — the minimum gap between messages for a group that already knew about something.
- **`repeat_interval`** — how often to re-send a group that has not changed. The "is this still broken" heartbeat.

Here is the whole file I used — one root, two children, three receivers, one inhibition rule:

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  receiver: default-webhook        # root = catch-all, always names a receiver
  group_by: ['alertname']
  group_wait: 10s
  group_interval: 1m
  repeat_interval: 4h

  routes:
    # 1. Pages: one notification per alertname, fast repeat.
    - matchers:
        - severity = "page"
      receiver: webhook-page
      group_by: ['alertname']
      group_wait: 10s
      group_interval: 30s
      repeat_interval: 30s

    # 2. Symptoms of one service, bundled into ONE notification.
    - matchers:
        - service = "billing"
        - severity = "warning"
      receiver: webhook-billing
      group_by: ['service']
      group_wait: 10s
      group_interval: 30s
      repeat_interval: 1m

receivers:
  - name: default-webhook
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true
  - name: webhook-page
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true
  - name: webhook-billing
    webhook_configs:
      - url: http://am-webhook:19195/hook
        send_resolved: true

inhibit_rules:
  - source_matchers:
      - severity = "critical"
    target_matchers:
      - severity = "warning"
    equal:
      - service
```

Two config details before you copy this. `matchers` uses Prometheus label-selector syntax — `label = "x"`, `label != "x"`, `label =~ "re.*"` — and is the current form; `match` and `match_re` are the old equality-only ones and are deprecated. And `matchers` at one node are **ANDed**: the billing route matches `service="billing"` *and* `severity="warning"`, so a critical alert for billing falls through to the root receiver. Which is what happened — the critical alert arrived at `default-webhook`:

```text
webhook-page       firing    first notification  groupKey={}/{severity="page"}:{alertname="TargetDown"}
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{service="billing"}
default-webhook    firing    first notification  groupKey={}:{alertname="SharedDependencyDown"}
```

Three different buckets from three different route nodes in one run: the page route hashes on `{alertname}`, the billing route on `{service}`, and the unmatched critical alert inherits the root's.

<figure>
<svg viewBox="0 0 900 250" width="100%" role="img" aria-label="Firing alerts enter at the root route, are matched by child routes on labels such as severity or service, grouped by the group_by key, and leave as one notification per group; inhibited and silenced alerts never become a notification.">
  <defs>
    <marker id="am-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="8" y="14">alerts, from Prometheus</text>
    <text x="190" y="14">route tree</text>
    <text x="540" y="14">notifications</text>
  </g>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.75">
    <rect x="8" y="24" width="146" height="34" rx="6"/>
    <rect x="8" y="74" width="146" height="34" rx="6"/>
    <rect x="8" y="124" width="146" height="34" rx="6"/>
    <rect x="190" y="68" width="118" height="40" rx="6"/>
    <rect x="344" y="26" width="150" height="36" rx="6"/>
    <rect x="344" y="76" width="150" height="36" rx="6"/>
    <rect x="344" y="126" width="150" height="36" rx="6"/>
    <rect x="540" y="22" width="352" height="40" rx="6"/>
    <rect x="540" y="72" width="352" height="40" rx="6"/>
    <rect x="540" y="122" width="352" height="40" rx="6"/>
    <rect x="8" y="180" width="884" height="50" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none">
    <line x1="156" y1="41" x2="186" y2="74" marker-end="url(#am-arrow)"/>
    <line x1="156" y1="91" x2="186" y2="88" marker-end="url(#am-arrow)"/>
    <line x1="156" y1="141" x2="186" y2="102" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="44" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="94" marker-end="url(#am-arrow)"/>
    <line x1="310" y1="88" x2="340" y2="144" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="44" x2="536" y2="42" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="94" x2="536" y2="92" marker-end="url(#am-arrow)"/>
    <line x1="496" y1="144" x2="536" y2="142" marker-end="url(#am-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
    <text x="81" y="45" text-anchor="middle">TargetDown</text>
    <text x="81" y="95" text-anchor="middle">BillingErrorRateHigh</text>
    <text x="81" y="145" text-anchor="middle">BillingLatencyHigh</text>
    <text x="249" y="86" text-anchor="middle">route</text>
    <text x="249" y="100" text-anchor="middle" font-size="10">group_wait 10s</text>
    <text x="419" y="41" text-anchor="middle">severity = "page"</text>
    <text x="419" y="54" text-anchor="middle" font-size="9">group_by [alertname]</text>
    <text x="419" y="91" text-anchor="middle">service + warning</text>
    <text x="419" y="104" text-anchor="middle" font-size="9">group_by [service]</text>
    <text x="419" y="141" text-anchor="middle">(no match)</text>
    <text x="419" y="154" text-anchor="middle" font-size="9">root receiver</text>
    <text x="716" y="39" text-anchor="middle">webhook-page · 1 notification, 1 alert</text>
    <text x="716" y="89" text-anchor="middle">webhook-billing · 1 notification, 2 alerts</text>
    <text x="716" y="139" text-anchor="middle">default-webhook · the critical one</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="26" y="203">inhibit_rules (cause fires) and silences (maintenance) remove alerts from every group,</text>
    <text x="26" y="221">so the most common outcome is correctly "no notification at all".</text>
  </g>
</svg>
<figcaption>Alerts in, groups out. `group_by` is what turns a pile of firing series into a bounded number of notifications; the route tree only decides which bucket each pile lands in.</figcaption>
</figure>

## Alert grouping: why `group_by` decides whether you get 1 or 100 notifications

Grouping is the difference between a usable channel and a wall. Alertmanager hashes the `group_by` labels of every alert it holds, and one notification per hash bucket. Change the key and the same alert storm becomes a completely different number of messages.

I ran the identical alert set twice, changing only `group_by`, and the webhook log tells the whole story. With `group_by: ['service']` on the billing route, both symptom alerts land in one bucket and ship as **one notification containing two alerts**:

```text
[00:58:06] POST /hook status=firing receiver=webhook-billing
          groupLabels={'service': 'billing'} alerts=2 [BillingErrorRateHigh,BillingLatencyHigh]
```

The payload, trimmed of nothing:

```json
{
  "receiver": "webhook-billing",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "BillingErrorRateHigh", "instance": "am-node:9100", "job": "node", "service": "billing", "severity": "warning" },
      "annotations": { "summary": "Billing error rate 34%" },
      "startsAt": "2026-10-13T00:57:56.121Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "0efe0119f00205cf"
    },
    {
      "status": "firing",
      "labels": { "alertname": "BillingLatencyHigh", "instance": "am-node:9100", "job": "node", "service": "billing", "severity": "warning" },
      "annotations": { "summary": "Billing p95 latency 0.9s" },
      "startsAt": "2026-10-13T00:57:56.121Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "cde40a1a655a7af5"
    }
  ],
  "notification_reason": "first notification",
  "groupLabels": { "service": "billing" },
  "groupKey": "{}/{service=\"billing\",severity=\"warning\"}:{service=\"billing\"}",
  "truncatedAlerts": 0
}
```

Note the arithmetic, because it makes `group_wait` concrete: the alerts' `startsAt` is `00:57:56.121` and the notification arrived at `00:58:06.149`. Ten seconds — exactly `group_wait: 10s`. The rule's `for: 20s` is the other ten seconds before that. *That* is why a burst of fifty alarms becomes one message.

Then I restarted Alertmanager with the billing route's `group_by: ['alertname']` and re-armed the same two alerts. Same data, same rules, one field changed:

```text
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{alertname="BillingErrorRateHigh"}  alerts=1
webhook-billing    firing    first notification  groupKey={}/{service="billing",severity="warning"}:{alertname="BillingLatencyHigh"}   alerts=1
```

Two notifications, one alert each, arriving separately. Multiply that by fifty hosts and you have the wall of noise — built entirely out of a `group_by` list. The practical rules: group by something a human owns (`service`, `team`, `cluster`), never by `instance` or any other high-cardinality label. And when a group's contents change while it is already open, `group_interval` is the minimum wait before you hear about it — the throttle that stops a flapping alert from becoming a chat channel's metronome.

## A real firing → resolved lifecycle: `up{job="app"} == 0`

Grouping is only half the product. The other half is that an alert has a life, and you hear about both ends of it. I stopped the `app` target and watched Prometheus's own view of it:

```text
# t+0s   targets up: up{job="app",instance="am-app-exporter:9100"} => 1
# stopping am-app-exporter
--- t+10s  ALERTS:       TargetDown{alertstate=pending,instance=am-app-exporter:9100,job="app",severity="page"} => 1
--- t+15s  ALERTS:       TargetDown{alertstate=pending,instance=am-app-exporter:9100,job="app",severity="page"} => 1
--- t+20s  ALERTS:       TargetDown{alertstate=firing,instance="am-app-exporter:9100",job="app",severity="page"} => 1
--- t+20s  ALERTS_FOR_STATE: TargetDown{instance="am-app-exporter:9100",job="app"} => 1791853231
```

`pending` for the `for: 10s` I wrote in the rule, then `firing`. `ALERTS` and `ALERTS_FOR_STATE` are how you read Prometheus alert state from outside Prometheus — the first is the alert as a metric, the second the Unix timestamp of when it entered that state. The notification that followed is the `up{job="app"}` alert, one alert, `status: firing`:

```json
{
  "receiver": "webhook-page",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "TargetDown", "instance": "am-app-exporter:9100", "job": "app", "severity": "page", "team": "infra" },
      "annotations": { "summary": "Target app/am-app-exporter:9100 is down" },
      "startsAt": "2026-10-13T01:00:41.813Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "fingerprint": "5720e89ba7a86cdf"
    }
  ],
  "notification_reason": "first notification",
  "commonLabels": { "alertname": "TargetDown", "job": "app", "severity": "page" },
  "externalURL": "http://am-am:9093"
}
```

And because `repeat_interval` was 30 seconds on that route (deliberately short so the demo does not take four hours), the heartbeat showed up too — `notification_reason: "repeat interval elapsed"`, same group, no change. That field is the one to grep on: it tells a receiver whether this is news or just a pulse. Then I started the container again, and the other end of the lifecycle arrived:

```text
webhook-page   resolved   all alerts resolved   groupKey={}/{severity="page"}:{alertname="TargetDown"}  alerts=1
```

`status: resolved`, with a real `endsAt` instead of the zero timestamp. Two things follow. Always set `send_resolved: true` — a resolved notification is what closes a page in your head, and without it silence means both "still broken" and "fixed". And `resolve_timeout: 5m` is the safety net: if Prometheus disappears and stops telling Alertmanager anything, alerts auto-resolve after five minutes instead of paging forever.

The receiver itself was twenty lines of Python, because a webhook is just an HTTP endpoint:

```python
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        data = json.loads(body)          # let it raise: we want to know

        names = ",".join(a["labels"].get("alertname", "?") for a in data.get("alerts", []))
        print(f'[{datetime.now():%H:%M:%S}] status={data.get("status")} '
              f'receiver={data.get("receiver")} alerts={len(data.get("alerts", []))} [{names}]', flush=True)

        self.send_response(200)          # anything 2xx, or Alertmanager retries
        self.end_headers()
        self.wfile.write(b"ok")
```

Log the raw body. When the alert is wrong you need the exact JSON, not a human summary; and if you keep those payloads, [structured logging](/posts/structured-logging/) is how you make them searchable afterwards — the fields above are already structured.

## Inhibition: suppress the symptom when the cause fires

**Inhibition** is the rule that says: when the cause fires, shut up about the symptoms. My rule: any `severity: critical` alert suppresses `severity: warning` alerts that carry the same `service`. I set `demo_switch_up{service="billing"}` to `0`, the shared dependency rule went critical, and the two symptom alerts — which were firing and being repeated every minute — stopped being notified. Alertmanager's own API shows exactly what it decided:

```text
$ curl -s localhost:19193/api/v2/alerts | jq -r '.[] | "\(.labels.alertname) \(.status.state)"'
BillingErrorRateHigh   suppressed
SharedDependencyDown    active
BillingLatencyHigh     suppressed

$ docker exec am-am amtool alert query            # what a human should act on
Alertname             Starts At                Summary                                          State
SharedDependencyDown  2026-10-13 01:07:46 UTC  Shared switch/rabbit for billing is unreachable  active

$ docker exec am-am amtool alert query --inhibited # what was swallowed, and why it matters
Alertname             Starts At                Summary                   State
BillingErrorRateHigh  2026-10-13 00:57:56 UTC  Billing error rate 34%   suppressed
BillingLatencyHigh    2026-10-13 00:57:46 UTC  Billing p95 latency 0.9s  suppressed
```

`inhibitedBy` in the raw API names the fingerprint of the alert doing the suppressing — that is the whole audit trail, and it is why you should design around it. A suppressed alert is not deleted: it is held, and it comes back the moment the cause resolves (I flipped the switch back to `1` and the symptom group resumed).

Two honest caveats. Inhibition needs the cause and the symptom to be **firing at the same time** with a shared label to match on — `equal: [service]` here, naming a label present on *both*. And the pattern is weaker than it sounds when the target is genuinely gone: a host that stops responding takes its own metrics with it, so `up == 0` fires while that host's CPU, latency and disk alerts simply vanish rather than needing suppression. That is the limitation my textfile symptom was simulating, and it is why inhibition earns its keep for *shared* dependencies — a switch, a database, a queue, a DNS resolver — where forty dependents keep reporting that they cannot reach it.

## Silence: a maintenance window with an expiry date

A **silence** is a manual, time-boxed mute. Not a config change, not a restart, no reload: you tell a running Alertmanager to stop notifying for an alert set. `amtool` is the CLI for it, and it lives inside the official image:

```text
$ docker exec am-am amtool silence add service="billing" severity="warning" \
    --duration=15m --comment="planned billing maintenance: rolling restart of the exporter"
a6f1d79a-d08a-4008-b828-90d29ac20f57

$ docker exec am-am amtool silence query
ID                                    Matchers                              Ends At                  Created By  Comment
a6f1d79a-d08a-4008-b828-90d29ac20f57  service="billing" severity="warning"  2026-10-13 01:25:29 UTC  nobody      planned billing maintenance: rolling restart of the exporter
```

What "works" means, precisely: the alert kept firing, and the notifications stopped.

```text
$ curl -s localhost:19193/api/v2/alerts | jq -r '.[] | "\(.labels.alertname) state=\(.status.state) silencedBy=\(.status.silencedBy)"'
BillingErrorRateHigh state=suppressed silencedBy=['a6f1d79a-d08a-4008-b828-90d29ac20f57']
BillingLatencyHigh state=suppressed silencedBy=['a6f1d79a-d08a-4008-b828-90d29ac20f57']
```

The last repeat had gone out at `01:09:51`; with `repeat_interval: 1m` the next was due at `01:10:51`. At `01:13` there had been nothing since the silence was created at `01:10:29`, and two minutes of silence is proof enough when the interval is one minute. `silencedBy` carries the silence ID, so every mute is attributable to a comment and an end time — which is the point. Silence the narrowest matcher you can (`service="billing" severity="warning"`, not `alertname=~".+"`), give it the length of the maintenance window and not a minute more, and delete it with `amtool silence expire <id>` when you are done. A silence is a promise that someone will look at this later.

## The anti-patterns, since the config is the easy part

The honest list, learned the expensive way:

- **Alert on symptoms, not causes.** "CPU at 90%" is a fact; "disk will be full inside the retention window" is a task. A cause alert (`up == 0`) is nearly always the actionable one; symptoms are context for it, which is what inhibition is for.
- **Page only on actionable.** `severity: page` should mean "wake a human up". Thirty page rules means zero — the fix is routing them to a non-paging receiver, not deleting them.
- **Do not silence your way out of a broken alert.** A silence that never expires is a deleted alert with extra steps. If you re-create it every week, the rule is wrong.
- **Never group by a high-cardinality label.** `group_by: [instance]` is one notification per host; put `instance` or a pod name in `group_by` and you have built the wall yourself.
- **Say what to do, in the alert.** Annotations are the only text a human reads at 03:00. A runbook link and a sentence naming the service beat a wall of labels.

Alertmanager is not a notifier, it is a noise filter with a notifier bolted on. Once you see that, the config reads differently: every field is a decision about how much a human should be interrupted, and `group_by` is the one that decides whether the channel survives its first bad night.

The lab was five containers, two files, and fifteen minutes, and it came apart the same way:

```bash
$ docker rm -f am-prom am-am am-node am-app-exporter am-webhook && docker network rm am-net
am-prom
am-am
am-node
am-app-exporter
am-webhook
am-net
```
