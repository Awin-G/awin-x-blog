---
title: "Fixed-Point Math Without an FPU: Q16.16 on Microcontrollers"
description: "Fixed-point math on microcontrollers: why Q16.16 beats float when a chip has no FPU. Real C code, real overflow failures, a lookup-table sine, and honest timing numbers."
pubDate: 2027-02-15
lang: en
translationKey: fixed-point-math-on-mcus
tags: [embedded, c]
featured: false
keywords:
  - fixed-point math
  - Q16.16
  - microcontroller math
  - no FPU
  - overflow
---

Fixed-point math is what you reach for when the chip in front of you has no
FPU. On a Cortex-M0+ or any of the cheap 8-bit and 16-bit parts still
outselling the fancy stuff, a `float` multiply is not an instruction — it is a
call into a software floating-point library, and that single fact reshapes
your whole program. I hit this on a small motor-control board where the
"obvious" C using `double` for the DAC ramp looked perfect and ran three
times too slow, because the compiler quietly turned every arithmetic line
into a function call.

This article is the practical version of that lesson. Everything below is
real C, compiled and run on this host with gcc 16.2.1 on an x86-64
Intel i7-8550U — real overflow failures, real errors against `double`, a real
lookup-table sine, and real timings. I will be honest about where
fixed-point wins and where it does not, including the part embedded marketing
rarely mentions: **the numbers from your laptop are not the numbers from your
target**.

## Why fixed-point math exists: no FPU

Many microcontrollers have no hardware floating-point unit. When the compiler
cannot emit an FPU instruction for `a * b`, it emits a call to a libgcc
routine — `__mulsf3` and friends for `float`, longer ones for `double`. Each
call pushes a few words to the stack, runs a software loop, and returns. One
`double` divide can cost hundreds of cycles where an integer divide costs
tens.

That is a timing problem, not just a throughput problem. In a superloop
where every task shares one loop period (see
[Embedded C Without an RTOS](/posts/embedded-c-without-an-rtos/)), one
soft-float-heavy task stretches the loop for everything else, and a soft-float
routine invoked from an ISR can blow the latency budget of the whole
firmware. On the ESP32, which *does* have a single-precision FPU, the story
flips and `float` is usually fine — I wrote about the ESP32's actual power
behaviour in [ESP32 Power Management](/posts/esp32-power-management/), and
this article is aimed at the opposite case: no FPU at all.

Fixed-point replaces `float` with integers. Same numbers, different encoding:

```c
/* Q16.16: 1 sign bit + 15 integer bits + 16 fraction bits */
typedef int32_t fix_t;         /* range: -32768 .. 32767.99998 */

static inline fix_t f2fix(float f)   { return (fix_t)lrintf(f * 65536.0f); }
static inline float  fix2f(fix_t a)  { return (float)a / 65536.0f; }
```

Add and subtract are plain integer add and subtract. That is the whole
story — and it is why the encoding exists.

<figure>
<svg viewBox="0 0 640 196" width="100%" role="img" aria-label="A Q16.16 value is one 32-bit integer: the high 16 bits hold the integer part including the sign bit, the low 16 bits hold the fraction. The example 2.75 encodes as 0x0002C000: the integer field 0x0002 equals 2 and the fraction field 0xC000 equals 0.75. Minus 1.5 encodes as 0xFFFE8000 in two's complement.">
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
    <text x="12" y="42" fill="#0f766e" font-weight="600">integer part (sign + 15 bits)</text>
    <text x="12" y="62" fill="currentColor" opacity="0.75">value &gt;&gt; 16</text>

    <rect x="250" y="22" width="244" height="52" rx="6" fill="currentColor" opacity="0.07" stroke="currentColor" stroke-width="1.5"/>
    <text x="262" y="42" fill="currentColor" font-weight="600">fraction (16 bits)</text>
    <text x="262" y="62" fill="currentColor" opacity="0.75">value &amp; 0xFFFF</text>

    <line x1="503" y1="22" x2="503" y2="74" stroke="#0f766e" stroke-width="1.25" marker-end="url(#qm-tick)"/>
    <text x="510" y="44" fill="currentColor" opacity="0.75">result =</text>
    <text x="510" y="62" fill="currentColor" opacity="0.75">int + frac/65536</text>

    <text x="0" y="104" fill="currentColor" opacity="0.75">2.75   -&gt;  int32_t 0x0002C000  -&gt;  0x0002 = 2   |   0xC000 = 0.75</text>
    <text x="0" y="130" fill="currentColor" opacity="0.75">-1.5   -&gt;  int32_t 0xFFFE8000  -&gt;  0xFFFE = -2  |   0x8000 = 0.5   (two's complement)</text>
  </g>
</svg>
<figcaption>FIG. The Q16.16 word: 32 signed bits, the high half carries the integer part, the low half the fraction. Both examples above are the real program output printed later in this article.</figcaption>
</figure>

## Multiplication needs a wider intermediate — the classic overflow

`fix_mul` is one line, and that line is where everyone gets bitten:

```c
static inline fix_t fix_mul(fix_t a, fix_t b) {
    return (fix_t)(((int64_t)a * (int64_t)b) >> 16);
}
```

Shift by 16 because the product of two Q16.16 values is a Q32.32 number —
64 bits — and we want the 16 integer bits back above the 16 fraction bits.
Widen the intermediate to `int64_t` or you lose. I compiled a program that
does the naive 32-bit version next to the correct one:

```c
int32_t a = 100 * 65536;      /* 0x06400000 = 100.0 */
int32_t b = 2 * 65536;        /* 0x00020000 =   2.0 */

int32_t wrong = (int32_t)((a * b) >> 16);              /* int32_t intermediate */
int32_t right = (int32_t)((((int64_t)a) * b) >> 16);
```

Real output:

```
1) Q16.16 * Q16.16: 100.0 * 2.0, expected 200.0
   naive  (a*b)>>16            : raw          0  ->    0.0000
   proper (int64_t)a*b >> 16   : raw   13107200  ->  200.0000
```

Not garbage — *zero*. And that is deterministic: two Q16.16 values are both
multiples of 2^16, so their product is always a multiple of 2^32, and
truncating to 32 bits always drops everything. This is the real reason
"fixed-point multiply returns zero" is a stack-overflow classic.

The failure is worse when the two operands carry different scales. A Q16.16
signal times a Q0.8 gain, computed with a 32-bit intermediate, produces
outright garbage:

```
2) Q16.16 * Q0.8 gain: 100.0 * 78.125, expected 7812.5
   naive  (x*g)>>8             : raw   -8093696  -> -123.5000
   proper (int64_t)x*g >> 8    : raw  512000000  ->  7812.5000
```

Minus 123.5. A filter built on that saturates in the wrong direction and
crashes your stint in ways that look like a sensor fault. Same trap in
division — `((int64_t)a << 16) / b`, not `((a << 16) / b)`:

```
3) Q16.16 division: 300.0 / 4.0, expected 75.0
   naive  (n<<16)/d            : raw          0  ->    0.0000
   proper (int64_t)n<<16 / d   : raw    4915200  ->    75.0000
```

All three of those naive lines are undefined behaviour, and the compiler can
tell you. Building the same file with `-fsanitize=undefined` reports each one
verbatim:

```
overflow.c:15:34: runtime error: signed integer overflow: 6553600 * 131072 cannot be represented in type 'int'
overflow.c:28:31: runtime error: signed integer overflow: 6553600 * 20000 cannot be represented in type 'int'
overflow.c:41:31: runtime error: left shift of 19660800 by 16 places cannot be represented in type 'int'
```

Run your fixed-point code under UBSan once. It is free and it finds the
overflow you cannot see.

## Precision and rounding: the real error against double

Q16.16 has a resolution of 2^-16 ≈ 1.526e-5 and that is the whole error
budget for addition and subtraction. Conversion and multiplication round on
top of it. Real numbers, same program, printed against `double`:

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

Note the divide: `-1.8333282471` versus the exact `-1.8333333333`. Integer
division truncates toward zero, so every Q16.16 division is off by up to
half an LSB, biased in one direction. For a one-off that is nothing. For a
controller that divides millions of times a second into a slow integrator, a
consistent bias is a systematic error — a trim pot that only ever drifts one
way. Add and subtract are exact; multiply is within half an LSB; divide
truncates.

Filtered data shows how this accumulates. An EMA filter `y += 0.15*(x - y)`
run in Q16.16 next to the same filter in `double`:

```
== EMA filter, alpha = 0.15 (Q16.16 vs double) ==
  n     x        fixed        double     |err|
  0    1.00     0.149994     0.150000    6.11e-06
  1    5.00     0.877457     0.877500    4.34e-05
  3   25.00     5.034027     5.034244    2.17e-04
  4  100.00    19.278336    19.279108    7.72e-04
  7    0.00    14.006989    14.007282    2.93e-04
```

Seven steps in, the fixed version is 3e-4 away from the double version —
tens of LSBs. That is not a bug, it is the price of 16 fraction bits in a
feedback loop, and it is why control engineers reach for Q2.30 or Q8.24
depending on dynamics instead of defaulting to Q16.16. Compare against
`float`, which itself carries 24 bits of mantissa and the same class of
issue; the question is always whether *your* error budget survives.

## Lookup tables: sine without a math library

`sin()` on a soft-float MCU is brutal — a software routine with dozens of
cycles and a large flash footprint. The fixed-point answer is a table. I
built a Q16.16 sine from 1024 entries over [0, pi/2] (4100 bytes — the
4 KB you can afford on an M0+) plus quadrant folding, with linear
interpolation between entries:

```c
static int32_t q_interp(int32_t p, int32_t quarter, int interp) {  /* p in [0, pi/2] */
    if (p >= quarter) return table[TSIZE];
    int64_t num = (int64_t)p * TSIZE;
    int32_t i = (int32_t)(num / quarter);
    if (!interp) return table[i];
    int32_t w = (int32_t)(((num % quarter) << 16) / quarter);      /* Q16.16 weight */
    int32_t a = table[i], b = table[i + 1];
    return (int32_t)((int64_t)a + (((int64_t)(b - a) * w) >> 16));
}
```

Then I scanned 125,664 points across [-2pi, 2pi] against libm's `sin()`:

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

Two-and-a-half LSB of error for an interpolation step is excellent, and note
where the remaining error comes from: not the interpolation math (theory says
~1e-7 rad here) but the table's own 1-LSB quantization. Bumping the table to
Q20.12 stores half the RAM but four times the error; this is the usual
size/accuracy trade you tune per application. Meanwhile a raw nearest-entry
read without interpolation is ~101 LSB — visibly wrong on a scope trace.

## Timing: what fixed-point actually saves

I benchmarked a control-loop workload — 3-tap FIR plus an EMA with
clamping — in Q16.16 and in `double`, 50 million iterations, best of three,
`clock_gettime(CLOCK_MONOTONIC)`:

```
workload: 3-tap FIR + EMA + clamp, 50000000 iterations, best of 3
  Q16.16 fixed-point :   0.415 s     8.30 ns/iter
  double             :   0.613 s    12.26 ns/iter
  ratio fixed/double : 0.68x
```

The fixed-point version is 1.5x *faster* — on an x86 with a full FPU and SSE
hardware. So fixed-point always wins, right? No. I ran a second, batch
workload — the same FIR over 1024 independent samples per block, which the
compiler can vectorize:

```
batch: 3-tap FIR over 1024 samples/block, best of 3
  Q16.16 fixed-point :   0.047 s     2.29 ns/sample
  double             :   0.028 s     1.35 ns/sample
  ratio fixed/double : 1.69x  (double is 1.7x faster)
```

Now double wins by 1.7x, because SSE processes two doubles per instruction
while my 64-bit-intermediate fixed-point code refuses to vectorize. The
honest summary for this host: when the workload is a serial dependency chain,
integer instructions with 1–3 cycle latencies win; when the data is
parallel, the FPU's throughput wins. Neither is the case that matters. The
case that matters is a Cortex-M0+ with no FPU at all, where each `double`
operation is a function call into libgcc and the fixed-point version wins by
an order of magnitude — a number I cannot show you here, because it depends
on *your* toolchain, flash wait states, and clock frequency.

## When fixed-point math is not worth it

Do not port working `float` code to fixed-point on:

- **A modern MCU with an FPU.** Cortex-M4F and up, the ESP32's single-precision
  unit — the hardware does the work in one cycle, and the fixifies nothing
  except your code's readability.
- **Anything desktop-class.** Your phone, a Pi, a server — double is fast and
  the FPU does more per cycle than your fixed-point code ever will.
- **Algorithms with wide dynamic range** — FFTs with 60+ dB of headroom,
  matrix inversions. Q16.16 covers -32768..32767.99998 and overflows
  silently; `300.0 * 300.0` already needs 5.9e9 units, past the int32
  maximum, and your saturation code — you wrote saturation code, right? — has
  to exist everywhere.

## The host is not the target

Everything above was compiled with gcc 16.2.1 on an Intel i7-8550U, x86-64,
and calibrated first (my int loop runs 0.64 ns/iter, a double multiply chain
3.85 ns/iter, so the machine is healthy). Your Cortex-M0 at 48 MHz with
soft-float linked in is a different universe: cycle counts, flash
latencies, and even whether `int` multiply is one instruction all change.
The workflow that works: write the `float` version, measure it on the real
target with a DWT cycle counter or a toggling GPIO pin and a scope, and only
then port the hot loop to fixed-point — keeping the float version behind a
compile switch to compare against on the bench.

Fixed-point math is not faster arithmetic. It is arithmetic that works when
the FPU does not exist — exact, predictable, single-cycle, and one overflow
trap away from a bug that only UBSan will tell you about.
