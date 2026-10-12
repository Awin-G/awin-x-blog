---
title: "Rust for CLI tools: when it's worth it (and when a shell script is fine)"
description: "Rust gives a command line tool a single static binary, no runtime, predictable performance, strong types, and a mature ecosystem like clap, anyhow, thiserror, serde, and ignore. But it also costs build time, borrow-checker friction, and ceremony. Here is how I decide between Rust, Python, Go, and a plain shell script."
pubDate: 2026-11-13
lang: en
translationKey: rust-for-cli-tools
tags: [rust, devops]
featured: false
keywords:
  - Rust CLI
  - Rust vs Python
  - clap
  - command line tools
  - single binary
---

Every few months I catch myself reaching for `cargo new` to write something that a
ten-line shell script would have finished before the first `cargo build` completed.
And every few months I write a "quick" Python script for a tool that I then have to
run on a box without Python, or ship to someone who cannot build it. Both mistakes are
real, and they point in opposite directions. This is my honest decision rule for when a
**Rust CLI** earns its keep, when a shell script is plainly the right answer, and where
the **command line tools** I actually maintain fall on that line.

## What a Rust CLI actually buys you

When I do pick Rust, it is rarely for the reasons people list in blog posts. Let me be
specific about which benefits are real for a small tool.

**A single static binary.** `cargo build --release` produces one file with no
interpreter, no virtualenv, no shared-library surprise. `scp` it to a server, drop it in
`/usr/local/bin`, done. For anything I distribute to more than one machine, this is the
whole argument. Compare with a Python tool, where "works on my machine" is a packaging
problem you inherit forever.

**No runtime, and no warm-up.** A Rust binary starts, does its work, and exits. There is
no interpreter to start, no module imports to resolve, no JIT to warm up. For a tool that
runs in a loop, a cron job, or a shell pipeline thousands of times a day, this is the
difference between a script that feels instant and one that quietly adds a tax to every
invocation.

**Predictable performance.** No garbage collector means no pause tail. For CLIs this
mostly matters when you are processing large inputs — walking a big directory tree,
parsing a multi-gigabyte log — where you want throughput that does not vary with heap
pressure. It is not about beating C; it is about not being surprised.

**Strong types and exhaustive errors.** The compiler forces me to handle the `Result`, to
match every enum variant, to be honest about what can fail. For a tool that touches the
filesystem, network, or other processes, this catches a whole class of "the happy path
worked on my laptop" bugs before the tool ever runs.

### The ecosystem is the real reason (clap, anyhow, thiserror, serde, ignore)

Honestly, the libraries matter more than the language. The crates that carry every CLI I
write:

- **[`clap`](https://docs.rs/clap)** — argument parsing with derive macros. Subcommands,
  flags, help text, and shell completions from one struct definition.
- **[`anyhow`](https://docs.rs/anyhow)** — ergonomic error handling for application code,
  where you just want to add context and propagate.
- **[`thiserror`](https://docs.rs/thiserror)** — typed, named errors for library code,
  where callers need to match on what went wrong.
- **[`serde`](https://serde.rs)** — read and write JSON, YAML, TOML without hand-rolling
  a parser.
- **[`ignore`](https://docs.rs/ignore)** — the crate behind ripgrep's directory walking:
  respects `.gitignore`, handles parallelism, does the right thing by default.

Here is the dependency block for a typical tool of mine:

```toml
# Cargo.toml
[package]
name = "scan"
version = "0.1.0"
edition = "2021"

[dependencies]
clap = { version = "4", features = ["derive"] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
ignore = "0.4"
```

I add `thiserror` only when the crate is a library or when a caller needs to distinguish
error kinds; for a pure application, `anyhow` is enough and `thiserror` is ceremony.

## When a shell script is fine (and Rust is overkill)

The mistake in the other direction is just as common. Rust is the wrong tool whenever the
program is small, single-purpose, and short-lived:

- **A 20-line script.** If it fits on one screen and does one thing, a script is faster to
  write, faster to read, and needs no toolchain. Pulling in a `Cargo.toml` to rename some
  files is cost with no payoff.
- **One-off automation.** If you will run it once — a migration, a data munge, a cleanup —
  the maintainability argument for types evaporates. Nobody maintains a script you delete
  tomorrow.
- **Throwaway glue.** The thing that stitches three existing tools together in a pipeline.
  `jq`, `awk`, and `curl` already exist; wrapping them in Rust is re-implementing a
  shell in a slower language.
- **Anything that lives inside the shell.** If the tool's job is to be composed with
  other tools — read stdin, write stdout, respect exit codes — the shell is already the
  right runtime, and it never needed to be a binary.

The script I reach for instead of a tiny Rust binary:

```bash
#!/usr/bin/env bash
# Fail fast, and be honest when a name is unset.
set -euo pipefail

# Rotate logs older than N days and report what was removed.
target="${1:?usage: rotate.sh <dir>}"
days="${DAYS:-14}"

find "$target" -type f -name '*.log' -mtime "+$days" -print -delete \
  | wc -l \
  | xargs -I{} echo "removed {} log files from $target"
```

That is legible to anyone, runs everywhere, and I will never wait for it to compile.

## The cost you are actually signing up for

Rust is not free, and the honest version of the pitch has to name the bill.

**Build times.** A fresh release build of a tool with `clap`, `serde`, and `ignore` pulls
in a real dependency tree, and the first `cargo build` is measured in tens of seconds to
minutes, not a moment. Incremental builds are quick, but you feel it on the first clone
and in CI. The mitigation is `cargo build` (debug) while iterating and reserving
`--release` for the artifact you actually ship, plus a good `sccache` or incremental
setup. It still costs more than `chmod +x`.

**Borrow-checker friction.** For a CLI, most of the ownership pain comes from one place:
you want to pass a config around while mutating state. The fix is almost always to
structure it so the config is read-only and handed out by reference. Once you internalize
that, small tools rarely fight you — but the first week, they do.

**Ceremony.** `Cargo.toml`, `src/main.rs`, a module split once the file passes a few
hundred lines, error types, tests in a `tests/` directory. That structure is an asset for
something you maintain; it is pure tax for something you would have piped through `awk`.

## Rust vs Python (and Go, and shell): a fair comparison

The interesting axis is not language preference, it is what breaks first. I compare across
three things: startup, distribution, and maintainability.

### Startup time

A shell script forks the tools it uses and is fast to launch but slow to do real work once
it hits a big loop — every `$(…)` spawns a process. Python pays an interpreter start on
every invocation, which is fine interactively and painful in a hot loop or a pipeline run
a thousand times. Go and Rust both start as compiled binaries; you will not notice the
difference between them for CLI work. Rust's edge over Python is precisely in the
"invoked constantly" case, not the "invoked by a human" case.

### Distribution

Shell needs a compatible shell and the tools you called. Python needs an interpreter and
usually a dependency manager, and the packaging story is the thing people give up on.
Go gives you a single static binary too, and cross-compilation is famously easy. Rust also
gives a single static binary, and while cross-compiling is more fiddly than Go, plain
`--target` builds cover most of what I need. For "give this to a coworker who runs macOS,"
Go and Rust both end the conversation; Python and shell reopen it.

### Maintainability

This is where it splits by lifetime. A script is the most readable thing in the world at
50 lines and a liability at 500. Python is the fastest to write and stays readable if you
keep it small and typed-ish. Go is boring in the best way: simple, fast to build, easy to
read, fewer ways to shoot yourself. Rust asks the most up front — types, lifetimes, error
enumeration — and pays it back on tools that live for years, where the compiler is doing
the review you no longer have time for. My rule of thumb: **the longer a tool lives and the
less I will look at it, the more I want Rust's compiler checking my work.**

## A clap CLI skeleton, complete

Here is the whole thing, without hand-waving. A tool with two subcommands, typed config,
and honest error handling.

```rust
// src/main.rs
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

/// Scan a directory tree and report on files.
#[derive(Parser, Debug)]
#[command(name = "scan", version, about)]
struct Cli {
    /// Directory to operate on.
    #[arg(short, long, default_value = ".")]
    path: PathBuf,

    /// Print more detail as we go.
    #[arg(short, long)]
    verbose: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Count files, honoring .gitignore.
    Count {
        /// Only count files with this extension.
        #[arg(long)]
        ext: Option<String>,
    },
    /// Print the absolute path of each match, one per line.
    List,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = cli
        .path
        .canonicalize()
        .with_context(|| format!("cannot resolve {}", cli.path.display()))?;

    match cli.command {
        Command::Count { ext } => {
            let mut n = 0usize;
            for entry in ignore::WalkBuilder::new(&path).build() {
                let entry = entry.context("failed to read directory entry")?;
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    continue;
                }
                if let Some(ref want) = ext {
                    if entry.path().extension().and_then(|e| e.to_str()) != Some(want.as_str()) {
                        continue;
                    }
                }
                n += 1;
            }
            if cli.verbose {
                eprintln!("scanned {}", path.display());
            }
            println!("{n}");
        }
        Command::List => {
            for entry in ignore::WalkBuilder::new(&path).build() {
                let entry = entry.context("failed to read directory entry")?;
                if entry.file_type().is_some_and(|t| t.is_file()) {
                    println!("{}", entry.path().display());
                }
            }
        }
    }

    Ok(())
}
```

Building and using it:

```bash
cargo build --release
./target/release/scan --path ~/code count --ext rs
./target/release/scan list | head
```

A few things worth noting, because they are the payoff. `clap` generated `--help`,
`--version`, and argument validation from the struct alone — I never wrote a usage string.
`anyhow::Context` turned every fallible call into a message a user can act on. `ignore`
gave me `.gitignore`-aware walking with a single builder. And the binary I `scp` to a
server has none of Python's environment questions.

## My recommendation

Use the smallest tool that will survive the job.

- **Shell** for anything that is one screen of glue, calls other programs, or is thrown
  away after it runs. Reach for it first, not as a fallback.
- **Python** for data munging, quick analysis, and anything where the library ecosystem
  (not the runtime) is the point — especially when it will run from source in an
  environment you control.
- **Go** when you want a single binary and the path of least resistance: fast builds,
  simple language, trivial cross-compilation.
- **Rust** when the tool will live for years, be distributed as a binary to machines you
  do not own, be invoked constantly, or grow past the size where a script stays readable.
  The `clap` + `anyhow` + `serde` + `ignore` combination is why I keep choosing it for the
  tools in my own dotfiles and on my servers.

The tiebreaker for me is always the same question: **will this outlive the afternoon I
write it?** If yes, Rust's upfront cost is a down payment on maintainability. If no, a
shell script is not a compromise — it is the correct answer. The same instinct about
buying structure only when it pays off runs through how I pick tools elsewhere: it is why
I keep [git workflows for a solo developer](/posts/git-for-solo-developers/) boring and
why I [self-host without Docker](/posts/self-hosting-without-docker/).

Write the script. Then, when you notice you keep opening the same file every week, rewrite
it in Rust.
