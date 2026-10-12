---
title: "Local-first software: why your app should work offline (and what it costs)"
description: "Why cloud-default apps betray you on latency, availability, ownership and lock-in; what local-first software and offline-first really mean; the honest hard parts (conflict resolution, CRDTs vs last-write-wins, sync engines); a practical SQLite stack for small apps; and when local-first is overkill."
pubDate: 2026-11-21
lang: en
translationKey: local-first-software
tags: [devops, self-hosting]
featured: true
keywords:
  - local-first software
  - offline-first
  - CRDT
  - sync engine
  - data ownership
---

I write software for myself, and for years I defaulted to the same architecture without deciding anything: a server, a database on that server, and a thin client that talks to it over HTTP. Then I spent a week working from a train with bad wifi and watched half my own tools become useless. **Local-first software** is the answer I landed on: the app keeps its data on your device and treats the network as an enhancement, not a dependency. This post is why **offline-first** is usually the right default for small tools, what a **sync engine** and a **CRDT** actually buy you, and — just as important — exactly what it costs, because the honest answer is "more than the conference talks admit."

## The problem with cloud-default apps

A cloud-default app is one where the server is the only place your data exists and the client is a window onto it. That is defensible for a shared, always-online product, but a bad default for the long tail of software one person or a small team runs.

Four costs show up every time.

- **Latency.** Every interaction is a round trip. On a good connection that is 50ms of dead time per keystroke or click; on a bad one it is a spinner. The client cannot render your own data until the server agrees, so the app feels slower than a paper notebook even when the server is fast.
- **Availability.** If the server is down, or your connection is, or the vendor has an incident, the app has no features. Your data is not gone, but it is unreachable, which for practical purposes is the same. A local-first app degrades to "works, minus sync."
- **Ownership.** Your data lives in someone's database under someone's terms. You can usually export it, in a format that loses the relationships that made it useful. The default is that you are a tenant, not an owner.
- **Lock-in.** Once the schema, the API, and the auth all live in a vendor's cloud, leaving means rewriting the app. That asymmetry is the point: it is easy to move in and expensive to move out.

None of these is new, and none is inevitable. They are the bill for a design choice most of us never consciously made.

## What local-first software actually means

Local-first software inverts the default. The **source of truth is the copy on your device**, and the server, if any, exists only to help devices find each other. The canonical description comes from the Ink & Switch essay of the same name, and the short version is a set of properties:

- Your data lives on your device in a store you can read, copy, and back up.
- Reads and writes hit that local store directly, so they are instant and work with no network at all.
- Sync is a *feature you add*, not a requirement you must satisfy before anything works.
- If multiple devices change the same thing, the software converges to a consistent state rather than losing data or refusing to merge.

That last property is where all the difficulty lives, and I will get to it; the first three are the point, and they are cheap. Note the practical consequence: "offline-first" is not a mode you switch on, it is the result of putting the store next to the user and letting sync catch up later.

## The hard part: conflict resolution, CRDTs, and last-write-wins

The moment two devices can edit the same record, you need **conflict resolution**. This is the part that separates a demo from a product, and it is where most local-first projects quietly die.

### Last-write-wins: cheap, and lossy

The simplest strategy is **last-write-wins** (LWW): every write carries a timestamp, and when two versions meet, the newest wins. It is a few lines of code, it always converges, and it is wrong often enough to matter. Clocks disagree across devices, so "newest" can be arbitrary. And it silently discards the losing edit — no error, no prompt. For a single-user notes app where you never edit the same note on two devices at once, LWW is fine. For anything collaborative, it is data loss with extra steps.

### CRDTs: convergence without a referee

A **CRDT** (conflict-free replicated data type) is a data structure designed so that replicas merged in any order reach the same state. Unlike LWW, merging never silently drops an edit: a counter adds up, a set unions, a well-designed text type keeps both insertions. That property, called strong eventual consistency, is genuinely powerful — it is what makes collaborative editing work when peers cannot reach a central arbiter.

Here is an honest accounting. CRDTs buy you convergence, offline edits that merge cleanly, and no central server in the critical path. They cost you larger per-item metadata, tombstone garbage that needs collecting, text types that are subtle to implement, and a data model that does not map cleanly onto the rows and columns you already have. The key insight people miss is that a **CRDT is not a sync engine**. It is one merge strategy a sync engine can use, and it solves exactly one of your five problems. Reach for a CRDT when you have genuinely concurrent edits to shared structure — collaborative text, a shared queue, a shopping list. Do not reach for one because it sounds modern.

### Sync engines: the layer that makes it usable

A **sync engine** is the machinery that moves changes between replicas: tracking what changed since last sync, transmitting it, applying it, and resolving conflicts. The good news in 2026 is that you rarely write one from scratch. Options include SQLite-based engines like cr-sqlite and ElectricSQL, purpose-built ones like Automerge and Yjs for documents, and general-purpose tooling like Replicache or PowerSync. They trade in different units — operation logs, table-level diffs, or document updates — and the honest advice is to pick one whose conflict model matches your data before you have data to migrate.

<figure>
<svg viewBox="0 0 660 220" width="100%" role="img" aria-label="Two devices each own a local store that reads and writes go straight to; a sync layer moves changes between them only when the network is available, so the app never blocks on it.">
  <defs>
    <marker id="lf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="12" y="40" width="176" height="120" rx="10"/>
    <rect x="242" y="66" width="176" height="68" rx="10"/>
    <rect x="472" y="40" width="176" height="120" rx="10"/>
    <path d="M188 88 H242" marker-end="url(#lf-arrow)"/>
    <path d="M242 112 H188" marker-end="url(#lf-arrow)"/>
    <path d="M418 88 H472" marker-end="url(#lf-arrow)"/>
    <path d="M472 112 H418" marker-end="url(#lf-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" text-anchor="middle">
    <text x="100" y="76" font-size="14">Device A</text>
    <text x="100" y="100" font-size="12" opacity="0.8">local store</text>
    <text x="100" y="126" font-size="11" opacity="0.7">reads/writes go here</text>
    <text x="100" y="144" font-size="11" opacity="0.7">always available</text>
    <text x="330" y="92" font-size="14">sync engine</text>
    <text x="330" y="114" font-size="11" opacity="0.7">moves changes when online</text>
    <text x="560" y="76" font-size="14">Device B</text>
    <text x="560" y="100" font-size="12" opacity="0.8">local store</text>
    <text x="560" y="126" font-size="11" opacity="0.7">reads/writes go here</text>
    <text x="560" y="144" font-size="11" opacity="0.7">always available</text>
    <text x="330" y="28" font-size="11" opacity="0.6">the app never blocks on this</text>
  </g>
</svg>
<figcaption>The local-first shape: each device reads and writes its own store, and sync is a background concern that catches up when it can.</figcaption>
</figure>

## Building an offline-first app: SQLite locally, sync on top

For a small app, the practical stack is unglamorous and it is the same one I keep recommending: **SQLite** on the device plus a sync path you control. SQLite is already the best local store on earth — a single file, transactional, queryable, and present in every phone, browser, and laptop. If you have read my case for [SQLite as the default small-app database](/posts/sqlite-is-enough/), this is the same argument one layer up.

The simplest correct design is local-only: ship SQLite, and add an explicit import/export so the user owns their data as a file. That is a complete, defensible product for a personal tool, and I have shipped it more than once.

```sql
-- every row carries enough metadata to merge later
CREATE TABLE note (
  id          TEXT PRIMARY KEY,   -- UUID, generated on-device
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,   -- device logical clock, not wall time
  device_id   TEXT NOT NULL,      -- who wrote it, for tie-breaking
  deleted     INTEGER NOT NULL DEFAULT 0
);
```

Notice the columns that exist only for sync: `updated_at`, `device_id`, and a soft-delete flag (a hard `DELETE` is invisible to a peer that never saw the row). Those three are the minimum to make last-write-wins converge. If you want merges that do not lose edits, you layer a CRDT or an operation log on top, and the schema gets more expensive per row — that is the trade, stated plainly.

A naive LWW merge is small enough to show:

```ts
type Note = { id: string; updated_at: number; device_id: string; deleted: number };

// newest logical clock wins; device_id breaks ties deterministically,
// so every replica reaches the same answer regardless of merge order.
function pick(a: Note, b: Note): Note {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return a.device_id > b.device_id ? a : b;
}
```

That is honest last-write-wins: correct convergence, deterministic, and still lossy. The `device_id` tie-break is the difference between "eventually consistent" and "randomly inconsistent."

## The unglamorous parts nobody tweets about

Three more problems show up once you go beyond one device, and they are the reason local-first is real work:

- **Multi-device.** Two devices drift apart the longer they are offline, and merge cost grows with the diff: how much history to keep, when to snapshot, how a month-offline device rejoins without downloading everything.
- **Schema migrations.** A cloud app migrates one database. A local-first app migrates *every device*, including ones that have been offline for months and hold old data. Migrations become a compatibility problem across versions, and you lose the luxury of "just run it on the server."
- **Auth without a server.** If the app works offline, it must authenticate offline — against a device-held key or a cached credential, not a live session check. That pushes you toward local key storage, signed operations, and a sync server that verifies signatures rather than trusting a session cookie. It is more crypto than most small apps want to touch, and it is why "no server at all" is often the cheaper answer.

None of these is fatal. All of them are ongoing maintenance, and the bill arrives during a bad week, not a demo.

## Where local-first is overkill

I will not pretend it is always the answer. Local-first is overkill when:

- **The data is genuinely shared in real time.** A multiplayer game, a live dashboard, a chat room — a central authority is simpler and you want it.
- **The data must be authoritative and server-controlled.** Payments, inventory counts, anything where a client must not be trusted. The server owns that truth on purpose.
- **There is no offline story.** If the app is useless without a network anyway (streaming, search over a remote corpus), local-first buys you nothing and costs you sync machinery.
- **The team is one person and the data is small.** Sometimes a server and a `curl` is genuinely less code than a sync engine and a conflict model.

The failure mode I see most is the opposite of overselling: teams add a sync engine to an app that never needed to work offline, then spend months on conflicts for a product whose users are always online.

## My recommendation

Start local-only. Put your data in **SQLite** on the device, make reads and writes instant, and add an **export** so the user owns a file. That is the 80% of local-first value — latency, availability, **data ownership** — for a fraction of the complexity, and it is reversible.

Add a sync layer only when you have a concrete, named need: two devices you personally use, or a second person editing the same data. When you do, choose the conflict model before the library. Last-write-wins for single-writer-per-record data; a CRDT only for genuinely concurrent edits to shared structure; and a proven sync engine rather than a homemade one whenever you can. If you self-host the sync endpoint, keep it boring and behind the same front door as everything else — this is a peer in the [stack I already run](/posts/what-i-self-host-2026/), not a new religion.

Local-first is not free, and it is not for everything. But for the small tools that make up most of the software I actually use, it is the difference between an app I own and an app I am renting. That trade has been worth it every time.
