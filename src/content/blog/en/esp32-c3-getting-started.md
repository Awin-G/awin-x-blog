---
title: "Getting started with the ESP32-C3 and ESP-IDF in 2026: from blink to Wi-Fi in an hour"
description: "A practical ESP-IDF tutorial for the ESP32-C3: choosing between Arduino, PlatformIO and ESP-IDF, installing the toolchain, the project layout, a minimal app_main, GPIO blink, UART logging and a working Wi-Fi station — with copyable commands."
pubDate: 2026-10-17
lang: en
translationKey: esp32-c3-getting-started
tags: [esp32, embedded, c]
featured: false
keywords:
  - ESP32-C3 getting started
  - ESP-IDF tutorial
  - ESP32 Wi-Fi station
  - idf.py
  - embedded C
---

The **ESP32-C3** is one of the easiest ways to get into embedded networking. It is
a single-core RISC-V chip, 2.4GHz Wi-Fi and BLE 5, a few hundred KB of RAM, and a
devkit costs less than lunch. But the *getting started* part is where most people
stall — not on the chip, on the toolchain decision. So this **ESP-IDF tutorial**
walks the whole path once, in order: pick a framework, install the toolchain,
understand the project layout, write a minimal `app_main`, blink a GPIO, log over
UART, and finally join **Wi-Fi in station mode**. The code is stable across
recent ESP-IDF releases, and every command is copy-pasteable.

Honest scoping: the code takes about an hour. Downloading the toolchain can take
longer than that on a slow link, so start the install first, read while it runs.

## Arduino vs PlatformIO vs ESP-IDF: pick on purpose

All three work. They optimize for different things, and choosing wrong is why so
many tutorials feel like dead ends when you hit real networking work.

**Arduino (the ESP32 core)** is the fastest way to make hardware move. You get
`setup()` and `loop()`, and an enormous library ecosystem for sensors and
displays. The cost is abstraction: the Wi-Fi stack, lwIP and FreeRTOS are behind
a convenience layer. It is great for "read a sensor and publish it", and it is
the wrong tool when you need to reason about event loops, tasks, or what the
network stack is actually doing under load.

**PlatformIO** is a build system and dependency manager that wraps Arduino *and*
ESP-IDF (plus many other frameworks) behind one `platformio.ini`. If you already
jump between AVR, STM32 and Espressif boards, its consistency is worth a lot.
But it is a layer on top of the vendor SDK, and when something breaks deep in the
build you end up debugging the wrapper.

**ESP-IDF** is Espressif's own SDK: FreeRTOS, `esp_wifi`, `esp_netif`, lwIP,
mbedTLS, and the full event system, with no wrapper in between. More ceremony,
but nothing hidden. My rule of thumb: if the device's *job is the network* — a
long-lived connection, retries, TLS, custom protocols — use raw ESP-IDF. That
last category is exactly the kind of work in my
[ESP32-C3 EasyTier node post](/posts/esp32-easytier-node-in-c/), where the whole
point was precise control of the wire. Everything below assumes ESP-IDF. The good
news: you can add the Arduino core as a component later if you want both.

## Installing ESP-IDF and the toolchain

Install the SDK outside your project tree, once, and pin a version. On Debian or
Ubuntu, the documented system packages look like this:

```bash
sudo apt-get install git wget flex bison gperf python3 python3-pip \
  python3-venv cmake ninja-build ccache libffi-dev libssl-dev \
  dfu-util libusb-1.0-0

git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf
cd ~/esp/esp-idf
./install.sh esp32c3      # only the tools this target needs
. ./export.sh             # source this in every new shell
idf.py --version
```

Two things to note. First, `-b v5.4` pins the release — "latest" moves, and a
team should share one. Second, `export.sh` is per-shell; either re-source it or
add it to your shell profile. The installer prints a warning at the end if a tool
it wanted is missing; read it rather than skimming past it.

## The project layout `idf.py` gives you

Let the tool scaffold the first project so you can see the shape:

```bash
idf.py create-project hello-c3
cd hello-c3
idf.py set-target esp32c3
```

The layout is small and worth knowing by heart:

```text
hello-c3/
├── CMakeLists.txt      # registers the project, includes the IDF build system
├── main/
│   ├── CMakeLists.txt  # idf_component_register(SRCS ... INCLUDE_DIRS ...)
│   └── hello-c3.c      # your app_main lives here
├── sdkconfig           # generated per-build configuration
└── build/              # generated; never edit or commit (except sdkconfig.defaults)
```

The top-level `CMakeLists.txt` sets the project name and includes Espressif's
`project.cmake`; every folder under `main/` (and later `components/`) is a
component with its own `CMakeLists.txt`. When you add shared code, drop it in
`components/` rather than piling files into `main/`. `sdkconfig` is regenerated
by `idf.py menuconfig`; if you want a setting to survive a clean checkout, put it
in `sdkconfig.defaults`.

Build, flash and watch the serial log in one command:

```bash
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

`/dev/ttyACM0` is the built-in USB Serial/JTAG on many C3 devkits; a board with a
separate USB-UART bridge usually shows up as `/dev/ttyUSB0`. Exit the monitor
with `Ctrl+]`. If flashing fails, it is almost always the port (or permissions on
it), not the code.

## A minimal `app_main` — and your first blink

There is no `main()` in an ESP-IDF app. FreeRTOS starts, and the framework calls
**`app_main`**, whose signature is `void app_main(void)`. Return from it and the
task is torn down; most apps create their own task or loop forever. Here is a
complete blink using the stable `driver/gpio.h` API:

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

Two habits to pick up here. `ESP_ERROR_CHECK` wraps calls that return `esp_err_t`
and aborts with a readable message on failure — far better than ignoring return
codes. And `vTaskDelay` (not a busy loop) is how you yield the CPU in FreeRTOS;
`pdMS_TO_TICKS` converts milliseconds to ticks portably. On many C3 devkits the
onboard LED is on GPIO 8, but check your board's schematic — the pin number is
the one thing this code cannot guess for you.

## UART logging with `ESP_LOGx`

The serial console is your debugger on a target this small, so use the leveled
logging macros from day one:

```c
ESP_LOGI(TAG, "boot count=%d", n);
ESP_LOGW(TAG, "retrying in %d ms", delay);
ESP_LOGE(TAG, "connect failed: %s", esp_err_to_name(err));
```

Each line prints a level, a timestamp, and your tag, so you can filter a busy log
by subsystem. At runtime you can quiet a noisy component with
`esp_log_level_set("wifi", ESP_LOG_WARN)`. The default monitor baud is 115200;
`idf.py monitor` picks it up automatically. If you see garbage, it is a baud or
clock mismatch, not your `printf` — and note that in ESP-IDF you should use the
`ESP_LOGx` macros rather than bare `printf`, so output stays ordered with the
SDK's own messages.

## Connecting to Wi-Fi in station mode

This is where raw ESP-IDF pays off. Station (**STA**) mode means the C3 joins an
existing access point like a phone would. The flow is always the same: initialise
NVS, bring up `esp_netif` and the default event loop, create the STA netif,
initialise the Wi-Fi driver, register event handlers, set the mode and config,
then start. Here is a complete, minimal version:

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

The important idea is that Wi-Fi is **event-driven**, not a blocking call. The
driver fires `WIFI_EVENT_STA_START` (you call `esp_wifi_connect()`), then
`IP_EVENT_STA_GOT_IP` when DHCP hands you an address; the event group lets the
main task wait for that moment. The reconnect line is the whole reason I like
this layer: when the AP reboots, you get `WIFI_EVENT_STA_DISCONNECTED` and you
decide what happens. Add backoff before you ship it, or a flaky AP will spin.

Two practical notes. If `nvs_flash_init()` returns a "no free pages" style error
after a version change, erase and re-init once (`nvs_flash_erase()`), which is
normal during development. And do not hardcode credentials in a real device —
store them in NVS so you can provision without a reflash. The stock
`wifi/getting_started/station` example exposes SSID and password through
`idf.py menuconfig` so you can set them without editing source; run
`idf.py menuconfig` and look under the example's own configuration section.
While you are in there, the Wi-Fi and log-output options under *Component
config* are worth a look — I describe them rather than name them because the
exact menu paths move between releases.

## Where to go next

You have the whole loop now: toolchain, project, `app_main`, GPIO, logging, and a
Wi-Fi station that survives a disconnect. The natural next steps are OTA updates
so you can ship firmware without a cable, NVS-backed credentials, `esp_timer`
for timing, and TLS through mbedTLS for anything that talks to a server. To see
how far the networking path goes, the [ESP32-C3 overlay node](/posts/esp32-easytier-node-in-c/)
builds a full custom protocol on this exact stack. And if your firmware dials a
server you own, harden that side first — my [server hardening checklist](/posts/hardening-a-public-server/)
is the companion. ESP-IDF is more ceremony than Arduino, and that ceremony is
the point: when the network is the product, you want to see every layer.
