---
title: "Git Hooks: A Local CI You Can Version-Control"
description: "Git hooks are scripts that run at key points in the git lifecycle. Learn how pre-commit, commit-msg, and pre-push hooks work, why core.hooksPath solves the cloning problem, and how server-side hooks enforce what client hooks only suggest."
pubDate: 2027-02-02
lang: en
translationKey: git-hooks-and-local-ci
tags: [devops]
featured: false
keywords: [git hooks, pre-commit hook, core.hooksPath, commit-msg, pre-push]
---

Git hooks are the built-in extension mechanism most developers never touch — and that's a mistake. They're the cheapest CI you'll ever run: scripts that execute at precise moments in your git workflow, before anything reaches your remote. In this post I'll walk through the hooks that matter, show real output from each, and explain how to version them with `core.hooksPath` so your whole team shares the same guards.

I'm assuming you're comfortable with basic git. If you want a grounding in git's internals or a solo-dev git workflow, I've written about those separately: [git for solo developers](/posts/git-for-solo-developers/) and [git internals](/posts/git-internals/).

## What hooks actually are

A git hook is a script — any executable file — that git runs automatically at a specific point in the commit/push/checkout lifecycle. Git ships with a set of default hook names (each ending in `.sample`). When you rename a sample to drop the `.sample` suffix and make it executable, git starts running it.

The hooks most people care about are client-side:

- `pre-commit` — runs *before* the commit is created. Exit non-zero to abort.
- `commit-msg` — runs after the message editor closes, before the commit is finalized. Exit non-zero to reject the message.
- `pre-push` — runs before anything is pushed to the remote. Exit non-zero to block the push.
- `post-checkout` — runs after a checkout. Useful for regenerating files or setting up per-branch state.

And server-side hooks (on the bare repo):

- `pre-receive` — runs once before any refs are updated on the server.
- `update` — runs once per ref being updated.

Here's a visual map of where each hook fires:

<figure>
<svg viewBox="0 0 720 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Git lifecycle hook points">
  <!-- Timeline -->
  <line x1="40" y1="110" x2="680" y2="110" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
  <!-- Nodes -->
  <circle cx="80" cy="110" r="8" fill="#0f766e"/>
  <text x="80" y="145" text-anchor="middle" font-size="12" fill="currentColor">edit</text>

  <circle cx="180" cy="110" r="8" fill="#0f766e"/>
  <text x="180" y="145" text-anchor="middle" font-size="12" fill="currentColor">git add</text>

  <circle cx="280" cy="110" r="10" fill="#0f766e"/>
  <text x="280" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-commit</text>
  <text x="280" y="145" text-anchor="middle" font-size="12" fill="currentColor">git commit</text>

  <circle cx="380" cy="110" r="10" fill="#0f766e"/>
  <text x="380" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">commit-msg</text>
  <text x="380" y="145" text-anchor="middle" font-size="12" fill="currentColor">message</text>

  <circle cx="480" cy="110" r="10" fill="#0f766e"/>
  <text x="480" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-push</text>
  <text x="480" y="145" text-anchor="middle" font-size="12" fill="currentColor">git push</text>

  <circle cx="600" cy="110" r="10" fill="#0f766e"/>
  <text x="600" y="90" text-anchor="middle" font-size="11" fill="#0f766e" font-weight="bold">pre-receive</text>
  <text x="600" y="145" text-anchor="middle" font-size="12" fill="currentColor">bare repo</text>
</svg>
<figcaption>Hook points along the git lifecycle. Client-side hooks (pre-commit, commit-msg, pre-push) run on your machine; server-side hooks (pre-receive) run on the remote.</figcaption>
</figure>

## A pre-commit hook that actually blocks a commit

The most common use: reject commits that don't meet a standard. Here's a minimal `pre-commit` that scans staged files for a `TODO` marker and refuses the commit if it finds one:

```sh
#!/bin/sh
# .git/hooks/pre-commit
if git diff --cached --name-only | xargs grep -n "TODO" 2>/dev/null; then
  echo "ERROR: TODO found in staged files. Remove it before committing." >&2
  exit 1
fi
```

I tested this in a scratch repo. I staged a file containing `# TODO: fix this` and tried to commit:

```console
$ git commit -m "add bad file"
1:# TODO: fix this
ERROR: TODO found in staged files. Remove it before committing.
$ echo $?
1
$ git log --oneline
16fc42f initial commit
$ git status --short
A  bad.py
```

Three things to notice: the hook printed the offending line, exited with code `1`, and **no commit was created** — `git log` still shows only the initial commit, and the file remains staged. That's the core mechanic: a non-zero exit stops the operation.

## commit-msg: enforce a message format

The `commit-msg` hook receives the path to a temporary file containing the commit message. If it exits non-zero, the commit is aborted. This is how teams enforce [Conventional Commits](https://www.conventionalcommits.org/) or any format:

```sh
#!/bin/sh
# .git/hooks/commit-msg
commit_msg_file="$1"
commit_msg=$(cat "$commit_msg_file")
pattern='^(feat|fix|docs|style|refactor|test|chore)(\([a-z-]+\))?: .+'
if ! echo "$commit_msg" | grep -qE "$pattern"; then
  echo "ERROR: Commit message does not follow Conventional Commits format." >&2
  echo "Expected: type(scope): subject  (e.g. feat(auth): add login)" >&2
  echo "Got: $commit_msg" >&2
  exit 1
fi
```

A rejected message and an accepted one, from the same scratch repo:

```console
$ git commit -m "just some random message"
ERROR: Commit message does not follow Conventional Commits format.
Expected: type(scope): subject  (e.g. feat(auth): add login)
Got: just some random message
$ echo $?
1

$ git commit -m "feat(core): add new feature module"
[master 651ab1b] feat(core): add new feature module
 1 file changed, 1 insertion(+)
 create mode 100644 feature.txt
$ echo $?
0
```

## pre-push: run a quick test before pushing

`pre-push` runs before any objects are sent to the remote. It's the right place for a fast smoke test — something that takes seconds, not minutes. Here's a Python syntax check that runs before a push:

```sh
#!/bin/sh
# .git/hooks/pre-push
echo "Running pre-push tests..."
for f in $(git diff --name-only HEAD~1 HEAD 2>/dev/null | grep '\.py$'); do
  python3 -m py_compile "$f" 2>/dev/null || {
    echo "ERROR: Python syntax error in $f" >&2
    exit 1
  }
done
echo "All tests passed."
```

I committed a file with a deliberate syntax error and tried to push to a scratch bare repo:

```console
$ git push origin master
Running pre-push tests...
ERROR: Python syntax error in broken.py
错误：无法推送一些引用到 '../bare-repo.git'
$ echo $?
1
```

The push was blocked before anything left the machine. Note the Chinese error text — my git's `LC_MESSAGES` is set to `zh_CN.UTF-8`, so git itself localized the "could not push" message. The hook's English error is what matters.

## The cloning problem — and the core.hooksPath fix

Here's the catch with client-side hooks: **they live in `.git/hooks/`, which is not tracked by git and not cloned.** When a teammate clones your repo, they get none of your hooks. Every developer has to install them manually, and drift is inevitable.

The fix is to store hooks in a repo-tracked directory (conventionally `.githooks/`) and point git at that directory with `core.hooksPath`:

```sh
$ git config core.hooksPath .githooks
$ git config core.hooksPath
.githooks
```

Now I can commit `.githooks/` into the repo. After cloning, the `.githooks/` directory is present but **inactive** until you run that one config command:

```console
$ git clone bare-repo.git fresh-clone
$ cd fresh-clone
$ ls .githooks/
pre-commit
$ git config --get core.hooksPath
(exit: 1 — not set)
```

So the workflow for a new team member is: clone, then `git config core.hooksPath .githooks`. After that, the hooks run exactly as they do for you. I verified this end-to-end — after setting the config, a commit containing a `FIXME` marker was rejected:

```console
$ git config core.hooksPath .githooks
$ echo "# FIXME test2" > test-fixme2.txt
$ git add test-fixme2.txt
$ git commit -m "feat: test hook after config"
[.githooks/pre-commit] Running versioned pre-commit hook...
test-fixme2.txt
ERROR: FIXME marker found. Clean up before committing.
$ echo $?
1
```

## --no-verify: the legitimate bypass

Every hook can be skipped with `git commit --no-verify` (or `-n`). This is a footgun if abused, but it's also essential: sometimes you *need* to commit a WIP, a merge conflict resolution, or a temporary debug flag. The key is that `--no-verify` is explicit and visible in the reflog — it's not a silent failure mode.

```console
$ git commit --no-verify -m "feat: add hack file"
[master da1df6c] feat: add hack file
 1 file changed, 1 insertion(+)
 create mode 100644 hack.txt
$ echo $?
0
```

My rule of thumb: `--no-verify` is fine for local WIP commits you'll squash later, but never use it to push to a shared branch. If you find yourself needing `--no-verify` regularly, your hooks are too strict or too slow.

## Server-side hooks: the real enforcement point

Client-side hooks are suggestions. Anyone can bypass them with `--no-verify`, and they don't exist until you configure them. **Server-side hooks on your bare repo are the actual enforcement point** — they run on the server regardless of what any client does.

Here's a `pre-receive` hook for a bare repo that rejects pushes containing files larger than 1 MB:

```sh
#!/bin/sh
# hooks/pre-receive in the bare repo
while read oldrev newrev refname; do
  if [ "$newrev" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
  if [ "$oldrev" = "0000000000000000000000000000000000000000" ]; then
    files=$(git ls-tree -r --name-only "$newrev")
  else
    files=$(git diff --name-only "$oldrev" "$newrev")
  fi
  for file in $files; do
    size=$(git cat-file -s "$newrev:$file" 2>/dev/null || echo 0)
    if [ "$size" -gt 1048576 ]; then
      echo "ERROR: '$file' is $size bytes (max 1MB). Push rejected." >&2
      exit 1
    fi
  done
done
```

I committed a 3 MB file and tried to push:

```console
$ git push origin master
remote: ERROR: 'huge.bin' is 3145728 bytes (max 1MB). Push rejected.
To ../bare-repo.git
 ! [remote rejected] master -> master (pre-receive hook declined)
错误：无法推送一些引用到 '../bare-repo.git'
$ echo $?
1
$ git ls-remote origin
b5d969af5a170aa1a4f5e2dcf0f84291b55a2010	HEAD
b5d969af5a170aa1a4f5e2dcf0f84291b55a2010	refs/heads/master
```

The `remote:` prefix shows the error came from the server, not from any local hook. The remote still points to the old commit — nothing was updated. The `update` hook is similar but runs once per ref, which matters when a single push updates multiple branches.

## How this relates to a full CI

Hooks and CI are not competitors — they're layers. A **pre-commit hook** runs in under a second and catches the obvious stuff: leftover debug markers, syntax errors, formatting violations. A **pre-push hook** runs your unit test suite — still local, still fast, but heavier. A **CI pipeline** on your remote is the authority: it runs on every push to every branch, it can't be bypassed with `--no-verify`, and it has access to secrets, dependencies, and a clean environment.

The practical split:

- **Hooks**: fast feedback, catches mistakes before they leave your machine. Guard the common cases.
- **CI**: authoritative, runs everything, integrates with code review. This is where you enforce what hooks can't or shouldn't.

A solo dev might stop at hooks — a well-written `pre-push` that runs the test suite is often enough. A team adds CI on top so that no one can merge without a green build, regardless of their local hook configuration.

## A minimal solo-dev setup

If you work alone and want version-controlled hooks without ceremony, here's what I'd start with:

1. **Create a `.githooks/` directory** in your repo and put your hooks there.
2. **Set `core.hooksPath`** once per clone: `git config core.hooksPath .githooks`.
3. **Write a `pre-commit`** that runs your linter or formatter. Keep it under 2 seconds.
4. **Write a `commit-msg`** that enforces your message format. Even a loose regex beats no format at all.
5. **Write a `pre-push`** that runs your test suite. This is your safety net before anything reaches the remote.

That's it. No dependencies, no `npm install`, no framework. Just shell scripts in a directory that git already knows how to share. The whole setup is maybe 30 lines of shell, and it turns git from a dumb file tracker into a development workflow that enforces your standards automatically.

The beauty of git hooks is that they're already there — installed, documented, and waiting. The only question is whether you'll use them.
