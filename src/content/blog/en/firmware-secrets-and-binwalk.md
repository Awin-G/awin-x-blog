---
title: "Firmware analysis with binwalk: extract firmware and hunt hardcoded credentials"
description: "A guided firmware analysis walkthrough for devices you own: where to get a vendor or OTA image, how binwalk recognises squashfs, cramfs, jffs2 and uImage, how to extract firmware with binwalk -e and unsquashfs, and how to hunt hardcoded credentials, private keys and API tokens with strings and grep."
pubDate: 2026-11-11
lang: en
translationKey: firmware-secrets-and-binwalk
tags: [reverse-engineering, security, embedded]
featured: false
keywords:
  - firmware analysis
  - binwalk
  - extract firmware
  - hardcoded credentials
  - squashfs
---

Most people meet **firmware analysis** the day they realise the router on their
desk, the IP camera in the hallway, or the robot vacuum has a web page nobody
audited. The vendor app insists on a cloud account; the update URL is plain HTTP;
the admin password is printed on a sticker. None of that is a vulnerability by
itself, but together they are a reason to look inside. This is a walkthrough of
how I do that with **binwalk**, `strings`, and a file system — on hardware I own,
for the purpose of understanding it and, where it matters, reporting it.

The method is short: get the image, recognise the container, **extract firmware**,
mount it, then hunt. The interesting material is rarely encrypted — it is a
`/etc/shadow` with no hashes, a JSON config with an API token, or an
`RSA PRIVATE KEY` shipped at world-readable permissions. Those are the
**hardcoded credentials** we are looking for, and finding them is usually a
`grep` away.

## Where a firmware image comes from

You cannot analyse what you do not have, so step one is acquiring the image
legitimately. Three sources, in order of least fuss:

1. **The vendor's support page.** Many vendors publish full firmware as a
   `.bin`, `.img`, or a zip. Download the same version your device runs so
   offsets and file paths line up.
2. **The OTA update itself.** If the device checks a known URL, capture the
   request (the same discipline as [reading a packet
   capture](/posts/reading-a-packet-capture/)) and pull the artifact directly.
3. **A filesystem image you are allowed to build.** For open platforms
   (OpenWrt, Buildroot, Yocto) the image is reproducible; download the exact
   build rather than the one on the device if you only need the structure.

Fetching the advertised update is a one-liner when the URL is not a secret:

```bash
# Pull the OTA artifact the device itself would download.
curl -O https://firmware.example.net/device/v2.4.1/image.bin

# Keep a hash so the version you analysed is the version you report.
sha256sum image.bin | tee image.bin.sha256
```

Record the hash. If you later file a report, the vendor needs to know exactly
which build you unpacked.

## Recognising the container before you extract anything

A vendor `.bin` is not a single filesystem. It is usually a small bootloader plus
a kernel plus one or more compressed file systems, stitched together at fixed
offsets. **binwalk** reads the file as raw bytes and matches the magic numbers at
the start of each segment, which is why it can tell you what you are holding
without a datasheet:

```bash
$ binwalk image.bin

DECIMAL       HEXADECIMAL     DESCRIPTION
--------------------------------------------------------------------------------
0             0x0             uImage header, header size: 64 bytes
                              image name: "Linux-2.6.31"
                              load address: 0x80008000
                              created: 2026-03-14
64            0x40            LZMA compressed data
1572864       0x180000        Squashfs filesystem, little endian,
                              version 4.0, size: 6291456 bytes
8519680       0x820000        JFFS2 filesystem, little endian
```

That output is a map. The **uImage** header is a U-Boot kernel wrapper — a magic
`0x27051956`, a load address, and a name. **Squashfs** is the read-only root file
system almost every consumer device uses: compressed, block-based, and cheap to
build. **cramfs** is its older, smaller cousin. **JFFS2** is a writable flash file
system, usually mounted at `/overlay` or `/data`, and it is where a device keeps
the bits it is allowed to change. Recognising which is which tells you where the
juicy config lives: the squashfs has the shipped defaults, the JFFS2 has the
device's runtime state.

## Extracting firmware with binwalk -e

`binwalk` can carve every recognised segment out of the image for you. The `-e`
flag extracts known signatures, `-M` recurses into what it finds, and `-r` removes
carved files it cannot classify:

```bash
# Extract every signature, recursing into nested images.
binwalk -eM image.bin

# Signed images: tell binwalk what wrappers to ignore.
binwalk -e --dd='.*' image.bin

# You get a directory named after the file plus ".extracted".
ls _image.bin.extracted/
# 40  40.lzma  180000.squashfs  820000.jffs2
```

If the automatic pass misses a segment — a non-standard header, an encrypted
blob — you can carve at an offset by hand. Find the magic in a hex dump, then cut
from there:

```bash
# Find the squashfs magic (hsqs) and carve from its offset.
grep -abo $'\x68\x73\x71\x73' image.bin
dd if=image.bin of=rootfs.squashfs bs=1 skip=$((0x180000))
```

## Unpacking and mounting the filesystem

Squashfs does not need `binwalk` to unpack; `unsquashfs` is purpose-built and
keeps ownership and permissions intact, which matters when you are checking for
over-permissive key files:

```bash
# Unpack into ./squashfs-root, preserving perms.
unsquashfs -d squashfs-root 180000.squashfs

# Or mount it read-only if you prefer to browse in place.
sudo mkdir -p /mnt/fw
sudo mount -t squashfs -o loop,ro 180000.squashfs /mnt/fw

# JFFS2 images need an MTD-style mount via a memory block.
sudo modprobe mtdram total_size=131072 erase_size=128
sudo modprobe mtdblock
sudo dd if=820000.jffs2 of=/dev/mtdblock0 bs=1M
sudo mount -t jffs2 /dev/mtdblock0 /mnt/data
```

Two habits: never mount read-write (you are inspecting, not rebuilding), and keep
the unpacked tree so you can diff two firmware versions later.

## Hunting hardcoded credentials with strings

Now the actual hunt. `strings` dumps printable runs from any file, including
binaries and compressed blobs, and a handful of `grep` patterns cover the
recurring offenders. This is the core of the review:

```bash
# Passwords, keys, and tokens sitting in plain sight.
strings -n 8 squashfs-root/bin/* | grep -Ei 'password|passwd|secret|token|apikey|api_key'

# Accounts and shells a device ships with.
cat squashfs-root/etc/passwd
cat squashfs-root/etc/shadow

# Scripts that glue config to hardware are a goldmine for defaults.
grep -RIn --exclude-dir=node_modules \
  -Ei 'password|token|secret|BEGIN .*PRIVATE KEY' squashfs-root/etc/
```

The finds that matter:

- **`/etc/shadow` with real hashes.** A default `root` password reused across a
  whole product line is the classic. A hash is not always cracked, but an empty
  field or a known vendor hash is a finding.
- **Private keys shipped to the device.** Look for `BEGIN RSA PRIVATE KEY` or
  `BEGIN PRIVATE KEY`. A device that has the *same* private key as every other
  unit cannot keep a TLS secret.
- **Config files with API tokens.** Cloud-enabled devices paste a shared token
  into `/etc/config`, JSON blobs, or shell scripts that call home.
- **Update URLs and staging hosts.** A plain-HTTP update URL, or a hostname that
  resolves to an internal staging server, is how a device can be hijacked in
  transit.

## The patterns worth grepping for again and again

Once you have done a few images you stop reading files and start reading shapes.
These four show up constantly, and each is worth an explicit search:

```bash
# 1. TLS material: which units share a key, and what perms does it have?
find squashfs-root -name '*.key' -o -name '*.pem' -o -name '*.crt' | xargs -r ls -l
openssl rsa -in squashfs-root/etc/ssl/private/server.key -check -noout 2>&1

# 2. Hardcoded admin defaults in web UI assets.
grep -RIn -Ei 'admin|root' squashfs-root/www/ | grep -Ei 'default|password'

# 3. Where the device phones home, and over what.
grep -RIn -Ei 'https?://[a-z0-9.-]+' squashfs-root/etc/ squashfs-root/usr/sbin/ \
  | grep -viE 'localhost|127\.0\.0\.1|example\.com'

# 4. Startup scripts that unlock a debug console.
grep -RIn -Ei 'telnetd|dropbear|/bin/sh' squashfs-root/etc/init.d/
```

The `openssl rsa -check` line is the fastest way to confirm a private key is
real and unencrypted. If it prints `RSA key ok` with no passphrase prompt, that
key is doing its job protecting nothing.

## What to do with a finding: report, do not exploit

Two rules keep this work defensible.

First, the **authorised-use boundary**. This applies to hardware you own, or to a
target that is explicitly inside a program's scope — a vendor bug bounty, an
engagement letter, a CTF. Your own devices, your own bench, your own reports.
Pointing `strings` at a neighbour's camera or a company's router you were not
given is not "research", it is unauthorised access, and the commands above are
indistinguishable from an attacker's. Scope is the only thing that separates them.

Second, **responsible disclosure**. When you find a hardcoded key or a default
credential, the useful act is not to demonstrate the impact — it is to tell the
vendor clearly:

- Which build (the hash from step one), which file, which line.
- What the issue enables, in one sentence.
- A minimal reproducer and, if you can, a fix — rotate the key, generate a
  per-device secret at first boot, force HTTPS for updates.
- A private channel and a disclosure deadline you are willing to hold to.

Give them time to rotate the key and ship an update before you write anything
public. The same discipline that applies to [hardening a public
server](/posts/hardening-a-public-server/) applies here from the other side: you
are reducing the number of shared secrets that can be lifted from a device in the
first place. And when the device is a BLE gadget rather than a router, the
skills transfer cleanly — the same patience that powered [reverse-engineering a
BLE device](/posts/reverse-engineering-a-ble-device/) is what keeps you reading a
squashfs tree until the token falls out.

## A short checklist

- Get the image from the vendor page or the OTA URL; record its hash.
- Run `binwalk image.bin` and read the map before extracting.
- `binwalk -eM` to carve; `unsquashfs` to unpack the root filesystem.
- `strings` plus targeted `grep` for passwords, tokens, and private keys.
- Check `/etc/shadow`, `/etc/config`, web assets, and init scripts.
- Confirm key material with `openssl`; note file permissions.
- Report through a private channel with a reproducible build reference.

The point of **firmware analysis** is not to prove you can break in. It is to
know, concretely, what your own devices are carrying — and to turn that knowledge
into a fix instead of a novelty. Extract firmware, read the filesystem, grep for
the secrets nobody meant to ship, and report what you find.
