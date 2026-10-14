---
title: "把 Homelab 做得更省电（实测，而非猜测）"
description: "Homelab 功耗不能靠猜：本文在 i7-8550U 上用 RAPL 实测空闲功耗与满载功耗，对比 CPU 调频策略 performance/powersave 的真实差距（结论有点反直觉），并给出一份先测量、再压最大功耗项的省电清单，把省电服务器从玄学变成算术。"
pubDate: 2027-02-19
lang: zh
translationKey: power-efficient-homelab
tags: [homelab, linux]
featured: false
keywords:
  - Homelab 功耗
  - 省电服务器
  - RAPL
  - 空闲功耗
  - CPU 调频策略
  - 电费
---

关于 Homelab 省电的建议，到处都是笃定的数字和稀缺的实测，所以我把自己的机器测了一遍。这是不带滤镜的版本：**空闲功耗**到底是多少，用 **RAPL** 在一台真实的 4 核 Intel 机器上实测；切换 **CPU 调频策略**到底改变了什么（比你预期的少）；以及如果你真的想要一台**省电服务器**而不是一个取暖器，电到底省在哪里。被测的机器是我的开发机：一台 ASUS VivoBook S14 X430UN 笔记本，Intel Core i7-8550U，跑着 Arch、浏览器、KDE 和 Docker。它从来都不是真正空闲的，所以下面每个数字都当作下限来看——而这本身就是第一课：你的机器没你以为的那么闲，只有测量能告诉你这一点。

## 为什么空闲功耗重要：24×7 的算术

Homelab 是一笔 recurring cost（持续性支出）：瓦数乘以小时数，常年不断。按国内居民电价约 ¥0.55/kWh 估算（电价因地而异，请换成你自己的）：

| 设备功耗 | 一年耗电（24×7） | 一年电费 @ ¥0.55/kWh |
| --- | --- | --- |
| 10 W（小型 ARM 板） | 87.6 kWh | ¥48 |
| 25 W（纯 SSD 的 x86 主机） | 219 kWh | ¥120 |
| 40 W（机械盘 + 停着的独显） | 350 kWh | ¥193 |
| 60 W（两台主机、HDD、老化的电源） | 526 kWh | ¥289 |

```bash
awk 'BEGIN{for(w=10;w<=60;w+=10){kwh=w*8760/1000; printf "%3dW  24x7 = %7.1f kWh/yr = %.0f CNY/yr\n", w, kwh, kwh*0.55}}'
#  10W  24x7 =    87.6 kWh/yr = 48 CNY/yr
#  20W  24x7 =   175.2 kWh/yr = 96 CNY/yr
#  30W  24x7 =   262.8 kWh/yr = 145 CNY/yr
#  40W  24x7 =   350.4 kWh/yr = 193 CNY/yr
#  50W  24x7 =   438.0 kWh/yr = 241 CNY/yr
#  60W  24x7 =   525.6 kWh/yr = 289 CNY/yr
```

10 W 到 40 W 的差距是每年 ¥145——不致命，但每多一台机器它就会叠加。空闲功耗的关键属性是它是*结构性的*：它由你买的硬件和你忘了关掉的服务决定，而不是由你实际使用多少决定。一台空闲 40 W 的机器，无论你摸不摸它，都在持续缴这笔税。

## Homelab 里到底是什么在耗电

- **空闲时的 CPU 封装（package）。** 一个停下来的核心只占零点几瓦，但整个封装——核心、uncore，以及在这颗 CPU 上还包括 DRAM——永远到不了零。封装空闲功耗就是整台机器的地板。
- **内存。** 一两瓦，而且它从不休眠。这就是为什么 suspend-to-RAM（挂起）是正经选项而不是噱头。
- **机械盘。** 按 datasheet，一块 2.5 寸 5400 转盘运行时通常是一两瓦，standby 时只有其中一小部分——这是规格数字，不是我测的，请看你自己盘的规格表。一块盘无所谓，四块盘就是一笔预算。SSD 空闲更低，而且没有什么可以停转。
- **什么都没干的独显。** 这是笔记本的经典坑：我这台同时有 Intel 集显和一块 NVIDIA MX150（规格标称 25 W TDP），它们的运行时电源状态是：

```bash
$ lspci -nnk | grep -Ei 'vga|3d'
00:02.0 VGA compatible controller [0300]: Intel Corporation Kaby Lake-R GT2 [UHD Graphics 620] [8086:5917] (rev 07)
01:00.0 3D controller [0302]: NVIDIA Corporation GP108M [GeForce MX150] [10de:1d10] (rev a1)
$ # 每块 GPU 的 runtime PM 状态：
0000:00:02.0 class=0x030000 driver=i915   power_state=D3hot runtime=suspended control=auto
0000:01:00.0 class=0x030200 driver=nvidia power_state=D0    runtime=active    control=on
```

集显乖乖地睡在 D3hot 里。而 MX150 全功率供电、D0 状态、什么都不干，只因为闭源驱动让它保持 active。这就是「独显空转耗电」问题，在你读 sysfs 状态之前，它完全不可见。
- **电源。** 一颗老旧的 ATX 电源在低负载下通常只有 80-85% 的效率（80 PLUS 曲线，规格范畴），于是 60 W 的负载会安静地向电网要 70 W。一颗好的现代电源，或者原生 12 V 的 DC 供电，对 Homelab 来说是正经升级。
- **网络设备。** 一台网管交换机是 5-15 W；五台交换机就是 50 W，而你从来不会想起它。

## 我在这里是怎么测的——以及哪些测不了

我没有墙插功率计，所以下面的数字没有一个是*墙上的*瓦数：一只即插即用的功率计是唯一真实的总量，而且它能平息所有争论。这台机器有的是 RAPL——Intel 通过内核 powercap 接口导出的能量计数器。这里的 **package** 域包含 core、uncore 和 DRAM 子域；它对风扇、磁盘、屏幕和电源损耗一无所知。而且读它需要 root：

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

注意 `lscpu` 没说什么：TDP。Intel 的规格表把这颗 U 标成 15 W，但固件自己的功耗上限完全是另一回事：

```bash
$ sudo cat /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
44000000                      # µW → PL1 = 44 W sustained, from sysfs
$ for d in /sys/class/powercap/intel-rapl:0*; do echo "$d -> $(sudo cat $d/name)"; done
/sys/class/powercap/intel-rapl:0 -> package-0
/sys/class/powercap/intel-rapl:0:0 -> core
/sys/class/powercap/intel-rapl:0:1 -> uncore
/sys/class/powercap/intel-rapl:0:2 -> dram
```

这里有两个驱动共同导出这些计数器（走 MSR 的 `intel-rapl` 和一个 MMIO 变体），两个都读一遍是验证数字不是编造的好办法——它们在 5 秒窗口内的差距在 28 mJ 以内。不过，干这活的标准工具在这台机器上都没有：

```bash
$ which turbostat powertop cpupower rapl
turbostat not found
powertop not found
cpupower not found
rapl not found
```

所以下面的一切都是裸读 sysfs，而这有一个好处：原始计数器，中间没有任何工具。

## 空闲功耗 vs 满载功耗，实测

方法无聊得恰到好处：读计数器，睡一个已知时长，再读一次，相除。先在机器的正常桌面负载下取三个窗口，再上八个忙线程（openssl AES 能把八个超线程全占住）：

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
  <figcaption>i7-8550U 上实测的 RAPL 封装功耗，按子域拆分。最有教育意义的是那个极小的差值：负载本来就在 8-9，八个新忙线程主要是把已有的活挤掉了，而不是凭空增加。空闲功耗是结构性的；饱和机器上的忙碌是挤出效应。</figcaption>
</figure>

两个事实浮现出来。第一，构成：基线时 15 W 封装里有 1.7 W 是 DRAM——空闲成本里超过十分之一是内存，而它从不睡觉。第二，差值：八个忙线程只增加了大约半瓦。这不是在说算力免费；这是一台已经在跑浏览器、KDE、Docker，外加一个忙个不停的 `baloo_file` 索引器和 swap 抖动的机器上，挤出效应本来的样子。在一台真正空闲的 Homelab 上，同样的实验会给出大得多的跃升——这正是要测你自己的机器、而不是信我的机器的原因。

这些数字背后的空闲状态计数器同样真实。在这台机器 2.6 天的运行时间里，把所有 C6 及更深的状态加起来是 228,281 秒中的 186,804 秒——大约 82% 的时间在深睡：

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

机器搁在桌上时，C 状态干得不错。Homelab 的失效模式完全不同：一个每隔几秒唤醒一次 CPU 的服务，会把封装永久钉在深 C 状态之外。`powertop` 会把它显示成一张唤醒表；没有它，你就观察机器安静时 C10 的时间到底涨不涨。

## CPU 调频策略的意外

传统观点说 `powersave` 省电、`performance` 费电。我翻转了调频策略（带自动恢复），两边各测了空闲和负载窗口：

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

测不出差别——而且在 `powersave` 下频率反而略*高*。原因在 sysfs 里：这颗 CPU 跑的是 `intel_pstate`，启用硬件 P 状态控制（HWP），energy performance preference 是 `performance`，无论软件里哪个 governor 在管事，硬件都已经把频率钉在高位。在 HWP 时代的 Intel 上，真正有用的旋钮是 EPP，而不是 governor 的名字；我没有动 EPP，因为这是一台为响应速度调好的工作机。温度随负载的变化符合预期：忙时 81-83 °C，基线 78-79 °C——在一个封装里，抬升瓦数的同一份功也抬升了温度。

## 省电手段，按「每份努力换来多少瓦」排序

1. **关掉你不用的东西。** 把五个空转的容器并到一台机器上，让那台为一个每周两小时的活儿而 24 小时开机的实验 VM 退休，把轮询守护进程换成 systemd timer。每去掉一个服务，就是永久去掉它的空闲瓦数。
2. **修好停着的独显。** 运行时电源管理，或者 `bbswitch`，能停掉你不需要的 GPU。我这里的单行修法是 `echo auto > /sys/bus/pci/devices/0000:01:00.0/power/control`——我*没有*执行它：一块能算活的 GPU 对我来说比那几瓦更值。你的机器，你的取舍。
3. **挂起，而不是空转。** 这台机器有 `s2idle` 和 `deep` 可用：

```bash
$ cat /sys/power/state
freeze mem disk
$ cat /sys/power/mem_sleep
s2idle [deep]        # '[deep]' marks the default
```

一条 `rtcwake -m mem -s 3600` 定时器，能让 Homelab 睡到凌晨三点，跑完备份批次再睡回去。如果一台机器每天有十个小时没人用，挂起胜过一切微优化的总和。
4. **磁盘策略。** 对机械盘来说停转是真实的省电——`hdparm -B` 设激进的电源管理，`-S` 设待机计时器。我这块盘目前设在最激进的*不*停转档位上，我只读了、没改它：

```bash
$ sudo hdparm -C /dev/sda
/dev/sda:
 drive state is:  active/idle      # NOT spun down
$ grep -H . /sys/block/sd{a,b}/queue/rotational
/sys/block/sda/queue/rotational:1
/sys/block/sdb/queue/rotational:0
```

5. **高效供电。** 一颗好的 80 PLUS Gold/Platinum 电源，或者原生 12 V DC，能在低负载下把丢掉的百分点赢回来。按纸面算，60 W 负载按 85% 效率，墙上就是 71 W。
6. **常驻职责用低功耗板。** 对 DNS、metrics 或文件同步节点来说，一块个位数瓦数的 ARM 板在设计上就碾压一台退役办公 PC。我没有测过具体型号——看 datasheet，然后用上面同一套方法自己测。
7. **governor 和 EPP 排最后，不是排最先。** 如上所示，governor 的名字可能什么都改变不了；试 EPP，测量，然后才信。

## 诚实的取舍

有两个手段会咬人。**停转磁盘**增加延迟——standby 之后的第一次访问要付几秒的起转时间——而对一块每几分钟就被摸一下的磁盘做 load/unload 循环是磨损，不是省电。**深度电源状态**增加退出延迟，这是对延迟敏感的服务（VPN 端点、上报代理）能感觉到的，而过于激进的 EPP 会把调度器的延迟预算削薄。**定时睡眠**打破了「服务总在」这个假设：备份、监控和 DNS 必须容忍一台凌晨四点是关着的机器。每一项改动都要复测：为了省 5 W 而在面向用户的东西上多出一秒尾延迟，这是取舍，不是胜利。

## 清单：先测量，再压最大的功耗项

1. 给机器插上墙插功率计，跑一周，记下空闲地板。
2. 读 RAPL：在一个已知窗口内 `sudo cat /sys/class/powercap/intel-rapl:0/energy_uj` 两次；把封装空闲功耗和上面的表对照。
3. 审计停着的硬件：`lspci -nnk`，然后看每个设备的 `power/runtime_status`。停掉那些供电着却没用上的东西。
4. 找出根本不该跑的：`systemctl list-timers`、被遗忘的容器、那台实验 VM。
5. 最后才动 governor、EPP、磁盘停转和挂起定时器——并且每改一项就复测一次。

这就是全部的纪律。**Homelab 功耗**不是什么玄学；它是一个测量问题，末尾附一张小小的算术表。同一个问题的机群视角，我写在[监控一个小机群](/zh/posts/monitoring-a-small-fleet/)；至于虚拟化那一层本身会不会花你的电，见[Proxmox 与纯 Linux](/zh/posts/proxmox-vs-plain-linux/)。
