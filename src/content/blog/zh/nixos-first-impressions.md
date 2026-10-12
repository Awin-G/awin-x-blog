---
title: "NixOS 初体验：声明式、可复现，偶尔让人抓狂"
description: "运行 NixOS 一个月后的实地报告：把整台系统声明在一个文件里的吸引力、configuration.nix 到底长什么样、Nix 语言与 Nix flakes 的真实学习曲线、它在服务器与 CI 上的用武之地、它哪里硌人，以及一个诚实的使用建议。"
pubDate: 2026-11-23
lang: zh
translationKey: nixos-first-impressions
tags: [linux, devops, self-hosting]
featured: false
keywords:
  - NixOS
  - 声明式配置
  - 可复现构建
  - Nix flakes
  - 回滚
---

我这辈子亲手重建过不少 Linux 机器，剩下的也都用 Ansible 和 shell 脚本自动化掉了。所以当人们
一再告诉我 **NixOS** 才是终点——说你不再*配置*一台机器，而是*描述*它——我就想知道这是真有
其事，还是一种非常有说服力的宗教。我拿一台闲置的机器和一个容器试了一个月。这是一份初体验的
实地报告，不是教程：它的吸引力到底是什么、配置长什么样、它在哪里值回票价、以及它在哪里让我
想把笔记本扔出去。

## 吸引力：一个文件，一台能被精确重建的机器

**声明式配置**的承诺，一句话就能说清，但很难被高估。在 NixOS 上，整台系统——软件包、服务、
用户、内核参数、防火墙、你的 shell——都活在少数几个声明式文件里，主要是
`/etc/nixos/configuration.nix`。你不去 `apt install` 东西。你*描述*这台机器，跑一条命令，
系统就被构建成与之相符的样子。

这和一份配置脚本的区别，正是**可复现构建**重要的原因：Nix 在隔离的沙箱里，从一份描述构建
每一个包，并把结果按「其全部输入哈希而成」的路径存进 `/nix/store`。两台要求同一份 derivation
的机器，拿到的是*同样的字节*——而不是「大概版本相同」。那个按哈希寻址的 store 是全部的诀窍。
它也是第二条性质——原子回滚——几乎免费的原因。

每次你运行 `nixos-rebuild`，Nix 都会构建一代新的、不可变的系统*代际*（generation），并把它
加进启动菜单。如果新一代坏了——某次升级把网络搞瘫、某个服务起不来——你不用在凌晨两点去调它。
你在引导器里挑上一代，或者直接跑：

```bash
sudo nixos-rebuild switch --rollback
```

一条命令，几秒钟回到已知良好的系统。没有漂移要收敛，因为从来就没有漂移：运行中的系统*就是*
构建产物。这一点是真正改变了我对机器看法的部分。

<figure>
<svg viewBox="0 0 700 260" width="100%" role="img" aria-label="一份声明式配置被构建成一个不可变的代际并存进 Nix store；switch 会启动它，rollback 则选回上一代，中间没有任何漂移。">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13">
    <text x="90" y="30" text-anchor="middle" font-weight="600">configuration.nix</text>
    <text x="350" y="30" text-anchor="middle" font-weight="600">nixos-rebuild</text>
    <text x="610" y="30" text-anchor="middle" font-weight="600">/nix/store（不可变）</text>
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
    <text x="264" y="92">沙箱内构建</text>
    <text x="264" y="112">对每个输入求哈希</text>
    <text x="264" y="132">第 N 代</text>
    <text x="264" y="152">启动项 N</text>
    <text x="264" y="172">switch / test</text>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <line x1="470" y1="121" x2="520" y2="121"/>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="11">
    <text x="530" y="72">/nix/store/a1b2…-gen-42</text>
    <text x="530" y="92">/nix/store/c3d4…-gen-43  ← 当前</text>
    <text x="530" y="112">/nix/store/e5f6…-gen-44  ← 坏了</text>
  </g>
  <g fill="none" stroke="#0f766e" stroke-width="2">
    <path d="M676 132 C 656 170, 560 190, 470 190"/>
  </g>
  <text x="470" y="205" fill="#0f766e" font-family="system-ui, sans-serif" font-size="12">回滚 = 启动 gen-43；没有任何要收敛的东西</text>
</svg>
<figcaption>整个模型就在这一张图里：你描述机器，Nix 构建出一个不可变的代际，回滚只是换一个代际来启动。</figcaption>
</figure>

## 配置到底长什么样

真正让我相信这不是纸上谈兵的，是一份真实配置有多短。下面是我跑的那台机器删减后的版本——
一台带 SSH 加固、非 root 用户和防火墙的 Web 服务器，大约三十行：

```nix
# /etc/nixos/configuration.nix
{ config, pkgs, ... }:

{
  boot.loader.systemd-boot.enable = true;
  networking.hostName = "nixbox";
  time.timeZone = "Asia/Shanghai";

  # 用户与 SSH：只用密钥，禁用密码登录。
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

  # 一个服务，是被声明的，而不是被安装的。
  services.nginx = {
    enable = true;
    virtualHosts."blog.awin-x.top" = {
      root = "/srv/www/blog";
      locations."/" = { tryFiles = "$uri $uri/ =404"; };
    };
  };

  networking.firewall.allowedTCPPorts = [ 22 80 443 ];

  # 这台机器将拥有的确切软件包集合。
  environment.systemPackages = with pkgs; [
    git vim tmux htop curl jq
  ];

  system.stateVersion = "24.05";
}
```

你用一条命令施加它，而且因为跑第二遍什么都不变，它感觉就像是
[单台服务器上的 Ansible](/zh/posts/ansible-for-one-server/)里我试图从 playbook 拿到的东西，
诚实版本的样子：

```bash
sudo nixos-rebuild switch          # 构建并激活新一代
sudo nixos-rebuild test            # 激活它，但不设为默认启动项
sudo nixos-rebuild switch --rollback   # 撤销
```

吸引力全在这里了。它确实是一种拥有机器的不同方式，而第一周它感觉像是超能力。

## 学习曲线：Nix 语言、flakes，以及文档

然后现实来了，而且是三波一起到的。

**Nix 语言。** Nix 是一门小巧、惰性、纯函数式的语言，本身不难——但它*陌生*。配置值是函数、
overlay 和属性集（attribute set）。`with pkgs;` 把名字带入作用域。你的第一周会花在读别人的
配置、复制你并不完全理解的片段上，这没问题，直到某个片段和另一个冲突，你才不得不真正搞懂为
什么。这门语言是声明式配置的代价，你没法不付。

**Flakes。** **Nix flakes** 是描述输入的现代、锁定、自包含方式：与其跟着 `nixpkgs-unstable`
听天由命，一份 `flake.nix` 会把每个依赖锁进 `flake.lock`，就像 lockfile 本该做的那样。它们是
未来，对可复现性显然更好——但也撕裂了生态：你能找到的文档和示例有一半是 *channel* 时代的，
另一半是 flake 时代的，而没有任何东西告诉你哪个是哪个。一份最小的 `flake.nix` 长这样：

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

有了它，`nixos-rebuild switch --flake .#nixbox` 就能用锁在 `flake.lock` 里的输入构建整台系统。
很棒。但现在「channels 还是 flakes」成了你必须做的决定，而你连两者都还没搞懂，很多教程还会
悄悄替你选一边。

**文档。** 这里我得直说：文档是最弱的一环。手册是完整的，但读不下去。选项可搜索，这救了你——
[从描述构建机器](https://search.nixos.org/options)是一条生命线——但*为什么*常常缺失，报错
信息出了名地没用，而真正好的解释活在一些博客和论坛帖子里，而不是任何官方材料里。对这么聪明
的一套系统，文档却像是个事后补丁。

## NixOS 的用武之地，和它硌人的地方

### 服务器与 CI：这才是甜区

在**服务器**上，NixOS 近乎理想。配置就是文档，构建可复现，一次重建就是一个回滚目标。你把同一
代际启动到一台全新的 VPS 上，它和你测过的那个字节一致——没有「在我机器上能跑」。对 CI 尤其
是一种安静的超能力：`nix develop` 让每个任务拿到完全相同的工具链，于是[构建为什么慢](/zh/posts/why-builds-are-slow/)
不再有部分是谜，而「我机器上通过了」也失去了借口。

### 开发环境：被人低估的最好部分

在所有这些挫败之后，我仍会继续用的唯一功能就是 `nix develop`。一个文件锁定你的编译器、语言
运行时、linter 和系统库，任何同事或 CI runner 都能用一条命令拿到同样的环境。如果你曾伺候过一
台两个服务对同一个原生库版本意见不一的共享机器——就是我在[不用 Docker 的自托管](/zh/posts/self-hosting-without-docker/)
里描述过的问题——这是我找到的最干净的解法，而且完全不需要你在 NixOS 上全押。

### 硌人的地方：隐藏的魔法与被打破的反射

但少了另一半，这份实地报告就不诚实。

- **隐藏的魔法。** 透明在顶层是真的，在底下却是浑浊的。当某样东西表现异常时，原因往往埋在一个
  你没写的 overlay、某个模块的默认值，或某个 `lib` 函数里。你在调试一个生成*系统*的函数式程
  序，而不去深挖，你就看不到那个被生成的系统。
- **调试方式不同，而且一开始更糟。** 坏配置没有 `systemctl restart` 能救。错误来自求值
  （evaluation）而不是运行时，而 Nix 的报错是我这些年用过的最没帮助的。你练出的本事是真的，但
  第一个月疼得不成比例。
- **生态缺口。** Ubuntu 给所有东西都准备了 `.deb` 和一个 Stack Overflow 答案。NixOS 有的是
  `nixpkgs` 里的一个 derivation——*前提是有人写过*。没人写过时，你就得自己打包——那是一门真本
  事，不是五分钟绕个路。有些二进制还假设一个 FHS 文件系统，而 NixOS 故意不提供；`nix-ld`、
  一个 `buildFHSUserEnv`，或者一个 wrapper 是解法，而这三个你都会遇到。
- **「直接改文件」的反射。** 这个没人提醒过你。我有十年在凌晨三点改
  `/etc/nginx/nginx.conf` 的经历，而且它*管用*。NixOS 故意禁止这个反射——对 store 或生成文件的
  改动会在下次 switch 时被抹掉——但这个反射深深刻在我手指里，改掉它花了好几周。当你和这个模型
  对着干，NixOS 会礼貌地惩罚你。

## 诚实的建议

NixOS 不是一次周末切换，任何说它是的人，都已经忘了自己的第一个月。

**该用它，如果**你有耐心、你看重精确重建与回滚一台机器，而且你愿意在学习和 flakes 上、以及
在写出好配置之前读大量配置这件事上，付出一笔实打实的前置成本。回报是真的：可复现构建、原子回
滚，以及一台你描述而非伺候的系统。对服务器、CI 和锁定的开发环境，这是我用过的最强的答案。

**该等一等，如果**你这周就需要机器能用，如果你的技术栈依赖没人打包过的软件，或者如果你知道自
己会习惯性地伸手去 `vi /etc/...`。先在一台虚拟机或闲置机器上试试——我就是这么做的，而这也是
唯一诚实地判断这笔交易对你不划算的办法。

我自己的打算：在可复现性值回票价的那几台机器上留着 NixOS，其他地方继续用 `nix develop`。一台
机器应该是你能够重建的*描述*，而不是你维护的宠物——这个想法是对的。我只是不假装通往它的路很
短。
