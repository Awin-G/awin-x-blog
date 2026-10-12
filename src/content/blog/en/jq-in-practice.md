---
title: "jq tutorial: a practical JSON command line cookbook with real output"
description: "A hands-on jq tutorial for real work: pretty-print and compact output, selecting and select, map and to_entries, // defaults, slurp, --arg, -e exit codes, group_by, sort, unique, and --stream. Every jq command here comes with real, copy-pasteable output."
pubDate: 2026-12-03
lang: en
translationKey: jq-in-practice
tags: [linux, devops]
featured: false
keywords:
  - jq tutorial
  - jq command
  - JSON command line
  - jq examples
  - select
---

I reach for `jq` more than almost any other tool. Every API response, every
Kubernetes object, every `journalctl -o json` line ends up piped through it. And
yet, every few weeks, I catch myself on the same handful of things: how do I
slurp instead of streaming? Why is my `//` default firing when the value exists?
Why does `jq` print nothing at all?

This is the jq tutorial I wanted: a cookbook of the jq commands I actually run,
each one executed against small sample files, with the real output pasted in. No
man page tab, no guessing. Everything below was produced with **jq 1.8.2** on
Linux.

I assume you can type `jq` already — install it from your package manager
(`apt install jq`, `brew install jq`) and run `jq --version` to confirm. The
point of this post is not installation, it is the twenty percent of the syntax
that covers ninety-five percent of the real work: pulling fields out of API
responses, reshaping them, and feeding them to the next command in a pipeline.

I use two tiny files throughout. `app.json`:

```json
{"name":"billing","version":"2.3.1","replicas":3,"env":{"REGION":"eu-west-1","DEBUG":false},"owners":["ana","bo"],"limits":{"cpu":"500m"}}
```

And `users.json`, an array of records:

```json
[
  {"id":1,"name":"ana","role":"admin","active":true,"logins":42},
  {"id":2,"name":"bo","role":"dev","active":false,"logins":7},
  {"id":3,"name":"cy","role":"dev","active":true,"logins":19},
  {"id":4,"name":"dee","role":"ops","active":true,"logins":7},
  {"id":5,"name":"eve","role":"dev","active":true}
]
```

## Pretty-print and compact output

The two modes you will use constantly. Default `.` re-indents pretty JSON with
two-space indentation, which is what you want when a human is reading it or when
you are diffing two documents. `-c` gives you one line per value, which is what
you want when piping onward into `grep`, `wc`, or another program. Getting into
the habit of `-c` early saves a lot of confusion later, because most of the
sections below produce compact output precisely so the results stay readable in a
terminal.

```bash
jq '.' app.json
```

```json
{
  "name": "billing",
  "version": "2.3.1",
  "replicas": 3,
  "env": {
    "REGION": "eu-west-1",
    "DEBUG": false
  },
  "owners": [
    "ana",
    "bo"
  ],
  "limits": {
    "cpu": "500m"
  }
}
```

```bash
jq -c '.' app.json
```

```
{"name":"billing","version":"2.3.1","replicas":3,"env":{"REGION":"eu-west-1","DEBUG":false},"owners":["ana","bo"],"limits":{"cpu":"500m"}}
```

## Selecting: `.`, `.a.b`, and iterating with `.[]`

A `.field` walks one level; `.a.b` chains; a leading `.[]` iterates an array or
object into a *stream* of values, one per line.

```bash
jq '.env' app.json
```

```json
{
  "REGION": "eu-west-1",
  "DEBUG": false
}
```

```bash
jq '.owners[]' app.json
```

```
"ana"
"bo"
```

Add `-r` and the quotes disappear — the single most useful flag in the tool:

```bash
jq -r '.env.REGION' app.json
```

```
eu-west-1
```

Missing keys do not error, they return `null`. That is a feature until you rely
on it by accident:

```bash
jq '.limits.memory' app.json
```

```
null
```

## Filtering with select

`select(expr)` keeps only inputs where `expr` is true and lets everything else
fall through as empty (which produces no output at all). It reads best after a
`.[]` or `map`, and it composes with `and`, `or`, and comparisons. This is the
single construct that turns `jq` from a formatter into a query language: rather
than grepping for a substring, you assert a condition on the structured value and
get back exactly the objects you asked for. Because `select` is just a filter,
you can chain several of them, or stack one after a `map`, and each stage sees
the stream produced by the previous one.

```bash
jq -r '.[] | select(.role=="dev") | .name' users.json
```

```
bo
cy
eve
```

```bash
jq -r '.[] | select(.active and .logins > 10) | .name' users.json
```

```
ana
cy
```

## Transforming with map, to_entries, with_entries

`map(f)` runs `f` on every element and collects the results back into an array —
it is the array-shaped sibling of `.[]`. `to_entries` turns an object into
`[{key,value}]`; `with_entries(f)` is `to_entries | map(f) | from_entries`, which
makes renaming or dropping keys a one-liner instead of a loop you write by hand.
Together these three cover almost every reshape you will ever need, because
almost every reshape is either "change each element" or "change each key".

```bash
jq -c 'map(.name)' users.json
```

```
["ana","bo","cy","dee","eve"]
```

```bash
jq -c '.env | to_entries' app.json
```

```
[{"key":"REGION","value":"eu-west-1"},{"key":"DEBUG","value":false}]
```

```bash
jq -c '.env | with_entries(.key |= ascii_downcase)' app.json
```

```
{"region":"eu-west-1","debug":false}
```

Keep only the flags that are on:

```bash
jq -c '.env | with_entries(select(.value == true))' app.json
```

```
{}
```

## Defaults and optional access: `//` and `?`

`a // b` yields `b` when `a` is `null` **or** `false`. That second case bites
people, so keep it in mind: `//` is a *falsy* default, not a null check. A
trailing `?` suppresses the error when you try to iterate something that is not
iterable; it converts "this path does not exist" from a hard failure into the
empty stream, which is exactly what you want in a pipeline that has to survive
missing fields.

```bash
jq '.limits.memory // "unset"' app.json
```

```
"unset"
```

```bash
jq -c '.env.DEBUG // "was false"' app.json
```

```
"was false"
```

Here `.users` does not exist, so `.[]` over `null` errors — but `?` turns the
error into empty output:

```bash
jq '.users[]' app.json
```

```
jq: error (at app.json:1): Cannot iterate over null (null)
```

```bash
jq '.users[]?' app.json
```

```
```

## Building objects and arrays

You build output the same way you write it in JSON, except that fields can be
arbitrary expressions. Wrapping a stream in `[...]` collects it into an array, and
`{n: .name, l: .logins}` builds objects with the keys you choose. This is how you
go from a verbose API payload to the two or three fields a downstream script
actually needs, and it is almost always shorter than doing the same reshaping in
your language of choice.

```bash
jq -c '[.[] | {n: .name, l: .logins}]' users.json
```

```
[{"n":"ana","l":42},{"n":"bo","l":7},{"n":"cy","l":19},{"n":"dee","l":7},{"n":"eve","l":null}]
```

## The jq command flags worth knowing: -r, -c, -s, --arg, -e

Flags do the plumbing that the filter language cannot: raw output, compact
output, slurping a stream into an array, passing in arguments, and turning a
result into a process exit code.

`-s` (slurp) reads the whole input as a single array instead of a stream. It is
how you turn newline-delimited JSON into one array. Take `events.ndjson`:

```
{"ts":"10:01","level":"info","svc":"api","msg":"start"}
{"ts":"10:02","level":"error","svc":"api","msg":"db timeout"}
{"ts":"10:03","level":"warn","svc":"web","msg":"slow"}
{"ts":"10:04","level":"error","svc":"web","msg":"500"}
```

```bash
jq -c -s 'length' events.ndjson
```

```
4
```

```bash
jq -r -s 'group_by(.level)[] | "\(.[0].level): \(length)"' events.ndjson
```

```
error: 2
info: 1
warn: 1
```

`--arg` passes a string, `--argjson` parses the value as JSON. Both keep you out
of shell-quoting hell:

```bash
jq -c --arg region eu-west-1 '.env.REGION == $region' app.json
```

```
true
```

```bash
jq -c --argjson n 2 '.replicas * $n' app.json
```

```
6
```

`-e` sets the exit code from the result — `1` for `false`/`null`, `4` for no
output, `0` otherwise. That is what makes `jq -e` a real condition in scripts:
`if jq -e '.ready' status.json > /dev/null; then ...` reads the JSON and branches
on it without a single line of parsing code. The `4` case is the one people miss,
because "the filter matched nothing" is usually a failure worth catching.

```bash
jq -e '.replicas > 99' app.json; echo "exit=$?"
```

```
false
exit=1
```

```bash
jq -e '.nope' app.json; echo "exit=$?"
```

```
null
exit=1
```

## Grouping, sorting, unique, and math

`group_by` and `sort_by` both sort first, so they compose cleanly and you rarely
need to reach for a second pass. `unique` needs no key and works on any value
type. `add`, `length`, `max`, and `min` do the arithmetic, and because `add`
treats `null` as the identity element, summing a field that is sometimes missing
just works.

```bash
jq -c 'group_by(.role) | map({role: .[0].role, n: length})' users.json
```

```
[{"role":"admin","n":1},{"role":"dev","n":3},{"role":"ops","n":1}]
```

```bash
jq -c 'map(.role) | unique' users.json
```

```
["admin","dev","ops"]
```

```bash
jq -c 'sort_by(.logins // 0) | reverse | map(.name)' users.json
```

```
["ana","cy","dee","bo","eve"]
```

Summing a field that is sometimes missing drops the nulls for free, because
`null` is the identity for addition:

```bash
jq -c 'map(.logins) | add' users.json
```

```
75
```

## Streaming large files with --stream

For a file too big to load, `--stream` emits `[path, value]` pairs as it parses.
The usual trick is to keep only leaves (`length==2`) so you never hold the whole
document in memory:

```bash
jq -c --stream 'select(length==2)' app.json | head -4
```

```
[["name"],"billing"]
[["version"],"2.3.1"]
[["replicas"],3]
[["env","REGION"],"eu-west-1"]
```

The path arrays are the same ones `getpath` and `setpath` understand, so once you
are comfortable with `--stream` you can select, drop, or rewrite a leaf without
ever materialising the document around it. For the 10 GB log file that will not
fit in RAM, this is the difference between a working command and an OOM kill.

## Turning a payload into a table

The fastest way to eyeball an API response is to flatten it to a table. `@tsv`
escapes tabs and newlines for you, so the result is safe to hand to `awk` or
`cut`, while `@csv` does the same with proper quoting:

```bash
jq -r '.[] | [.name, .role] | @tsv' users.json
```

```
ana	admin
bo	dev
cy	dev
dee	ops
eve	dev
```

## The "I keep forgetting this" list

- **No `-n` means no output.** A filter that ignores input still reads stdin.
  `jq -r '"hi"' </dev/null` prints nothing; `jq -nr '"hi"'` prints `hi`.
- **`-S` sorts keys** so diffs are stable; `-a` is ASCII-only output;
  `--indent 4` and `--tab` change indentation.
- **`keys_unsorted`** preserves original order; plain `keys` sorts.
- **`has("k")`** tests key presence without iterating.
- **`@csv`, `@tsv`, `@sh`** format a value for another tool:
  `jq -r '.[] | [.name, .role] | @tsv' users.json`.
- **`getpath(["a","b"])`** reads a path you built as data.
- **`splits` returns a stream**, so bracket it: `jq -r -n '["a-b-c" | splits("-")][1]'` prints `b`.
- **`try ... catch`** contains errors: `jq -c 'try (.replicas / 0) catch "boom"' app.json`.
- **`-s` wraps input in an extra array** — piping an already-array file through
  `-s` gives you `[[...]]`, which breaks `map(.field)`.
- **`max`/`min` see `null`**, and `null` sorts before numbers, so
  `map(.logins) | min` returns `null` if any record omits the field.

That is the loop I actually live in: select, transform, default, slurp, group.
For the wider "why bother with structured data" context, my
[structured logging piece](/posts/structured-logging/) is the companion read,
and when the pipeline itself misbehaves,
[strace is how I find out why](/posts/debugging-with-strace/).
