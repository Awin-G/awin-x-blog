---
title: "tmux 实战：比 SSH 连接更持久的会话"
description: "tmux 会话、窗口与面板的实用指南：终端复用器如何在 SSH 断线后保持你的工作现场，如何脚本化生成可复现的布局，以及 send-keys 和 capture-pane 如何实现真正的自动化。"
pubDate: 2027-01-30
lang: zh
translationKey: tmux-and-session-management
tags: [linux, devops]
featured: false
keywords:
  - tmux
  - tmux 会话
  - 终端复用器
  - tmux 脚本
  - 断开与重连
---

如果你曾经因为 SSH 连接中断而眼睁睁看着一次漫长的编译或 `scp` 传输失败，你已经知道了 tmux 所解决的问题。如果你曾经在六个终端窗口之间反复切换，只为了同时盯着开发服务器、数据库 shell 和日志输出，你知道第二个问题。tmux——**终端复用器**——同时解决这两个问题，而且它的核心概念很少，很容易内化。

我之前写过 [SSH 高级技巧](/zh/posts/advanced-ssh/) 和 [bash 严格模式](/zh/posts/bash-strict-mode/)。tmux 位于这两者之上：它是当 SSH 放弃时保持你的 shell 存活的层次，也是让你组织和脚本化这些 shell 的层次。这篇文章就是我希望自己最先读到的那份指南。

## tmux 到底是什么

tmux 是一个客户端-服务器程序。**服务器**在后台运行，持有**会话**。每个会话包含**窗口**（类似标签页），每个窗口包含**面板**（分割视图）。你的终端只是一个**客户端**，连接到会话并将其渲染出来。当你断开连接时，客户端断开，但服务器会继续运行会话中的每一个 shell。

这个单一的设计决策——服务器比客户端存活得更久——就是 tmux 会话能比你的 SSH 连接更持久的原因。这些 shell 是 tmux 服务器的子进程，而不是你 SSH 会话的子进程。当 SSH 断开时，没有任何东西向这些 shell 发送 SIGHUP。它们继续运行。

## 会话 / 窗口 / 面板模型

层级结构很简单：

- **会话（Session）**——一个命名的工作区。通常每个项目一个会话，或每个长时间运行的任务一个会话。
- **窗口（Window）**——会话中的全屏视图，类似浏览器标签页。
- **面板（Pane）**——窗口内的分割区域，每个面板运行自己的 shell。

以下是一个真实的三面板布局，来自 `list-panes`：

```text
$ tmux -L scratch list-panes -a -F "session:#{session_name} window:#{window_index}.#{window_name} pane:#{pane_index} #{pane_width}x#{pane_height} cmd=#{pane_current_command}"
session:work window:0.bash pane:0 60x30 cmd=bash
session:work window:0.bash pane:1 59x15 cmd=bash
session:work window:0.bash pane:2 59x14 cmd=bash
```

一个会话，一个窗口，三个面板。面板 0 是 60×30（完整的左半部分），面板 1 是 59×15（右上），面板 2 是 59×14（右下）。每个都是独立的 bash shell。

<figure>
<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="tmux 会话包含一个窗口和三个面板">
  <rect x="10" y="10" width="380" height="180" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
  <rect x="14" y="14" width="372" height="20" fill="#0f766e"/>
  <text x="20" y="28" font-family="monospace" font-size="12" fill="#f7f6f2">work — bash — 3 panes</text>
  <rect x="14" y="38" width="180" height="148" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="20" y="60" font-family="monospace" font-size="11" fill="currentColor">pane 0 — editor</text>
  <rect x="198" y="38" width="188" height="72" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="204" y="60" font-family="monospace" font-size="11" fill="currentColor">pane 1 — server</text>
  <rect x="198" y="114" width="188" height="72" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="204" y="136" font-family="monospace" font-size="11" fill="currentColor">pane 2 — logs</text>
</svg>
<figcaption>一个 tmux 会话：一个窗口分割为三个面板，每个面板是独立的 shell。</figcaption>
</figure>

## 你真正会用的命令

一旦你熟悉了前缀键（默认 `Ctrl-b`），你可以完全通过键盘驱动 tmux。但命令行才是真正的力量所在——它让你可以脚本化、自动化和恢复。以下是我每天使用的命令：

```bash
# 创建一个名为 "work" 的分离会话
tmux new-session -d -s work

# 列出运行中的会话
tmux ls
# work: 1 windows (created Wed Oct 14 03:17:52 2026)

# 连接到会话（用 Ctrl-b d 断开连接）
tmux attach -t work

# 完成后杀死会话
tmux kill-session -t work
# no server running on /tmp/tmux-0/scratch
```

`new-session` 上的 `-d` 标志是关键：它在后台创建会话而不附加连接。这是每个可脚本化工作流的基础。

## 脚本化可复现的开发布局

因为每个 tmux 命令都可以从 shell 运行，你可以写一个脚本在几秒钟内构建整个开发环境。以下是我为典型项目使用的真实布局脚本：

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION="project"
SOCKET="dev"

# 从头开始
tmux -L "$SOCKET" kill-server 2>/dev/null || true
tmux -L "$SOCKET" new-session -d -s "$SESSION" -x 120 -y 30

# 面板 0：编辑器（全高，左半部分）
# 面板 1：开发服务器（右上）
# 面板 2：测试运行器（右下）
tmux -L "$SOCKET" split-window -h -t "$SESSION"
tmux -L "$SOCKET" split-window -v -t "$SESSION:0.1"

# 启动实际工具
tmux -L "$SOCKET" send-keys -t "$SESSION:0.0" "nvim" Enter
tmux -L "$SOCKET" send-keys -t "$SESSION:0.1" "npm run dev" Enter
tmux -L "$SOCKET" send-keys -t "$SESSION:0.2" "npm test -- --watch" Enter

# 连接到完成的布局
tmux -L "$SOCKET" attach -t "$SESSION"
```

当我运行这个脚本时，我得到一个三面板布局：编辑器、开发服务器和测试运行器——全部在一秒内完成。如果会话已存在，我可以重新运行分割命令或直接重新连接。布局完全可复现。

以下是通过这种方式构建的会话的真实捕获：

```text
$ tmux -L scratch list-panes -a -F "session:#{session_name} window:#{window_index}.#{window_name} pane:#{pane_index} #{pane_width}x#{pane_height} cmd=#{pane_current_command}"
session:work window:0.bash pane:0 60x30 cmd=bash
session:work window:0.bash pane:1 59x15 cmd=bash
session:work window:0.bash pane:2 59x14 cmd=bash
```

## send-keys 和 capture-pane：没有终端的自动化

让 tmux 真正可脚本化的两个命令是 `send-keys` 和 `capture-pane`。它们让你可以输入到面板中并读回结果——不需要伪终端，不需要 expect 风格的技巧。

### send-keys：向面板输入

`send-keys` 向面板发送按键。你可以发送字面文本、按键名称或两者：

```bash
# 在面板 0 中运行命令
tmux send-keys -t work:0.0 "echo hello-from-pane-0" Enter

# 发送字面字符串（不发送 Enter）
tmux send-keys -t work:0.1 "ls -la"
```

`Enter` 键名发送一个回车。命令会像你手动输入一样运行。

### capture-pane：读回面板内容

`capture-pane` 将面板的可见文本输出到 stdout。这是你验证命令是否成功的方式：

```bash
tmux capture-pane -p -t work:0.0 | grep -v "^$"
# root@179763965b4b:/# echo hello-from-pane-0
# hello-from-pane-0
# root@179763965b4b:/#
```

`-p` 标志输出到 stdout（而不是剪贴板）。`-t` 标志定位到特定面板。这是我在 CI 脚本中使用的模式：发送命令，短暂等待，捕获面板，grep 成功标记。

### pipe-pane：记录一切

如果你想完整记录面板中出现的所有内容，`pipe-pane` 会将其写入文件：

```bash
tmux pipe-pane -t work:0.1 -o "cat >> /workspace/pane1.log"
tmux send-keys -t work:0.1 "echo logged-line-1" Enter
tmux send-keys -t work:0.1 "echo logged-line-2" Enter
```

运行这些命令后，日志文件包含：

```text
echo logged-line-1
logged-line-1
root@179763965b4b:/# echo logged-line-2
logged-line-2
root@179763965b4b:/#
```

每次按键和每个输出字节都被捕获。这对于调试构建或记录可复现的输出轨迹非常有价值。

### respawn-pane：重启面板

如果面板的 shell 死了（或者你想重启一个服务），`respawn-panel` 会让它回来：

```bash
tmux respawn-pane -k -t work:0.2 -c /workspace
tmux send-keys -t work:0.2 "echo respawned-ok" Enter
tmux capture-pane -p -t work:0.2 | grep -v "^$" | head -3
# root@179763965b4b:/workspace# echo respawned-ok
# respawned-ok
# root@179763965b4b:/workspace#
```

`-k` 标志先杀死面板中现有的命令。`-c` 标志设置新 shell 的工作目录。

## 配置文件：前缀键、鼠标、状态栏、真彩色

我的 `~/.tmux.conf` 很短且立场明确。完整内容如下：

```bash
# ~/.tmux.conf — tmux 实战

# 将前缀键从 Ctrl-b 重映射为 Ctrl-a
set -g prefix C-a
unbind C-b
bind C-a send-prefix

# 鼠标支持
set -g mouse on

# 真彩色
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"

# 状态栏
set -g status-style "bg=#0f766e,fg=white"
set -g status-left "#[fg=white,bold] #S "
set -g status-right "%H:%M %d-%b-%y"

# 窗口/面板从 1 开始编号
set -g base-index 1
setw -g pane-base-index 1

# 轻松重新加载配置
bind r source-file ~/.tmux.conf \; display "Config reloaded!"
```

影响最大的改变是前缀键重映射。`Ctrl-a` 比 `Ctrl-b` 更容易触及，而且它与 GNU screen 的默认前缀相同——所以肌肉记忆可以直接迁移。鼠标支持让你可以点击选择面板并拖动调整大小。状态栏在左侧显示会话名称，右侧显示时间戳，使用与本博客强调色一致的青色背景。

以下是配置已应用的证明：

```text
$ tmux show-options -g prefix
prefix C-a
$ tmux show-options -g mouse
mouse on
$ tmux show-options -g status-style
status-style "bg=#0f766e,fg=white"
$ tmux show-options -g default-terminal
default-terminal screen-256color
$ tmux show-options -g status-left
status-left "#[fg=white,bold] #S "
$ tmux show-options -g status-right
status-right "%H:%M %d-%b-%y"
```

`bind r` 这一行是一个实用性改进：按前缀键 + `r` 在编辑后重新加载配置。不需要杀死服务器或断开连接。

## 分离会话为什么能存活

tmux 的全部意义在于会话在你断开连接后继续运行。以下是证明，使用私有套接字避免干扰任何东西：

```bash
# 创建一个分离会话
tmux -L scratch new-session -d -s survivor -x 100 -y 25

# 列出会话 — 它在运行
tmux -L scratch list-sessions
# survivor: 1 windows (created Wed Oct 14 03:19:26 2026)

# 列出客户端 — 没有连接
tmux -L scratch list-clients
# [end of list-clients output]
```

会话存在，但零个客户端已连接。它完全分离。当你重新 `ssh` 回来并运行 `tmux -L scratch attach -t survivor` 时，你会重新连接到完全相同的 shell，完全相同的滚动缓冲区，完全相同的面板布局。SSH 连接可以在中间断开一百次——无关紧要。

这就是让 tmux 在远程服务器上不可或缺的工作流：在分离会话中启动一个长时间运行的任务，断开连接，关闭笔记本电脑，第二天早上回来，连接，任务仍在那里（或者它已完成，输出正在等你）。

## 诚实的对比

### tmux vs. GNU screen

GNU screen 是更老的终端复用器，它也能工作。但 tmux 在实用层面赢得了战斗，原因有三：

- **可脚本化性**——tmux 的命令行接口一致且定义明确。你可以交互式执行的每个操作也可以作为 `tmux` 命令运行。screen 的命令语法不够统一。
- **活跃开发**——tmux 在积极开发中，定期发布。screen 已处于维护模式多年。
- **面板模型**——tmux 的分割面板是一等公民且可脚本化。screen 的分屏支持更原始。

如果你刚开始，用 tmux。如果你已经懂 screen，概念可以直接迁移。

### tmux vs. nohup / systemd

这是一个常见的混淆。`nohup long-job &` 和 `systemd-run --user my-service` 都能在你注销后保持进程存活。但它们解决的是不同的问题：

- **nohup / systemd**——用于*服务*和*批处理作业*。进程在后台运行，写入日志文件，你稍后检查。没有交互式终端连接。
- **tmux**——用于*交互式*工作。你连接，看到完整的 TUI（测试运行器、调试器、`htop`），与之交互，断开连接，回来。

经验法则：如果你曾经想要运行*期间查看*某个东西，用 tmux。如果是需要保持存活的无头服务，用 systemd。如果一个需要一个小时的一次性命令，`nohup` 可以——但 tmux 更好，因为你可以实时观看它。

## 结论

tmux 是那种悄然成为基础设施的工具。学习曲线只有一个晚上：会话、窗口、面板、`attach`、`detach`、`send-keys`、`capture-pane`。回报是你的 SSH 连接变成无状态的——它可以断开，你的笔记本电脑可以休眠，你的网络可以切换——而你的工作就在你离开的地方。

如果你从本文只带走一样东西，让它成为这个：在下一次长时间运行的任务中，在分离的 tmux 会话中启动它。断开连接。回来。重新连接。一旦这个循环变得自然，你会永远不再依赖 SSH 连接的持久性。
