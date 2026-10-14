---
title: "没有 FPU 的定点数学：单片机上的 Q16.16 实战"
description: "很多单片机没有 FPU，一次 float 运算就是一次软浮点库调用。本文用真实 C 代码和真实输出讲清 Q16.16 定点数学：乘法溢出的真实失败、与 double 的真实误差、查找表正弦，以及诚实的计时对比与适用边界——包括什么时候不该用它。"
pubDate: 2027-02-15
lang: zh
translationKey: fixed-point-math-on-mcus
tags: [embedded, c]
featured: false
keywords:
  - 定点数学
  - Q16.16
  - 单片机数学
  - 无 FPU
  - 溢出
---

当一个芯片没有 FPU 时，定点数学就是你伸手要拿的东西。在 Cortex-M0+ 以及任何一块仍在走量的廉价 8 位、16 位单片机上，`float` 乘法不是一条指令——它是调用一个软件浮点库，而这一件事会重塑你的整个程序。我曾在一块小型电机控制板上撞上这个问题：那段"显然应该用 `double` 写 DAC 斜率"的代码看起来无懈可击，实测却慢了整整三倍，因为编译器把每一行算术都悄悄变成了函数调用。

这篇文章是那一课的实践版。下面所有内容都是用本机的 gcc 16.2.1（x86-64，Intel i7-8550U）真实编译并运行过的——真实的溢出失败、与 `double` 对比的真实误差、一张真实的查找表正弦，以及真实的计时。我会坦白定点数在哪些场合赢、哪些场合不赢，包括嵌入式营销很少提的那部分：**你笔记本上的数字，不是你目标板上的数字**。

## 为什么需要定点数学：没有 FPU

许多单片机没有硬件浮点单元。当编译器无法为 `a * b` 生成 FPU 指令时，它会生成一次 libgcc 调用——`float` 是 `__mulsf3` 一类例程，`double` 则更长。每次调用压栈几个字、跑一段软件循环再返回。一次 `double` 除法可能耗掉几百个周期，而整数除法只要几十个。

这不只是吞吐问题，是时序问题。在超级循环里，所有任务共享同一个循环周期（见[无 RTOS 的嵌入式 C](/zh/posts/embedded-c-without-an-rtos/)），一个重软浮点的任务会把整个循环周期拉长，而从 ISR 里调用一次软浮点例程，足以炸掉整套固件的延迟预算。在 ESP32 上故事相反——它确实有单精度 FPU，用 `float` 通常没问题，我在[ESP32 电源管理](/zh/posts/esp32-power-management/)里写了它的实际功耗行为；本文针对的是相反的情形：根本没有 FPU。

定点数用整数替换 `float`。同样的数，不同的编码：

```c
/* Q16.16：1 个符号位 + 15 个整数位 + 16 个小数位 */
typedef int32_t fix_t;         /* 范围：-32768 .. 32767.99998 */

static inline fix_t f2fix(float f)   { return (fix_t)lrintf(f * 65536.0f); }
static inline float  fix2f(fix_t a)  { return (float)a / 65536.0f; }
```

加减法就是普通的整数加减。这就是全部——也正是这种编码存在的原因。

<figure>
<svg viewBox="0 0 640 196" width="100%" role="img" aria-label="一个 Q16.16 数就是一个 32 位有符号整数：高 16 位存放含符号位的整数部分，低 16 位存放小数部分。示例 2.75 编码为 0x0002C000：整数字段 0x0002 等于 2，小数字段 0xC000 等于 0.75。负数 -1.5 以补码编码为 0xFFFE8000。">
  <defs>
    <marker id="qm-tick" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0 L8 4 L0 8 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12">
    <text x="2" y="14" fill="currentColor" opacity="0.65">bit 31</text>
    <text x="196" y="14" fill="currentColor" opacity="0.65">bit 16</text>
    <text x="312" y="14" fill="currentColor" opacity="0.65">bit 15</text>
    <text x="566" y="14" fill="currentColor" opacity="0.65">bit 0</text>

    <rect x="0" y="22" width="244" height="52" rx="6" fill="#0f766e" opacity="0.14" stroke="#0f766e" stroke-width="1.5"/>
    <text x="12" y="42" fill="#0f766e" font-weight="600">整数部分（符号 + 15 位）</text>
    <text x="12" y="62" fill="currentColor" opacity="0.75">value &gt;&gt; 16</text>

    <rect x="250" y="22" width="244" height="52" rx="6" fill="currentColor" opacity="0.07" stroke="currentColor" stroke-width="1.5"/>
    <text x="262" y="42" fill="currentColor" font-weight="600">小数部分（16 位）</text>
    <text x="262" y="62" fill="currentColor" opacity="0.75">value &amp; 0xFFFF</text>

    <line x1="503" y1="22" x2="503" y2="74" stroke="#0f766e" stroke-width="1.25" marker-end="url(#qm-tick)"/>
    <text x="510" y="44" fill="currentColor" opacity="0.75">结果 =</text>
    <text x="510" y="62" fill="currentColor" opacity="0.75">整部 + 小数/65536</text>

    <text x="0" y="104" fill="currentColor" opacity="0.75">2.75   -&gt;  int32_t 0x0002C000  -&gt;  0x0002 = 2   |   0xC000 = 0.75</text>
    <text x="0" y="130" fill="currentColor" opacity="0.75">-1.5   -&gt;  int32_t 0xFFFE8000  -&gt;  0xFFFE = -2  |   0x8000 = 0.5   （二进制补码）</text>
  </g>
</svg>
<figcaption>图. Q16.16 字：32 个有符号位，高半是整数部分，低半是小数部分。上面两个例子都是本文后面真实程序打印的输出。</figcaption>
</figure>

## 乘法需要更宽的中间量——经典溢出

`fix_mul` 只有一行，而这一行就是所有人栽跟头的地方：

```c
static inline fix_t fix_mul(fix_t a, fix_t b) {
    return (fix_t)(((int64_t)a * (int64_t)b) >> 16);
}
```

右移 16 位，因为两个 Q16.16 的乘积是一个 Q32.32 的值——64 位——我们要的是让整数部分回到 16 位小数位的上方。把中间量加宽到 `int64_t`，否则你就输了。我编译了一个程序，把偷懒的 32 位写法和正确写法并排放：

```c
int32_t a = 100 * 65536;      /* 0x06400000 = 100.0 */
int32_t b = 2 * 65536;        /* 0x00020000 =   2.0 */

int32_t wrong = (int32_t)((a * b) >> 16);              /* int32_t 中间量 */
int32_t right = (int32_t)((((int64_t)a) * b) >> 16);
```

真实输出：

```
1) Q16.16 * Q16.16: 100.0 * 2.0, expected 200.0
   naive  (a*b)>>16            : raw          0  ->    0.0000
   proper (int64_t)a*b >> 16   : raw   13107200  ->  200.0000
```

不是乱码——是*零*。而且这是确定性的：两个 Q16.16 值都是 2^16 的倍数，所以它们的乘积总是 2^32 的倍数，截断到 32 位时什么都不会剩下。这就是"定点乘法老是返回零"成为 stack-overflow 经典问题的真正原因。

当两个操作数携带不同的标度时，失败更难看。一个 Q16.16 信号乘以一个 Q0.8 增益，用 32 位中间量计算，会产出彻头彻尾的垃圾：

```
2) Q16.16 * Q0.8 gain: 100.0 * 78.125, expected 7812.5
   naive  (x*g)>>8             : raw   -8093696  -> -123.5000
   proper (int64_t)x*g >> 8    : raw  512000000  ->  7812.5000
```

负数 -123.5。建在这种结果上的滤波器会朝错误的方向饱和，让你的产品以看起来像传感器故障的方式罢工。除法是同一个坑——要么 `((int64_t)a << 16) / b`，要么错：

```
3) Q16.16 division: 300.0 / 4.0, expected 75.0
   naive  (n<<16)/d            : raw          0  ->    0.0000
   proper (int64_t)n<<16 / d   : raw    4915200  ->    75.0000
```

这三行偷懒代码全都是未定义行为，而编译器可以告诉你。用
`-fsanitize=undefined` 构建同一份文件，它逐条报告：

```
overflow.c:15:34: runtime error: signed integer overflow: 6553600 * 131072 cannot be represented in type 'int'
overflow.c:28:31: runtime error: signed integer overflow: 6553600 * 20000 cannot be represented in type 'int'
overflow.c:41:31: runtime error: left shift of 19660800 by 16 places cannot be represented in type 'int'
```

把你的定点代码放进 UBSan 跑一次。这是免费的，而且它能抓到你肉眼看不见的溢出。

## 精度与舍入：与 double 的真实误差

Q16.16 的分辨率是 2^-16 ≈ 1.526e-5，这就是加减法的全部误差预算。转换和乘法在此之上还有舍入。同一个程序打印出来的真实数字，与 `double` 对比：

```
== conversions ==
pi  : Q=0x0003243f  back=3.141586 (double 3.14159265, err 6.35e-06)
0.1 : Q=0x0000199a  back=0.1000061035 (double 0.1000000000, err 6.10e-06)

== operations ==
a=2.7500 (0x0002c000)  b=-1.5000 (0xfffe8000)
a+b = 1.2500000000  (exact 1.2500000000)
a-b = 4.2500000000  (exact 4.2500000000)
a*b = -4.1250000000  (exact -4.1250000000)
a/b = -1.8333282471  (exact -1.8333333333)
```

注意除法：`-1.8333282471` 对精确的 `-1.8333333333`。C 的整数除法向零截断，于是每次 Q16.16 除法都偏差最多半个 LSB，而且偏向一个方向。一次性除法无所谓；对每秒做几百万次除法、输出喂给一个慢积分器的控制器来说，一个一致的偏差是系统性误差——像一个只会朝一个方向漂的微调电位器。加减是精确的；乘法在半个 LSB 内；除法截断。

滤波展示了误差如何累积。EMA 滤波器 `y += 0.15*(x - y)`，Q16.16 与 `double` 并行运行：

```
== EMA filter, alpha = 0.15 (Q16.16 vs double) ==
  n     x        fixed        double     |err|
  0    1.00     0.149994     0.150000    6.11e-06
  1    5.00     0.877457     0.877500    4.34e-05
  3   25.00     5.034027     5.034244    2.17e-04
  4  100.00    19.278336    19.279108    7.72e-04
  7    0.00    14.006989    14.007282    2.93e-04
```

七步之后，定点版本离 double 版本差了 3e-4——几十个 LSB。这不是 bug，这是反馈回路里 16 位小数位的代价，也正是控制工程师按动力学范围去选 Q2.30 或 Q8.24、而不是默认 Q16.16 的原因。拿 `float` 对比也一样：它自己带 24 位尾数和同一类问题。真正的问题永远是：*你的*误差预算够不够用。

## 查找表：不用数学库的正弦

在软浮点单片机上 `sin()` 很残忍——一个几十个周期、还占一大块 flash 的例程。定点答案是查表。我用 [0, pi/2] 上的 1024 个表项（4100 字节——M0+ 上负担得起的 4 KB）构建了 Q16.16 正弦，配上象限折叠和线性插值：

```c
static int32_t q_interp(int32_t p, int32_t quarter, int interp) {  /* p in [0, pi/2] */
    if (p >= quarter) return table[TSIZE];
    int64_t num = (int64_t)p * TSIZE;
    int32_t i = (int32_t)(num / quarter);
    if (!interp) return table[i];
    int32_t w = (int32_t)(((num % quarter) << 16) / quarter);      /* Q16.16 权重 */
    int32_t a = table[i], b = table[i + 1];
    return (int32_t)((int64_t)a + (((int64_t)(b - a) * w) >> 16));
}
```

然后我在 [-2pi, 2pi] 上扫了 125,664 个点，对照 libm 的 `sin()`：

```
table: 1024 entries over [0, pi/2], 4100 bytes, step 0.001534 rad

scan 125664 points, x in [-2pi, 2pi] step 1e-4 rad, vs libm sin():
  interpolated : max abs err = 0.000036857 rad (= 2.42 LSB of Q16.16)  at x = 3.4105
  raw lookup   : max abs err = 0.001546298 rad (= 101.34 LSB)  at x = 3.1738

spot checks:
  sin(0.000000): fixed 0.000000   libm 0.000000   err 0.00e+00
  sin(3.141593): fixed 0.000015   libm 0.000006   err 8.91e-06
  sin(1.570796): fixed 1.000000   libm 1.000000   err 9.92e-12
```

两个半 LSB 的插值误差非常优秀，而且注意剩下的误差来自哪里：不是插值数学（理论上这里约 1e-7 rad），而是表自身 1 个 LSB 的量化。把表改成 Q20.12 能省一半 RAM，但误差翻两番——这就是每个应用都要调的大小与精度平衡。同时，不做插值的原始最近表项读取误差约 101 LSB——在示波器上肉眼可见地错。

## 计时：定点到底省了什么

我基准测试了一个控制循环负载——3 抽头 FIR 加一个带限幅的 EMA——Q16.16 与 `double` 各 5000 万次迭代，三次取最好，`clock_gettime(CLOCK_MONOTONIC)`：

```
workload: 3-tap FIR + EMA + clamp, 50000000 iterations, best of 3
  Q16.16 fixed-point :   0.415 s     8.30 ns/iter
  double             :   0.613 s    12.26 ns/iter
  ratio fixed/double : 0.68x
```

定点版本快 1.5 倍——在一块带完整 FPU 和 SSE 硬件的 x86 上。所以定点总是赢，对吧？不。我跑了第二个批处理负载——同样的 FIR，每个块作用在 1024 个独立样本上，这是编译器能够向量化的形态：

```
batch: 3-tap FIR over 1024 samples/block, best of 3
  Q16.16 fixed-point :   0.047 s     2.29 ns/sample
  double             :   0.028 s     1.35 ns/sample
  ratio fixed/double : 1.69x  (double is 1.7x faster)
```

这次 double 赢 1.7 倍，因为 SSE 每条指令处理两个 double，而我那段带 64 位中间量的定点代码拒绝被向量化。对这台机器的诚实总结：负载是串行依赖链时，延迟只有 1–3 个周期的整数指令赢；数据可以并行时，FPU 的吞吐赢。这两种没有一种是重点。重点是 Cortex-M0+ 这种完全没有 FPU 的芯片，每一次 `double` 运算都是一次 libgcc 函数调用，定点版本会赢一个数量级——这个数字我没法在这里展示，因为它取决于*你的*工具链、flash 等待状态和时钟频率。

## 什么时候不值得用定点数学

不要在以下场合把能跑的 `float` 代码改成定点：

- **带 FPU 的现代单片机。** Cortex-M4F 及以上、ESP32 的单精度单元——硬件一个周期干完，除了代码可读性之外你什么也固定不了。
- **任何桌面级的东西。** 手机、树莓派、服务器——double 快，而且 FPU 每周期干的活比你的定点代码多。
- **动态范围很宽的算法**——带 60 dB 以上余量的 FFT、矩阵求逆。Q16.16 只覆盖 -32768..32767.99998，而且它会静默溢出；`300.0 * 300.0` 已经需要 5.9e9 个单位，超过 int32 最大值，于是你的饱和代码——你写了饱和代码吧？——必须无处不在。

## 主机不是目标机

上面的一切都是用 gcc 16.2.1 在 Intel i7-8550U、x86-64 上编译的，而且我先做过校准（我的整数循环 0.64 ns/迭代，double 乘法链 3.85 ns/迭代，说明这台机器是健康的）。你那块 48 MHz、链接了软浮点的 Cortex-M0 是另一个宇宙：周期数、flash 延迟、甚至整数乘法是不是单周期指令，全都变了。可行的工作流是：先写 `float` 版本，在真实目标板上用 DWT 周期计数器或一根翻转的 GPIO 加示波器测它，然后再把热循环移植成定点——同时把 float 版本留在编译开关后面，方便在台架上对比。

定点数学不是更快的算术。它是当 FPU 不存在时依然能用的算术——精确、可预测、单周期，以及距离一个只有 UBSan 才会告诉你的溢出陷阱，只差一行。
