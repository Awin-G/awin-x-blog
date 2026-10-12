---
title: "Time, timezones, and UTC: how to stop getting it wrong"
description: "Timezones, UTC, and the bugs between them: why you store UTC and convert at the edges, the difference between an instant, a local date-time, and a duration, why the wall clock is not monotonic, DST gaps and ambiguity, the tz database, cron across DST, and Python/JS traps — with a checklist."
pubDate: 2026-11-21
lang: en
translationKey: time-and-timezones
tags: [linux, devops]
featured: false
keywords:
  - timezones
  - store UTC
  - DST bugs
  - monotonic clock
  - tz database
---

Every bug I have shipped that involved **timezones** traced back to the same
root cause: a timestamp that meant two things at once. The fix is not a clever
library. It is a discipline — **store UTC** (or another absolute instant) and
convert only at the edges. Do that and most **DST bugs** never get written in
the first place, and you learn the one job where the wall clock is the wrong
tool and a **monotonic clock** is the right one.

## The three things people call "the time"

Before any code, separate three ideas that get flattened into one:

| Thing | Example | What it is for |
| --- | --- | --- |
| **Instant** | `2026-11-21T15:00:00Z` | a point on the global timeline; storage, ordering, comparison |
| **Local date-time** | `2026-11-21 10:00 America/New_York` | what a human's clock shows; needs a zone to mean anything |
| **Duration** | `90m`, `P1D` | an amount of elapsed time; arithmetic, timeouts |

The instant is the thing that actually happened. The local date-time is a
*projection* of it, and that projection depends on where you stand and on laws a
government can change. A duration is not a point at all. The mistake is treating
any of the three as interchangeable: a meeting at `2026-11-21 10:00` with no zone
is not a time, it is a riddle.

<figure>
<svg viewBox="0 0 640 240" width="100%" role="img" aria-label="Two timelines. The top shows evenly spaced absolute instants labelled in UTC. The bottom shows the same instants as a local wall clock, where spring-forward skips the 02:00 hour, so one real hour becomes two clock hours.">
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12">
    <text x="20" y="28" opacity="0.85">absolute instants (UTC)</text>
    <line x1="60" y1="80" x2="580" y2="80" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
    <g stroke="currentColor" stroke-width="1.5" opacity="0.55">
      <line x1="60" y1="74" x2="60" y2="86"/>
      <line x1="190" y1="74" x2="190" y2="86"/>
      <line x1="320" y1="74" x2="320" y2="86"/>
      <line x1="450" y1="74" x2="450" y2="86"/>
      <line x1="580" y1="74" x2="580" y2="86"/>
    </g>
    <g text-anchor="middle" opacity="0.95">
      <text x="60" y="66">00:00</text>
      <text x="190" y="66">01:00</text>
      <text x="320" y="66">02:00</text>
      <text x="450" y="66">03:00</text>
      <text x="580" y="66">04:00</text>
    </g>
    <g stroke="currentColor" stroke-width="1" stroke-dasharray="3 4" opacity="0.35">
      <line x1="60" y1="90" x2="60" y2="180"/>
      <line x1="190" y1="90" x2="190" y2="180"/>
      <line x1="320" y1="90" x2="320" y2="180"/>
      <line x1="450" y1="90" x2="450" y2="180"/>
      <line x1="580" y1="90" x2="580" y2="180"/>
    </g>
    <text x="20" y="160" opacity="0.85">local wall clock (spring-forward day)</text>
    <line x1="60" y1="200" x2="580" y2="200" stroke="currentColor" stroke-width="1.5" opacity="0.55"/>
    <g stroke="currentColor" stroke-width="1.5" opacity="0.55">
      <line x1="60" y1="194" x2="60" y2="206"/>
      <line x1="190" y1="194" x2="190" y2="206"/>
      <line x1="320" y1="194" x2="320" y2="206"/>
      <line x1="450" y1="194" x2="450" y2="206"/>
      <line x1="580" y1="194" x2="580" y2="206"/>
    </g>
    <g text-anchor="middle" opacity="0.95">
      <text x="60" y="224">01:00</text>
      <text x="190" y="224">03:00</text>
      <text x="320" y="224">04:00</text>
      <text x="450" y="224">05:00</text>
      <text x="580" y="224">06:00</text>
    </g>
    <path d="M60 184 H190" stroke="currentColor" stroke-width="2" opacity="0.9"/>
    <text x="125" y="176" text-anchor="middle" font-size="11" opacity="0.9">1 real hour = 2 clock hours</text>
    <text x="125" y="188" text-anchor="middle" font-size="11" opacity="0.9">02:00 is skipped</text>
  </g>
</svg>
<figcaption>Instants tick forward evenly; the local wall clock can jump. Store the
top row, render the bottom one.</figcaption>
</figure>

## Store UTC, convert at the edges

The rule: **persist and transmit instants, convert for humans at the boundary.**

- **Database:** store an instant. In Postgres that is `timestamptz` (really "a
  UTC instant"), never a zone-less `timestamp`. In SQLite or MySQL, store UTC or
  an integer epoch.
- **Wire format:** ISO 8601 with an explicit offset (`...Z` or `+02:00`), or
  epoch seconds. Never a bare `2026-11-21 10:00`.
- **Logs:** UTC, always. It makes [structured logging](/posts/structured-logging/)
  queries line up across machines in different regions.
- **Input:** parse whatever the user gave you — including a zone — and normalize
  to an instant immediately.
- **Output:** convert to the reader's zone at the last possible moment.

Treat this like money. You would never store a price as "12.99 in whatever
currency the reader assumes." Time is the same: store the absolute amount,
format at the edges.

```python
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# An instant. This is what you store, log, and send.
now = datetime.now(timezone.utc)          # 2026-11-21 15:00:00+00:00
db_value = now.isoformat()                # "2026-11-21T15:00:00.123456+00:00"

# Convert only when showing it to someone.
ny = now.astimezone(ZoneInfo("America/New_York"))
print(ny.strftime("%Y-%m-%d %H:%M %Z"))   # 2026-11-21 10:00 EST
```

One line going in, one line coming out, an instant in the middle. That is the
whole idea.

## Why wall-clock time is not monotonic (and when to use a monotonic clock)

`datetime.now()` and `time.time()` read the **wall clock**: what a human would
see on the wall. It is correct for naming an instant, and the *wrong* tool for
measuring elapsed time, because it is not **monotonic** — it can jump.

It jumps backward or forward when:

- **NTP** steps the clock. A first sync or a manual `ntpdate` can move time by
  seconds at once. (Normally NTP slews, but a step still happens.)
- A **DST transition** occurs, on systems that keep local time in the hardware
  clock or apply the offset to `time.time()`.
- An operator or a hypervisor sets the clock by hand.

Measure a 500 ms request across a backward step and your code reports a negative
duration, or a timeout fires early. Anything that measures *how long* — latency,
timeouts, retry backoff, rate limiters, "has this lease expired" — must use a
**monotonic clock**: one that only ever moves forward.

```python
import time

# WRONG for elapsed time: the wall clock can step.
t0 = time.time()
do_work()
elapsed_wall = time.time() - t0     # can be negative!

# RIGHT: a monotonic clock never goes backward.
t0 = time.monotonic()
do_work()
elapsed = time.monotonic() - t0     # safe for latency, timeouts, backoff
```

What each language gives you: Python `time.monotonic()` (and
`time.perf_counter()` for the highest resolution); Go `time.Since()` and
`time.Now()` carry a monotonic reading automatically; Node and browsers have
`performance.now()`. The catch: a monotonic clock has no relationship to
calendar dates — you cannot store it, only compare it within one process's
lifetime. So: wall clock for *when*, monotonic for *how long*.

## DST bugs: spring-forward gaps and fall-back ambiguity

This is where the abstractions earn their keep. In a zone that observes DST, two
local times a year are pathological.

**Spring forward — the gap.** Clocks jump from 02:00 to 03:00, so 02:30 *does
not exist* locally:

```python
from datetime import datetime
from zoneinfo import ZoneInfo

ny = ZoneInfo("America/New_York")

# 2026-03-08 is spring-forward in the US: 02:00 -> 03:00.
gap = datetime(2026, 3, 8, 2, 30, tzinfo=ny)
print(gap)                 # 2026-03-08 02:30:00-05:00  (silently shifted!)
print(gap.utcoffset())     # -5:00 — rounded to the pre-transition offset
```

Python's `zoneinfo` does not raise; it resolves the nonexistent time by picking
an offset — and different libraries pick *differently*. That is exactly why you
should not be asking the question. Store the instant and the gap never exists.

**Fall back — the ambiguity.** Clocks go from 02:00 back to 01:00, so 01:30
happens *twice*: once in DST, once in standard time. Which one did the user mean?

```python
# 2026-11-01 is fall-back: 02:00 -> 01:00, so 01:30 occurs twice.
ambiguous = datetime(2026, 11, 1, 1, 30, tzinfo=ny)
print(ambiguous.utcoffset())                    # -4:00 (first pass, EDT)
print(ambiguous.replace(fold=1).utcoffset())    # -5:00 (second pass, EST)
```

`fold` (PEP 495) is Python's way of saying "the second occurrence". Most code
never sets it, so most code silently picks the first. The lesson is the same
both times: **a local wall-clock time plus a zone does not always identify an
instant.** When it must — a future appointment, a market open — store the local
time *and the zone name* and resolve at the last moment, never a pre-computed
offset. Everything else: store UTC and neither bug can occur.

## The tz database: why hardcoding offsets fails

`America/New_York` is not "UTC-5". It is "UTC-5 in winter and UTC-4 in summer,
according to rules a government can change." Those rules live in the **tz
database** (IANA tzdata), text files compiled into `/usr/share/zoneinfo` on
virtually every Unix.

Hardcoding an offset fails in two ways:

1. **Twice a year.** `UTC-5` is wrong every summer; `UTC-4` is wrong every winter.
2. **Without warning.** When a country abolishes DST, changes its standard
   offset, or moves its transition dates, your `UTC-5` keeps working — and is
   now silently wrong forever. The tz database receives the update; your
   constant does not.

```bash
$ timedatectl status                        # what the box thinks "now in"
$ TZ=America/New_York date                   # render in a zone, no clock change
$ TZ=UTC date -d '2026-11-21 15:00'          # same instant, another view
$ zdump -v America/New_York | head           # transitions, straight from the db
```

The practical rule: **store zone names, not offsets.** Keep `tzdata` updated
(`apt upgrade tzdata` is not a joke — that is how a stale ruleset gets fixed),
and let the library do the projection.

## Cron and timers across DST

`cron` fires on wall-clock time, and that produces two classic bugs on transition
days:

- **Spring forward:** a job at `02:30` has no 02:30 that day, and some cron
  implementations skip it entirely.
- **Fall back:** `01:30` happens twice; some implementations fire the job twice,
  others once. If the job is not idempotent, you just ran a backup twice.

[systemd timers](/posts/systemd-timers-vs-cron/), which I prefer for anything
that matters, are specified in local time too, but systemd handles the
transitions deliberately: it skips a nonexistent time and runs an ambiguous one
once. Still, the boring advice holds:

- **Do not schedule inside the 01:00–03:00 window.** Put the job at an hour no
  DST rule touches. `03:30` is safe; `02:30` is asking for it.
- **Make the job idempotent.** Safe under a double fire is safe under every
  scheduler quirk.
- **For strict UTC scheduling**, cron accepts `CRON_TZ=UTC`.

The scheduler is a different problem from the timestamp, but the two collide
exactly here, at 02:30 on a March Sunday.

## Common language traps: naive datetime and the JS Date

**Python — naive versus aware.** A **naive datetime** has no zone; an aware one
carries a `tzinfo`. Almost every time bug is a naive value crossing a DST
boundary or being compared to an aware one.

```python
from datetime import datetime, timezone, timedelta

x = datetime.now()              # naive LOCAL time — a trap, despite the name
y = datetime.utcnow()           # naive UTC — deprecated in 3.12 for this reason
z = datetime.now(timezone.utc)  # aware. Use this.

# "+1 day" is not +24h across a DST transition — calendar math needs a zone.
datetime(2026, 3, 8, 23, 0) + timedelta(days=1)
```

Two habits: never call `datetime.now()` without an argument in server code, and
do not use `timedelta` when you mean "the same wall time tomorrow" — that is
calendar arithmetic and needs a zone-aware library.

**JavaScript — one type, two contexts.** `Date` stores a single absolute value
(milliseconds since epoch) and *also* insists on rendering in the local zone:

```js
Date.parse("2026-01-01")        // date-only  => parsed as UTC midnight
Date.parse("2026-01-01T00:00")  // date-time  => parsed as LOCAL
new Date().toISOString()        // always UTC — good for storage
new Date().getHours()           // local — fine for display, wrong for logic
```

The inconsistency between the first two lines has burned every JS developer at
least once. `Date` cannot represent "10:00 in New York" at all — only an instant
plus your machine's local view. For real work, reach for `Temporal` (now widely
available) or a library, and keep the rest of the app on `toISOString()` and
epoch internally.

## A short checklist

- **Store instants, not wall time.** UTC in the database (`timestamptz`), ISO
  8601 with an offset or epoch on the wire.
- **Convert at the edges only.** Parse with a zone on the way in; format in a
  zone on the way out.
- **Name the zone, never the offset.** `America/New_York`, not `-05:00`. Keep
  `tzdata` current.
- **Wall clock for *when*, monotonic for *how long*.** Latency, timeouts, and
  backoff use `time.monotonic()` / `performance.now()`.
- **Never mix naive and aware.** Python: `datetime.now(timezone.utc)`. JS:
  `toISOString()` internally.
- **Respect the gap and the ambiguity.** Do not schedule into 01:00–03:00 local
  on transition days; store future local times with their zone and resolve late.
- **Make scheduled jobs idempotent.** Then a double fire is a shrug, not an
  incident.
- **Log in UTC.** The only way [log lines](/posts/structured-logging/) from
  three machines sort correctly.

## The one-sentence version

An instant is a fact; a local date-time is an opinion; a duration is arithmetic.
**Store UTC**, project at the edges, measure elapsed time with a **monotonic
clock**, keep names not offsets for **timezones** — and most **DST bugs** simply
never get written.
