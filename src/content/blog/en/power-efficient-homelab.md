---
title: "Making a homelab power-efficient (measured, not guessed)"
description: "Homelab power consumption measured, not guessed: real RAPL readings of idle power vs busy on an i7-8550U, a CPU governor A/B test, and an honest checklist for a power-efficient server."
pubDate: 2027-02-19
lang: en
translationKey: power-efficient-homelab
tags: [homelab, linux]
featured: false
keywords:
  - homelab power consumption
  - power efficient server
  - RAPL
  - idle power
  - CPU governor
---

Homelab power advice is full of confident numbers and very little measurement, so I measured my own box. This is the honest version: what **idle power** actually costs, measured here with **RAPL** on a real 4-core Intel machine, what flipping the **CPU governor** changed (less than you would expect), and where the watts really go if you want a genuine **power efficient server** instead of a warm room. The machine is my dev box: an ASUS VivoBook S14 X430UN with an Intel Core i7-8550U, running Arch, a browser, KDE and Docker. It is never truly idle, so treat every number below as a floor — which is itself the first lesson: your box is less idle than you think, and only the measurement tells you so.

## Why idle power matters: the arithmetic of 24/7

A homelab is a recurring cost: watts times hours, always on. At a typical Chinese residential rate of about ¥0.55/kWh (use your own tariff):

| Device draw | Energy/year (24×7) | Cost/year @ ¥0.55/kWh |
| --- | --- | --- |
| 10 W (small ARM board) | 87.6 kWh | ¥48 |
| 25 W (SSD-only x86 box) | 219 kWh | ¥120 |
| 40 W (spinning disk + parked dGPU) | 350 kWh | ¥193 |
| 60 W (two boxes, HDDs, tired PSU) | 526 kWh | ¥289 |

```bash
awk 'BEGIN{for(w=10;w<=60;w+=10){kwh=w*8760/1000; printf "%3dW  24x7 = %7.1f kWh/yr = %.0f CNY/yr\n", w, kwh, kwh*0.55}}'
#  10W  24x7 =    87.6 kWh/yr = 48 CNY/yr
#  20W  24x7 =   175.2 kWh/yr = 96 CNY/yr
#  30W  24x7 =   262.8 kWh/yr = 145 CNY/yr
#  40W  24x7 =   350.4 kWh/yr = 193 CNY/yr
#  50W  24x7 =   438.0 kWh/yr = 241 CNY/yr
#  60W  24x7 =   525.6 kWh/yr = 289 CNY/yr
```

The 10 W-to-40 W gap is ¥145 a year — not life-changing, but it compounds with every extra box. The key property of idle power is that it is *structural*: it is decided by the hardware you bought and the services you forgot to disable, not by how much you use the machine. A box that idles at 40 W pays that tax whether you touch it or not.

## What actually draws power in a homelab

- **The CPU package at idle.** A parked core costs a fraction of a watt, but the package — cores, uncore, and on this platform DRAM — never reaches zero. Package idle is the floor of the whole machine.
- **DRAM.** A couple of watts that never sleeps. This is why suspend-to-RAM is a real option and not a gimmick.
- **Spinning disks.** A 2.5-inch 5400 RPM drive is typically one to two watts running by its datasheet, and a fraction of that in standby — spec figures, not measurements; check your drive's sheet. One disk is fine, four is a budget. SSDs idle lower and have nothing to spin down.
- **A discrete GPU doing nothing.** The laptop classic: mine has an Intel iGPU and an NVIDIA MX150 (25 W TDP per spec), and their runtime power states are:

```bash
$ lspci -nnk | grep -Ei 'vga|3d'
00:02.0 VGA compatible controller [0300]: Intel Corporation Kaby Lake-R GT2 [UHD Graphics 620] [8086:5917] (rev 07)
01:00.0 3D controller [0302]: NVIDIA Corporation GP108M [GeForce MX150] [10de:1d10] (rev a1)
$ # runtime PM state of each GPU:
0000:00:02.0 class=0x030000 driver=i915   power_state=D3hot runtime=suspended control=auto
0000:01:00.0 class=0x030200 driver=nvidia power_state=D0    runtime=active    control=on
```

The iGPU is properly asleep in D3hot. The MX150 is fully powered, D0, doing nothing at all, because the proprietary driver holds it active. That is the "discrete GPU idling" problem, and it is invisible until you read the sysfs state.
- **The PSU.** A tired ATX supply at low load typically runs 80-85% efficient (80 PLUS curves, spec territory), so 60 W of load quietly asks the wall for 70 W. A good modern unit, or a 12 V DC supply at native voltage, is a legitimate homelab upgrade.
- **Network gear.** One managed switch is 5-15 W; five switches is 50 W you never think about.

## How I measured it here — and what I could not

I do not own a wall meter, so none of the numbers below are *wall* watts: a plug-in meter is the only true total, and it settles every argument. What this box does have is RAPL, the Intel energy counters exported through the kernel's powercap interface. The **package** domain here contains core, uncore and the DRAM sub-domain; it says nothing about fans, disks, screen or PSU losses. Reading it needs root:

```bash
$ cat /sys/class/powercap/intel-rapl:0/energy_uj
cat: '/sys/class/powercap/intel-rapl:0/energy_uj': Permission denied

$ LC_ALL=C lscpu | grep -E 'Model name:|CPU\(s\):|Vendor ID:|Thread\(s\) per core:|Core\(s\) per socket:|CPU max MHz:|CPU min MHz:'
CPU(s):                                  8
Vendor ID:                               GenuineIntel
Model name:                              Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz
Thread(s) per core:                      2
Core(s) per socket:                      4
CPU max MHz:                             4000.0000
CPU min MHz:                             400.0000
```

Note what `lscpu` does not say: TDP. Intel's spec sheet rates this part at 15 W, but the firmware's own limit is very different:

```bash
$ sudo cat /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
44000000                      # µW → PL1 = 44 W sustained, from sysfs
$ for d in /sys/class/powercap/intel-rapl:0*; do echo "$d -> $(sudo cat $d/name)"; done
/sys/class/powercap/intel-rapl:0 -> package-0
/sys/class/powercap/intel-rapl:0:0 -> core
/sys/class/powercap/intel-rapl:0:1 -> uncore
/sys/class/powercap/intel-rapl:0:2 -> dram
```

Two drivers export these counters (an MSR-backed `intel-rapl` and an MMIO variant), and reading both over the same window is a good sanity check that the numbers are not fiction — they agreed to within 28 mJ across a 5 s window. The tools of the trade, though, are absent here:

```bash
$ which turbostat powertop cpupower rapl
turbostat not found
powertop not found
cpupower not found
rapl not found
```

So everything below is plain sysfs, which has one advantage: raw counters, no tool in between.

## Idle power vs busy power, measured

Boring method: read the counters, sleep a known window, read again, divide. Three windows at the box's normal desktop load, then three with eight busy threads (openssl AES keeps all eight hyperthreads calculating):

```
idle run 1 (8s window)  pkg=15.11W  core=13.32W  uncore=0.48W  dram=1.73W  (load 9.40 -> 9.13)
idle run 2 (8s window)  pkg=15.06W  core=13.28W  uncore=0.49W  dram=1.71W  (load 9.13 -> 8.64)
idle run 3 (8s window)  pkg=15.00W  core=13.47W  uncore=0.24W  dram=1.66W  (load 8.64 -> 8.46)

busy run 1 (8s window)  pkg=15.47W  core=14.24W  uncore=0.02W  dram=1.28W  (load 8.46 -> 9.78)
busy run 2 (8s window)  pkg=15.52W  core=14.17W  uncore=0.02W  dram=1.18W  (load 9.78 -> 10.81)
busy run 3 (8s window)  pkg=15.49W  core=14.44W  uncore=0.02W  dram=1.21W  (load 10.81 -> 11.14)
```

<figure>
  <svg viewBox="0 0 760 250" role="img" aria-label="Stacked bars of package power measured with RAPL: desktop baseline about 15.0 W split into core, uncore and DRAM, versus 15.5 W with eight busy AES threads" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12.5" fill="currentColor">
      <text x="170" y="24" font-size="13.5">Package power (RAPL), i7-8550U, measured</text>
      <line x1="170" y1="34" x2="640" y2="34" stroke="currentColor" stroke-opacity="0.25"/>

      <text x="0" y="60" font-size="12">desktop baseline</text>
      <text x="0" y="76" font-size="11" opacity="0.7">load ~8.5-9.4</text>
      <rect x="170" y="44" width="400" height="32" rx="5" fill="#0f766e" fill-opacity="0.55"/>
      <rect x="570" y="44" width="11" height="32" rx="5" fill="#0f766e" fill-opacity="0.35"/>
      <rect x="581" y="44" width="50" height="32" rx="5" fill="#0f766e" fill-opacity="0.18"/>
      <text x="636" y="65" font-size="12">15.0 W</text>

      <text x="0" y="124" font-size="12">8 busy threads</text>
      <text x="0" y="140" font-size="11" opacity="0.7">load ~9.8-11.1</text>
      <rect x="170" y="108" width="430" height="32" rx="5" fill="#0f766e" fill-opacity="0.62"/>
      <rect x="600" y="108" width="1" height="32" fill="#0f766e" fill-opacity="0.35"/>
      <rect x="601" y="108" width="37" height="32" rx="5" fill="#0f766e" fill-opacity="0.18"/>
      <text x="646" y="129" font-size="12">15.5 W</text>
      <text x="646" y="151" font-size="11" opacity="0.75">Δ ≈ +0.5 W</text>

      <rect x="170" y="176" width="12" height="12" rx="3" fill="#0f766e" fill-opacity="0.55"/><text x="188" y="186" font-size="11">core</text>
      <rect x="250" y="176" width="12" height="12" rx="3" fill="#0f766e" fill-opacity="0.35"/><text x="268" y="186" font-size="11">uncore</text>
      <rect x="340" y="176" width="12" height="12" rx="3" fill="#0f766e" fill-opacity="0.18"/><text x="358" y="186" font-size="11">DRAM</text>
      <text x="170" y="216" font-size="11" opacity="0.8">Both on a box that was already busy: the 8 threads displaced existing work,</text>
      <text x="170" y="232" font-size="11" opacity="0.8">so the delta is small. Package only — wall power is higher.</text>
    </g>
  </svg>
  <figcaption>Measured RAPL package power on the i7-8550U, split into sub-domains. The instructive part is the tiny delta: with the load average already at 8-9, eight new busy threads mostly displaced other work instead of adding it. Idle power is structural; busy work on a saturated machine is displacement.</figcaption>
</figure>

Two facts fall out. First, composition: at baseline 1.7 W of the 15 W package is DRAM — more than a tenth of the idle cost is memory that never sleeps. Second, the delta: eight busy threads added only about half a watt. That is not a claim that compute is free; it is what displacement looks like on a box already running a browser, KDE, Docker, a busy `baloo_file` indexer and swap thrash. On a genuinely idle homelab the same test would show a much bigger jump — which is why you measure yours instead of trusting mine.

The idle-state counters behind those numbers are just as real. Over this machine's 2.6-day uptime, summing every state at C6 or deeper gives 186,804 s of 228,281 s — about 82% of the time in deep idle:

```bash
$ for s in /sys/devices/system/cpu/cpu0/cpuidle/state*; do
    echo "$(cat $s/name) usage=$(cat $s/usage) time_us=$(cat $s/time)"
  done | sort -t= -k3 -rn | head -5
C10 usage=41225632 time_us=115034975762   # 50% of uptime in the deepest state
C8  usage=63150197 time_us=52246759382    # 23%
C6  usage=37683402 time_us=18217611489    # 8%
C1E usage=14641675 time_us=1346476474
C3  usage=11324009 time_us=1312197733
```

C-states are fine when the box sits on a desk. The homelab failure mode is different: a service that wakes the CPU every few seconds pins the package out of deep C-states forever. `powertop` shows that as a wakeup table; without it, watch whether C10 time actually grows while the box is quiet.

## The CPU governor curveball

Conventional wisdom says `powersave` saves and `performance` costs. I flipped the governor with an automatic restore, sampling idle and loaded windows on each side:

```
PERF idle            pkg=14.82W core= 13.77W dram=1.29W | load 6.06->6.06
PERF idle            pkg=15.25W core= 14.22W dram=1.27W
PERF +4 threads      pkg=15.07W core= 14.17W dram=1.07W
PERF idle freq mix:  all 8 CPUs ~3.10 GHz

SAVE idle            pkg=15.16W core= 14.13W dram=1.23W | load 6.14->6.29
SAVE idle            pkg=14.96W core= 13.88W dram=1.39W
SAVE +4 threads      pkg=15.15W core= 14.12W dram=1.17W
SAVE idle freq mix:  all 8 CPUs ~3.20 GHz
```

No measurable difference — and under `powersave` the frequencies were slightly *higher*. The reason is in sysfs: this CPU runs `intel_pstate` with hardware P-state control (HWP) and an energy-performance preference of `performance`, which already pins frequency high regardless of the software governor. On HWP-era Intel the knob that matters is EPP, not the governor's name; I left EPP alone because this is a working box tuned for responsiveness. Thermals moved with load as expected, 81-83 °C busy against 78-79 °C at baseline — the same work that raises watts raises temperature in the same package.

## The levers, ranked by watts saved per unit of effort

1. **Turn off what you are not using.** Consolidate five idle containers onto one box, retire the experimental VM that runs 24/7 for a two-hour-per-week job, replace a poller daemon with a systemd timer. Every removed service is its idle watts, permanently.
2. **Fix the parked dGPU.** Runtime power management, or `bbswitch`, parks a GPU you do not need. On my machine the one-line fix is `echo auto > /sys/bus/pci/devices/0000:01:00.0/power/control` — I did *not* run it: a working compute GPU is worth more to me than the watts. Your box, your trade.
3. **Suspend, don't idle.** This box has `s2idle` and `deep` available:

```bash
$ cat /sys/power/state
freeze mem disk
$ cat /sys/power/mem_sleep
s2idle [deep]        # '[deep]' marks the default
```

A `rtcwake -m mem -s 3600` timer lets a homelab sleep until 03:00, run the backup batch, and sleep again. If the machine is unused ten hours a day, sleeping beats every micro-optimisation combined.
4. **Disk policy.** Spin-down is real for spinning disks — `hdparm -B` sets aggressive power management, `-S` a standby timer. Mine is currently at the most aggressive *non*-spin-down setting, and I read rather than changed it:

```bash
$ sudo hdparm -C /dev/sda
/dev/sda:
 drive state is:  active/idle      # NOT spun down
$ grep -H . /sys/block/sd{a,b}/queue/rotational
/sys/block/sda/queue/rotational:1
/sys/block/sdb/queue/rotational:0
```

5. **Efficient power delivery.** A good 80 PLUS Gold/Platinum unit, or native 12 V DC, wins the lost percent back at low load. On paper, a 60 W load at 85% efficiency costs 71 W at the wall.
6. **Low-power boards for always-on duties.** For DNS, metrics or a file-sync node, an ARM board in the single-digit watts beats a repurposed office PC by design. I have not measured specific boards — check the datasheet and measure with the same method above.
7. **Governor and EPP last, not first.** As shown, the governor name may change nothing; try EPP, measure, and only then believe it.

## The honest trade-offs

Two levers bite. **Spin-down** adds latency — the first access after standby pays seconds of spin-up — and load/unload cycles on a disk touched every few minutes is wear, not savings. **Deep power states** add exit latency, which latency-sensitive services (a VPN endpoint, a phone-home agent) feel, and an over-eager EPP thins the scheduler's latency budget. **Sleep scheduling** breaks the assumption that your services are always there: backups, monitoring and DNS must tolerate a machine that is off at 04:00. Measure each change: saving 5 W that costs a second of tail latency on something user-facing is a trade, not a win.

## The checklist: measure first, then cut the biggest draw

1. Wall meter on the box for a week; note the idle floor.
2. Read RAPL: `sudo cat /sys/class/powercap/intel-rapl:0/energy_uj` twice over a known window; compare package idle against the table above.
3. Audit parked hardware: `lspci -nnk`, then each device's `power/runtime_status`. Park what is powered and unused.
4. Find what should not run at all: `systemctl list-timers`, forgotten containers, the experimental VM.
5. Only then touch governors, EPP, disk spin-down and suspend timers — and re-measure after each change.

That is the whole discipline. **Homelab power consumption** is not a mystery; it is a measurement problem with a small arithmetic table at the end. For the fleet-level view of the same problem, I wrote about [monitoring a small fleet](/posts/monitoring-a-small-fleet/), and on whether the hypervisor layer itself costs you watts, see [proxmox vs plain linux](/posts/proxmox-vs-plain-linux/).
