---
title: "VPS hardening: the checklist I actually run on a fresh Linux server"
description: "A copy-paste checklist to secure a Linux server: SSH hardening, a default-deny firewall, fail2ban, unattended security updates, sysctl basics, nginx headers, log rotation and tested backups. Plus what not to do."
pubDate: 2026-10-16
lang: en
translationKey: hardening-a-public-server
tags: [self-hosting, security, devops, systemd]
featured: false
keywords:
  - VPS hardening checklist
  - secure a Linux server
  - SSH hardening
  - ufw fail2ban
  - unattended upgrades
---

The moment a VPS gets a public IP, it starts getting probed. Not in a day, not in
an hour — the first SSH brute-force attempts usually land within minutes of the
box coming up. So **VPS hardening** is not a "someday" task; it is the first
thing I do after provisioning, before I install anything I care about. This is
the actual checklist I run to **secure a Linux server**, in the order I run it,
with every command copy-pasteable.

It is deliberately boring. No exotic daemons, no kernel patches, no security
product. Just the four things that stop the overwhelming majority of real
attacks: no passwords on SSH, a default-deny **firewall**, **fail2ban**, and
automatic security updates — plus the boring operational hygiene most people
skip. If you want the broader "run services well" picture, my
[self-hosting without Docker](/posts/self-hosting-without-docker/) post is the
companion piece; this one is only about locking the door.

## The short version: the checklist

Run this top to bottom on a fresh box. Do not close your current SSH session
until step 4 is verified in a **new** one.

- [ ] **Step 0 — Create a non-root admin user with sudo.**
- [ ] **Step 1 — Install your SSH public key for that user.**
- [ ] **Step 2 — Harden sshd:** key-only, no root login, non-default port, `AllowUsers`.
- [ ] **Step 3 — Verify the new login in a second terminal** before touching the old one.
- [ ] **Step 4 — Turn on a default-deny firewall (ufw)** and allow only what you need.
- [ ] **Step 5 — Add fail2ban** for SSH and any exposed web auth.
- [ ] **Step 6 — Enable unattended security updates.**
- [ ] **Step 7 — Set time, timezone and a few sysctl basics.**
- [ ] **Step 8 — Add nginx/pass-through hardening headers.**
- [ ] **Step 9 — Configure log rotation** so the disk never fills silently.
- [ ] **Step 10 — Set up backups you have actually restored at least once.**

The rest of this post is each step in detail.

## Step 0 — A non-root admin user and sudo

Never work as root interactively. On Debian/Ubuntu the base image often has no
sudo group wired up, so do it explicitly.

```bash
# as root, over the console or your initial session
adduser deploy                       # pick a strong passphrase
usermod -aG sudo deploy              # Debian/Ubuntu
# usermod -aG wheel deploy          # RHEL/Fedora family

# optional: passwordless sudo for a handful of admin commands
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/sbin/ufw' \
  | tee /etc/sudoers.d/deploy-ops
chmod 440 /etc/sudoers.d/deploy-ops
```

The point of a named user is accountability and a smaller blast radius: your
normal shell cannot `rm -rf /` unless you deliberately ask for it.

## Step 1 — Put your SSH key on the box

From your **local** machine, copy the public key over. Do it now, while password
login still works.

```bash
ssh-copy-id -p 22 deploy@203.0.113.10
# verify the key works before you disable passwords
ssh -o PreferredAuthentications=publickey -p 22 deploy@203.0.113.10 'echo ok'
```

If `ssh-copy-id` is unavailable, append manually:

```bash
cat ~/.ssh/id_ed25519.pub | \
  ssh root@203.0.113.10 "install -d -m700 -o deploy -g deploy /home/deploy/.ssh && \
    tee -a /home/deploy/.ssh/authorized_keys && \
    chmod 600 /home/deploy/.ssh/authorized_keys"
```

## Step 2 — SSH hardening

This is the highest-leverage change on the whole list. Open
`/etc/ssh/sshd_config.d/99-hardening.conf` (drop-in files beat editing the big
config) and set:

```ini
Port 49222
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
PermitEmptyPasswords no
AllowUsers deploy
MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
```

A few notes, because defaults lie:

- **Non-default port** only cuts noise, not real attackers. It is worth doing
  because it removes 99% of dumb bot traffic from your logs, but never treat it
  as security on its own. See [what not to do](#what-not-to-do).
- `AllowUsers deploy` means even if root login were misconfigured, only that
  account can authenticate.
- Keep `PermitRootLogin no`, not `prohibit-password`, unless you have a concrete
  reason.

Validate the syntax **before** restarting, or you can lock yourself out:

```bash
sudo sshd -t && sudo systemctl restart ssh
```

On Debian the unit is `ssh`; on RHEL it is `sshd`. Check your distribution.

## Step 3 — Verify the new login *before* you close the old one

This is the step people skip, and it is the one that turns a hardening session
into a lost server. Open a **second** terminal and test both the port and the
key path:

```bash
ssh -p 49222 deploy@203.0.113.10 'whoami && hostname'
# expect: deploy / your hostname
```

Only after that command succeeds do you close the original session. If it fails,
you still have the working one open to fix the config.

## Step 4 — The firewall: default deny, explicit allow

I use `ufw` because it is legible and correct by default. The rule that matters
is **deny incoming, allow outgoing**, then poke holes for exactly what you serve.

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 49222/tcp comment 'ssh'
sudo ufw allow 80/tcp  comment 'http'
sudo ufw allow 443/tcp comment 'https'
sudo ufw enable
sudo ufw status verbose
```

If you use **Docker**, know this now: publishing a container port writes its own
iptables rules that can bypass ufw. Either bind ports to `127.0.0.1` in your
compose file and reverse-proxy them, or accept that ufw is not the whole story.
My [nginx front-door setup](/posts/self-hosting-without-docker/) keeps service
ports on loopback for exactly this reason.

## Step 5 — fail2ban

The firewall says *which* ports are reachable. `fail2ban` watches the logs and
bans the IPs that keep guessing. Together they are the difference between
"reachable" and "annoying to attack".

```bash
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.local >/dev/null <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = 49222
EOF
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

Add jails for anything with a login form — nginx basic-auth, WordPress, Nextcloud
— so a single service cannot be brute-forced at leisure.

## Step 6 — Unattended security updates

Most real-world compromises are a known CVE on a package nobody patched. Automate
the boring part; security patches apply on their own, but I never let it restart
things under me during the day.

```bash
sudo apt install -y unattended-upgrades
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Debian/Ubuntu: only security origins, no surprise reboots
sudo tee /etc/apt/apt.conf.d/51myunattended-upgrades >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
sudo unattended-upgrade --dry-run -d | tail -n 5
```

If you run kernel updates, reboot on your own schedule and watch
`/var/run/reboot-required`.

## Step 7 — Time, timezone and sysctl basics

Boring, but wrong time breaks TLS, logs and backups. Set it once.

```bash
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true
timedatectl status
```

A handful of sysctl knobs worth having (put them in
`/etc/sysctl.d/99-hardening.conf`):

```ini
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.tcp_syncookies = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.dmesg_restrict = 1
```

```bash
sudo sysctl --system
```

## Step 8 — nginx / pass-through hardening headers

If nginx is your front door, add a small header block to every server. These do
not replace app security, but they cut a whole class of browser-side problems —
and if you terminate a proxy in front, pass them through consistently.

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# never leak the version
server_tokens off;
```

Test before reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://example.com | grep -Ei 'strict-transport|x-frame|x-content'
```

## Step 9 — Log rotation

Unrotated logs are the most common way a healthy box fills its disk in six
months. `logrotate` usually exists; the fix is to actually cap what you generate.

```ini
# /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

```bash
sudo logrotate -d /etc/logrotate.d/myapp   # dry run
sudo journalctl --disk-usage
# cap the journal too
sudo sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

## Step 10 — Backups (and a tested restore)

A hardened server you cannot recover is still a failed server. Backups are the
step that makes every other step survivable.

```bash
# a minimal, honest example: encrypted, offsite, versioned
tar -C / -czf - etc/opt/services 2>/dev/null \
  | age -r "$RECIPIENT" \
  | rclone rcat backup-remote:host1/$(date +%F).tar.gz.age

# verify the archive is readable before trusting it
rclone cat backup-remote:host1/$(date +%F).tar.gz.age | age -d -i key.txt | tar -tz | head
```

Whatever tool you pick — restic, borg, plain tar — the rule is the same: it
lands somewhere that is **not this machine**, and you have restored it at least
once. See how the blog's own
[build-and-deploy pipeline](/posts/how-this-blog-ships-itself/) treats
reproducibility; backups deserve the same seriousness.

## What NOT to do

- **Obscurity only.** Changing the SSH port and calling it done is not
  hardening. Attackers scan all ports; you have only hidden from the lazy ones.
- **Skipping backups** because "it's just a small box". Small boxes hold the
  only copy of things all the time.
- **Closing the old SSH session before testing the new one.** The single most
  common way to brick remote access. New terminal, verify, *then* close.
- **Turning on the firewall before allowing your SSH port.** Same story. Allow
  first, enable second.
- **Ignoring `ufw`-bypassing Docker port publishing.** A published container port
  can be world-reachable regardless of your firewall rules.
- **Auto-rebooting during the day.** Patch automatically; reboot deliberately.

## Restore and rollback

Hardening is reversible if you do it in small, verified steps. Keep the escape
hatches open:

- **Keep one working session** (or provider console/VNC access) until the new
  config is proven. That is your rollback.
- **Back up configs before editing** — `sudo cp /etc/ssh/sshd_config.d/99-hardening.conf{,.bak}`.
- **Have a serial console.** Every serious provider offers one; confirm it works
  *before* you need it.
- **Make rollback cheap:** if a step locks you out, the fix should be "restore
  one file and restart one service", not "reinstall the OS".

Do it once, script it, and every future box takes twenty minutes instead of an
anxious evening.

## Frequently asked questions

**Do I really need a non-default SSH port?** No, but it cuts log noise
dramatically. Key-only auth is the actual protection; the port is a convenience.

**ufw or nftables directly?** Start with ufw for clarity. Drop to nftables when
you need sets, rate limits or NAT that ufw cannot express cleanly.

**Is fail2ban still worth it with key-only SSH?** Yes. It still bans
misbehaving scanners and protects any web login you expose, which is usually the
weaker surface.

**How often should I check for reboot-required?** After every unattended upgrade
run. A weekly glance at `/var/run/reboot-required` is enough for a small box.
