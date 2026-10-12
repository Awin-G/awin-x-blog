---
title: "Container security basics: what a container does and doesn't protect"
description: "A container is a process on the host kernel, not a VM. Real Docker demos of the defaults you inherit — root, 14 capabilities, a permissive seccomp profile — and the flags that matter: --user, --cap-drop, no-new-privileges, --read-only, memory limits, rootless, and the docker.sock footgun."
pubDate: 2026-12-10
lang: en
translationKey: container-security
tags: [security, devops]
featured: false
keywords:
  - container security
  - docker security
  - capabilities seccomp
  - rootless containers
  - no-new-privileges
---

Most **container security** advice collapses into one of two errors. Either a container is treated as a lightweight VM that isolates you from everything, or it is dismissed as a packaging format that isolates nothing. The truth is narrower and more useful. A container is a process running on the *host* kernel with a different view of the world, and the **Docker security** defaults are tuned to prevent accidents, not to stop attackers. Below: what each default does, what the runtime merely *configures* instead of enforces, and which flags change the answer — with commands you can run yourself. No sudo, no `--privileged`, just local images.

<figure>
<svg viewBox="0 0 680 215" width="100%" role="img" aria-label="Two panels. Left: three containers, each holding an app, sit on one shared host kernel above the hardware. Right: two virtual machines, each holding an app and its own guest kernel, sit on a hypervisor above the hardware.">
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.55">
    <rect x="10" y="28" width="320" height="170" rx="10"/>
    <rect x="350" y="28" width="320" height="170" rx="10"/>
    <rect x="25" y="46" width="88" height="52" rx="6"/>
    <rect x="121" y="46" width="88" height="52" rx="6"/>
    <rect x="217" y="46" width="88" height="52" rx="6"/>
    <rect x="25" y="112" width="280" height="32" rx="6"/>
    <rect x="25" y="158" width="280" height="26" rx="6"/>
    <rect x="365" y="46" width="134" height="52" rx="6"/>
    <rect x="511" y="46" width="134" height="52" rx="6"/>
    <rect x="365" y="112" width="280" height="32" rx="6"/>
    <rect x="365" y="158" width="280" height="26" rx="6"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="170" y="20" text-anchor="middle" font-weight="600">Containers</text>
    <text x="510" y="20" text-anchor="middle" font-weight="600">Virtual machines</text>

    <text x="69" y="76" text-anchor="middle">app</text>
    <text x="165" y="76" text-anchor="middle">app</text>
    <text x="261" y="76" text-anchor="middle">app</text>
    <text x="165" y="132" text-anchor="middle">host kernel — one, shared</text>
    <text x="165" y="175" text-anchor="middle">hardware</text>

    <text x="432" y="66" text-anchor="middle">app</text>
    <text x="432" y="86" text-anchor="middle">guest kernel</text>
    <text x="578" y="66" text-anchor="middle">app</text>
    <text x="578" y="86" text-anchor="middle">guest kernel</text>
    <text x="505" y="132" text-anchor="middle">hypervisor</text>
    <text x="505" y="175" text-anchor="middle">hardware</text>
  </g>
</svg>
<figcaption>In the container model every workload shares one kernel, so that kernel is the trust boundary. In the VM model each guest carries its own kernel and the hypervisor hardware-isolates them. A container is never the second picture.</figcaption>
</figure>

## Containers are not VMs: the shared-kernel truth

A virtual machine gets a hypervisor, virtual hardware, and its **own kernel**. A container gets the host's kernel and a set of namespaces that redraw what it can *see*. Prove it:

```console
$ uname -r
7.2.9-arch1-1
$ docker run --rm alpine:3.21 uname -r
7.2.9-arch1-1
$ docker run --rm alpine:3.21 cat /proc/version
Linux version 7.2.9-arch1-1 (linux@archlinux) (gcc ...) #1 SMP PREEMPT_DYNAMIC Sat, 03 Oct 2026
```

Same kernel string, same build. The container emulates nothing; it executes syscalls on the kernel you are already running. Isolation comes from four mechanisms stacked together:

- **Namespaces** decide what the process can see (PIDs, mounts, network, hostname, users).
- **cgroups** decide how much it can consume (CPU, memory, PIDs).
- **Capabilities** decide which privileged kernel operations root may still perform.
- **LSMs** (AppArmor/SELinux) apply mandatory access control on top.

The practical consequence: the kernel is the trust boundary. One kernel bug is one escape away from being a host bug, and every container on the machine shares that blast radius. There is no "secure container" in isolation — there is a *host* that is or isn't defensible. The host side of that equation is its own article: [hardening a public server](/posts/hardening-a-public-server/).

## The defaults you inherit: root, capabilities, seccomp

A bare `docker run image` hands you three defaults that would make a sysadmin wince on a normal host.

**One: you are root.** Not a namespaced user pretending — uid 0 in the container's user namespace, which is the host's initial user namespace unless you turned on rootless.

```console
$ docker run --rm alpine:3.21 id
uid=0(root) gid=0(root) groups=0(root),0(root),1(bin),2(daemon),3(sys),4(adm),6(disk),10(wheel),...
```

**Two: root keeps 14 capabilities.** Modern Docker does *not* hand over the full set — it drops all but fourteen known-safe ones, which is genuinely good. But "known-safe" is relative to the runtime, not to your app.

```console
$ docker run --rm alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -2'
Current: cap_chown,cap_dac_override,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,
cap_setpcap,cap_net_bind_service,cap_net_raw,cap_sys_chroot,cap_mknod,cap_audit_write,cap_setfcap=ep
Bounding set =cap_chown,cap_dac_override,...,cap_setfcap
```

Notice `cap_dac_override`: it means "ignore file permission bits". A root process with it can read any file in the container's filesystem regardless of mode — which is why a *file* permission is not a boundary on its own.

**Three: seccomp filters syscalls, but permissively.** Docker installs a default seccomp profile that blocks roughly 40 of the ~350 syscalls (mostly exotic ones: `keyctl`, `add_key`, `reboot`, and namespace creation). The kernel reports it as filter mode:

```console
$ docker run --rm alpine:3.21 grep Seccomp /proc/self/status
Seccomp:        2
Seccomp_filters:        1
$ docker run --rm alpine:3.21 unshare -U true
unshare: unshare(0x10000000): Operation not permitted
$ docker run --rm --security-opt seccomp=unconfined alpine:3.21 unshare -U true
$ echo $?
0
```

The same `unshare` call the default profile refuses is allowed the moment you disable seccomp. This is the **capabilities seccomp** pair people conflate: capabilities gate *privileged operations*; seccomp gates *which syscalls exist at all*. You need both, and dropping one does not cover the other.

## Docker security knobs that actually move the needle

Each knob below is a real reduction in what a compromised process can do, roughly in order of value per line of config.

### `--user`: stop being root

The highest-leverage flag. Give the process a uid that owns nothing.

```console
$ docker run --rm --user 1000:1000 alpine:3.21 id
uid=1000 gid=1000 groups=1000
$ docker run --rm --user 65534:65534 alpine:3.21 grep '^Uid:' /proc/self/status
Uid:    65534   65534   65534   65534
```

Now the process starts without `cap_dac_override` mattering and without write access to root-owned paths. In an image this belongs in the Dockerfile (`USER 1000`), not only on the command line.

### `--cap-drop=ALL`: keep the kernel's checks on

Drop everything, then add back the one or two capabilities your app truly needs.

```console
$ docker run --rm --cap-drop=ALL alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -2'
Current: =
Bounding set =
```

The difference is functional, not cosmetic. With default caps, root ignores file modes; drop them and the same root process is refused:

```console
$ docker run --rm alpine:3.21 sh -c 'printf secret > /f; chmod 0000 /f; cat /f'
secret
$ docker run --rm --cap-drop=ALL alpine:3.21 sh -c 'printf secret > /f; chmod 0000 /f; cat /f'
cat: can't open '/f': Permission denied
```

Most services need *zero* capabilities. Add one back only when you can name why:

```console
$ docker run --rm --cap-drop=ALL --cap-add=NET_BIND_SERVICE alpine:3.21 sh -c 'apk add -q libcap; capsh --print | head -1'
Current: cap_net_bind_service=ep
```

### `--security-opt no-new-privileges`: block setuid elevation

Dropping capabilities does not stop a setuid-root binary in the image from *regaining* them at `exec`. `no-new-privileges` does. You can watch the kernel bit flip:

```console
$ docker run --rm alpine:3.21 grep NoNewPrivs /proc/self/status
NoNewPrivs:     0
$ docker run --rm --security-opt no-new-privileges alpine:3.21 grep NoNewPrivs /proc/self/status
NoNewPrivs:     1
```

And it changes behaviour. Here an unprivileged user runs a setuid-root Perl; without the flag it executes as root, with the flag the elevation is silently refused:

```console
$ docker run --rm debian:stable sh -c 'chmod u+s /usr/bin/perl;
    setpriv --reuid=1000 --regid=1000 --clear-groups perl -e "printf qq(euid=%d real=%d\n), \$>, \$<"'
euid=0 real=1000
$ docker run --rm --security-opt no-new-privileges debian:stable sh -c 'chmod u+s /usr/bin/perl;
    setpriv --reuid=1000 --regid=1000 --clear-groups perl -e "printf qq(euid=%d real=%d\n), \$>, \$<"'
euid=1000 real=1000
```

Unless something genuinely needs setuid, set this on every container, including your own Compose services.

### `--read-only` and `--tmpfs`: make the rootfs immutable

If the app can't write to its own image, an attacker who lands inside can't persist by editing a binary or a config.

```console
$ docker run --rm --read-only alpine:3.21 touch /evidence
touch: /evidence: Read-only file system
$ docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --tmpfs /run alpine:3.21 \
    sh -c 'touch /tmp/ok && ls -l /tmp/ok; mount | grep " /tmp "'
-rw-r--r--    1 root     root             0 Oct 12 09:10 /tmp/ok
tmpfs on /tmp type tmpfs (rw,nosuid,nodev,noexec,relatime,size=16384k,inode64,huge=advise)
```

The pattern is a read-only rootfs plus explicit writable `tmpfs` mounts that vanish with the container. `noexec,nosuid` on those mounts means a dropped file can't be executed or used to escalate. This is the container analogue of the read-only filesystem work in [systemd hardening](/posts/systemd-hardening/), where the same idea arrives as `ProtectSystem=strict` and `ReadWritePaths=`.

### seccomp and AppArmor: the syscall and MAC layers

The default seccomp profile is a floor, not a ceiling. If you know the syscalls your binary needs, a custom profile narrows "which syscalls exist" to that list. `seccomp=unconfined` should only ever be a debugging step you remove. On hosts with AppArmor, `apparmor=unconfined` disables an entire mandatory-access-control layer that is otherwise on by default. Neither substitutes for the flags above; they are extra filters on top.

### Resource limits: `--memory`, `--cpus`, `--pids-limit`

Isolation is partly about not letting one tenant take the machine down. A memory limit is enforced by cgroup v2 and visible from inside:

```console
$ docker run --rm --memory=32m alpine:3.21 cat /sys/fs/cgroup/memory.max
33554432
$ docker run --rm alpine:3.21 cat /sys/fs/cgroup/memory.max
max
```

Exceed it and the kernel kills the process, which Docker surfaces as an OOM kill:

```console
$ docker run -d --memory=32m python:3.12-slim python3 -c 'bytearray(200*1024*1024)'
$ docker inspect --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' <id>
OOMKilled=true ExitCode=137
```

Pair it with `--pids-limit` (a fork-bomb ceiling) and `--cpus`; on cgroup v2 they are one mechanism.

## The Docker socket is root: the docker.sock footgun

Now the mistake that undoes everything above. Mounting `/var/run/docker.sock` into a container does not grant "a bit of Docker access". That socket *is* the Docker API, and the API can create containers — including one that mounts the host filesystem. Whoever holds the socket is root on the host, by construction. On this machine:

```console
$ ls -l /var/run/docker.sock
srw-rw---- 1 root docker 0 Oct 12 04:12 /var/run/docker.sock
```

Members of the `docker` group can read and write it, so `docker` group membership is root-equivalent — and so is any container you hand the socket to. Watch a container with nothing but the socket use the standard library to reach the host daemon:

```python
import socket, http.client
class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")
c = UnixHTTP("localhost")
c.request("GET", "/containers/json?all=1")
print(c.getresponse().read().decode())
```

```console
$ docker run --rm -v /var/run/docker.sock:/var/run/docker.sock python:3.12-slim python3 demo.py
status 200 ApiVersion 1.56 Engine 29.9.0
  python:3.12-slim | /modest_lederberg
  postgres:17-alpine | /mq-pg
  nginx:1.27-alpine | /compose-cookbook-web-1
  ...
  total containers visible: 14
```

That container can now create *another* container that mounts host `/`, run as root, and read files the first one could never touch:

```console
POST /containers/create?name=sockpwn  ->  201 {"Id":"f6fe176b8cb7..."}
start  ->  204
--- id inside the new container ---
uid=0(root) gid=0(root) groups=0(root),...
--- host /etc/shadow, seen from the container ---
root:root 600 /host/etc/shadow
36
DELETE /containers/sockpwn?force=1  ->  204
```

The `600 root:root` file is exactly the boundary you thought you had, and the socket walked straight through it. The rules are simple to state: never bind-mount the Docker socket into an untrusted container; if a service must react to Docker events, put `tecnativa/docker-socket-proxy` (or equivalent) in front of it with an endpoint allowlist; and treat every member of the `docker` group as a root account. The only container that should ever see the socket is a purpose-built proxy running nothing else.

## Rootless containers: remove root from the daemon

Every flag above shrinks a container while the daemon and its socket still run as root. **Rootless containers** remove that assumption at the source: the daemon runs as an unprivileged user, using a user namespace and either rootlesskit with slirp4netns/pasta or another network shim. Now a daemon bug is a bug in *your* user, not root, and the socket lives under `$XDG_RUNTIME_DIR`, not `/var/run`.

```console
$ docker info --format '{{json .SecurityOptions}}'
["name=seccomp,profile=builtin","name=cgroupns"]
```

This host is rootful — there is no `rootless` entry. On a rootless install you would see `name=rootless` here, and the daemon's `Root Dir` would live under `~/.local/share/docker`. Rootless costs a little (sometimes `overlayfs`, low port bindings, some network modes), but it is the strongest single change available, because it removes the exact thing the docker.sock footgun hands over. If containers are your main runtime, it belongs on your list *before* any per-container flag.

## Supply chain: image provenance, digests, and minimal bases

Everything above assumed the image is honest. Three supply-chain habits matter.

- **Pin by digest, not just tag.** Tags move. `alpine:3.21` resolved to a digest today:

  ```console
  $ docker image inspect alpine:3.21 --format '{{index .RepoDigests 0}}'
  alpine@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
  ```

  `FROM alpine:3.21` can silently become something else; `FROM alpine@sha256:48b0...` cannot.

- **Know who built it and what's inside.** Prefer official or verified publishers, scan for CVEs before deploy (`docker scout`, `trivy`, `grype`), and rebuild on a schedule so base-image patches actually reach you.

- **Start minimal.** Attack surface tracks the number of installed packages, because each one is another setuid binary and another library:

  ```console
  alpine:3.21         12.2MB
  nginx:1.27-alpine   74.5MB
  python:3.12-slim     190MB
  debian:stable        187MB
  golang:1.27-alpine   381MB
  ```

  And check the image's default user — an empty `User` means root:

  ```console
  $ docker image inspect alpine:3.21 --format 'User={{.Config.User}}'
  User=
  $ docker image inspect nginx:1.27-alpine --format 'User={{.Config.User}}'
  User=
  ```

  Both of those images are "minimal", and both still default to root, so `--user`/`USER` remains your job.

## A defensible container security checklist

Defaults are a starting point, not a policy. What I actually reach for, in order:

1. `--user` / `USER` — run as a non-root uid. If the image fights you, fix the image.
2. `--cap-drop=ALL`, then `--cap-add` only what you can justify. Most services need none.
3. `--security-opt no-new-privileges` — on every container, always.
4. `--read-only` plus `--tmpfs` for the few paths that must be writable (`noexec,nosuid`).
5. Keep the default seccomp profile, or a stricter custom one; never ship `seccomp=unconfined` or `apparmor=unconfined`.
6. `--memory`, `--cpus`, `--pids-limit` — a ceiling on blast radius.
7. No Docker socket in any container except a hardened proxy with an endpoint allowlist; treat the `docker` group as root.
8. Prefer rootless containers where the workload allows.
9. Pin image digests, start from a minimal base, scan and rebuild regularly.
10. Harden the host itself — the container shares its kernel with you. See [hardening a public server](/posts/hardening-a-public-server/).

None of this turns a container into a VM, and it isn't meant to. The goal is to keep the kernel's existing checks switched on, drop the privileges nobody asked for, and make sure the one process that *does* hold the keys — the Docker socket — is never handed to code you don't control. Do that and a container is a genuinely useful boundary. Skip it and you have root in a box whose lid opens outward.
