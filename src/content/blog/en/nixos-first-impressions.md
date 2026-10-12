---
title: "NixOS first impressions: declarative, reproducible, and occasionally maddening"
description: "A field report after a month of running NixOS: the appeal of declaring a whole system in one file, what a configuration.nix actually looks like, the real learning curve around the Nix language and Nix flakes, where it shines on servers and CI, where it hurts, and an honest recommendation."
pubDate: 2026-11-23
lang: en
translationKey: nixos-first-impressions
tags: [linux, devops, self-hosting]
featured: false
keywords:
  - NixOS
  - declarative configuration
  - reproducible builds
  - Nix flakes
  - rollback
---

I have rebuilt my share of Linux boxes by hand, and I have automated the rest
with Ansible and shell scripts. So when people kept telling me that **NixOS** was
the end state — that you stop *configuring* a machine and start *describing* it —
I wanted to know whether that was real or just a very convincing religion. I gave
it a month on a spare box and a container. This is a first-impressions field
report, not a tutorial: what the appeal actually is, what the config looks like,
where it earns its keep, and where it made me want to throw the laptop.

## The appeal: one file, and a machine you can rebuild exactly

The promise of **declarative configuration** is easy to state and hard to overstate.
On NixOS, the entire system — packages, services, users, kernel parameters, the
firewall, your shell — lives in a handful of declarative files, primarily
`/etc/nixos/configuration.nix`. You do not `apt install` things. You *describe*
the machine, run one command, and the system is built to match.

The reason that is different from a provisioning script is the same reason
**reproducible builds** matter: Nix builds every package from a description,
in an isolated sandbox, and stores the result in `/nix/store` under a path derived
from a hash of all its inputs. Two machines that ask for the same derivation get
the *same bytes* — not "the same versions, probably." That hash-addressed store is
the whole trick. It is also why the second property, atomic rollback, is almost
free.

Every time you run `nixos-rebuild`, Nix builds a new, immutable *generation* of
the system and adds it to the boot menu. If the new generation is broken — an
update bricks networking, a service refuses to start — you do not debug it at 2
a.m. You pick the previous generation at the bootloader, or run:

```bash
sudo nixos-rebuild switch --rollback
```

One command, back to a known-good system, in seconds. No drift to reconcile,
because there was never any drift: the running system *is* the build output. That
is the part that genuinely changed how I think about machines.

<figure>
<svg viewBox="0 0 700 260" width="100%" role="img" aria-label="A declarative configuration is built into an immutable generation stored in the Nix store; switching boots it, and rollback picks the previous generation with no drift in between.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="90" y="30" text-anchor="middle" font-weight="600">configuration.nix</text>
    <text x="350" y="30" text-anchor="middle" font-weight="600">nixos-rebuild</text>
    <text x="610" y="30" text-anchor="middle" font-weight="600">/nix/store (immutable)</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <rect x="30" y="46" width="120" height="150" rx="8"/>
    <line x1="170" y1="121" x2="240" y2="121"/>
    <rect x="250" y="46" width="200" height="150" rx="8"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11">
    <text x="44" y="72">services.nginx</text>
    <text x="44" y="92">users.users.x</text>
    <text x="44" y="112">networking</text>
    <text x="44" y="132">environment.system</text>
    <text x="44" y="152">boot.kernelParams</text>
    <text x="44" y="172">firewall</text>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11">
    <text x="264" y="72">derivation →</text>
    <text x="264" y="92">sandboxed build</text>
    <text x="264" y="112">hash each input</text>
    <text x="264" y="132">generation N</text>
    <text x="264" y="152">boot entry N</text>
    <text x="264" y="172">switch / test</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <line x1="470" y1="121" x2="520" y2="121"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11">
    <text x="530" y="72">/nix/store/a1b2…-gen-42</text>
    <text x="530" y="92">/nix/store/c3d4…-gen-43  ← current</text>
    <text x="530" y="112">/nix/store/e5f6…-gen-44  ← broken</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="2">
    <path d="M676 132 C 656 170, 560 190, 470 190"/>
  </g>
  <text x="470" y="205" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">rollback = boot gen-43; nothing to reconcile</text>
</svg>
<figcaption>The whole model in one picture: you describe the machine, Nix builds an immutable generation, and rollback just picks a different one.</figcaption>
</figure>

## What the config actually looks like

The part that convinced me it was not just theory was how small a real config is.
Here is a trimmed version of the box I ran — a web server with SSH hardening, a
non-root user, and a firewall, in about thirty lines:

```nix
# /etc/nixos/configuration.nix
{ config, pkgs, ... }:

{
  boot.loader.systemd-boot.enable = true;
  networking.hostName = "nixbox";
  time.timeZone = "Asia/Shanghai";

  # Users and SSH: keys only, no password logins.
  users.users.deepseek = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3Nza… deepseek@laptop"
    ];
  };
  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = false;
  };

  # A service, declared rather than installed.
  services.nginx = {
    enable = true;
    virtualHosts."blog.awin-x.top" = {
      root = "/srv/www/blog";
      locations."/" = { tryFiles = "$uri $uri/ =404"; };
    };
  };

  networking.firewall.allowedTCPPorts = [ 22 80 443 ];

  # The exact package set the machine will have.
  environment.systemPackages = with pkgs; [
    git vim tmux htop curl jq
  ];

  system.stateVersion = "24.05";
}
```

You apply it with one command, and because the second run changes nothing, it
feels like the honest version of what I was trying to get out of a playbook in
[Ansible for a single server](/posts/ansible-for-one-server/):

```bash
sudo nixos-rebuild switch          # build and activate the new generation
sudo nixos-rebuild test            # activate it, but don't make it the boot default
sudo nixos-rebuild switch --rollback   # undo
```

That is the appeal in full. It is a genuinely different way to own a machine, and
for the first week it felt like a superpower.

## The learning curve: the Nix language, flakes, and the docs

Then reality arrived, and it arrived in three waves.

**The Nix language.** Nix is a small, lazy, purely functional language, and it is
not hard — but it is *unfamiliar*. Config values are functions, overlays, and
attribute sets. `with pkgs;` brings names into scope. You will spend your first
week reading other people's configs and copying fragments you do not fully
understand, which is fine, until one fragment conflicts with another and you have
to actually learn why. The language is the price of declarative configuration,
and you cannot opt out of paying it.

**Flakes.** **Nix flakes** are the modern, pinned, self-contained way to describe
inputs: instead of following `nixpkgs-unstable` and hoping, a `flake.nix` locks
every dependency in `flake.lock`, exactly like a lockfile should. They are the
future and they are clearly better for reproducibility — but they fragment the
ecosystem, because half the documentation and examples you will find are *channel*-era
and the other half are flake-era, and nothing tells you which. A minimal
`flake.nix` looks like this:

```nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";

  outputs = { self, nixpkgs }: {
    nixosConfigurations.nixbox = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ ./configuration.nix ];
    };
  };
}
```

With that, `nixos-rebuild switch --flake .#nixbox` builds the whole system from
inputs pinned in `flake.lock`. Great. But now "channels vs flakes" is a decision
you have to make before you understand either, and a lot of tutorials silently
pick one.

**The docs.** Here I have to be blunt: the documentation is the weakest part.
The manual is complete and unreadable. Options are searchable, which saves you —
[building the machine from a description](https://search.nixos.org/options) is a
lifeline — but the *why* is often missing, error messages are famously unhelpful,
and the good explanations live in blog posts and forum threads rather than in
anything official. For a system this clever, the docs feel like an afterthought.

## Where NixOS shines, and where it hurts

### Servers and CI: this is the sweet spot

On a **server**, NixOS is close to ideal. The config is the documentation, the
build is reproducible, and a rebuild is a rollback target. You boot the same
generation on a fresh VPS and it is byte-identical to the one you tested — no
"works on my box." For CI in particular it is a quiet superpower: `nix develop`
gives every job the exact same toolchain, so [why builds are
slow](/posts/why-builds-are-slow/) stops being partly a mystery, and "it passed
on my machine" loses its alibi.

### Dev environments: the best part people undersell

The single feature I will keep using even after all the frustration is `nix develop`.
One file pins your compiler, your language runtime, your linters, and your
system libraries, and any teammate or CI runner gets the same environment with
one command. If you have ever nursed a shared box where two services disagree
about a native library — the problem I described in [self-hosting without
Docker](/posts/self-hosting-without-docker/) — this is the cleanest fix I have
found, and it does not require going all-in on NixOS at all.

### Where it hurts: hidden magic and a broken reflex

But the field report would be dishonest without the other half.

- **Hidden magic.** The transparency is real at the top and murky underneath.
  When something behaves unexpectedly, the cause is often buried in an overlay,
  a module's default, or a `lib` function you did not write. You are debugging a
  functional program that generates a *system*, and you cannot see the generated
  system without going looking.
- **Debugging is different, and worse at first.** There is no `systemctl restart`
  fix for a bad config. Errors come from evaluation, not from runtime, and Nix
  error messages are the least helpful I have used in years. The skill you build
  is real, but the first month is disproportionately painful.
- **Ecosystem gaps.** Ubuntu has a `.deb` and a Stack Overflow answer for
  everything. NixOS has a `nixpkgs` derivation *if someone wrote one*, and when
  they did not, you package it yourself — which is a genuine skill, not a
  five-minute detour. Some binaries also assume an FHS filesystem that NixOS
  deliberately does not provide; `nix-ld`, a `buildFHSUserEnv`, or a wrapper is
  the fix, and you will meet all three.
- **The "just edit the file" reflex.** This is the one nobody warns you about. I
  have spent a decade editing `/etc/nginx/nginx.conf` at 3 a.m. and it *worked*.
  NixOS forbids that reflex on purpose — edits to the store or to generated
  files are wiped on the next switch — but the reflex is deep in my fingers, and
  unlearning it took weeks. When you fight the model, NixOS punishes you politely.

## The honest recommendation

NixOS is not a weekend switch, and anyone who tells you it is has forgotten
their first month.

**Use it if** you are patient, you value being able to rebuild and roll back a
machine exactly, and you are willing to pay a real up-front cost in learning —
in the Nix language, in flakes, and in reading a lot of configs before you write
good ones. The payoff is genuine: reproducible builds, atomic rollback, and a
system you describe rather than nurse. For servers, CI, and pinned dev
environments, it is the strongest answer I have used.

**Wait if** you need the machine working this week, if your stack depends on
software nobody has packaged, or if you know you will reach for `vi /etc/...`
out of habit. Try it in a VM or on a spare box first — that is what I did, and
it is the only honest way to learn whether the trade is worth it for you.

My own plan: keep NixOS on the boxes where reproducibility earns its keep, and
keep reaching for `nix develop` everywhere else. The idea that a machine should be
a *description* you can rebuild, not a pet you maintain, is the right idea. I am
just not pretending the path there is short.
