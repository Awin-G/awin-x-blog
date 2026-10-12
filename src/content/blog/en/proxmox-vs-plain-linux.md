---
title: "Proxmox vs plain Linux for a homelab: honesty over hype"
description: "Proxmox vs plain Linux is not a holy war. Here is what a homelab hypervisor actually buys you, what it costs in patching, RAM and backup work, when each option wins, and the pragmatic middle path with systemd-nspawn, podman and real backups."
pubDate: 2026-11-04
lang: en
translationKey: proxmox-vs-plain-linux
tags: [self-hosting, homelab, devops]
featured: false
keywords:
  - Proxmox vs plain Linux
  - homelab hypervisor
  - systemd-nspawn
  - virtualization
  - LXC
---

Every few months someone asks me whether they should run Proxmox or just install Linux and be done with it. The question is usually framed as **Proxmox vs plain Linux**, and the answers online are framed as a religious war. I think that is the wrong frame. A **homelab hypervisor** is a tool with a specific shape: it trades a layer of complexity for snapshotting, lifecycle management and isolation. Whether that trade is good depends entirely on what you are running, not on which camp you joined.

I have run both. I have run a Proxmox box with a dozen guests, and I have run the same workloads as plain systemd services on one host. Both worked. Neither was magic. This is the honest version, without **virtualization** as an identity.

## What a homelab hypervisor actually buys you

Let us start by giving Proxmox its due, because the benefits are real and people who dismiss them are usually optimizing for the wrong thing.

- **Snapshots.** This is the headline feature. Before a risky upgrade you snapshot the guest, break it, and roll back in seconds. On plain Linux you can do this too, but you have to decide the storage layout up front (ZFS or LVM-thin) and you own the rollback procedure. Proxmox gives you a button and, more importantly, a habit.
- **Easy VM and container lifecycle.** Creating a VM or an LXC container is a few clicks. Cloning a template, setting resources, assigning a network bridge — all in one place. On plain Linux you assemble that from `qemu-system`, `systemd-nspawn`, `debootstrap`, and your own scripts. More transparent, more typing.
- **Isolation.** Each guest gets its own kernel (VMs) or its own namespace-isolated userspace (containers). One compromised service does not trivially reach another. On a single plain host, a bad service runs next to your data with whatever privileges you gave it.
- **One UI.** The web interface is genuinely useful for the boring parts: console access when SSH is dead, a rough resource graph, a backup schedule list, a place to click "start" at 11pm. You can reach all of this on plain Linux with SSH and systemd, but not all in one pane.

The collection of these things is what a hypervisor is *for*. If you value that collection, it earns its keep.

## What plain Linux + systemd + containers gives you

The other side is not "nothing." It is a different set of goods:

- **Simplicity.** No abstraction layer between you and the machine. `systemctl status`, `journalctl -u`, `ss -ltnp`, and you know everything. There is no cluster filesystem quirk, no guest agent to install, no "why is the web UI showing the wrong disk."
- **No extra layer.** Every guest consumes CPU and RAM for its own userspace. On a small homelab box, that overhead is a meaningful fraction of the budget. Plain Linux has exactly one kernel.
- **Direct access.** Mounting storage, changing kernel parameters, dropping a debug binary into place, `tcpdump` on the physical interface — all immediate. With a hypervisor you occasionally have to ask "is this a host problem or a guest problem?" and the answer costs time.
- **A smaller patch surface.** One OS to update weekly instead of one host plus N guests. Not zero work, but less.

This is the same argument I made in [self-hosting without Docker](/posts/self-hosting-without-docker/): for a handful of stable services, the operating system *is* the orchestrator, and adding a control plane above it is often a tax you never get back.

## The real costs of Proxmox

Here is the part the hype skips. Proxmox is not free. It costs:

- **Another thing to patch.** It is a Debian-based distro with its own packages, its own kernel, and its own web stack. That is a second update cadence on top of every guest's update cadence. Skip it and you have an unpatched management interface listening on your LAN.
- **ZFS appetite.** The common guidance is to leave a chunk of RAM for the ARC, and ZFS dedup is a trap that eats memory you needed for actual guests. On a box with modest RAM, choosing the "nice" filesystem quietly costs you a guest. It is a real engineering trade, not a free upgrade.
- **Backups you still must configure.** The snapshot button is not a backup. Snapshots live on the same pool as the thing you are protecting, so a failed disk takes both. You still have to configure a real backup job, ideally to a different device, and verify that you can restore it. Proxmox makes this *easier*, not *automatic*. My rule from [backups you can restore](/posts/backups-you-can-restore/) still applies: an untested backup is a hope, not a backup.
- **The tendency to virtualise everything.** Once you have a hypervisor, every little thing becomes a guest. A tiny cron job gets a container. A static site gets a VM. You end up maintaining ten mini-operating-systems where one would do, and the box spends its resources on the layer instead of the work.

That last one is the subtlest cost, and it is cultural rather than technical.

## Proxmox vs plain Linux: a decision table

Here is how I actually decide. Read the row that matches your situation.

| Situation | Proxmox | Plain Linux + systemd + containers |
| --- | --- | --- |
| Many services you experiment with and often break | Better: snapshot, roll back, try again | Painful: you rebuild by hand |
| A handful of stable services | Overkill: you pay for a layer you do not use | Better: one kernel, direct control |
| You want to learn hypervisors / build a lab | Better: the whole point | Not the goal |
| Small box, tight RAM | Risky: ZFS + per-guest overhead | Better: nothing wasted |
| You need strong isolation between tenants | Better: separate kernels via VMs | Weaker: containers share a kernel |
| You hate extra patch channels | Worse: host plus every guest | Better: one OS to update |
| Mixed Windows + Linux workloads | Better: VMs are the natural home | Awkward |
| A blog, a few APIs, some timers | Overkill | Better |

If most of your rows land on the same side, the decision is already made. The trap is picking the column that *sounds* more professional instead of the one that matches the work.

## The pragmatic middle path

You do not have to choose between "bare metal with no isolation" and "a full hypervisor." The middle path is a plain Linux host that still gives you most of what people actually want from virtualization, using tools that ship with the system.

For system containers — the LXC-style use case — you have **`systemd-nspawn`**, built into systemd. It gives you a container with its own filesystem and process namespace, started and supervised like any other unit:

```ini
# /etc/systemd/nspawn/notes.nspawn
[Exec]
Boot=on
PrivateUsers=pick
[Network]
Private=yes
VirtualEthernet=yes
```

```bash
# create a Debian container with debootstrap, then run it
sudo debootstrap --include=systemd,iproute2 stable /var/lib/machines/notes \
  http://deb.debian.org/debian
sudo systemctl start systemd-nspawn@notes
sudo machinectl shell notes        # drop into it like a VM console
```

For application containers, **podman** runs OCI images without a daemon, and with rootless mode it is a reasonable isolation boundary for a single service:

```bash
podman run -d --name wiki --restart=always \
  -p 127.0.0.1:8080:8080 \
  -v /srv/wiki/data:/data:Z \
  docker.io/requarks/wiki:2
podman generate systemd --new --files --name wiki   # supervise it with systemd
```

Snapshots and backups do not require a hypervisor either. If your root pool is ZFS, `zfs snapshot` and `zfs send | zfs receive` give you atomic, verifiable copies. If it is not, `restic` or `borg` to another machine does the same job with deduplication and encryption.

So the middle path is: one host, `systemd-nspawn` for the things that want their own userspace, podman for third-party images, and a backup job that you have actually restored from. You get isolation and easy rollback for the services that need it, and none of the overhead for the ones that do not.

This is also how I run [what I self-host](/posts/what-i-self-host-2026/): a small number of boring services, supervised directly, with backups that are tested rather than assumed.

## Virtualization is a tool, not a personality

The honest summary: run Proxmox when you are running many things, you break them often, and you want the lifecycle and snapshot machinery in one place. Run plain Linux when you have a handful of stable services and value direct access and a smaller patch surface over a control panel.

Neither choice makes you a better engineer. The person who virtualises everything to look serious is as wrong as the person who refuses any abstraction on principle. Match the tool to the work, keep your backups real, and do not add a hypervisor to solve a problem you do not have.
