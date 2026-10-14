---
title: "tmux in practice: sessions that outlive your SSH connection"
description: "A practical guide to tmux sessions, windows, and panes: how a terminal multiplexer keeps your work alive across dropped SSH connections, how to script reproducible layouts, and how send-keys and capture-pane enable real automation."
pubDate: 2027-01-30
lang: en
translationKey: tmux-and-session-management
tags: [linux, devops]
featured: false
keywords:
  - tmux
  - tmux sessions
  - terminal multiplexer
  - tmux scripting
  - detach attach
---

If you have ever watched a long compilation or a `scp` transfer die because your SSH connection dropped, you already know the problem tmux solves. And if you have ever alt-tabbed between six terminal windows to keep a dev server, a database shell, and a log tail in view, you know the second problem. tmux — the **terminal multiplexer** — solves both, and it does it with a small set of concepts that are easy to internalise.

I have covered [advanced SSH patterns](/posts/advanced-ssh/) and [bash strict mode](/posts/bash-strict-mode/) before. tmux sits on top of both: it is the layer that keeps your shells alive when the SSH layer gives up, and the layer that lets you organise and script those shells.

## What tmux actually is

tmux is a client-server program. A **server** runs in the background, holding **sessions**. Each session contains **windows** (like tabs), and each window contains **panes** (split views). Your terminal is just a **client** that attaches to a session and renders it. When you detach, the client disconnects but the server keeps running every shell inside the session.

That single design decision — the server survives the client — is why tmux sessions outlive your SSH connection. The shells are children of the tmux server, not of your SSH session. When SSH drops, nothing sends SIGHUP to those shells. They keep running.

## The session / window / pane model

The hierarchy is simple:

- **Session** — a named workspace. One per project or one per long-running job.
- **Window** — a full-screen view within a session, like a browser tab.
- **Pane** — a split region within a window, each running its own shell.

Here is a real three-pane layout, from `list-panes`:

```text
$ tmux -L scratch list-panes -a -F "session:#{session_name} window:#{window_index}.#{window_name} pane:#{pane_index} #{pane_width}x#{pane_height} cmd=#{pane_current_command}"
session:work window:0.bash pane:0 60x30 cmd=bash
session:work window:0.bash pane:1 59x15 cmd=bash
session:work window:0.bash pane:2 59x14 cmd=bash
```

One session, one window, three panes. Pane 0 is 60×30 (full left half), pane 1 is 59×15 (top right), pane 2 is 59×14 (bottom right). Each is an independent bash shell.

<figure>
<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="tmux session with one window and three panes">
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
<figcaption>A tmux session: one window split into three panes, each an independent shell.</figcaption>
</figure>

## The commands you actually use

The command line is where the real power is — it lets you script, automate, and recover:

```bash
# Create a detached session named "work"
tmux new-session -d -s work

# List running sessions
tmux ls
# work: 1 windows (created Wed Oct 14 03:17:52 2026)

# Attach to a session (detach with prefix + d)
tmux attach -t work

# Kill a session when done
tmux kill-session -t work
# no server running on /tmp/tmux-0/scratch
```

The `-d` flag on `new-session` is the key: it creates the session in the background without attaching. That is the foundation of every scriptable workflow.

## Scripting a reproducible dev layout

Because every tmux command works from the shell, you can write a script that builds your entire dev environment in seconds:

```bash
#!/usr/bin/env bash
set -euo pipefail

SESSION="project"
SOCKET="dev"

# Start from a clean slate
tmux -L "$SOCKET" kill-server 2>/dev/null || true
tmux -L "$SOCKET" new-session -d -s "$SESSION" -x 120 -y 30

# Pane 0: editor (full height, left half)
# Pane 1: dev server (top right)
# Pane 2: test runner (bottom right)
tmux -L "$SOCKET" split-window -h -t "$SESSION"
tmux -L "$SOCKET" split-window -v -t "$SESSION:0.1"

# Launch the actual tools
tmux -L "$SOCKET" send-keys -t "$SESSION:0.0" "nvim" Enter
tmux -L "$SOCKET" send-keys -t "$SESSION:0.1" "npm run dev" Enter
tmux -L "$SOCKET" send-keys -t "$SESSION:0.2" "npm test -- --watch" Enter

# Attach to the finished layout
tmux -L "$SOCKET" attach -t "$SESSION"
```

When I run this, I get a three-pane layout with my editor, a dev server, and a test runner — all in under a second. The layout is fully reproducible.

## send-keys and capture-pane: automation without a terminal

The two commands that make tmux genuinely scriptable are `send-keys` and `capture-pane`. Together they let you type into a pane and read the result back.

### send-keys: typing into a pane

`send-keys` sends keystrokes to a pane. You can send literal text, key names, or both:

```bash
# Run a command in pane 0
tmux send-keys -t work:0.0 "echo hello-from-pane-0" Enter

# Send a literal string (no Enter)
tmux send-keys -t work:0.1 "ls -la"
```

The `Enter` key name sends a carriage return. The command runs as if you typed it.

### capture-pane: reading a pane back

`capture-pane` dumps the visible text of a pane to stdout:

```bash
tmux capture-pane -p -t work:0.0 | grep -v "^$"
# root@179763965b4b:/# echo hello-from-pane-0
# hello-from-pane-0
# root@179763965b4b:/#
```

The `-p` flag prints to stdout. The `-t` flag targets a specific pane. This is the pattern I use in CI scripts: send a command, sleep briefly, capture the pane, grep for a success marker.

### pipe-pane: logging everything

`pipe-pane` writes all pane output to a file:

```bash
tmux pipe-pane -t work:0.1 -o "cat >> /workspace/pane1.log"
tmux send-keys -t work:0.1 "echo logged-line-1" Enter
tmux send-keys -t work:0.1 "echo logged-line-2" Enter
```

After running those commands, the log file contains:

```text
echo logged-line-1
logged-line-1
root@179763965b4b:/# echo logged-line-2
logged-line-2
root@179763965b4b:/#
```

Every keystroke and every byte of output is captured — invaluable for debugging a build or recording a reproducible output trail.

### respawn-pane: restarting a pane

If a pane's shell dies (or you want to restart a service), `respawn-pane` brings it back:

```bash
tmux respawn-pane -k -t work:0.2 -c /workspace
tmux send-keys -t work:0.2 "echo respawned-ok" Enter
tmux capture-pane -p -t work:0.2 | grep -v "^$" | head -3
# root@179763965b4b:/workspace# echo respawned-ok
# respawned-ok
# root@179763965b4b:/workspace#
```

The `-k` flag kills the existing command first. The `-c` flag sets the working directory.

## The config file: prefix, mouse, status, true color

My `~/.tmux.conf` is short and opinionated:

```bash
# ~/.tmux.conf — tmux in practice

# Remap prefix from Ctrl-b to Ctrl-a
set -g prefix C-a
unbind C-b
bind C-a send-prefix

# Mouse support
set -g mouse on

# True color
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"

# Status line
set -g status-style "bg=#0f766e,fg=white"
set -g status-left "#[fg=white,bold] #S "
set -g status-right "%H:%M %d-%b-%y"

# Window/pane indexing from 1
set -g base-index 1
setw -g pane-base-index 1

# Easy config reload
bind r source-file ~/.tmux.conf \; display "Config reloaded!"
```

The most impactful change is the prefix remap — `Ctrl-a` is easier to reach than `Ctrl-b`. Mouse support lets you click to select panes and drag to resize. Here is proof the config was applied:

```text
$ tmux show-options -g prefix
prefix C-a
$ tmux show-options -g mouse
mouse on
$ tmux show-options -g status-style
status-style "bg=#0f766e,fg=white"
$ tmux show-options -g status-left
status-left "#[fg=white,bold] #S "
```

The `bind r` line is a quality-of-life addition: press prefix + `r` to reload the config after editing. No need to kill the server or detach.

## Why detached sessions survive

The whole point of tmux is that a session continues running after you disconnect. Here is the proof, using a private socket:

```bash
# Create a detached session
tmux -L scratch new-session -d -s survivor -x 100 -y 25

# It is running
tmux -L scratch list-sessions
# survivor: 1 windows (created Wed Oct 14 03:19:26 2026)

# But nothing is attached
tmux -L scratch list-clients
# [end of list-clients output]
```

The session exists, but zero clients are attached. When you `ssh` back in and run `tmux -L scratch attach -t survivor`, you reconnect to the exact same shells, with the same scrollback, in the same pane layout. The SSH connection can drop a hundred times in between — it does not matter.

This is the workflow that makes tmux indispensable on a remote server: start a long job in a detached session, detach, close your laptop, come back the next morning, attach, and the job is still there.

## The honest comparison

### tmux vs. GNU screen

GNU screen is the older terminal multiplexer, and it works. But tmux has won the practical battle for three reasons: **scriptability** (every interactive action maps to a `tmux` command; screen's syntax is less uniform), **active development** (tmux has regular releases; screen has been in maintenance mode for years), and **pane model** (tmux's split panes are first-class and scriptable; screen's split-screen is primitive). If you are starting fresh, use tmux.

### tmux vs. nohup / systemd

This is a common confusion. `nohup long-job &` and `systemd-run --user my-service` both keep a process alive after you log out. But they solve a different problem:

- **nohup / systemd** — for *services* and *batch jobs*. The process runs in the background, writes to a log file, and you check on it later. No interactive terminal.
- **tmux** — for *interactive* work. You attach, you see the full TUI (a test runner, a debugger, an `htop`), you interact with it, you detach, you come back.

Rule of thumb: if you would ever want to *look at* the thing while it runs, use tmux. If it is a headless service that needs to stay alive, use systemd. If it is a one-off command that takes an hour, `nohup` is fine — but tmux is better because you can watch it live.

## Conclusion

tmux is one of those tools that quietly becomes infrastructure. The learning curve is a single evening: sessions, windows, panes, `attach`, `detach`, `send-keys`, `capture-pane`. The payoff is that your SSH connection becomes stateless — it can drop, your laptop can sleep, your network can change — and your work is exactly where you left it.

If you take one thing from this article, make it this: start your next long-running job in a detached tmux session. Detach. Come back. Reattach. Once that loop clicks, you will never go back to hoping your SSH connection holds.
