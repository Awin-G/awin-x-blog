---
title: "Modbus TCP 与 RTU：如何与工业设备通信"
description: "动手实操 Modbus —— 那个驱动工厂的极简协议。通过 TCP 和 pty 模拟的 RS485 链路，展示真实请求/响应字节、CRC16 校验和异常处理。"
pubDate: 2027-02-16
lang: zh
translationKey: modbus-tcp-and-rs485
tags: [embedded, networking]
featured: false
keywords:
  - Modbus TCP
  - Modbus RTU
  - RS485
  - holding registers
  - CRC16
---

Modbus 无处不在。它驱动着太阳能逆变器、变频器、PLC、电表，以及典型 SCADA 系统中一半的传感器。它于 1979 年由 Modicon 发布，至今仍是与工业设备通信的默认方式。本文将用真实字节带你走一遍协议——下面每个帧都是我为本篇文章用 Python 标准库写的最小服务器和客户端生成的。

## Modbus 是什么

Modbus 是一个**主从**协议。一个主站（你的 PLC、树莓派、Python 脚本）发送请求；从站（传感器、驱动器、电表）响应。最初的版本运行在串口 RS485 上；现代变体 **Modbus TCP** 将同样的协议封装在 TCP 连接的 502 端口上。

数据模型极小——四张 16 位值的表：

| 表 | 访问权限 | 典型用途 |
|---|---|---|
| 线圈 (Coils) | 读/写 | 数字量输出 |
| 离散量输入 (Discrete inputs) | 只读 | 数字量输入 |
| 保持寄存器 (Holding registers) | 读/写 | 配置、设定值 |
| 输入寄存器 (Input registers) | 只读 | 测量值、状态 |

每个地址 16 位，所以每台设备每张表最多可以有 65,536 项。实际上大多数设备只暴露几百个。

<figure>
<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Modbus 主站与从站及寄存器表">
  <defs>
    <style>
      .box { fill: none; stroke: currentColor; stroke-width: 1.5; }
      .reg { fill: #0f766e; opacity: 0.15; }
      .reg-hi { fill: #0f766e; opacity: 0.45; }
      .lbl { font-family: ui-monospace, monospace; font-size: 11px; fill: currentColor; }
      .lbl-sm { font-family: ui-monospace, monospace; font-size: 9px; fill: currentColor; opacity: 0.7; }
      .arrow { stroke: currentColor; stroke-width: 1.5; fill: none; marker-end: url(#arr); }
    </style>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Master -->
  <rect x="20" y="60" width="140" height="100" class="box" rx="4"/>
  <text x="90" y="85" text-anchor="middle" class="lbl">主站</text>
  <text x="90" y="100" text-anchor="middle" class="lbl-sm">PLC / Python</text>
  <text x="90" y="120" text-anchor="middle" class="lbl-sm">端口 502</text>
  <!-- Slave -->
  <rect x="480" y="40" width="140" height="140" class="box" rx="4"/>
  <text x="550" y="62" text-anchor="middle" class="lbl">从站</text>
  <text x="550" y="76" text-anchor="middle" class="lbl-sm">地址 0x01</text>
  <!-- Register tables in slave -->
  <rect x="495" y="88" width="110" height="16" class="reg"/>
  <rect x="495" y="108" width="110" height="16" class="reg-hi"/>
  <rect x="495" y="128" width="110" height="16" class="reg"/>
  <rect x="495" y="148" width="110" height="16" class="reg"/>
  <text x="550" y="100" text-anchor="middle" class="lbl-sm">线圈</text>
  <text x="550" y="120" text-anchor="middle" class="lbl-sm">保持寄存器</text>
  <text x="550" y="140" text-anchor="middle" class="lbl-sm">输入寄存器</text>
  <text x="550" y="160" text-anchor="middle" class="lbl-sm">离散量输入</text>
  <!-- Arrows -->
  <path d="M160,95 L480,95" class="arrow"/>
  <path d="M480,125 L160,125" class="arrow"/>
  <text x="320" y="88" text-anchor="middle" class="lbl-sm">请求 (功能码 0x03)</text>
  <text x="320" y="140" text-anchor="middle" class="lbl-sm">响应 (2 个寄存器)</text>
  <!-- Frame annotation -->
  <rect x="180" y="170" width="280" height="36" class="box" rx="3"/>
  <text x="320" y="185" text-anchor="middle" class="lbl-sm">00 01 00 00 00 06 01 03 00 0A 00 02</text>
  <text x="320" y="198" text-anchor="middle" class="lbl-sm">MBAP 头部 + PDU</text>
</svg>
<figcaption>Modbus TCP：主站将 PDU 封装在 7 字节 MBAP 头部中。从站解码功能码和地址，然后从相应的寄存器表中读取。</figcaption>
</figure>

<figure>
<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Modbus 主站与从站及寄存器表">
  <defs>
    <style>
      .box { fill: none; stroke: currentColor; stroke-width: 1.5; }
      .reg { fill: #0f766e; opacity: 0.15; }
      .reg-hi { fill: #0f766e; opacity: 0.45; }
      .lbl { font-family: ui-monospace, monospace; font-size: 11px; fill: currentColor; }
      .lbl-sm { font-family: ui-monospace, monospace; font-size: 9px; fill: currentColor; opacity: 0.7; }
      .arrow { stroke: currentColor; stroke-width: 1.5; fill: none; marker-end: url(#arr); }
    </style>
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Master -->
  <rect x="20" y="60" width="140" height="100" class="box" rx="4"/>
  <text x="90" y="85" text-anchor="middle" class="lbl">主站</text>
  <text x="90" y="100" text-anchor="middle" class="lbl-sm">PLC / Python</text>
  <text x="90" y="120" text-anchor="middle" class="lbl-sm">端口 502</text>
  <!-- Slave -->
  <rect x="480" y="40" width="140" height="140" class="box" rx="4"/>
  <text x="550" y="62" text-anchor="middle" class="lbl">从站</text>
  <text x="550" y="76" text-anchor="middle" class="lbl-sm">地址 0x01</text>
  <!-- Register tables in slave -->
  <rect x="495" y="88" width="110" height="16" class="reg"/>
  <rect x="495" y="108" width="110" height="16" class="reg-hi"/>
  <rect x="495" y="128" width="110" height="16" class="reg"/>
  <rect x="495" y="148" width="110" height="16" class="reg"/>
  <text x="550" y="100" text-anchor="middle" class="lbl-sm">线圈</text>
  <text x="550" y="120" text-anchor="middle" class="lbl-sm">保持寄存器</text>
  <text x="550" y="140" text-anchor="middle" class="lbl-sm">输入寄存器</text>
  <text x="550" y="160" text-anchor="middle" class="lbl-sm">离散量输入</text>
  <!-- Arrows -->
  <path d="M160,95 L480,95" class="arrow"/>
  <path d="M480,125 L160,125" class="arrow"/>
  <text x="320" y="88" text-anchor="middle" class="lbl-sm">请求 (功能码 0x03)</text>
  <text x="320" y="140" text-anchor="middle" class="lbl-sm">响应 (2 个寄存器)</text>
  <!-- Frame annotation -->
  <rect x="180" y="170" width="280" height="36" class="box" rx="3"/>
  <text x="320" y="185" text-anchor="middle" class="lbl-sm">00 01 00 00 00 06 01 03 00 0A 00 02</text>
  <text x="320" y="198" text-anchor="middle" class="lbl-sm">MBAP 头部 + PDU</text>
</svg>
<figcaption>Modbus TCP：主站将 PDU 封装在 7 字节 MBAP 头部中。从站解码功能码和地址，然后从相应的寄存器表中读取。</figcaption>
</figure>

## 编号的坑

这里是所有人都会绊倒的地方：Modbus 规范文档中使用**从 1 开始**的地址（线圈从 00001 开始，保持寄存器从 40001 开始），但线上协议使用**从 0 开始**的偏移量。所以"保持寄存器 40011"在发送时是偏移量 `0x000A`（十进制 10）。功能码已经隐含了表——`0x03` 总是指保持寄存器——所以请求中的地址只是该表内的偏移量。

## Modbus TCP：MBAP 头部

Modbus TCP 在 PDU 之前加了一个 7 字节的 **MBAP**（Modbus Application Protocol）头部：

```
00 01 00 00 00 06 01
```

| 字节 | 字段 | 值 | 含义 |
|---|---|---|---|
| 0–1 | 事务标识符 | `00 01` | 匹配请求与响应 |
| 2–3 | 协议标识符 | `00 00` | Modbus 始终为 0 |
| 4–5 | 长度 | `00 06` | 此字段之后的字节数 |
| 6 | 单元标识符 | `01` | 从站地址（TCP 上常被忽略） |

接下来是 PDU：功能码 + 数据。一个**读保持寄存器**请求（功能码 `0x03`），从偏移量 10 开始读 2 个寄存器：

```
PDU: 03 00 0a 00 02
```

线上完整帧：

```
00 01 00 00 00 06 01 03 00 0a 00 02
```

我写的服务器响应：

```
00 01 00 00 00 07 01 03 04 12 34 56 78
```

PDU `03 04 12 34 56 78` 拆解：功能码 `0x03`，字节数 `04`（4 字节 = 2 个寄存器），然后两个大端 16 位值：`0x1234` 和 `0x5678`。作为有符号 16 位分别是 4660 和 22136。

## 异常响应

请求一个不存在的寄存器，服务器返回异常。功能码被 `0x80` 或运算后，跟着一个异常码：

```
00 01 00 00 00 03 01 83 02
```

PDU `83 02`：功能码 `0x83`（= `0x03 | 0x80`），异常码 `0x02` = **非法数据地址**。当我请求从偏移量 95 开始读 10 个寄存器时（只存在 100 个寄存器），我的服务器发送了这个异常。

## 写寄存器

功能码 `0x06` 写单个保持寄存器。我向偏移量 20 写入 `0xABCD`：

```
请求：  00 02 00 00 00 06 01 06 00 14 ab cd
响应：  00 02 00 00 00 06 01 06 00 14 ab cd
```

服务器将请求原样返回——这就是确认。读回该值：

```
00 01 00 00 00 05 01 03 02 ab cd
```

返回 `0xABCD`。作为有符号 16 位值是 −21555——同样的比特，只是解释方式不同。

## RS485 上的 Modbus RTU

**Modbus RTU** 是没有 MBAP 头部的相同协议。帧格式为：

```
[从站地址] [功能码] [数据] [CRC16]
```

CRC16（多项式 0xA001，初始值 0xFFFF）在除 CRC 本身外的所有数据上计算，以小端格式发送。我用真实的 pty 对其进行了验证——Python 的 `pty.openpty()` 并在两端设置 `tty.setraw()`，这在协议层面对 RS485 半双工链路是一个合理的模拟。

同样的 2 个保持寄存器的 RTU 读请求：

```
01 03 00 0a 00 02 e4 09
```

前 6 字节的 CRC 是 `0x09E4`，发送为 `e4 09`。服务器收到后验证 CRC，响应：

```
01 03 04 12 34 56 78 81 07
```

CRC `0x0781` 发送为 `81 07`。客户端验证通过——匹配。

第二个读请求，功能码 `0x04`（读输入寄存器）：

```
请求：  01 04 00 00 00 02 71 cb
响应：  01 04 04 00 ff 01 00 ca 24
```

返回两个输入寄存器：`0x00FF` 和 `0x0100`。

如果 CRC 错误，从站保持静默。一个损坏的帧：

```
01 03 00 0a 00 02 00 00
```

正确的 CRC 是 `e4 09`，不是 `00 00`——从站发现不匹配，不响应。这是 RS485 上主要的错误检测机制；Modbus 本身没有内置重传。

## RS485：物理层

RS485 是差分串口总线——两根线（A 和 B）抑制共模噪声。在大多数工业环境中运行在 9600 或 19200 波特率，尽管 115200 在较短线路中也很常见。关键特性：

- **半双工**：一对线同时承载两个方向，所以同一时刻只能有一个设备发送。主站轮询；从站从不被询问不发言。
- **多站**：单条总线最多 32 个设备（使用中继器可以更多），每个有唯一的从站地址。
- **终端匹配**：总线两端各接一个 120 Ω 电阻，防止信号反射。没有它，在较高波特率或较长电缆上数据会出错。

RS485 总线上的串口嗅探器看到的正是上面的字节——地址、功能码、数据、CRC——没有任何帧界。这就是为什么 Modbus RTU 需要帧间 3.5 字符的静默来区分消息边界。

## 实用建议

**读寄存器映射表。** 每台 Modbus 设备都应附带寄存器映射表——PDF 或电子表格，列出哪个偏移量存什么、什么比例。没有它你只能靠猜。有了你只是读偏移量。

**注意 32 位值。** 很多设备将 32 位整数或浮点数存在两个连续的 16 位寄存器中。字序因厂商而异：有的先发高字（大端），有的先发低字。查手册。如果读到无意义的值，试试交换两个寄存器。

**生产环境用成熟的库。** Python 用 `pymodbus`，它处理重连、字节序和边界情况。快速读取可以用 `mbpoll` 或 `modpoll`。自己写协议栈（如上文）很有教育意义，但会错过多年积累的兼容经验。

**一条总线一个主站。** 在 RS485 上，两个主站会冲突并互相破坏帧。在 TCP 上，多个客户端可以连接，但设备可能串行化请求——查看其并发规格。

**超时和重试。** Modbus TCP 没有内置重试。如果发送请求后在超时时间内没有收到响应，重试。三次失败则标记设备离线。

## 总结

Modbus 之所以长盛不衰，是因为它小到可以在微控制器的睡眠周期中实现，简单到可以用串口调试器排查。TCP 变体把它带到了以太网而没有改变协议。我上面展示的字节——MBAP 头部、功能码、CRC16——就是每时每刻流过工厂、发电站和楼宇自动化系统的字节。一旦见过它们，你就无法忽视它们。

更多关于嵌入式 TCP 调试的内容，参见 [嵌入式 TCP 调试](/zh/posts/debugging-tcp-on-embedded/)。如果你对串口协议的字节级工作原理感兴趣，[解码串口协议](/zh/posts/decoding-a-serial-protocol/) 涵盖了基础知识。