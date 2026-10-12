---
title: "Consul in practice: service discovery, health checks, and KV without Kubernetes"
description: "Real Consul, no Kubernetes: I ran a throwaway dev agent on 127.0.0.1, registered a service with an HTTP health check, watched it flip to critical, queried it through the DNS interface and HTTP API, and stored config in Consul KV — with real output."
pubDate: 2027-01-09
lang: en
translationKey: consul-in-practice
tags: [devops, networking]
featured: false
keywords:
  - Consul
  - service discovery
  - health check
  - Consul KV
  - DNS interface
---

**Consul** is the tool I keep recommending to people who need **service discovery** on a handful of machines and no Kubernetes. It gives you three boring, useful things: a registry of what's running and where, a **health check** system that tells consumers which instances are actually alive, and a small replicated key-value store — **Consul KV** — that doubles as a config store. There is a fourth thing, a **service mesh**, but that only matters once you have enough services and teams to justify paying for it; the core is much simpler than that. I ran a throwaway dev-mode agent on `127.0.0.1`, registered a service with a real HTTP check, broke the backend on purpose, and watched the world update. Everything below is real output from Consul 2.0.4, run from the official binary and torn down afterward — pulls from Docker Hub were blocked on my box, and the HTTP/DNS interface is identical either way.

## What Consul actually does

Strip away the marketing and Consul does four jobs:

- **Service registry.** A service says *"I am `web`, I live at `127.0.0.1:8080`, call me."* Other machines find it without knowing its address in advance.
- **Health checking.** The agent doesn't just record the registration, it runs checks against it — HTTP, script, or TTL heartbeat — and marks the service `passing`, `warning`, or `critical`. Consumers can filter to healthy instances only.
- **A DNS interface.** Every service is queryable as `<service>.service.consul` (and `<tag>.<service>.service.consul`), so discovery works with any client that can send a DNS query — no SDK required.
- **Consul KV.** A hierarchical key/value store with compare-and-set, replicated across the servers, readable over HTTP. Good for feature flags, DB hosts, anything you want to change without redeploying.

The **service mesh** (encryption, mTLS, retries, routing between services) is a paid-tier feature — it requires running sidecars or the "proxy" mode. For a three-to-ten service estate it is overkill, and I have never needed it below about twenty services.

## The five objects to understand

- **Agent** — the process running on every machine (client agent) or the quorum of servers. It holds its local state, runs checks, and forwards registrations to the servers.
- **Service** — a named instance (`web`, ID `web-1`) with an address, port, and optional tags like `v1`. Tags become DNS filters.
- **Check** — a health probe attached to a service (or to a node). Types: `http`, `script`, `ttl`. Each check carries one of three statuses; `critical` is the one that matters.
- **Catalog** — the merged, cluster-wide view the servers hold: every node, service, and check. What you query when you want the truth, not one agent's opinion.
- **KV** — the keyspace. Flat, prefix-hierarchical, values are base64 over HTTP, max 512 KB per key.

## The lab: one throwaway dev agent

A dev agent is a single-node, in-memory Consul — perfect for testing, useless for production memory guarantees, exactly what a lab wants:

```
$ consul agent -dev -node=lab
==> Starting Consul agent...
            Node name: 'lab'
           Datacenter: 'dc1' (Segment: '<all>')
               Server: true (Bootstrap: false)
          Client Addr: [127.0.0.1] (HTTP: 8500, HTTPS: -1, gRPC: 8502, gRPC-TLS: 8503, DNS: 8600)
          Cluster Addr: 127.0.0.1 (LAN: 8301, WAN: 8302)

$ curl http://127.0.0.1:8500/v1/status/leader
"127.0.0.1:8300"
```

HTTP API on `8500`, DNS on `8600`. Note what's missing: DNS records never reach this agent until a service registers something *and* its checks pass.

## Registering a service with an HTTP health check

In production you'd use a config file or the CLI; the HTTP API is the same operation and needs no tooling beyond `curl`:

```
$ curl -X PUT http://127.0.0.1:8500/v1/agent/service/register -d '{
    "Name": "web",
    "ID": "web-1",
    "Tags": ["lab", "v1"],
    "Address": "127.0.0.1",
    "Port": 8080,
    "Check": {
      "HTTP": "http://127.0.0.1:8080/health",
      "Interval": "2s",
      "Timeout": "1s",
      "DeregisterCriticalServiceAfter": "1m"
    }
  }'
$ curl http://127.0.0.1:8500/v1/catalog/services
{ "consul": [], "web": ["lab", "v1"] }
```

Empty body, status 200 — the agent accepted the registration and immediately started probing. A few seconds later the check has a verdict:

```
$ curl -s http://127.0.0.1:8500/v1/health/service/web | (trimmed)
[
  {
    "Node": "lab",
    "Service": { "ID": "web-1", "Service": "web", "Tags": ["lab", "v1"], "Address": "127.0.0.1", "Port": 8080 },
    "Checks": [
      { "CheckID": "serfHealth", "Status": "passing", "Output": "Agent alive and reachable" },
      { "CheckID": "service:web-1", "Status": "passing",
        "Output": "HTTP GET http://127.0.0.1:8080/health: 200 OK Output: ok",
        "Type": "http", "Interval": "2s", "Timeout": "1s" }
    ]
  }
]
```

Three details worth internalizing. The check's `Output` carries the raw result — one GET, one status line; when it fails you'll read the reason here, not guess. `serfHealth` is the node-level check, always present, and it is what tells the cluster the *machine* is gone versus the *service* being sick. And `Interval`/`Timeout` are the knobs that decide how fast consumers learn the truth — two seconds here, and every consumer would agree within about two seconds.

## The DNS interface and the HTTP API

Now the part that makes this discovery work anywhere. Consul runs its own DNS server, and `web.service.consul` is a name every client can ask about — `curl`, a browser, a Postgres connection string, anything that does a lookup:

```
$ dig +short web.service.consul            # no dig on this box, so same bytes
$ python3 dnsq.py web.service.consul A      # via a 40-line raw UDP client
A 127.0.0.1 (ttl 0)
$ python3 dnsq.py web.service.consul SRV
SRV -> 127.0.0.1:8080 prio 1 weight 1 (ttl 0)
$ python3 dnsq.py v1.web.service.consul A
A 127.0.0.1 (ttl 0)
$ python3 dnsq.py nope.web.service.consul A
(no records)
```

An `A` record lists healthy instances; an `SRV` record attaches the port, which is why `SRV` is the honest primitive for registries. Prefix a tag and you filter: `v1.web.service.consul` only matches instances carrying the `v1` tag, and a tag that doesn't exist resolves to nothing. Tag rewriting (`canary.web.service.consul`, the `enableTagOverride` flag) is how you get a poor-man's canary without any control plane.

For programmatic consumers, the HTTP API is the other face of the same catalog. The `catalog` endpoints are the cluster-wide read path; `agent` endpoints are node-local; and `?passing` is the single most useful query filter in the whole API, because it is the difference between "registered" and "usable":

```
$ curl -s 'http://127.0.0.1:8500/v1/health/service/web?passing'  → exactly one entry, check passing
```

## When a check flips to critical

A registry without health checks is a graveyard of stale addresses, so this is the experiment that matters. I made the backend return `503` — the worst kind of failure, the process is *up* but the app is not:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health
503

# agent log, immediately:
2026-10-13T04:28:42 [WARN] agent: Check is now critical: check=service:web-1

$ curl -s http://127.0.0.1:8500/v1/health/service/web | (trimmed)
        "CheckID": "service:web-1", "Status": "critical",
        "Output": "HTTP GET http://127.0.0.1:8080/health: 503 Service Unavailable Output: down"

$ curl -s 'http://127.0.0.1:8500/v1/health/service/web?passing'
[]

$ python3 dnsq.py web.service.consul A
(no records)
```

`critical` means "do not send traffic here," and the DNS interface enforces it immediately — the name stops resolving to that instance rather than handing out a dead address. That is the entire point of running checks instead of trusting registrations. The `DeregisterCriticalServiceAfter: "1m"` from my registration is the cleanup path: a check that stays critical for a full minute gets its service deregistered automatically, which is what you want after a bad deploy and *not* what you want during a two-minute blip — tune it per environment. Restoring the backend made the check `passing` again on its own; no restart of anything.

## Consul KV for configuration

The KV store is the least glamorous and most-used feature. `PUT` writes (with optional `?cas=` compare-and-set), `GET` reads, values come back base64-encoded, and prefixes group into a hierarchy:

```
$ curl -X PUT --data 'db-01.internal:5432' http://127.0.0.1:8500/v1/kv/app/db/host
true
$ curl http://127.0.0.1:8500/v1/kv/app/db/host
[ { "LockIndex": 0, "Key": "app/db/host", "Flags": 0,
    "Value": "ZGItMDEuaW50ZXJuYWw6NTQzMg==", "CreateIndex": 46, "ModifyIndex": 46 } ]

$ curl -s 'http://127.0.0.1:8500/v1/kv/app?recurse' | decoded
app/db/host    = db-01.internal:5432   (CreateIndex 46)
app/db/timeout = 30s                   (CreateIndex 47)

$ consul kv put app/feature/flags '{"newNav": true}'
Success! Data written to: app/feature/flags
$ consul kv get app/feature/flags
{"newNav": true}
```

`CreateIndex`/`ModifyIndex` are Raft indexes — they turn into ordering and watch semantics if you need them: blocking queries and watches hang until the index advances, so a config consumer gets *pushed* changes instead of polling. The locks (`?acquire=`/`?release=`) that fall out of KV are leader election for whoever wants it.

## The full lifecycle, end to end

The cycle I actually ran, in one view:

```
$ consul members
Node  Address         Status  Type    Build  Protocol  DC   Partition  Segment
lab   127.0.0.1:8301  alive   server  2.0.4  2         dc1  default    <all>

# agent log, condensed:
2026-10-13T04:23:06 [INFO] agent: Synced service: service=web-1
2026-10-13T04:28:42 [WARN] agent: Check is now critical: check=service:web-1
2026-10-13T04:30:05 [INFO] agent: Deregistered service: service=web-1

$ curl -X PUT http://127.0.0.1:8500/v1/agent/service/deregister/web-1
$ curl http://127.0.0.1:8500/v1/catalog/services
{ "consul": [] }
```

`consul members` shows the gossip membership — the layer *under* the catalog. Note it printed `alive` the whole time: the node was fine, the service was not. That split is the mental model worth keeping. `consul` itself appears in the catalog because servers run their own health checks against themselves.

<figure>
<svg viewBox="0 0 680 288" width="100%" role="img" aria-label="Services register with Consul and are health-checked; consumers query the DNS interface and only get healthy instances. On the left, web-1 and db-1 register with Consul in the middle; Consul sends GET /health to web-1 every two seconds; on the right a client queries the A record web.service.consul and gets back only 127.0.0.1.">
  <defs>
    <marker id="consul-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>

  <rect x="238" y="86" width="204" height="118" rx="14" fill="#0f766e" opacity="0.07" stroke="#0f766e" stroke-width="2.5"/>
  <text x="340" y="114" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="17" font-weight="700">consul</text>
  <text x="340" y="136" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">catalog · checks · KV</text>
  <text x="340" y="160" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">node lab · dc1 · server</text>
  <text x="340" y="184" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">HTTP :8500 · DNS :8600</text>

  <rect x="30" y="34" width="190" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="46" y="58" fill="#0f766e" font-family="system-ui, sans-serif" font-size="14" font-weight="600">web-1</text>
  <text x="46" y="78" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">127.0.0.1:8080 · passing ✓</text>

  <rect x="30" y="200" width="190" height="56" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="46" y="224" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">db-1</text>
  <text x="46" y="244" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">127.0.0.1:5432</text>

  <rect x="470" y="86" width="180" height="118" rx="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
  <text x="560" y="116" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="14" font-weight="600">client app</text>
  <text x="560" y="138" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">A web.service.consul →</text>
  <text x="560" y="156" text-anchor="middle" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" opacity="0.8">healthy instances only</text>
  <text x="560" y="182" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11" font-weight="600">127.0.0.1:8080</text>

  <g fill="none" stroke="#0f766e" stroke-width="2" marker-end="url(#consul-arrow)">
    <line x1="222" y1="62" x2="236" y2="104"/>
    <line x1="222" y1="228" x2="236" y2="184"/>
  </g>
  <text x="232" y="52" text-anchor="end" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">register</text>

  <line x1="290" y1="206" x2="196" y2="200" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#consul-arrow)"/>
  <text x="243" y="226" text-anchor="middle" fill="#0f766e" font-family="system-ui, sans-serif" font-size="11">GET /health every 2s</text>

  <g fill="none" stroke="#0f766e" stroke-width="2">
    <line x1="468" y1="128" x2="450" y2="128" marker-end="url(#consul-arrow)"/>
    <line x1="440" y1="158" x2="468" y2="158" marker-end="url(#consul-arrow)"/>
  </g>
</svg>
<figcaption>The two main flows: services register and get probed repeatedly (when web-1's HTTP check fails, its A record disappears); consumers query DNS and only ever receive addresses of healthy instances.</figcaption>
</figure>

## Consul vs etcd: different jobs, overlapping tools

The honest comparison, because the KV stores invite it. [etcd is a KV store plus linearizable consensus](/posts/consensus-and-etcd/): one ordered Raft log, watch-based reads, the model Kubernetes was built on. Consul has a KV too, but its center of gravity is different:

- **etcd** = *the control plane database*. Correctness is linearizable ordered log; small keys; tight latencies; cluster state, not service state.
- **Consul** = *a live registry that happens to carry config*. It talks gossip for membership, anti-entropy for registrations, and it speaks DNS so clients don't need a client library. It runs checks; etcd does not check your services at all.

If your problem is "replicate my cluster's cluster state safely," that's etcd's job. If your problem is "how does service A find a healthy instance of service B *right now*," that's Consul's. Running Consul without its servers is also mostly pointless — `consul agent -dev` fits in one process, but a production topology is 3 (or 5) servers plus a client agent per machine, and that's the real cost to weigh.

## When you don't need any of this

The strongest recommendation I can give is about restraint. Consul earns its keep when you have more churn and more instances than your head can hold. Below that line, honestly:

- **A dozen stable services with static addresses** — [DNS records in your own resolver](/posts/self-hosted-dns-resolver/) do the job, versioned in git, zero new infrastructure.
- **Config that changes on deploys** — bake it into the image or fetch it at boot. KV adds a moving part to debug during the very incident it was supposed to simplify.
- **A single machine** — `localhost` is a service discovery protocol.

Consul starts paying off at roughly: services come and go faster than you can edit DNS, you want traffic to stop flowing to broken instances *automatically*, or you run many environments that want the same config surface. If that's your situation, the loop above — register, check, query, critical, deregister — is the whole feature, and it works without a Kubernetes cluster in sight.
