---
title: "Choosing a VPS in 2026: what actually matters (and what doesn't)"
description: "Beyond the pricing page: which VPS specs actually matter for a small self-hosting server — RAM before CPU, disk IO, network caps, IPv4/IPv6, snapshots, latency — which marketing numbers lie, the real cheap-vs-premium tradeoff, KVM vs OpenVZ, port 25 and abuse policy, and a decision checklist."
pubDate: 2026-11-01
lang: en
translationKey: choosing-a-vps
tags: [self-hosting, devops, linux]
featured: false
keywords:
  - choosing a VPS
  - VPS specs
  - self-hosting server
  - KVM vs OpenVZ
  - bandwidth
---

People ask me how I pick a machine for a **self-hosting server**, and the honest
answer is that **choosing a VPS** in 2026 is not harder than it used to be — it is
just harder to do *well*. Pricing pages are full of plans that look
interchangeable and behave completely differently six months in. This is the
checklist I use after running one public box for years: the **VPS specs** that
decide whether a small setup feels solid or fragile, the numbers that mean
nothing, and the questions a provider never answers on its page.

## The VPS specs that actually matter for a self-hosting server

Six things decide whether a box is pleasant to run, and half are not the biggest
number on the page.

### RAM before CPU, always

For a small setup, memory is what you run out of first. nginx, a database, a Git
forge, a container or two, systemd itself — all of it wants to *stay* resident.
CPU is spiky and idle 99% of the time, so you notice the 1%. Memory is flat: you
either fit or you swap, and swapping to a network disk is where a "cheap" plan
quietly dies. Buy memory, rent CPU.

- **Tiny:** a reverse proxy, a static site, a tunnel endpoint. The smallest tier is
  genuinely enough if no database lives there.
- **Small:** Git, a vault, a few services behind a proxy. Services plus the OS
  should fit with room for page cache — cache is why the box feels fast.
- **Comfortable:** mail, a real database, a couple of tenants. Here RAM *is* the
  product; cores barely matter.

### Disk type and IO

"SSD" on a plan page is a category, not a measurement. What matters is whether it
is **local NVMe**, local SATA SSD, or — the gotcha — network-attached storage
dressed up as an SSD. Network storage makes a database feel like it is thinking.
IOPS, not capacity, is what you notice. If a provider will not name the disk type,
that is your answer.

### Network port and bandwidth caps

Two numbers get called "bandwidth". The **port speed** (1 Gbps, 10 Gbps) decides
how fast a single transfer bursts. The **monthly allowance** decides how much data
you move before you are throttled, billed, or nullrouted. For a blog or proxy, the
cap matters more; for serving large files, the port does.

### IPv4 and IPv6

IPv4 is scarce and providers pay real money for it, which is why some cheap tiers
are **IPv6-only** with a shared, NAT'd v4 address or none. Fine for a tunnel or a
site behind a CDN; fatal for anything that must *accept* inbound v4 connections —
mail, a bastion, a game server. IPv6 is where you get a routable address per
service, which makes firewalling cleaner. Check that the provider actually
*routes* IPv6, not just advertises it.

### Snapshots and backups

These are not the same, and providers love to conflate them. A **snapshot** is a
point-in-time copy on the *same* storage under the *same* account: great for "roll
back before this upgrade", useless the moment the account closes or the provider
disappears. A **backup** leaves the building. Use their snapshots if free, but
treat your offsite copy as the real safety net.

### Location and latency

Closer is better, but distance is the least interesting variable: peering, network
quality and jurisdiction matter more. Pick a region near you (snappy SSH) and near
most readers if you serve them directly.

## The marketing numbers that mislead

- **Core count.** "8 vCPU" on a shared host is eight *slices* of contended
  physical cores. A neighbor running a build can eat your share. One honest core
  beats four busy ones.
- **"Unlimited" bandwidth.** Nothing is unlimited; there is always a fair-use
  clause. Read the number in the terms, not the word on the button.
- **Burst RAM.** You do not *have* burst memory, you *borrow* it when the host is
  idle — exactly when you do not need it. Never size a box on burst.
- **"Dedicated" CPU** with no denominator. Guaranteed against what? Check the
  vCPU-vs-physical-core ratio, or just watch steal time yourself.
- **A big storage number** with no IOPS attached. Terabytes of slow network
  storage lose to a fraction of fast local NVMe.

## Cheap vs premium providers: where the money actually goes

The price gap is rarely about CPU or disk — those are cheap. You are paying for
three things: **network and peering** (better transit, lower latency that holds
under load); **oversubscription** (cheap plans pack in more neighbors, so
performance is less predictable); and **support and policy** (premium answers a
ticket in hours and gives notice before a suspension, cheap often does neither).
For a hobby box I am happy on a cheap tier **if** I have real offsite backups and
accept that the box may vanish with a day's warning. For anything whose failure
mode is *me being locked out* — mail, the front door — I pay for network and
support, not cores. Most of my machines live in the sane middle: a reputable
mid-tier that is boring and slightly more expensive.

## KVM vs OpenVZ: why the virtualization type matters

The **KVM vs OpenVZ** question quietly decides what you can run. **OpenVZ** — and
its cousins LXC and Virtuozzo — is *container* virtualization: every tenant shares
the host kernel. That is efficient, so plans are cheap, but it constrains you. No
custom kernel or kernel modules. Some `sysctl` knobs are locked, `iptables` may be
partially owned by the host, and nested Docker can be flaky or forbidden. You are
a tenant in someone else's home. **KVM** is full virtualization: your own kernel,
so Docker, WireGuard, ZFS, custom kernels and your own packet filter all work. It
costs more and is usually worth it.

My default: pick **KVM** unless you have a specific reason not to. I would not
consider a container plan for mail (full control of the network stack) or anything
that steps outside a normal userland.

## When a tiny box is enough — and when you need more

Most people over-buy and under-use. The signals a small box is enough are boring:
CPU near idle, RAM mostly free with a healthy page cache, no swap, egress nowhere
near the cap. If that is you, do not upgrade to satisfy a dashboard. The signals
you have genuinely outgrown it are equally concrete:

- **Swap is in use in normal operation**, or you restart services to free memory.
- **Steal time is high** (the `st` column in `top`) — you are paying for a
  neighbor's workload.
- **IO wait is high** on trivial queries — the disk, not the code, is the problem.
- **You keep hitting the egress cap**, or TLS handshakes are visibly slow.

When you cross one, move up *one* tier and stay there. Pre-buying capacity for
traffic you do not have is the most common waste; OOM-killing your own database at
3 a.m. is the most common regret.

## Port 25, abuse policy, and the fine print

Read this before you buy, not after it bites.

**Port 25.** Most providers block outbound 25 by default to stop spam. If you want
to *receive* mail you need inbound 25 open, and many providers will not open it —
or only on a business tier, after a wait, or with an argument. Some block only
outbound, which is fine if you send through a relay. Confirm the policy *before*
you migrate a mailbox.

**Abuse policy.** Find out what happens when a DMCA or abuse report lands. Instant,
silent suspension is a dealbreaker for anything you care about; a warning email is
not. Check the acceptable-use policy for whatever you plan to run — a VPN exit
node or a torrent client is disallowed on some networks and fine on others.

**The rest.** Is the IP shared or dedicated? Is extra IPv4 a charge? Can you get a
console when SSH is broken? This is where **choosing a VPS** stops being about
specs and becomes about trust.

## The choosing-a-VPS decision checklist

Work down this list before you pay:

1. **Sizing:** what is the smallest box my services *plus* page cache fit in?
   Start one tier above "barely fits".
2. **RAM and swap:** enough that I will not swap in normal operation?
3. **Disk:** local NVMe or SATA SSD? What IOPS? Is it network storage?
4. **Network:** port speed, monthly egress cap, overage policy.
5. **IPv4/IPv6:** do I need a dedicated IPv4? Is IPv6 actually routed?
6. **Snapshots:** free, and do I still have a real offsite backup regardless?
7. **Virtualization:** KVM, or a container plan I have a reason to accept?
8. **Port 25 / abuse:** will they unblock mail ports, and how do they handle
   reports?
9. **Location:** close to me and my users, in a jurisdiction I am fine with.
10. **Support:** can I reach a human fast, and is the policy documented?

Then verify what you bought instead of trusting the page:

```bash
# Run these on the fresh box before you trust the plan page.
nproc                              # logical cores; check /proc/cpuinfo for the real model
free -h                            # RAM, and whether swap is already in use
lsblk -d -o NAME,SIZE,ROTA,MODEL   # ROTA=0 means non-rotational (SSD/NVMe)
dd if=/dev/zero of=./t bs=1M count=512 conv=fdatasync status=progress  # rough write speed
ip -6 addr show                    # is IPv6 actually delivered?
vmstat 1 5                         # watch the `st` column: steal time = noisy host
```

If the write test is slow, the box is already swapping, or steal time is climbing,
you have your answer regardless of what the plan promised.

## The one-line rule

Buy RAM and network quality, not core count; pick KVM; keep a backup that leaves
the building; and read the port-25 and abuse policy before you fall in love with a
price. The best **self-hosting server** is the boring one you stop thinking about.

If you want to see what actually runs on my box once it is chosen, it is in
[what I self-host in 2026](/posts/what-i-self-host-2026/); and the first thing I do
after provisioning any of them is
[harden the public server](/posts/hardening-a-public-server/).
