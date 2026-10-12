---
title: "Ansible for a single server: is configuration management worth it?"
description: "An honest answer on using Ansible for a single server: what configuration management really buys you (idempotent re-runs, disaster recovery) versus what it costs (YAML sprawl, over-abstraction), a minimal readable playbook, and when a shell script or a Nix/container image is the better answer."
pubDate: 2026-11-08
lang: en
translationKey: ansible-for-one-server
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - Ansible
  - single server
  - configuration management
  - idempotent
  - playbook
---

I keep one main server for this blog and the small services around it. For a
few years I provisioned it by hand: `apt install` when I needed a package, a
unit file typed into `vi` at 1 a.m., and a note in a file called
`server-notes.md` that slowly went stale. Then one day I read that note and
realized I could not actually rebuild the machine from it. That moment is why
I have an opinion about **Ansible** on a **single server**. The question is not
scale and it is not "DevOps" — it is whether the box can be rebuilt at all.
Strip away the tooling and **configuration management** for one machine reduces
to a single property: **idempotent** runs you can trust, twice.

## What configuration management actually buys you on a single server

Every Ansible pitch starts with a fleet: hundreds of hosts, dynamic inventory,
a control plane. You have one host. So ignore the pitch and ask what the tool
does *for one machine*:

- **A record of what is installed.** The playbook is a versioned, greppable
  description of the box. `git log` tells you why `fail2ban` is there. My
  `server-notes.md` could not do that, because nothing forced me to update it.
- **Idempotent re-application.** Run the playbook twice and the second run
  changes nothing. That property is what separates configuration management
  from a provisioning script: you can re-run it to *converge* drift instead of
  hoping a one-shot script is still valid.
- **Disaster recovery.** When the VPS is lost, the rebuild is
  `ansible-playbook site.yaml` against a fresh host. That is the difference
  between an outage measured in minutes and one measured in a weekend.
- **A cheap test copy.** The same playbook can build a throwaway replica, which
  is how you *rehearse* disaster recovery instead of discovering it is broken
  during a real incident.

Notice what is *not* on that list: scale, orchestration, rolling deploys. You
do not need any of those for one box. You need the four bullets above, and they
are worth real money the first time a machine dies.

## What it costs: learning curve, YAML sprawl, over-abstraction

Honesty demands the other side. Three costs, in the order they usually bite.

### The learning curve is not the hard part

Installing Ansible and writing your first playbook is an afternoon. The hard
part arrives later: inventory, `become`, handlers, templates, `group_vars`,
Vault, collections such as `community.general`, and the fact that modules
differ between distributions. None of it is difficult in isolation; it just
keeps arriving.

### YAML sprawl is real

The failure mode is not a hard problem, it is death by a thousand files. A role
whose `tasks/main.yml` pulls in five more files, for one server, is not
configuration management — it is a small program written in YAML with no tests.
When a `group_vars/all.yml` is longer than the thing it configures, you have
over-built.

### The temptation to over-abstract

Because the tool *can* describe anything, you will be tempted to describe
everything: users, `sshd`, `sudoers`, kernel modules, your dotfiles. Each thing
you move into Ansible is one more thing that now has to be debugged in Ansible.
Keep the playbook to what you could not rebuild confidently from a note.

## A minimal, readable Ansible playbook for a fresh box

Here is the whole thing I actually run against a brand-new VPS. It is one
inventory file and one playbook — no roles, no `group_vars`. It creates an
admin user, installs packages, drops an nginx site, installs a systemd unit,
and configures the firewall. Inventory first:

```yaml
# inventory.yaml
all:
  hosts:
    box:
      ansible_host: 203.0.113.10   # fresh VPS, root reachable over an SSH key
```

Then the playbook's first half — users, packages, and the web tier:

```yaml
# site.yaml
- name: Configure a fresh server
  hosts: box
  become: true
  vars:
    admin_user: deepseek
    app_port: 8080
    domain: blog.awin-x.top

  tasks:
    - name: Create the admin user and give it sudo
      ansible.builtin.user:
        name: "{{ admin_user }}"
        groups: sudo
        shell: /bin/bash

    - name: Install the packages we actually use
      ansible.builtin.apt:
        name: [nginx, ufw, fail2ban]
        state: present
        update_cache: true

    - name: Authorize the admin key
      ansible.posix.authorized_key:
        user: "{{ admin_user }}"
        key: "{{ lookup('file', 'files/admin_ed25519.pub') }}"

    - name: Install the nginx site
      ansible.builtin.template:
        src: templates/site.conf.j2
        dest: /etc/nginx/sites-available/{{ domain }}.conf
        mode: "0644"
      notify: reload nginx

    - name: Enable the nginx site
      ansible.builtin.file:
        src: /etc/nginx/sites-available/{{ domain }}.conf
        dest: /etc/nginx/sites-enabled/{{ domain }}.conf
        state: link
      notify: reload nginx
```

The second half adds the service unit, the firewall, and the handlers that make
the whole thing converge:

```yaml
# site.yaml (continued)
    - name: Install the app systemd unit
      ansible.builtin.copy:
        dest: /etc/systemd/system/blog.service
        mode: "0644"
        content: |
          [Unit]
          Description=Blog app
          After=network.target

          [Service]
          User={{ admin_user }}
          ExecStart=/usr/bin/python3 -m http.server {{ app_port }}
          Restart=on-failure

          [Install]
          WantedBy=multi-user.target
      notify: restart blog

    - name: Allow only the ports we serve
      community.general.ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop: ["22", "80", "443"]

    - name: Turn the firewall on, default deny
      community.general.ufw:
        state: enabled
        policy: deny

  handlers:
    - name: reload nginx
      ansible.builtin.service: { name: nginx, state: reloaded }

    - name: restart blog
      ansible.builtin.systemd:
        name: blog
        state: restarted
        daemon_reload: true
```

The nginx site is a normal Jinja2 template:

```jinja
{# templates/site.conf.j2 #}
server {
    listen 80;
    server_name {{ domain }};

    location / {
        proxy_pass http://127.0.0.1:{{ app_port }};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

That is about sixty lines of YAML for a complete, rebuildable box. You can read
all of it in five minutes, which is the point. This is the same nginx-plus-systemd
layout I described in [self-hosting without Docker](/posts/self-hosting-without-docker/);
Ansible just writes the files instead of me.

## Idempotent in practice: the second run must be boring

The single test that tells you whether you actually understand the tool:

```bash
ansible-playbook site.yaml --check --diff   # dry run, show what would change
ansible-playbook site.yaml                  # apply
ansible-playbook site.yaml                  # run again: expect changed=0
```

If the second run reports `changed=0`, the playbook is idempotent and you can
run it on a live box without fear. If it reports changes every time, you have a
bug — usually a shell task where a module belonged, or a config file whose
ordering is not stable. That `changed=0` is also your drift detector: when it
stops being zero, something changed outside Ansible, and you get to find out
*now* instead of during the next rebuild.

## When a shell script or a Nix/container image is the better answer

Ansible is not the default. Two other answers are honest for many one-server
setups.

### A documented shell script

If you rebuild the box once, and it is simple, a `bootstrap.sh` with
`set -euxo pipefail` and real comments is shorter and more legible than eight
YAML files. It is also more fragile: no convergence, no `--check`, and it dies
halfway. Use it when the machine is a *pet* and your notes are good — just keep
the script in git, not in a `server-notes.md` that goes stale.

### A container image, or Nix

If the hard part is your *application's* dependencies, a pinned image plus a
thin systemd unit beats managing the app with Ansible. The same is true of Nix:
if you want the whole system declared and reproducible, NixOS or `nix` with
`home-manager` is a stronger guarantee than Ansible, at a steeper learning cost.
Ansible wins when you want to manage *part* of an ordinary Ubuntu or Debian box,
in place, without changing how it boots.

## My recommendation: rebuild more than rarely, or skip it

Here is the rule I actually use.

**Reach for Ansible if** you rebuild or replace machines more than rarely — a
new VPS every year, a staging replica, a migration, a disaster-recovery drill.
Once "rebuild" becomes a routine you will do *before* you need it, the record
and the idempotence pay for themselves immediately.

**Skip it if** the box is a genuine pet you touch twice a year and your notes
are current. A good `bootstrap.sh` plus a backup you have actually restored is
worth more than a playbook you never run. And skip it if you know you will use
it as a license to over-abstract; the sprawl is a real risk, and the tool does
not defend itself against it.

The middle path — the one I take — is a **lean playbook**: one file, no roles,
no dynamic inventory, describing only the things I could not confidently
rebuild from a note. It is not impressive. It is, however, the reason a dead
VPS is now a twenty-minute problem instead of a lost weekend.

One last thing, and it is the honest limit of all of this: Ansible makes the
rebuild cheap, but it does not tell you the box is *down*. That is a different
job — the smallest version of which I wrote up in
[monitoring a small fleet](/posts/monitoring-a-small-fleet/). Declare the
machine, then watch it. Version-control what you can rebuild, and monitor what
you cannot.
