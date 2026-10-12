---
title: "Docker networking explained: what your container actually sees"
description: "A hands-on Docker networking walk-through from inside the container: how docker0 hands out IPs and NATs to the internet, why veth pairs glue eth0 to the bridge, what a user-defined bridge network adds (embedded DNS), what -p really does, host/none/macvlan/overlay, and how to debug it."
pubDate: 2026-12-06
lang: en
translationKey: docker-networking
tags: [networking, devops, self-hosting]
featured: true
keywords:
  - Docker networking
  - docker bridge network
  - container networking
  - docker0
  - veth
---

Most explanations of **Docker networking** start at the daemon and the flags. I find it clearer to start on the other side of the wall: inside the container. From there, container networking is a surprisingly small set of things — a network interface called `eth0`, a default route pointing at a gateway you don't recognise, a nameserver that may or may not exist, and a host-side bridge called `docker0`. Once you can see those four pieces from both sides, every "why can't my containers talk to each other" question has an answer.

Everything below is real output from real containers on this machine (Docker 29.9.0, kernel 6.x, `iptables v1.8.13 (nf_tables)`), created and destroyed as I wrote it. Nothing here needs `--privileged`.

## The default bridge: docker0 gives the container an address and a route

Every Docker host has a `docker0` interface. It is a plain Linux bridge, and it is the default **docker bridge network**. Docker's own description of it is dense but complete:

```console
$ docker network inspect bridge --format '{{json .Options}}'
{"com.docker.network.bridge.default_bridge":"true",
 "com.docker.network.bridge.enable_icc":"true",
 "com.docker.network.bridge.enable_ip_masquerade":"true",
 "com.docker.network.bridge.host_binding_ipv4":"0.0.0.0",
 "com.docker.network.bridge.name":"docker0",
 "com.docker.network.driver.mtu":"1500"}
```

Three of those matter: the bridge is literally named `docker0`, inter-container communication is on, and IP masquerade is on — that last one is the NAT that gets the container to the internet. On the host it looks like any other bridge:

```console
$ ip -br addr show docker0
docker0          UP    172.17.0.1/16 fe80::24be:f0ff:fec9:94cf/64
```

Run a container on it and look from the inside:

```console
$ docker run --rm alpine sh -c 'ip addr show eth0; echo; ip route; echo; cat /etc/resolv.conf'
2: eth0@if74: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1500 qdisc noqueue state UP
    link/ether b6:b1:4e:e3:d7:44 brd ff:ff:ff:ff:ff:ff
    inet 172.17.0.6/16 brd 172.17.255.255 scope global eth0
       valid_lft forever preferred_lft forever

default via 172.17.0.1 dev eth0
172.17.0.0/16 dev eth0 scope link  src 172.17.0.6

nameserver 223.5.5.5
nameserver 119.29.29.29
```

Read that carefully, because it answers most questions up front:

- The container has **one** interface, `eth0`, with an address drawn from `172.17.0.0/16`. Docker's IPAM handed it out; it looks like DHCP but it is not — there is no DHCP server. The daemon picks an address and configures the interface directly.
- The default route points at `172.17.0.1`, which is `docker0` on the host. The bridge is the gateway.
- The nameserver is the host's resolver (`223.5.5.5` here), **not** a Docker DNS server. On the default bridge, `nslookup` of another container's name goes to the public internet and fails.
- `eth0@if74` is the clue that this is one half of a **veth** pair — hold that thought.

## veth pairs: how eth0 reaches docker0

A veth pair is a virtual cable with two ends: a packet that goes in one end comes out the other, as if they were wired together. Docker creates one pair per container network endpoint. One end stays in the host and is enslaved to the bridge; the other end is moved into the container's network namespace and renamed `eth0`.

On the host you see the ends but not the mapping, so you have to match them by index:

```console
$ ip -o link | grep veth
65: vethffd2a6e@if2: ... master docker0 state UP ...
69: veth8ba5050@if2: ... master br-3030e858b1f6 state UP ...
70: vethed0a861@if2: ... master br-3030e858b1f6 state UP ...

$ docker exec dnet-a ip -o addr show eth0
2: eth0    inet 172.28.0.2/16 brd 172.28.255.255 scope global eth0

$ docker exec dnet-a cat /sys/class/net/eth0/ifindex /sys/class/net/eth0/iflink
2
69
```

`eth0` says `@if2` on the host side, and its host peer index is **69** — exactly `veth8ba5050` above, enslaved to bridge `br-3030e858b1f6`. So the path is: `eth0` in the netns → veth → bridge on the host. The bridge MAC is what the container ARPs for:

```console
$ docker exec dnet-a ip neigh
172.28.0.1 dev eth0 lladdr 52:4e:3e:33:7e:4a STALE
```

<figure>
<svg viewBox="0 0 720 200" width="100%" role="img" aria-label="A container network namespace holding eth0, joined by a veth pair to the docker0 Linux bridge on the host; the bridge is the default gateway, masquerading traffic via iptables/nftables before it leaves through the physical NIC to the internet.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.75">
    <rect x="8" y="34" width="604" height="140" rx="10"/>
    <rect x="22" y="72" width="152" height="100" rx="8" stroke-dasharray="6 4"/>
    <rect x="34" y="92" width="130" height="42" rx="6"/>
    <rect x="214" y="92" width="112" height="48" rx="6"/>
    <rect x="340" y="92" width="112" height="48" rx="6"/>
    <rect x="466" y="92" width="112" height="48" rx="6"/>
    <circle cx="662" cy="116" r="40"/>
    <path d="M174 116 H214"/>
    <path d="M326 116 H340"/>
    <path d="M452 116 H466"/>
    <path d="M578 116 H622" stroke="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui,sans-serif" font-size="12">
    <text x="18" y="54">host network namespace (kernel)</text>
    <text x="34" y="88">container netns</text>
    <text x="48" y="110">eth0</text>
    <text x="48" y="127" font-size="11">172.17.0.6/16</text>
    <text x="34" y="158" font-size="11">default via 172.17.0.1</text>
    <text x="228" y="114">docker0</text>
    <text x="228" y="131" font-size="11">172.17.0.1/16</text>
    <text x="172" y="108" font-size="11" fill="#0f766e">veth pair</text>
    <text x="348" y="114" font-size="11">MASQUERADE</text>
    <text x="348" y="131" font-size="11">nat/POSTROUTING</text>
    <text x="480" y="114">physical NIC</text>
    <text x="480" y="131" font-size="11">192.168.1.70</text>
    <text x="636" y="120" font-size="12">Internet</text>
  </g>
</svg>
<figcaption>One container's egress path: eth0 in its own network namespace, a veth pair, the docker0 bridge, the NAT rule Docker writes, then the physical interface.</figcaption>
</figure>

## User-defined bridge networks and Docker's embedded DNS

The default bridge works, but it is deliberately limited. The moment you create your own **user-defined bridge**, two things change: Docker gives the bridge a name you choose and a subnet you can pin, and it turns on an embedded DNS server that resolves container names.

```console
$ docker network create --driver bridge --subnet 172.28.0.0/16 --gateway 172.28.0.1 dnet
3030e858b1f67d9676d71b96ec3f0a7a4b9451f85585bc4a54e9ce92c70982ea
$ docker run -d --name dnet-a --network dnet --hostname alpha alpine sleep 3600
$ docker run -d --name dnet-b --network dnet --hostname beta  alpine sleep 3600
```

The container's resolv.conf is the tell:

```console
$ docker exec dnet-a cat /etc/resolv.conf
nameserver 127.0.0.11
options ndots:0
```

`127.0.0.11` is not a real address — it is a magic address that Docker's embedded DNS listens on inside that container's namespace. It resolves container names and network aliases to their current IPs:

```console
$ docker exec dnet-a nslookup beta
Server:		127.0.0.11
Address:	127.0.0.11:53
Name:	beta
Address: 172.28.0.3

$ docker exec dnet-a ping -c 2 beta
64 bytes from 172.28.0.3: seq=0 ttl=64 time=0.156 ms
```

On the default bridge there is no `127.0.0.11`, so the same query goes upstream and dies:

```console
$ docker run --rm alpine nslookup dnet-a
Server:		223.5.5.5
Address:	223.5.5.5:53
** server can't find dnet-a: NXDOMAIN
```

<figure>
<svg viewBox="0 0 640 170" width="100%" role="img" aria-label="Left: a container on the default bridge queries the host's upstream resolver and gets NXDOMAIN for another container's name. Right: a container on a user-defined bridge queries Docker's embedded DNS at 127.0.0.11 and gets the peer's address.">
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.7">
    <rect x="8" y="16" width="300" height="136" rx="10"/>
    <rect x="24" y="56" width="92" height="34" rx="6"/>
    <rect x="160" y="56" width="132" height="34" rx="6"/>
    <path d="M116 73 H160"/>
    <rect x="332" y="16" width="300" height="136" rx="10" stroke="#0f766e"/>
    <rect x="348" y="56" width="92" height="34" rx="6"/>
    <rect x="484" y="56" width="132" height="34" rx="6"/>
    <path d="M440 73 H484" stroke="#0f766e"/>
  </g>
  <g fill="currentColor" font-family="system-ui,sans-serif" font-size="12">
    <text x="24" y="40">default bridge</text>
    <text x="34" y="77">container</text>
    <text x="170" y="77" font-size="11">223.5.5.5 upstream</text>
    <text x="24" y="128" font-size="11">nslookup dnet-a -&gt; NXDOMAIN</text>
    <text x="348" y="40" fill="#0f766e">user-defined bridge</text>
    <text x="358" y="77">container</text>
    <text x="494" y="77" font-size="11">127.0.0.11 embedded</text>
    <text x="348" y="128" font-size="11">nslookup beta -&gt; 172.28.0.3</text>
  </g>
</svg>
<figcaption>Name resolution is the real difference between the default and a user-defined bridge: the embedded DNS at 127.0.0.11 only exists on the latter.</figcaption>
</figure>

That is why service discovery "just works" in Compose: every service joins a user-defined network, and every service name becomes a DNS name.

## Publishing ports: what `-p` actually does

`-p 127.0.0.1:18080:80` looks like a single act. It is two, and knowing which is which explains most port-conflict and traffic-not-arriving bugs.

The first is userland: the daemon binds the host socket and hands the listening file descriptor to `docker-proxy`.

```console
$ docker run -d --name dnet-web --network dnet -p 127.0.0.1:18080:80 nginx:1.27-alpine
$ ss -ltnp | grep 18080
LISTEN 0 4096 127.0.0.1:18080 0.0.0.0:*
$ ps -eo pid,args | grep 'host-port 18080'
155140 /usr/bin/docker-proxy -proto tcp -host-ip 127.0.0.1 -host-port 18080 \
       -container-ip 172.28.0.4 -container-port 80 -use-listen-fd
```

The `-use-listen-fd` flag is a newer detail: `docker-proxy` did **not** bind the port itself — dockerd did, and passed the descriptor down.

The second path is kernel NAT, and only that path matters for traffic that doesn't hit the host's loopback socket. Docker writes a DNAT rule into the `nat` table:

```console
$ iptables -t nat -L DOCKER -n -v
Chain DOCKER (2 references)
 pkts bytes target prot opt in                    out  source     destination
    0     0 DNAT   tcp  --  !br-3030e858b1f6     *    0.0.0.0/0  127.0.0.1   tcp dpt:18080 to:172.28.0.4:80
```

Read the fields: `!br-3030e858b1f6` means "not arriving from the container's own bridge" (that case is handled separately, for hairpin traffic), `127.0.0.1` is the bind address I chose, `dpt:18080` is the published port, and `to:172.28.0.4:80` is the container. Publish to `0.0.0.0` and this rule becomes reachable from your LAN too, which is exactly why `-p 8080:80` on a VPS is a security decision, not a convenience.

## NAT to the outside: MASQUERADE and the rules Docker writes

Outbound traffic needs the reverse trick. The container has a private address, but the internet has to see the host's public address, so Docker writes one **MASQUERADE** rule per bridge subnet into `POSTROUTING`:

```console
$ iptables -t nat -L POSTROUTING -n -v | grep 172.28
    0     0 MASQUERADE  all  --  *  !br-3030e858b1f6  172.28.0.0/16  0.0.0.0/0

$ docker exec dnet-a ping -c 3 1.1.1.1     # a ping from inside the container

$ iptables -t nat -L POSTROUTING -n -v | grep 172.28
    1    84 MASQUERADE  all  --  *  !br-3030e858b1f6  172.28.0.0/16  0.0.0.0/0
```

The counter went from 0 to 1 packet, 84 bytes. And the container's view of the outside confirms the rewrite:

```console
$ docker exec dnet-a wget -qO- http://ipv4.icanhazip.com
182.150.122.48
```

That is the host's public address, not `172.28.0.2`. "Is my container NATted?" is answered by one counter on that rule. This is the same address-rewriting machinery as ordinary home NAT — I went through its failure modes in [how NAT traversal actually works](/posts/nat-traversal-explained/), and the container case is the easy version of it.

There is one caveat worth stating plainly: on this host, `iptables` is the nftables backend, and Docker reports `Firewall Backend: iptables`. So the rules physically live in a `nft` table:

```console
$ nft list tables
table ip filter
table ip6 filter
table ip nat
table ip6 nat
table ip raw
```

Reading them back through `iptables` works, but nft itself warns you off: `# Warning: table ip nat is managed by iptables-nft, do not touch!`. If you write firewall rules by hand, don't edit Docker's chains — use `DOCKER-USER`, which Docker creates empty precisely so it survives reloads. Note also that the `FORWARD` chain's policy is `DROP`, and Docker's `DOCKER-FORWARD`/`DOCKER` chains add the `ACCEPT`s that make published ports work. That is why a hostile `FORWARD` policy from ufw or firewalld can silently break container networking.

Two honest notes about getting this output. First, as an unprivileged user you cannot read netfilter state at all:

```console
$ iptables -t nat -L -n
iptables v1.8.13 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)
```

You need `CAP_NET_ADMIN`. A capability-scoped container is a legitimate way to read it without root — `--cap-add=NET_ADMIN --network host`, which is a capability, not `--privileged` — and that is how I produced the tables above.

## host, none, macvlan and overlay

The four network modes you'll actually choose between behave very differently:

**`--network none`** gives the container a loopback and nothing else. There is no route, so even DNS dies. Useful for batch jobs you want to guarantee can't phone home:

```console
$ docker run --rm --network none alpine ip -o addr show
1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
1: lo    inet6 ::1/128 scope host
```

**`--network host`** removes the container's network namespace entirely. The process sees the host's real interfaces — `wlp2s0`, `tun0`, the host routes — and `-p` becomes meaningless (the container's port *is* the host's port). Isolation: zero.

**macvlan** gives the container a real address on your physical LAN, with its own MAC:

```console
$ docker network create -d macvlan --subnet 192.168.1.0/24 \
      --gateway 192.168.1.1 -o parent=wlp2s0 mvn
$ docker run --rm --network mvn alpine ip -o addr show eth0
97: eth0    inet 192.168.1.2/24 brd 192.168.1.255 scope global eth0
```

It looks perfect. It usually is not on Wi-Fi: my test container had a valid LAN address and **100% packet loss** to both the host and the LAN gateway, because an access point drops frames whose source MAC isn't the one that associated. And by design, a macvlan container cannot reach its own host at all.

**overlay** is the swarm-scope option: containers get addresses on a private, cross-host subnet, and the node tunnels them.

```console
$ docker network create -d overlay --attachable ovl
$ docker exec ovl-a ip -o addr show eth0
108: eth0    inet 10.0.1.2/24 brd 10.0.1.255 scope global eth0
```

Each node also gets a `docker_gwbridge` bridge and a veth per container for egress, while the VXLAN device itself lives in a network namespace only root can list. If you don't need multi-host addressing, a user-defined bridge is simpler and just as fast.

## How a container reaches the host, and the host reaches a container

Container to host: the gateway *is* the host. `172.28.0.1` on my user-defined network and `172.17.0.1` on the default bridge are both host addresses, so they're pingable and reachable. For a stable name, add one:

```console
$ docker run --rm --network dnet --add-host host.docker.internal:host-gateway \
    alpine getent hosts host.docker.internal
172.17.0.1        host.docker.internal
```

The gotcha: `host-gateway` resolves to the **default bridge** gateway (`172.17.0.1`), not to your custom network's gateway, and on Linux nothing defines `host.docker.internal` for you — Docker Desktop does, the Linux daemon does not.

Host to container: the host has a route into every bridge subnet, so it can reach a container address directly, with no `-p` at all:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://172.28.0.4:80
200
```

That works because the route `172.28.0.0/16 dev br-3030e858b1f6` is local to the host. It is *not* a substitute for publishing — no other machine can do it — but it's why `curl <container-ip>` from the host is the fastest way to check whether a problem is the app or the port forward. Related: in [WireGuard in a container](/posts/wireguard-in-containers/) the same "which namespace am I in" question decides whether a tunnel is useful or merely healthy.

## Debugging container networking: a repeatable order

Work outward from the container, and stop at the first layer that breaks:

1. **Is the container even on the network?** `docker network inspect <net>` lists each attached container with its MAC and `IPv4Address`. If it's missing, it's not a networking bug.
2. **Does the container have an address and a route?** `docker exec <c> ip addr; ip route`. No route means no gateway or a `none` network.
3. **Does DNS resolve?** `docker exec <c> nslookup <other-container>`. Remember the `127.0.0.11` rule: names only resolve on a user-defined network.
4. **Is it layer 2?** On the host, `ip -o link | grep veth` plus `bridge link show` to see which veth is enslaved to which bridge, then match the index to `eth0@ifN` inside the container.
5. **Is it NAT or publishing?** Read the rules and, more usefully, the counters: `iptables -t nat -L POSTROUTING -n -v` and `-L DOCKER -n -v`. A `DNAT` rule you didn't expect means another service already owns the port — the conflict I hit at `8080`.

About `nsenter`: it's the right tool when you have root, because it drops you into the container's namespaces directly — `nsenter -t $(docker inspect -f '{{.State.Pid}}' <c>) -n ip addr`. As an unprivileged user it just fails:

```console
$ nsenter -t $(docker inspect -f '{{.State.Pid}}' dnet-a) -n ip -o addr show
nsenter: reassociate to namespaces failed: Operation not permitted
```

Two unprivileged equivalents cover almost every case. `docker exec` runs a command *in* the namespace, and `--network container:<name>` joins another container's namespace outright:

```console
$ docker run --rm --network container:dnet-a alpine sh -c 'hostname; ip -o addr show eth0'
alpha
2: eth0    inet 172.28.0.2/16 brd 172.28.255.255 scope global eth0
```

## The mental model, in one paragraph

A container's `eth0` is one end of a **veth** pair; the other end is enslaved to a Linux bridge on the host. The **default bridge** is `docker0` at `172.17.0.1/16`: it makes itself the gateway, NATs outbound traffic with a `MASQUERADE` rule, and has no name resolution. A **user-defined bridge** is the same machinery with a subnet you control and embedded DNS at `127.0.0.11`. `-p` is two mechanisms — a `DNAT` rule and a `docker-proxy` socket — and only the first matters off loopback. `host`, `none`, `macvlan` and `overlay` swap pieces out.
