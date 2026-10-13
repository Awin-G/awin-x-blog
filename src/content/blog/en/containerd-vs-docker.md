---
title: "containerd vs Docker: what's actually doing the work"
description: "Docker vs containerd, settled on a real Arch host with docker version, docker info, ps and runc output: which layer starts your container, why runc is the OCI runtime at the bottom, what Docker adds on top, and why you probably shouldn't rip it out."
pubDate: 2027-01-16
lang: en
translationKey: containerd-vs-docker
tags: [devops]
featured: false
keywords:
  - containerd
  - runc
  - Docker vs containerd
  - OCI runtime
  - nerdctl
---

Every few months someone asks me whether they should "switch from Docker to containerd", as if the two were rival products — a **Docker vs containerd** bake-off with a winner. I've stopped answering from memory and started answering with `ps aux`. On the machine I'm writing this on — Arch Linux, kernel 7.2.9, Docker 29.9.0 — **containerd v2.4.1** is running, **runc 1.5.2** is installed, and so is Docker, because Docker never replaced containerd: it sits *on top of* it. The story continues downward — **runc**, the **OCI runtime** that actually makes the syscalls, is what both Docker and Kubernetes end up calling. Once you can see the layers, "Docker vs containerd" stops being a rivalry and becomes plumbing.

Everything below is real output from this host — no `sudo`, no `--privileged`, and every container I started was destroyed as I wrote. Where I couldn't run something, I say so.

## The stack, in one picture

A container isn't a program, it's five layers handing work downward. The CLI is the only one most people ever meet:

<figure>
<svg viewBox="0 0 720 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Layered stack from top to bottom: the docker CLI with buildx and compose, the dockerd daemon, containerd, runc as the OCI runtime, and the Linux kernel providing namespaces, cgroups and overlayfs.">
  <defs>
    <marker id="ar" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#0f766e"/>
    </marker>
  </defs>
  <rect x="60" y="16" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="44" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">docker CLI · buildx · compose</text>
  <line x1="250" y1="62" x2="250" y2="84" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="78" font-size="10" fill="#0f766e">HTTP/JSON · /var/run/docker.sock</text>
  <rect x="60" y="88" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="116" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">dockerd</text>
  <line x1="250" y1="134" x2="250" y2="156" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="150" font-size="10" fill="#0f766e">gRPC · /run/containerd/containerd.sock</text>
  <rect x="60" y="160" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="188" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">containerd</text>
  <line x1="250" y1="206" x2="250" y2="228" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="222" font-size="10" fill="#0f766e">spawns containerd-shim-runc-v2</text>
  <rect x="60" y="232" width="380" height="46" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="250" y="260" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">runc</text>
  <line x1="250" y1="278" x2="250" y2="300" stroke="#0f766e" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="470" y="294" font-size="10" fill="#0f766e">create + start the init process</text>
  <rect x="60" y="304" width="380" height="46" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="250" y="332" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">Linux kernel</text>
  <text x="470" y="332" font-size="10" fill="#0f766e">namespaces · cgroups · overlayfs</text>
</svg>
<figcaption>The full stack as it exists on this host. Only the top box is "Docker" in the sense most people mean; the bottom three boxes are what Docker and Kubernetes have in common.</figcaption>
</figure>

Two things to hold onto: the `docker` binary is a *client*, and every layer below it speaks a different protocol over a Unix socket.

## What is actually on this host: `docker version`

The fastest way to see that Docker contains containerd is to ask Docker itself:

```console
$ docker version
Client:
 Version:           29.9.0
 API version:       1.56
 Go version:        go1.27.1-X:nodwarf5
 Git commit:        f415da838b
 Built:             Fri Oct  9 00:19:20 2026
 OS/Arch:           linux/amd64
 Context:           default

Server:
 Engine:
  Version:          29.9.0
  API version:      1.56 (minimum version 1.40)
 containerd:
  Version:          v2.4.1
  GitCommit:        f2551031d7276a770f65f98c9b52e57e7dad07e8.m
 runc:
  Version:          1.5.2
 docker-init:
  Version:          0.19.0
```

Read the server half carefully. The client is 29.9.0; the Engine — the daemon, `dockerd` — is too; but notice what it delegates to: `containerd v2.4.1`, `runc 1.5.2`, `docker-init 0.19.0` (a hardened `tini` whose only job is being a well-behaved PID 1: reaping zombies, forwarding signals). Those aren't bundled dependencies; they are the parts doing the work.

Client and server are separate programs sharing a package: the client only talks HTTP over `/var/run/docker.sock`, the server does everything else. That's why you can drive a daemon from inside a container or from CI — and why socket access is a security boundary, as I covered in [securing containers in practice](/posts/container-security/).

## Docker vs containerd in `ps aux`

Now the part that usually ends the argument. `containerd` runs as a standalone service, and `dockerd` is pointed at it:

```console
$ ps aux | grep -E 'containerd|dockerd' | grep -v grep
root      147850  1.7  0.3 2047448  48084 ?       Ssl  Oct12  15:36 /usr/bin/containerd
root      147879  0.4  0.7 2115664  89156 ?       Ssl  Oct12   4:22 /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
```

That flag is the relationship in one line: `dockerd` was started *pointing at* the existing containerd — it didn't start its own, it connected. Here are the shims, five of them for the five running containers:

```console
$ ps aux | grep containerd-shim | grep -v grep
root 605897 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id a98048d4dcd0941e50f66dd421b8a00e12e610321c27393f54547f4517e5e651 -address /run/containerd/containerd.sock
root 606458 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 680910beb06c0192fda511b7aa91a8a7788d9398c9667a57031a297d2b68638b -address /run/containerd/containerd.sock
root 970577 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 3d994363756589deb76c6bc8837b8839e8648f58699b59a9ca0c8fc27eb787ea -address /run/containerd/containerd.sock
root 971592 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 200df4ce0d236f1020a2ad4499e0d6b67217412eb68db96174ee125fe16ed6fb -address /run/containerd/containerd.sock
root 972001 ... /usr/bin/containerd-shim-runc-v2 -namespace moby -id 6bcecf7782771f033093a99b9c30be889764f29574d3cc06f8a0f969a983bf5d -address /run/containerd/containerd.sock
```

Three details decode most of Docker vs containerd:

- `-namespace moby` — from containerd's point of view, Docker's containers are just containers in its `moby` namespace. (Kubernetes uses `k8s.io`.) That's where "Docker containers are containerd containers" comes from.
- One shim per container: it holds the container's stdio and outlives daemon restarts, which is what makes `docker logs` work.
- Each shim's parent is PID 1, not containerd — deliberate, so upgrading containerd doesn't take the containers with it.

`docker info` tells the same story, and shows Docker's image storage has moved *into* containerd:

```console
$ docker info
Server:
 Server Version: 29.9.0
 Storage Driver: overlayfs
  driver-type: io.containerd.snapshotter.v1
 Logging Driver: json-file
 Cgroup Driver: systemd
 Cgroup Version: 2
 Runtimes: io.containerd.runc.v2 runc
 Default Runtime: runc
 Init Binary: docker-init
 containerd version: f2551031d7276a770f65f98c9b52e57e7dad07e8.m
 Security Options:
  seccomp
   Profile: builtin
  cgroupns
 Kernel Version: 7.2.9-arch1-1
 Operating System: Arch Linux
```

`Default Runtime: runc` answers "what actually runs containers here" — the `runc` OCI runtime, whether asked by Docker or directly by containerd. And `io.containerd.snapshotter.v1` means Docker's image layers are unpacked and mounted by containerd's snapshotter. (More on the layers in [Docker networking explained](/posts/docker-networking/).)

## Following one container down to the kernel

Trace a real container to the bottom. Take a running nginx here and walk *up* from its process to the shim:

```console
$ CPID=$(docker inspect -f '{{.State.Pid}}' 680910beb06c)   # nginx container
$ ps -o pid,ppid,cmd -p $CPID
  PID   PPID  CMD
606482 606458 nginx: master process nginx -g daemon off;

$ ps -o pid,ppid,cmd -p 606458
  PID   PPID  CMD
606458      1 /usr/bin/containerd-shim-runc-v2 -namespace moby -id 680910beb06c0192fda511b7... -address /run/containerd/containerd.sock

$ cat /proc/$CPID/cgroup
0::/system.slice/docker-680910beb06c0192fda511b7aa91a8a7788d9398c9667a57031a297d2b68638b.scope
```

The picture: containerd spawned the shim, the shim supervises the container's init, and the kernel put it in a cgroup called `docker-<id>.scope`. Notice what's missing: `dockerd` — once a container runs, the daemon isn't in its ancestry at all; stop dockerd and this nginx keeps serving. `runc` is missing too: it runs once, at create time, then exits. The init is long-lived; the runtime that made it is transient.

Now the kernel's part, seen from inside a container I started for exactly this:

```console
$ docker run -d --name ns-demo alpine sh -c 'sleep 60'
$ docker exec ns-demo sh -c 'ls -l /proc/1/ns/'
lrwxrwxrwx cgroup -> cgroup:[4026533017]
lrwxrwxrwx ipc    -> ipc:[4026533015]
lrwxrwxrwx mnt    -> mnt:[4026533012]
lrwxrwxrwx net    -> net:[4026533018]
lrwxrwxrwx pid    -> pid:[4026533016]
lrwxrwxrwx pid_for_children -> pid:[4026533016]
lrwxrwxrwx time   -> time:[4026533179]
lrwxrwxrwx time_for_children -> time:[4026533179]
lrwxrwxrwx user   -> user:[4026531837]
lrwxrwxrwx uts    -> uts:[4026533014]

$ docker exec ns-demo sh -c 'cat /proc/1/cgroup; ps aux'
0::/
PID   USER     TIME  COMMAND
    1 root      0:00 sleep 60
```

Eight namespace IDs, a process that believes it is PID 1 with nothing else in its PID namespace, and a cgroup view rooted at `/`. `sleep 60` is the container. The root filesystem is just as revealing:

```console
$ docker exec ns-demo mount | head -2
overlay on / type overlay (rw,relatime,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2682/fs:/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/981/fs,upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2683/fs,workdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2683/work,index=off)
proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)
```

`docker info` says "Docker Root Dir: /var/lib/docker", but the container's merged view comes from `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/...`. Same kernel feature — overlayfs — installed, mounted and owned by containerd. That path is this article's whole thesis, in one directory name.

## What containerd is, and why Kubernetes uses it too

**containerd** is a CNCF-graduated daemon for the boring parts of containers: pull and verify images, store them, unpack them into snapshotters, and start, stop and supervise containers through runtime shims. It was extracted from Docker in 2017. It is not a Docker competitor; it's a component Docker itself uses, and one Kubernetes has talked to directly since the dockershim was deprecated in 1.20 and removed in 1.24 — kubelet speaks CRI to it over a socket, exactly like dockerd does.

The design worth borrowing is the shim: a separate process per container, reparented to init, so containerd can be upgraded without killing anything. The daemon comes and goes while the workload keeps running — which is why the same two daemons show up whether you typed `docker run` or `kubectl apply`.

## What Docker adds on top

So what's left for Docker? Everything that isn't running containers:

```console
$ docker --version
Docker version 29.9.0, build f415da838b
$ docker buildx version
github.com/docker/buildx 0.38.0 0dbe87f36ed472fe36b6796c3f70b4210a731fc5
$ docker compose version
Docker Compose version 5.6.0
```

On top of "pull image, run container":

- **A CLI past `run`** — `docker build` via BuildKit with real layer caching; `docker compose`, which turns three flags and a network into one YAML file; `volume`, `network`, and the rest.
- **The REST API.** `/var/run/docker.sock` is a documented HTTP API; every CI system, IDE plugin and homelab dashboard talks to *that*, not to containerd's gRPC API.
- **The ecosystem.** Docker Hub, official images, plugins, and the fact that every tutorial assumes `docker` exists. None of it is technology; all of it is coordination.
- **Sensible defaults over runc.** Seccomp profiles, the cgroup namespace, capability sets, `--init` — the security model I've written about [before](/posts/container-security/), packaged and maintained.

None of these are "container runtime" features in the OCI sense. Docker owns the front, containerd the middle, runc the bottom; the kernel owns everything.

## Why the OCI specs matter

This stack is composable because of the **OCI** (Open Container Initiative) specifications. Two matter here:

1. **The image spec** — a tarball of layers plus a JSON manifest. Any OCI image pulled by containerd can be read by Docker and vice versa. Not marketing; the spec.
2. **The runtime spec** — the JSON document that describes how to *run* an image: which namespaces, which mounts, which capabilities, which rlimits. That's the interface between containerd and runc.

You can see the second one by generating a default with the host's runc:

```console
$ runc spec && head -c 700 config.json
{
	"ociVersion": "1.3.0",
	"process": {
		"terminal": true,
		"user": { "uid": 0, "gid": 0 },
		"args": [ "sh" ],
		"capabilities": {
			"bounding": [ "CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE" ],
			...
		},
		"root": { "path": "rootfs", "readonly": true },
		...
	}
```

And farther down, the section that becomes the namespace soup inside `ns-demo`:

```json
		"namespaces": [
			{ "type": "pid" },
			{ "type": "network" },
			{ "type": "ipc" },
			{ "type": "uts" },
			{ "type": "mount" },
			{ "type": "cgroup" }
		],
		"maskedPaths": [ "/proc/acpi", "/proc/sysrq_trigger", ... ],
		"readonlyPaths": [ "/proc/bus", "/proc/irq", "/proc/sys", ... ]
```

`runc --version` even declares the spec version it implements — mine reports `spec: 1.3.0`. That's why there's no lock-in at the image or runtime layer: the spec is the contract.

## ctr, nerdctl, and what I could not run

The lower layers are usable by hand — that's the point of them having CLIs. `ctr` is containerd's official client, installed at the daemon's version (v2.4.1). But as my unprivileged user:

```console
$ ctr namespaces list
time="2026-10-13T07:44:54+08:00" level=warning msg="Failed to check deprecations" error="connection error: desc = \"transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied\""
ctr: rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied"
```

Permission denied, as expected: the socket is `root:root 660` and I'm uid 1000. `nerdctl`, the Docker-flavoured containerd client people mean when they say "containerd with a nice CLI", isn't installed here at all.

What I deliberately did **not** do: mount `/run/containerd/containerd.sock` into a container so `ctr` could reach the real daemon. Containers here run as real root (no user-namespace remapping), so that trick wouldn't be "talking to containerd" — it would be handing full host root to anything that can read the socket. If you want a sandbox for `ctr`/`nerdctl`, use a throwaway VM or a rootless setup, not your workstation's daemon.

## You probably don't need to replace Docker

If Docker works for you, keep it. The swap on offer is "fewer processes, one less layer to runc"; the bill arrives immediately — compose files, container DNS, logging drivers, your team's `docker` muscle memory. Move when:

- **You already run Kubernetes.** Then containerd is underneath you whether you like it or not; `ctr`/`crictl` is debugging literacy, not a migration project.
- **You need rootless or edge deployments.** Rootless Docker works, but rootless nerdctl + containerd can be smoother on small machines.
- **You want the runtime without the daemon** — "load an OCI image, run it", no API server. Then containerd + nerdctl is the thinner stack.
- **You're curious.** Fine — but on a VM, not the box running your databases.

The habit worth taking from all of this: when a container misbehaves, don't stop at `docker logs`. `ps aux | grep containerd-shim`, `cat /proc/$(docker inspect -f '{{.State.Pid}}' <id>)/cgroup` and one `docker exec` into the namespaces tell you more than any dashboard.
