---
title: "什么才真正装得下：在受限单片机上跑一套 MQTT ESP32 栈"
description: "MQTT 比大多数 IoT 消息协议都更契合单片机的预算——最小两字节的固定头、发布/订阅解耦、以及可按下调的 QoS。本文说清楚，一旦把 TLS、证书和重连都算进来，一套 MQTT ESP32 方案到底要付出什么。"
pubDate: 2026-10-31
lang: zh
translationKey: mqtt-on-a-microcontroller
tags: [esp32, embedded, networking]
featured: false
keywords:
  - MQTT ESP32
  - MQTT 单片机
  - esp-mqtt
  - IoT 消息传递
  - QoS
---

每隔几个月就有人让我往一块板子上塞"一点点"MQTT：一个上报温度的传感器，一个能被
仪表盘扳动的继电器。第一反应总是去拿你在容器里跑的那套栈，而那个反应是错的——
**MQTT 单片机**这一侧难，不是因为协议重；协议其实轻得惊人。难的是它外面裹着的
一切：TLS、证书、时钟、重连。对 **IoT 消息传递**而言，它仍是少数真正能塞进 MCU 的
协议之一。工具链如果还没搭起来，可以先看那份
[ESP32-C3 入门笔记](/zh/posts/esp32-c3-getting-started/)。

## 为什么 MQTT 适合单片机：IoT 消息传递的契合点

MQTT 能在 MCU 上取胜，靠的是结构性的原因，而不是因为它时髦：

- **固定头极小。** 最小只有两个字节：一个控制字节，外加一个剩余长度字段——只要
  载荷小于 128 字节，它就是一个字节。一条只带一个传感器读数的 `PUBLISH`，比一行
  HTTP 请求行还小。
- **发布/订阅把设备解耦了。** 设备往一个主题发完就忘，根本不在乎是一个仪表盘、十个
  仪表盘，还是根本没人订阅。需要收命令的设备，再去订阅自己的命令主题就行。
- **QoS 是旋钮，不是开关。** 每条消息你都可以自己挑要买多少投递保证——从"发完就算"
  到需要确认的握手。
- **它天生能扛坏链路。** 心跳、last will、retain、持久会话，这些存在的意义就是让
  一个不可靠的边缘，对可靠的核来说变得合理。

协议本身要的东西很少：一个 TCP socket、一个定时器、每条连接几字节的状态。麻烦在于，
几乎没人只跑 MQTT。

## MQTT ESP32 的内存现实：一条 TLS 连接到底要花多少

在一套 **MQTT ESP32** 方案里，MQTT 这一层本身很便宜；账单是 TLS 出的，而握手指的
是你固件里最大的一笔单次分配。

- **MQTT 包缓冲**小且有界。你配一个收缓冲、一个发缓冲，按 `esp-mqtt` 默认的每边
  几 KB 来算，能装的载荷已经远大于任何理智的传感器消息了。
- **TLS 握手是一次瞬时尖峰。** mbedTLS 在计算会话时，需要在两个方向上各持记录缓冲，
  *外加*一块临时空间。握手期间的堆峰值，比 MQTT 缓冲高出一个数量级都算保守；而它
  只会在任务栈或 DNS 缓存也占着内存的时候才失败。
- **稳定态更小，但并非免费。** 会话建立后，进/出的记录缓冲会一直驻留，和 socket、
  MQTT 任务栈一起：只要会话活着，就是好几 KB 的堆被压在那里。
- **心跳让它一直活着。** 你是持续在为这块堆付费，所以间隔很要紧。把心跳设到路径上
  NAT 和防火墙的空闲超时之下（常见是 60–120 秒），但也别低到无谓地狂发 `PINGREQ`。
  把会话恢复和 TLS session ticket 打开：靠 ticket 重连能直接跳过那次昂贵的握手。

所以要按需才开 TLS 会话，把握手余量算进空闲堆预算里，绝不要在堆已经吃紧时才去握手。
用 `esp_get_free_heap_size()` 在连接前后量你自己的最坏情况，把它当硬底线：这个尖峰
取决于密码套件、证书链长度和你的缓冲大小。

## 在 ESP-IDF 里跑通 esp-mqtt

ESP-IDF 的 MQTT 客户端是协议之上的一层薄封装，它的配置结构体几乎就是本文所有决策的
落脚点。下面是一段完整、最小的启动代码，带 TLS、稳定的 client id、心跳和 last will：

```c
#include "mqtt_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"

static esp_mqtt_client_handle_t s_client;

static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data);

esp_mqtt_client_handle_t mqtt_start(const char *uri)
{
    const esp_mqtt_client_config_t cfg = {
        .broker = {
            .address = { .uri = uri },   // "mqtts://broker.example:8883"
            .verification = { .crt_bundle_attach = esp_crt_bundle_attach },
        },
        .credentials = {
            .client_id = "sensor-a17",   // stable and unique per device
            .authentication = {
                .certificate = (const char *)client_crt_pem, // mTLS, if used
                .key         = (const char *)client_key_pem,
            },
        },
        .session = {
            .keepalive = 60,             // seconds; stay under NAT idle timeouts
            .disable_clean_session = false,
            .last_will = {
                .topic   = "fleet/sensor-a17/availability",
                .msg     = "offline",
                .msg_len = 7,
                .qos     = 1,
                .retain  = 1,
            },
        },
        .network = {
            .reconnect_timeout_ms = 5000,
            .timeout_ms           = 10000,
        },
    };
    s_client = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                   mqtt_event_handler, NULL);
    esp_mqtt_client_start(s_client);
    return s_client;
}
```

事件处理器是诚实设计真正住的地方——也是最常见的 bug 住的地方：在一个本来就会退避
重试的客户端之上，自己再套一层重连循环。

```c
static void mqtt_event_handler(void *args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    switch (event_id) {
    case MQTT_EVENT_CONNECTED:
        // Announce ourselves as retained state, then listen for commands.
        esp_mqtt_client_publish(s_client, "fleet/sensor-a17/availability",
                                "online", 0, 1, 1);  // QoS 1, retained
        esp_mqtt_client_subscribe(s_client, "fleet/sensor-a17/cmd/#", 1);
        break;

    case MQTT_EVENT_DISCONNECTED:
        // Do NOT reconnect by hand here. esp-mqtt already backs off and retries;
        // stacking your own loop on top is how you build a reconnect storm.
        break;

    default:
        break;
    }
}
```

## QoS 0、1、2：只为需要的部分付费

QoS 不是那种可以"调高"的质量档位。它是按消息类别的成本：RAM、往返次数，以及你必须
跨重启保留的状态。

- **QoS 0——至多一次。** 发完就忘。没有确认、不存状态、不重试。用在高速遥测上，丢
  一个采样无所谓，因为下一个马上就来。这是传感器流的正确默认值。
- **QoS 1——至少一次。** 接收方用 `PUBACK` 确认；发送方在送达前一直把消息留在飞行
  中，并可能重投。重复是可能的，所以载荷要做成幂等的——设状态、把计数器设成绝对值，
  而不是"自增一"。用在命令，以及你确实会错过的东西上。代价是一个在途消息槽的 RAM，
  加一个往返。
- **QoS 2——恰好一次。** 一次四路握手，两端都要存状态。对在 broker 之间流转的钱来说
  它是正确答案，对一颗电池传感器来说是错误的答案：它把协议状态翻倍，多加两个往返，
  换来的保证是绝大多数传感器数据从不需要的。

我实际交付的切分是：**遥测走 QoS 0，命令、状态和 last will 走 QoS 1，QoS 2 基本不
用。** 把在途窗口设小——一到两条未确认消息——因为这个窗口就是你一直攥着的 RAM。

## Retain 与 last will：让一个不可靠的设备变得可读

断电的设备没法说再见。有两个特性可以把这个洞糊上，而且它们比任何 QoS 设置都值：

**Retain** 让 broker 记住某个主题上的最后一条消息，并在新订阅者一连上时就立刻交给它，
于是仪表盘能在连上的瞬间显示当前温度。把它用在低频的状态和在线主题上；不要 retain
高速流，因为 broker 会为每个被 retain 的主题永久留一份。

**last will** 是你在连接时登记的一条消息。如果连接在没有干净 `DISCONNECT` 的情况下
断掉，broker 会替你发布它。把它指到一个 retained 的在线主题上，这样一个凭空消失的
设备就会被标记为离线，而不是永远留着一条过期的"在线"：

```text
fleet/<device-id>/availability   # retained "online" / LWT "offline"
```

有一个会咬人的坑：*干净* 断开是会压制 last will 的。如果你是有意关机，就在断开前自己
发一条空的 retained 消息（或 "offline"），否则 broker 会一直对外宣称你在线。

## 面向大量设备的主题设计

主题是一层层级结构，它怎么摆，决定了订阅有多便宜、你能多安全地在整个设备群里用通配符。

```text
fleet/<device-id>/state        # retained JSON: last known state
fleet/<device-id>/availability # retained "online"/"offline" (LWT target)
fleet/<device-id>/telemetry    # QoS 0, high rate
fleet/<device-id>/cmd/#        # device subscribes; broker routes commands in
$SYS/broker/...                # broker health — dashboards read, devices do not
```

我最终定下来的规矩：

- **把变量放在末尾。** `fleet/sensor-a17/telemetry` 让一个车队仪表盘能廉价地订阅
  `fleet/+/telemetry`；一个把设备 id 放在最后的主题，会让所有通配符失效。
- **设备只往自己的命名空间发，只订阅自己的命令主题。** 永远不要让设备去订阅 `#`。
- **载荷保持小而自描述。** 把单位、时间戳放进消息里，而不是塞进越来越深的主题。主题
  是路由地址，不是数据库 schema。
- **当多个后端 worker 需要为一个订阅做负载均衡时，用 `$share` 组**，而不是让每个
  worker 各订一份、各收一份。

## 只有在生产里才见得到的失效模式

### 重连风暴

一次全场断电把所有设备同时重启，它们全都按同一个节奏、指向同一个 broker 去重连。
broker 撞上连接上限，设备失败、退避、然后又永远整齐划一地重试。两边都要治：配置
`reconnect_timeout_ms`，在你自己的重试时序里加上抖动，让整个设备群不要像一群羊一起
动；再给 broker 的 `max_connections` 设上限，让它优雅降级而不是直接死掉。

### broker 背压与队列

MQTT 除了 TCP 本身，不会给发布者任何流控。一个慢订阅者配上 QoS 1，会逼 broker 替它
排队；队列一满，broker 就丢——这是对的，但如果你不盯着，它就是静默的。把
`max_queued_messages` 设成有界，别在高频主题上用 QoS 1，并且盯住
`$SYS/broker/messages/*`，别让一个持续被淹没的订阅者看起来一切正常。

### 时钟必须在 TLS 做任何事之前就是对的

刚启动的 ESP32 以为自己身处 1970 年，于是每张证书都"尚未生效"，握手就以一个和你的
凭据毫无关系的原因失败。要在开 TLS 连接 *之前* 对时：

```c
#include "esp_sntp.h"
#include <time.h>

static bool time_is_plausible(void)
{
    setenv("TZ", "UTC0", 1);
    tzset();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();

    time_t now = 0;
    // Wait, bounded, for a clock past 2025 — then certs can validate.
    for (int i = 0; i < 100 && now < 1735689600; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
        time(&now);
    }
    return now >= 1735689600;
}
```

如果你实在连不上 NTP，那就改为把 broker 的证书或它的公钥哈希钉死——但千万别用关闭
校验来"修复"时钟问题。那等于用一次不稳定的握手，换来一个静默的中间人。

### mTLS 证书的存放

每设备一张客户端证书，听起来干净，落地起来很快就别扭。证书和私钥总得存在 flash 上，
也就是 NVS 或一段内嵌的 PEM 字符串。把私钥烧进固件，意味着所有单元共享同一个 secret，
而且从固件 dump 里能轻易提取；在出厂时把密钥写进 NVS 更好，但只有在 flash 加密和
secure boot 都打开时才有意义。在出货一千台之前就想好轮换，并且只带一张 CA 证书，
而不是一整个浏览器式的信任包——那个包是你并不需要的 RAM 和 flash。

## broker 那一侧：Mosquitto 基础

如果 broker 是默认安装，前面所有设备侧的工作都白搭。Mosquitto 小到可以完整想清楚，
一个锁死的 listener 也就那么几行：

```conf
# /etc/mosquitto/conf.d/site.conf
listener 8883
allow_anonymous false
password_file /etc/mosquitto/passwd
acl_file      /etc/mosquitto/acl

cafile       /etc/mosquitto/certs/ca.crt
certfile     /etc/mosquitto/certs/broker.crt
keyfile      /etc/mosquitto/certs/broker.key
require_certificate true          # enable this only for mTLS

persistence true
persistence_location /var/lib/mosquitto/

# Blast-radius limits: the broker degrades instead of dying
max_connections     500
max_queued_messages 1000          # bounded; beyond this the broker drops
```

ACL 文件才是让"大量设备"变安全的地方：给每个设备 id 写 `fleet/<id>/#` 的权限、读
`fleet/<id>/cmd/#` 的权限，其余一律默认拒绝。然后，用设备会用的那套凭据，从 broker
这一侧测：

```bash
# Subscribe the way a device would, with the same certs and QoS.
mosquitto_sub -h broker.example -p 8883 \
  --cafile ca.crt --cert client.crt --key client.key \
  -t 'fleet/+/availability' -q 1 -v

# A retained availability message arrives instantly for a fresh subscriber.
mosquitto_sub -h broker.example -p 8883 --cafile ca.crt \
  -t 'fleet/sensor-a17/availability' -C 1 -v
```

## 什么才真正装得下

诚实的总结很短。协议本身轻松装下——两字节的头、几字节的连接状态，在 ESP32 上什么
都不是。**esp-mqtt** 客户端也装得下，只要你尊重 TLS 的握手尖峰、别在它之上自己再写
重连。QoS 0 和 QoS 1 覆盖了现实中几乎所有的设备群；QoS 2 是一个你很少需要、却总要
付费的承诺。Retain 和 last will 对运维理智的贡献，比任何投递保证都大。而真正会让你
半夜被叫起来的故障都很无聊：TLS 之前时钟就是错的、flash 上的私钥没有加密、以及上千
台设备整齐划一地重连。

上面这些都跑在*网络之上*，所以底下那张网络同样要紧。如果你的 broker 不是答在一个
公网主机名上，而是答在一张 overlay 上，那同样的约束也会在那里冒头——
[把一颗 ESP32-C3 作为真正的节点放进 overlay](/zh/posts/esp32-easytier-node-in-c/)
就是另一个关于代价的长故事。挑一个小面、把它自动化，并对子集在哪里结束保持诚实。
