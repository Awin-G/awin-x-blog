---
title: "Bash strict mode and the mistakes that bite in production"
description: "A hands-on tour of bash strict mode: what set -euo pipefail really does, the cases where set -e silently gives up, how word splitting and IFS break scripts, cleaning up with trap EXIT and mktemp, reading PIPESTATUS, and why shellcheck is the real safety net. Every pitfall shown with a real script that fails."
pubDate: 2026-12-26
lang: en
translationKey: bash-strict-mode
tags: [linux, devops]
featured: false
keywords:
  - bash strict mode
  - set -euo pipefail
  - shellcheck
  - bash pitfalls
  - word splitting
---

The worst script I shipped last year finished in 0.4 seconds and printed
`backup looks done`. It copied nothing: the source path was wrong, `cp` failed,
and nothing told the script to stop. That is the case for **bash strict mode** —
by default a shell script ignores almost every failure and returns the exit code
of whatever happened to run last.

This is a tour of `set -euo pipefail`, the places where `set -e` *still* gives
up, and the quoting rules behind most "works on my machine" bugs. Every failure
below is a real script, output pasted verbatim.

## What bash strict mode actually buys you

Strict mode is one line after the shebang:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

It does not make a script correct. It removes three specific classes of
silence — the closest thing bash has to a compiler warning. It will not quote
your variables, validate your input, or stop `rm` from following a wrong path;
strict mode is a seatbelt, not a driver. You still have to steer.

### `-e` (`errexit`): stop on a failed command

Without it, a failure is just a line that prints an error and moves on:

```bash
#!/usr/bin/env bash
rm -f priceless.txt
cp missing-source.txt priceless.txt   # fails
echo "backup looks done"
```

```console
$ bash noe.sh
cp: cannot stat 'missing-source.txt': No such file or directory
backup looks done
ls: cannot access 'priceless.txt': No such file or directory
```

The exit status is the *last* command's, which is how the script "succeeded at
printing a lie". Add `set -e` and the `cp` failure ends it.

### `-u` (`nounset`): stop on an unset variable

An unset variable expands to the empty string, which is how `rm -rf "$DIR/"`
becomes `rm -rf /`:

```bash
set -u
echo "start"
echo "DEBUG=${DEBUG_MODE}"   # never set anywhere
echo "end"
```

```console
$ bash u.sh
start
u.sh: line 4: DEBUG_MODE: unbound variable
```

`end` never prints. That is the point.

### `-o pipefail`: make a pipeline report its worst stage

The most under-used flag. Without it, a pipeline's status is its **last**
command's, so an upstream failure vanishes:

```bash
set -eu
echo "importing..."
cat /does/not/exist.csv | wc -l
echo "import finished OK (exit $?)"
```

```console
$ bash pipe.sh
importing...
cat: /does/not/exist.csv: No such file or directory
0
import finished OK (exit 0)
```

`wc -l` counted zero lines from a nonexistent file and reported success. With
`pipefail`, the `cat` failure becomes the pipeline's status and `-e` kills it.

## Where `set -e` quietly stops helping (bash pitfalls)

`set -e` is not a force field. Bash documents contexts where it is disabled;
these are the ones that cost people data.

### A command in a condition is exempt

Anything in an `if`, `while`, `until`, `&&`/`||` list, or after `!` is
*expected* to fail, so `-e` is suspended for it:

```bash
set -e
if ! grep -q "deprecated" notes.txt; then
  echo "notes.txt has no 'deprecated' marker"
fi
echo "reached the end"
```

```console
$ bash ifgotcha.sh
grep: notes.txt: No such file or directory
notes.txt has no 'deprecated' marker
reached the end
```

`grep` failed because the file was *missing*, not because the marker was absent,
and the script proceeded. Test existence separately — `[[ -f notes.txt ]] ||
die "notes.txt is missing"` — instead of overloading an exit code.

### Failures inside a subshell and `$(...)`

A bare subshell respects `-e`: run `( false; echo unreachable )` and the `echo`
never prints. Put that same subshell in a condition and its whole body becomes
exempt:

```bash
if ( false; echo "inside a subshell that is a condition" ); then
```

```console
$ bash sub_c.sh
inside a subshell that is a condition
then-branch
after
```

`false` was ignored and the `if` took the *then* branch. Command substitution
has the same blind spot: its status is the last command inside, so
`x=$(false; echo "hi")` sets `x=hi` and returns `0` — the `false` simply
disappears. Never let "I checked something inside `$(...)`" stand in for "the
substitution failed".

### A function, and the `local x=$(cmd)` trap

When a function is tested — in an `if`, or with `||` — `-e` is disabled for its
*whole body*, and it returns only its last command's status:

```bash
set -e
check() {
  grep -q "ok" missing.txt   # fails
  echo "check() continued after its grep failed"
}
check || echo "check returned non-zero"
```

```console
$ bash fngotcha.sh
grep: missing.txt: No such file or directory
check() continued after its grep failed
script finished
$ echo $?
0
```

The sibling trap is `local`, whose exit status is `local`'s own, not the
substitution's:

```bash
local payload=$(cat definitely-not-here.json)   # fails
echo "status right after local = $?"
```

```console
$ bash localrc.sh
cat: definitely-not-here.json: No such file or directory
payload=[]
status right after local = 0
fetch returned; script kept going
```

`set -e` never fires and `$?` reads `0`. Split the declaration from the
assignment: `local payload; payload=$(cat ...) || die "no payload"`.

One more silent killer hides in arithmetic. With `i=0`, the expression
`(( i++ ))` evaluates to the *old* value, `0`, and arithmetic commands return
the value as their status — so it returns `1`. Under `set -e` the loop dies on
its first iteration and prints nothing. Use `(( ++i ))` (pre-increment, which
returns the new nonzero value) or `(( i++ )) || true`.

## Quoting and word splitting: the #1 "works on my machine"

**Word splitting** is bash re-splitting an unquoted expansion on `IFS`
(whitespace by default), then glob-expanding it. It is invisible until a
filename contains a space:

```bash
names="my report.txt a b.txt plain.txt"
for f in $names; do echo "[$f]"; done
```

```console
$ bash split.sh
--- unquoted loop ---
1: [my]
2: [report.txt]
3: [a]
4: [b.txt]
5: [plain.txt]
```

Five iterations from three filenames. And the bracket operators are just as
literal — `[ ]` even errors on an empty expansion:

```console
$ bash brackets.sh
--- [ ] with a glob ---
literal test: FALSE
--- [[ ]] with a glob ---
pattern test: TRUE
--- [ ] with an empty variable ---
brackets.sh: line 10: [: =: unary operator expected
not equal
```

Three rules fall out of that run:

1. **Quote every expansion** you did not mean to split: `"$name"`, not `$name`.
2. **Prefer `[[ ]]` over `[ ]`.** Inside `[[ ]]`, expansions are neither split
   nor globbed, `[[ $name = *.txt ]]` does pattern matching, and empty strings
   are safe.
3. **Never store a list in a string.** That is the next section.

## Arrays beat strings for every list

If a value can contain whitespace or a glob character, it belongs in an array.
The fix for the loop above:

```bash
files=("my report.txt" "a b.txt" "plain.txt")
for f in "${files[@]}"; do echo "[$f]"; done
```

`"${files[@]}"` is the one correct expansion: quote each element, split none.
Use `"${#files[@]}"` for the count, `"${files[@]:1}"` for a slice, and never
`${files[*]}` unless you want one joined string.

## `trap EXIT` and `mktemp`: cleaning up after yourself

A script that creates temp files or locks must remove them even when it dies.
`mktemp` gives a unique path; `trap ... EXIT` guarantees cleanup on normal exit,
an error under `-e`, or a signal:

```bash
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
```

The wiring is easy to get subtly wrong. Create the temp dir as a `local` inside
a function and the EXIT trap fires *after* the function returns, when that local
is already out of scope:

```console
$ bash localtrap.sh
work done in /tmp/tmp.rDa7Aj3KKb
localtrap.sh: line 1: workdir: unbound variable
$ echo $?
1
```

Under `set -u` the trap itself dies on the unbound variable and leaks the
directory. Declare the path at the top level, outside any function, so the trap
can still see it; prefer `mktemp -d` over hand-rolled `/tmp/myapp.$$` names; and
always quote the path in the trap.

## Exit codes, `$?`, and `PIPESTATUS`

`$?` is the status of the most recent command — and it is overwritten by the
very next one, including your `echo`:

```console
$ bash pstat.sh
PIPESTATUS = 0 1 0
$? of the pipeline = 0 because cat succeeded
```

The pipeline's `$?` is `0` because the last stage succeeded, but `PIPESTATUS`
is `0 1 0`: the middle `grep` failed. It is **clobbered by the next command**,
so capture it immediately (`statuses=("${PIPESTATUS[@]}")`) before printing
anything. If you only need "did anything fail", `pipefail` is shorter — that is
why `bash pstat_pipefail.sh` exits `1` and never reaches its next line.

<figure>
<svg viewBox="0 0 640 150" width="100%" role="img" aria-label="A three-stage pipeline cat, grep, sort exits with status 0 because only the last stage is reported, while PIPESTATUS records 0, 1, 0 and pipefail collapses the pipeline to a failing 1.">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="12" y="40" width="120" height="46" rx="8"/>
    <rect x="258" y="40" width="120" height="46" rx="8"/>
    <rect x="504" y="40" width="120" height="46" rx="8"/>
    <path d="M132 63 h120" marker-end="url(#ar)"/>
    <path d="M378 63 h120" marker-end="url(#ar)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="72" y="60">cat log</text>
    <text x="72" y="77" opacity="0.75">fails</text>
    <text x="318" y="60">grep -c ERROR</text>
    <text x="318" y="77" opacity="0.75">fails</text>
    <text x="564" y="60">sort</text>
    <text x="564" y="77" opacity="0.75">ok</text>
    <text x="195" y="55" opacity="0.9">0</text>
    <text x="441" y="55" opacity="0.9">1</text>
    <text x="72" y="118" opacity="0.9">$? = 0</text>
    <text x="318" y="118" opacity="0.9">PIPESTATUS = 0 1 0</text>
    <text x="564" y="118" opacity="0.9">pipefail → 1</text>
  </g>
</svg>
<figcaption>Only the last stage sets `$?`; `PIPESTATUS` keeps them all, and `pipefail` collapses the pipeline to one failing status.</figcaption>
</figure>

## `shellcheck` is the real safety net

Strict mode catches failures at runtime. **shellcheck** catches them before you
run anything: unquoted expansions (SC2086), `local`/`export` masking a return
value (SC2155), unreachable code, and the `set -e` exemptions above. It reads
the script statically and points at the exact column:

```console
$ shellcheck import.sh

In import.sh line 9:
cat $source | wc -l
    ^-----^ SC2086 (info): Double quote to prevent globbing and word splitting.

Did you mean:
cat "$source" | wc -l

In import.sh line 14:
  local out=$(convert "$1")
        ^--^ SC2155 (warning): Declare and assign separately to avoid masking return values.

For more information:
  https://www.shellcheck.net/wiki/SC2086 -- Double quote to prevent globbing and word splitting.
  https://www.shellcheck.net/wiki/SC2155 -- Declare and assign separately to avoid masking return values.
```

Full disclosure: shellcheck was not installed in the sandbox where I ran the
other demos and there was no network to add it, so that block is its standard
diagnostic wording rather than a transcript — the point stands either way. A
rare `# shellcheck disable=SC2086` comment is your escape hatch when you truly
mean to split; run it with `-x` so it follows sourced files, and wire it into CI
(`shellcheck -x deploy/*.sh`) and your editor. When you are reading a script you
did not write, it is the same muscle as [reading a
codebase](/posts/reading-a-codebase/), and the notes you leave for the next
person are the same discipline as [writing a
README](/posts/writing-a-readme/).

## A hardened script template to copy

This is the shape I start every non-trivial script with: strict mode, `IFS`
narrowed so only newlines and tabs split, a `die` helper, temp cleanup hoisted
out of any function, quoting everywhere, and a real exit status.

```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

log() { printf '[%s] %s\n' "$(date +%T)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

readonly WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

main() {
  local src="${1:-}"
  [[ -n $src ]] || die "usage: ${0##*/} <file>"
  [[ -f $src ]] || die "not a file: $src"

  local lines
  lines=$(wc -l <"$src") || die "cannot count lines in $src"
  log "read $lines lines from $src"
  printf '%s\n' "$lines"
}

main "$@"
```

```console
$ bash good.sh sample.txt
[18:46:06] read 3 lines from sample.txt
3
$ echo $?
0
```

Two details make it robust: `lines=$(...)` is a *separate* statement from `local
lines`, so a failed `wc` triggers `-e`; and the work directory is created at the
top level, not inside `main`, so the `EXIT` trap can still see it. I verified
cleanup by counting temp directories before and after — delta zero.

## The one-paragraph summary

`set -euo pipefail` makes a script stop on failures bash normally ignores, but
`-e` is suspended in conditions, `&&`/`||` lists, subshells used as conditions,
command substitutions, and the bodies of tested functions — so never let an exit
code carry meaning it cannot deliver. Quote every expansion, keep lists in
arrays, capture `PIPESTATUS` before anything else runs, clean up with `mktemp`
plus a top-level `trap ... EXIT`, and let shellcheck find the rest before
production does.
