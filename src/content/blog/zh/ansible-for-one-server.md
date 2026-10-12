---
title: "单台服务器上的 Ansible：配置管理到底值不值？"
description: "关于在单台服务器上用 Ansible 的诚实回答：配置管理到底带来什么（可复现的记录、幂等重跑、灾难恢复），又付出什么代价（学习曲线、YAML 膨胀、过度抽象），一个最小可读的 playbook 示例，以及什么时候一份 shell 脚本或 Nix／容器镜像是更好的答案。"
pubDate: 2026-11-08
lang: zh
translationKey: ansible-for-one-server
tags: [devops, self-hosting, linux]
featured: false
keywords:
  - Ansible
  - 单台服务器
  - 配置管理
  - 幂等
  - playbook
---

这个博客和我身边那几个小服务，主要都跑在一台服务器上。有好几年我都是手工把它配起来的：
需要哪个包就 `apt install` 一下，凌晨一点在 `vi` 里现敲一个 unit 文件，再往一个叫
`server-notes.md` 的笔记里写两行——而那笔记慢慢就过期了。直到有一天我打开它，才发现自己
根本没法照着把它重建出来。那一刻之后，我对在**单台服务器**上用 **Ansible** 有了明确观点。
问题不在规模，也不是什么「DevOps」——问题是你这台机器到底能不能被重建。把工具的外壳剥掉，
一台机器的**配置管理**最后就归结为一条性质：信得过的**幂等**运行，跑第二遍。

## 单台服务器上，配置管理到底给你什么

所有 Ansible 的宣传都从机队讲起：上百台主机、动态 inventory、一个控制面。而你只有一台。
所以别听那套，直接问这工具 *对一台机器* 到底做了什么：

- **一份装了什么的可复现记录。** playbook 就是这台机器带版本、可 grep 的描述。
  `git log` 能告诉你当初为什么装了 `fail2ban`。我的 `server-notes.md` 做不到，因为没有任何
  东西逼我去更新它。
- **幂等的重新施加。** playbook 跑第二遍，什么都不变。正是这条性质把配置管理和一次性配置
  脚本区分开：你可以反复运行它去*收敛*漂移，而不是祈祷某个只跑一次的脚本今天还有效。
- **灾难恢复。** VPS 没了，重建就是对着新主机跑一次 `ansible-playbook site.yaml`。这就是
  「停机几分钟」和「报废一个周末」的差别。
- **一份廉价的测试副本。** 同一套 playbook 能搭一台用完即弃的副本，这样你就能*演练*灾难
  恢复，而不是在真出事的时候才发现恢复流程是坏的。

注意这份清单里*没有*什么：规模、编排、滚动发布。单机一个都不需要。你需要的就是上面四条，
而它们在一台机器第一次挂掉时就已经值回票价。

## 代价：学习曲线、YAML 膨胀、过度抽象

诚实就得讲另一面。三项代价，按它们通常咬人的顺序排。

### 学习曲线其实不是难的地方

装上 Ansible、写出第一个 playbook，一个下午就够。难的部分在后面才到：inventory、`become`、
handlers、模板、`group_vars`、Vault、`community.general` 这类 collection，还有各发行版之间
模块行为不一致这件事。单拎出哪一样都不难，它只是一直往你面前堆。

### YAML 膨胀是真问题

失败模式从来不是某个难题，而是被一千个文件凌迟。一个 role 的 `tasks/main.yml` 下面再
`include_tasks` 拉进来五个文件，而它服务的只有一台机器——那不叫配置管理，那是一门用 YAML
写、且没有测试的小程序。当 `group_vars/all.yml` 比它所配置的东西还长时，你就是过度建设了。

### 过度抽象的诱惑

正因为这工具*什么都能*描述，你就会忍不住什么都描述：用户、`sshd`、`sudoers`、内核模块、
你的 dotfiles。每搬进 Ansible 一样东西，就多一样东西以后得在 Ansible 里调试。把 playbook
限制在「你没把握靠一条笔记重建」的范围内。

## 一个最小、可读的 Ansible playbook

下面就是我真正会对着一台全新 VPS 跑的全部内容。一个 inventory 文件加一个 playbook——没有
role，没有 `group_vars`。它建一个管理员用户、装包、放一份 nginx 站点、装一个 systemd 单元、
配好防火墙。先是 inventory：

```yaml
# inventory.yaml
all:
  hosts:
    box:
      ansible_host: 203.0.113.10   # 全新 VPS，root 可用 SSH key 直连
```

然后是 playbook 的前半段——用户、软件包和 Web 层：

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

后半段加上服务单元、防火墙，以及让整件事收敛的 handlers：

```yaml
# site.yaml（续）
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

nginx 站点就是一个普通的 Jinja2 模板：

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

一份完整、可重建的机器，大约就六十行 YAML。你五分钟能把它读完，这正是重点。这也是我在
[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/) 里写过的同一套
nginx 加 systemd 布局，只是这次换 Ansible 来写文件，而不是我亲手写。

## 幂等落到实处：第二遍必须无聊

判断你到底有没有真懂这工具，只需要一个测试：

```bash
ansible-playbook site.yaml --check --diff   # 预演，显示会改什么
ansible-playbook site.yaml                  # 应用
ansible-playbook site.yaml                  # 再跑一次：期望 changed=0
```

如果第二遍报告 `changed=0`，说明 playbook 是幂等的，你可以放心地对着线上机器跑。如果它每
次都报告有改动，那你就是有 bug——通常是本该用模块的地方写了 shell 任务，或者某份配置文件的
顺序不稳定。这个 `changed=0` 同时也是你的漂移探测器：当它不再为零，说明有东西在 Ansible
之外被改动了，而你可以在*此刻*发现，而不是等到下一次重建。

## 什么时候 shell 脚本或 Nix／容器镜像是更好的答案

Ansible 并不是默认选项。对很多单机场景来说，另外两个答案同样诚实。

### 一份有注释的 shell 脚本

如果你只重建一次、而且机器很简单，那么一个带 `set -euxo pipefail` 和真实注释的
`bootstrap.sh`，会比八个 YAML 文件更短、更好读。它也更脆弱：没有收敛、没有 `--check`、
中途挂了就停在那。当这台机器是只*宠物*、而你的笔记又够新时，就用它——只要把脚本放进 git，
别丢在那个会过期的 `server-notes.md` 里。

### 容器镜像，或者 Nix

如果真正难缠的是*应用本身*的依赖，那么一个钉死版本的镜像加一层薄薄的 systemd 单元，胜过用
Ansible 去管这个应用。Nix 也一样：如果你想让整个系统都被声明式地描述且可复现，NixOS 或者
`nix` 加 `home-manager` 给出的保证比 Ansible 更强，代价是更陡的学习曲线。Ansible 的胜场在
于：你想*就地*管理一台普通 Ubuntu/Debian 机器的一部分，而不改变它怎么启动。

## 我的建议：重建得比偶尔多，就用；否则跳过

下面是我真正在用的判断规则。

**如果你重建或更换机器的频率高于「偶尔」——每年换一台 VPS、一个预发副本、一次迁移、一次灾
难恢复演练——那就上 Ansible。** 一旦「重建」变成你在*需要之前*就会做的常规动作，那份记录和
那点幂等性立刻回本。

**如果这台机器是只你一年碰两次的宠物，而且笔记是最新的，那就跳过。** 一个靠谱的
`bootstrap.sh`，加一份你真正恢复过的备份，比一套你永远不跑的 playbook 更有价值。如果你知道
自己会拿它当过度抽象的许可证，也跳过——YAML 膨胀是真实风险，而这工具本身不会替你防住它。

中间路线——也是我选的那条——是一套**精简 playbook**：一个文件，没有 role，没有动态
inventory，只描述那些我没把握靠一条笔记重建的东西。它一点都不惊艳。但它正是那台 VPS 挂掉
之后，从「报废一个周末」变成「二十分钟的事」的原因。

最后一点，也是这一切诚实的边界：Ansible 让重建变便宜，但它不会告诉你机器*正在宕机*。那是另
一件事——它最小的那套做法我写在[小规模服务器监控](/zh/posts/monitoring-a-small-fleet/)里。
把机器声明出来，然后盯着它。能重建的，纳入版本控制；不能重建的，纳入监控。
