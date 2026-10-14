---
title: "How Much RAM a Cheap VPS Needs for Self-Hosting (Measured on the Real Box)"
description: "A cheap VPS does not need to be big — this blog runs on 1 vCPU and 981 MB of RAM. Real measured numbers from the box (dd, openssl, load average during a build) plus the criteria that actually decide whether a small self-hosted stack holds up."
pubDate: 2027-02-17
lang: en
translationKey: cheap-vps-providers-compared
tags: [self-hosting, devops]
featured: false
keywords:
  - cheap VPS
  - VPS for self-hosting
  - how much RAM
  - VPS criteria
  - NVMe
---

I run this blog on a **cheap VPS**. Not a charming homelab, not a rented rack — a
single small virtual machine in a foreign datacenter, the kind of box you can get for
the price of a coffee a month. It serves a static site through nginx, terminates a
mesh VPN, and periodically compiles the entire site from source. And it does all of
that on resources that would make a phone laugh.

I have already written the general checklist for
[choosing a VPS](/posts/choosing-a-vps/) and for
[self-hosting without Docker](/posts/self-hosting-without-docker/). This is the
companion piece: not *which* box to pick, but **how little you can get away with**,
proved with the actual numbers from the machine I am typing on. Because the question
people actually ask is not "what are the criteria" — it is "how much RAM do I need,"
and the answer is almost always less than the plan page implies.

## What a small self-hosted stack actually needs

Before the criteria, the arithmetic. A small stack is a list of processes, and each
one has a memory footprint you can measure instead of guess:

- **nginx** serving static files: ~20 MB resident. It is a file cache and a TLS
  terminator; it does not think hard.
- **A static site build** (the Astro compile that produces this blog): a Node
  process that spikes to ~400–500 MB and then exits. This is the *heaviest* thing the
  box does, and it is temporary.
- **A password vault** (Vaultwarden): ~80 MB and happy there.
- **A mesh VPN endpoint** (EasyTier/WireGuard): ~20 MB and a kernel tunnel.
- **The OS itself**: journald, sshd, a cron, systemd — call it 200 MB with a normal
  install.

Add it up and a honest small stack lives in **roughly 700–900 MB**, with the build
spike as the only thing that ever touches the ceiling. That is the number to size
against. A box with 1 GB of RAM is not a joke for this workload — it is the correct
answer, provided you give it a little swap for the build spike and you do not also run
a database.

```bash
# What this box actually runs, by resident size (RSS), while idle:
ps -eo comm,rss --sort=-rss | head -8
   COMMAND          RSS
   node          428368   # the Astro build, mid-run (the spike)
   npm            58656
   systemd-journald 25248
   vaultwarden     8328
   sshd            6112
   systemd          5900
   cron            2688
   sshd            2400
```

Read that as a budget, not a snapshot: the build is the outlier, the steady state is
well under 500 MB, and the whole thing fits in 1 GB with room for page cache. Page
cache is the point — RAM you do not use is RAM the kernel uses to make reads instant,
so "free" memory is not wasted memory.

<figure>
<svg viewBox="0 0 640 240" width="100%" role="img" aria-label="What a small stack needs versus what the box provides">
  <style>
    .lbl{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:currentColor}
    .val{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;fill:currentColor}
    .bar{fill:#0f766e}
    .box{fill:none;stroke:currentColor;stroke-width:1;stroke-dasharray:3 3}
  </style>
  <text x="8" y="20" class="lbl">RAM the stack needs (steady + build spike)</text>
  <rect x="8" y="30" width="600" height="22" class="box"/>
  <rect x="8" y="30" width="415" height="22" class="bar"/>
  <text x="430" y="46" class="val">~900 MB</text>
  <text x="8" y="78" class="lbl">RAM this box has</text>
  <rect x="8" y="88" width="600" height="22" class="box"/>
  <rect x="8" y="88" width="590" height="22" class="bar"/>
  <text x="520" y="104" class="val">981 MB</text>
  <text x="8" y="136" class="lbl">vCPU (1 shared core is enough)</text>
  <rect x="8" y="146" width="600" height="22" class="box"/>
  <rect x="8" y="146" width="18" height="22" class="bar"/>
  <text x="34" y="162" class="val">1</text>
  <text x="8" y="194" class="lbl">Disk (14 GB is plenty for a static site)</text>
  <rect x="8" y="204" width="600" height="22" class="box"/>
  <rect x="8" y="204" width="26" height="22" class="bar"/>
  <text x="40" y="220" class="val">14 GB</text>
</svg>
<figcaption>FIG. 1 — A small self-hosted stack is a memory problem, not a CPU or disk problem. The bar shows what fits; the dashed line is the box.</figcaption>
</figure>

## The criteria, in the order they actually matter

### 1. RAM before vCPU, always

For a small stack, memory is what you run out of first and CPU is what you notice
least. CPU is spiky — idle 99% of the time, a brief compile, then idle again. Memory
is flat: either your services plus page cache fit, or you swap, and swapping to a
virtual disk is where a cheap plan quietly dies. **Buy memory, rent CPU.** A 1 vCPU
box with 2 GB will out-serve a 4 vCPU box with 512 MB for almost any self-hosted
workload.

### 2. Disk type: NVMe vs HDD, and why the flag lies

"SSD" on a plan page is a category, not a measurement. What you want is **local
NVMe** or local SATA SSD, and you want to be sure it is not network-attached storage
dressed up as a disk. Capacity is the least interesting number — a static site plus
a vault plus logs lives in a few gigabytes. **IOPS is what you feel.**

A gotcha worth knowing: on a virtual machine the `ROTA` flag in `lsblk` is not
trustworthy. This box reports `ROTA=1` (rotational) on its virtual disk, yet the
measured write speed below is clearly SSD-grade. The flag reflects how the hypervisor
presents the device, not the physical medium behind it. Trust a real `dd` test, not
the flag.

### 3. Monthly traffic, not "bandwidth"

Two numbers get called bandwidth. The **port speed** (1 Gbps, 10 Gbps) decides how
fast one transfer bursts. The **monthly allowance** decides how much you move before
you are throttled, billed, or nullrouted. For a blog or a proxy the allowance is the
one that matters. A static site serving a few thousand pageviews a month moves tens
of gigabytes; the cap is rarely the constraint. The trap is the word **"unlimited"**
— nothing is unlimited, there is always a fair-use clause. Read the number in the
terms, not the word on the button.

### 4. Location and latency

Closer is better, but distance is the least interesting variable — peering and
network quality matter more. Pick a region near you for snappy SSH and near most of
your readers if you serve them directly. This box sits far from most of my readers,
which is exactly why the site is static and cached: the origin's latency barely
matters when the bytes move once and then sit in a CDN.

### 5. IPv6

IPv4 is scarce and providers pay real money for it, so some cheap tiers are
**IPv6-only** with a shared, NAT'd v4 address or none. Fine for a tunnel or a site
behind a CDN; fatal for anything that must *accept* inbound v4 connections — mail, a
bastion, a game server. Check that the provider actually *routes* IPv6, not just
advertises it. IPv6 also gives you a routable address per service, which makes
firewalling cleaner.

### 6. Snapshots and backups

Providers love to conflate these. A **snapshot** is a point-in-time copy on the same
storage under the same account — great for "roll back before this upgrade," useless
the moment the account closes or the provider disappears. A **backup** leaves the
building. Use their snapshots if they are free, but treat your offsite copy as the
real safety net. **No snapshots is a real disqualifier** for a box you care about.

### 7. Support and panel

The panel is a nice-to-have; support is not. Can you reach a human when SSH breaks,
and is the policy documented? This is where the cheapest tiers and the boring
mid-tier diverge. For a hobby box I accept slow support if I have real offsite
backups. For anything whose failure mode is *me being locked out* — mail, the front
door — I pay for support, not cores.

## The traps, in one place

- **Oversold "unlimited" bandwidth** — there is always a fair-use clause. Find it.
- **"1 vCPU" means a shared slice.** A neighbor running a build can eat your share.
  One honest core beats four busy ones; watch steal time (`st` in `top`).
- **Renewal price vs first-year promo.** The $2/month plan is often $6/month in year
  two. Compute the *steady-state* cost, not the landing-page cost.
- **No snapshots** — cheap and common, and a real risk if the box holds state.
- **Disk IO is the real bottleneck.** A slow disk makes a fast CPU wait. Measure it.

## What the real box does

This is not a shootout — I do not have a rack of providers to benchmark. It is one
box, measured read-only, and it is the machine this blog actually ships from. Here is
what it reports:

```bash
nproc                          # 1
free -m
               total   used   free  shared  buff/cache   available
Mem:             981    407     63       2         510       415
Swap:           2559    390   2169
df -h /
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        14G  8.5G  4.2G  68% /
lsblk -d -o NAME,ROTA,SIZE
NAME ROTA  SIZE
vda     1   14G
```

One core, 981 MB of RAM, a 14 GB disk, and 2 GB of swap. The swap is not an
accident: the Astro build is the heaviest thing this box does, and it once
OOM-killed the kernel mid-build before the swap existed. Now the build survives on
swap and RAM together — which is the honest argument for "a little swap is fine, but
still buy RAM."

```bash
dd if=/dev/zero of=/tmp/ddtest bs=1M count=512 oflag=direct 2>&1 | tail -1
512+0 records out
536870912 bytes (512 MiB) copied, 0.465319 s, 1.2 GB/s
dd if=/dev/zero of=/tmp/ddtest bs=1M count=512 2>&1 | tail -1
536870912 bytes (512 MiB) copied, 2.50204 s, 215 MB/s
```

The `ROTA=1` flag says "rotational," but 1.2 GB/s direct and 215 MB/s through the
page cache say otherwise — this virtual disk is fast. The direct run is *faster* than
the cached one here because the second run had to write back dirty pages from the
first. The lesson is the one above: measure the disk, do not trust the flag.

Single-core crypto, for the TLS terminator and the VPN:

```bash
openssl speed -evp aes-128-gcm -bytes 16 -seconds 3 2>&1 | tail -1
aes-128-gcm     217944.35k        # ~218 MB/s of AES on one core
```

That is the ceiling for a single TLS handshake burst, and it is plenty for a small
site. And the load average during a real build — the moment this box is actually
working:

```bash
cat /proc/loadavg
2.08 1.08 0.48 2/173 417202
ps aux --sort=-%mem | head -3
root  417047  93.0  42.6  ...  node .../astro build
root  417012   0.7   5.8  ...  npm run build
root    268   0.0   2.5  ...  systemd-journald
```

Load average 2.08 on one core — meaningfully oversubscribed, because a build is
exactly the workload that does not care how small your box is. This is the honest
upper bound: **the build is the only thing that stresses this box, and it still
finishes.** Serving the finished site is, by comparison, nothing.

## The cheapest adequate box beats the biggest spec sheet

Here is the whole thesis in one paragraph. For a small self-hosted stack — nginx, a
static build, a mesh VPN, a vault — the binding constraint is memory, the disk just
has to be fast, and a single core is more than enough for everything except the
build. A cheap 1 vCPU / 1 GB / 14 GB box with NVMe-class IO, a real monthly traffic
allowance, routed IPv6, and snapshots is not a compromise; it is the correct tool.
Paying for 4 cores you will never use is not headroom, it is a worse price on the
same network.

The criteria, in the order to weigh them: **RAM first, then disk speed, then the
traffic allowance, then location, then IPv6, then snapshots, then support.** The
traps are the same everywhere — oversold bandwidth, shared-core vCPU, promo-vs-renewal
pricing, missing snapshots — and they are all cheaper to check before you pay than to
discover after a 3 a.m. outage. Pick the smallest box that fits your measured
footprint with room for page cache and a build spike, keep a backup that leaves the
building, and then stop thinking about the machine. That is the entire art of
running a small stack on a **cheap VPS**.
