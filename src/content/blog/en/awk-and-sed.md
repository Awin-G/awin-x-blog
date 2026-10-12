---
title: "awk and sed cookbook: text wrangling without leaving the shell"
description: "A practical awk tutorial and sed tutorial with real output: field selection, sums and averages, BEGIN/END, grouped counts, sed replace, capture groups, line ranges, in-place edits with backups, and when to stop and use jq or Python instead."
pubDate: 2026-12-25
lang: en
translationKey: awk-and-sed
tags: [linux]
featured: false
keywords:
  - awk tutorial
  - sed tutorial
  - awk examples
  - sed replace
  - text processing
---

Every time I open a file to eyeball it, then reach for a language runtime to do
something trivial to it, I lose five minutes and a bit of self-respect. A log
line I want to filter, a CSV column I want to sum, a config value that changed
in twenty files — none of these need an interpreter and a virtualenv. They need
`sed` and `awk`, which are already on the box and start in milliseconds.

This is a cookbook, not a reference. Everything below is real output from files
I created in a scratch directory: a small `access.csv` and an `app.log`. If you
read this while looking at a terminal, you can follow along verbatim.

## The mental model: sed edits a stream, awk reads records

The single most useful thing to internalize is that they are not
interchangeable.

- **`sed`** is a *stream editor*. It reads input line by line, and for each line
  it applies a script — usually "find this, replace it". It thinks in **lines**.
  Its superpower is *in-place editing of files*, and *not caring* about the
  structure of the line.
- **`awk`** is a *record-and-field* language. It also reads line by line, but it
  splits each line into **fields** (`$1`, `$2`, …) using a separator, and it has
  variables, arithmetic, conditionals, loops, and associative arrays. It thinks
  in **columns and aggregate state**, so it can *sum*, *average*, *group*, and
  *count*.

Rule of thumb I actually use: if the answer depends only on the current line, use
`sed`. If it depends on a field, a running total, or a grouping key, use `awk`.
When you start writing a `while read` loop with counters in bash, that is `awk`
telling you to stop.

## sed tutorial: the core moves

Here is the sample log I will be mangling:

```
2026-12-01T08:00:01Z INFO  api boot complete pid=4821
2026-12-01T08:00:02Z INFO  request id=1 path=/api/users status=200 ms=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 ms=1330
```

### The substitution command

The workhorse is `s/find/replace/`. Without `g` it replaces only the **first**
match per line:

```console
$ sed 's/ERROR/ERR/' app.log | head -4
2026-12-01T08:00:01Z INFO  api boot complete pid=4821
2026-12-01T08:00:02Z INFO  request id=1 path=/api/users status=200 ms=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:04Z ERR request id=3 path=/api/orders status=500 ms=1330
```

That is the whole "sed replace" story in one line. Add `/g` when a line can
contain the pattern more than once.

### Capture groups reorder instead of replace

`sed` with extended regex (`-E`) captures with `(...)` and reproduces them with
`\1`, `\2`. Here I turn an ISO timestamp into a day/month/year date:

```console
$ echo '2026-12-01T08:00:02Z INFO request id=1' \
    | sed -E 's#([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})#\3/\2/\1 \4#'
01/12/2026 08:00:02Z INFO request id=1
```

I used `#` as the delimiter instead of `/` so the slashes in the replacement
don't need escaping. Changing the delimiter is one of the highest-value `sed`
habits there is — especially for paths, which are full of `/`.

### Addresses, ranges, and `-n` + `p`

By default `sed` prints every line. `-n` suppresses that, and `p` prints only
what you ask for. That turns `sed` into a filter:

```console
$ sed -n '/WARN/p' app.log
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing ms=880
2026-12-01T08:00:07Z WARN  slow downstream id=6 service=billing ms=920
```

Addresses can also be line numbers or ranges. `4,6p` prints lines 4 through 6
inclusive:

```console
$ sed -n '4,6p' app.log
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 ms=1330
2026-12-01T08:00:05Z INFO  request id=4 path=/api/orders status=200 ms=118
2026-12-01T08:00:06Z ERROR db timeout id=5 pool=primary waited=2500
```

Ranges can also be *pattern* addresses — `/BEGIN/,/END/` — which is the usual
way to pull one stack trace or config block out of a big file.

### Deleting lines by pattern

`d` deletes. This is how you strip noise before you read something:

```console
$ sed '/boot complete/d' app.log | wc -l
9
```

The ten-line log came back as nine — the boot line is gone, and crucially the
original file is untouched because I did not use `-i`.

### `-i`: edit in place, with a backup, on a copy

`-i` edits the file instead of printing to stdout. **Always give it a suffix so
it writes a backup.** I am doing this on a copy because I like my sample file:

```console
$ cp app.log app.copy
$ sed -i.bak 's/pool=primary/pool=replica/' app.copy
$ grep replica app.copy
2026-12-01T08:00:06Z ERROR db timeout id=5 pool=replica waited=2500
$ grep -c primary app.copy.bak
1
```

The changed file has `replica`; `app.copy.bak` still has the original
`primary`. That backup is your undo button.

### Many expressions, and many files

`-e` chains expressions. Here I pad the log level and rename the `ms=` field in
one pass:

```console
$ sed -e 's/INFO/INFO /' -e 's/ms=/latency=/' app.log | sed -n '2,4p'
2026-12-01T08:00:02Z INFO   request id=1 path=/api/users status=200 latency=42
2026-12-01T08:00:03Z WARN  slow downstream id=2 service=billing latency=880
2026-12-01T08:00:04Z ERROR request id=3 path=/api/orders status=500 latency=1330
```

And `sed` happily takes many files at once, which is the real reason people love
it for config migrations. Suppose two config files both point at an old upstream:

```console
$ cat cfg/one.conf cfg/two.conf
upstream api = http://10.0.0.5:8080
retries = 3
upstream api = http://10.0.0.5:8080
timeout = 30
$ sed -i.bak 's#http://10\.0\.0\.5:8080#https://api.internal:443#' cfg/*.conf
$ cat cfg/one.conf cfg/two.conf
upstream api = https://api.internal:443
retries = 3
upstream api = https://api.internal:443
timeout = 30
```

One command, two files, two `.bak` backups, zero manual editing. Note the
escaped dots (`10\.0\.0\.5`) — in a regex `.` matches any character, and you
want it to match a literal dot.

### Multiline, briefly

`sed` is line-oriented, and this is where it starts to hurt. To join the line
after a match you need the `N` command to pull the next line into the pattern
space: `sed '/^START/{N;s/\n/ /}'`. If your problem is genuinely about
paragraphs or JSON spanning lines, this is the edge of `sed`'s comfort zone —
reach for `awk` records, or `jq`. I have a whole post on
[jq in practice](/posts/jq-in-practice/) for the JSON side.

## awk tutorial: fields, records, and `BEGIN`/`END`

Now the interesting tool. `awk` splits each input line into fields. The whole
CSV looks like this:

```
ts,status,method,path,bytes,ms
2026-12-01T08:00:01Z,200,GET,/api/users,1203,42
2026-12-01T08:00:02Z,200,GET,/api/orders,8842,118
2026-12-01T08:00:03Z,404,GET,/api/nope,210,9
```

### Reaching into columns with `$1..$NF`

The special variable `NF` is the number of fields, so `$NF` is the *last* field.
This is the single most-used `awk` idiom:

```console
$ awk -F, '{print $1, $4, $NF}' access.csv | head -4
ts path ms
2026-12-01T08:00:01Z /api/users 42
2026-12-01T08:00:02Z /api/orders 118
2026-12-01T08:00:03Z /api/nope 9
```

`-F,` sets the field separator. `$1` is the timestamp, `$4` the path, `$NF` the
latency.

### `NR`, `NF`, and a one-command header skip

`NR` is the current record (line) number. It is also how you skip a header
without losing your mind:

```console
$ awk -F, 'NR<=3 {print NR": NF="NF" path="$4}' access.csv
1: NF=6 path=path
2: NF=6 path=/api/users
3: NF=6 path=/api/orders
```

Every row has six fields, including the header. `NR>1` is the pattern I use to
skip that header in every sum that follows.

### BEGIN, END, and computing a sum

`BEGIN` runs before any input; `END` runs after the last line. Together they are
the entire reason `awk` feels like a tiny language:

```console
$ awk -F, 'NR>1 {s+=$5} END {print "total bytes:", s}' access.csv
total bytes: 31825
```

No loop, no counter boilerplate: `s+=$5` accumulates while `awk` reads, and
`END` prints once.

### Averages, with `printf`

A running sum plus a row counter gives you an average. `printf` gives you control
over decimals:

```console
$ awk -F, 'NR>1 {s+=$6; n++} END {printf "avg ms: %.1f over %d rows\n", s/n, n}' access.csv
avg ms: 298.8 over 12 rows
```

Note this average includes two requests that took 1330 ms and 1490 ms, which is
exactly the kind of thing a quick average is meant to expose.

### Conditionals and `BEGIN`/`OFS`

Patterns like `$2>=500` are conditionals. And you can set the output separator
`OFS` in `BEGIN`:

```console
$ awk -F, 'BEGIN {OFS=" | "} NR>1 {print $2, $3, $4}' access.csv | head -3
200 | GET | /api/users
200 | GET | /api/orders
404 | GET | /api/nope
$ awk -F, '$2>=500 {print $1, $2, $4}' access.csv
ts status path
2026-12-01T08:00:05Z 500 /api/orders
2026-12-01T08:00:23Z 500 /api/orders
```

## awk examples: grouping and counting

Associative arrays are where `awk` leaves `sed` in the dust. `c[$4]++` means
"increment the counter indexed by field 4". Then `END` loops over the keys.

### Count by key

```console
$ awk -F, 'NR>1 {c[$4]++} END {for (p in c) print c[p], p}' access.csv | sort -rn
5 /api/orders
4 /api/users
1 /old
1 /api/nope
1 /admin
$ awk -F, 'NR>1 {c[$2]++} END {for (s in c) printf "%s %d\n", s, c[s]}' access.csv | sort
200 7
301 1
403 1
404 1
500 2
```

That second one is a status-code histogram, and it is the reason `awk` is my
default for "what's in this file". For a note on making those counts survive
across restarts and aggregations, see my post on
[structured logging](/posts/structured-logging/).

### Extract a `key=value` field from unstructured text

`app.log` is not columnar, but its fields are space-separated `key=value` pairs.
Loop over fields, find the one you want, strip the prefix:

```console
$ awk '{for (i=1;i<=NF;i++) if ($i ~ /^path=/) {sub("path=","",$i); print $i}}' app.log
/api/users
/api/orders
/api/orders
/api/users
/admin
/api/users
```

### A join-ish enrichment

`awk` can hold two files in memory. The `NR==FNR` idiom loads the first file
into an array, then the second pass consults it. Here I tag each request path as
`known` or `new` using a lookup from the same file (imagine it is a route table
instead):

```console
$ awk -F, 'NR==FNR {if (FNR>1) load[$4]++; next} {print $1, $4, (load[$4]?"known":"new")}' access.csv access.csv | head -3
ts path new
2026-12-01T08:00:01Z /api/users known
2026-12-01T08:00:02Z /api/orders known
```

That `NR==FNR {...; next}` shape is the closest thing to a SQL join you will get
without leaving the shell.

## The same job three ways: awk vs sed vs a one-liner

Counting the `500` rows shows the tradeoff clearly. All three are correct:

```console
$ grep -c ',500,' access.csv
2
$ sed -n '/,500,/p' access.csv | wc -l
2
$ awk -F, '$2==500' access.csv | wc -l
2
```

- `grep` is shortest and fastest to type, but it is a substring match: it would
  also count a `500` hiding in a path or a byte count.
- `sed -n` needs a pipe to `wc` because it has no notion of "count".
- `awk` is the most verbose but the only one that is *field-aware* — `$2==500`
  can never be fooled by a `500` in another column. When the answer must be
  exact, the extra characters pay for themselves.

## When to stop and use Python or jq

I reach for `awk`/`sed` constantly, and I stop in three situations:

1. **The data is JSON.** Do not hand-parse JSON with regexes. Use `jq`; that is
   literally what it is for.
2. **The logic needs real functions, dates, or types.** If I am doing date math,
   floating-point currency, or something that needs a helper function I will
   reuse, `awk` starts becoming a program that deserves tests. Write it in
   Python.
3. **The one-liner is now a script.** The moment I need `-v` variables, quoting
   gymnastics, and a shell wrapper to make an `awk` program readable, it has
   stopped being a one-liner and the maintainability argument flips to Python.

`awk` is at its best at one or two operations over one or two fields. Past that,
you are debugging a language without a debugger.

## Portability: GNU vs BSD `sed -i`

The classic trap. On Linux (GNU `sed`), `-i` optionally takes a suffix:

```console
$ sed --version | head -1
sed (GNU sed) 4.10
$ sed -i.bak 's/foo/bar/' file      # GNU: suffix, backup created
```

On macOS and the BSDs, `-i` **requires** an argument, and if you want no backup
you must pass an empty one:

```sh
sed -i '' 's/foo/bar/' file         # BSD/macOS: empty suffix, overwrites
sed -i '.bak' 's/foo/bar/' file     # BSD/macOS: backup
```

The portable habit is to always pass an explicit suffix so the same line works
on both, and to reach for `perl -pi -e` only when you truly need `\b`, lookahead,
or other PCRE features that `awk`/`sed` do not have. Other small differences
worth knowing: GNU `sed` supports `\t` in regexes and `-E`; BSD historically
wanted `-r` (modern `-E` is supported too), and `awk` on macOS is one-true-awk
rather than GNU `awk`, so `gensub()` and `\s` may be missing. `gawk` vs `mawk` on
Linux matters too — `mawk` is faster but has fewer extensions.

## The takeaway

`sed` is a line-oriented stream editor whose killer feature is `s///` and
in-place edits. `awk` is a field-oriented record processor with variables,
`BEGIN`/`END`, and associative arrays, and its killer feature is grouping and
arithmetic over columns. Learn `s///`, addresses, and `-n p` on the `sed` side;
learn `$1..$NF`, `NR`/`NF`, `-F`, and `c[$k]++` on the `awk` side. That is
ninety percent of daily text processing, it runs everywhere, and it starts
before your interpreter has finished booting.
