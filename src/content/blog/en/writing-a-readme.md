---
title: "Writing a README people actually read: a quickstart-first guide to project documentation"
description: "A README is a product, not a formality. This is how I write project documentation that gets a stranger from \"what is this\" to \"it works\" in one screenful: the sections that matter and their order, the quickstart that actually runs on a fresh clone, what to leave out, and a copyable template."
pubDate: 2026-11-28
lang: en
translationKey: writing-a-readme
tags: [devops]
featured: false
keywords:
  - README
  - project documentation
  - quickstart
  - developer experience
  - template
---

A **README** is the highest-leverage piece of **project documentation** you will ever write, and most of us treat it as a formality we do on the way out the door. That is backwards. The README is the first thing a new teammate, a future you, or a stranger on the internet reads, and it has one job: move a person from "what is this" to "it works" as fast as possible. Every sentence that does not shorten that trip works against your **developer experience**. The **quickstart** is not a section of the README — it *is* the README, and everything else is supporting material.

I have written a lot of these and watched people bounce off my own bad ones. The difference between a README that gets read and one that gets abandoned is rarely the writing. It is the order, and the willingness to delete.

<figure>
  <svg viewBox="0 0 760 300" width="100%" role="img" aria-labelledby="readme-fold-title" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">
    <title id="readme-fold-title">What belongs in the first screenful of a README</title>
    <desc id="readme-fold-desc">Name and one-line description, a short why, and a copy-paste quickstart command all sit above the fold; configuration, architecture, gotchas and license scroll below.</desc>
    <rect x="16" y="16" width="728" height="268" rx="14" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="36" y="42" fill="currentColor" font-weight="600"># project-name — one line: what it is</text>
    <text x="36" y="66" fill="currentColor" opacity="0.85">Why it exists. Two or three lines, no marketing.</text>
    <rect x="36" y="82" width="688" height="66" rx="8" fill="none" stroke="#0f766e" stroke-width="1.5"/>
    <text x="52" y="106" fill="currentColor" font-weight="600">Quickstart — copy-paste, runs on a fresh clone</text>
    <text x="52" y="128" fill="currentColor" font-family="ui-monospace, monospace" font-size="12">$ git clone … &amp;&amp; cd … &amp;&amp; make run  → http://localhost:8080</text>
    <line x1="36" y1="166" x2="724" y2="166" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 4"/>
    <text x="36" y="190" fill="currentColor" opacity="0.7">— the fold: everything below is reference, not a decision —</text>
    <text x="36" y="216" fill="currentColor" opacity="0.85">Configuration · Architecture sketch · Gotchas · License</text>
    <text x="36" y="242" fill="currentColor" opacity="0.6">Read later, or never. That is fine.</text>
  </svg>
  <figcaption>A reader decides in one screenful whether to trust you. Put the name, the why, and a working command up top; push the reference material below the fold.</figcaption>
</figure>

## The job of a README: from "what is this" to "it works"

A README is a funnel with a single conversion: someone arrives with a vague question and leaves with the thing *running*. Not understood — running; understanding is a much later stage and should not spend the README's budget.

That reframing decides what you write. A marketing tagline or a design essay never moves anyone through the funnel; a single command that works does, instantly. Measure every paragraph against one question: **does this shorten the trip from clone to running?** If not, it belongs at the bottom or in `docs/`.

## The sections that matter, in order

Seven sections, in this order. The order is the trick — sorted by decreasing urgency, not by importance.

1. **One-line what.** Name, then one sentence: what it is and who it is for.
2. **Why it exists.** Two or three lines on the problem it solves and what it replaces — this answers "should I even use this", which readers ask first.
3. **Quickstart that actually runs.** The one section you must not fake. More below.
4. **Configuration.** The knobs, their defaults, and which are required — a table, not prose.
5. **Architecture sketch.** The moving parts and how data flows, just enough to orient a change.
6. **Gotchas.** Known limitations, footguns, "do not do this in production yet".
7. **License.** One line and a link; never bury it, since people filter on it in seconds.

If you have these seven and nothing else, you have a good README. Most READMEs fail not by having too few sections but by ordering them wrong, with the quickstart lost on line 90.

## Show a real command in the first screenful

The most common failure: the first screenful is badges, a logo, a features list, and no command. The reader scrolls, finds nothing executable, and closes the tab.

Put a **real, copy-pasteable command above the fold.** Not a placeholder like `<your-token>`, not a link to "see the wiki". A command someone can paste and watch do something. Even three lines prove the project is alive and that you respect the reader's time. Everything they need to *decide* goes above the fold; everything they need to *operate* goes below.

## A quickstart that actually runs

Most READMEs quietly lie here. The bad version, which I have written more than once:

```bash
# BAD — reads like a quickstart, runs like a scavenger hunt
# 1. Install the dependencies for your platform.
# 2. Configure your database connection.
# 3. Set the required environment variables.
# 4. Start the server and open your browser.
# See the wiki for details.
```

Every line is a footnote. "Your platform" is a decision you did not make for me; "the required environment variables" is a list you did not give me. The reader must read four other documents before the first command does anything.

Now the good version — the one I test on a clean machine before I commit it:

```bash
# GOOD — fresh clone to a running server, copy-paste, no edits
git clone https://github.com/acme/widgets.git
cd widgets
cp .env.example .env       # committed defaults work for local dev
docker compose up --build  # first build is slow (~90s); later starts are seconds
# → open http://localhost:8080/health; it should return {"ok":true}
```

Four lines, no decisions, a stated expected output. Yes, `docker compose` is a choice — but *made for the reader*, not left to them. With several install paths, pick one default and tuck the rest into a collapsed section; a quickstart offering three options runs for nobody.

## "Works on a fresh clone" is the bar

Before calling the README done, clone your repo into a fresh directory and follow your own quickstart from a clean shell. No leftover `.env`, no globally-installed tool from two years ago. This one ritual catches almost every quickstart bug: the `.env.example` you forgot to commit, the tool installed on your laptop but not listed as a requirement, the step you do automatically and forgot to write down.

If it does not work from a fresh clone, it does not work — and every reader hits the same wall, without your context. As with [reading a codebase](/posts/reading-a-codebase/), the honest test is running it, not reading it.

## Configuration: name the knobs

Configuration belongs in a table, not a paragraph: a name, a default, and one line of meaning per knob, with required values marked as required. Readers come back to this section, so optimize it for scanning:

```markdown
| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `LOG_LEVEL` | `info` | Set `debug` for verbose logs |
```

If a value is required, say so and give an example; if it has a default, print it. Nothing wastes more time than a config section that lists names without saying what happens when you leave them blank.

## An architecture sketch, not an architecture diagram

You do not need a full C4 diagram — just orient a stranger in ten seconds. Prose with arrows is often enough ("web handles HTTP, pushes jobs to the queue, the worker drains it into Postgres"); a box-and-arrow sketch earns its place past four parts. Point to `docs/` for detail; the sketch is a map to the code, not an inventory of it.

## Gotchas: write down the sharp edges

The most valuable lines in a README usually tell you where it breaks: known limitations, non-obvious footguns, "not production-ready for X". Each one is a bug report you never have to receive. Writing them down is not admitting weakness; it is the difference between a reader who trusts the document and one who finds the sharp edge in production at 2am.

## What to leave out

Cut these by default:

- **Badges nobody clicks.** Build status, coverage, "made with love" — noise that pushes the command down. Keep one a contributor would act on; delete the rest.
- **Screenshots of code.** A terminal screenshot is unsearchable, un-copyable, and stale the next day. Paste the text.
- **A wall of features.** A README is not a landing page. Ten bullets of capability are ten chances to lose the reader before the quickstart.
- **A full API reference.** That belongs in generated docs; link to it, do not inline it.
- **"Coming soon."** It sets an expectation with no delivery date. Either it exists or it does not.

## Write for your future self

The hardest reader is you, six months from now, on a new machine, having forgotten everything — and that person has only the file in front of them. This is why the fresh-clone test matters even for solo projects: you will be the one cloning it at midnight after a disk failure. The README is the cheapest **onboarding** you will ever ship. It is a close cousin of version-control hygiene — [git habits for a solo developer](/posts/git-for-solo-developers/) and a good README share one instinct: leave the next version of you enough breadcrumbs to get back to working code.

## A copyable README template

Start here and delete whatever does not apply. Resist adding sections.

```markdown
# project-name

One sentence: what it is and who it is for.

Two or three lines on why it exists — the problem it solves and what it replaces.

## Quickstart

Requirements: Docker 24+, or Python 3.11+ with a Postgres 15 URL.

    git clone https://github.com/acme/project.git
    cd project
    cp .env.example .env
    docker compose up --build

Open http://localhost:8080 — you should see the login page.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `LOG_LEVEL` | `info` | Set `debug` for verbose logs |

## Architecture

Three processes: `web` (HTTP), `worker` (queue), `db` (Postgres).
Data flows web → queue → worker → db. Details in `docs/architecture.md`.

## Gotchas

- Migrations run on startup; do not run two instances against one database.
- The `send-email` job is not idempotent — retries can double-send.

## License

MIT — see `LICENSE`.
```

Copy it, fill it in, then do the one thing that makes it real: open a fresh terminal, clone your own repo, and follow your quickstart until it runs. **Project documentation** is not a chore you finish once. It is the interface between your project and everyone who will ever touch it, including you — and a README that takes someone from "what is this" to "it works" in one screenful has done most of the work that **developer experience** gets credit for.
