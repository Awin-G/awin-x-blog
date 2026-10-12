---
title: "Advanced SSH: an ssh config, tunnels, ProxyJump, and port forwarding"
description: "The ssh config file is the best productivity upgrade I ever made on the command line. Then come ssh tunnels: local, remote and dynamic port forwarding, ProxyJump for bastion hosts, ed25519 keys and ssh-agent. Concrete configs and commands, plus hardening that also improves daily UX."
pubDate: 2026-11-11
lang: en
translationKey: advanced-ssh
tags: [linux, networking, security]
featured: false
keywords:
  - ssh config
  - ssh tunnel
  - ProxyJump
  - port forwarding
  - ssh-agent
---

If I count the time I have spent typing IP addresses, long hostnames, `-i` key
paths and non-standard ports, it adds up to whole working days. The single best
productivity upgrade I ever made on the command line was not a new terminal or a
multiplexer — it was writing a `~/.ssh/config` file and letting it pay the tax for
me. From there, the same file quietly unlocks the rest of advanced SSH: **ssh
tunnels**, **ProxyJump** through a bastion, and clean **port forwarding** without
memorized one-off flags.

This is the version of SSH I actually run on my own machines. If you are still
hardening a fresh box, my [VPS hardening checklist](/posts/hardening-a-public-server/)
covers the server side; this post is the client side. And if some of your hosts
are not routable at all, a mesh overlay like my
[EasyTier setup](/posts/private-mesh-with-easytier/) is the layer above this one.

## `~/.ssh/config`: the single best productivity upgrade

SSH reads `~/.ssh/config` automatically on every invocation. Anything you would
pass as `-o Key=Value` on the command line can live there permanently, scoped to
a matching host. The result is that `ssh web` replaces a command you never want to
type again.

Here is a config I would happily hand to a new teammate:

```sshconfig
# ~/.ssh/config — chmod 600, chown you:you

# Applies to every host. Keep this small and safe.
Host *
    ServerAliveInterval 30
    ServerAliveCountMax 3
    AddKeysToAgent yes
    IdentitiesOnly yes

Host web
    HostName 203.0.113.10
    User deploy
    Port 49222
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 15

Host bastion
    HostName bastion.example.com
    User jump
    Port 22
    IdentityFile ~/.ssh/id_ed25519_bastion

Host db
    HostName 10.0.0.5
    User postgres
    ProxyJump bastion
    IdentityFile ~/.ssh/id_ed25519
```

What each directive buys you:

- **`Host`** is the alias you type, and it can match patterns (`Host *.internal`).
  It is not a hostname — it is a label.
- **`HostName`** is the real address behind the label. Now `ssh web` reaches
  `deploy@203.0.113.10:49222` without a single flag.
- **`User`** and **`Port`** remove the two most common typos in ad-hoc commands.
- **`IdentityFile`** pins which key to use, per host. No more guessing.
- **`IdentitiesOnly yes`** tells SSH to offer *only* that key, not every key the
  agent holds. This alone fixes most `Too many authentication failures` errors
  when your `ssh-agent` has a dozen keys loaded.
- **`ProxyJump`** routes through another host (more below).
- **`ServerAliveInterval 30`** sends a keepalive every 30 seconds so NAT and idle
  firewalls do not silently drop a session you left open. `ServerAliveCountMax 3`
  means you learn the link is dead within ~90 seconds instead of hanging forever.

Two habits make this safe: `chmod 600 ~/.ssh/config` (it can contain hostnames you
would rather not advertise), and `ssh -G web` to print the fully-resolved config
for a host when something is not behaving.

## ed25519 keys, ssh-agent, and hardware keys

If you are generating keys today, generate **ed25519**. It is small, fast, and
strictly better than RSA for new keys.

```bash
ssh-keygen -t ed25519 -C "deepseek@laptop-2026" -f ~/.ssh/id_ed25519
# ed25519-sk is the FIDO2 hardware-backed variant: touch required to use it
ssh-keygen -t ed25519-sk -C "deepseek yubikey" -f ~/.ssh/id_ed25519_sk
```

Set a passphrase. The comment (`-C`) is just a label so you can tell keys apart in
a log later. Then let **ssh-agent** hold the unlocked key so you type the
passphrase once per boot, not once per connection:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
ssh-add -l            # list what the agent is holding
```

The temptation next is **agent forwarding** (`ssh -A bastion`), which forwards
your local agent to the remote host so you can hop onward without copying keys.
Do not do this casually. While you are connected, root on that remote host can
talk to your forwarded agent socket and use it to authenticate *as you* to
anything your keys can reach. A compromised bastion becomes a skeleton key. The
modern answer is **ProxyJump**, which keeps the private key on your laptop and
never exposes the agent to the intermediate host.

For the machines that matter most, use a hardware key (`ed25519-sk`). The private
key never leaves the token, and every use requires a physical touch — which also
means a stolen laptop is not a stolen identity.

## Local port forwarding with `-L`

Local forwarding opens a listening socket on *your* machine and tunnels every
connection to a destination reachable from *the remote* side. This is the tool for
reaching a service that only listens on loopback.

```bash
# Syntax: -L [local_bind:]local_port:dest_host:dest_port
ssh -N -L 5432:127.0.0.1:5432 db
# in another terminal, the database now looks local:
psql -h 127.0.0.1 -p 5432 -U postgres mydb
```

The two flags worth knowing: `-N` means "do not run a shell, just forward", and
`-f` pushes it to the background so your terminal stays usable. The destination is
resolved **on the remote side**, so `-L 8080:internal-web:80 web` lets your
browser hit `http://localhost:8080` and reach a service that only exists inside
the private network. By default the listener binds to `127.0.0.1`; do not bind it
to `0.0.0.0` unless you truly mean to expose that port to your whole LAN.

## Remote port forwarding with `-R`

Remote forwarding is the mirror image: the listening socket lives on *the remote*,
and connections to it come back down the tunnel to *your* machine. This is how you
show a local dev server to someone, or reach a box behind NAT where only outbound
connections are possible.

```bash
# Syntax: -R [remote_bind:]remote_port:dest_host:dest_port
ssh -N -R 8080:localhost:3000 web
# now, on the server 'web':
curl http://127.0.0.1:8080   # served by your laptop's :3000
```

By default the remote listener is loopback-only, which is the safe default. To
bind it wider you need `GatewayPorts clientspecified` in the *server's*
`sshd_config` and an explicit bind address — think hard before doing that, because
you have just punched a hole through the firewall into your laptop.

## Dynamic forwarding with `-D`: one tunnel, any destination

Local and remote forwarding are point-to-point. **Dynamic forwarding** turns SSH
into a SOCKS5 proxy: you point your client at one local port and it can reach
*any* host the remote can reach, chosen at connect time.

```bash
ssh -N -D 1080 bastion
# every request through this proxy exits from bastion's network
curl --socks5-hostname 127.0.0.1:1080 https://internal.example.com/
```

`--socks5-hostname` is the important part: it asks the proxy to resolve DNS on
the remote side too, so your internal names never leak to your local resolver and
split-horizon DNS works. Any browser can point at `127.0.0.1:1080` as a SOCKS
proxy for the same effect. This is the fastest way to reach a whole subnet behind
a jump host without forwarding each service individually.

## ProxyJump for bastion hosts

The chain I use most: a private `db` reachable only from a public `bastion`. With
the config above, `ssh db` just works — `ProxyJump bastion` means SSH opens a TCP
connection through the bastion and then negotiates the SSH session end-to-end to
`db`. The private key stays on your machine.

On the command line, without any config, the same thing is:

```bash
ssh -J jump@bastion.example.com postgres@10.0.0.5
# chain two hops, comma-separated, for a nested network
ssh -J jump@bastion.example.com,jump2@inner-host deploy@10.0.1.20
```

Prefer `ProxyJump` over the older `ssh -A bastion` then `ssh db` pattern for two
reasons: no agent forwarding (see the risk above), and the session is end-to-end
encrypted to `db` rather than trusting the bastion's shell. If you see an old
`ProxyCommand nc %h %p` in a config, `ProxyJump` is the modern replacement — it
handles IPv6, multiple hops and retries for you.

## Hardening that also improves daily UX

A few of the changes I would make "for security" turn out to make the client
nicer too, which is why I make them first:

- **Key-only auth plus `IdentitiesOnly yes`.** Safer on the server and it silences
  the auth-failure noise on the client.
- **Non-default port, stored in `Host`.** Loaners get scanned less, and you type
  `ssh web` instead of `ssh -p 49222`.
- **`ServerAliveInterval`.** Keeps idle tunnels and long sessions alive across NAT
  timeout windows.
- **Connection multiplexing.** Add this to `Host *` and every repeated connection
  to the same host reuses the first one, which makes `scp`, `git` and nested
  `ssh` feel instant:

  ```sshconfig
  Host *
      ControlMaster auto
      ControlPath ~/.ssh/cm-%r@%h:%p
      ControlPersist 10m
  ```

- **ProxyJump instead of agent forwarding.** One fewer secret in the blast radius.
- **`ed25519-sk` for the crown jewels.** Physical touch, nothing to steal.

None of this replaces the server-side work — read the
[hardening checklist](/posts/hardening-a-public-server/) for `sshd_config`, a
default-deny firewall and fail2ban. The client config just makes the safe path
also the convenient path, which is the only kind of security that survives a busy
week.

## Frequently asked questions

**Where does `~/.ssh/config` have to live?** At exactly that path for your user; a
system-wide `/etc/ssh/ssh_config` applies to everyone. First matching value wins,
so put specific `Host` blocks before broad `Host *` ones.

**Is a tunnel secure end to end?** The SSH transport is encrypted to the remote
endpoint you specify. Data past that endpoint — say, from the server to a local
database on its own loopback — is not; it only travels as far as you asked.

**Can I keep a tunnel alive in the background?** Yes: `ssh -fN -L ...` detaches
after authentication. Pair it with `ServerAliveInterval` and autossh if you need
it to survive reconnects.

**Why is `ProxyJump` better than `ProxyCommand`?** It is the same mechanism with
the boring parts handled — multiple hops, IPv6, and no external `nc` binary to get
wrong.
