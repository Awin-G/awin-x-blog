---
title: "Git archaeology: how to find when and why a line changed"
description: "A practical method for git archaeology: use git log -S (the pickaxe) and -G to find when a string changed, git log -L to follow one function, git blame and its -w/-C limits, --follow across renames, and git bisect run to catch the commit that broke it — then read the why, not just the what."
pubDate: 2026-12-05
lang: en
translationKey: git-archaeology
tags: [devops, linux]
featured: false
keywords:
  - git log -S
  - git blame
  - git bisect
  - git archaeology
  - pickaxe
---

Somebody changed one line six months ago and now something is subtly wrong. There is
no ticket, no comment, no obvious author. This is the moment for **git archaeology**:
digging through history to answer *when* a line changed and *why*. The good news is
that git recorded everything; the bad news is that the tools are full of traps, and
the most popular one — `git blame` — answers the wrong question. My usual first move
is not blame at all. It is `git log -S`, the pickaxe, searching for the exact string
that puzzles me.

Here is the workflow I actually run, on a throwaway repository that I built so every
command below prints something real.

## A small repo with a buried regression

The demo is a newsletter digest fetcher. It grows from a single file to a package,
a helper function moves between files, and one day a refactor quietly removes a
backoff cap. The history looks like this:

```text
* f227728 feat: render the digest as a plain-text report
* 94d0479 style: reflow core/ (trailing whitespace, no logic change)
* d3288d9 docs: note the API rate limit in the README
* 65b321f simplify backoff: the cap was never hit in practice   <-- the bug
* 389277e (tag: v0.2.0) extract retry_delay and clamp into core/util.py
* f291cea refactor: move digest.py under core/ to make room for more modules
* dfb797b (tag: v0.1.0) retry transient API failures with exponential backoff
* 542a97f init: fetch newsletter items from the API
```

Eight commits. Small enough to eyeball, which is exactly why it is a good teaching
example: the bug is invisible in the top-level summary, because the commit message
is confident and misleading.

## `git log -S`: the pickaxe finds when a string changed

The pickaxe is `git log -S<string>`. It walks history and shows every commit where
the *number of occurrences* of `<string>` changed — a commit that added it, or
removed it, but not one that merely reworded around it. When you know a magic
constant, a flag name, or an API identifier but not where it came from, this is the
fastest question in git:

```console
$ git log -S 'BACKOFF_CAP' --oneline
65b321f simplify backoff: the cap was never hit in practice
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff
```

Three commits, three seconds, and the whole life of that constant is on screen:
introduced, moved, and deleted. Now I know the deletion is my prime suspect. Adding
`--stat` (or `-p`) turns each hit into a diff, so I can see *only* the relevant
hunks instead of the whole commit:

```console
$ git log -S 'BACKOFF_CAP' --stat
65b321f simplify backoff: the cap was never hit in practice
 core/util.py | 3 +--
 1 file changed, 1 insertion(+), 2 deletions(-)
```

If the string moved between files, the pickaxe follows it for free, because it
compares every diff in every branch of history. That is precisely the case `git
blame` cannot handle — more on that below.

## `-S` versus `-G`: counting occurrences versus matching diffs

There is a sibling flag that trips people up. `-S` counts occurrences of a literal
string; `-G<regex>` shows any commit whose diff contains a `+` or `-` line matching
a regular expression. On the same token they mostly agree, but they diverge exactly
on the changes that fool you:

```console
$ git log -S 'retry_delay' --oneline
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff

$ git log -G 'retry_delay' --oneline
94d0479 style: reflow core/ (trailing whitespace, no logic change)
389277e extract retry_delay and clamp into core/util.py
dfb797b retry transient API failures with exponential backoff
```

The reflow commit `94d0479` only added trailing whitespace, so the *count* of
`retry_delay` did not change and `-S` correctly ignores it. `-G` sees a matching
`+`/`-` line and reports it. The rule of thumb: reach for `-S` to find the commit
that introduced or removed a thing; reach for `-G` when the string may have been
edited in place and you want every diff that touched a line near it — accepting that
`-G` returns formatting noise too.

## `git log -L`: follow one function through its edits

When the question is about a *function* rather than a string, `-L` reads like a
screenplay of that function's life. It takes a line range or, better, a
`function:file` pair:

```console
$ git log -L ':retry_delay:core/util.py' --oneline -s
94d0479 style: reflow core/ (trailing whitespace, no logic change)
65b321f simplify backoff: the cap was never hit in practice
389277e extract retry_delay and clamp into core/util.py
```

Each entry is a diff limited to that function, so I can watch `min(2 ** attempt,
BACKOFF_CAP)` turn into bare `2 ** attempt` without reading a single unrelated line.
`-L` understands Python, C, Go, Rust, and more — it finds the function by name using
a built-in regex per language.

The catch: `-L` is scoped to one path in one file. It will not follow a function that
moved to another file — combine it with `--follow` and git simply refuses:

```console
$ git log --follow -L ':retry_delay:core/util.py' --oneline -s
fatal: --follow requires exactly one pathspec
```

So for a function that moved, I run `-L` against the old file *and* the new one. The
old location shows where it came from, the new one shows what happened after:

```console
$ git log -L ':retry_delay:core/digest.py' --oneline -s
389277e extract retry_delay and clamp into core/util.py
```

Two commands, one story: the function lived in `core/digest.py` until `389277e`
pulled it out into `core/util.py`.

## `git blame` and its limits

`git blame` annotates every line with the last commit that touched it. It is the
command everyone reaches for and the one that lies most often, because "last touched"
is not "introduced". Start with the honest view:

```console
$ git blame -L 8,15 core/util.py
389277e (DeepSeek 2026-10-01 10:20:00 +0800  8) def retry_delay(attempt):
94d0479 (DeepSeek 2026-10-18 19:30:00 +0800  9)     """Seconds to wait before retry `attempt` (zero-based)."""
65b321f (DeepSeek 2026-10-12 14:55:00 +0800 10)     return 2 ** attempt
...
94d0479 (DeepSeek 2026-10-18 19:30:00 +0800 13) def clamp(value, lo, hi):
```

Line 10 blames the bug commit `65b321f`, which is true. But lines 9 and 13 blame the
*reflow* commit, which changed nothing but whitespace — a false lead if you are
hunting for meaning. `-w` tells blame to ignore whitespace-only changes, and the
noise collapses:

```console
$ git blame -L 8,15 -w core/util.py
389277e (DeepSeek 2026-10-01 10:20:00 +0800  8) def retry_delay(attempt):
389277e (DeepSeek 2026-10-01 10:20:00 +0800  9)     """Seconds to wait before retry `attempt` (zero-based)."""
65b321f (DeepSeek 2026-10-12 14:55:00 +0800 10)     return 2 ** attempt
...
389277e (DeepSeek 2026-10-01 10:20:00 +0800 13) def clamp(value, lo, hi):
```

The other limit is the *copy*. Blame credits the commit that pasted code, not the
commit that wrote it, so a copy-paste refactor looks like brand-new code. `-C` makes
blame hunt for lines copied from other files (repeat it — `-C -C -C` searches
harder). Here a helper was pasted verbatim into `core/report.py`:

```console
$ git blame -C -C -C --oneline core/report.py
f227728 core/report.py (DeepSeek 2026-10-20 13:12:00 +0800  1) """Render the fetched items as a plain-text report."""
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  4) def clamp(value, lo, hi):
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  5)     """Force `value` into the inclusive range [lo, hi]."""
389277e core/util.py   (DeepSeek 2026-10-01 10:20:00 +0800  6)     return max(lo, min(value, hi))
```

The copied lines now point at their true origin in `core/util.py`, not at the paste.
Two flags, `-w` and `-C`, fix most of what is wrong with `git blame`.

## Following a file across renames with `--follow`

Renames break history unless you ask for `--follow`. Without it, the log stops at
the commit that created the *current* path:

```console
$ git log --oneline -- core/digest.py
f227728 feat: render the digest as a plain-text report
389277e extract retry_delay and clamp into core/util.py
f291cea refactor: move digest.py under core/ to make room for more modules

$ git log --follow --oneline -- core/digest.py
f227728 feat: render the digest as a plain-text report
389277e extract retry_delay and clamp into core/util.py
f291cea refactor: move digest.py under core/ to make room for more modules
dfb797b retry transient API failures with exponential backoff
542a97f init: fetch newsletter items from the API
```

The extra two commits are the file's life under its old name, `digest.py`. Two rules
keep this honest: `--follow` accepts exactly one path (it is a heuristic, not a
database), and at a merge it may pick the wrong parent. For anything load-bearing,
cross-check with the pickaxe, which needs no rename detection because it scans every
diff. This is the same discipline I described in
[git for a solo developer](/posts/git-for-solo-developers/): history only pays off
if you can read it.

## Narrow the log: `--author`, `--since`, and `-- path`

Before reading diffs, shrink the haystack. The three filters I use most:

```console
$ git log --oneline --since='2026-10-10'
f227728 feat: render the digest as a plain-text report
94d0479 style: reflow core/ (trailing whitespace, no logic change)
d3288d9 docs: note the API rate limit in the README
65b321f simplify backoff: the cap was never hit in practice

$ git log --oneline --since='2026-10-01' -- core/util.py
94d0479 style: reflow core/ (trailing whitespace, no logic change)
65b321f simplify backoff: the cap was never hit in practice
```

Combine `--since`, `--until`, and `--author` with a trailing `-- path` and a
thousand-commit history becomes four commits you can actually read. `--oneline
--graph --decorate` on top of these is where I start almost every investigation.

## `git bisect`: let the machine find the breaking commit

Filters tell you *where to look*; **git bisect** tells you *exactly which commit
broke it*. You give it one known-good and one known-bad commit, and it binary
searches the range, halving it each step — a thousand commits become about ten tests.

<figure>
  <svg viewBox="0 0 760 250" width="100%" role="img" aria-labelledby="bisect-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="bisect-title">How git bisect halves the search range</title>
    <desc id="bisect-desc">A range of commits between a good and a bad endpoint is split at the midpoint; each test discards half until one commit remains.</desc>
    <text x="20" y="26" fill="currentColor" font-weight="600">good v0.2.0</text>
    <text x="640" y="26" fill="currentColor" font-weight="600">bad HEAD</text>
    <line x1="30" y1="46" x2="730" y2="46" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="30" cy="46" r="5" fill="#0f766e"/>
    <circle cx="730" cy="46" r="5" fill="currentColor"/>
    <text x="380" y="36" text-anchor="middle" fill="currentColor">5 commits in range</text>
    <line x1="380" y1="46" x2="380" y2="96" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="86" text-anchor="middle" fill="#0f766e">test midpoint</text>
    <text x="700" y="96" text-anchor="middle" fill="currentColor" font-size="12">f227728 bad</text>
    <line x1="30" y1="120" x2="380" y2="120" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="30" cy="120" r="5" fill="#0f766e"/>
    <text x="205" y="110" text-anchor="middle" fill="currentColor">left half: good → discard right</text>
    <line x1="205" y1="120" x2="205" y2="168" stroke="#0f766e" stroke-width="1.5"/>
    <text x="205" y="158" text-anchor="middle" fill="#0f766e">test midpoint</text>
    <line x1="205" y1="182" x2="380" y2="182" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="300" cy="182" r="6" fill="#b91c1c"/>
    <text x="470" y="186" fill="currentColor">65b321f first bad commit</text>
    <text x="20" y="234" fill="currentColor" font-size="12">Each test halves the range. log₂(1000) ≈ 10 tests to pin one commit.</text>
  </svg>
  <figcaption>Bisect does not read diffs; it runs your test at a midpoint and keeps the half that still fails, until one commit is left.</figcaption>
</figure>

The manual loop is `git bisect start`, `git bisect bad`, `git bisect good <ref>`, and
then marking each test `good`/`bad` by hand. Automation is the whole point: pass a
command with `bisect run` and let it decide via exit code (0 = good, non-zero = bad).
My reproduction script checks the invariant directly and reports failure when the cap
is gone:

```sh
#!/bin/sh
# Exit 0 while the backoff delay is capped, non-zero once the cap regresses.
exec python3 - <<'PY'
import importlib.util, os, sys
path = next((p for p in ["core/util.py", "core/digest.py", "digest.py"]
             if os.path.exists(p)), None)
spec = importlib.util.spec_from_file_location("mod", path)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
sys.exit(0 if mod.retry_delay(6) <= 30 else 1)
PY
```

```console
$ git bisect start
$ git bisect bad                 # HEAD is broken
$ git bisect good v0.2.0         # this tag was fine
$ git bisect run ./check_backoff.sh
running './check_backoff.sh'
Bisecting: 0 revisions left to test after this (roughly 0 steps)
[65b321f0c3e042d7c257e18c2b2ab4cbb6157f66] simplify backoff: the cap was never hit in practice
running './check_backoff.sh'
65b321f0c3e042d7c257e18c2b2ab4cbb6157f66 is the first 'bad' commit
...
bisect found first 'bad' commit
$ git bisect reset
```

Three commits in this toy repo, but the number in the parenthesis — *roughly N steps*
— is the payoff: for a real thousand-commit range, bisect runs about ten tests and
hands you one SHA. The one investment that matters is a repro script you trust; get
that right and bisect is deterministic, not clever.

## Reading the why: `git show`, `git diff`, and the message

Bisect names the commit; it does not explain it. That is the next step, and it is
where most people stop too early. `git show` prints the commit, the message, and the
diff together:

```console
$ git show 65b321f
commit 65b321f... 
    simplify backoff: the cap was never hit in practice

diff --git a/core/util.py b/core/util.py
@@ -3,12 +3,11 @@
 RETRIES = 5
-BACKOFF_CAP = 30  # seconds
 def retry_delay(attempt):
-    return min(2 ** attempt, BACKOFF_CAP)
+    return 2 ** attempt
```

The message is the trap. "The cap was never hit in practice" sounds reasonable and is
the entire justification — and it is wrong, because the cap existed precisely for the
one bad day when the upstream API is down and the retry loop would otherwise sleep
for minutes. The diff shows the *what*; only the message (and, in a real repo, the
linked issue or PR) can show the *why* — and here the why was a guess that later
turned out to be a regression. That is the whole point of archaeology: separate the
change from its justification, then ask whether the justification still holds.

When the commit does not carry the story, the issue tracker is the next dig site:
follow the `Fixes #1234` trailer, read the discussion, and check whether the
assumption that motivated the change is still true. And if the problem is that you do
not yet understand the surrounding code, that is a different skill — the method I use
for that is in [how to read a codebase you didn't write](/posts/reading-a-codebase/).

## A git archaeology checklist

The order I reach for, roughly from cheapest to most expensive:

1. **`git log -S 'string'`** — when a constant, flag, or name changed (the pickaxe).
2. **`git log -G 'regex'`** — when a line may have been edited in place.
3. **`git log -L :func:file`** — when the question is about one function's evolution.
4. **`git blame -w -C -C -C`** — when "who last touched this" is still useful, after
   stripping whitespace and chasing copies.
5. **`git log --follow`** + `--since`/`--author`/`-- path` — when you need to shrink
   the haystack before reading diffs.
6. **`git bisect run`** — when you have a reliable repro and need the exact commit.
7. **`git show` and the linked issue** — always, last, to read the *why*.

None of it is clever. The skill is picking the cheapest tool that answers the actual
question and refusing to trust `git blame` alone. History is the only documentation
that cannot drift out of date; the work is learning to read it without being misled
by the commit that merely formatted the line you care about.
