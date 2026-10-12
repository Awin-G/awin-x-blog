---
title: "Grafana in practice: dashboards as code, not as clicking"
description: "A throwaway Grafana + Prometheus stack on 127.0.0.1, provisioned entirely from files. What Grafana actually is (a viewer, not a TSDB), Grafana provisioning for datasources and dashboards as code, the query editor vs raw PromQL, panels that lie, templating, and alerting — with real API output."
pubDate: 2026-12-15
lang: en
translationKey: grafana-in-practice
tags: [devops, self-hosting]
featured: false
keywords:
  - Grafana
  - Grafana provisioning
  - dashboards as code
  - Prometheus datasource
  - templating
---

I have clicked a dashboard together more than once, then lost it: no export, no version control, a panel someone renamed and nobody remembers why. **Grafana** is a viewer you point at a data source, and the click-first workflow is the wrong default. This post is the opposite one: a throwaway Grafana plus Prometheus and node_exporter on `127.0.0.1`, with a **Prometheus datasource**, a dashboard, and an alert rule all delivered by **Grafana provisioning** — *dashboards as code*, files in git, reproduced with one command. Every block of output below came out of that stack, unedited.

## What Grafana is — and what it is not

Grafana stores almost nothing. It is a query front end: you choose a **data source** (Prometheus, Loki, PostgreSQL, InfluxDB, Elasticsearch, a pile of others), write a query, and Grafana draws the result. It keeps dashboards, variables, users, and alert state in its own SQLite/Postgres database — but it does **not** keep your metrics.

That single fact settles most arguments:

- **Not a time-series database.** Sample retention, downsampling, and cardinality belong to Prometheus (or VictoriaMetrics, Mimir, etc.). Grafana reads; it does not own the samples. If your Grafana is slow, look at the query and the datasource before you blame the renderer.
- **Not a collector.** Nothing scrapes your hosts into Grafana. Prometheus pulls `/metrics`; Grafana asks Prometheus.
- **Not the source of truth.** Since everything is a file, the running Grafana is a cache of your repo. Clicking is a temporary convenience, not the artifact.

The data flow is deliberately boring: datasource holds samples, Grafana reads them, and dashboards and alerts are the two readers. Here is the picture for this stack.

<figure>
<svg viewBox="0 0 700 230" width="100%" role="img" aria-label="A Prometheus datasource holds the metrics; Grafana queries it through a provisioned data source and renders the results into provisioned dashboards and provisioned alert rules. The datasource, dashboards, and alert rules are all delivered as files by Grafana provisioning.">
  <defs>
    <marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g stroke="currentColor" fill="none" stroke-width="1.5" opacity="0.7">
    <rect x="8" y="80" width="150" height="70" rx="8"/>
    <rect x="270" y="80" width="150" height="70" rx="8"/>
    <rect x="532" y="22" width="160" height="54" rx="8"/>
    <rect x="532" y="96" width="160" height="54" rx="8"/>
    <rect x="532" y="170" width="160" height="52" rx="8" stroke-dasharray="5 4"/>
  </g>
  <g stroke="#0f766e" stroke-width="1.6" fill="none" color="#0f766e">
    <line x1="158" y1="115" x2="266" y2="115" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="112" x2="528" y2="52" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="117" x2="528" y2="122" marker-end="url(#g-arrow)"/>
    <line x1="420" y1="122" x2="528" y2="194" marker-end="url(#g-arrow)"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">
    <text x="83" y="110" text-anchor="middle">data source</text>
    <text x="345" y="110" text-anchor="middle">Grafana</text>
    <text x="612" y="54" text-anchor="middle">Dashboards</text>
    <text x="612" y="128" text-anchor="middle">Alerts</text>
    <text x="612" y="200" text-anchor="middle">provisioning</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.75">
    <text x="83" y="130" text-anchor="middle">Prometheus / Loki…</text>
    <text x="345" y="130" text-anchor="middle">query + render</text>
    <text x="612" y="71" text-anchor="middle">JSON files</text>
    <text x="612" y="145" text-anchor="middle">YAML files</text>
    <text x="612" y="218" text-anchor="middle">YAML files</text>
    <text x="212" y="103" text-anchor="middle">PromQL</text>
  </g>
</svg>
<figcaption>Grafana owns no samples. It queries a data source and renders; the dashboards and alerts are files, loaded on boot by Grafana provisioning.</figcaption>
</figure>

## Grafana provisioning: the Prometheus datasource as code

The fastest way to make a Grafana claim reproducible is to never configure it by hand. `GF_PATHS_PROVISIONING` points at a directory (by default `/etc/grafana/provisioning`) that Grafana scans at startup: `datasources/` for datasources, `dashboards/` for dashboard providers, `alerting/` for alert rules. Mount that directory read-only and the container's whole configuration is a folder in your repo.

Here is the compose stack — three services, `127.0.0.1` only, no privileged flags:

```yaml
# docker-compose.yml
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports: ["127.0.0.1:19090:9090"]

  node-exporter:
    image: prom/node-exporter:latest

  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
      - ./dashboards:/var/lib/grafana/dashboards:ro
    ports: ["127.0.0.1:3000:3000"]
```

The **Prometheus datasource** is one small file. The `uid` matters: dashboards reference the datasource by that stable id, not by display name, so renaming a datasource never breaks a panel.

```yaml
# provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prom-main
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      httpMethod: POST
      timeInterval: 5s
```

`access: proxy` means Grafana's backend makes the request to Prometheus — the browser never needs to reach it, which is why this works with Prometheus on a private `127.0.0.1`. Bring it up and ask Grafana what it loaded:

```bash
$ docker compose up -d
$ curl -s localhost:3000/api/health
{
  "database": "ok",
  "version": "13.2.3",
  "commit": "90ffed056f0884267356c12a0eeb72a022af53f1"
}

$ curl -s -u admin:admin localhost:3000/api/datasources | # trimmed
  python3 -c '...'
name=Prometheus uid=prom-main type=prometheus isDefault=True readOnly=True
```

`readOnly: true` is the payoff: a provisioned datasource cannot be edited in the UI. The file wins. Grafana says so in its own logs:

```text
logger=provisioning.datasources msg="inserting datasource from configuration" name=Prometheus uid=prom-main
logger=provisioning.dashboard msg="starting to provision dashboards"
logger=provisioning.alerting msg="finished to provision alerting"
```

## Dashboards as code: the JSON is the artifact

A dashboard provider is the bridge between the file tree and Grafana's database. It says which folder the JSON files live in and whether the UI may override them:

```yaml
# provisioning/dashboards/dashboards.yml
apiVersion: 1
providers:
  - name: homelab
    orgId: 1
    folder: Homelab
    type: file
    disableDeletion: true
    updateIntervalSeconds: 30
    allowUiUpdates: false        # the file is authoritative
    options:
      path: /var/lib/grafana/dashboards
```

`allowUiUpdates: false` and `disableDeletion: true` are the two lines that make this *as code*. The dashboard is a plain JSON document — `uid`, `title`, a `templating` block, and a `panels` array. A panel is a data source, a query, and a display type:

```json
{
  "uid": "node-overview",
  "title": "Node Overview (provisioned)",
  "templating": { "list": [ { "name": "instance",
    "type": "query",
    "query": "label_values(up{job=\"node\"}, instance)",
    "includeAll": true, "multi": true } ] },
  "panels": [
    { "type": "stat",  "title": "Targets up",
      "targets": [ { "expr": "sum(up{job=\"node\", instance=~\"$instance\"})" } ] },
    { "type": "gauge", "title": "Memory available %",
      "targets": [ { "expr":
        "100 * node_memory_MemAvailable_bytes{instance=~\"$instance\"} / node_memory_MemTotal_bytes{instance=~\"$instance\"}" } ] }
  ]
}
```

Search the API and the dashboard is there, tagged and folder-scoped, and the metadata confirms it came from a file rather than from a click:

```bash
$ curl -s -u admin:admin 'localhost:3000/api/search?type=dash-db' | # trimmed
  python3 -c '...'
uid=node-overview title="Node Overview (provisioned)" tags=[node, provisioned] folder=Homelab

$ curl -s -u admin:admin localhost:3000/api/dashboards/uid/node-overview | # trimmed
  python3 -c '...'
provisioned=True provisionedExternalId="node-overview.json"
panels=4 vars=[instance]
```

That is the whole idea of **dashboards as code**: a git diff shows what changed, a review catches the bad panel, and a fresh Grafana rebuilds itself. Give each dashboard a file; give each datasource a `uid`; never let the UI be the only copy.

## The query editor vs raw PromQL

Grafana's query editor is a PromQL builder: a metric picker, a label filter, a function menu, an "explain" panel. It is good for discovery — find the metric name, see the labels. It is a lossy translation of the query you actually run, and some of what it produces is ugly on purpose (auto-generated regex filters, a chain of functions you did not write).

Every panel ultimately sends a PromQL string to the datasource. You can send the same string by hand, through Grafana's own proxy, and see exactly what the panel sees:

```bash
$ curl -s -u admin:admin \
    'localhost:3000/api/datasources/proxy/uid/prom-main/api/v1/query' \
    --data-urlencode 'query=up'
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      { "metric": { "__name__": "up", "env": "demo", "instance": "node-exporter:9100",
                    "job": "node", "role": "host" }, "value": [1791798871.408, "1"] },
      { "metric": { "__name__": "up", "instance": "localhost:9090",
                    "job": "prometheus" }, "value": [1791798871.408, "1"] }
    ]
  }
}
```

Two rules of thumb. **Write the query in code mode** (`editorMode: "code"`) once it stops being trivial — the visual editor is for the first draft, not for a rate over a histogram. And **the API is the ground truth**: when a panel shows nothing, hit the proxy URL with the same expression and see whether Prometheus returns an empty vector (your query is wrong) or an error (your labels are wrong). The panel is a rendering; the proxy is the answer.

## Panels that matter — and when each lies to you

Four panel types carry almost every useful dashboard, and each has a way of telling a comfortable lie.

- **Time series** — the line chart. The default and usually the right one: rate, latency, queue depth over time. It lies when the Y axis is auto-scaled from zero to maximum and a 3% wobble looks like a cliff; pin the axis, and use `rate()` on counters rather than plotting raw totals that only ever climb.
- **Stat** — one big number. Perfect for "is it up", "how many", a value with thresholds. It lies by averaging away the shape: a single `avg()` of a bimodal latency looks calm while half your requests time out. If the distribution matters, do not reduce it to a stat.
- **Gauge** — a stat with a known range. Memory %, disk %, a saturation ratio. It lies when the range is wrong: a memory gauge set `0..100` when the host has 64 GB hides a run to 90% behind a half-full dial. Set `min`/`max` from the thing being measured.
- **Table** — many series, side by side. Best for "which instance is the outlier": top-N by error rate, per-host disk free, a label-value breakdown. It lies by becoming a wall of numbers nobody reads — cap it with `topk(10, …)` and sort by the column that matters.

The choice is not cosmetic. A **stat** answers "what is it now"; a **time series** answers "what is happening"; a **table** answers "which one". Pick by the question, and set units, thresholds, and axis bounds explicitly, because a panel that lies is worse than no panel.

## Templating: variables for reuse

A dashboard hard-coded to one `instance` is a dashboard you copy for each host. **Templating** fixes that: a dashboard variable that becomes a dropdown, interpolated into every query with `$name`. The variable above is a query variable — its options come from Prometheus itself:

```text
label_values(up{job="node"}, instance)   →  node-exporter:9100
```

`includeAll` adds an `All` choice (expanding to a regex over every value), `multi` allows several at once, and `instance=~"$instance"` is the interpolation in a panel query. Two habits worth forming: use `=~` with variables even when you expect one value (the All case needs regex), and scope the variable query with a label (`{job="node"}`) so it does not enumerate every series in the store. One templated dashboard then covers the fleet, and a new host appears in the dropdown without a single click.

## Alerting in Grafana vs in Prometheus

Both can alert, and the honest answer is that they overlap enough to cause confusion. The distinction that matters:

- **Prometheus alerting rules** evaluate PromQL inside Prometheus on `evaluation_interval`. The rule is a file, the evaluation is cheap (the data is already there), and firing alerts go to Alertmanager for routing, grouping, and silences. This is the right home for simple, expression-based conditions over metrics.
- **Grafana alerting** evaluates in Grafana, can query *any* data source (not just Prometheus) in one rule, and gives you a UI for contact points, notification policies, and silences. It is the right home for "alert when the log count from Loki spikes", or when the condition spans data sources.

Because this stack provisions everything as code, the Grafana rule is a file too:

```yaml
# provisioning/alerting/rules.yml
apiVersion: 1
groups:
  - orgId: 1
    name: homelab
    folder: Homelab
    interval: 1m
    rules:
      - uid: target-down
        title: TargetDown
        condition: C
        for: 30s
        labels: { severity: page }
        data:
          - refId: A
            datasourceUid: prom-main
            model: { expr: "up == 0", instant: true, editorMode: code }
          - refId: C
            datasourceUid: __expr__
            model: { type: threshold, expression: A, conditions: [ { evaluator: { type: gt, params: [0] } } ] }
```

Read the two `datasourceUid` values: `A` runs PromQL against `prom-main`, and `C` is a threshold expression over `A` — Grafana's alerting is a small expression pipeline, not a single PromQL string. The API returns the rule it built, which is how you check a provisioned alert actually loaded:

```bash
$ curl -s -u admin:admin localhost:3000/api/v1/provisioning/alert-rules | # trimmed
  python3 -c '...'
uid=target-down title=TargetDown condition=C for=30s labels={severity: page}
expr="up == 0" datasourceUid=prom-main
```

The advice (also in [my Prometheus write-up](/posts/prometheus-in-practice/)) is not to run both for the same condition. Pick the home by where the data lives, keep `for:` long enough to survive a blip, and alert on things a human would act on. A green light that lies is worse than none — the same discipline [a small-fleet setup](/posts/monitoring-a-small-fleet/) lives by.

## Anti-patterns worth naming

- **The dashboard nobody opens.** If a dashboard has not answered a question in a month, it is a maintenance burden pretending to be monitoring. Delete it; git remembers.
- **The useless average.** `avg()` across rooms, hosts, or request types hides exactly the outlier you care about. Average the thing that is homogeneous, and use `max`, `topk`, or a percentile everywhere else.
- **The hundred-panel wall.** A dashboard is a story, not a data dump. Six panels that each answer a question beat sixty that answer none; split the rest into a second dashboard behind a link.
- **The clicked-but-uncommitted change.** A UI edit that never became a file is a mystery for the next person. With `allowUiUpdates: false`, the UI simply refuses — and the fix is a commit.

## Clean up

The whole stack was one compose file, three provisioning YAMLs, and one dashboard JSON — deleted the moment the output was captured:

```bash
$ docker compose down -v && cd ..
```

The promise of **Grafana provisioning** is small and real: the install is never the hard part, the hard part is deciding which question a panel answers, and then committing it. Point Grafana at a data source, keep the datasource and dashboards as code, and the dashboard you rebuild on a new box is the dashboard you reviewed.
