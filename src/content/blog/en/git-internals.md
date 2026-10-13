---
title: "Git internals: objects, refs, and packfiles (git is a tiny database)"
description: "A hands-on tour of Git internals: blobs, trees, commits, and tags as one content-addressed store, refs and HEAD, and how git gc packs loose objects. Real git cat-file, ls-tree, and verify-pack output."
pubDate: 2027-01-19
lang: en
translationKey: git-internals
tags: [devops]
featured: false
keywords:
  - Git internals
  - git objects
  - blob tree commit
  - packfiles
  - git cat-file
---

Most of the time git feels like a folder of text files with an undo button attached. Underneath that friendly surface, **Git internals** is both simpler and more elegant than the command set suggests: it's a content-addressed key–value store. Everything you commit, branch, or reset is, at the bottom, one of four **git objects** — the **blob tree commit** (plus the tag) — each stored under the SHA-1 of its own contents. Refs such as `HEAD` and `refs/heads/main` are nothing more than files that hold a hash, and over time **packfiles** squeeze the whole graph onto disk. In this post I'll pop the hood with real `git cat-file` output and show that git really is a tiny database.

Everything below is from a fresh repo I built with git 2.56.0. No tricks, no redaction — this is the actual output.

## Git internals: four object types in one content-addressed store

Start by initializing an empty repository and looking at what git created:

```sh
$ git init demo
Initialized empty Git repository in .../demo/.git/
$ ls .git
config
description
HEAD
hooks
info
objects
refs
```

Almost everything interesting lives in `.git/objects`. Git stores **git objects** there, and there are exactly four kinds:

- **blob** — the raw contents of a file. No name, no path, just bytes.
- **tree** — a directory listing. It maps a name (with mode bits) to a blob or another tree.
- **commit** — a pointer to one tree, plus parent commits, an author, and a message.
- **tag** — an annotated tag object that points at another object.

The word *content-addressed* is the key idea. You never ask git to save "version 3 of app.py"; you hand git bytes and it hands back the SHA-1 of those bytes. That hash _is_ the address. Make a blob and watch it appear:

```sh
$ echo 'print("hello")' > app.py
$ git hash-object -w app.py
11b15b1a4584b08fa423a57964bdbf018b0da0d5
$ git cat-file -t 11b15b1
blob
```

The `-w` flag is what actually writes the object into `.git/objects`. Without it, `hash-object` just prints the hash and throws the bytes away. Now ask git what type each object is and it's obvious they're peers in the same store:

```sh
$ git cat-file -t f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
commit
$ git cat-file -t 7298c20ec158c1e9064e11c7035956f883e41270
tree
$ git cat-file -t 6844eb30b360b3756885d1ad0cfc2a8f32c876bc
tag
```

Because the address is derived from the content, two identical files anywhere in the repository — or anywhere on Earth — produce the same blob and are stored once. That's git's built-in deduplication, and it falls out for free from hashing.

## The blob, tree, commit graph

Here's the part that makes "git is a database" click. After committing `app.py`, a `src/util.py`, and a `README.md`, the root tree looks like this:

```sh
$ git ls-tree HEAD
100644 blob 03d17bd48c75430987a9b01b9b296f20d50ec6d8	README.md
100644 blob b9f2c3c96ec0e97ab1791c1625d124218ab38fba	app.py
040000 tree 42ee7f3c96dc32b419752107861a6d3bf3842216	src
```

Read that carefully. A tree is a flat list of `mode type sha name` rows. `100644` is a regular file, `040000` is a subdirectory that itself points at a *tree* object (`42ee7f3c…`), not a blob. `src/` therefore recurses:

```sh
$ git ls-tree HEAD src/
100644 blob 312b477d18e86322d223001d940fc5a0b3758fc0	src/util.py
```

And a commit is just a short text file that points at the top-level tree and its parent:

```sh
$ git cat-file -p HEAD
tree 7298c20ec158c1e9064e11c7035956f883e41270
parent 5db046419edc9c7477c9e50d9983f3be14ac36c9
author DeepSeek <deepseek@awin-x.top> 1767664800 +0800
committer DeepSeek <deepseek@awin-x.top> 1767664800 +0800

Update app and util
```

Pull the whole graph together and it's arrestingly plain — a **blob tree commit** chain where a commit points to a tree, a tree points to blobs and subtrees, and a commit points back to its parent:

<figure>
<svg viewBox="0 0 660 232" width="100%" role="img" aria-labelledby="gi-t gi-d" style="max-width:660px;height:auto;font-family:ui-monospace,monospace">
  <title id="gi-t">A commit points to a root tree, which points to blobs and a subtree</title>
  <desc id="gi-d">Commit f5ef823 points to root tree 7298c20. That tree lists app.py blob b9f2c3c, README blob 03d17bd, and the src tree 42ee7f3c, which in turn lists util.py blob 312b477.</desc>
  <defs>
    <marker id="gi-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 z" fill="#0f766e"></path>
    </marker>
  </defs>
  <!-- commit -->
  <rect x="16" y="88" width="140" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="30" y="110" font-size="12" fill="#0f766e">commit</text>
  <text x="30" y="126" font-size="12" fill="currentColor">f5ef823</text>
  <!-- root tree -->
  <rect x="216" y="88" width="150" height="48" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="230" y="110" font-size="12" fill="#0f766e">tree (root)</text>
  <text x="230" y="126" font-size="12" fill="currentColor">7298c20</text>
  <!-- connectors -->
  <line x1="156" y1="112" x2="210" y2="112" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></line>
  <path d="M366,112 L452,46" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <line x1="366" y1="112" x2="210" y2="112" stroke="none"></line>
  <line x1="366" y1="112" x2="446" y2="98" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></line>
  <path d="M366,112 L452,150" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <!-- app.py blob -->
  <rect x="452" y="24" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="42" font-size="10" fill="#0f766e">100644 blob</text>
  <text x="464" y="58" font-size="11" fill="currentColor">app.py → b9f2c3c</text>
  <!-- README blob -->
  <rect x="452" y="76" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="94" font-size="10" fill="#0f766e">100644 blob</text>
  <text x="464" y="110" font-size="11" fill="currentColor">README.md → 03d17bd</text>
  <!-- src tree -->
  <rect x="452" y="128" width="196" height="44" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="146" font-size="10" fill="#0f766e">040000 tree</text>
  <text x="464" y="162" font-size="11" fill="currentColor">src → 42ee7f3c</text>
  <!-- util.py blob -->
  <path d="M550,172 L550,182" stroke="#0f766e" stroke-width="1.5" marker-end="url(#gi-arrow)"></path>
  <rect x="452" y="184" width="196" height="36" rx="6" fill="none" stroke="#0f766e" stroke-width="1.5"></rect>
  <text x="464" y="206" font-size="11" fill="currentColor">util.py → 312b477</text>
</svg>
<figcaption>A commit points to one root tree; the tree points to blobs (files) and subtrees (directories). Every arrow is a hard link stored by content hash.</figcaption>
</figure>

This is why git history is tamper-evident. Change a single byte in `app.py`, and the blob gets a new SHA — which changes the tree, because the tree now names a different hash — which changes the commit. The commit's SHA is computed from its own contents, including that tree pointer, so it changes too, and every descendant commit points at a now-different parent. You cannot quietly rewrite a file in the middle of history without changing the SHA of everything after it. That chain of hashes is exactly the integrity guarantee people get excited about, and it's not a special feature bolted on — it's a consequence of addressing objects by their contents.

Notice too that trees are immutable and shared. If `README.md` didn't change between two commits, both root trees list the *same* blob `03d17bd`. Git stores that blob once and both trees reference it. Nothing is ever edited in place; a new commit points at new objects and the old ones linger untouched until garbage collection prunes them.

## Refs and HEAD: branches are just files with a SHA

If objects form the database, **refs** are the pointers, and a branch is literally a file containing 40 hex characters. Straight from `.git`:

```sh
$ cat .git/HEAD
ref: refs/heads/main
$ cat .git/refs/heads/main
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ git rev-parse HEAD
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
```

`HEAD` usually contains a symbolic reference (`ref: refs/heads/main`) meaning "whichever commit `main` currently points at." A branch is not a container of commits; it's a sticky note with one SHA on it. That's the entire mental model. An annotated tag is also a ref, but it resolves to a tag *object* rather than straight to a commit:

```sh
$ git cat-file -p v1.0
object f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
type commit
tag v1.0
tagger DeepSeek <deepseek@awin-x.top> 1767747600 +0800

Release 1.0
```

One wrinkle: after a packed repository, you may not find `.git/refs/heads/main` at all. Git can move loose refs into a single file to avoid one-file-per-branch bloat:

```sh
$ cat .git/packed-refs
# pack-refs with: peeled fully-peeled sorted
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc refs/heads/main
```

Same idea, different shelf: a branch is still just a name mapped to a hash.

## How git log and git diff fall out of the graph

Once objects are a graph and refs are pointers, `log` and `diff` aren't special machinery — they're walks. `git log` starts at the commit `HEAD` resolves to, prints it, follows the `parent` pointer, prints that, and repeats. Nothing more:

```sh
$ git log --oneline
f5ef823 Update app and util
5db0464 Add app and util
```

`git diff` between two commits simply loads each commit's tree, walks both trees in parallel, and reports where the blob hashes diverge. Because content is hashed, comparing two versions of a file is a hash comparison — no byte-level diff unless the hashes differ, and even then the tree only re-diffs the paths that actually changed:

```sh
$ git diff 5db0464 HEAD
diff --git a/app.py b/app.py
index 11b15b1..b9f2c3c 100644
--- a/app.py
+++ b/app.py
@@ -1 +1,2 @@
-print("hello")
+print("hello v2")
+print("second line")
diff --git a/src/util.py b/src/util.py
index 4693ad3..312b477 100644
--- a/src/util.py
+++ b/src/util.py
@@ -1,2 +1,2 @@
-def add(a, b):
-    return a + b
+def sub(a, b):
+    return a - b
```

See the `index 11b15b1..b9f2c3c` line? Those are the two blob hashes. `README.md` is absent because its blob is identical in both trees, so git skips comparing it entirely. The unified diff you read is a presentation layer; the decision about *what* to show was already made by comparing hashes in the trees.

## Loose objects vs packfiles, and what git gc does

Newly written objects are **loose**: each one is a small zlib-compressed file under `.git/objects/`, one per object, named by its hash. That's fast and safe, but wasteful for large histories. Before any packing, count the objects:

```sh
$ git count-objects -v
count: 11
size: 44
in-pack: 0
packs: 0
size-pack: 0
```

Eleven separate loose objects. Run the garbage collector and they collapse into a single **packfile**:

```sh
$ git gc
$ git count-objects -v
count: 0
size: 0
in-pack: 11
packs: 1
size-pack: 2
```

Zero loose objects, eleven packed into one file, and the on-disk footprint drops from 44 KiB to 2 KiB. A `.pack` file stores objects as a sorted stream, delta-compressed against each other — so the tiny `app.py` change between versions doesn't store the whole file twice, just the diff. Inspect the real pack:

```sh
$ git verify-pack -v .git/objects/pack/*.pack
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc commit 228 157 12
5db046419edc9c7477c9e50d9983f3be14ac36c9 commit 177 124 169
03d17bd48c75430987a9b01b9b296f20d50ec6d8 blob   32 35 293
b9f2c3c96ec0e97ab1791c1625d124218ab38fba blob   39 45 328
312b477d18e86322d223001d940fc5a0b3758fc0 blob   32 42 373
7298c20ec158c1e9064e11c7035956f883e41270 tree   101 110 415
...
non delta: 11 objects
.git/objects/pack/pack-eed3fc9e8a33ebbd0b5eb63284fb47393ab5ef25.pack: ok
```

Each row is `<sha> <type> <size> <packed-size> <offset>`. The accompanying `.idx` file lets git binary-search the pack by SHA, so random access stays fast. Note `git gc` also ran `pack-refs`, which is why the loose `.git/refs/heads/main` disappeared into `packed-refs` in the previous section. Loose versus packed is purely a storage optimization; the object graph is identical either way.

## Why this explains everyday git

Nearly every git action that feels magical is just a pointer move in this store.

**`git reset` moves a ref.** `reset --hard HEAD~1` doesn't delete the newest commit; it rewrites `.git/refs/heads/main` to point one commit earlier and updates your working tree to match. The old commit and its unique blobs still exist in the object store — that's why `reset` is cheap and `git reflog` can recover it:

```sh
$ cat .git/refs/heads/main           # before
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ git reset --hard HEAD~1
$ cat .git/refs/heads/main           # after
5db046419edc9c7477c9e50d9983f3be14ac36c9
$ git cat-file -t f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
commit                              # still here, now just unreferenced
```

**A rebase rewrites commits.** Rebase creates brand-new commit objects with new parent pointers and re-points your branch at the fresh tip. The old commits aren't edited — they're abandoned, since a commit's SHA is derived from its parent's SHA, so replaying onto a different base inevitably produces new hashes. That's also why you shouldn't rebase pushed history: you and your collaborators would end up with two divergent sets of commit objects for the "same" changes.

**A detached HEAD is just a ref pointing at a commit.** When you check out a raw SHA, git writes that SHA directly into `.git/HEAD` instead of `ref: refs/heads/…`:

```sh
$ git checkout f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
$ cat .git/HEAD
f5ef823efa9ff5d7d2af52dff6e108cd153b8ddc
```

There's no current branch any more — `HEAD` isn't symbolic — so new commits have no branch to update, and checking out another branch leaves them "detached" (recoverable only via reflog). It is a single line in a single file. That's the whole phenomenon.

The next time a git operation surprises you, don't reach for a memorized incantation — ask what object it created and which ref it moved. That's almost always the answer, because under the hood git isn't a version-control system with a data model; it's a small, content-addressed database that a few friendly commands happen to be wrapped around.

If you enjoyed poking at real object dumps, my walkthrough on digging through git history — [Git archaeology](/posts/git-archaeology/) — is the natural next read, and for the human side of working day-to-day without ceremony, see [git for solo developers](/posts/git-for-solo-developers/).
