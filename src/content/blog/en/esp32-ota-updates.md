---
title: "ESP32 OTA update without a vendor cloud: ESP-IDF OTA, partitions, and rollback"
description: "Vendor clouds are a liability. Here is how self-hosted firmware update works on the ESP32: two app partitions plus an OTA data partition, the esp_ota_* APIs, signed images, and rollback when a new build fails to boot."
pubDate: 2026-11-03
lang: en
translationKey: esp32-ota-updates
tags: [esp32, embedded, devops]
featured: false
keywords:
  - ESP32 OTA update
  - ESP-IDF OTA
  - firmware update
  - rollback
  - partition table
  - esp_ota
  - signed firmware
---

Sooner or later every ESP32 fleet needs a **firmware update** in the field, and
sooner or later someone suggests the easy path: flash the vendor's cloud agent
and let their dashboard push builds. I have done that, and I have regretted it.
This post is the other path — an **ESP32 OTA update** you serve yourself, using
**ESP-IDF OTA**, a **partition table** with two app slots, and a **rollback** that
saves you when the new image boots into a crash loop. No account, no dashboard,
no phone-home.

I write this from the same ESP32-C3 setup as my
[getting started guide](/posts/esp32-c3-getting-started/). The mechanics carry to
other ESP32 variants; the partition sizes do not, so size them for your flash.

## Why a vendor cloud is a liability for firmware update

A cloud OTA service looks free until it is load-bearing. Then the costs show up
all at once. There is an account, with credentials your build servers need and a
console nobody watches. There is **lock-in**: the agent is a binary blob wired
into your update path, and moving off it means a reflash you can only do over
serial. There is **privacy**: every device reports its MAC, version and often its
network to someone else's server, forever, whether or not you ever ship a build.
And there is **offline**: if the device lives on a field LAN with no internet, or
your link is down, the whole update channel is down with it.

None of those are hypothetical for the devices on my desk. They sit on networks
where "just allow outbound HTTPS to the vendor" is not something an operator will
agree to. A plain HTTPS endpoint I control removes the account, the lock-in and
the phone-home in one move, and I can host it on the same network the devices
already reach.

## The ESP-IDF OTA pieces: two app partitions, otadata, and esp_ota_*

ESP-IDF does not need a cloud to update itself. It needs flash laid out so that
the bootloader can choose between two application images. That is the **partition
table**: two app partitions (`ota_0` and `ota_1`) plus a small `otadata` partition
that records which slot is the current boot target and whether it is pending
verification. A 4 MB ESP32-C3 layout looks like this:

```
# ESP32 OTA update, 4 MB flash, two app slots
# Name,     Type, SubType, Offset,   Size,     Flags
nvs,        data, nvs,     0x9000,   0x6000,
otadata,    data, ota,     0xf000,   0x2000,
phy_init,   data, phy,     0x11000,  0x1000,
ota_0,      app,  ota_0,   0x20000,  0x180000,
ota_1,      app,  ota_1,   0x1a0000, 0x180000,
```

The two app slots are 0x180000 (1.5 MB) each — big enough for a Wi-Fi + TLS
firmware with room to grow. If you want a factory image as a last resort, add a
`factory` app partition and the bootloader will fall back to it when both OTA
slots fail. I keep the two-slot version because it is simpler to reason about, and
`otadata` is what makes updates atomic: writing it is a small, fast operation, so
the bootloader either sees the old target or the new one, never a half-written
state.

On top of that layout sits the runtime API. `esp_ota_get_running_partition()`
tells you which slot you booted from, `esp_ota_begin()`/`esp_ota_write()`/
`esp_ota_end()` stream a new image into the *other* slot, and
`esp_ota_set_boot_partition()` points `otadata` at it. `esp_ota_end()` is the
gate: it rejects a truncated or corrupt image before anything is committed.

## ESP32 OTA update flow: manifest, verify, flash, reboot, confirm

The flow I use on every device is deliberately boring. The device wakes, fetches
a small JSON manifest from my HTTPS endpoint, compares versions, and only then
downloads the binary. The manifest carries the version, the URL and a hash so I
can reject a partial download without trusting TLS alone:

```json
{
  "version": "1.4.0",
  "url": "https://ota.example.com/fw/app-1.4.0.bin",
  "sha256": "9f2c1b7a4e0d...e1",
  "min_bootloader": "1.0.0"
}
```

Then it streams the image straight into the inactive slot. There is no RAM
buffer of the whole firmware — `esp_ota_write()` takes chunks as they arrive, so
a 1.5 MB image fits comfortably even on a chip with far less RAM:

```c
#include "esp_ota_ops.h"
#include "esp_http_client.h"

esp_err_t apply_image(const char *url, const esp_partition_t *slot)
{
    esp_ota_handle_t ota;
    ESP_ERROR_CHECK(esp_ota_begin(slot, OTA_SIZE_UNKNOWN, &ota));

    /* Fetch the manifest, open url, then feed chunks as they arrive: */
    // while ((n = read_http_chunk(buf, sizeof buf)) > 0)
    //     ESP_ERROR_CHECK(esp_ota_write(ota, buf, n));

    ESP_ERROR_CHECK(esp_ota_end(ota));          /* rejects corrupt images */
    ESP_ERROR_CHECK(esp_ota_set_boot_partition(slot));  /* arm otadata */
    esp_restart();
    return ESP_OK;
}
```

The device reboots, runs the new image, and — only if its self-test passes —
marks it valid. The confirm step is the part people skip, and skipping it is how
firmware updates become bricks.

## Signed firmware, HTTPS, and versioning

HTTPS is transport security; it protects bytes in flight, nothing more. It says
nothing about whether the image in the other slot is *yours*. For that you need
**signed firmware**: ESP-IDF's secure-boot/secure-flash path signs the app image,
and the bootloader refuses to execute a build whose signature does not verify.
Turn it on once and every subsequent update — cloud or self-hosted — has to be
signed. This is the one piece I would not compromise on.

Compared to that, the transport is a knob. `esp_https_ota()` wraps the whole
begin/write/end dance and does certificate validation for you, and it is fine when
I control the CA. On isolated LANs I have also used a plain HTTP endpoint with a
pinned cert and a signature check, because the signature, not the transport, is
what actually matters. Do not let "HTTPS" and "signed" collapse into one idea.

Versioning keeps it sane. Every image carries a version from `esp_app_desc.h`, and
the device reads its own before deciding anything:

```c
#include "esp_app_desc.h"
#include "esp_log.h"

const esp_app_desc_t *me = esp_app_get_description();
ESP_LOGI("ota", "running %s v%s", me->project_name, me->version);

/* Only take the manifest if its version is newer than me->version. */
```

Version strings must be monotonic and comparable. I keep a strict `major.minor.patch`
and refuse anything that is not strictly newer, which stops the loop where a
device downloads and reflashes the same build forever.

## Rollback: what happens when the new image fails to boot

Here is the failure that matters: the new image flashes fine, then crashes on
boot — a bad config, a Wi-Fi regression, a null pointer only hit at startup. If
that image is committed, the device is gone and you are driving to the site with
a serial cable. **Rollback** is the answer, and it is why `otadata` tracks a
*pending* state.

When you call `esp_ota_set_boot_partition()`, the bootloader boots the new slot in
`ESP_OTA_IMG_PENDING_VERIFY` state. It is on probation. On the first boot, the app
must prove it works and then *cancel* the rollback:

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
        return;  /* normal boot of a confirmed image */
    }

    if (self_test_passes()) {                    /* connect, read sensors, ... */
        ESP_LOGI(TAG, "self-test ok, cancelling rollback");
        esp_ota_mark_app_valid_cancel_rollback();  /* stay on this image */
    } else {
        ESP_LOGE(TAG, "self-test failed, rolling back");
        esp_ota_mark_app_invalid_rollback_and_reboot();  /* back to previous */
    }
}
```

If the app never calls `esp_ota_mark_app_valid_cancel_rollback()` — because it
crashed, hung, or failed the self-test — the bootloader counts a failed boot and
switches back to the previous slot. That is the entire safety net, and it only
works if you *arm* it: an image that calls the confirm function before its Wi-Fi
is actually up is testing nothing.

## The failure modes that bite, and bootloader recovery over serial

The mechanics are simple; the failures are not. The ones I have actually hit:

**Power loss mid-flash.** This is the scariest-sounding and the least dangerous
*when the layout is right*. Because you never overwrite the running image — you
write the inactive slot and only then flip `otadata` — a cut at any point leaves
the old, working image bootable. If you ever write to the slot you are running
from, you have removed that guarantee and you own the brick.

**Image too big for the partition.** `esp_ota_end()` and the build both fail when
the binary exceeds the slot, but the cheap mistake is failing to notice the build
no longer fits after a library grew. I check the app size against the partition
size in CI so an oversized image never leaves the build server.

**Rollback not armed.** The image boots, works, but you forgot to mark it
valid — or marked it valid unconditionally. Then the next failure reboots into
the same broken image, or a genuinely bad build gets confirmed. The confirm must
be tied to a real check, and it must be the *only* place validity is granted.

**A bricked bootloader.** If the bootloader itself (or secure-boot state) is
broken, OTA cannot save you. The recovery is the one I keep in my notes: hold the
board in download mode (`BOOT` + reset on a C3, or pull `IO9` low), and reflash
the bootloader, partition table and factory image over serial with `idf.py
-flash` / `esptool.py write_flash`. This is rare, it is why I refuse to overwrite
the only working slot, and it is the reason every board I ship keeps the serial
pads accessible.

## What I would do first

Lay out the flash for two slots before you write a line of update code — the
partition table is the decision that everything else depends on, and changing it
later costs a serial reflash. Get the plain `esp_ota_*` begin/write/end/set-boot
path working over a manual download first, and watch a device reboot into the new
image. Only then add the manifest, the signature check and the self-test, in that
order, testing each failure on purpose — pull power mid-flash, ship a build that
fails its self-test, and confirm the device comes back on the old one.

Self-hosting the endpoint is the easy half. The hard, honest half is the rollback
path, and that is exactly the half a vendor cloud hides from you. The same
discipline shows up in
[ESP32 power management](/posts/esp32-power-management/): decide what the device
must survive, and design for the failure, not the happy path.
