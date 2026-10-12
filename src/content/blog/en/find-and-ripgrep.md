---
title: "find command and ripgrep: the two commands for everything"
description: "A practical walkthrough of the find command and ripgrep as a grep replacement: search files by name, type, size, mtime, user and permission; why -print0 and xargs -0 matter; ripgrep's smart filtering, ignore files and binary detection; fd as a friendlier find; and real recipes."
pubDate: 2026-12-25
lang: en
translationKey: find-and-ripgrep
tags: [linux, devops]
featured: false
keywords:
  - ripgrep
  - find command
  - grep replacement
  - search files
  - fd
  - xargs -0
  - -print0
---

Almost everything I do on a server turns into one of two questions. "Which file is this, and what is it?" is a filesystem question, and the **find command** answers it. "Where does this text live?" is a content question, and **ripgrep** is the **grep replacement** I reach for instead of `grep -r`. Between them they handle the overwhelming majority of the **search files** work I do. This post is the version I wish I'd been handed early: real commands, real output, and the safety rules that keep a search from turning into a delete.

Every command below was run against a small throwaway tree I built in a scratch directory — Python, Rust, JS, Markdown, logs, a binary, a 6 MB dump, and a couple of filenames with spaces. The output is trimmed, not invented. When you need to understand the code you've *found*, that's the next step: [reading a codebase](/posts/reading-a-codebase/). And when you need to know who changed it, that's [git archaeology](/posts/git-archaeology/).

## find and ripgrep: metadata versus content

The dividing line is simple and worth internalising before you type anything:

- **`find` walks the filesystem.** It knows names, types, sizes, timestamps, owners and permissions. It does *not* open files unless you tell it to.
- **`rg` walks the contents.** It reads bytes, matches patterns, and has no idea what a file's size or mtime is.

So "delete every file older than a year" is `find`. "Show me where `SESSION_TTL` is defined" is `rg`. Reaching for `grep -r` to hunt content is fine until you notice it happily wades through `.git`, `node_modules` and binary blobs; that is exactly the work ripgrep skips by default.

<figure>
<svg viewBox="0 0 640 210" role="img" aria-label="Decision diagram: pick find for filesystem metadata, ripgrep for file contents" fill="none" stroke="currentColor" font-family="ui-monospace, monospace">
  <rect x="230" y="12" width="180" height="42" rx="8" stroke-width="1.5"/>
  <text x="320" y="38" text-anchor="middle" font-size="14" fill="currentColor" stroke="none">What do I need?</text>
  <line x1="270" y1="54" x2="140" y2="96" stroke-width="1.5"/>
  <line x1="370" y1="54" x2="500" y2="96" stroke-width="1.5"/>
  <text x="185" y="80" font-size="11" fill="currentColor" stroke="none">name / size / time</text>
  <text x="420" y="80" font-size="11" fill="currentColor" stroke="none">text / pattern</text>
  <rect x="50" y="96" width="180" height="46" rx="8" stroke-width="1.5"/>
  <text x="140" y="115" text-anchor="middle" font-size="13" fill="currentColor" stroke="none">find</text>
  <text x="140" y="132" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">walk the tree</text>
  <rect x="410" y="96" width="180" height="46" rx="8" stroke-width="1.5"/>
  <text x="500" y="115" text-anchor="middle" font-size="13" fill="currentColor" stroke="none">rg</text>
  <text x="500" y="132" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">walk the bytes</text>
  <text x="320" y="190" text-anchor="middle" font-size="10" fill="currentColor" stroke="none">pipe them together when the question is both</text>
</svg>
<figcaption>Two tools, two nouns: the filesystem and the content inside it.</figcaption>
</figure>

## The safety rules: `-print0`, `-0`, and why `rm $(find ...)` bites

Here is the mistake that has cost people entire directories. The obvious way to act on a find result is command substitution:

```bash
rm $(find . -name "*.log")
```

That looks harmless and is not. `find` prints one path per line, and the shell then splits that output on whitespace. A file called `log file with spaces.log` becomes four separate arguments. Let me prove it with a harmless command instead of `rm`:

```bash
$ find . -name "*.txt" | xargs -n1 printf "[%s] "
[./backup/old] [report] [2024.txt]
```

One real file, three mangled arguments. With `rm` in place of `printf`, you would be deleting things that happen to be named `old`, `report` or `2024.txt`. The fix is to stop passing paths as text. `find -print0` separates them with a NUL byte, and `xargs -0` / `grep -Z` read that NUL:

```bash
$ find . -name "*.txt" -print0 | xargs -0 -n1 printf "[%s] "
[./backup/old report 2024.txt]
```

Three rules I follow without thinking:

1. **Never** `rm $(find ...)`. Use `-print0 | xargs -0` or, better, `-exec ... {} +`.
2. **Quote your globs.** `find . -name "*.log"` — unquoted, the shell expands `*.log` against your *current* directory before `find` ever runs.
3. **Preview before you destroy.** Swap `rm` for `ls` or `echo` and run it once. Then run it for real.

## The find command predicates that actually matter

Most of `find`'s value is five predicates. Run against my demo tree, honestly unedited:

```bash
$ find . -name "*.py"
./src/utils/strings.py
./src/api/errors.py
./src/api/routes.py
./src/auth/session.py
./src/auth/login.py

$ find . -type f -name "*.log"
./logs/app.old.log
./logs/app.log
./backup/log file with spaces.log

$ find . -size +1M
./assets/old/dump.bin

$ find . -mtime -7 -type f
./logs/app.log
./docs/guide.md
./src/auth/session.py
...
```

- `-name` / `-iname` match the basename (case-insensitively with `i`).
- `-type f` (`d`, `l`) filters regular files, directories, symlinks.
- `-size +1M` — `+` is "more than", `-` is "less than", and the suffix matters (`c` bytes, `k`, `M`, `G`).
- `-mtime -7` is "modified within the last 7 days"; `-mtime +365` is "older than a year". Use `-newermt "2026-10-01"` when you want a real date.
- `-user`, `-group` and `-perm` handle ownership and mode. `-perm -u+x` means "the owner execute bit is set" (note the leading `-`).

Two more worth remembering: `-maxdepth 2` stops the walk from going deeper, which is a real speed win on huge trees, and `-newer file` means "changed more recently than that file".

## Combining find with `-exec` and `xargs -0`

Once you have a result set, there are two ways to act on it. `-exec` calls a command directly from within `find`:

```bash
$ find . -type f -size +1M -exec ls -lh {} +
-rw-r--r-- 1 awinx awinx 5.8M 10月12日 18:41 ./assets/old/dump.bin

$ find . -type f -name "*.log" -exec wc -l {} +
  3 ./logs/app.old.log
  3 ./logs/app.log
  1 ./backup/log file with spaces.log
  7 总计
```

The `{} +` form passes as many paths per invocation as fit on one command line — far faster than `{} \;`, which spawns one process per file. `-exec` also needs no quoting tricks, because `find` passes each path as its own argument; spaces are safe by construction.

`xargs -0` is the pipe-based equivalent, and it is the one to use when the file list comes from somewhere else or you want to insert it mid-pipeline:

```bash
$ find . -type f -name "*.txt" -print0 | xargs -0 ls -l
-rw-r--r-- 1 awinx awinx 24 2021年 6月 1日 ./backup/old report 2024.txt
```

The mental model: `-exec` is find-native and safe, `-print0 | xargs -0` is composable and safe. Never mix a plain `|` into a command that deletes or moves.

## ripgrep: the grep replacement that skips what you don't want

`rg` is the **grep replacement** I install on every machine. Syntax is familiar:

```bash
$ rg -n "login" src/
src/api/routes.py:11:@app.route("/login", methods=["POST"])
src/api/routes.py:12:def login():
```

Where it diverges from `grep -r` is what it refuses to search. By default ripgrep skips hidden files and honours `.gitignore`, `.ignore` and `.rgignore` — but there's a wrinkle I had to verify rather than assume. Ignore files only take effect **inside a git repository**. In my tree, before `git init`, `rg` searched 2300 files including `node_modules`; after `git init`, the same command searched 2000 and skipped the ignored directory entirely:

```bash
$ rg --stats "login" .      # inside a git repo
2000 files searched
6357768 bytes searched
0.022445 seconds total
```

That filtering is the real win, not raw speed. On a small, warm-cache tree `grep -rn` and `rg` are honestly neck and neck; ripgrep's advantage compounds when it gets to *not read* a vendored directory. To see everything anyway, `rg -uu` disables both ignore files and hidden filtering:

```bash
$ rg "SECRET"          # hidden file, skipped
$ rg --hidden "SECRET"
.hidden/env:SECRET=notreally
```

Binary handling is equally deliberate. ripgrep decides a file is binary when it sees a NUL byte, and then refuses to dump gibberish at your terminal:

```bash
$ rg "login" vendor/secret.bin
binary file matches (found "\0" byte around offset 6)

$ rg -a "login" vendor/secret.bin | cat -v
header^@^@login payload inside binary^@
```

`-a` forces the search; `-uuu` would too. The flags I actually use, in roughly descending order:

- `-t py` / `-t rust` — search only files of a language type; `-T json` excludes.
- `-g "*.md"` / `--glob "!vendor/**"` — include or exclude by glob.
- `-l` lists filenames only; `-c` counts matches per file; `-o` prints just the match.
- `-i` case-insensitive, `-w` whole words, `-F` literal fixed strings.
- `-A2 -B1 -C3` add after/before/context lines.
- `-U` enables multi-line search, so you can match across line boundaries.
- `--json` emits one structured object per event — perfect for scripting.

Context and multi-line, on real files:

```bash
$ rg "hash_password" -A2 -B1 src/auth/login.py

def hash_password(raw: str, salt: bytes) -> str:
    digest = hashlib.sha256(salt + raw.encode()).hexdigest()
    logger.info("hashed password for user")
--
    # TODO: use constant-time comparison
    return hash_password(raw, salt) == expected

$ rg -U -n "def login\(\):[\s\S]*?return jsonify" src/api/routes.py
12:def login():
13:    payload = request.get_json()
14:    return jsonify(user=payload.get("user"))
```

## fd: a friendlier find (when it's installed)

`fd` is a modern `find` replacement with sane defaults: it ignores `.gitignore` out of the box, uses colour, and takes a regex directly instead of all those predicates. On this box it isn't installed:

```bash
$ command -v fd || echo "fd: not installed on this box"
fd: not installed on this box
```

I'm not going to pretend I ran it. The mental mapping is straightforward, though — `fd PATTERN` is roughly `find . -iname "*PATTERN*"`, and `fd -e py` is `find . -name "*.py"`. When `fd` *is* available I use it for interactive "find me that file" work and keep `find` for anything scripted, because `find` is in base POSIX and `fd` is not. A piece of advice: if your scripts shell out to `fd` or `rg`, ship them with a clear failure message when the binary is missing, the way the line above does.

## Real recipes

These are the ones I type most often. All output below is from the demo tree.

### Find the large files eating your disk

```bash
$ find . -type f -size +1M -printf "%s\t%p\n" | sort -rn
6000000	./assets/old/dump.bin

$ find / -xdev -type f -size +500M -printf "%s\t%p\n" 2>/dev/null | sort -rn
```

`-printf` with `%s` is cleaner than `-exec ls -l`, and `-xdev` keeps you on one filesystem instead of descending into mounts.

### Find what changed recently

```bash
$ find . -type f -newermt "2026-10-01" ! -newermt "2026-10-08" -printf "%TY-%Tm-%Td %p\n" | sort
2026-10-05 ./src/api/routes.py
```

This is the "what did the deploy actually touch?" question, answered with real dates rather than mtime integers.

### Search inside one specific tree

```bash
$ rg -t py "import" src/
src/auth/login.py:import hashlib
src/auth/login.py:import logging
src/auth/session.py:import secrets
src/api/routes.py:from flask import Flask, request, jsonify
```

Scope the path instead of fighting the pattern. `rg -t py` means "only Python", which is both faster and less noisy than `-g "*.py"` when you have several extensions in mind.

### Grep by file type

```bash
$ rg -t rust "user"
src/api/handler.rs:    let user = req.query("user");
src/api/handler.rs:    Response::ok(format!("hello {user}"))
```

If `rg` doesn't know a type, `-g` covers it; `rg --type-list` prints everything it recognises.

### List unique matches

```bash
$ rg -o --no-filename "user=\w+" logs/ | sort | uniq -c
      2 user=alice
      2 user=bob

$ rg -o --no-filename -t py "def \w+" src/ | sort -u
def hash_password
def health
def __init__
def is_expired
def login
def new_token
def slugify
def truncate
def verify
```

`-o` prints only the matched text, `--no-filename` drops the path prefix, and then it's ordinary Unix plumbing. This is how I extract every function name, every incident ID or every error code from a codebase in one line.

## When I reach for which

Start with `find` when the answer is a file, and with `rg` when the answer is a line. The two compose: `find` narrows the set by metadata, `rg` reads inside it, and `xargs -0` or a `while IFS= read -r -d ''` loop carries the set across safely. The only thing that ever bites is the join between them — so always `-print0` into `-0`, always quote your globs, and always dry-run a destructive pipeline once. Do that and these two commands really do become the two commands for everything.
