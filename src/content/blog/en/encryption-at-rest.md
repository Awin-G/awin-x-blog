---
title: "Encryption at rest: what LUKS and friends actually protect you from"
description: "A practical, honest look at encryption at rest: the real threat model, what full disk encryption with LUKS covers and does not, why your passphrase is the weak point, TPM/clevis and crypttab unlock, and doing LUKS on a VPS, encrypted ZFS and encrypted backups."
pubDate: 2026-11-22
lang: en
translationKey: encryption-at-rest
tags: [security, linux]
featured: false
keywords:
  - encryption at rest
  - LUKS
  - full disk encryption
  - threat model
  - TPM
---

"Just turn on full disk encryption." It is the most-repeated advice after "use a
password manager", and like that advice it is routinely misunderstood. People encrypt
a laptop and assume they are now safe from a compromised process; ops teams dismiss
encryption at rest because "an attacker on the box can read everything anyway." Both
miss the point. **Encryption at rest** is not a property of a running system; it is a
property of a disk that is *gone*, read by someone who is not you. Here is how to
place **LUKS**, encrypted ZFS and encrypted backups correctly.

<figure>
<svg viewBox="0 0 640 230" width="100%" role="img" aria-label="Left column: threats encryption at rest covers. Right column: threats it does not cover.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.5">
    <rect x="12" y="14" width="290" height="200" rx="10"/>
    <rect x="338" y="14" width="290" height="200" rx="10"/>
    <line x1="12" y1="48" x2="302" y2="48"/>
    <line x1="338" y1="48" x2="628" y2="48"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="157" y="44" text-anchor="middle" font-size="14" font-weight="600">covered by encryption at rest</text>
    <text x="483" y="44" text-anchor="middle" font-size="14" font-weight="600">NOT covered</text>
    <text x="40" y="85">stolen / lost laptop or disk</text>
    <text x="40" y="120">retired or RMA drive</text>
    <text x="40" y="155">cloud disk or snapshot</text>
    <text x="40" y="190">offsite backup blob</text>
    <text x="370" y="85">running, unlocked machine</text>
    <text x="370" y="120">malware reading memory</text>
    <text x="370" y="155">an unencrypted copy</text>
    <text x="370" y="190">a weak passphrase</text>
  </g>
</svg>
<figcaption>Encryption at rest protects data when the medium leaves your control. It does nothing once the machine is booted and mounted as you.</figcaption>
</figure>

## The threat model: who is the attacker, and where are they?

Start with the **threat model**, because everything follows from it. At-rest
encryption targets one boring, extremely common attacker: someone holding your
medium while your machine is *not* running.

- **Stolen or lost hardware.** A laptop on a train, a USB drive, a phone. Encrypted
  and powered off, the thief holds a brick with a login prompt; unencrypted, they
  hold your SSH keys and browser cookies.
- **Decommissioned or RMA'd drives.** Without encryption, "delete" only means "the
  filesystem stopped pointing at those blocks" — the bytes remain for a recovery tool
  when the SSD goes back to the vendor.
- **A cloud provider, or whoever runs the hypervisor.** Your VPS provider can read
  and snapshot your disk image. Encryption will not make them trustworthy, but the
  snapshot they hold is then ciphertext.

At-rest encryption is *not* designed against a live attacker: if the machine is on
and unlocked, the key is in RAM and the filesystem is mounted in the clear.

## LUKS: what full disk encryption actually does

On Linux, **full disk encryption** almost always means LUKS — the Linux Unified Key
Setup. It stores a header with key slots, derives a master key from your passphrase,
and encrypts each block with it (today's sane default is AES-XTS,
`aes-xts-plain64`).

The design detail is indirection: **your passphrase never encrypts the data
directly.** It unlocks a key slot, the slot holds a copy of the master key, and the
master key encrypts the blocks. That is why changing a passphrase is instant, why one
volume can have several keys, and why LUKS is a header format around a plain dm-crypt
device, not a filesystem.

```bash
# Format with an explicit KDF budget (1 GiB KDF memory: expensive per guess)
sudo cryptsetup luksFormat \
  --type luks2 --cipher aes-xts-plain64 --key-size 512 \
  --pbkdf argon2id --pbkdf-memory 1048576 --pbkdf-parallel 4 \
  /dev/nvme0n1p3

sudo cryptsetup open /dev/nvme0n1p3 cryptroot
sudo mkfs.ext4 /dev/mapper/cryptroot

# Back up the header: lose it and the data is gone, leak it and you leak the KDF
sudo cryptsetup luksHeaderBackup /dev/nvme0n1p3 --header-backup-file luks-header.img
```

That header backup is a footgun: no passphrase, but everything needed to brute-force
the master key offline. Treat it like the disk — if it protects a secret, it *is* a
secret, as in my [secrets management](/posts/secrets-management/) post.

## Full disk vs volume vs application-level

- **Full disk encryption (FDE).** The whole device is ciphertext except the boot
  loader, so swap, `/tmp` and stray files are covered. Unlock happens once at boot,
  and everything downstream is trusted — exactly the boundary malware exploits.
- **Volume / filesystem encryption.** Only some datasets are encrypted: a data
  partition, an encrypted ZFS dataset, a LUKS volume for one service. Useful on
  servers, where the OS image is disposable but `/srv` is not, and it lets a headless
  box boot first and unlock data later.
- **Application-level encryption.** The app encrypts fields before they reach disk.
  This is the only layer that survives a *compromised OS*: the data stays ciphertext
  while running, because only the app holds the key. The cost: you cannot `grep` it.

My rule: **FDE or volume encryption for "the disk is gone", application encryption
for "the machine is compromised".** Most people need the first and imagine they have
the second — which is also why [password hashing](/posts/password-hashing/) still
matters on an encrypted disk.

## Key derivation, and why your passphrase is the weak point

LUKS does not weaken AES; it makes each *guess* expensive, and the passphrase decides
the outcome anyway. The header stores a **key derivation function** (KDF) and its
parameters — memory, iterations, parallelism — and an attacker with your header (from
the stolen disk, or the backup above) runs it offline with no rate limit. The entropy
of the passphrase is the whole security margin.

Same arithmetic as [password hashing](/posts/password-hashing/): a KDF can only slow
a guesser down, never rescue a guessable input. A four-word diceware passphrase
(~52 bits) is vastly stronger than the phrase people actually pick. `argon2id` with a
gigabyte of memory makes each guess cost a lot of RAM — the best it can do; it cannot
make "password1" safe.

## Unlock UX: passphrase, TPM/clevis, key files, crypttab

A passphrase at every boot is fine for a laptop and miserable for a fleet.

- **Passphrase at the console.** Maximum control, zero automation. The right default
  for a personal laptop.
- **TPM + clevis.** The TPM seals the key to the machine's state (firmware, Secure
  Boot, PCRs) and `clevis` binds a LUKS slot to it, so the box unlocks itself.
  Convenient, but a TPM is not a safe against someone with physical access and time,
  and a sealed key can enable an evil-maid attack if boot is not verifiable — and with
  no passphrase fallback you have quietly given up passphrase protection entirely. Use
  it *with* measured boot, not instead of it.
- **Key files.** A file on a USB stick or read-only medium that unlocks a volume. On
  a server, key and disk live apart, so both are required to decrypt — stronger than
  TPM.

```bash
# Key file unlock: the file on the stick is the secret, not a typing convenience
sudo dd if=/dev/urandom of=/media/stick/cryptroot.key bs=512 count=8
sudo chmod 400 /media/stick/cryptroot.key
sudo cryptsetup luksAddKey /dev/nvme0n1p3 /media/stick/cryptroot.key
```

Then wire it into boot with **crypttab**, so the initramfs knows which device maps
to which name and how to unlock it:

```bash
# /etc/crypttab — name      source device   keyfile                    options
cryptroot  UUID=9f1c-...   /media/stick/cryptroot.key  luks,discard,keyfile-timeout=10
```

## Encryption at rest on servers: VPS, ZFS, backups

A headless box must boot *and then* unlock, which shapes every server decision.

**LUKS on a VPS** is a common request and a partially leaked one. Your provider
controls the hypervisor and can in principle inspect guest memory, so encryption
protects snapshots and stolen images, not a running guest against the provider. The
usual setup is a small unencrypted `/boot` with root that unlocks over the provider
console (dropbear in initramfs, or KVM) — or the key lives somewhere the host also
has, which is just trusting them again.

On bare metal, **encrypted ZFS datasets** are the cleanest tool I have used:

```bash
# Create an encrypted dataset; keep the key file OFF the pool it protects
sudo zfs create -o encryption=aes-256-gcm -o keyformat=raw \
  -o keylocation=file:///etc/zfs/keys/data.key rpool/data
sudo zfs load-key -a && sudo zfs mount rpool/data   # load the key, then mount
```

If the key sits on the same pool it protects, you have encrypted nothing — keep it
on a USB stick or an encrypted secrets store instead.

**Encrypted backups** have the highest payoff and get skipped the most: a backup
leaves your control by design, so encrypt it at the client before it leaves.

```bash
# restic: client-side encryption, dedup, no key ever sent to the backend
export RESTIC_REPOSITORY=s3:s3.example.com/my-backups
export RESTIC_PASSWORD_FILE=/root/.config/restic/pw   # 0600, off the backed-up tree
restic init && restic backup /srv /etc
```

The test of "encrypted backups" is that the backend operator cannot restore them,
and neither can you without the passphrase. Keep it out of the backup and actually
test a restore — see [backups you can restore](/posts/backups-you-can-restore/).

## What encryption at rest does not protect you from

Once the disk is not at rest, encryption protects nothing:

- **A running, unlocked machine.** Root can read `/dev/mapper/cryptroot` and every
  mounted file. Transparency after unlock is the feature, and the hole.
- **Malware, including in memory.** A process reading live memory can find the master
  key in the kernel keyring or in the app holding a field key.
- **A bad backup.** The strongest encryption does nothing if you `rsync` a mounted,
  decrypted tree to an unencrypted destination.
- **A weak passphrase.** Offline brute force needs only the header off the stolen
  disk, not access to a running system.
- **Side channels and metadata.** Size and timing of your writes leak even when
  contents do not. Encryption is not anonymization.

## The honest conclusion: it is for the disk being gone

Use encryption at rest, and be precise about why. You are defending the case where
the medium leaves your control: the stolen laptop, the RMA drive, the provider's
snapshot, the offsite backup. For that case it is cheap and built into Linux — do it
by default on anything portable and anything that leaves the building.

Do not pretend it defends a box an attacker is sitting on. That is a different
problem — least privilege, patched software, no plaintext env vars, the discipline in
my [secrets management](/posts/secrets-management/) post. At-rest encryption answers
one question: *if this disk disappears tonight, can a stranger read it?* If the answer
is no, it is working. If you wanted it to stop someone already on the box, you have
the wrong tool.
