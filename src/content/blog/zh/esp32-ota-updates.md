---
title: "不依赖厂商云的 ESP32 OTA 升级：ESP-IDF OTA、分区表与回滚"
description: "厂商云是一种负债。本文讲清楚在 ESP32 上自助完成固件升级的完整链路：两个 app 分区加一个 OTA data 分区、esp_ota_* API、签名镜像，以及新固件启动失败时的回滚机制，还有断电、超容、未确认等真实故障模式与串口救砖。"
pubDate: 2026-11-03
lang: zh
translationKey: esp32-ota-updates
tags: [esp32, embedded, devops]
featured: false
keywords:
  - ESP32 OTA 升级
  - ESP-IDF OTA
  - 固件升级
  - 回滚
  - 分区表
  - esp_ota
  - 签名固件
---

迟早会有那么一天，每一批 ESP32 设备都需要在现网做一次**固件升级**，也迟早会
有人提议走捷径：把厂商的云代理烧进去，让他们的控制台推构建。我干过，然后后悔了。
这篇讲的是另一条路——自助搭建的 **ESP32 OTA 升级**，用 **ESP-IDF OTA**、一张带两个
app 槽位的**分区表**，以及一套在新镜像陷入崩溃循环时救命的**回滚**。没有账号，没有
控制台，不回连上报。

这些笔记来自我在[入门指南](/zh/posts/esp32-c3-getting-started/)里搭好的那套
ESP32-C3 环境。机制可以迁移到其他 ESP32 型号，分区大小不能——按你的 flash 来定。

## 为什么厂商云是固件升级的一种负债

云 OTA 服务看着免费，直到它变成承重墙。那一刻成本会一起浮出来。有一个账号，它的
凭据要交给构建服务器，还有一个没人盯的控制台。有**锁定**：代理是一个焊死在升级
链路里的二进制黑盒，想搬走就意味着一次只能在串口上完成的重新烧录。有**隐私**：每台
设备把 MAC、版本、常常还有所在网络，持续上报到别人的服务器，无论你到底有没有发过
一次新构建。还有**离线**：如果设备待在某个上不了外网的现场内网里，或者链路断了，
整条升级通道也跟着断。

这些对我桌上的设备都不是假设。它们待在那种"给我开一条到厂商的出站 HTTPS"根本不是
运维会点头的网络里。一个我自己掌控的、朴素的 HTTPS 端点，一步就把账号、锁定和回连
全都去掉了，而且我可以把它放在设备本来就能连到的同一张网络里。

## ESP-IDF OTA 的零件：两个 app 分区、otadata 与 esp_ota_*

ESP-IDF 更新自己根本不需要云。它需要的是把 flash 布局成让 bootloader 能在两份应用
镜像之间做选择。这就是**分区表**：两个 app 分区（`ota_0` 和 `ota_1`），外加一个很小
的 `otadata` 分区，用来记录当前引导目标落在哪个槽，以及它是否处于待验证状态。一块
4MB 的 ESP32-C3 大致长这样：

```
# ESP32 OTA 升级，4MB flash，两个 app 槽
# Name,     Type, SubType, Offset,   Size,     Flags
nvs,        data, nvs,     0x9000,   0x6000,
otadata,    data, ota,     0xf000,   0x2000,
phy_init,   data, phy,     0x11000,  0x1000,
ota_0,      app,  ota_0,   0x20000,  0x180000,
ota_1,      app,  ota_1,   0x1a0000, 0x180000,
```

两个 app 槽各 0x180000（1.5MB）——装得下一份 Wi-Fi + TLS 的固件，还留了增长空间。
如果你想要一份工厂镜像作最后退路，就再加一个 `factory` app 分区，当两个 OTA 槽都
失败时 bootloader 会回落到它。我保留了双槽版本，因为它更好推理；而 `otadata` 才是
让升级变得原子的东西：写它是个很小、很快的操作，所以 bootloader 要么看到旧目标、
要么看到新目标，永远不会看到写了一半的状态。

这套布局之上才是运行时的 API。`esp_ota_get_running_partition()` 告诉你从哪个槽
启动的，`esp_ota_begin()`/`esp_ota_write()`/`esp_ota_end()` 把新镜像流式写进*另一个*
槽，而 `esp_ota_set_boot_partition()` 让 `otadata` 指向它。`esp_ota_end()` 是那道
闸门：在提交任何东西之前，它先拒掉截断或损坏的镜像。

## ESP32 OTA 升级流程：清单、校验、烧写、重启、确认

我在每台设备上用的流程刻意做得很无聊。设备醒来，从我自己的 HTTPS 端点取一个小 JSON
清单，比版本，然后才去下载二进制。清单带上版本、URL 和一个哈希，这样即便只信 TLS，
我也能在下载不完整时就拒掉它：

```json
{
  "version": "1.4.0",
  "url": "https://ota.example.com/fw/app-1.4.0.bin",
  "sha256": "9f2c1b7a4e0d...e1",
  "min_bootloader": "1.0.0"
}
```

接着它把镜像直接流进那个闲置槽。整个固件不需要一块 RAM 缓冲——`esp_ota_write()`
是边到边取块，所以哪怕芯片 RAM 远小于镜像，1.5MB 也放得下：

```c
#include "esp_ota_ops.h"
#include "esp_http_client.h"

esp_err_t apply_image(const char *url, const esp_partition_t *slot)
{
    esp_ota_handle_t ota;
    ESP_ERROR_CHECK(esp_ota_begin(slot, OTA_SIZE_UNKNOWN, &ota));

    /* 取清单、打开 url，然后边到边喂块： */
    // while ((n = read_http_chunk(buf, sizeof buf)) > 0)
    //     ESP_ERROR_CHECK(esp_ota_write(ota, buf, n));

    ESP_ERROR_CHECK(esp_ota_end(ota));          /* 拒掉损坏的镜像 */
    ESP_ERROR_CHECK(esp_ota_set_boot_partition(slot));  /* 武装 otadata */
    esp_restart();
    return ESP_OK;
}
```

设备重启，跑起新镜像，然后——只有当它的自检通过时——才把这份镜像标记为有效。这个
确认步骤正是最多人跳过的，而跳过它，就是把升级变成砖头的办法。

## 签名固件、HTTPS 与版本管理

HTTPS 是传输层安全；它保护的是飞行中的字节，仅此而已。它完全不代表另一个槽里的
镜像*是你的*。要做到后者，你需要**签名固件**：ESP-IDF 的安全启动/加密 flash 路径会
对 app 镜像签名，bootloader 拒绝执行任何签名验不过的构建。打开一次，之后每一次升级
——不管走云还是自助——都必须带签名。这是我唯一不肯妥协的一环。

相比之下，传什么是旋钮。`esp_https_ota()` 把整套 begin/write/end 包起来，还帮你做
证书校验；当我掌控 CA 时它很好用。在隔离内网里，我也用过朴素 HTTP 端点配固定证书加
签名校验，因为真正起作用的是签名，而不是传输。别让"HTTPS"和"已签名"这两件事糊成
一坨。

版本管理是让它不失控的办法。每份镜像都带着来自 `esp_app_desc.h` 的版本，设备在做任何
决定前先读出自己的：

```c
#include "esp_app_desc.h"
#include "esp_log.h"

const esp_app_desc_t *me = esp_app_get_description();
ESP_LOGI("ota", "running %s v%s", me->project_name, me->version);

/* 只有清单版本比 me->version 更新时才接受它。 */
```

版本字符串必须单调、可比。我用严格的 `major.minor.patch`，并且只接受严格更新的版本，
这样就能挡住设备反复下载并重刷同一个构建的死循环。

## 回滚：当新镜像启动失败时会发生什么

真正要紧的故障是这个：新镜像烧得好好的，一启动就崩——一个坏配置、一次 Wi-Fi 回归、
一个只在开机时才会碰到的空指针。如果这份镜像被提交了，设备就没了，你只能揣着串口线
去现场。**回滚**就是答案，也正是 `otadata` 要记录一个*待验证*状态的原因。

当你调用 `esp_ota_set_boot_partition()` 时，bootloader 会以
`ESP_OTA_IMG_PENDING_VERIFY` 状态引导新槽。它处在观察期。首次启动时，app 必须证明
自己能干活，然后*取消*回滚：

```c
#include "esp_ota_ops.h"
#include "esp_log.h"

static const char *TAG = "ota";

void confirm_or_rollback(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;

    if (esp_ota_get_state_partition(running, &state) != ESP_OK ||
        state != ESP_OTA_IMG_PENDING_VERIFY) {
        return;  /* 已确认镜像的正常启动 */
    }

    if (self_test_passes()) {                    /* 连网、读传感器…… */
        ESP_LOGI(TAG, "自检通过，取消回滚");
        esp_ota_mark_app_valid_cancel_rollback();  /* 留在本镜像 */
    } else {
        ESP_LOGE(TAG, "自检失败，回滚");
        esp_ota_mark_app_invalid_rollback_and_reboot();  /* 退回上一份 */
    }
}
```

如果 app 从没调用 `esp_ota_mark_app_valid_cancel_rollback()`——因为它崩了、卡住了，
或者自检没过——bootloader 就记一次启动失败，切回上一个槽。这就是整张安全网，而它只有
在你*武装*了之后才起作用：一份在 Wi-Fi 真正起来之前就调用确认函数的镜像，什么都没
验证。

## 真正会咬人的故障模式，以及串口救砖

机制很简单；故障不简单。下面是我实际踩过的。

**烧写中途断电。** 这个听起来最吓人，但*只要布局是对的*，它反而最不危险。因为你从不
覆盖正在运行的镜像——你写闲置槽，之后才翻 `otadata`——所以在任何一点被切断，旧的可
用镜像仍然可引导。如果你曾经往正在运行的那个槽里写，你就已经撤掉了这条保证，砖头
由你自己负责。

**镜像超出分区容量。** 当二进制超过槽大小时，`esp_ota_end()` 和构建都会失败；但更
廉价的错误是——某个库变大之后，没人注意到构建已经装不下了。我在 CI 里拿 app 大小去
比分区大小，让超容镜像根本出不了构建服务器。

**回滚没有武装。** 镜像启动、工作正常，但你忘了标记有效——或者无条件地标了有效。
那么下一次故障会重启进同一份坏镜像，或者一份真正有问题的构建被确认下来。确认必须绑
在一个真实的检查上，而且它必须是*唯一*授予有效性的地方。

**bootloader 被搞坏。** 如果 bootloader 本身（或安全启动状态）坏了，OTA 救不了你。
恢复办法我记在笔记里：让板子进下载模式（C3 上是 `BOOT` + 复位，或把 `IO9` 拉低），
再用 `idf.py -flash` / `esptool.py write_flash` 通过串口重烧 bootloader、分区表和工厂
镜像。这很罕见，它正是我拒绝覆盖唯一可用槽的原因，也是我发出去的每块板子都留着串口
焊盘的原因。

## 我会先做什么

在写第一行升级代码之前，先把 flash 布局成两个槽——分区表是所有其他东西都依赖的决定，
事后再改要付一次串口重烧的代价。先让最朴素的 `esp_ota_*` begin/write/end/set-boot
链路跑通，并且亲眼看到设备重启进新镜像。然后才按顺序加清单、签名校验和自检，并且
故意去测每一种故障——烧写中途拔电、发一份自检会失败的构建，确认设备能回到旧的那份。

自助搭端点只是简单的那一半。难而诚实的那一半是回滚路径，而那恰恰是厂商云替你藏起来
的一半。同样的纪律也出现在[ESP32 电源管理](/zh/posts/esp32-power-management/)里：
先决定设备必须扛住什么，再为故障设计，而不是为顺利路径设计。
