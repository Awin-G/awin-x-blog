---
title: "ESP32-C3 + ESP-IDF 入门指南（2026）：从点灯到 Wi-Fi，一小时跑通"
description: "一篇可以直接照做的 ESP-IDF 教程：如何在 Arduino、PlatformIO 与 ESP-IDF 之间做选择，安装工具链、认识工程结构、写一个最小 app_main、点亮 GPIO、用 UART 打日志，最后让 ESP32-C3 以 station 模式连上 Wi-Fi，所有命令均可复制。"
pubDate: 2026-10-17
lang: zh
translationKey: esp32-c3-getting-started
tags: [esp32, embedded, c]
featured: false
keywords:
  - ESP32-C3 入门
  - ESP-IDF 教程
  - ESP32 WiFi
  - idf.py
  - 嵌入式 C
---

**ESP32-C3** 是踏入嵌入式组网最省事的入口之一。它是一颗单核 RISC-V，带 2.4GHz Wi-Fi 和
BLE 5，几百 KB 内存，一块开发板比一顿午饭还便宜。但真正让人卡住的往往不是芯片，而是
"入门"本身——卡在工具链的抉择上。所以这篇 **ESP-IDF 教程**把整条路一次性、按顺序走完：
选框架、装工具链、看懂工程结构、写一个最小的 `app_main`、点亮 GPIO、通过 UART 打日志，
最后让设备以 **station 模式**连上 Wi-Fi。这里用的 API 在近几个 ESP-IDF 版本里都稳定，
每条命令都能直接复制。

先把话说清楚：代码本身大约一小时。如果网速慢，下载工具链可能比这还久，所以先起安装、
边等边读。

## Arduino、PlatformIO 与 ESP-IDF：要有意识地选

三者都能用，只是各自优化的方向不同。选错了，就是很多教程在你碰到真实组网需求时显得
像死胡同的原因。

**Arduino（ESP32 core）**是让硬件最快动起来的方式。你有 `setup()` 和 `loop()`，外加一个
庞大的传感器与屏幕库生态。代价是抽象：Wi-Fi 协议栈、lwIP、FreeRTOS 都藏在便利层之后。
做"读个传感器然后发布出去"很合适；当你要推理事件循环、任务、或者网络栈在高负载下到底
在干什么时，它就是错的选择。

**PlatformIO** 是一套构建系统加依赖管理器，把 Arduino *和* ESP-IDF（以及许多其他框架）
统一在 `platformio.ini` 之后。如果你本来就在 AVR、STM32 和乐鑫的板子之间来回跳，它的一致
性非常值钱。但它毕竟是压在原厂 SDK 之上的一层，一旦构建深处出问题，你其实是在调试那层
包装。

**ESP-IDF** 是乐鑫自己的 SDK：FreeRTOS、`esp_wifi`、`esp_netif`、lwIP、mbedTLS
以及完整的事件系统，中间没有包装。仪式感更重，但没有黑盒。我的经验法则：如果这颗设备的
*工作就是网络*——长时间连接、重连、TLS、自定义协议——那就用裸的 ESP-IDF。最后一类，恰好
就是我在[那篇 ESP32-C3 EasyTier 节点文章](/zh/posts/esp32-easytier-node-in-c/)里做的事，
重点全在于对线协议的精确掌控。下面全部默认使用 ESP-IDF。好消息是：以后想要两者兼得，
完全可以把 Arduino core 作为一个组件加进来。

## 安装 ESP-IDF 与工具链

把 SDK 装在工程目录之外，装一次，并锁定版本。在 Debian 或 Ubuntu 上，官方文档里列出的
系统依赖大致是这样：

```bash
sudo apt-get install git wget flex bison gperf python3 python3-pip \
  python3-venv cmake ninja-build ccache libffi-dev libssl-dev \
  dfu-util libusb-1.0-0

git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
cd ~/esp/esp-idf
./install.sh esp32c3      # 只装这个目标需要的工具
. ./export.sh             # 每个新 shell 都要 source 一次
idf.py --version
```

两点要注意。其一，`-b v5.4` 锁定了发布版本——"最新"是会动的，团队应该共用一个版本。
其二，`export.sh` 是每个 shell 各自生效的；要么每次重新 source，要么写进你的 shell
配置里。安装器最后如果缺了什么工具会打印一条警告，请认真读，别一扫而过。

## `idf.py` 给你的工程结构

让工具先给你搭一个最简工程，好看看形状：

```bash
idf.py create-project hello-c3
cd hello-c3
idf.py set-target esp32c3
```

结构很小，值得记牢：

```text
hello-c3/
├── CMakeLists.txt      # 注册工程，包含 IDF 构建系统
├── main/
│   ├── CMakeLists.txt  # idf_component_register(SRCS ... INCLUDE_DIRS ...)
│   └── hello-c3.c      # 你的 app_main 放在这里
├── sdkconfig           # 每次构建生成的配置
└── build/              # 生成物；别手改也别提交（sdkconfig.defaults 除外）
```

顶层的 `CMakeLists.txt` 设置工程名并包含乐鑫的 `project.cmake`；`main/`（以及之后的
`components/`）下每个目录都是一个组件，各自带一份 `CMakeLists.txt`。要加共享代码时，把
它放进 `components/`，而不是一股脑塞进 `main/`。`sdkconfig` 会被 `idf.py menuconfig`
重新生成；如果你希望某个设置能在干净检出后依然存在，就写进 `sdkconfig.defaults`。

一条命令搞定构建、烧录和看串口日志：

```bash
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

很多 C3 开发板用的是内置的 USB Serial/JTAG，端口是 `/dev/ttyACM0`；带独立 USB-UART
桥的板子通常显示为 `/dev/ttyUSB0`。按 `Ctrl+]` 退出 monitor。烧录失败几乎都是端口
（或该端口的权限）问题，而不是代码问题。

## 最小的 `app_main`——以及你的第一次点灯

ESP-IDF 应用里没有 `main()`。FreeRTOS 先启动，框架再调用 **`app_main`**，签名是
`void app_main(void)`。它一旦返回，这个任务就被拆掉了；多数应用会自己建任务，或者干脆
死循环。下面是一个用稳定的 `driver/gpio.h` API 写的完整点灯：

```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "blink";
#define LED_GPIO GPIO_NUM_8

void app_main(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));

    bool on = false;
    while (true) {
        on = !on;
        gpio_set_level(LED_GPIO, on);
        ESP_LOGI(TAG, "LED %s", on ? "on" : "off");
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
```

这里要立刻养成两个习惯。`ESP_ERROR_CHECK` 会包裹返回 `esp_err_t` 的调用，失败时带着
可读信息中止——比无视返回值好太多。而 `vTaskDelay`（不是忙等）是在 FreeRTOS 里让出
CPU 的方式；`pdMS_TO_TICKS` 把毫秒可移植地换算成 tick。很多 C3 开发板把板载 LED 接在
GPIO 8 上，但请对照你板子的原理图——引脚号是这段代码唯一没法替你猜的东西。

## 用 `ESP_LOGx` 打 UART 日志

在这类小目标上，串口控制台就是你的调试器，所以第一天就用带级别的日志宏：

```c
ESP_LOGI(TAG, "boot count=%d", n);
ESP_LOGW(TAG, "retrying in %d ms", delay);
ESP_LOGE(TAG, "connect failed: %s", esp_err_to_name(err));
```

每一行都会打印级别、时间戳和你的 tag，于是一大堆日志里可以按子系统过滤。运行时还能用
`esp_log_level_set("wifi", ESP_LOG_WARN)` 把吵闹的组件调安静。monitor 默认波特率是
115200，`idf.py monitor` 会自动采用。如果看到乱码，那是波特率或时钟不匹配，不是你
`printf` 的错——另外注意，在 ESP-IDF 里应该用 `ESP_LOGx` 宏而不是裸 `printf`，这样输出
才能和 SDK 自己的消息保持有序。

## 以 station 模式连接 Wi-Fi

这正是裸 ESP-IDF 值回票价的地方。Station（**STA**）模式，指的是让 C3 像手机一样接入
一个已有的热点。流程永远是同一套：初始化 NVS，拉起 `esp_netif` 和默认事件循环，创建 STA
的 netif，初始化 Wi-Fi 驱动，注册事件处理器，设置模式和配置，然后 start。下面是一个
完整而精简的版本：

```c
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "nvs_flash.h"

#define WIFI_SSID     "your-ssid"
#define WIFI_PASSWORD "your-password"

static const char *TAG = "wifi";
static EventGroupHandle_t s_wifi_events;
#define WIFI_CONNECTED_BIT BIT0

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "disconnected, reconnecting");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "got ip: " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_start(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL, NULL));

    wifi_config_t wifi_config = { .sta = { .threshold.authmode = WIFI_AUTH_WPA2_PSK } };
    strncpy((char *)wifi_config.sta.ssid, WIFI_SSID, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, WIFI_PASSWORD,
            sizeof(wifi_config.sta.password) - 1);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

void app_main(void)
{
    s_wifi_events = xEventGroupCreate();
    wifi_start();
    xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE,
                        portMAX_DELAY);
    ESP_LOGI(TAG, "network is up");
}
```

核心认知是：Wi-Fi 是**事件驱动**的，不是一次阻塞调用。驱动先触发
`WIFI_EVENT_STA_START`（此时你调用 `esp_wifi_connect()`），DHCP 把地址交给你后再触发
`IP_EVENT_STA_GOT_IP`；事件组让主任务能等到那一刻。那句重连代码，正是我喜欢这一层的
全部理由：热点重启时你会收到 `WIFI_EVENT_STA_DISCONNECTED`，然后由你决定接下来怎么
办。上线前记得加上退避，否则一个不稳定的热点会把你的设备转飞。

两个实用提醒。换个版本后如果 `nvs_flash_init()` 返回类似"没有空闲页"的错误，擦一次再
初始化即可（`nvs_flash_erase()`），开发阶段这很正常。另外，真机上别把凭据硬编码——
存进 NVS，这样不用重新烧录就能配网。自带的 `wifi/getting_started/station` 示例把 SSID
和密码暴露成 `idf.py menuconfig` 里的选项，不必改源码就能设置；跑一次 `idf.py menuconfig`，
到该示例自己的配置区找找看。顺手也看看它上面那些 *Component config* 下的 Wi-Fi 和
日志输出选项——我这里只描述而不写死具体菜单路径，因为准确路径在不同版本间会挪动。

## 接下来往哪走

到这里你已经拿齐了整个闭环：工具链、工程、`app_main`、GPIO、日志，以及一个断线还能扛
住的 Wi-Fi station。自然的下一步是 OTA 更新（不用插线也能发固件）、把凭据存进 NVS、
用 `esp_timer` 处理定时，以及用 mbedTLS 打通任何要对服务器讲的话。想知道这条组网之路
能走多远，[那篇 ESP32-C3 overlay 节点](/zh/posts/esp32-easytier-node-in-c/)正是在这套
完全相同的栈上自己写了一套完整协议。而如果你的固件要拨向你自己的服务器，先把那一侧加固
好——我的[服务器加固清单](/zh/posts/hardening-a-public-server/)是配套文章。ESP-IDF 确实
比 Arduino 多些仪式，而这仪式正是重点：当网络本身就是产品时，你会希望每一层都看得见。
