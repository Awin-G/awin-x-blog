---
title: "How to read a codebase you didn't write: an outside-in method"
description: "A repeatable method for reading a codebase you didn't write: start outside in, trace one real request end to end, lean on the debugger and logs, find the seams, and use git log sparingly. The honest core of it is deciding what not to read."
pubDate: 2026-11-23
lang: en
translationKey: reading-a-codebase
tags: [devops, linux]
featured: false
keywords:
  - read a codebase
  - understand unfamiliar code
  - onboarding
  - code archaeology
  - debugger
---

Every few months I inherit a repository I did not write. The instinct — mine included — is to open the largest file and read from the top. That instinct is wrong. Reading a codebase front to back is the slowest possible way to **understand unfamiliar code**; you spend hours building context the project never uses, and you still cannot say what happens when a request arrives. What follows is the method I actually run now. It is deliberately not a list of tools. It is an order of operations for reading a codebase so that each hour buys a fact you can use.

The whole method fits in one picture: work from the outside in, and stop when you can change the one thing you came for.

<figure>
  <svg viewBox="0 0 760 340" width="100%" role="img" aria-labelledby="outside-in-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="outside-in-title">The outside-in reading order</title>
    <desc id="outside-in-desc">Read a codebase from docs and run scripts, to the entrypoint, to one traced request, to the seams and data models at the centre.</desc>
    <rect x="16" y="16" width="728" height="308" rx="14" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="36" y="44" fill="currentColor" font-weight="600">0. Docs, README, how it is run</text>
    <rect x="76" y="60" width="608" height="224" rx="12" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="96" y="88" fill="currentColor">1. Entrypoint</text>
    <rect x="140" y="104" width="480" height="146" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="160" y="132" fill="currentColor">2. One real request, traced end to end</text>
    <rect x="212" y="150" width="336" height="76" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="380" y="182" text-anchor="middle" fill="currentColor">3. Seams: modules, data models,</text>
    <text x="380" y="202" text-anchor="middle" fill="currentColor">where side effects live</text>
  </svg>
  <figcaption>Read from the outer ring inward. You stop at the depth the change you need actually reaches — often layer 2, rarely the centre.</figcaption>
</figure>

## Start outside in: docs, how it is run, and the entrypoint

Before reading a single function, read what the humans wrote and what the machine executes. Four things, in order:

1. **`README`, `docs/`, `CONTRIBUTING`, and any ADRs.** These name the vocabulary. When a domain word appears in the code later, you already know what it means.
2. **How it is run.** `Dockerfile`, `Makefile`, `package.json` scripts, a `systemd` unit, CI config. This tells you the entrypoint and the real build path without guessing.
3. **The dependency manifest.** `go.mod`, `Cargo.toml`, `requirements.txt`, `package.json`. It dates the project, names its framework, and tells you which conventions to expect.
4. **The directory layout.** Just the top level. Resist opening files.

```bash
# What is this, and how do I run it?
ls -a
head -60 README.md
cat package.json | jq '.scripts'
rg -n --glob '*.json' '"main"|"bin"' .        # declared entrypoints

# Layout without reading contents.
ls -d */ && find . -maxdepth 2 -name '*.service'
```

By the end of this step you should be able to answer: what does this program do, what does it depend on, and what command starts it. If you cannot, read no code yet — you are missing the frame the code hangs on.

## Trace one request end to end

Now pick exactly one real flow and follow it. Not "the architecture" — one flow. A user signs in. A job is submitted. A file is uploaded. Something with a start and an end.

Find where it enters:

```bash
# Entrypoint and route table, whatever the stack.
rg -n 'func main|if __name__ ==|fn main\(' .
rg -n '@app\.(get|post|put)|router\.(get|post)|HandleFunc|http\.Handle' .

# Then find handlers by the words you learned in the README.
rg -n -i 'sign ?in|login|authenticate' --glob '!**/node_modules/**'
```

To **trace a request**, follow the call chain by hand across every boundary: HTTP handler → service function → data layer → database. Do not skim. At each hop answer three questions — what goes in, what comes out, what can fail. When the chain leaves the process (a queue, a cache, an external API), mark that as a seam and keep going in the caller; you will inspect the far side later.

To keep yourself honest, add a temporary log line at each hop and run the flow once. A printed trace of the real value at each layer beats three files of reading. If a hop is hard to follow, that is a signal about the code's design, not your skill.

## Stop reading: use the debugger and logs instead

Reading tells you what code *could* do. Running tells you what it *does*. The moment you are unsure which branch executes, stop reading and attach a **debugger**:

```bash
# Python
python -m pdb -c continue ./manage.py runserver   # then b <file>:<line>

# Node
node --inspect-brk build/index.js                  # chrome://inspect

# Go
dlv debug ./cmd/server -- -config ./config.yaml    # break main.main

# Native C
gdb --args ./server --port 8080                    # break main, then run
```

Breakpoints, step-over, and inspecting a live value replace paragraphs of speculation. Add conditional breakpoints instead of reading every branch. When you cannot attach a debugger, `strace`/`ltrace` and structured logs do the same job at one remove — I lean on the same instinct when debugging at the wire level, as in [debugging TCP on embedded](/posts/debugging-tcp-on-embedded/).

Logs are the cheapest map. Grep for what already gets logged before adding your own:

```bash
rg -n 'log\.|logger\.|console\.log|println!|ESP_LOG' src | head -50
rg -n 'LOG_LEVEL|logging\.getLogger|RUST_LOG' .
```

If the project has a log level you can raise at runtime, you may not need to edit anything to see the flow. Prefer that to instrumenting twelve files.

## Find the seams: module boundaries, data models, side effects

Architecture is not the classes — it is the seams between them. Three seams repay attention:

- **Module boundaries.** Each top-level directory is a promise: what it owns and what it must not touch. Read the one directory your change lands in, plus its immediate callers. Ignore the rest on purpose.
- **Data models.** The schema, migrations, or the type definitions are the most reliable spec in the repo. Code can drift; the database shape usually cannot.

```bash
ls migrations/ 2>/dev/null || ls db/
rg -n 'CREATE TABLE|type .* struct|interface .*\{|class .*:' --glob '!**/test*' | head -40
```

- **Side effects.** Anything that touches the network, disk, the clock, or randomness is where surprises live. Grep for them explicitly rather than discovering them by accident:

```bash
rg -n 'http\.|requests\.|fetch\(|os\.(open|write)|fs\.|time\.Now|rand\.|getenv|os\.Getenv'
```

I keep a simple rule: read data flow forward, read side effects backward. Forward tells you what a module computes; backward tells you what broke.

## Read the tests as executable documentation

Tests are the codebase describing its own intent in a language you can execute. For onboarding, they beat comments outright — a comment can lie, a failing test cannot.

- Find the test for the exact behaviour you must change, and read only that file plus its fixtures.
- Tests encode the edge cases the author actually cared about. That set is the real spec.
- Run them before you touch anything, so you know your baseline.

```bash
# Cheap entry: names of tests tell you what the system promises.
rg -n 'def test_|it\(|#\[test\]|func Test' . | rg -i 'auth|order|parse'
# Then run just the ones you touched.
pytest tests/test_auth.py::test_expired_token -x
cargo test expired_token -- --nocapture
```

If a behaviour has no test, that absence is information: it is either unowned or too new to trust. Treat both as risk.

## Code archaeology with `git log` and `git blame`

History explains intent that the code only implies. Used sparingly, **code archaeology** answers "why is this weird", and it should stay sparing — most of the time the code is weird because it was written for a project that no longer exists.

```bash
git log --follow -p path/to/file.go      # history through renames
git blame -L 120,160 path/to/file.go     # who last touched these lines, and when
git log -S 'deprecated_flag' --oneline   # every commit that added/removed a string (pickaxe)
git log --oneline -- path/to/dir | head # recent activity = where the risk lives
```

Blame tells you *who* and *when*, never *why*. The why lives in the commit message and its linked issue, so read that, not the name. A single `git log -S` pickaxe search for a magic constant regularly explains a whole subsystem, and it takes two seconds. I treat this as the archaeology arm of ordinary source control habits — the same discipline I describe in [git for solo developers](/posts/git-for-solo-developers/) applies whether you wrote the history or inherited it.

## Take notes, draw a map, and throw it away

Your working memory is not a cache; it evicts under pressure. Keep an external note file next to the code:

- One line per component: what it is responsible for.
- One line per seam: how data crosses it and what can go wrong.
- The exact command that starts the app, and the exact command that runs one test.
- Open questions, with the file and line where you got stuck.

Draw the map as text first — a call sketch is not a diagram, it is a sentence with arrows. Its purpose is not to be correct; it is to make your mental model inspectable and wrong in public. Expect to delete it within a week. The map is a phase of learning, not an artifact.

## Onboarding is mostly knowing when to stop

The honest core of this: most of the skill is choosing what **not** to read. You are not there to understand the codebase. You are there to change one thing safely. The difference matters because it gives you a stopping rule.

You are done reading when you can say, without looking:

1. How the app starts and where the flow you care about enters.
2. The full call chain of one real request, including the seams it crosses.
3. Where the data it touches is defined and what a valid shape looks like.
4. How to run the test that covers it, and what currently passes.

If you cannot state those four, keep going. If you can, stop — reading the tenth module is not diligence, it is procrastination wearing a lab coat. The method is outside-in, one request at a time, debugger before prose, seams before classes, tests before comments, and history only when a specific question forces it. Everything else is optional, and knowing that is the actual **onboarding** skill.
