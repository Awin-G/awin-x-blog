---
title: "Rootless containers: running containers without root (and Podman vs Docker)"
description: "A rootful container daemon is root-equivalent — a container escape is host root. Real demos of user namespaces, subuid/subgid mapping, unshare, and what breaks rootless: low ports, storage drivers, cgroup delegation. An honest Podman vs Docker verdict."
pubDate: 2027-02-05
lang: en
translationKey: rootless-containers-and-podman
tags: [devops, security]
featured: false
keywords:
  - rootless containers
  - Podman vs Docker
  - user namespaces
  - subuid
  - daemonless
---

Most container security advice stops at the container's *internal* posture — drop capabilities, run as non-root, read-only filesystems. Those matter, and I covered them in [container security basics](/posts/container-security/). But there is a bigger question one layer down: **who runs the daemon?** A rootful container daemon is root-equivalent on the host. If an attacker escapes the container, they don't get "container root" — they get *host* root, because the daemon itself was root and the kernel is shared. **Rootless containers** flip that: the daemon runs as you, an unprivileged user, so an escape lands you back where you started. This article is the mechanism (user namespaces, `subuid`/`subgid`), the two runtimes (Podman vs Docker), and what honestly breaks.

## The problem: a rootful daemon is root-equivalent

On this Arch box the Docker daemon runs as root:

```console
$ ps -o user,pid,comm -p $(pgrep -f dockerd | head -1)
USER         PID COMMAND
root      147879 dockerd
$ pgrep -fa dockerd
147879 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
```

That is not incidental — a container daemon *must* be root in the classic model, because creating containers means calling privileged kernel operations (mounting overlay filesystems, manipulating network interfaces, writing cgroup files) that only root may perform. The daemon is a root process that listens on a root-owned socket (`/var/run/docker.sock`) and happily does root things on your behalf. Mount that socket into a container and you have handed over the host — the `docker.sock` footgun is a whole article by itself.

The security options Docker reports are real but they are *inside* the container:

```console
$ docker info | sed -n '/Security Options/,/Kernel Version/p'
 Security Options:
  seccomp
   Profile: builtin
  cgroupns
```

Seccomp, cgroup namespace isolation — these protect the host from the container's *syscalls*. They do nothing about the daemon's own root privilege. The blast radius of a kernel escape is the daemon's privilege, not the container's. That is the gap rootless closes.

## User namespaces: the mechanism that makes rootless possible

A **user namespace** is a namespace that re-maps user and group IDs. Inside a user namespace you can be uid 0 (root) while outside — on the real host — you are your ordinary unprivileged user. The kernel translates between the two views. This is the single primitive that makes rootless containers possible, and it is not a container invention — it is a general Linux namespace, available since kernel 3.8.

Prove it on this host. Outside, I am `awinx` (uid 1000). Inside a new user namespace, I am root:

```console
$ unshare -Ur id
uid=0(root) gid=0(root) groups=0(root),65534(nobody)
$ echo "outside: $(id -un) (uid=$(id -u))"
outside: awinx (uid=1000)
$ unshare -Ur sh -c 'echo "inside userns: $(id -un) (uid=$(id -u))"'
inside userns: root (uid=0)
```

And the kernel's own view of the mapping, from inside:

```console
$ unshare -Ur sh -c 'cat /proc/self/uid_map; echo "--- gid_map ---"; cat /proc/self/gid_map'
         0       1000          1
--- gid_map ---
         0       1000          1
```

`0 1000 1` reads: uid 0 *inside* maps to uid 1000 *outside*, for a range of 1 ID. The translation is one-to-one and total — there is no ambiguity about who you really are.

The real proof is what happens to files. Create a file inside the namespace and check its owner from outside:

```console
$ unshare -Ur sh -c 'id; touch /tmp/opencode/work/rootless/inside_ns.txt; echo "inside sees:"; ls -ln /tmp/opencode/work/rootless/inside_ns.txt'
uid=0(root) gid=0(root) groups=0(root),65534(nobody)
inside sees:
-rw-r--r-- 1 0 0 0 10月14日 13:30 /tmp/opencode/work/rootless/inside_ns.txt
$ ls -ln /tmp/opencode/work/rootless/inside_ns.txt
-rw-r--r-- 1 1000 1000 0 10月14日 13:30 /tmp/opencode/work/rootless/inside_ns.txt
```

Inside: owned by root (uid 0). Outside: owned by uid 1000, which is `awinx`. The same file, two identities. A rootless container runtime exploits exactly this: the container's root is mapped to a range of subordinate IDs owned by your user, so "root inside" is genuinely unprivileged outside.

<figure>
<svg viewBox="0 0 680 240" width="100%" role="img" aria-label="Two-panel diagram of uid mapping. Left: host view, a single unprivileged user awinx uid 1000. Right: inside a user namespace, container root uid 0. An arrow labeled with the mapping 0 to 1000 connects them.">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.55">
    <rect x="30" y="60" width="260" height="140" rx="10"/>
    <rect x="390" y="60" width="260" height="140" rx="10"/>
  </g>
  <g fill="#0f766e" stroke="none">
    <path d="M 320 130 L 380 130" stroke="#0f766e" stroke-width="2" fill="none"/>
    <polygon points="380,130 368,124 368,136" fill="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="160" y="30" text-anchor="middle" font-weight="600">Host view (outside)</text>
    <text x="520" y="30" text-anchor="middle" font-weight="600">Container view (inside userns)</text>

    <text x="160" y="95" text-anchor="middle" font-weight="600">awinx</text>
    <text x="160" y="118" text-anchor="middle">uid 1000</text>
    <text x="160" y="140" text-anchor="middle" opacity="0.7">ordinary unprivileged user</text>
    <text x="160" y="170" text-anchor="middle" opacity="0.7">real identity on the host</text>

    <text x="520" y="95" text-anchor="middle" font-weight="600">container root</text>
    <text x="520" y="118" text-anchor="middle">uid 0</text>
    <text x="520" y="140" text-anchor="middle" opacity="0.7">maps back to uid 1000 outside</text>
    <text x="520" y="170" text-anchor="middle" opacity="0.7">root in name only</text>

    <text x="350" y="120" text-anchor="middle" fill="#0f766e" font-weight="700">0 → 1000</text>
    <text x="350" y="145" text-anchor="middle" fill="#0f766e" font-weight="700">1 ID range</text>
  </g>
</svg>
<figcaption>User-namespace uid mapping. The container's uid 0 is real root only inside the namespace; outside it is your ordinary unprivileged uid 1000. A rootless runtime builds on exactly this translation.</figcaption>
</figure>

## subuid and subgid: the ID ranges rootless needs

A single-ID mapping (root → you) is enough to *prove* the concept, but a real rootless container needs many UIDs: the image has files owned by uid 0, 1, 2, … and they all have to map somewhere unprivileged. Linux solves this with **subordinate ID ranges**. Your user is allocated a contiguous block of UIDs and GIDs that they may assign inside namespaces:

```console
$ cat /etc/subuid
awinx:100000:65536
$ cat /etc/subgid
awinx:100000:65536
```

`awinx:100000:65536` means: user `awinx` may use 65536 subordinate IDs starting at 100000 — so UIDs 100000–165535 are theirs to map. A rootless container runtime picks a slice of that range and maps the container's uid 0 → some ID in it, uid 1 → the next, and so on. The host reserves the low range (0–65535) for real system accounts, and your unprivileged user owns the high range. This file is the reason rootless works for non-root users at all — without an allocated range there is nothing to map *to*.

Two sysctls gate the whole feature. Both are permissive here:

```console
$ sysctl kernel.unprivileged_userns_clone
kernel.unprivileged_userns_clone = 1
$ sysctl user.max_user_namespaces
user.max_user_namespaces = 47200
```

`kernel.unprivileged_userns_clone = 1` is the Debian/Ubuntu-specific toggle that lets unprivileged users create user namespaces (set to 1 here; on some distros it defaults to 0 and must be flipped). `user.max_user_namespaces` caps how many user namespaces a single user may create — 47200 here, effectively unlimited for a workstation. If either is 0, rootless is dead on arrival and the fix is a `sysctl` line, not a container flag.

## Podman vs Docker: daemonless vs rootless daemon

This is where the two runtimes genuinely differ, and the difference is architectural.

**Podman** is **daemonless** and **rootless-first**. There is no long-running root daemon at all. Podman uses a fork/exec model: the `podman` process you invoke forks a child that becomes the container, and the two communicate over a socket. When you run as an unprivileged user, Podman creates a user namespace for that child, maps your `subuid`/`subgid` range into it, and runs the container as "root" *inside* that namespace — which is your unprivileged uid outside. No root daemon, no root socket, no setuid helper in the common case. The CLI is deliberately Docker-compatible (`podman run`, `podman build`, `podman ps`) so muscle memory carries over.

**Docker** is the opposite shape: a rootful `dockerd` daemon with a root-owned socket. Docker *can* run rootless — `dockerd-rootless.sh` starts a daemon as your unprivileged user inside a user namespace — but it is a bolted-on mode, not the design center. A rootless Docker daemon still needs the same primitives (user namespaces, subordinate IDs) plus userspace replacements for things the kernel would normally do for root: **fuse-overlayfs** for the overlay filesystem (because an unprivileged user can't mount overlayfs directly) and **slirp4netns** or **pasta** for networking (because an unprivileged user can't configure real network interfaces). Those userspace layers work, but they are slower and more moving parts than the kernel-native path Podman takes on a rootless-by-default setup.

I could not run Podman here to show you — it is not installed on this box:

```console
$ podman --version
zsh:1: command not found: podman
```

So the honest statement is: on this particular host I can prove the *primitives* (user namespaces, subordinate IDs, namespace creation) which both runtimes depend on, but I cannot show you a live `podman run`. The architectural claims above are from how the two are built, not from a side-by-side benchmark on this machine.

## What honestly breaks rootless

Rootless is not free. The things that break all share one cause: an unprivileged user cannot do what root can, and containers have historically assumed root.

**Binding ports below 1024.** Ports 1–1023 are privileged; only root may bind them. A rootless container that tries `-p 80:80` fails. The fix is `slirp4netns`/`pasta` handling the translation, or just using unprivileged ports (8080, 8443) and letting a reverse proxy or the host's rootless port-forwarder handle 80/443.

**Storage drivers.** The overlay filesystem needs mount privileges. Rootful Docker uses the kernel overlay driver; rootless Docker must use **fuse-overlayfs**, a FUSE implementation that runs in userspace. It works, with a performance cost on I/O-heavy workloads. Podman on a rootless setup uses the same FUSE path unless a kernel-native rootless overlay is available.

**cgroup v2 delegation.** Containers are limited by cgroups, and writing cgroup files usually needs root. On a rootless setup you need **cgroup v2 delegation** — systemd (or the runtime) must delegate a cgroup subtree to your user so the container can set its own CPU/memory limits. Without it, `--memory` and `--cpus` are silently ignored or error out.

**`--privileged` and friends.** `--privileged` is meaningless rootless — there is no root to escalate *to*. `--cap-add`, `--device`, host-path mounts of root-owned files, and `--network host` all either fail or behave differently. This is a feature (it is hard to accidentally hand a container the host), but it surprises people.

**File ownership on volumes.** This one bites everyone. A rootless container writes files as its mapped UIDs (e.g. 100000+), and from the host's view those are high-numbered UIDs your user owns but didn't "mean" to create. The fix is `--userns=keep-id` (Podman) or Docker's equivalent, which maps your host uid to the same uid *inside* the container, so files you write land with the ownership you expect.

## The verdict: when rootless is the right default

For a **workstation or dev box** — a machine you log into, run projects on, and don't want a root daemon lurking on — **rootless is the right default**. The threat model is exactly right: you are the only user, the daemon runs as you, and a container escape gets an attacker exactly your unprivileged access and no more. Podman's daemonless, rootless-first design fits this perfectly; Docker's rootless mode works but carries the userspace overhead.

For a **dedicated server with a single admin** running trusted workloads, rootful with good isolation is often fine and simpler — you already have a root problem to solve (SSH, hardening, updates), and the marginal risk of a rootful daemon over a locked-down root account is small. The calculus changes with multiple tenants, CI runners executing untrusted code, or anything internet-facing: there, rootless removes a whole class of "escape → host root" without giving up containers.

The honest summary: rootless containers trade some convenience (low ports, kernel-native storage, cgroup delegation setup) for a strictly smaller blast radius. On a box you actually use every day, that trade is worth it — and the user-namespace primitives underneath are now mature enough that "rootless by default" is a reasonable posture, not an experiment. Start with `unshare -Ur id` on your own machine: if you see `uid=0(root)` while being `awinx` outside, the whole idea is already working, and the runtime is just a wrapper around it.
