---
title: "Python subprocess without shell injection: the list rule, real payloads, real tracebacks"
description: "A hands-on guide to running commands from Python safely: why a list beats shell=True, a real shell injection demo with shlex.quote, check=True, capture_output, timeout, and env and cwd. Every block actually run."
pubDate: 2027-02-06
lang: en
translationKey: python-subprocess-and-shell-safety
tags: [python, security]
featured: false
keywords:
  - Python subprocess
  - shell injection
  - shell=True
  - subprocess.run
  - shlex.quote
---

Every Python program that touches the outside world eventually runs a command. `git`, `ffmpeg`, `openssl`, some internal CLI. The API is one function — `subprocess.run` — and the difference between a convenience and a vulnerability is usually one keyword: `shell=True`. This article is about that difference, and everything below was actually executed on my machine. Python 3.14.7, a scratch directory under `/tmp/opencode/work/subprocess`, and a payload that only prints.

## The two shapes of a command

`subprocess.run` takes the command in one of two shapes.

The first is **a list of arguments**. The list is handed to the kernel as `argv` — one list item, one `argv` entry, no interpretation in between.

```python
subprocess.run(["ls", "-l", "demo"])
```

The second is **a string**, which is meaningless without a shell to parse it — so `shell=True` spawns `/bin/sh -c "<the string>"`. The string gets re-parsed: metacharacters are interpreted, quoting is applied, expansions happen.

```python
subprocess.run(f"ls -l {base}/demo", shell=True)
```

That re-parsing step is the entire problem. A filename is a *value*; `ls -l <file>` is *code*. When you build the code with an f-string, you are concatenating a value into a program.

The one rule, and it has no exceptions worth arguing about: **never pass untrusted input to `shell=True`; prefer a list.**

## The injection, demonstrated for real

Here is the experiment. One untrusted value — `hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it` — passed four ways. Everything stays inside my scratch directory, and the payload's `echo` is the only thing it "does".

```python
name = "hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it"
```

The script (`demo1_list_vs_shell.py`):

```python
import subprocess
from pathlib import Path

base = Path("/tmp/opencode/work/subprocess")
(base / "demo").mkdir(exist_ok=True)
(base / "demo" / "hello.txt").write_text("hello\n")

subprocess.run(["ls", "-l", "demo"])                              # A: list
subprocess.run(f"ls -l {base}/demo", shell=True)                  # B: literal
subprocess.run(f"ls -l {base}/demo/{name}", shell=True)           # C: injection
subprocess.run(["ls", "-l", f"{base}/demo/{name}"])               # D: same input
```

Real output:

```
=== A) list of args (recommended) ===
total 4
-rw-r--r-- 1 awinx awinx 6 Oct 14 13:33 hello.txt

=== C) shell=True with untrusted input ===
-rw-r--r-- 1 awinx awinx 6 Oct 14 13:33 /tmp/opencode/work/subprocess/demo/hello.txt
INJECTED-if-this-prints-the-shell-parsed-it

=== D) the SAME untrusted input, passed as a list ===
ls: cannot access '/tmp/opencode/work/subprocess/demo/hello.txt; echo INJECTED-if-this-prints-the-shell-parsed-it': No such file or directory
```

Read section C and section D side by side, because they are the whole article.

In C, `/bin/sh -c "ls -l .../hello.txt; echo INJECTED..."` runs **two** commands. `ls` lists the real file, and then the semicolon ends the statement and the injected `echo` runs. The attacker picked the program; your process just paid for the privilege.

In D, the identical string went to `execve` as a single `argv[2]`. There is no shell in the chain, so nothing is parsed. `ls` receives a filename that happens to contain a semicolon and reports, honestly, that no such file exists. The payload is inert — not sanitised, *structurally* inert. Safety came from the shape of the call, not from inspecting the input.

That is the property to internalise: with a list, a hostile filename is still a hostile filename, but it cannot stop being a filename.

<figure>
<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="Left path: a list of three arguments goes straight to execve and arrives at the program as argv 0, argv 1 and argv 2, with a hostile filename kept whole. Right path: a shell string is parsed by the shell, which splits it on metacharacters into two separate commands.">
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="26" opacity="0.9">A list of arguments → one argv entry each</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="16" y="44" width="150" height="52" rx="8"/>
    <rect x="186" y="44" width="150" height="52" rx="8"/>
    <rect x="356" y="44" width="264" height="52" rx="8"/>
    <path d="M166 70 h20" marker-end="url(#hfm1)"/>
    <path d="M336 70 h20" marker-end="url(#hfm1)"/>
  </g>
  <defs>
    <marker id="hfm1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="91" y="66">["ls", "-l",</text>
    <text x="91" y="86" opacity="0.75">three list items</text>
    <text x="261" y="66">"ls" "-l"</text>
    <text x="261" y="86" opacity="0.75">execve(argv)</text>
    <text x="488" y="66">"evil; echo INJECTED"</text>
    <text x="488" y="86" opacity="0.75">argv[2] — ONE argument</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor">
    <text x="16" y="140" opacity="0.9">A shell string → re-parsed by the shell</text>
  </g>
  <g stroke="#0f766e" stroke-width="1.5" fill="none" opacity="0.85">
    <rect x="16" y="156" width="150" height="52" rx="8"/>
    <rect x="186" y="156" width="150" height="52" rx="8"/>
    <rect x="356" y="156" width="128" height="52" rx="8"/>
    <rect x="500" y="156" width="120" height="52" rx="8"/>
    <path d="M166 182 h20" marker-end="url(#hfm2)"/>
    <path d="M336 182 h20" marker-end="url(#hfm2)"/>
    <path d="M484 182 h16" marker-end="url(#hfm2)"/>
  </g>
  <defs>
    <marker id="hfm2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="#0f766e"/>
    </marker>
  </defs>
  <g font-family="system-ui, sans-serif" font-size="13" fill="currentColor" text-anchor="middle">
    <text x="91" y="178">"ls -l evil;</text>
    <text x="91" y="198" opacity="0.75">echo INJECTED"</text>
    <text x="261" y="178">/bin/sh -c</text>
    <text x="261" y="198" opacity="0.75">tokenise</text>
    <text x="420" y="180">ls -l evil</text>
    <text x="560" y="180">echo INJECTED</text>
  </g>
</svg>
<figcaption>Same untrusted filename, two shapes. A list keeps it one argument; a shell string hands the parser a second command.</figcaption>
</figure>

## When you genuinely need a shell: `shlex.quote`

Sometimes the shell is unavoidable — a pipeline, a glob, a redirect the library does not expose. Then the value must be quoted *for the shell*, and `shlex.quote` is the tool that does it correctly instead of your regex.

```python
import shlex
import subprocess

name = "x; echo INJECTED"
subprocess.run(f"cat {base}/{shlex.quote(name)}", shell=True)
```

What actually gets built:

```
cat /tmp/opencode/work/subprocess/demo2/'x; echo INJECTED'
```

And what `cat` reports — one argument, semicolon intact, injected `echo` never executed:

```
=== A) shell=True, raw f-string ===
cat: /tmp/opencode/work/subprocess/demo2/x: No such file or directory
INJECTED

=== B) shell=True, shlex.quote(name) ===
cat: '/tmp/opencode/work/subprocess/demo2/x; echo INJECTED': No such file or directory
```

In A the shell split the string, `cat` tried the nonexistent path `demo2/x`, and `echo INJECTED` ran. In B the single quotes from `shlex.quote` told the shell to keep the whole mess as one word, so the injection silently became a filename.

`shlex.quote` is the correct fix and also the weaker one: it is a patch applied to a design that already went wrong. Quote the *whole* argument, never half of it, and never quote and then re-split. If you find yourself quoting several pieces of a command, that is the moment to rewrite the call as a list.

## Error handling: `check=True` and `CalledProcessError`

By default `subprocess.run` returns a `CompletedProcess` with a non-zero `returncode` and says nothing. Silence is not success — if the build failed and you continue, you ship a stale artifact.

```python
r = subprocess.run(["ls", "definitely-not-here"], check=True)
```

raises:

```
Traceback (most recent call last):
  File "/tmp/opencode/work/subprocess/demo4_traceback.py", line 4, in <module>
    subprocess.run(["ls", "definitely-not-here"], check=True)
    ~~~~~~~~~~~~~~
  File "/usr/lib/python3.14/subprocess.py", line 578, in run
    raise CalledProcessError(retcode, process.args,
                             output=stdout, stderr=stderr)
subprocess.CalledProcessError: Command '['ls', 'definitely-not-here']' returned non-zero exit status 2.
```

`CalledProcessError` carries `cmd`, `returncode`, and — when you captured them — `output` and `stderr`, so a handler can log the failing invocation rather than a bare "command failed". If you deliberately tolerate failure (checking a version, probing for a binary), set `check=False` and inspect `returncode` yourself.

## Capturing output: `capture_output=True` and `text=True`

Without capture, the child's output goes straight to your terminal, which is useless for machinery. `capture_output=True` pipes both streams; `text=True` decodes them to `str` instead of leaving you with `bytes`.

```python
r = subprocess.run(["cat", "cfg.txt"], capture_output=True, text=True)
```

```
returncode=0
stdout='MODE=production\n'
stderr=''
```

One caveat worth burning into memory: **never capture stdout of a long-lived or chatty process without a timeout or a thread reading the pipe** — a full pipe buffer blocks the child forever, and your `run()` call hangs with it. Capture what you will actually read, and drain promptly.

## Timeouts: `timeout=` and `TimeoutExpired`

A command can hang: a dead service, a `git` waiting on a credential prompt, a script stuck on stdin. `timeout` is the seatbelt, and it kills the process on expiry.

```python
subprocess.run(["python3", "-c", "import time; time.sleep(30)"], timeout=2)
```

```
caught: TimeoutExpired cmd=['python3', '-c', 'import time; time.sleep(30)'] timeout=2
```

Note that `TimeoutExpired` is raised regardless of `check`, and that killing the direct child does not stop grandchildren it spawned — for a process tree, use `start_new_session=True` and kill the process group, or delegate to a supervisor like `timeout(1)`.

## `env=` and `cwd=`

`cwd` sets the working directory; `env` **replaces** the environment entirely rather than extending it. That surprises people: forget `PATH` and even `git` becomes unfindable.

```python
env = {"MODE": "staging", "PATH": "/usr/bin:/bin"}
subprocess.run(["python3", "tool.py"], env=env, cwd=base)
```

```
MODE   = staging
PATH   = /usr/bin:/bin
cwd    = /tmp/opencode/work/subprocess/demo3
```

compared with the inherited default, where `MODE` is simply absent:

```
MODE   = None
PATH   = /home/awinx/.local/bin:...
```

So the idiom for "same world, one more variable" is `env={**os.environ, "MODE": "staging"}`. And a hidden `PATH` is a real attack surface: if `PATH` is attacker-controlled, `subprocess.run(["git", ...])` may execute the attacker's `git`. Prefer absolute paths for privileged callers, or reset `PATH` to a known-safe prefix.

## The real-world shape

A concrete helper. An untrusted ref arrives from a webhook and must reach `git`. The list form makes the untrusted value one `argv` entry; `git` itself then rejects it, and logs it.

```python
def show_file(ref: str) -> str:
    r = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref],
        cwd=repo, capture_output=True, text=True, timeout=10,
    )
    if r.returncode != 0:
        return f"error: {r.stderr.strip()}"
    return r.stdout.strip()
```

With `ref = "main; echo INJECTED-VIA-SHELL"`:

```
1) safe: list form, untrusted ref
error: fatal: Not a valid object name main; echo INJECTED-VIA-SHELL
2) safe: list form, clean ref
notes.md
3) naive: shell=True with the same untrusted ref
fatal: Not a valid object name main
INJECTED-VIA-SHELL
4) lazy fix: shell=True + shlex.quote
stderr: fatal: Not a valid object name main; echo INJECTED-VIA-SHELL
```

Three ways to handle one hostile string, and only one of them runs the payload. Note also the layered result: even the *safe* path lets `git` tell you the ref is invalid, so validation happens in the tool that owns the semantics — not in your quoting code.

## `subprocess` versus `os.system`, and versus a library

`os.system` always goes through the shell and only returns an exit status — you cannot capture output or pass a list. `os.popen` likewise always spawns a shell and hands back a file-like object. Both are thin wrappers over `/bin/sh` and both keep the injection surface permanently open. If you see them in review, replace them.

```python
import os
os.system("echo os.system-said-hello")        # returncode only
with os.popen("echo os.popen-said-hello") as p:
    p.read()                                  # shell, always
```

There is also the older `Popen` interface. It is fine, but `run` is a thin wrapper over it and 95% of code is clearer as `run`. Reach for `Popen` when you need streaming, interactivity, or non-blocking reads.

And the more senior question: **should you shell out at all?** If a library can do it, use the library. Parsing `git log` is worse than using a Git library; parsing `ffprobe` output with regex is worse than a media probe; shelling out to `ls` and string-splitting the result is worse than `os.scandir`. Native Python works on Windows, raises structured exceptions, and cannot inject anything. Reserve `subprocess` for CLI tools with no library equivalent.

A related note on parsing: if your command's output is anything like shell text, remember that [bash has its own set of traps](/posts/bash-strict-mode/) — an audit of the tooling around your Python is worth the afternoon. And if the child process accumulates memory over a long run, [the tracemalloc workflow](/posts/python-memory-leaks/) explains how I find that without guessing.

## Checklist

- [ ] Command passed as a **list**; `shell=True` appears only where the shell is genuinely required.
- [ ] Untrusted input reaches the command as a single `argv` entry — never interpolated into a string.
- [ ] When a shell is unavoidable, every interpolated piece goes through `shlex.quote`.
- [ ] `check=True` (or an explicit `returncode` check) on anything whose failure matters.
- [ ] `capture_output=True` with `text=True` where output is consumed; drained, not left to block.
- [ ] A `timeout=` long enough to be honest and short enough to matter.
- [ ] `cwd` and `env` explicit; `PATH` never inherited from an untrusted caller.
- [ ] Absolute paths to binaries in security-sensitive callers.
- [ ] No `os.system`, no `os.popen`, no `os.exec*` without a list.
- [ ] A library considered, and the reason for rejecting it written down.

## Authorised use

Everything above ran in a scratch directory I own, and the injected payload only printed a line — it never deleted, wrote, or transmitted anything. Read this article to defend the systems you are authorised to test, and keep the destructive version of the payload in your head, not in someone else's repository.
