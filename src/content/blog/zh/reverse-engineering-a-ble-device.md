---
title: "逆向工程 BLE 设备：一套可落地的方法（GATT、HCI snoop log 与 bleak）"
description: "一套动手可用的逆向工程 BLE 方法：用 bluetoothctl、nRF Connect 和 Python 的 bleak 枚举 BLE GATT 服务与特征，用 HCI snoop log 抓取链路并在 Wireshark 里分析，最后重建 App 的私有协议。"
pubDate: 2026-10-27
lang: zh
translationKey: reverse-engineering-a-ble-device
tags: [reverse-engineering, security, embedded]
featured: false
keywords:
  - 逆向工程 BLE
  - BLE GATT
  - bluetoothctl
  - nRF Connect
  - HCI snoop log
---

大多数讲**逆向工程 BLE** 的教程，都是从一个扫描开始，以一个在作者桌上恰好能用的
「魔法写入」结束。那是演示，不是方法。方法是一套固定的序列——枚举、抓包、关联、
复现——它在你自己真正拥有的设备上依然奏效：那里一半特征只读，真正有意思的那个
是加密的，而控制通道从不通知你任何东西。

目的不是去破坏什么。目的是理解一台你拥有的设备，好让你用代码驱动它，而不是用那个
强迫你注册账号的厂商 App。在这里，**BLE GATT** 就是流量所读写的那张属性数据库，而
本文剩下的部分，是我攻克它的顺序：先 `bluetoothctl`，再用 nRF Connect 交叉验证，
用 `bleak` 做自动化，最后用 **HCI snoop log** 看清官方 App 做了哪些我猜不到的事。

## 逆向工程 BLE 到底意味着什么

BLE 不是一条字节流。它是一个小的、结构化的数据库——GATT server——藏在无线链路
之后。客户端并不「发送命令」，它读写属性；每个属性都有一个仅对本连接有效的 16 位
handle，以及一个说明它是什么的 UUID。你能学到的一切，都来自三个问题：

1. 有哪些属性？它们的 handle 和 UUID 是什么？
2. 哪些我能读、能写、能订阅？
3. 对我关心的那些操作，App 在它们之间搬运了什么值？

回答了这些，协议就不再是谜；答不上来，你就只能对着不透明的字节乱猜。所以这套方法
毫不性感：枚举数据库，抓取链路，然后把两者关联起来。

## 一页讲清 BLE GATT：服务、特征、handle

GATT server 是一棵树。你真正会碰到的层级：

- **Service（服务）**——一组相关的数据，用 UUID 标识（例如 `0x180F`
  电量，或某个 128 位厂商 UUID）。服务分为 primary 和 secondary。
- **Characteristic（特征）**——一个值加上它的权限，用 UUID 标识，并落在某个
  **attribute handle** 上。出现在原始 ATT 流量里的是 handle，不是 UUID。
- **Descriptor（描述符）**——特征上的元数据。真正要紧的是
  **Client Characteristic Configuration Descriptor（CCCD，UUID `0x2902`）**，
  它用来开启或关闭通知。

每个特征会声明它的 `properties`。相关的那几个是 `read`、`write`、
`write-without-response`、`notify`、`indicate`。后两个是异步通道：

- **Notify** 是发后不理。外设把值推过来，客户端不回确认。更省，但在链路差时可能被丢。
- **Indicate** 是有确认的。客户端要回一个确认，外设才知道值到了。更可靠，更慢。

要收到其中任何一种，客户端都必须先往该特征的 CCCD 写入 `0x0001`（notify）或
`0x0002`（indicate）。如果你在代码里订阅了却什么都收不到，CCCD 的写入就是第一个
要查的地方。

## 用 bluetoothctl 扫描与枚举

在 Linux 上，`bluetoothctl` 是看清一台设备形状最快的方式。它是交互式的，但你也能
把它脚本化。开始扫描，列出发现，连接，然后进入 GATT 子菜单：

```bash
$ bluetoothctl
[bluetooth]# scan on
Discovery started
[NEW] Device AA:BB:CC:DD:EE:FF MySensor
[bluetooth]# scan off
[bluetooth]# connect AA:BB:CC:DD:EE:FF
[MySensor]# menu gatt
[MySensor]# list-attributes
Primary Service (Handle 0x0001): 00001800-0000-1000-8000-00805f9b34fb
  Characteristic: 00002a00-...  (Primary Service)
Descriptor: 00002901-...  (Characteristic User Description)
...
[MySensor]# select-attribute /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service000a/char000b
[MySensor]# read
```

`list-attributes` 会打印出服务、特征和描述符以及它们的 handle——有时是十进制，有时
是 `/org/bluez/...` 路径。用 `read` 读一个特征，用 `write <value>` 写它，用
`notify on` 订阅（它会分配一个通知槽位），再 `acquire-notify`，然后在另一个终端里
`monitor`，就能实时看值。默认的 `write <value>` 用的是 write-with-response；当某个
特征只支持 write-without-response 时，`bluetoothctl` 会自动选对方法。

两个省时间的习惯。第一，`info AA:BB:CC:DD:EE:FF` 能在你连接之前就显示已广播的服务。
第二，随手把关心的 handle 记下来——你之后读抓包要用到它们，因为嗅探器看到的是
handle，从来不是 UUID。

## 用 nRF Connect 枚举

`bluetoothctl` 适合脚本，却不适合探索；我接下来用来交叉验证的是 **nRF Connect for
Mobile**。它把整张 GATT 表渲染成一棵树，把每个特征的属性显示成图标（R、W、N、I），
让你点一下就能读、写一个十六进制串、或开关 notify，并把收到的通知按时间戳记录下来。
它还会报告协商出的 **MTU**。

它真正的价值是那个日志，而且就在运行厂商 App 的同一部手机上。两个一起跑，在厂商
App 里复现一个操作，再看 nRF Connect 里什么东西动了。这是你能拿到的最便宜的一个
「协议神谕」。

## 用 bleak 枚举服务

凡是想重复做的事，都转到 Python。`bleak` 跨平台，给你和 `bluetoothctl` 一样的视角，
而且自带 API。下面这段枚举了每个服务与特征，含 handle 和属性：

```python
import asyncio
from bleak import BleakClient

ADDRESS = "AA:BB:CC:DD:EE:FF"

async def main() -> None:
    async with BleakClient(ADDRESS) as client:
        for service in client.services:
            print(f"[service] {service.uuid}  {service.description}")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"  [char] {char.uuid}  handle=0x{char.handle:04x}  {props}")

if __name__ == "__main__":
    asyncio.run(main())
```

`handle` 这一列，就是这份 Python 视图和下面的抓包之间的桥梁。如果这里显示
`0x0014`，那它就是你之后要在 Wireshark 里 grep 的那个数字。

## 读特征 vs 写特征

读返回的是当前值，写改变的是状态。两者不可互换，`bleak` 把区别摆得很明白：

```python
VENDOR_CHAR = "0000fff2-0000-1000-8000-00805f9b34fb"

# 读取当前值。
value = await client.read_gatt_char(VENDOR_CHAR)
print("read:", value.hex(" "))

# 带响应的写（ATT opcode 0x12）。可靠，有确认。
await client.write_gatt_char(VENDOR_CHAR, bytes([0x01, 0x00, 0x00, 0x00]), response=True)

# 不带响应的写（ATT opcode 0x52）。更快，失败会被静默丢弃。
await client.write_gatt_char(VENDOR_CHAR, bytes([0x02, 0x01]), response=False)
```

两个坑。第一，**write-without-response** 在链路繁忙时可能凭空消失；如果一条命令
「有时候能用」，原因就在这里。第二，默认的 ATT MTU 是 23 字节，留给负载的只有 20
字节。你发一个 32 字节的帧，它会被截断或拒绝——写长值之前先协商更大的 MTU，同时也
要清楚很多设备会悄悄限制它能接受的长度。

## 订阅一个通知

要观察设备主动推上来的数据，就订阅某个特征。底层上，`bleak` 会替你写 CCCD，然后
每来一条通知就调用你的回调：

```python
import asyncio
from bleak import BleakClient

ADDRESS = "AA:BB:CC:DD:EE:FF"
NOTIFY_CHAR = "0000fff1-0000-1000-8000-00805f9b34fb"

def on_notify(_char, data: bytearray) -> None:
    print("notify:", data.hex(" "))

async def main() -> None:
    async with BleakClient(ADDRESS) as client:
        await client.start_notify(NOTIFY_CHAR, on_notify)
        await asyncio.sleep(60)          # 在你摆弄设备时持续观察
        await client.stop_notify(NOTIFY_CHAR)

if __name__ == "__main__":
    asyncio.run(main())
```

跑起来，然后触发你关心的那个物理动作——按下按钮、改变温度、移动设备。回调里出现的
一切，就是设备真实的高频通道，而且它通常比你读到的任何值都更有信息量。

## 用 HCI snoop log 抓取链路

到此为止，一切还都依赖你猜该做哪个动作。**HCI snoop log** 把「猜」去掉了：它记录
下厂商 App 实际交换的字节，包括那些它从不暴露的部分。在 Android 上，打开开发者
选项，启用 **Enable Bluetooth HCI snoop log**，在厂商 App 里复现那个动作，然后取出
日志：

```bash
# Android：从 bug report 里把抓包捞出来。
adb bugreport bugreport.zip
unzip -j bugreport.zip '*btsnoop_hci.log' -d .
wireshark btsnoop_hci.log

# Linux：在厂商 App 与设备通信时实时抓包。
sudo btmon -w capture.btsnoop
```

这个文件是 **btsnoop** 格式，Wireshark 能直接读。在 Linux 上，`btmon` 记录的是内核
的 HCI 流量——不需要手机，但要留意它会捕获适配器的每一个事件，所以要狠狠地过滤。

## 在 Wireshark 里读 HCI snoop log

HCI 抓包很吵：连接事件、L2CAP 分帧、LMP 闲谈，什么都有。你要的是 ATT 层，而下面这
几个显示过滤器，能覆盖一次会话的大部分：

```text
btatt                    # 所有 ATT 请求、响应与通知
btatt.opcode == 0x1b     # Handle Value Notification（服务端 -> 客户端）
btatt.opcode == 0x1d     # Handle Value Indication
btatt.handle == 0x0014   # 所有触碰某个属性 handle 的包
btatt.uuid16 == 0x2a00   # 按 UUID 看对 Device Name 的读写
btsmp                    # 配对：pairing request/response、密钥交换
```

工作流是：先从 `bluetoothctl`/`bleak` 拿到 handle，过滤到那个 handle，然后按顺序
读值。一次控制会话读起来像一句话——一个首字节是 opcode 的写，接着一条在同一或相关
handle 上运回设备回复的通知。把这些包和你在厂商 App 里的操作时间线对齐，协议就
自己浮出来了。

## 配对与绑定：为什么有些设备需要它

如果某个特征拒绝你，错误码会告诉你撞上了哪堵墙。会遇到的 ATT 错误：

- `0x05 Insufficient Authentication`——你没有绑定，或者链路没有加密。
- `0x0F Insufficient Encryption`——这个属性可用之前必须先配对。
- `0x08 Insufficient Authorization`——你绑定了，但缺少某个必要条件。

**Pairing（配对）**是一次性的密钥交换；**bonding（绑定）**是把密钥存下来，好让下次
连接直接加密。厂商特征往往要求先有这条绑定且加密的链路，才肯交出值或接受写入。如果
`bluetoothctl` 读出 `0x05`，先在 `connect` 之前跑 `pair AA:BB:CC:DD:EE:FF` 和
`trust AA:BB:CC:DD:EE:FF`，然后重试。如果配对本身要求一个你并没有的 passkey，那是一
道刻意的屏障，不是一道待解的谜题。

## 重建 App 的协议

现在所有拼图合到一处。手里有 snoop log，GATT 表也画好了，你就靠关联来重建协议：

1. **给 App 做标记。** 每次在厂商 App 里做一件事，就记下时间和动作。
2. **过滤抓包**，只留那些动作碰过的 handle，按时间排序。
3. **对两次完全相同的动作做 diff。** 变化的字段是状态——计数器、nonce、序号；
   不变的字段是结构。
4. **在 `bleak` 里重放。** 发出抓到的那个写，订阅回复特征，确认同一条通知回来了。
5. **一次只改一个变量**，直到你能预测一个新输入对应的写。

这和[逆向一个私有 HTTP API](/zh/posts/reverse-engineering-a-private-api/) 是同一套
纪律：观察、抓包、重放，然后才自动化——而当初解开[校园认证门户](/zh/posts/ruijie-campus-portal-reverse-engineering/)
的那个直觉，同样适用于一个两字节的 BLE opcode。边填边维护一张 opcode → 含义的表；
那张表就是协议。

## 你会卡住的地方

诚实地划出边界，因为这套方法有它的边：

- **加密的厂商特征。** 有些设备把真正有意思的特征，藏在一层应用层加密之后，而密钥
  是在云端配对步骤里派生的。绑定给你的是加密链路，它不给你 App 密钥。没有那个
  密钥，字节就是不透明的，而暴力破解不是答案。
- **控制通道没有 notify。** 如果某个控制特征从不通知，你就没法被动观察状态。改为
  定时去读那个读特征，同时记住设备可能会对你限流。
- **write-without-response 静默丢弃。** 不会有任何错误返回。事后读一次状态来验证；
  不要相信那次写。
- **iOS 的 GATT 缓存。** iOS 会按已绑定设备缓存服务。固件更新后，删掉并重新配对，
  才能看到新的 handle。
- **handle 会随固件版本变化。** 永远不要把 handle 写死；运行时按 UUID 去解析它。

## 授权使用：只对自己的设备

把它指向你拥有、且被允许检查的硬件。逆向你自己的灯泡、传感器或码表，来自动化你自己
的访问，是正常的工程。去攻破一道你无权绕过的设备锁、去读别人的数据，或者去破解一条
你从未拿到密钥的加密通道，都不是——那是边界，不是谜题。遵守你所在之处的法律和适用
条款；如果某一步需要别人的密钥，就停下。

这套方法本身是中立的，而这正是重点。扫描、枚举、抓包、关联、重放。在你自己的工作台
上做，笔记留好，那个不透明的厂商 App 就会变成一段你看得懂的两字节协议。
