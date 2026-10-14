---
title: "A homelab on a budget: what you actually need (and what is a waste)"
description: "Measured, not imagined: what a home stack really costs in RAM, disk and watts. A real 3-year homelab total cost for a used mini PC vs a VPS — and the gear that is pure waste."
pubDate: 2027-02-19
lang: en
translationKey: homelab-on-a-budget
tags: [homelab, self-hosting]
featured: false
keywords:
  - homelab on a budget
  - homelab total cost
  - mini PC homelab
  - electricity cost
  - used hardware
---

Most people build their first **homelab on a budget** — and most of them overspend on the wrong things. Not because the gear is expensive, but because they buy for a workload they imagine instead of the one they will actually run. So let me start with measurements, not a shopping list.

I run this blog from a VPS with **981 MB of RAM and one vCPU**. Not a lab machine, not a rack — the cheapest thing that serves static files. Let me ask it what it is actually doing right now.

```console
$ ssh -p622 root@88.218.79.95
$ free -m | awk '/Mem:/{print $2" MB total, "$3" MB used, "$7" MB available"}'
981 MB total, 84 MB used, 753 MB available

$ for p in nginx easytier-core vaultwarden mariadbd sms.smtp.server syncserver; do \
    printf '%-16s %s MB\n' "$p" \
      "$(pgrep -f "$p" | xargs -r ps -o rss= -p | awk '{s+=$1} END{printf "%.1f", s/1024}')"; \
  done
nginx            6.3 MB
easytier-core    6.1 MB
vaultwarden      9.2 MB
mariadbd         7.4 MB
sms.smtp.server  6.4 MB
syncserver       3.2 MB
```

That is a web server, a VPN daemon, a password manager, a database, an SMTP service and a sync service — **about 39 MB of RAM for six services**. The box reports 84 MB used in total (the rest is the OS and a build that happened to be running). Disk: 14 GB total, 8.5 GB used, most of which is the blog repo at 613 MB.

That is the honest requirement for a large class of home stacks: **tens of megabytes, one core, a few gigabytes of disk**. Not 64 GB and a Xeon.

## What a home stack actually needs (measured)

The dev box I am typing this on is a laptop CPU from 2017 — an i7-8550U, 4 cores / 8 threads, 11.8 GB of RAM, a 234 GB root disk and two more disks hanging off it. It runs five Docker containers, a VPN daemon and a local model server, and it is not struggling.

```console
$ nproc; lscpu | grep -E 'Model name|^CPU\(s\)'
8
Model name:          Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
CPU(s):              8
$ free -m | awk '/Mem:/{print $2" MB total, "$3" MB used"}'
11833 MB total, 8832 MB used
$ df -h /
Filesystem              Size  Used Avail Use% Mounted on
/dev/mapper/cryptroot   234G  152G   70G  69% /
```

So the real requirements of a home stack are modest and easy to state:

- **Compute:** one modern core is enough for a static site, a few containers and a VPN. Two to four cores give you headroom for a CI job or a build.
- **Memory:** 4 GB is generous, 8 GB is comfortable. The blog host does its job in under 100 MB.
- **Storage:** a few hundred GB of SSD. Media libraries are the only thing that actually needs terabytes, and that is a different hobby.
- **Backups:** off-box, tested, and boring. This is the requirement people skip and then regret.
- **Network:** the router you already own. A VPN daemon is a few megabytes, not a separate box.

## What is genuinely cheap and useful

**A used mini PC.** An off-lease 6th–8th generation Intel mini PC (think the small office boxes that flood the second-hand market) is the sweet spot. Realistic bands are **¥800–1,500** for the machine and **¥250–450** for a 500 GB SSD — prices vary a lot by region and timing, so check locally rather than trusting any single number, mine included. It idles around 8–12 W, is silent, and is small enough to sit on a shelf.

**One SSD.** Buy the storage you will use this year. A single 500 GB drive holds more containers, images and notes than most people will ever create.

**A UPS is optional.** If your power is stable, a mini PC survives brief outages fine — a static site does not care, and most services recover on their own. A small line-interactive UPS (roughly ¥200–400) is worth it if you have frequent brownouts or a machine that does something write-sensitive. It is insurance, not a requirement.

**A Pi for one job.** A single-board computer is excellent at exactly one thing: being always-on for almost no power (5 W class). Ad-blocking DNS, a VPN endpoint, a small uptime monitor. It is not a general-purpose server and you should not pretend it is.

**The old laptop you already own.** This is the cheapest homelab on the list: **¥0 in hardware**, because the sunk cost is already sunk. A laptop even has a built-in UPS (its battery) and a screen for setup. If you are unsure whether you need a homelab at all, this is the experiment to run first.

## What is a waste for most people

- **A rack.** You have one or two machines. A shelf is a rack. Racks exist to hold dozens of units and manage their airflow and cabling; at home they hold dust.
- **10GbE.** Your internet connection is not 10 Gb, your disks are the bottleneck, and a single stream from your phone will not saturate 1 Gb either. Fast Ethernet is a lab-shaped solution to a problem you do not have.
- **Enterprise gear.** Old 1U servers are cheap to buy and expensive to run — see the arithmetic below. They are also loud enough that you will turn them off, which defeats the purpose.
- **A hypervisor with one VM.** Virtualisation earns its complexity when you run several isolated guests. For one workload you want a package manager and systemd, not a hypervisor. I already argued this in [Proxmox vs plain Linux](/posts/proxmox-vs-plain-linux/), and the measured stack above is the proof: everything fits in a normal OS.
- **"Just in case" capacity.** The blog host uses **84 MB of 981 MB** and **8.5 GB of 14 GB**. Capacity you buy "just in case" is capacity you paid for, powered, cooled and backed up for nothing. Buy for the workload you have; the used market will still be there next year.
- **Untested redundancy.** A second disk that has never been restored from is not a backup. See below.

## The real homelab total cost over 3 years

Here is where a budget gets real. I wrote a small script to compute the **homelab total cost** over three years — electricity plus hardware amortisation — and compared it to renting a VPS. Two honest caveats first: I have no power meter on my box, so the watt figures are **typical published idle/load figures for each hardware class**, and the tariff is an **assumption** (China residential tier-1, roughly ¥0.56/kWh; real rates run about ¥0.5–0.6 and vary by region and tier).

```js
// 3-year TCO: owning a homelab box vs renting a VPS.
const HOURS_3YR = 3 * 365 * 24;      // 26,280 h
const TARIFF = 0.56;                 // ¥/kWh (assumption)
const kwh  = (w) => w * HOURS_3YR / 1000;
const elec = (w) => kwh(w) * TARIFF;

const scenarios = [                  // name, upfront ¥, avg watts
  ['Used mini PC + SSD (+UPS)',   1200 + 350 + 300, 18],
  ['Used mini PC + SSD (no UPS)', 1200 + 350,       18],
  ['Used 1U enterprise server',   900,              90],
  ['Old laptop (already owned)',  0,                12],
  ['Pi-class board + PSU + SD',   400,               5],
];
```

Run it and you get a real table, not a vibe:

```console
Assumptions: 26,280 h over 3 yrs, tariff ¥0.56/kWh

| Setup                        | Upfront | Electricity (3 yr) | TCO (3 yr) | ¥/mo equiv | Elec % |
|------------------------------|---------|--------------------|------------|------------|--------|
| Used mini PC + SSD (+UPS)    | ¥1,850  | ¥265 (473 kWh)     | ¥2,115     | ¥59        | 13%    |
| Used mini PC + SSD (no UPS)  | ¥1,550  | ¥265 (473 kWh)     | ¥1,815     | ¥50        | 15%    |
| Used 1U enterprise server    | ¥900    | ¥1,325 (2365 kWh)  | ¥2,225     | ¥62        | 60%    |
| Old laptop (already owned)   | ¥0      | ¥177 (315 kWh)     | ¥177       | ¥5         | 100%   |
| Pi-class board + PSU + SD    | ¥400    | ¥74 (131 kWh)      | ¥474       | ¥13        | 16%    |
| VPS at ¥20/mo                | ¥0      | — (included)       | ¥720       | ¥20        | —      |
| VPS at ¥40/mo                | ¥0      | — (included)       | ¥1,440     | ¥40        | —      |
| VPS at ¥60/mo                | ¥0      | — (included)       | ¥2,160     | ¥60        | —      |

Payback vs "mini PC, no UPS" (¥1,550 upfront, ~¥7.4/mo in power):
  vs VPS ¥20/mo: 123 months (10.2 yrs) — beyond the 3-yr window
  vs VPS ¥40/mo:  47 months (4.0 yrs)  — beyond the 3-yr window
  vs VPS ¥60/mo:  29 months (2.5 yrs)
```

<figure>
<svg viewBox="0 0 760 250" role="img" aria-label="3-year total cost of ownership, stacked by hardware, UPS, and electricity" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  <text x="0" y="20" fill="currentColor" font-size="13" font-family="ui-monospace,monospace">3-year TCO — where the money goes</text>
  <g font-size="12" font-family="ui-monospace,monospace" fill="currentColor">
    <text x="160" y="66" text-anchor="end">Mini PC (owned)</text>
    <text x="160" y="128" text-anchor="end">1U server</text>
    <text x="160" y="190" text-anchor="end">VPS ¥40/mo</text>
  </g>
  <rect x="170" y="46" width="295" height="32" fill="#0f766e"/>
  <rect x="465" y="46" width="57" height="32" fill="#0f766e" opacity="0.5"/>
  <rect x="522" y="46" width="50" height="32" fill="currentColor" opacity="0.3"/>
  <rect x="170" y="108" width="171" height="32" fill="#0f766e"/>
  <rect x="341" y="108" width="252" height="32" fill="currentColor" opacity="0.3"/>
  <rect x="170" y="170" width="274" height="32" fill="currentColor" opacity="0.18"/>
  <g font-size="12" font-family="ui-monospace,monospace" fill="currentColor">
    <text x="580" y="66">¥2,115</text>
    <text x="601" y="128">¥2,225</text>
    <text x="452" y="190">¥1,440</text>
  </g>
  <g font-size="11" font-family="ui-monospace,monospace" fill="currentColor">
    <rect x="170" y="224" width="12" height="12" fill="#0f766e"/>
    <text x="188" y="234">hardware</text>
    <rect x="270" y="224" width="12" height="12" fill="#0f766e" opacity="0.5"/>
    <text x="288" y="234">UPS</text>
    <rect x="340" y="224" width="12" height="12" fill="currentColor" opacity="0.3"/>
    <text x="358" y="234">electricity</text>
  </g>
</svg>
<figcaption>At ¥0.56/kWh electricity is only ~13% of a mini-PC homelab — but it is 60% of the same job on a used 1U server. The hardware is a one-time cost; the watts are forever.</figcaption>
</figure>

## The electricity cost arithmetic

The formula is trivial: `watts × hours × ¥/kWh`. Over three years that is `watts × 26,280 ÷ 1000 × 0.56`. Two things fall out of it that a shopping list will never tell you:

1. **At Chinese residential rates, electricity is not the biggest line for a mini PC.** 18 W × 26,280 h = 473 kWh = ¥265 over three years — about 13% of the total. Hardware dominates.
2. **Electricity becomes the biggest line the moment you buy the wrong hardware or live where power is dear.** A used 1U server idling at 90 W burns 2,365 kWh = ¥1,325 over three years — **60% of its total cost**, and more than the machine cost to buy. At a higher tariff like ¥1.00/kWh, the same mini PC's power bill nearly doubles to ¥473, and the server's jumps to ¥2,365.

So the honest version of "electricity is often the biggest cost" is: it is the cost that **never stops**, and it is the line that punishes cheap-looking deals. A ¥900 server that costs ¥1,325 to run is not a ¥900 server. When people say a homelab is expensive, they usually mean the watts.

## A mini PC homelab vs a VPS

This is the trade-off people get wrong in both directions. Over three years:

- A **budget VPS** (¥20–40/month) is often *cheaper* than buying a new mini PC. At ¥40/month it costs ¥1,440 over three years — less than the ¥2,115 mini PC — and you never touch the hardware, never hear a fan, never lose power. The crossover, from the script above, is around **four years** at ¥40/month and about **2.5 years** at ¥60/month.
- A **mini PC homelab** wins when you already own the hardware (the old laptop row: ¥177 total), when the VPS you need is expensive (more RAM or CPU than a ¥40 plan gives), when you need local storage or a GPU, or when you simply want to own it.

The pragmatic answer most people should hear: **rent a cheap VPS for the public-facing bits, and use the machine you already own as the lab.** That is close to what I do — the blog lives on the ¥-cheap box, the experiments live on the laptop. I keep a deliberately short list of what I self-host in 2026; the list stays short because the cheapest stack is the one you have to maintain least.

## Honest advice

- **Start with the smallest thing that solves your problem.** Often that is a single VPS or the laptop you already have. Upgrade when something hurts, not before.
- **Back up before you buy more.** A second machine that mirrors an unbacked-up disk is two copies of the same mistake. Get one tested, off-box backup working first.
- **Buy the second disk before the second machine.** Redundancy for your data beats capacity for your compute. A mirror of the disk you care about is worth more than another node to run containers on.
- **Measure before you upgrade.** Run `free -m`, `df -h`, `ps aux --sort=-%mem`. If you are using 84 MB of 981 MB, your problem is not RAM. The numbers above are why I have not bought a bigger box: I cannot justify it against a real measurement.

## What this blog's own stack actually uses

So the whole point, measured once more, plainly:

| | This blog's host | The dev laptop |
|---|---|---|
| CPU | 1 vCPU | i7-8550U, 4c/8t |
| RAM | 981 MB (84 MB used) | 11.8 GB |
| Disk | 14 GB (8.5 GB used) | 234 GB root + 2 disks |
| Services | nginx, easytier, vaultwarden, MariaDB, SMTP, sync — ~39 MB total | 5 containers + VPN + local model |

The blog serves 254 articles in two languages, an OG-image pipeline and a VPN endpoint from **under 100 MB of RAM**. The load average you might see on it (3.09 when I looked) was an Astro build running at that exact moment, not steady state — which is itself the lesson: measure at the right time, or you will buy hardware to fix a spike that lasts ninety seconds.

A homelab on a budget is not a smaller version of a datacenter. It is the realisation that most home workloads are tiny, that the used market sells perfectly good small machines, and that the cost that actually compounds is the electricity — so buy small, buy used, and spend the savings on a backup disk.
