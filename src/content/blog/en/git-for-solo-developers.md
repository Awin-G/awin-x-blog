---
title: "Git workflows for a solo developer: you don't need Git Flow"
description: "Git Flow and PR-heavy processes exist to coordinate teams. If you are the only committer, they are pure overhead. My git workflow: trunk on main, short-lived branches or direct commits, tags for releases, tight commit hygiene, a few pre-commit hooks, and bisect plus reflog as the safety net."
pubDate: 2026-11-08
lang: en
translationKey: git-for-solo-developers
tags: [devops, linux]
featured: false
keywords:
  - git workflow
  - solo developer
  - git branch strategy
  - pre-commit
  - bisect
---

Every tutorial about branching opens with the same diagram: `develop`, `feature/*`,
`release/*`, `hotfix/*`, arrows going everywhere. That diagram was drawn to solve a
problem I do not have. My git workflow, as a solo developer, is about ten lines of
habit and a couple of hooks — no release trains, no mandatory pull requests, no
branch left alive longer than an afternoon. Here is the version I actually use, and
why almost everything the team-oriented advice tells you to do is ceremony when you
are the whole team.

## Why team branching models are overhead for one person

Git Flow is not a law of software; it is a coordination protocol. Every branch in it
exists to manage a *specific conflict between people*:

- `develop` exists because a release train must leave `main` stable while unfinished
  work piles up somewhere else.
- `feature/*` branches exist so two people can edit the same files in parallel.
- `hotfix/*` exists because the person who fixes an emergency is not the person
  who owns the release branch.
- Pull requests exist to force a second pair of eyes onto a change, and to give a
  merge a paper trail.

None of those conflicts exist when the number of committers is one. What you keep
instead is the cost: stale branches you forget to delete, "merge release into
develop" commits that mean nothing, conflicts you invented by splitting your own
work across three long-lived lines, and a mental model of the repository that is
strictly larger than the repository. A PR you open against yourself and merge
yourself is just `git commit` with a delay, a web round-trip, and a green button.

If a flow adds a step, the step has to buy something. For one person, it usually
does not.

## The git branch strategy I actually use

My entire strategy fits in four rules:

1. **`main` is trunk and is always releasable.** Whatever is on `main` should be
   deployable at any moment. This blog deploys itself from `main` on every push,
   which makes the rule self-enforcing — see
   [how this blog ships itself](/posts/how-this-blog-ships-itself/).
2. **Small changes go straight to `main`.** A typo fix, a dependency bump, a config
   tweak: commit and push. A branch here is pure friction.
3. **Anything that might take more than an hour, or that I might abandon, gets a
   short-lived branch.** The branch is a scratchpad, not a stage in a process. Its
   only job is to keep half-finished work off `main` until it is done.
4. **Releases are tags, not branches.** I never keep a `release-1.x` branch alive.
   The artifact is the annotated tag.

That is the whole thing. The day-to-day loop looks like this:

```bash
# The 80% path: just work on main.
git switch main
git pull --ff-only
$EDITOR some/file
git add -p                      # stage only what belongs in this commit
git commit -m "clamp retry backoff to 30s"
git push

# The 20% path: an experiment that may or may not survive.
git switch -c try/new-parser
# ... work, commit as you go ...
git switch main
git merge --ff-only try/new-parser   # only if it stays a straight line
git branch -d try/new-parser
```

Cutting a release is one command, and the tag carries the message so `git describe`
and `git log` both stay useful:

```bash
git tag -a v1.4.0 -m "esptool support, fix captive-portal detection"
git push origin v1.4.0
git describe --tags            # -> v1.4.0-3-gabc1234
```

If I need to patch an old release, I branch *from the tag*, land the fix, and tag
again. No permanent `hotfix` branch, no merge back into anything.

## Commit hygiene: your history is the changelog

With no teammates to ask, the git log is the only documentation of *why* the code
looks the way it does. I treat it accordingly.

- **One idea per commit.** If you cannot describe the commit in a single sentence
  without "and", it is two commits. `git add -p` exists precisely so you can stage
  parts of a file.
- **Imperative subject, under ~50 characters.** "fix: reject zero-length reads", not
  "fixed some stuff".
- **The body explains why, not what.**

The difference is not cosmetic. When you are staring at `git blame` eighteen months
from now, the message is the only context you have left:

```text
# Bad — tells you nothing you couldn't read in the diff:
wip
fix bug
more changes

# Good — the body carries the reasoning that is not in the code:
reject responses whose Content-Length is zero

The CDN returns 200 with an empty body during a purge. We treated that as
a valid empty document and cached deleted content. Treating a zero-length
body as a retryable error fixes it.
```

For local cleanup before pushing, rewrite freely — it is *your* history, nobody has
it:

```bash
git commit --amend                 # fix the last message or content
git rebase -i HEAD~5               # squash, reword, reorder, drop
git config --global rebase.autosquash true
git commit --fixup <sha>           # then rebase -i --autosquash to fold it in
```

## pre-commit hooks worth having

A hook is a rule enforced by the machine instead of by your memory, which is the
whole reason to bother. You do not need a zoo of them. Three pull their weight:

1. **Run the tests and the linter.** The fast ones, on every commit, so broken code
   never reaches `main`. The slow suite belongs in CI.
2. **A content / format check.** In this blog that means validating that each
   Markdown file parses and its frontmatter has the fields the schema requires. In
   another repo it is `gofmt -l` or a trailing-whitespace check. Format drift is the
   slowest kind of rot.
3. **Secret scanning.** The one hook you cannot skip. A leaked key in a pushed
   commit is a rotation incident, and once it is public, "delete the commit" does not
   undo it.

The [`pre-commit`](https://pre-commit.com) framework wires all three into one config
file that lives in the repo:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-yaml
      - id: end-of-file-fixer
      - id: trailing-whitespace
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
  - repo: local
    hooks:
      - id: tests
        name: fast tests
        entry: make test-fast
        language: system
        pass_filenames: false
```

```bash
pip install pre-commit
pre-commit install          # writes .git/hooks/pre-commit
pre-commit run --all-files  # run it once over the whole tree
```

Two caveats. Hooks live in your working copy, so `git commit --no-verify` bypasses
them and a fresh clone has none until you run `pre-commit install` — never treat a
hook as a gate. Run the same checks in CI as well, and let the hook be the fast
local mirror of that gate, not the gate itself.

## When you actually collaborate

The moment a second committer appears, the branches become worthwhile — and the
rules change:

- **Feature branches come back**, because two people now *can* touch the same file
  at once. Branch, push, open a pull request.
- **Rebase your own branch, never someone else's.** To bring a stale feature branch
  up to date, rebase it onto `main` for a clean, linear history. Once a branch is
  shared and someone else has built on it, rebasing rewrites commits they already
  pulled — merge `main` into it instead.

```bash
# Local, unshared branch: rebase for a straight line.
git switch feature/login
git fetch origin
git rebase origin/main
git push --force-with-lease     # safe force: refuses if upstream moved

# Shared branch, or a release branch: merge, don't rebase.
git switch feature/login
git merge origin/main
```

- **Keep pull requests small and single-purpose.** A 900-line PR gets a rubber stamp,
  not a review. A 90-line PR gets read.
- **Turn on branch protection for `main`.** Even with two people, "nobody pushes to
  `main` directly" is the one process rule that earns its keep.

`--force-with-lease` is the detail people get wrong. Plain `--force` will happily
clobber a teammate's push; `--force-with-lease` refuses if the remote moved since
you last fetched. Use it every single time.

## bisect and reflog: the safety net

The two commands that make the solo workflow safe are the ones people learn last.

**`git bisect` finds the commit that introduced a bug** by binary search — a
thousand commits become about ten tests. Automate it with a script and let it run:

```bash
git bisect start
git bisect bad                 # current HEAD is broken
git bisect good v1.3.0         # this tag was fine
git bisect run ./scripts/repro.sh   # exit 0 = good, non-zero = bad
git bisect reset
```

`git bisect run` exits the loop the moment the script's exit code flips, names the
offending commit, and cleans up. A reproduction script you can trust is the entire
investment.

**`git reflog` is the undo for everything else.** Reset, rebase, and branch deletion
all look "permanent" until you remember that HEAD has been logging every move:

```bash
git reflog                          # find the commit you dropped
git switch -c rescue HEAD@{3}       # branch back to it
git reset --hard HEAD@{1}           # undo the reset you just did
```

I have recovered an interactive rebase I botched, and a `reset --hard` I ran in the
wrong checkout, both in seconds. Because of the reflog, almost nothing in git is
truly lost for weeks — so experiment freely and push often.

## A few config niceties

Set these once and the defaults stop fighting you:

```bash
git config --global init.defaultBranch main
git config --global pull.rebase true        # pull = fetch + rebase, no merge bubbles
git config --global rebase.autosquash true
git config --global fetch.prune true        # drop deleted remote branches
git config --global merge.conflictstyle zdiff3   # shows the common ancestor
git config --global rerere.enabled true     # remember conflict resolutions
git config --global diff.algorithm histogram
git config --global alias.lg "log --oneline --graph --decorate"
git config --global alias.amend "commit --amend --no-edit"
```

`merge.conflictstyle zdiff3` deserves a special mention: with the common ancestor
showing in the conflict markers, you can see *what each side changed*, which turns a
guessing game into a decision. `rerere` then replays resolutions you already made
when the same conflict comes back during a rebase.

None of this is impressive, and that is the point. The best git workflow for a solo
developer is the one that spends your attention on the code and keeps a way back if
you are wrong: a trunk on `main`, tags for releases, commits you can read, a couple
of hooks, and `bisect` and `reflog` in your back pocket.

The infrastructure around this repo runs the same way — one machine, a handful of
units, no docker — which is what I wrote about in
[self-hosting without Docker](/posts/self-hosting-without-docker/).
