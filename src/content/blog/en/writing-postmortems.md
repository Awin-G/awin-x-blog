---
title: "Writing a postmortem that actually changes something"
description: "Most postmortems are theatre: a timeline nobody rereads, a conclusion of 'human error', and action items that quietly expire. Here is the structure I use now — impact, detection, contributing factors, blamelessness, and action items that are few, owned and verifiable, with a template to steal."
pubDate: 2026-11-26
lang: en
translationKey: writing-postmortems
tags: [devops]
featured: false
keywords:
  - postmortem
  - incident review
  - blameless postmortem
  - root cause analysis
  - action items
---

I have written postmortems that changed nothing. I spent an afternoon on a
careful document, we held the review, everyone nodded, and six weeks later the
same class of failure took us down again — because not one line of that document
had turned into a change in the system. The postmortem was a ritual we performed
to feel responsible, not a mechanism that made us safer. This is what I do
differently now: a **postmortem** and **incident review** process aimed at one
outcome, which is a different system after the meeting than before it.

## Why most postmortems are theatre

A postmortem is theatre when it satisfies the social need — someone "owns" it,
we "learned lessons" — without touching the artifact that failed. Three patterns
give it away.

**A timeline nobody reads.** Reconstructed to the minute, with twelve
timestamps and a colour-coded incident channel transcript, and then never
opened again. A **timeline** is valuable when it answers a question: how long
until we *detected* it? How long until we *understood* it? How long until we
*fixed* it? A timeline copied from chat logs answers none of these; it just
proves we were busy.

**"Human error" as the conclusion.** "The engineer ran the wrong command" is
not a root cause, it is the place where analysis stopped. It ends the inquiry
before it begins, and it quietly converts a systems problem into a personnel
problem. Worse, it teaches everyone else to write defensive postmortems that
omit the interesting detail.

**Action items that never happen.** Eight action items, none assigned to a
named person, none with a date, two of them "add a runbook," and all of them
already stale by the next sprint. An action item without a name and a date is a
wish.

The tell for all three is the same: the postmortem's output is a document. If
the output is a document, the document is the deliverable, and any document can
be produced regardless of whether the system got better.

## The incident review structure I use now

I write every review in the same shape, because the shape enforces honesty. It
is roughly the order I'd ask questions if I were interrogating the incident
rather than performing for an audience.

**1. Impact — who and what, in user terms.** Not "the deploy failed," but
"checkout returned 500 for 14 minutes; roughly 2,300 requests failed and no
orders were lost because the queue held them." Impact first is a discipline: it
anchors the whole document in reality and it forces a magnitude estimate, which
is often the most useful number in the file.

**2. Detection — how we found out, and how long that took.** This is where the
cheapest wins usually live. Did a user tweet it? Did an alert fire? Did we
notice from a graph three days later? If detection is slow, fixing the trigger
without fixing detection just means the next incident is quieter. Mapping that
gap is exactly the job of [monitoring a small fleet](/posts/monitoring-a-small-fleet/)
— the alert that would have caught it ten minutes in instead of forty.

**3. Timeline — but keyed to those three questions.** I keep it short: last
known good, first bad symptom, first detection, first correct hypothesis, full
recovery. Five or six lines, not a transcript.

**4. Contributing factors — plural, always.** Not one cause. The reason this
matters is the next section.

**5. What went well.** Nobody remembers to write this, and it is the part that
keeps the process socially survivable. "The rollback worked in 90 seconds." "The
APIs we deployed behind a dark launch meant nobody noticed." Write it down, or
the next incident review becomes an exercise in blame avoidance.

**6. What we'll change — with owners and dates.** Small, real, tracked. I cover
how below.

## A blameless postmortem is not an excuse-free zone

Blameless gets misunderstood in both directions. It does **not** mean "nobody is
responsible"; it means we refuse to stop the analysis at a person. The question
"why did a reasonable, competent engineer, with the information they had at that
moment, do the thing that turned out to be wrong?" is more uncomfortable than
"who screwed up?" — because its honest answer is usually "because our tools,
docs, or defaults *suggested* that action."

But I've also watched blamelessness get weaponised into "the system made me do
it," where no one is ever accountable and nothing changes. That is not
blamelessness; that's abdication. The distinction I hold onto: **blame asks who
to punish; accountability asks who will fix what.** Blamelessness removes the
first and *requires* the second. You can be completely blameless about how the
incident started and still be personally on the hook for the action item that
stops it happening again. No excuses, no scapegoats.

One practical test: if every name were redacted from the postmortem, would the
document still explain why this was a reasonable-looking action? If yes, you've
described a system. If no, you've described a person — go deeper.

## Trigger, not root cause: doing root cause analysis honestly

The single most useful reframe I've adopted: separate the **trigger** from the
**root cause**.

- The **trigger** is the thing that happened immediately before impact. "The
  database connection pool ran out." "A bad deploy went out." "A disk filled."
- The **root cause** is, in the systems sense, an *absence* — the missing
  guardrail, default, check, or piece of knowledge that let the trigger produce
  impact at all.

The trigger is what you'll be tempted to write down. It's satisfying, it's
concrete, and it's almost always a symptom. "Connection pool exhausted because
we didn't cap concurrency in the new worker" — the trigger is the pool, the root
cause is that nothing forced the new worker to declare a concurrency budget
before it could ship. Only the second one generalises.

This is the honest version of **root cause analysis**: not a single culprit
chased back to its laziest cause, but a set of contributing factors, each of
which is a small, fixable change. You don't need one; you need the two or three
that, if absent, would have broken the chain.

<figure>
<svg viewBox="0 0 640 190" width="100%" role="img" aria-label="A diagram showing a trigger on the left feeding through three contributing factors (weak defaults, invisible state, slow detection) before reaching impact on the right, with a note that root causes are the missing guardrails, not the trigger.">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.6">
    <rect x="12" y="72" width="120" height="56" rx="8"/>
    <rect x="196" y="26" width="180" height="34" rx="8"/>
    <rect x="196" y="82" width="180" height="34" rx="8"/>
    <rect x="196" y="138" width="180" height="34" rx="8"/>
    <rect x="470" y="72" width="150" height="56" rx="8"/>
    <path d="M132 100 h60" marker-end="url(#arrow)"/>
    <path d="M376 100 h90" marker-end="url(#arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="72" y="94">trigger</text>
    <text x="72" y="112" opacity="0.75">"pool exhausted"</text>
    <text x="286" y="47">weak default</text>
    <text x="286" y="103">invisible state</text>
    <text x="286" y="159">slow detection</text>
    <text x="545" y="94">impact</text>
    <text x="545" y="112" opacity="0.75">users affected</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12" text-anchor="middle" opacity="0.85">
    <text x="286" y="188">contributing factors: the fixable middle</text>
  </g>
</svg>
<figcaption>The trigger is one input. The root causes are the guardrails missing in the middle — and those are what you can actually change.</figcaption>
</figure>

## Making action items real: few, owned, verified

This is where a postmortem becomes a mechanism instead of a mood. Four filters
on every action item:

- **Few.** Three is a generous incident review; eight guarantees none ship. If
  you can only do three, pick the three whose absence would have broken the
  chain above.
- **Owned.** A named human, not a team. "The platform team" is how things don't
  happen.
- **Tracked.** A ticket in the same tracker as everything else, so it competes
  for attention honestly — not a bullet buried in a wiki page.
- **Verifiable.** You can name the test that would have caught the incident and
  *would fail before the fix and pass after*. If the fix can't be expressed that
  way, it's too vague to be real.

Here's the worked example I use when teaching this.

**Bad action item:**

> - Improve monitoring around the connection pool.

**Good action item:**

> - *Owner: Priya. Due: 2026-12-10. Done when:* the worker's deploy pipeline
>   fails if it declares a concurrency limit above the pool size, and a
>   Prometheus alert fires when pool utilization exceeds 85% for 2 minutes.

The bad one has no owner, no date, no test, and no observable end state. The
good one names a person, a deadline, and a condition that is either true or not
— it cannot be "mostly done." Notice the good item is also two changes to
*prevent* and *detect*, which is usually the right split: fail the deploy, and
alert early.

The same discipline applies to deploys, where I've seen a surprising share of
incidents originate. [Zero-downtime deploys](/posts/zero-downtime-deploys/) are
not just a throughput win; they're damage control, because when a bad release is
cheap to reverse, the postmortem's timeline ("recovery in 90 seconds") is short
by construction.

## A postmortem template you can steal

Copy this. Delete the sections you don't need, but don't add many.

```markdown
# Postmortem — <incident title> — <YYYY-MM-DD>

- **Severity:** <SEV-1/2/3>  **Duration:** <start–end, wall clock>
- **Author:** <name>  **Review held:** <date>  **Attendees:** <names>

## Impact
Who was affected, how, and for how long. In user terms. Magnitude estimate
(users, requests, revenue, orders). What was *not* affected.

## Detection
How we found out (alert / user report / graph). Time from first bad symptom
to detection. Time from detection to first correct hypothesis.

## Timeline (5–8 lines, no transcript)
- Last known good:
- First bad symptom:
- Detected:
- Correct hypothesis:
- Full recovery:

## Contributing factors
For each: what was missing (guardrail, default, doc, test), not who.

## What went well
Rollbacks, dark launches, someone's good call at 2am. Yes, write this.

## Action items
| Action | Owner | Due | Done when (verifiable) |
| --- | --- | --- | --- |
| | | | |

## Follow-up
Where these are tracked. Review date to confirm they landed.
```

## What I'd tell my past self

Two things. First, write it while the incident is fresh and let it be ugly —
a rough postmortem on Tuesday beats a polished one on Friday. Second, judge the
process by the diff, not the doc. Six weeks later, open the action items and
check: did they land, and did a later incident get caught earlier? If the answer
is no, the postmortem was theatre, however well written.

The document was never the point. The system after the meeting is.
