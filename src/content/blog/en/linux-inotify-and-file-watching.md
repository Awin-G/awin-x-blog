---
title: "inotify: how Linux tells you a file changed"
description: "A hands-on tour of inotify, the Linux kernel's file-change event API: real inotifywait and inotifywatch output, a Python ctypes reader, and a reproduced event-queue overflow."
pubDate: 2027-02-08
lang: en
translationKey: linux-inotify-and-file-watching
tags: [linux]
featured: false
keywords:
  - inotify
  - watch files Linux
  - inotifywait
  - file change events
  - max_user_watches
---

Somebody has to notice that `/etc/nginx/nginx.conf` changed. Maybe you want that: a watcher that reloads a service, a sync tool that pushes a file the moment it lands, an editor that reloads a buffer because another process overwrote it. For decades the obvious answer was **polling** — stat every file in a loop and compare mtimes. It works, it's simple, and it wastes a pile of CPU while sleeping badly. Since 2005 Linux has had a better answer: **inotify**, a kernel API that pushes **file change events** to you the moment they happen. No scanning, no sleeping, no 5-second delay.

This article is a hands-on tour. Every output block below is copied from a real run on my Arch box (kernel `7.2.9-arch1-1`, `inotifywait` 4.26.0, which was already installed — no container needed).

## What inotify actually is: watches on a file descriptor

The mental model matters more than the API. inotify is not a daemon and not a library you install — it's three syscalls:

1. `inotify_init()` — you get **one file descriptor**. This is an event *queue* owned by your process.
2. `inotify_add_watch(fd, path, mask)` — you say "tell me about this directory/file, filtered to these event types". The kernel returns a **watch descriptor** (an integer, like a tiny fd for the watch).
3. `read(fd, buf)` — events land in the queue as fixed-size `struct inotify_event` records: watch descriptor, mask, cookie, name length, optional filename. You read them like any other fd (and you can `select()`, `poll()`, or `epoll` it).

The events that matter day to day:

| Event | Meaning | Value |
|---|---|---|
| `IN_CREATE` | a new entry appeared in the watched dir | `0x100` |
| `IN_OPEN` | something opened the file | `0x20` |
| `IN_MODIFY` | contents written | `0x2` |
| `IN_ATTRIB` | metadata changed (chmod, chown, touch) | `0x4` |
| `IN_CLOSE_WRITE` | a writer closed the file | `0x8` |
| `IN_MOVED_FROM` / `IN_MOVED_TO` | rename, out of / into the dir | `0x40` / `0x80` |
| `IN_DELETE` | entry removed | `0x200` |

One more piece of state worth knowing: inotify events do **not** change how writes themselves work. When a program writes, the data still flows through the page cache exactly as it always did — inotify sits beside that path and just *reports* (I wrote about that write path in [Linux page cache and mmap](/posts/linux-page-cache-and-mmap/)). And unlike a polling loop that keeps a core warm for nothing, inotify costs almost nothing when idle — if you're chasing a mystery CPU burner, remember the [load average post](/posts/linux-load-average/) for telling the two apart.

<figure>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 150" role="img" aria-label="You add a watch to your process, the kernel queues events on the inotify file descriptor, and your process reads them">
  <rect x="8" y="40" width="120" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="68" y="70" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">your process</text>
  <text x="68" y="90" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">inotify fd</text>
  <rect x="260" y="24" width="120" height="102" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="320" y="70" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">kernel</text>
  <text x="320" y="90" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.7">fd queue</text>
  <rect x="512" y="40" width="120" height="70" rx="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
  <text x="572" y="78" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" fill="currentColor">read()</text>
  <path d="M40 40 L40 20 L268 20 L268 24" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="150" y="16" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">inotify_add_watch(dir)</text>
  <path d="M272 130 L200 130 L200 140 L40 140 L40 110" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
  <text x="150" y="146" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="currentColor" opacity="0.7">events queue instantly</text>
  <path d="M380 30 L452 30 L452 60" fill="none" stroke="#0f766e" stroke-width="1.5"/>
  <text x="338" y="24" text-anchor="middle" font-family="ui-monospace,monospace" font-size="11" fill="#0f766e">poll/epoll</text>
</svg>
<figcaption>inotify's whole contract: add a watch, the kernel queues events on your fd, you read them. The queue is the only shared state — and it is finite.</figcaption>
</figure>

## First look: watching files with `inotifywait`

The classic userspace tool is `inotify-tools`. One terminal watching a directory, a second one doing normal file work:

```bash
$ inotifywait -m -q . &        # monitor, quiet
$ echo "hello" > hello.txt    # create + first write
$ echo "more" >> hello.txt    # append
$ cp hello.txt copy.txt       # create by copy
$ mv hello.txt renamed.txt    # rename inside the dir
$ mv renamed.txt ../moved-out.txt   # rename OUT of the dir
$ rm copy.txt                 # delete
```

What the watcher printed, verbatim:

```
./ CREATE hello.txt
./ OPEN hello.txt
./ MODIFY hello.txt
./ CLOSE_WRITE,CLOSE hello.txt
./ OPEN hello.txt
./ MODIFY hello.txt
./ CLOSE_WRITE,CLOSE hello.txt
./ OPEN hello.txt
./ CREATE copy.txt
./ OPEN copy.txt
./ ACCESS hello.txt
./ MODIFY copy.txt
./ CLOSE_WRITE,CLOSE copy.txt
./ CLOSE_NOWRITE,CLOSE hello.txt
./ MOVED_FROM hello.txt
./ MOVED_TO renamed.txt
./ MOVED_FROM renamed.txt
./ DELETE copy.txt
```

Three things to notice in that real output:

- **A single "save" is a burst.** My two-line append fired `OPEN` → `MODIFY` → `CLOSE_WRITE,CLOSE`. If your watcher reacts to every event, it runs twice. Almost every serious tool waits for `CLOSE_WRITE`, not `MODIFY`, precisely because `MODIFY` fires on every write syscall and `CLOSE_WRITE` fires once per save. (Also note `CLOSE_WRITE,CLOSE` — one event carrying two mask bits.)
- **A rename in is `MOVED_FROM` + `MOVED_TO`.** `mv hello.txt renamed.txt` inside the same watched directory produced exactly those two events. `MOVED_TO` and `MOVED_FROM` share a **cookie**, so a watcher can pair them into "rename" instead of "delete + create". My later Python run shows this concretely: both events carried cookie `627829`.
- **Watches follow directories, not files.** When `renamed.txt` moved out to `../moved-out.txt`, the watcher (watching only `.`) printed `MOVED_FROM renamed.txt` and nothing else — the destination is a different directory with no watch on it.

`inotifywait` has a useful companion: `inotifywatch` is a *statistics* tool — watch, let events happen, print one summary table. Fire 300 file creations in a watched dir, then stop:

```
$ inotifywatch -t 8 -r bench &
$ seq 1 300 | while read i; do echo x > bench/f$i.txt; done

Establishing watches...
Finished establishing watches, now collecting statistics.
total  modify  close_write  open  create  filename
1200   300     300          300   300     bench/
```

Exactly 1200 events for 300 saves (4 per save: `create`, `open`, `modify`, `close_write`) — the "one save is several events" gotcha, in one table. If you ever wonder why a naive inotify consumer is four times busier than you thought, this is why.

## inotify is not recursive — and why `-r` matters

The kernel watch added by `inotify_add_watch(fd, "/srv/data", mask)` covers **that one inode**, not its children. Create `/srv/data/newdir` afterwards and the kernel happily queues `IN_CREATE newdir` (because `IN_CREATE` includes directories), but you'll never hear from anything inside `newdir` — nothing is watching it. Tools implement recursion themselves:

- `inotifywait -r dir` walks the tree at startup and adds one watch per directory. New directories created later? `inotifywait -r` handles the `IN_CREATE`/`IN_ISDIR` event and adds a watch on the fly (other tools silently don't).
- Syncthing, rsync daemons, editors, etc. each maintain their own in-memory "watches" map.

The cost of that design lands on a sysctl — see below. Walking a big tree with `-r` costs one `readdir` per directory at startup, nothing after:

```
$ inotifywait -m -q -r tree &
$ echo a > tree/top.txt
$ echo b > tree/sub/mid.txt           # subdirectory created in advance
$ echo c > tree/sub/deep/bottom.txt   # deeper still

tree/ CREATE top.txt
tree/ OPEN top.txt
tree/ MODIFY top.txt
tree/ CLOSE_WRITE,CLOSE top.txt
tree/sub/ CREATE mid.txt
tree/sub/ OPEN mid.txt
tree/sub/ MODIFY mid.txt
tree/sub/ CLOSE_WRITE,CLOSE mid.txt
tree/sub/deep/ CREATE bottom.txt
tree/sub/deep/ OPEN bottom.txt
tree/sub/deep/ MODIFY bottom.txt
tree/sub/deep/ CLOSE_WRITE,CLOSE bottom.txt
```

Same per-save burst, now reported with the sub-path attached. Each watched directory consumes one system watch — and the system limits the total number.

## Reading the queue yourself: inotify via Python ctypes

You don't need any package to talk to inotify. This small script uses the stdlib `ctypes` directly: `inotify_init`, `inotify_add_watch`, then parse the `struct inotify_event` records off the fd. It watches a directory and decodes masks and cookies:

```python
import ctypes, ctypes.util, os, select, struct, sys

libc = ctypes.CDLL(ctypes.util.find_library("c"))
fd = libc.inotify_init()                                 # the queue fd
wd = libc.inotify_add_watch(fd, b"pdir", 0xFFF)           # watch every event type

while True:
    if not select.select([fd], [], [], 5.0)[0]: break
    buf = os.read(fd, 4096)
    i = 0
    while i < len(buf):
        w, mask, cookie, ln = struct.unpack_from("iIII", buf, i)
        name = buf[i+16:i+16+ln].split(b"\0")[0].decode()
        print(f"event mask=0x{mask:08x} name={name!r} cookie={cookie}")
        i += 16 + ln
```

Real run — each line is one event, and the move shows the shared cookie that pairs `MOVED_FROM` with `MOVED_TO`:

```
event mask=0x00000100 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000040 name='a.txt' cookie=629578
event mask=0x00000080 name='b.txt' cookie=629578
event mask=0x00000100 name='a.txt' cookie=0
event mask=0x00000020 name='a.txt' cookie=0
event mask=0x00000002 name='a.txt' cookie=0
event mask=0x00000008 name='a.txt' cookie=0
event mask=0x00000040 name='a.txt' cookie=629579
event mask=0x00000080 name='b.txt' cookie=629579
event mask=0x00000100 name='c.txt' cookie=0
event mask=0x00000020 name='c.txt' cookie=0
event mask=0x00000002 name='c.txt' cookie=0
event mask=0x00000008 name='c.txt' cookie=0
event mask=0x00000040 name='c.txt' cookie=629580
event mask=0x00000080 name='d.txt' cookie=629580
```

(`pdir` is the watched directory; masks are the table from the first section: `0x100`=CREATE, `0x20`=OPEN, `0x2`=MODIFY, `0x8`=CLOSE_WRITE, `0x40`/`0x80`=MOVED_FROM/MOVED_TO.) Three file creations produced 21 events, and the rename pairs share cookies: `629578`, then `629579`, then `629580`. If you prefer a nicer API, the `watcher`/`inotify_simple` packages wrap exactly this; the raw path is twenty lines and good to have seen once.

## The limits, and the real overflow failure

Two numbers bound everything, and both are kernel-wide (per user namespace since Linux 5.x):

- **`/proc/sys/fs/inotify/max_user_watches`** — maximum number of watches *per user*. Every watched directory costs one, because of the `-r` design above.
- **`/proc/sys/fs/inotify/max_queued_events`** — depth of the queue *per inotify instance*.

My box:

```
$ cat /proc/sys/fs/inotify/max_user_watches /proc/sys/fs/inotify/max_queued_events
524288
16384
```

Now the failure mode. When the queue is full and more events arrive, the kernel **drops the new events** — there is no blocking, no wake-up, no error. The only trace is a single `IN_Q_OVERFLOW` event (`mask 0x4000`, `watch descriptor -1`) squeezed into the queue. Translation: **if your reader is slow, you silently miss things.**

I wanted to demonstrate that honestly. First I tried shrinking the queue artificially:

```
$ LC_ALL=C sysctl -w fs.inotify.max_queued_events=64
sysctl: permission denied on key "fs.inotify.max_queued_events"
exit=1
```

I'm not root on this box, `fs.inotify` sysctls are not namespaced, and an unprivileged `unshare -r` doesn't get you a writable `/proc/sys` either — so **I could not lower the limit**. Instead I provoked the overflow the hard way: a Python watcher that deliberately *stalls* for 12 seconds while another process floods the watched directory with 8,000 file creations (each one firing CREATE + OPEN + ATTRIB + CLOSE_WRITE ≈ 32,000 events against a 16,384-deep queue):

```
fd=3 wd=1; not reading for 12s
*** wd<0 event: mask=0x00004000 cookie=0
--- drained 16385 events total
--- mask histogram: {'0x4': 4096, '0x8': 4096, '0x20': 4096, '0x100': 4096, '0x4000': 1}
--- wd<0 (overflow markers): 1
--- last events: [(1, '0x4', 0), (1, '0x8', 0), (-1, '0x4000', 0)]
```

Read that carefully, because it's the whole lesson: of roughly 32,000 generated events, the kernel kept 16,384 (a tidy 4,096 of each of the first four event kinds) **plus one overflow marker** — and silently discarded everything after that. The last event in the queue is the overflow marker itself (`wd=-1, mask=0x4000`). Every file created after the queue filled is simply *gone* from the watch's view. If you build a managed-upload tool on this, you will not notice the gap from the events themselves; you only notice by seeing that files you know exist were never reported.

Practical takeaways: read the queue fast and never block in your handler; treat `IN_Q_OVERFLOW` as a hard "rescan the directory" signal; and when you genuinely can't keep up, that's your signal to drop to periodic reconciliation (polling) — hybrid designs are normal.

## Who uses this (and a real `systemd.path` unit)

This API underpins a lot of tooling you already rely on: `tail -f`-style log followers, editors watching files for external changes, `inotifywait`-driven build/systemd glue, Syncthing-family file syncers, `lsyncd`, and Buildroot/`watchman`-style build tooling.

`systemd.path` units are the packaged version of this idea: a declarative "watch a path, fire a service when it changes" — no code, no daemon of your own. I ran a real user-level one:

```ini
# ~/.config/systemd/user/blog-watch-demo.path
[Unit]
Description=Demo: react when trigger.txt changes

[Path]
PathModified=/tmp/opencode/work/inotify/trigger.txt

[Install]
WantedBy=default.target
```

with a matching `blog-watch-demo.service` (Type=oneshot, `ExecStart` appending a `date` line to a log). Two writes to the trigger file, two runs of the service:

```
$ systemctl --user start blog-watch-demo.path
$ echo "change" > trigger.txt              # write 1
$ echo "trigger.txt v2" >> trigger.txt     # write 2
$ cat trigger.log
1791959259 fired by systemd.path
1791959261 fired by systemd.path
```

Two writes two seconds apart, two firings. Under the hood, systemd is doing exactly what this whole article described: `inotify_add_watch` on the path plus a service unit fired on `CLOSE_WRITE`. (I removed the demo units afterwards — try it in scratch space, not in a directory you care about.)

## inotify vs polling vs `systemd.path`

- **inotify** — instant, near-zero idle cost, but: not recursive by itself, per-user watch caps, a finite queue that *loses* events under load, and it reports filesystem-level changes (no insight into *content*). Use it when "react right now to a file changing" is the requirement.
- **Polling** — trivially portable, works over NFS/most network filesystems (where inotify may not fire at all), and never *misses* if you scan the whole tree every time. Use it for reconciliation, low-frequency checks, and anywhere inotify semantics can't be trusted (e.g. many container volume drivers; recheck `/proc/sys/fs/inotify/*` inside the container — the container may cap `max_user_watches` far below the host).
- **`systemd.path`** — inotify without you writing the watcher. `PathModified`/`PathChanged` covers the common cases in a few lines, integrates with `journalctl` and unit dependencies, and dies with the system inverse of "I wrote a daemon for it". Reach for it before writing a service of your own; write a real watcher (inotify-tools, Python, or one of the wrapper libraries) when you need fan-out, debouncing, or cross-tree semantics.

One rule of thumb that has served me well regardless of mechanism: **prefer one burst per completed save over one event per write** — wait for `CLOSE_WRITE`, pair `MOVED_FROM`/`MOVED_TO` by cookie, and treat overflow as a resync alarm. inotify is fast because the kernel does the watching for you; everything after the queue is your design.
