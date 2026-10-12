---
title: "What actually happens when Linux boots: firmware, initramfs, and systemd targets"
description: "A ground-up walkthrough of the Linux boot process on a real Arch Linux laptop: UEFI firmware and the ESP, GRUB, kernel and initramfs, systemd as PID 1, the sysinit → basic → multi-user → graphical target chain, systemd-analyze timing, and a debugging playbook for slow or failed boots."
pubDate: 2027-01-01
lang: en
translationKey: linux-boot-process
tags: [linux, systemd]
featured: false
keywords:
  - Linux boot process
  - systemd targets
  - initramfs
  - systemd-analyze
  - GRUB
  - UEFI
  - PID 1
---

I have read more boot logs than I care to admit. Not out of fondness, but because
every machine I own eventually refuses to start, and the answer is almost always
hiding in the first fifteen seconds of its life. This is my walkthrough of the
**Linux boot process** — firmware to login prompt — built on outputs from the
machine I am typing on right now: an Arch Linux laptop called `BOOK`, kernel
`7.2.9-arch1-1`, systemd 262, LUKS-encrypted root. Everything below that is
quoted in a code block was copy-pasted from that host; where a command needed
root or a capability I do not have, I say so instead of inventing the output. We
will also cover the **initramfs**, the chain of **systemd targets**, and how to
read the timing with `systemd-analyze`.

<figure>
<svg viewBox="0 0 640 205" width="100%" role="img" aria-label="The Linux boot process in five stages: UEFI firmware hands over to GRUB, GRUB loads the kernel and initramfs, the initramfs unlocks LUKS and mounts the real root, systemd runs as PID 1 and walks the target chain to graphical.target, and the login prompt appears. Measured on this host: 4.3 seconds in firmware, 1.4 in the loader, 0.9 in the kernel, 4.7 in the initrd, 3.8 in userspace, 15.1 seconds total.">
  <defs>
    <marker id="boot-ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="#0f766e" stroke-width="1.5" fill="none">
    <rect x="8" y="34" width="112" height="54" rx="9"/>
    <rect x="136" y="34" width="112" height="54" rx="9"/>
    <rect x="264" y="34" width="112" height="54" rx="9"/>
    <rect x="392" y="34" width="112" height="54" rx="9"/>
    <rect x="520" y="34" width="112" height="54" rx="9"/>
    <path d="M122 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M250 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M378 61 h12" marker-end="url(#boot-ar)"/>
    <path d="M506 61 h12" marker-end="url(#boot-ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5" text-anchor="middle">
    <text x="320" y="18" opacity="0.85">the Linux boot process, end to end</text>
    <text x="64" y="26" opacity="0.6" font-size="11">1</text>
    <text x="192" y="26" opacity="0.6" font-size="11">2</text>
    <text x="320" y="26" opacity="0.6" font-size="11">3</text>
    <text x="448" y="26" opacity="0.6" font-size="11">4</text>
    <text x="576" y="26" opacity="0.6" font-size="11">5</text>
    <text x="64" y="57">UEFI firmware</text>
    <text x="64" y="76" opacity="0.75" font-size="11.5">ESP, boot entry</text>
    <text x="192" y="57">GRUB</text>
    <text x="192" y="76" opacity="0.75" font-size="11.5">kernel + initrd</text>
    <text x="320" y="57">kernel + initramfs</text>
    <text x="320" y="76" opacity="0.75" font-size="11.5">unlock LUKS, mount /</text>
    <text x="448" y="57">systemd, PID 1</text>
    <text x="448" y="76" opacity="0.75" font-size="11.5">targets → graphical</text>
    <text x="576" y="57">login</text>
    <text x="576" y="76" opacity="0.75" font-size="11.5">getty / display mgr</text>
    <text x="64" y="108" opacity="0.85" font-size="11">4.3 s</text>
    <text x="192" y="108" opacity="0.85" font-size="11">1.4 s</text>
    <text x="320" y="108" opacity="0.85" font-size="11">0.9 s + 4.7 s</text>
    <text x="448" y="108" opacity="0.85" font-size="11">3.8 s</text>
    <text x="576" y="108" opacity="0.85" font-size="11">~0 s</text>
    <text x="320" y="140" opacity="0.75" font-size="11">Arch Linux, kernel 7.2.9-arch1-1, systemd 262</text>
    <text x="320" y="160" opacity="0.75" font-size="11">4.317s firmware + 1.405s loader + 883ms kernel + 4.683s initrd + 3.785s userspace = 15.076s</text>
  </g>
</svg>
<figcaption>Five stages, one machine, real measurements: `systemd-analyze time` on `BOOK` totals 15.076 seconds from firmware to `graphical.target`.</figcaption>
</figure>

## Stage 1: UEFI firmware finds the ESP

Before any Linux code runs, the firmware runs. This host boots through UEFI, and
I can prove that instead of assuming it — `/sys/firmware/efi` only exists when
the kernel was started by EFI:

```
$ ls -ld /sys/firmware/efi
drwxr-xr-x 5 root root 0 10月12日 04:12 /sys/firmware/efi
```

(The host locale is Chinese, hence the date format in verbatim output.)

UEFI keeps its boot entries in NVRAM, and `efibootmgr` is readable as an
unprivileged user on this machine:

```
$ efibootmgr
BootCurrent: 0000
Timeout: 0 seconds
BootOrder: 0000,0001,0002,0003
Boot0000* GRUB	HD(1,GPT,00981c32-ada8-46ca-99e6-1d9bab3c5f72,0x800,0x100000)/\EFI\GRUB\grubx64.efi
Boot0001* UEFI:CD/DVD Drive	BBS(129,,0x0)
Boot0002* UEFI:Removable Device	BBS(130,,0x0)
Boot0003* UEFI:Network Device	BBS(131,,0x0)
```

`BootCurrent: 0000` says this boot used the `GRUB` entry: partition 1 of a GPT
disk (`sdb`), which is the EFI system partition, running `\EFI\GRUB\grubx64.efi`.
`Timeout: 0` means the firmware hands over instantly — no menu, no keypress
window. That is a convenience while things work and a small trap while they do
not: with a zero timeout you cannot pick the fallback entry at firmware time, so
bootloader-level recovery means editing GRUB's own menu instead.

## Stage 2: GRUB loads the kernel and the initramfs

The ESP is mounted at `/boot` here — a FAT32 partition — which is why
`lsblk -f` shows it so plainly and why the kernel and initramfs live inside it:

```
$ lsblk -f
NAME          FSTYPE      FSVER LABEL       UUID                                 FSAVAIL FSUSE% MOUNTPOINTS
sda
└─sda1        crypto_LUKS 2     data-crypt  5051dd9f-ee0c-4a55-a369-19b22308d97d
  └─data      ext4        1.0   coldbackup  324279fc-b511-464e-a3fb-03f8dc68cbac  278.7G     5% /data
sdb
├─sdb1        vfat        FAT32             5B41-70E4                             368.8M    28% /boot
└─sdb2        crypto_LUKS 2                 f872976e-53b5-4a38-8953-995ce2bc6153
  └─cryptroot ext4        1.0               14d09c9a-b9e2-4988-8099-129f919e67e7      75G    63% /
sdc
└─sdc1        vfat        FAT32 BIOS        8019-1093
zram0         swap        1     zram0       6c1f9c74-50c2-4050-96b2-21218de9e48e                [SWAP]
```

Three layers of storage to keep straight: the ESP (`5B41-70E4`, `/boot`), the
encrypted root container (`f872976e…`, LUKS on `sdb2`), and the ext4 filesystem
inside it (`14d09c9a…`, `/`). The GRUB menu entry that booted this machine is
mercifully boring — which is exactly what you want from a bootloader:

```
$ grep -nE '^\s*(linux|initrd)\s' /boot/grub/grub.cfg
	linux	/vmlinuz-linux root=UUID=14d09c9a-b9e2-4988-8099-129f919e67e7 rw root=/dev/mapper/cryptroot loglevel=3 quiet rd.systemd.show_status=auto memmap=1M$0x2F000000 ramoops.mem_address=0x2F000000 ramoops.mem_size=0x100000 ramoops.record_size=0x40000 ramoops.console_size=0x40000
	initrd	/intel-ucode.img /initramfs-linux.img
```

Two details worth internalizing. First, CPU microcode is loaded **before** the
kernel — errata fixes for the CPU have to land before the kernel starts using
the CPU, so `intel-ucode.img` precedes `initramfs-linux.img` on the `initrd`
line. Second, `grub.cfg` on disk is only what the *next* boot will get. The
`memmap`/`ramoops` parameters in that line do not appear in the last boot's
actual `/proc/cmdline`, which means the config was regenerated after the last
reboot. The kernel's own record is the source of truth, and that record is
readable at runtime:

```
$ cat /proc/cmdline
BOOT_IMAGE=/vmlinuz-linux root=UUID=14d09c9a-b9e2-4988-8099-129f919e67e7 rw root=/dev/mapper/cryptroot loglevel=3 quiet rd.systemd.show_status=auto
```

Note that `root=` appears **twice**. The kernel honors the *last* `root=` on the
command line, so the real root is `/dev/mapper/cryptroot` — a device-mapper name
that does not exist yet at this point. The first `root=UUID=…` names the ext4
filesystem inside the container; that is the convention the `sd-encrypt`
initramfs hook reads. Parameters starting with `rd.` ("ramdisk") are addressed
to the initramfs, not to the kernel itself.

## Stage 3: the initramfs unlocks the disk and mounts the real root

The kernel is deliberately small — it cannot ship every storage controller and
crypto driver in existence. So the bootloader hands it a second archive, the
**initramfs**, which the kernel unpacks into a temporary rootfs and executes as
PID 1 until the real root is ready. On this host it is 27 MB, alongside a 73 MB
fallback image:

```
$ ls -l /boot
总计 129468
-rwxr-xr-x 1 root root 73013318 10月12日 05:25 initramfs-linux-fallback.img
-rwxr-xr-x 1 root root 27033876 10月12日 05:24 initramfs-linux.img
-rwxr-xr-x 1 root root  15265792  9月26日 06:53 intel-ucode.img
-rwxr-xr-x 1 root root  17238584 10月10日 17:20 vmlinuz-linux
```

On Arch that image is assembled by mkinitcpio, and its hook list is the entire
job description of this stage:

```
$ grep -n '^HOOKS' /etc/mkinitcpio.conf
HOOKS=(base systemd autodetect microcode modconf kms keyboard keymap sd-vconsole block sd-encrypt filesystems fsck)
```

Read the hooks in order as a to-do list: set up a minimal systemd, autodetect
the modules this machine actually needs, apply microcode, bring up the
keyboard and KMS so the disk-unlock prompt is usable, assemble block devices,
run `sd-encrypt` to unlock the LUKS container on `sdb2`, mount the real root,
fsck it. `/etc/crypttab` is what tells `sd-encrypt` which container maps to
which name — it is mode `000` on this host, so I could not read it, but the
LUKS UUID `f872976e…` from `lsblk -f` above is the one it matches. When `/init`
finishes, the kernel is told to `switch_root`: the initramfs is discarded and
the real `/` takes over. If that handover fails, the boot has already failed —
and you are dropped into the initramfs's emergency shell, not systemd's.

Where this stage bites: `autodetect` records the modules the *currently running*
kernel needs. Upgrade the kernel without regenerating the image and the next
boot can produce an initramfs that cannot see its own disk. That is precisely
what the fallback image beside it is for — it ships a broad set of modules
instead of a tuned one.

## Stage 4: systemd becomes PID 1

After `switch_root`, the userspace init takes over. On this box that is systemd,
and the kernel confirms it directly:

```
$ head -12 /proc/1/status
Name:	systemd
State:	S (sleeping)
Tgid:	1
Pid:	1
PPid:	0
```

(`/proc/1/exe` does point at `/usr/lib/systemd/systemd`, but the symlink is only
readable by root on this host — permission denied for me, as expected for
another user's process.)

PID 1's job is not "run scripts top to bottom" — that was SysV. systemd reads
unit files (`.service`, `.socket`, `.mount`, `.target`, …), resolves them as a
dependency graph, starts independent units **in parallel**, and supervises
them. Generators synthesize units at boot from `/etc/fstab`, `/etc/crypttab`
and the kernel command line, which is why an `fstab` line quietly turns into a
`.mount` unit and a `crypttab` line into a `systemd-cryptsetup@…` service.

## systemd targets: how units are ordered into a boot

**systemd targets** are synchronization points, not scripted runlevels. Each one
groups units that share a readiness milestone, and `After=`/`Requires=` edges
between units define the ordering. The default target on this desktop is:

```
$ systemctl get-default
graphical.target
```

The canonical chain is `sysinit.target` → `basic.target` → `multi-user.target`
→ `graphical.target`, and every target on the running machine is visible at
once:

```
$ systemctl list-units --type=target
  UNIT                   LOAD   ACTIVE SUB    DESCRIPTION
  basic.target           loaded active active Basic System
  cryptsetup.target      loaded active active Local Encrypted Volumes
  getty.target           loaded active active Login Prompts
  graphical.target       loaded active active Graphical Interface
  local-fs.target       loaded active active Local File Systems
  multi-user.target      loaded active active Multi-User System
  network.target        loaded active active Network
  network-online.target loaded active active Network is Online
  sockets.target        loaded active active Sockets
  sysinit.target        loaded active active System Initialization
  slices.target         loaded active active Slices
```

A server typically defaults to `multi-user.target`; a desktop continues to
`graphical.target`, which adds the display manager. This host runs KDE
Plasma's `plasmalogin.service`, and `systemd-analyze critical-chain` shows the
whole critical path from the default target back to `sysinit.target`:

```
$ systemd-analyze critical-chain
graphical.target @3.785s
└─plasmalogin.service @3.739s
  └─plymouth-quit.service @3.704s +32ms
    └─systemd-user-sessions.service @3.685s +15ms
      └─network.target @3.661s
        └─NetworkManager.service @3.243s +417ms
          └─basic.target @3.242s
            └─dbus-broker.service @3.204s +37ms
              └─dbus.socket @3.196s +49us
                └─sysinit.target @3.195s
                  └─systemd-update-done.service @3.176s +18ms
                    └─ldconfig.service @2.899s +276ms
                      └─systemd-tmpfiles-setup.service @2.493s +404ms
                        └─local-fs.target @2.487s
                          └─boot.mount @2.326s +159ms
                            └─systemd-fsck@dev-disk-by\x2duuid-5B41\x2d70E4.service @1.956s +63ms
                              └─dev-disk-by\x2duuid-5B41\x2d70E4.device
```

Read it bottom-up: the ESP appears as a device, gets fscked, gets mounted at
`/boot`, `local-fs.target` is reached, tmpfiles and ldconfig run, `sysinit`
completes, sockets and D-Bus bring up `basic.target`, then networking, sessions
and the login manager carry it to `graphical.target`. The `@` is when a unit
became active, the `+` how long it took to start. Everything between
`basic.target` at 3.242s and `graphical.target` at 3.785s cost about half a
second.

## How long did that take? systemd-analyze

`systemd-analyze` is the first tool to reach for, and it has three modes that
answer three different questions. `time` splits the boot into phases — this is
the measurement the diagram at the top is drawn from:

```
$ systemd-analyze time
Startup finished in 4.317s (firmware) + 1.405s (loader) + 883ms (kernel) + 4.683s (initrd) + 3.785s (userspace) = 15.076s
graphical.target reached after 3.785s in userspace.
```

Firmware plus loader dominates here — a slow UEFI implementation with a zero
timeout is worth more attention than any service. `blame` attributes userspace
time:

```
$ systemd-analyze blame | head -5
6.406s systemd-fsck@dev-mapper-data.service
5.856s dev-tpm0.device
5.856s sys-devices-platform-MSFT0101:00-tpm-tpm0.device
5.809s dev-disk-by\x2dpath-pci\x2d0000:00:17.0\x2data\x2d3.0\x2dpart-by\x2duuid-5B41\x2d70E4.device
5.809s dev-disk-by\x2ddiskseq-2\x2dpart1.device
```

Two cautions, both visible on this host. A `.device` unit "taking" 5.8s almost
never means the disk was slow — it means something *waited* for that disk to
appear; blame charges the wait to the device. And `systemd-fsck@dev-mapper-data`
burning 6.4s is not on the critical path at all: `/data` is mounted with
`nofail` and `x-systemd.automount` in `/etc/fstab`, so its fsck runs lazily in
the background. `blame` measures where seconds were spent, not where the boot
was blocked — `critical-chain` is the tool for that.

## Where the Linux boot process breaks

**The initramfs cannot see the root disk.** A missing storage or crypto module —
usually after a kernel upgrade with a stale image — ends in a shell that says it
cannot find the root filesystem, or a `sd-encrypt` prompt that never gets a
device. Boot the fallback image from the GRUB menu, then regenerate: on Arch,
`mkinitcpio -P`.

**Wrong `root=`.** Symptom is a kernel panic or an emergency shell with "No
root filesystem found", often after disk surgery changed a UUID. Verify against
`lsblk -f`, fix `/etc/default/grub`, and rebuild `grub.cfg`. Never hand-write a
`/dev/sdX` root — those names move; UUIDs and `/dev/mapper/` names do not.

**A mount fails.** A bad `fstab` line drops the boot into `emergency.target`
with `systemctl --failed` pointing at the offender. The `/data` entry on this
host shows the defensive pattern: `nofail` plus `x-systemd.automount` plus an
explicit `x-systemd.device-timeout=15s` — a backup volume may be absent without
keeping the machine from booting.

**A unit hangs.** The boot stops on "A start job is running…" and eventually
times out (the documented default `DefaultTimeoutStartSec` is 90s). Append
`systemd.unit=emergency.target` to the kernel cmdline for a rescue shell, then
`systemctl list-jobs` to see what it was waiting on, and `systemctl mask` the
unit you can live without.

## A debugging playbook for a slow or failing boot

In order, every time:

1. `systemd-analyze time` — which phase owns the seconds.
2. `systemd-analyze blame | head -20` — who spent them (discount `.device`
   units; they are waits, not work).
3. `systemd-analyze critical-chain graphical.target` — the actual critical path.
4. `systemctl --failed` and `journalctl -b -p err` — what failed this boot.
5. `journalctl -b -k` for kernel messages. On this host plain `dmesg` is
   blocked — it fails with "读取内核缓冲区失败: 不允许的操作", because unprivileged
   reads of the kernel ring buffer are restricted — but `journalctl -b -k`
   works fine as a normal user, so that is what I use.
6. When it will not boot at all: remove `quiet` (or set `loglevel=7`) on the
   kernel command line to see the messages instead of a splash screen, boot the
   fallback initramfs, and use `systemd.unit=emergency.target` to get a shell.

That is the whole lifecycle: firmware finds the ESP, the bootloader loads a
kernel and an initramfs, the initramfs unlocks and mounts the real root, systemd
takes over as PID 1, and the target chain walks the machine from `sysinit` to
`graphical` until a login prompt appears. Nothing mystical — just five stages
that each fail in their own characteristic way, and a surprising number of tools
that will tell you exactly which one did.

If you want to go deeper on the userspace half: the
[systemd unit cookbook](/posts/systemd-unit-cookbook/) covers the unit syntax
behind everything above, and [systemd timers vs cron](/posts/systemd-timers-vs-cron/)
is where I go the moment a box boots reliably and starts running things on a
schedule.
