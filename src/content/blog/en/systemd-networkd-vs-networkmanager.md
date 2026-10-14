---
title: "systemd-networkd vs NetworkManager: which one should configure your network?"
description: "A hands-on comparison of systemd-networkd and NetworkManager with real output: .network files vs nmcli connection profiles, the same static IP configured both ways, how each feeds systemd-resolved, and why running both is a bad idea."
pubDate: 2027-01-30
lang: en
translationKey: systemd-networkd-vs-networkmanager
tags: [networking, systemd]
featured: false
keywords:
  - systemd-networkd
  - NetworkManager
  - Linux network configuration
  - .network file
  - nmcli
---

Every Linux box with a network has *something* writing the IP addresses. Usually
it is not you and not a boot script. It is one of two daemons, and knowing which
one you are running — and how it thinks — is the difference between a one-line
change and an afternoon of fighting.

This is my Arch desktop, right now, and it uses **NetworkManager**:

```bash
$ systemctl is-active NetworkManager systemd-networkd systemd-resolved
active
inactive
active
```

`systemd-networkd` is not just inactive here, it is **disabled** — `UnitFileState`
says so, which means nothing in my default boot target will ever start it:

```bash
$ systemctl is-enabled NetworkManager systemd-networkd systemd-resolved
enabled
disabled
enabled
```

That is the normal arrangement on a laptop: one daemon owns networking, and the
other is installed (it comes with systemd, you cannot uninstall it separately)
but switched off. Below is which one you want, how they differ in *shape*, and what
happens if you run both. Every command was really run; where I had to sandbox
something, I say so.

## What each one actually is

**systemd-networkd** is the network configuration daemon that ships as part of
systemd. It is small (a couple of MB of RSS when idle), has no interactive front
end, and is *declarative*: you drop `.network` files into
`/etc/systemd/network/`, it notices, and it converges the kernel to match. How
integration-happy it is shows in what systemd ships for containers — on this very
box, `/usr/lib/systemd/network/80-container-host0.network` is a real file
configuring DHCP on the container side of the `systemd-nspawn` veth link. It is
built for machines that are configured once and never roam: servers, VMs,
containers, network namespaces.

**NetworkManager** is a *stateful* daemon with a complete API. It keeps live
objects — devices, connections, active connections — and a connection is a
profile: "SSID X with this key, or this Ethernet with that static address", plus
the logic that decides *which* profile to apply *now*: the strongest AP nearby,
the VPN that should follow this SSID, the roaming rules when you walk out of
range. `nmcli` is just a CLI client for that state, alongside a D-Bus API, a
curses TUI (`nmtui`), and a desktop applet.

Short version: networkd configures interfaces, NetworkManager manages
connectivity. What makes NetworkManager big — stored credentials, VPN
autoconnect, dispatcher scripts reacting to link-up — is work networkd does not
attempt. What makes networkd small — no D-Bus, no plugin stack, runs in a network
namespace as an ordinary process — is work NetworkManager is not built for.

## The config model: `.network` files vs connection profiles

The second difference is the one you feel daily, because it decides how a change
is *represented on disk*.

networkd's config is **plain declarative files**, lexicographically ordered,
loaded from `/etc/systemd/network/` (and `/usr/lib/systemd/network/` for vendor
config):

```ini
# /etc/systemd/network/10-static.network
[Match]
Name=netdemod

[Network]
Address=10.42.0.5/24
Gateway=10.42.0.1
DNS=10.42.0.1
```

NetworkManager's config is a **stateful profile**, which the `keyfile` plugin
persists as an `.nmconnection` file under
`/etc/NetworkManager/system-connections/` — a completely different file format,
with a `uuid`, a `type`, and a `method=` field that says whether the profile is
manual, DHCP, or shared. That on-disk format matters: on this machine
`/etc/NetworkManager/system-connections/` is root-only (I could not read it, and
should not), and the profile you create with one command is the file the daemon
will re-apply at every boot.

On top of both sits **netplan** on Ubuntu/Debian: a thin YAML front end whose job
is to *render into either* networkd `.network` files or NetworkManager keyfiles,
depending on the `renderer:` you pick. Netplan is not a third daemon, and "netplan
apply" is one of the two above.

## The same static IP, both ways

I configured the identical policy — `10.42.0.5/24`, gateway `10.42.0.1`, DNS
`10.42.0.1` — with each tool against a throwaway `dummy` interface, and both
applied it. Two honest caveats: my desktop runs NetworkManager, so the networkd
half ran inside a throwaway sandbox, and I could not touch a *real* NIC without
root. The interfaces are `netdemod` (networkd) and `nmdemo` (NetworkManager).

<figure>
<svg viewBox="0 0 680 300" width="100%" role="img" aria-label="The same static IP written twice: as a systemd-networkd .network file in /etc/systemd/network, and as a NetworkManager keyfile in /etc/NetworkManager/system-connections, both ending up as 10.42.0.5/24 with gateway and DNS 10.42.0.1" xmlns="http://www.w3.org/2000/svg" style="max-width:680px">
  <defs>
    <marker id="arrow2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="170" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#0f766e">systemd-networkd</text>
  <text x="510" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#0f766e">NetworkManager</text>
  <rect x="24" y="38" width="292" height="150" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="36" y="60" font-family="monospace" font-size="12" fill="currentColor">/etc/systemd/network/</text>
  <text x="36" y="80" font-family="monospace" font-size="12" fill="currentColor">  10-static.network</text>
  <text x="36" y="106" font-family="monospace" font-size="12" fill="#0f766e">[Match] Name=netdemod</text>
  <text x="36" y="126" font-family="monospace" font-size="12" fill="#0f766e">[Network] Address=10.42.0.5/24</text>
  <text x="36" y="146" font-family="monospace" font-size="12" fill="#0f766e">Gateway=10.42.0.1  DNS=10.42.0.1</text>
  <text x="36" y="170" font-family="monospace" font-size="11" fill="currentColor">declarative, ordered, no state</text>
  <rect x="364" y="38" width="292" height="150" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="376" y="60" font-family="monospace" font-size="12" fill="currentColor">/etc/NetworkManager/</text>
  <text x="376" y="80" font-family="monospace" font-size="12" fill="currentColor">  system-connections/static-demo</text>
  <text x="376" y="106" font-family="monospace" font-size="12" fill="#0f766e">[ipv4] method=manual</text>
  <text x="376" y="126" font-family="monospace" font-size="12" fill="#0f766e">address1=10.42.0.5/24</text>
  <text x="376" y="146" font-family="monospace" font-size="12" fill="#0f766e">gateway=10.42.0.1  dns=10.42.0.1</text>
  <text x="376" y="170" font-family="monospace" font-size="11" fill="currentColor">a profile with uuid, tracked live</text>
  <line x1="170" y1="188" x2="170" y2="222" stroke="currentColor" stroke-width="2" marker-end="url(#arrow2)"/>
  <line x1="510" y1="188" x2="510" y2="222" stroke="currentColor" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="170" y="214" text-anchor="middle" font-family="monospace" font-size="11" fill="currentColor">networkctl status</text>
  <text x="510" y="214" text-anchor="middle" font-family="monospace" font-size="11" fill="currentColor">nmcli device show</text>
  <rect x="150" y="226" width="380" height="58" rx="10" fill="#0f766e"/>
  <text x="340" y="250" text-anchor="middle" font-family="monospace" font-size="13" fill="#ffffff">10.42.0.5/24</text>
  <text x="340" y="272" text-anchor="middle" font-family="monospace" font-size="12" fill="#ffffff">gw 10.42.0.1 · dns 10.42.0.1</text>
</svg>
<figcaption>The same intent, two representations. `systemd-networkd` keeps it as a
declarative <code>.network</code> file that is applied as-is and re-applied whenever the
link changes; NetworkManager keeps a stateful connection profile, written to disk as a
keyfile, that the daemon matches against devices and activates when it decides the
moment is right.</figcaption>
</figure>

### networkd: write the file, watch it converge

I dropped that file into an isolated network namespace (an `unshare -Urnm`
sandbox, with a private `sysfs` mounted so `networkd` could see the interface —
that step is the one everybody forgets). `networkd` started, saw the link appear,
and configured it:

```text
$ ip -brief addr show netdemod
netdemod         UNKNOWN        10.42.0.5/24 fe80::d45e:93ff:feba:8470/64

$ ip -4 route show
default via 10.42.0.1 dev netdemod proto static
default via 10.42.0.1 dev lo proto static
10.42.0.0/24 dev netdemod proto kernel scope link src 10.42.0.5

$ networkctl status netdemod
* 2: netdemod
                       State: routable (configured)
                Network File: /etc/systemd/network/10-static.network
                     Address: 10.42.0.5
                     Gateway: 10.42.0.1
                         DNS: 10.42.0.1
```

Note what `Network File:` gives you: the daemon names the exact declarative file
behind the current state. That is the debugging story — you never wonder which of
three files won, because the order is documented and the link cites its source.

The other half of "declarative" is that the state is *enforced*, not set once. I
deleted the address by hand behind networkd's back, then asked for a reconfigure:

```bash
$ ip addr del 10.42.0.5/24 dev netdemod
$ networkctl reconfigure netdemod
$ ip -brief addr show netdemod
netdemod         UNKNOWN        10.42.0.5/24 fe80::cca6:85ff:fe19:902f/64
```

The address came back. Anything that fights your `.network` file loses on the
next reconfigure — including, in principle, another network daemon.

### NetworkManager: create a profile, watch it activate

Same address, this time from `nmcli` inside a Debian 13 container (NetworkManager
plus a private D-Bus, with `eth0` left alone). From the *profile*'s point of
view, "connected" is a runtime state that has to be achieved, not a fact:

```bash
$ nmcli con add type dummy ifname nmdemo con-name static-demo \
    ip4 10.42.0.5/24 gw4 10.42.0.1 ipv4.dns 10.42.0.1
Connection 'static-demo' (31b43c67-ec5b-4a4d-919c-b4b23220847a) successfully added.

$ nmcli con up static-demo
Connection successfully activated

$ nmcli -f GENERAL.TYPE,GENERAL.STATE,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS device show nmdemo
GENERAL.TYPE:                           dummy
GENERAL.STATE:                          100 (connected)
IP4.ADDRESS[1]:                         10.42.0.5/24
IP4.GATEWAY:                            10.42.0.1
IP4.DNS[1]:                             10.42.0.1
```

And the profile lands on disk immediately, in NetworkManager's own format —
`0600`, because the same file format also has to hold Wi-Fi PSKs, which is
exactly why my host's profiles are the directory I cannot read:

```ini
# /etc/NetworkManager/system-connections/static-demo.nmconnection
[connection]
id=static-demo
uuid=31b43c67-ec5b-4a4d-919c-b4b23220847a
type=dummy
interface-name=nmdemo

[ipv4]
address1=10.42.0.5/24
dns=10.42.0.1;
gateway=10.42.0.1
method=manual
```

Two differences worth naming. First, NetworkManager needed a real *activation
step*: a profile is inert until something brings it up, and my first attempt
failed with `device 'nmdemo' not compatible with connection 'static-demo': The
connection was not a dummy connection`, because `type=dummy` was missing — it
matched type against device and refused, exactly the stateful reasoning networkd
does not do. Second, that `uuid`: profiles are objects with identity, not files.

### A real profile from the machine I am typing on

```bash
$ nmcli -f connection.id,connection.type,802-11-wireless.ssid,\
802-11-wireless.mode,802-11-wireless-security.key-mgmt,ipv4.method con show 317_NO_AUTH
connection.id:                          317_NO_AUTH
connection.type:                        802-11-wireless
802-11-wireless.ssid:                   317_NO_AUTH
802-11-wireless.mode:                   infrastructure
802-11-wireless-security.key-mgmt:      wpa-psk
ipv4.method:                            auto
```

That is the Wi-Fi connection this box is using right now, minus anything secret:
`key-mgmt` is `wpa-psk`, so the file also holds the password. And notice
`interface-name: --` — the profile is not bound to one NIC, it binds to whatever
wifi device is available. That is roaming, stated as data.

## Which distro defaults to which

The split tracks the machine's job:

- **NetworkManager**: Fedora and RHEL 8/9 on desktop and server, Debian and
  Ubuntu desktops, openSUSE, Arch desktop spins. RHEL switched in 7 and has gone
  further since: its own docs tell you to use `nmcli` instead of editing files.
- **systemd-networkd**: Ubuntu Server and Debian through netplan (whose default
  renderer is networkd), Fedora CoreOS and RHEL CoreOS through Ignition, Debian
  minimal/server installs, and essentially every container base image — which is
  why the `.network` examples systemd ships itself are container- and
  VM-flavoured.
- **Neither**: plenty of minimal images and most Docker containers just run `ip`
  commands from an entrypoint and never install a daemon at all.

So on Ubuntu Server you netplan, on RHEL you `nmcli`, and those are dialects of
the same two daemons. Linux network configuration is "learn one of these two",
not "learn all three".

## How each one feeds systemd-resolved

Both daemons can hand DNS to **systemd-resolved**, but by different routes, and
the result shows in `/etc/resolv.conf`. networkd does it through a privileged
hook: it writes per-link DNS into `/run/systemd/resolve/`, and `resolved` picks up
per-interface servers, which is what makes split DNS and DoT possible. On my host
`resolvectl status` shows the other model — NetworkManager *and*
`systemd-resolved` both running, wired together in the cheapest possible way:

```text
$ resolvectl status
Global
           Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
    resolv.conf mode: foreign
  Current DNS Server: 223.5.5.5
         DNS Servers: 223.5.5.5 119.29.29.29

Link 2 (wlp2s0)
    Current Scopes: DNS LLMNR/IPv4 LLMNR/IPv6 mDNS/IPv4 mDNS/IPv6
         DNS Servers: 223.5.5.5 119.29.29.29
       Default Route: yes

$ cat /etc/resolv.conf
# Generated by NetworkManager
nameserver 223.5.5.5
nameserver 119.29.29.29
```

`resolv.conf mode: foreign` means `resolved` is *not* managing `/etc/resolv.conf`
— NetworkManager wrote that file itself. It still sees the servers because
NetworkManager pushed them over D-Bus, so you get the cache and per-link
accounting, but not the `127.0.0.53` stub, hence no split DNS or DoT per app. That
one line tells you which model your box is in. The full mechanics are in
[systemd-resolved in practice](/posts/systemd-resolved/).

## Why running both is a bad idea

Both write to the same netlink objects — addresses, routes, metrics — and neither
knows about the other's intent. You get flapping addresses, a default route that
appears and disappears, and DNS that points at whatever each one last believed.
The symptom is rarely "it is broken"; it is "the network blinks every few
minutes", and the fix is always to pick one and disable the other.

I did not run them simultaneously — on my desktop networkd is disabled, so it
never touches an interface — but this box shows the *shape* of the problem
anyway. Docker and a VPN also configure interfaces here, and NetworkManager's
reaction is to put everything it did not configure into its own "not mine"
bucket:

```bash
$ nmcli device status
DEVICE             TYPE      STATE                   CONNECTION
wlp2s0             wifi      connected               317_NO_AUTH
docker0            bridge    connected (externally)  docker0
lo                 loopback  connected (externally)  lo
tun0               tun       connected (externally)  tun0
04:D3:B5:46:EB:FA   bt        disconnected             --
veth6f9fc93        ethernet  unmanaged                --
veth9be9eb8        ethernet  unmanaged                --
```

That `connected (externally)` / `unmanaged` distinction is NetworkManager
declining ownership: it observes and does not act. It is right for `docker0` and
`tun0`, and it is how two managers are *supposed* to coexist — give each an
exclusive set of interfaces, via `NetworkManager.conf` `[device] managed=0` or a
netplan `renderer:` split, and never let both claim the same NIC.
`systemd-resolved` is fine to share, because it is a *service* both consume, not
a manager of interfaces.

## So which one should you use?

The honest recommendation is mostly "keep what your distro shipped", and change
only when you have a reason:

- **Servers, VMs, containers, network namespaces → networkd, or no daemon at
  all.** Static IPs belong in a `.network` file (or an `ip` command) because
  nothing is roaming. networkd is also the one that behaves inside a network
  namespace, as the sandbox above shows — which matters if you test overlays the
  way I do in [network namespaces and veth](/posts/network-namespaces-and-veth/).
- **Laptops, desktops, anything with Wi-Fi or a VPN → NetworkManager.** Every
  property it has that networkd lacks — roaming, secrets, D-Bus control — is one
  you will use within a week.
- **Mixing both → no**, unless you partition interfaces explicitly and document
  it: the failure mode is intermittent and looks like hardware.
- **Switching for its own sake → no.** There is no prize for `nmcli` on a box
  that boots from netplan.

One last perspective: what matters is *who converges*. networkd holds a desired
state and pushes the kernel toward it, which is why `networkctl reconfigure`
resurrected an address I deleted. NetworkManager holds a desired *connection* and
pushes events into it, which is why a second activation of the same profile is a
no-op. Both models work. They just do not work on the same interface at the same
time.
