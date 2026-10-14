---
title: "Raspberry Pi vs mini PC vs VPS: where should the service actually run?"
description: "A decision, not a shopping list: Raspberry Pi vs mini PC vs VPS judged on real measured CPU, disk and CPU-steal numbers from a laptop and a 1-vCPU VPS, plus power consumption, TDP, public IP and the mesh-VPN split."
pubDate: 2027-02-17
lang: en
translationKey: raspberry-pi-vs-mini-pc-vs-vps
tags: [homelab, self-hosting]
featured: false
keywords:
  - Raspberry Pi vs mini PC
  - homelab hardware
  - VPS vs home server
  - power consumption
  - total cost of ownership
  - TDP
  - mesh VPN
---

Every few weeks somebody asks me some version of the same question: *I want to run X at home — should I buy a Raspberry Pi, a mini PC, or just rent a VPS?* I used to answer with a shopping list. That was wrong, because the question is not "what should I buy", it is "**where should this service actually live**" — and the answer turns on one thing above all: who has to be able to reach it.

Here is my answer, built from numbers on machines I can actually touch, with an honest line drawn around the numbers I cannot.

I own exactly two of the three shapes: a laptop-class x86 box I develop on, and a 1-vCPU VPS that serves this blog. **I do not own a Raspberry Pi.** Everything I say about the Pi below comes from Raspberry Pi's own product brief, and I label it that way. You should not take my word for a board I have never booted.

## The two machines I can actually measure

The dev box first. It is a 2017-vintage laptop — which is the right reference point for "mini PC" arguments, because it is a 15 W-class x86 chip in a small chassis doing real work:

```console
$ nproc; LC_ALL=C lscpu | grep -E 'Model name|^CPU\(s\)|Core\(s\) per|Thread\(s\) per'
8
Model name:  Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
CPU(s):      8
Core(s) per socket: 4
Thread(s) per core:  2
$ LC_ALL=C free -m | head -2
               total        used        free      shared  buff/cache   available
Mem:          11833        7968         454         247        4032        3865
$ lsblk -d -o NAME,ROTA,SIZE,MODEL
NAME  ROTA   SIZE MODEL
sda      1 298.1G WDC WD3200BUCT-63TWBY0
sdb      0 238.5G Micron_1100_MTFDDAV256TBN
sdc      1 116.5G Card Reader
$ df -h /
/dev/mapper/cryptroot   234G  157G   65G  71% /
```

Two disks, and the `ROTA` column is the point: `sda` spins (298 GB, `/data`), `sdb` is a SATA SSD (238 GB, `/`). Same machine, same OS, wildly different IO — I will come back to that with measurements.

Now the public box, read-only over SSH:

```console
$ ssh -p622 root@88.218.79.95 'nproc; uptime; df -h /; grep -m1 "model name" /proc/cpuinfo'
1
 12:13:44 up 23 days, 20:56,  0 users,  load average: 2.07, 1.55, 0.74
/dev/vda1        14G  8.5G  4.2G  68% /
model name	: Intel(R) Xeon(R) CPU E5-2630 v4 @ 2.20GHz
```

**One vCPU. 981 MB of RAM. 14 GB of disk. And a load average of 2.07 on a machine reporting one CPU.** That is the VPS experience in one line: the box is a single core of a 10-core Xeon, and the other nine are busy with somebody else's work. I sampled CPU steal in two separate 5-second windows — **0.60 % in one, 0.00 % in the other**. The sharing is real but mild right now, which is exactly what you want to know before trusting a benchmark you ran once.

## What each shape is actually good at

### Raspberry Pi: the GPIO machine

The Pi 5 is not a small general-purpose server; it is a **sensor-and-actuator board that happens to run Linux**. From the official product brief: Broadcom BCM2712, quad-core Arm Cortex-A76 at 2.4 GHz, 512 KB L2 per core plus a 2 MB shared L3, a 40-pin GPIO header, one PCIe 2.0 x1 lane for NVMe via an M.2 HAT, and 5 V/5 A USB-C power (25 W board ceiling, 27 W PSU recommended). List prices run $45 (1 GB) to $175 (8 GB). **These are from-spec figures, not measurements.**

It wins at three things: **3.3 V digital IO plus I2C, SPI and UART on a header** — no x86 box and no VPS gives you this, so "read a sensor, flash a relay" is the only correct answer; **single-digit-watt idle power**, so it can sit powered for years; and being **cheap enough to be disposable** in a shed.

It loses at two, honestly. **CPU and IO** — four 2.4 GHz cores are fine for an ad-blocking DNS resolver and hopeless for a build. And **SD-card fragility**: microSD is the default boot device, and an always-on service writing logs plus a database is precisely the workload that kills cards. The Pi 5's PCIe lane fixes this by booting from NVMe through an M.2 HAT — at extra cost, with an extra part to fail. I tried to measure my own card reader to show the damage and could not: `/dev/sdc1` is not readable by my unprivileged user, so I will not invent SD-card numbers. A Pi also still owns its own uptime: no public IP, no battery, no failover.

### Mini PC: the home box

A mini PC is the shape my dev box approximates: a 15 W-class x86 chip, a real SSD, 8–16 GB of RAM, silent, shelf-sized. Its **TDP** is what makes the category work — my i7-8550U is specified at **15 W**, with configurable TDP-up 25 W and TDP-down 10 W (Intel's specs; a TDP is a *thermal design* figure, not a wall measurement).

The honest trade is that **you own the hardware**. No rent, no noisy neighbour, real disks, a real upgrade path — swap the SSD, add RAM, or move the drives into a new box and keep the data. In exchange you own the power bill, the fan noise, the disk failure, the power cut, and the 3 a.m. "why is the box offline" debugging. Nobody else is on call for your uptime.

### VPS: someone else's uptime

A VPS is the only shape that arrives with a **public IP and somebody else's operations**: no hardware to babysit, a snapshot button, an IPv6 range, and power and network as somebody's day job. What you give up: you rent forever, the CPU is shared (measured above), the disk is whatever the hypervisor hands you, and a public IPv4 on a residential connection is exactly what most home ISPs will not sell you.

## The five criteria that actually decide it

Forget brand names. These five pick the shape: **power consumption over three years** (the cost that never stops, and the one that punishes cheap-looking deals); **IO** — not CPU cores, because cores can be shared and a spinning disk cannot; **uptime and backup responsibility** — who gets paged, and who else holds a copy; **public IP / reachability** — who must be able to connect; and **noise and upgrade path** — can you live next to it, and can you grow it?

## Measured here vs from spec

Everything I claim, with its source, because "from spec" and "measured here" are not the same claim:
| Quantity | Value | Source |
|---|---|---|
| Dev-box CPU | i7-8550U, 4C/8T, 1.80 GHz base, 4.00 GHz max, L3 8 MiB | measured (`lscpu`) |
| Dev-box CPU TDP | 15 W (cTDP-up 25 W, cTDP-down 10 W) | **from spec** (Intel) |
| Dev-box disks | SSD 303 MiB/s seq / HDD 70 MiB/s seq | measured (`fio`) |
| VPS CPU | 1 vCPU of Xeon E5-2630 v4 @ 2.20 GHz, 981 MB RAM | measured, read-only SSH |
| VPS CPU share | load avg 2.07 on 1 vCPU; steal 0.60 % / 0.00 % | measured (`/proc/stat`) |
| VPS disk | 0.79–2.7 GB/s seq (3.4× spread); 3,323 IOPS 4 KiB | measured (`dd`, `pread`) |
| Pi 5 CPU | BCM2712, 4×Cortex-A76 @ 2.4 GHz, 2 MiB L3 | **from spec** (Raspberry Pi) |
| Pi 5 power | 25 W ceiling, 27 W PSU recommended | **from spec** |
| Wall power of *my* box | **not measured** — see below | — |

I have no wall-watt numbers of my own and I am not going to fake them. The RAPL energy counters exist on this laptop (`/sys/class/powercap/intel-rapl:0/energy_uj`) but are not readable by my user, and I have no plug meter. **If you want honest power numbers, buy a plug meter** — the cheapest instrument in homelab hardware, and it turns "about 10 W" into a fact.

## What I could measure: CPU and IO

A small C benchmark (xorshift + LCG, no allocation, `gcc -O2`), best of several runs:

```console
$ ./bench 1 200000000
threads=1 iters_per_thread=200000000 total_iters=200000000 seconds=0.820 Mops/s=244.0
$ ./bench 4 100000000
threads=4 iters_per_thread=100000000 total_iters=400000000 seconds=0.585 Mops/s=684.0
$ uptime
 19:30:08 up 2 days, 15:17,  1 user,  load average: 5.71, 7.83, 6.81
```

Four threads give **2.8×**, not 4×, the single-thread number — a laptop power and thermal limit, on a chip whose spec TDP is 15 W. Note the load average too: **5.71 on 8 threads**. This box is doing other work while I benchmark it, which is why repeated single-thread runs landed between 176 and 259 Mops/s. That spread is not noise to hide; it is the honest behaviour of a busy machine, and the reason one VPS benchmark proves nothing.

The same serial workload on the VPS, in Python:

```console
# on the VPS: trial-division primes < 300000, best of 3
{"bench": "trial-division primes < 300000", "primes": 25997, "best_seconds": 1.156, "threads": 1}
```

Against **0.889 s** on the dev box — the VPS is ~1.3× slower on identical Python, despite its CPU being a 10-core, 85 W Xeon on paper. One shared vCPU is one shared vCPU.

Now the part that actually settles most homelab arguments — **disk IO**, same machine, `direct=1` to bypass the page cache:

```console
$ fio --name=ssd_seq --rw=read --bs=1M --size=256M --direct=1 --filename=$HOME/b.dat
   READ: bw=303MiB/s (318MB/s), io=256MiB (268MB), run=844-844msec
$ fio --name=ssd_rnd --rw=randread --bs=4k --size=256M --direct=1 --iodepth=16
   READ: bw=9.88MiB/s (10.4MB/s), io=256MiB (268MB), run=25915-25915msec
$ fio --name=hdd_seq --rw=read --bs=1M --size=256M --direct=1 --filename=/data/backup/home/b.dat
   READ: bw=70.3MiB/s (73.7MB/s), io=256MiB (268MB), run=3640-3640msec
$ fio --name=hdd_rnd --rw=randread --bs=4k --size=16M --direct=1 --iodepth=1
   READ: bw=193KiB/s (198kB/s), io=16.0MiB (16.8MB), run=84943-84943msec
```

Read that last line again: **49 random 4 KiB reads per second** — the 256 MiB version of the same test did not finish inside 120 seconds. One machine, two disks, a **4× sequential gap and a 50× random gap**, measured on a *good* spinning disk, not a worn card. This is the number that kills "a Pi with a big SD card is a NAS" before it starts.

And the VPS's disk, the punchline about renting shared hardware:

```console
$ for i in 1 2 3; do dd if=/dev/vda of=/dev/null bs=1M count=512 iflag=direct 2>&1|tail -1; done
536870912 bytes (537 MB, 512 MiB) copied, 0.570641 s, 941 MB/s
536870912 bytes (537 MB, 512 MiB) copied, 0.21896 s, 2.5 GB/s
536870912 bytes (537 MB, 512 MiB) copied, 0.199249 s, 2.7 GB/s
$ python3 -c 'random 4KiB pread over /dev/vda, 2000 reads'
device=/dev/vda size=15032385536 bytes  random 4KiB pread: 2000 reads in 0.60 s = 3323 IOPS
```

Sequential read ranged from **0.79 to 2.7 GB/s** across my sessions — a 3.4× spread from the *same* device, because the host's storage and cache are shared. Random 4 KiB at **3,323 IOPS** is perfectly fine (there is clearly NVMe behind it), but that sequential number moved by a factor of three. **A rented CPU and a rented disk both belong to somebody else's day.**

## Total cost of ownership, without a shopping list

I already wrote the full three-year TCO table in [A homelab on a budget](/posts/homelab-on-a-budget/), so I will not repeat it. What matters here is the shape of the arithmetic, so you can redo it with your own numbers:

- Electricity is `watts × 26,280 h ÷ 1000 × ¥/kWh` over three years. At a low-power x86 box it is a *minority* of the total and hardware dominates; at a used 1U server it becomes the *majority*, which is why "cheap enterprise gear" is the most expensive homelab mistake.
- A budget VPS is **rent**, a straight line: `¥/month × 36`. At a few tens of yuan a month it lands in the same ballpark as a used mini PC — and it never breaks, never loses power, and arrives with a public IP you cannot buy at home.
- The crossover that matters is not "which is cheaper" but "**which cost is still running in year four**". Hardware amortises to zero. Rent does not.

The honest framing: the Pi is cheapest to buy, the mini PC is cheapest to own if you already have it, and the VPS is cheapest to *not think about*.

## The decision tree

Answer these in order:

1. **Does it need a public URL, a public IP, or "always up even when my power is out"?** → **VPS.** Nothing else here comes with a public IP or somebody else's uptime. (How to pick one: [Choosing a VPS](/posts/choosing-a-vps/).)
2. **Is it media, backups, a big local library, or an experiment you rebuild monthly?** → **Mini PC.** Local bytes, local bandwidth, no per-gigabyte rent.
3. **Does it touch a sensor, a relay, a motor, or a GPIO header?** → **Pi.** The only shape with IO pins.
4. **Unsure?** → Start with the machine you already own and rent the smallest VPS that covers the public edge. Both are reversible.

What runs *inside* the home box is a separate question: for one or two workloads, plain Linux and systemd beat a hypervisor every time — I argued it in [Proxmox vs plain Linux](/posts/proxmox-vs-plain-linux/).

## Why not both — the split I actually run

The answer that dissolves this whole debate is not "pick one" but **"split by who must reach it"**:

- **Public-facing → the VPS.** Nginx for this blog, the VPN endpoint, anything a stranger's browser touches. It has the public IP and the uptime.
- **Big, private, or boring → the home box.** Backups, media, a scratch lab, anything measured in hundreds of gigabytes. It has the disks and costs no rent.
- **Join them with a mesh VPN**, not a port forward. My own VPS runs `easytier-core` alongside nginx, a password manager and a database, and the mesh makes the home box reachable without exposing one port to the internet — setup in [A private mesh with EasyTier](/posts/private-mesh-with-easytier/).

The rule underneath: **put the thing that must be reachable on the thing with the public IP; put the thing that must be durable on the thing you control.** A VPS can vanish in a billing dispute and a home disk can die silently; a mesh VPN joining them turns both into one boring, recoverable system.

<figure>
<svg viewBox="0 0 760 300" role="img" aria-label="Raspberry Pi, mini PC and VPS compared on power, CPU, disk, GPIO and public IP" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
  <g font-family="ui-monospace,monospace" font-size="11">
    <rect x="8" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="8" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="22" y="28" fill="#ffffff" font-size="13" font-weight="700">Raspberry Pi</text>
    <text x="22" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="86" y="56" fill="currentColor">single-digit W idle</text>
    <text x="22" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="86" y="76" fill="currentColor">4xA76 @ 2.4 GHz</text>
    <text x="22" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="86" y="96" fill="currentColor">microSD (fragile)</text>
    <text x="22" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="86" y="116" fill="currentColor">40-pin header</text>
    <text x="22" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="86" y="136" fill="currentColor">none</text>
    <line x1="22" y1="156" x2="230" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="22" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="22" y="200" fill="currentColor">sensors, relays,</text>
    <text x="22" y="218" fill="currentColor">embedded, GPIO</text>
    <text x="22" y="248" fill="currentColor" opacity="0.6">you own the uptime</text>

    <rect x="262" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="262" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="276" y="28" fill="#ffffff" font-size="13" font-weight="700">Mini PC (x86)</text>
    <text x="276" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="340" y="56" fill="currentColor">6-15 W idle</text>
    <text x="276" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="340" y="76" fill="currentColor">4-8 cores, real</text>
    <text x="276" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="340" y="96" fill="currentColor">SATA / NVMe SSD</text>
    <text x="276" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="340" y="116" fill="currentColor">none</text>
    <text x="276" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="340" y="136" fill="currentColor">none (NAT)</text>
    <line x1="276" y1="156" x2="484" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="276" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="276" y="200" fill="currentColor">media, backups,</text>
    <text x="276" y="218" fill="currentColor">homelab, big disks</text>
    <text x="276" y="248" fill="currentColor" opacity="0.6">you own the hardware</text>

    <rect x="516" y="8" width="236" height="284" rx="6" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="516" y="8" width="236" height="30" rx="6" fill="#0f766e"/>
    <text x="530" y="28" fill="#ffffff" font-size="13" font-weight="700">VPS</text>
    <text x="530" y="56" fill="currentColor" opacity="0.6">power</text>
    <text x="594" y="56" fill="currentColor">someone else's bill</text>
    <text x="530" y="76" fill="currentColor" opacity="0.6">cpu</text>
    <text x="594" y="76" fill="currentColor">1 shared vCPU</text>
    <text x="530" y="96" fill="currentColor" opacity="0.6">disk</text>
    <text x="594" y="96" fill="currentColor">hypervisor image</text>
    <text x="530" y="116" fill="currentColor" opacity="0.6">gpio</text>
    <text x="594" y="116" fill="currentColor">none</text>
    <text x="530" y="136" fill="currentColor" opacity="0.6">public ip</text>
    <text x="594" y="136" fill="currentColor">yes, included</text>
    <line x1="530" y1="156" x2="738" y2="156" stroke="currentColor" stroke-opacity="0.2"/>
    <text x="530" y="180" fill="#0f766e" font-weight="700">use when</text>
    <text x="530" y="200" fill="currentColor">public site, public</text>
    <text x="530" y="218" fill="currentColor">IP, always-on</text>
    <text x="530" y="248" fill="currentColor" opacity="0.6">you rent forever</text>
  </g>
</svg>
<figcaption>FIG. Three shapes, three different debts to pay: the Pi costs you IO, the mini PC costs you uptime, the VPS costs you rent. None of them costs you CPU — every shape has "enough" of that.</figcaption>
</figure>

## What I would do

If you are asking me today, with no Pi on my desk and both other shapes in front of me: **rent the smallest VPS that will hold your public edge, and run everything else on the box you already own.** Add a Pi only when a wire needs plugging into a header. Buy a mini PC when "the box you already own" stops being enough — and buy the SSD before you buy the machine.

The one thing I would refuse to decide on is a single benchmark. My own numbers above spread by 50 % depending on what else the machine was doing, and by 3.4× on a disk that never moved. **Measure your workload, on your box, at the hour it will actually run.** That is the only homelab hardware advice that survives contact with reality.
