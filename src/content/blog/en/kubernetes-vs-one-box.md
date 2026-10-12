---
title: "Kubernetes vs one box: when you don't need an orchestrator"
description: "Kubernetes earns its keep with many services across many nodes, rolling updates at scale, and multi-tenant scheduling. A solo builder on one box usually pays the cost without the benefit. What k8s really solves, what it costs a small operator, the honest middle grounds, a decision table, and what I run instead."
pubDate: 2026-11-12
lang: en
translationKey: kubernetes-vs-one-box
tags: [devops, self-hosting]
featured: true
keywords:
  - Kubernetes vs one box
  - do you need Kubernetes
  - docker compose
  - systemd
  - k3s
  - orchestration
  - homelab
---

You can run an astonishing amount of production software on a single machine. So the question that actually matters is not "is Kubernetes good?" — it is — but **Kubernetes vs one box: which one does *your* problem need?** I have run both. On one box I run this blog, a few small APIs, and a pile of scheduled jobs; I have also operated clusters where the orchestrator was unambiguously the right answer. The honest position is that most solo builders asking "do you need Kubernetes" already suspect the answer, and want permission to keep things simple. Here it is, with the reasoning attached.

## What Kubernetes actually solves

Kubernetes is a distributed scheduler plus a reconciliation loop. Almost every feature in it exists to answer a question that only shows up *at scale*. Strip away the branding and there are four real problems it solves.

### Many services across many nodes

The moment you have more containers than fit comfortably on one host, you need something to decide where each one lands, account for capacity, and move work when a node dies. That is the **scheduler**, and it is genuinely hard to replace with shell scripts. A scheduler that reschedules a failed pod onto healthy hardware without a human in the loop is worth real money when you have dozens of nodes. On one box, "where does it run" has exactly one correct answer, so you never needed to ask.

### Rolling updates at scale

Kubernetes gives you declarative rollouts — `maxSurge`, `maxUnavailable`, readiness gates, and an automatic rollback when a new ReplicaSet never becomes ready. On a single box you can get the same outcome with a symlink swap and a `systemctl reload`, which I walk through in detail in [zero-downtime deploys](/posts/zero-downtime-deploys/). The difference is that you build that plumbing yourself, once per service. With three services that is a pleasant afternoon; with thirty it starts to feel like a home-grown orchestrator, and home-grown orchestrators are where outages go to hide.

### Scheduling as a first-class concern

Requests and limits, node affinity, taints and tolerations, priority classes. If you genuinely need to pack heterogeneous workloads onto shared hardware and guarantee quality of service, Kubernetes expresses that as configuration instead of custom code. This is a real capability, not decoration.

### Multi-tenant isolation

Namespaces, RBAC, resource quotas, network policies. When several teams share a cluster and one team's runaway job must not starve another, the tenancy model is the whole point. A single operator has no tenants to isolate — you are the tenant, and you already trust yourself.

That is the honest list. If none of those four sections describes your situation, the orchestrator is solving someone else's problem.

## What Kubernetes costs a small operator

The cost is not mostly money. It is attention, and attention is the scarcest resource a solo builder has.

### Control-plane overhead

Even a managed control plane needs workers carrying a kubelet, a container runtime, a CNI plugin, and a CSI driver if you want real storage. A self-managed control plane is etcd, the API server, the controller manager, and the scheduler — four distributed components that must agree on one version of state. They fail in interesting ways, and each one is now a thing you own, patch, back up, and restore.

### YAML as its own API surface

A single service is a Deployment, a Service, an Ingress, a ConfigMap, a Secret, and often a ServiceAccount and a NetworkPolicy. That is five to eight documents to ship one thing. The YAML is not hard to *write*; it is declarative and reviewable, which is a genuine virtue. The cost is volume: you are maintaining a second interface to your software, and it drifts from the code the moment nobody owns it.

### The upgrade treadmill

Kubernetes ships roughly three minor versions a year and supports each cluster version for about a year. Deprecated APIs are removed on a schedule, so there is always a migration in flight — `extensions/v1beta1` to `networking.k8s.io/v1` was the famous one, and it broke a lot of otherwise healthy clusters. On one box, "upgrade" is `apt upgrade` and a reboot you schedule yourself.

### Debugging through indirection

A request enters an Ingress, hits a Service, is load-balanced to a Pod, maybe passes a sidecar, is logged to a node, and is shipped to an aggregator. When it fails, you get to guess which of those five layers dropped it. On one box the same investigation is `journalctl -u api` and `ss -ltnp` — the request path is the process path.

## The honest middle grounds

This is not a binary. There are at least three sane stopping points between bare processes and a full cluster.

### systemd + nginx

One machine, native processes supervised by systemd, logs in the journal, and nginx as the reverse proxy and TLS terminator. This is the shape I describe in [self-hosting without Docker](/posts/self-hosting-without-docker/), and it handles more traffic than most people assume. You get restart-on-failure, resource limits, dependencies between units, and socket activation — the useful half of what a scheduler does, with none of the distributed systems.

### docker compose / podman compose

When you want images and process isolation but no scheduler, `docker compose` is the right size. A `compose.yaml` describes a handful of services on one host, and `restart: unless-stopped` gives you restart-on-failure for free.

```yaml
# compose.yaml — three services, one box, no orchestrator
services:
  api:
    image: ghcr.io/example/api:1.4.2
    restart: unless-stopped
    env_file: .env
    ports: ["127.0.0.1:9001:9001"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9001/healthz"]
      interval: 30s
  worker:
    image: ghcr.io/example/api:1.4.2
    restart: unless-stopped
    command: ["/app/worker"]
    depends_on: [api]
  postgres:
    image: postgres:17
    restart: unless-stopped
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```

`podman compose` runs the same file without a daemon, which is a nicer fit if you dislike a root-owned socket on your host.

### k3s or a single Nomad

If you want the Kubernetes API — manifests, `kubectl`, the ecosystem of Helm charts and operators — but not the control-plane weight, **k3s** is a single binary with a trimmed control plane that runs happily on one box. For a homelab or a small fleet where the declarative API itself is the value, it is a defensible choice and it keeps the door open to growing into a real cluster. Nomad is the other honest option: one binary, a simpler job spec, and no etcd to reason about.

## A decision table

| Dimension | One box (systemd + nginx) | docker compose | k3s / Nomad | Full Kubernetes |
| --- | --- | --- | --- | --- |
| Services | 1–10 | 3–20 | 10–50 | 20+ |
| Nodes | 1 | 1 | 1–5 | 3+ (multi-AZ) |
| Teams sharing it | 1 | 1 | 1–2 | many |
| Autoscaling | not needed | not needed | occasional | required |
| Self-healing need | restart on failure | restart on failure | reschedule on node loss | reschedule across nodes |
| Upgrade effort | `apt upgrade` | pull new image | k3s upgrade | cluster upgrade + API migrations |
| Debug path | `journalctl`, `ss` | `docker logs` | `kubectl`, logs | ingress → service → pod → sidecar |
| Pick it when | you are the operator and the machine is one | you want images without a scheduler | you want the k8s API, not the cluster | many nodes, many teams, real scale |

Read the table by finding your row, not by finding the "most powerful" column. The right answer is the leftmost column that still covers every requirement you actually have.

## Do you need Kubernetes? For the solo builder, probably not

My clear recommendation: **one box, nginx, and systemd, or `docker compose` if you want images.** Add k3s only when you have a second node and a reason to treat your infrastructure as an API. Reach for full Kubernetes when you have multiple teams, multiple nodes, and an autoscaling requirement you can point at — not before. The failure mode of premature orchestration is not that it breaks; it is that it works, slowly, and quietly consumes the time you meant to spend building the actual product. Every hour spent fighting a control plane is an hour not spent on the thing users pay for.

## What I run instead

Concretely, here is the shape of my setup, so this is not just advice:

- **One small VPS.** nginx in front, terminating TLS for every hostname; systemd units behind it, one unit per service, each with `Restart=on-failure` and a `MemoryMax` limit so a leak cannot take down the box.
- **`docker compose` for anything I did not write.** If an upstream only ships a container, I run it under compose on the same host rather than fighting a tarball, and I put a nginx `proxy_pass` in front of it so every service looks the same from outside.
- **Scheduled work as systemd timers**, not cron, so jobs get logs, dependencies, and `flock`-based single-flight. I wrote about the trade-offs in [systemd timers vs cron](/posts/systemd-timers-vs-cron/).
- **Deploys are a symlink swap**, per the [zero-downtime](/posts/zero-downtime-deploys/) pattern: build beside the live release, health-check, flip, drain.
- **Configuration lives in one Git repo**, applied by hand or by a short Ansible playbook — the setup I described in [ansible for one server](/posts/ansible-for-one-server/).
- **Backups are restorable**, not just present. I test a restore on a schedule because an untested backup is a rumour.

The whole stack fits in my head, and that is the point. You can read the entire list of what I self-host — and why — in [what I self-host in 2026](/posts/what-i-self-host-2026/); none of it needs an orchestrator, and all of it would be worse to operate if I added one.

If your single box is genuinely at its limit — CPU pinned, memory gone, a second machine inevitable — then congratulations, you have earned a scheduler, and picking one is now a real decision rather than a résumé entry. Until then, the simplest architecture that satisfies your requirements is not a compromise. It is the correct engineering choice.
