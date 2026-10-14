---
title: "ESP32 续航要从 BOM 设计起：电池版传感器节点的真实功耗与数据预算"
description: "一份诚实的传感器节点 BOM 拆解：板子、稳压器、传感器与射频各自要让你的 ESP32 续航付出多少；再用一个 Python 模型算出真实的平均电流、电池天数与每月数据量，每个假设都明确标注。"
pubDate: 2027-02-18
lang: zh
translationKey: esp32-sensor-node-bom
tags: [esp32, embedded]
featured: false
keywords:
  - ESP32 续航
  - 传感器节点 BOM
  - 深度睡眠电流
  - 功耗预算
  - 锂电 vs 18650
---

我的工作台上现在没有 ESP32，所以这不是一篇「我接了一个 Joulescope，给你看
波形」的文章。我做了我劝别人先做的事：把假设写下来，变成一个小模型，然后让
算术保持真实。下面每一个电流值都是标注过的假设——一个你可以质疑的数据手册
典型值——但表格里每一个平均值、每一个天数、每一个兆字节，都是我真实跑出来
的脚本输出。脚本很短，就贴在文里，你可以改掉我的假设，看着预算随之移动。

道理很简单：你的 **ESP32 续航**不是由芯片决定的，而是由**传感器节点 BOM**
决定的——由那个没人去读数据手册的稳压器决定，由射频睡着时还在默默耗电的
USB 转串口桥决定，由你选的射频决定。以下就是我在为一个周期性上报的电池节点
买任何一个零件之前，推演它**功耗预算**的方法。

## 这个节点到底要做什么：感知、传输、睡眠

工作内容很无聊：醒来、读传感器、把读数发出去、接着睡。三个阶段，它们的
代价相差几个数量级：醒着几十毫安跑几毫秒，睡着几十微安跑几百秒。因为醒着的
窗口很短，平均电流基本只由两件事决定：整块板子在深度睡眠期间漏掉多少，以及
醒来的窗口本身花掉多少。**深度睡眠电流**可以在 BOM 里根治；醒来的窗口只能
靠缩短。

<figure>
  <svg viewBox="0 0 720 200" role="img" aria-label="一个十分钟周期内的电流曲线：大部分是平缓的深度睡眠底线、一个小小的传感器读数凸起，以及一次高高的 Wi-Fi 发射突发；平均电流线只比睡眠底线高一点" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto">
    <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="currentColor">
      <text x="24" y="20" font-size="13">模型中的十分钟周期，3 秒唤醒窗口</text>
      <rect x="385" y="95" width="40" height="55" fill="#0f766e" fill-opacity="0.3"/>
      <polygon points="520,150 520,25 555,25 555,150" fill="#0f766e" fill-opacity="0.18"/>
      <path d="M24,150 L375,150 L385,95 L425,95 L435,150 L520,150 L520,25 L555,25 L555,150 L700,150" fill="none" stroke="#0f766e" stroke-width="2"/>
      <line x1="24" y1="138" x2="700" y2="138" stroke="#0f766e" stroke-width="1" stroke-dasharray="6 4" opacity="0.8"/>
      <text x="300" y="132" font-size="11" opacity="0.85">平均 0.45 mA &#8594; 2000 mAh 下约 185 天</text>
      <text x="385" y="86" font-size="11" text-anchor="middle">读数</text>
      <text x="470" y="18" font-size="11">Wi-Fi 关联 + 发射突发</text>
      <text x="24" y="172" font-size="11" opacity="0.7">深度睡眠约 50 &#181;A（假设的板级底线）</text>
      <text x="470" y="172" font-size="11" opacity="0.7">600 秒里醒 3 秒 = 0.5% 占空比</text>
    </g>
  </svg>
  <figcaption>纵轴故意不成比例：睡眠底线与发射突发相差三个数量级，线性画出来只是一条平线，什么都教不了你。重点在于，当占空比小而诚实的时候，那条平均线长什么样。</figcaption>
</figure>

如果你想看逐个模式的细节——modem sleep、DTIM、重连的代价——我单独写在
[ESP32-C3 上的 ESP32 电源管理](/zh/posts/esp32-power-management/)一文里。
本文讲的是芯片*周围*的零件，以及决定它们加起来是几个月还是半个月的算术。

## BOM 就是预算

### 板子：ESP32 vs ESP32-C3 vs 裸模块

同样叫「ESP32 板子」的东西卖的其实是两种货，只有一种能安全地接上电池。
经典开发板带着 USB 转串口桥、电源 LED 和一个从不关心主芯片睡没睡的 LDO：
固件进了深度睡眠，它自己还会稳定耗掉几毫安——单这一项就把你的续航钉死在
低量级的天数上，数据手册说什么都没用。ESP32-C3 一类的新板子把这个差距缩小了
（裸片更小、单核、要保活的东西更少），但周围的外设是同一个问题。裸模块意味着
稳压器、电源开关和上拉电阻都归你管——而这正是**传感器节点 BOM**定胜负的
地方。它花掉的是你的焊接时间，换来的是几个月和几天的差别。

### 电源：锂电 vs 18650，以及卡在中间的稳压器陷阱

诚实的**锂电 vs 18650**结论：2000 mAh 级别的锂聚合物电池体积能量密度最好，
需要充电与保护电路；3.0–3.5 Ah 的 18650 可更换、低温表现更好；两节 AA 碱性
电池最便宜，在睡眠节点这种低电流下也能愉快地供出两三个安时，前提是你接受
它的体积。这些都随卖家和地区波动，所以我一个价格都不报——把它们当大宗配件，
哪个到货快买哪个。

比射频更能杀死电池设计的，是坐在电芯和一切负载之间的那个器件：稳压器。
半数老一代开发板用的 AMS1117 级 LDO，数据手册里的静态电流就是几毫安。静态
电流 24 小时不间断，包括节点睡着的那 99% 的时间，所以它会原样变成下面表格
里的第二组数字。现代低静态电流的 LDO 能把这一项压到微安级；整个 BOM 里就数
这个修复最便宜。

### 传感器：每种接口都有待机电流

- **I²C** 器件是最省心的情况：像样的温湿度气压传感器在两次转换之间只待机
  几十微安，没人说话时总线本身几乎不耗电。
- **模拟** 是设计漏电的地方。分压电阻就是一根永远不睡觉的到地电阻；一个
  3.3 V 供电的 100 kΩ 量级检测腿，会持续漏掉几十微安。换更大的阻值、给
   rail 加开关，或者干脆换数字器件，都比贴一块电池便宜。
- **单总线**居中：待机很低，但总线上拉和转换时间都要算进你的预算。

无论选哪种，用一颗 GPIO 给传感器的电源 rail 加个开关，待机问题就基本消失了：

```c
#include "driver/gpio.h"
#include "esp_sleep.h"

#define SENSOR_RAIL GPIO_NUM_8   /* rail you switched on the board */

RTC_DATA_ATTR static int s_wakes;  /* survives deep sleep */

void app_main(void)
{
    ++s_wakes;

    /* Pay for the sensor only for the milliseconds you use it. */
    gpio_set_direction(SENSOR_RAIL, GPIO_MODE_OUTPUT);
    gpio_set_level(SENSOR_RAIL, 1);
    vTaskDelay(pdMS_TO_TICKS(2));     /* let the rail settle */

    /* ... read the sensor, associate, publish, disconnect ... */
    gpio_set_level(SENSOR_RAIL, 0);

    esp_sleep_enable_timer_wakeup(600ULL * 1000000ULL);  /* 10 minutes */
    esp_deep_sleep_start();  /* does not return */
}
```

### 射频：Wi-Fi vs BLE vs LoRa 其实是一个「每字节能量」问题

「**LoRa vs WiFi**」通常被当成距离问题来问，而第一个该问的轴不是距离。在
电池上真正要问的轴是每送达一字节的能量。LoRa 用网关和严格的占空比限制，换来
惊人的距离和穿透；Wi-Fi 只要有个接入点就能用，代价是每次都要重新关联；BLE
居中，是贴近手机的节点的甜点位。模型给出的结论如下，所有假设都写在脚本里：

```python
#!/usr/bin/env python3
"""Average-current model for a duty-cycled ESP32 sensor node.

All current values are DATESHEET-TYPICAL / MEASURED-BALLPARK ASSUMPTIONS,
stated as constants below so they can be argued with. The arithmetic is the
point: average current (not peak, not sleep) is what sets battery life.
"""

MAH = 2000.0          # LiPo cell capacity [assumption: a common 2000 mAh pack]
SLEEP_UA = 50.0       # whole-board deep-sleep draw, bare module + good LDO [assumption]
WAKE_MA = 80.0        # average during the wake window: CPU + Wi-Fi + TX bursts [assumption]
SENSOR_MA = 2.0        # sensor active while being read [assumption]
SENSOR_S = 0.1         # sensor read takes 100 ms [assumption]

def avg_current_ma(cycle_s, wake_s):
    """Charge-weighted average current over one full cycle, in mA."""
    awake_charge = WAKE_MA * wake_s                    # mA*s
    sleep_charge = (SLEEP_UA / 1000.0) * (cycle_s - wake_s)
    return (awake_charge + sleep_charge) / cycle_s

def life_days(cycle_s, wake_s, capacity_mah=MAH):
    i = avg_current_ma(cycle_s, wake_s)
    hours = capacity_mah / i
    return i, hours / 24.0

print(f"Assumptions: battery {MAH:.0f} mAh, board deep-sleep {SLEEP_UA:.0f} uA, "
      f"wake-window average {WAKE_MA:.0f} mA")
print(f"{'cycle':>8} {'wake':>6} {'avg I (mA)':>11} {'life (days)':>12} {'life':>14}")
for cycle_s, wake_s, label in [
    (60, 3.0, "1 min"),
    (300, 3.0, "5 min"),
    (600, 3.0, "10 min"),
    (3600, 3.0, "1 hour"),
    (86400, 3.0, "1 day"),
]:
    i, d = life_days(cycle_s, wake_s)
    print(f"{label:>8} {wake_s:>4.1f}s {i:>11.3f} {d:>12.1f} {d/365:>13.2f} yr")

print()
print("Same battery, same firmware, but the wake window doubles (DHCP + slow AP):")
for cycle_s, label in [(300, "5 min"), (600, "10 min")]:
    i, d = life_days(cycle_s, 6.0)
    print(f"  {label:>6} cycle, 6.0s wake -> {i:.3f} mA avg, {d:.1f} days")

print()
print("The regulator trap (5 mA quiescent LDO, e.g. an old AMS1117-class part,")
print("feeding the same duty-cycled node):")
BAD_MA = 5.0
for cycle_s, wake_s, label in [(600, 3.0, "10 min"), (3600, 3.0, "1 hour")]:
    q_bad = (WAKE_MA * wake_s + BAD_MA * cycle_s) / cycle_s
    print(f"  {label:>7} cycle: {q_bad:.3f} mA avg, {MAH / q_bad / 24:.1f} days "
          f"(vs {avg_current_ma(cycle_s, wake_s):.3f} mA / {life_days(cycle_s, wake_s)[1]:.1f} days)")

print()
print("Energy per reported byte, two radios [assumptions: TX currents from")
print("datasheet-typical values; times-on-air are order-of-magnitude]:")
wifi = WAKE_MA * 3.0 / (102 * 8)      # 80 mA for the whole 3 s window / (80 B payload + 22 B headers)
lora = 120.0 * 0.10 / (51 * 8)        # 120 mA for ~100 ms on air at SF7 / 51-byte frame
ble  = 15.0 * 0.02 / (31 * 8)         # 15 mA for ~20 ms per advertisement / 31 bytes
print(f"  Wi-Fi publish : {wifi*1e6:8.1f} uJ/bit  ({WAKE_MA:.0f} mA x 3.0 s / 102 B)")
print(f"  LoRa SF7 frame: {lora*1e6:8.1f} uJ/bit  (120 mA x 0.10 s / 51 B)")
print(f"  BLE advert    : {ble*1e6:8.1f} uJ/bit  (15 mA x 0.02 s / 31 B)")
```

以及它真实打印出来的结果：

```console
$ python3 power_budget.py
Assumptions: battery 2000 mAh, board deep-sleep 50 uA, wake-window average 80 mA
   cycle   wake  avg I (mA)  life (days)           life
   1 min  3.0s       4.048         20.6          0.06 yr
   5 min  3.0s       0.850         98.1          0.27 yr
  10 min  3.0s       0.450        185.3          0.51 yr
  1 hour  3.0s       0.117        714.5          1.96 yr
   1 day  3.0s       0.053       1579.0          4.33 yr

Same battery, same firmware, but the wake window doubles (DHCP + slow AP):
   5 min cycle, 6.0s wake -> 1.649 mA avg, 50.5 days
  10 min cycle, 6.0s wake -> 0.850 mA avg, 98.1 days

The regulator trap (5 mA quiescent LDO, e.g. an old AMS1117-class part,
feeding the same duty-cycled node):
   10 min cycle: 5.400 mA avg, 15.4 days (vs 0.450 mA / 185.3 days)
   1 hour cycle: 5.067 mA avg, 16.4 days (vs 0.117 mA / 714.5 days)

Energy per reported byte, two radios [assumptions: TX currents from
datasheet-typical values; times-on-air are order-of-magnitude]:
  Wi-Fi publish : 294117.6 uJ/bit  (80 mA x 3.0 s / 102 B)
  LoRa SF7 frame:  29411.8 uJ/bit  (120 mA x 0.10 s / 51 B)
  BLE advert    :   1209.7 uJ/bit  (15 mA x 0.02 s / 31 B)
```

按顺序读这些行，因为它们讲的是同一个故事：

- **上报间隔是整个设计里最大的杠杆。**一分钟一次是 20.6 天；十分钟一次是 185 天；
  一小时一次在同一颗 2000 mAh 电芯上接近两年。同样的 BOM，同样的固件。
- **周期一短，唤醒窗口就压倒一切。**在一分钟周期里，醒着的 3 秒每个周期贡献
  240 mA·s 的电荷，而睡眠只贡献约 3 mA·s——睡眠电流小到看不见，唤醒就是预算。
- **唤醒窗口翻倍，寿命腰斩。**3 秒变 6 秒——忙乱的接入点上一次 DHCP 加一次
  不顺利的关联就是这个代价——五分钟周期的设计就从 98 天掉到 50 天。
- **稳压器决定天花板。**5 毫安静态电流把节点按在 15–16 天，跟占空比无关。
  这张表里其他所有行加起来都没这个错误大。
- **每字节能量：**模型里三种射频的差距接近两个数量级——Wi-Fi 发布对比 LoRa
  帧——BLE 广播居中。这不等于 LoRa 一定对（它需要网关），但它解释了为什么
  「直接套用那套 Wi-Fi 协议栈」是最贵的默认值。

## 数据预算：每月字节数也是 BOM 的一部分

功耗是预算的一半，另一半是你发了什么。消息越肥，占用的空口越多，而空口
就是电流。所以载荷编码是一个功耗决策。下面是一次真实的消息大小计算，把同一
条读数打成两种格式：

```python
#!/usr/bin/env python3
"""Real byte counts: JSON payload vs a packed binary struct."""
import json, struct

reading = {
    "node": "shf-01",
    "seq": 4_000_000,      # monotonic counter, wraps cleanly at 2^32
    "t": 21.5625,          # degC
    "h": 48.1875,          # %RH
    "batt_mv": 3940,       # millivolts
    "flags": 0b0000_0101,  # bit0: door open, bit2: low battery
}

json_payload = json.dumps(reading, separators=(",", ":")).encode()
print("JSON payload:")
print(" ", json_payload.decode())
print(f"  bytes: {len(json_payload)}")

# Packed: 3B node tag + uint32 seq + int16 t_centi + uint16 h_centi
#         + uint16 batt_mv + uint8 flags = 14 bytes
packed = struct.pack("<3sIhhHB",
                     b"shf",                       # 3 B compact node tag
                     reading["seq"],               # 4 B sequence
                     int(round(reading["t"] * 100)),  # 2 B, centi-degC, signed
                     int(round(reading["h"] * 100)),  # 2 B, centi-%RH
                     reading["batt_mv"],           # 2 B
                     reading["flags"])             # 1 B
print(f"\nPacked struct '<3sIhhHB': {len(packed)} bytes")
print("  hex:", packed.hex())

# Round-trip proof the packing is lossless for this schema
tag, seq, t_c, h_c, mv, fl = struct.unpack("<3sIhhHB", packed)
assert tag == b"shf" and seq == reading["seq"]
assert abs(t_c / 100 - reading["t"]) <= 0.005   # half of one 0.01 C LSB
assert abs(h_c / 100 - reading["h"]) <= 0.005   # half of one 0.01 %RH LSB
assert mv == reading["batt_mv"] and fl == reading["flags"]
print(f"  round-trips: t={t_c/100} C, h={h_c/100} %, mv={mv}, flags={fl:08b}  OK")
print(f"\nsaving: {len(json_payload)} B -> {len(packed)} B = "
      f"{100*(1-len(packed)/len(json_payload)):.0f}% smaller")
print("resolution actually kept: 0.01 C / 0.01 %RH, seq rollover at 2^32")
```

```console
$ python3 msg_size.py
JSON payload:
  {"node":"shf-01","seq":4000000,"t":21.5625,"h":48.1875,"batt_mv":3940,"flags":5}
  bytes: 80

Packed struct '<3sIhhHB': 14 bytes
  hex: 73686600093d006c08d312640f05
  round-trips: t=21.56 C, h=48.19 %, mv=3940, flags=00000101  OK

saving: 80 B -> 14 B = 82% smaller
resolution actually kept: 0.01 C / 0.01 %RH, seq rollover at 2^32
```

80 字节的 JSON，压缩后 14 字节——而且 0.01 °C 的分辨率保留了下来，比这些
传感器本身的精度还高。现在把它乘以一个月，对照经纪商套餐的现实。免费与
爱好者级别的云 MQTT 服务，通常每月给你几百 MB 到几个 GB 的出口流量——
把它当成一个需要向你的服务商核实的区间，而不是承诺：

```python
#!/usr/bin/env python3
"""Data budget for a duty-cycled sensor node: bytes/month vs broker quotas.

Message payloads come from msg_size.py's real byte counts; MQTT framing and
keepalive overhead are added here. Quote numbers are honest bands, not a
vendor promise - check your own broker plan.
"""
KB, MB, GB = 1e3, 1e6, 1e9

JSON_LEN = 80   # bytes, from msg_size.py
PACKED_LEN = 14  # bytes, from msg_size.py
MQTT_OVERHEAD = 22   # PUBLISH header + topic + fixed header + IP/TCP, order-of-magnitude
KEEPALIVE_S = 60     # [assumption] broker keepalive we choose
PINGREQ_BYTES = 2 + 20  # MQTT PINGREQ packet ~ TCP/IP overhead per ping

def monthly_bytes(payload_len, cycle_s, n_nodes=1):
    msgs_day = 86400 / cycle_s
    payload_month = msgs_day * 30 * (payload_len + MQTT_OVERHEAD) * n_nodes
    pings_month = (86400 / KEEPALIVE_S) * 30 * PINGREQ_BYTES * n_nodes
    return payload_month, pings_month

print(f"per-message payload: JSON {JSON_LEN} B, packed {PACKED_LEN} B")
print(f"assumptions: +{MQTT_OVERHEAD} B MQTT/TCP/IP overhead, keepalive {KEEPALIVE_S}s")
print()
print(f"{'report every':>12} {'nodes':>5} {'JSON /month':>14} {'packed /month':>15} {'ratio':>7}")
for cycle_s, label in [(60, "1 min"), (600, "10 min"), (3600, "1 hour")]:
    for n in (1, 25):
        j, jp = monthly_bytes(JSON_LEN, cycle_s, n)
        p, pp = monthly_bytes(PACKED_LEN, cycle_s, n)
        print(f"{label:>12} {n:>5} {j/MB:>11.2f} MB {p/MB:>12.2f} MB {j/p:>6.1f}x")

print()
print("Sense of scale against typical free-tier broker allowances (hundreds of MB")
print("to a few GB/month of egress - verify against your provider, not me):")
j, jp = monthly_bytes(JSON_LEN, 60, 25)
p, pp = monthly_bytes(PACKED_LEN, 60, 25)
for quota_gb in (1, 10):
    print(f"  {quota_gb} GB/month quota: JSON 1-min x25 = {j/GB:.3f} GB "
          f"({100*j/(quota_gb*GB):.2f}% of quota); packed = {p/GB:.3f} GB ({100*p/(quota_gb*GB):.2f}%)")
print(f"  keepalive ping traffic at 25 nodes, 60 s keepalive: "
      f"{(jp)/MB:.2f} MB/month ({100*jp/j:.1f}% of payload traffic)")
```

```console
$ python3 data_budget.py
per-message payload: JSON 80 B, packed 14 B
assumptions: +22 B MQTT/TCP/IP overhead, keepalive 60s

report every nodes    JSON /month   packed /month   ratio
       1 min     1        4.41 MB         1.56 MB    2.8x
       1 min    25      110.16 MB        38.88 MB    2.8x
      10 min     1        0.44 MB         0.16 MB    2.8x
      10 min    25       11.02 MB         3.89 MB    2.8x
      1 hour     1        0.07 MB         0.03 MB    2.8x
      1 hour    25        1.84 MB         0.65 MB    2.8x

Sense of scale against typical free-tier broker allowances (hundreds of MB
to a few GB/month of egress - verify against your provider, not me):
  1 GB/month quota: JSON 1-min x25 = 0.110 GB (11.02% of quota); packed = 0.039 GB (3.89%)
  10 GB/month quota: JSON 1-min x25 = 0.110 GB (1.10% of quota); packed = 0.039 GB (0.39%)
  keepalive ping traffic at 25 nodes, 60 s keepalive: 23.76 MB/month (21.6% of payload traffic)
```

从这张表能得出三个诚实的结论。第一，编码带来 2.8× 的收益，但*间隔*仍然主导
总量：一个十分钟上报一次的节点在任何套餐上都是零头；二十五个一分钟一次的
节点用 JSON 就是每月 110 MB，如果能接受十分钟一次，这个数字是 11 MB。第二，keepalive 流量不是免费的——60 秒的
keepalive 就能占到载荷流量的五分之一以上，所以选你的经纪商能容忍的最长
间隔。第三，如果每条消息都带一次 TLS 握手，握手占用的空口比编码省下来的
多得多——围绕这个的协议栈预算，正是我在[在单片机跑 MQTT](/zh/posts/mqtt-on-a-microcontroller/)
一文里算过的。压缩和太阳能一样，是人们最先伸手去抓的二阶修复。

## 陷阱合集

1. **开发板自己的底线。**你原型用的板子「睡着」时也要耗几毫安，因为它的
   USB 桥和 LDO。你的量产设计不会——但前提是你换掉了这个部分。
2. **静态电流单位用错了的稳压器。**mA 而不是 µA，悄悄拿掉一个数量级的续航，
   永远拿掉。
3. **短周期里唤醒时间主导一切。**低于某个上报间隔，预算就是关联时间；缩短
   连接胜过任何其他固件优化。
4. **关联是一笔固定税。**静态 IP、缓存 BSSID 与信道、AP 摆位，值的天数比
   任何库都多。
5. **永远不睡的分压电阻**，和从未关掉的传感器电源。
6. **数据侧的帧开销**：keepalive、保留状态和逐条 TLS，都在消耗载荷预算
  本该省下的同一批字节。

## 我会先做什么

先测睡眠电流，在其他任何事之前——在电池干路上并一颗 INA219 级别的测流
模块，哪怕只用一块便宜的在线表，测满一个完整周期。就这一个数字，能告诉你
你的板子选择到底可行不可行。然后定上报间隔，因为它比任何元件都值。再选稳压器，
然后才是编码。并把那个诚实的结论放在眼里：预算合不上时，更小的射频和更低的
睡眠电流通常打得过更大的电池。一块 2000 mAh 的电芯是一块固定的电荷 slab；
它周围的 BOM 决定你是三周花光它，还是三年花光它。
