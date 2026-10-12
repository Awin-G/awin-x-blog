---
title: "Feature flags for a solo developer: feature toggles without a SaaS"
description: "Feature flags let you decouple deploy from release, add a kill switch, and do progressive rollout — without buying LaunchDarkly. A minimal self-hosted design: one config file, an env override, per-request evaluation, fail-closed defaults, and a lifecycle that deletes expired flags before they turn into technical debt."
pubDate: 2026-11-29
lang: en
translationKey: feature-flags
tags: [devops, self-hosting]
featured: false
keywords:
  - feature flags
  - feature toggles
  - kill switch
  - progressive rollout
  - deploy vs release
---

**Feature flags** are the cheapest way to separate *deploying* code from *releasing* a
behavior, and you do not need a SaaS to get them. I run my flags out of a single
config file that ships with the app, plus one environment variable for emergencies.
That is enough for a kill switch, a progressive rollout, and an A/B test — and it is
small enough that I actually remove the flags when they are done. The hard part of
feature flags was never the evaluate-a-boolean part. It is the lifecycle around them,
and that is exactly where a heavyweight vendor will not save you.

## What feature flags are for — and what they become

The reason to have a flag is **deploy vs release**. Deploying is putting bytes on the
server; releasing is changing what users see. Coupling the two means every release is
a deploy and every deploy is a risk. A flag breaks the link: ship the code dark, then
flip it on when you are ready.

Four jobs a flag does well:

- **Remove the deploy from the decision to ship.** Merge the new editor, keep it off,
  turn it on Tuesday at 10am when you are awake to watch it.
- **Kill switch.** One boolean that turns a subsystem off under load, behind a config
  change instead of a rollback. This is the only genuinely long-lived flag type.
- **Progressive rollout.** Give it to 1% of users, then 10%, then 50%, then everyone —
  and stop early if the error rate moves.
- **A/B test.** Two variants, a metric, and a decision at the end.

Now the failure mode, which is more common than all four uses combined: flags that
are never deleted. A release flag that stays on for a year becomes a permanent `if`
in the code. Multiply it by a `&&` for each flag and you get **if spaghetti** — code
whose real behavior is a matrix of states nobody can hold in their head. The zombie
flags are worse than absent ones: they are untested in the "off" path, and one day
someone flips a switch that no longer does anything. Every flag is born as a tool and
dies as **technical debt** unless you plan for its removal on day one.

## Four kinds of feature toggles: release, kill switch, experiment, permission

The single most useful habit is to label each flag with its type, because the type
tells you how long it should live.

| Type | Lives | Default when missing | Remove when |
| --- | --- | --- | --- |
| Release | days–weeks | off | the feature is the only path |
| Ops / kill switch | forever (by design) | on (fail open for ops) | the subsystem is gone |
| Experiment | until the result | off | the A/B test is decided |
| Permission | months | off | it becomes a real entitlement system |

The lifetime column is the point. A release toggle that is not deleted is a bug in
waiting; a permission toggle that lives forever is fine *if* it is modeled properly.
Mixing the two in one undifferentiated pile of booleans is how you end up unable to
delete anything.

## A minimal self-hosted design: config file, env override, per-request evaluation

The design I use has three rules:

1. **Flags are data, not code.** They live in a file — committed to the repo for
   defaults, mounted on the server for live values. Changing a flag is changing data,
   which is why it needs no deploy.
2. **One source of truth, one override.** The file is the truth; a single environment
   variable per flag exists only so I can force a value from the shell during an
   incident without editing anything.
3. **Evaluate per request, in memory.** The file is parsed once and hot-reloaded on
   change. A flag lookup never makes a network call in the hot path.

Here is the entire system as a config file:

```yaml
# flags.yaml — the whole "feature flag service"
version: 1
flags:
  new_editor:                 # release: short-lived
    type: release
    enabled: true
    rollout: 25               # percent of subjects
    default: false            # what callers get if it's missing
    owner: deepseek
    created: 2026-11-01
    remove_by: 2026-12-15     # CI fails after this date

  checkouts_paused:           # ops / kill switch
    type: ops
    enabled: false            # off = normal path
    default: false

  recommendations_v2:         # experiment: needs a decision
    type: experiment
    enabled: true
    rollout: 50
    default: false

  team_sso:                   # permission: allow-list
    type: permission
    enabled: true
    allow: [team-alpha, team-beta]
    default: false
```

The `remove_by` field is not decoration — a small CI check reads it and fails the
build once the date passes. That is the only thing I have found that reliably kills
a flag instead of letting it age into a load-bearing `if`.

## Defaulting safely: fail closed and type your flags

Two rules keep a homemade flag system from becoming an outage source.

**Fail closed.** If the config file is missing, corrupt, or the flag name is unknown,
the answer is "off" — never an exception in the request path, never an accidental
"on". Feature flags should be able to disappear and take the system back to its
previous behavior. The one exception is ops flags, where you decide deliberately
whether failing open is safer; for most kill switches, *release the brakes* is the
right default only when the feature is genuinely optional.

**Type the lookup.** Give every call site an explicit default instead of relying on
whatever the config happens to say. A missing flag with a typed default is a
compile-time-ish promise; a missing flag that throws is a 3am page.

```python
import hashlib, json, os

_config: dict = {}

def load(path: str = "flags.json") -> None:
    global _config
    try:
        with open(path) as f:
            _config = json.load(f).get("flags", {})
    except (OSError, ValueError):
        _config = {}          # fail closed: no readable file => every flag off

def enabled(name: str, subject: str = "", default: bool = False) -> bool:
    # explicit caller default, not whatever the file says
    flag = _config.get(name)
    if flag is None:
        return default
    # emergency override from the shell: FLAG_NEW_EDITOR=1
    if os.environ.get(f"FLAG_{name.upper()}") in ("1", "true"):
        return True
    if not flag.get("enabled", False):
        return False
    if "allow" in flag:                       # permission flag
        return subject in flag["allow"]
    pct = flag.get("rollout")
    if pct is None:
        return True                           # fully on
    # stable bucketing: the same subject always lands in the same bucket
    h = hashlib.sha1(f"{name}:{subject}".encode()).hexdigest()
    return int(h[:8], 16) % 100 < pct
```

Two details carry the weight. **Stable bucketing** — hashing `name:subject` — means a
user in the 25% group stays in it on the next request, so the rollout is a cohort and
not a coin flip. And **the caller's default** means a flag that has been deleted from
the file degrades to the safe behavior instead of crashing.

## The lifecycle: create → progressive rollout → remove

Every flag has a birth and a death. Skipping the death is the whole disease.

<figure>
<svg viewBox="0 0 700 150" width="100%" role="img" aria-label="A feature flag lifecycle: create with a removal date, progressive rollout from one percent to fifty percent, full enablement, then deletion of the flag and its dead code branch.">
  <defs>
    <marker id="ff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="10" y="46" width="138" height="60" rx="9"/>
    <rect x="186" y="46" width="138" height="60" rx="9"/>
    <rect x="362" y="46" width="138" height="60" rx="9"/>
    <rect x="538" y="46" width="138" height="60" rx="9" stroke-dasharray="5 4"/>
    <path d="M148 76 H186" marker-end="url(#ff-arrow)"/>
    <path d="M324 76 H362" marker-end="url(#ff-arrow)"/>
    <path d="M500 76 H538" marker-end="url(#ff-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
    <text x="79" y="70">create</text>
    <text x="79" y="88" font-size="11" opacity="0.75">type + default</text>
    <text x="79" y="102" font-size="11" opacity="0.75">+ remove_by</text>
    <text x="255" y="70">roll out</text>
    <text x="255" y="88" font-size="11" opacity="0.75">1% → 10% → 50%</text>
    <text x="431" y="70">100%</text>
    <text x="431" y="88" font-size="11" opacity="0.75">the flag is now</text>
    <text x="431" y="102" font-size="11" opacity="0.75">the only path</text>
    <text x="607" y="70">remove</text>
    <text x="607" y="88" font-size="11" opacity="0.75">delete flag</text>
    <text x="607" y="102" font-size="11" opacity="0.75">+ dead branch</text>
  </g>
  <text x="350" y="134" fill="currentColor" font-family="system-ui, sans-serif" font-size="11" text-anchor="middle" opacity="0.75">an expired flag is a bug, not a leftover</text>
</svg>
<figcaption>The lifecycle is the feature. A flag without a scheduled removal is a permanent branch you will test forever.</figcaption>
</figure>

In practice the steps look like this:

1. **Create.** Add the config row with a type, an owner, a safe `default`, and a
   `remove_by` date. Commit the code behind `if enabled("new_editor", user.id)`.
2. **Roll out.** Flip `rollout` up over days, watching errors and latency. If
   something is wrong, set it to `0` — that is the kill switch, and it takes seconds
   because there is no deploy involved. If the whole feature is broken, `enabled:
   false` is the rollback.
3. **Remove.** When the rollout hits 100% and the old path is dead code, delete the
   flag from the config *and* delete the branch it guarded, in one commit. Retire the
   code, not just the switch.

The reason to enforce step 3 mechanically is that humans are bad at it. A flag left in
place has two behaviors, so both need tests; four flags need sixteen. The math is
exponential and the only constant-time fix is deletion. This is why I treat an expired
flag the same way I treat a failing test: the build stops until it is gone.

If you take nothing else from this post: **schedule the removal when you create the
flag**, and let CI be the one that remembers.

## When a flag is the wrong tool

Flags are seductive, so it is worth naming where they are the wrong answer:

- **When it is really user config.** If a human is meant to choose a theme or toggle
  a preference, that is a settings table, not a feature flag. Flags are for *you* to
  control, and they are temporary; settings are for *them* and are permanent.
- **When it is a long-term entitlement.** Per-plan limits, roles, and quotas belong in
  an entitlements or permissions model, not a growing allow-list of flag names. A flag
  system that has become your authorization layer cannot be deleted, ever.
- **When it hides a broken deploy.** If you cannot ship safely without a flag guarding
  the change, the deploy path is the bug. Fix that — [atomic symlink and blue-green
  deploys](/posts/zero-downtime-deploys/) solve the mechanics so a flag is not carrying
  them.
- **For schema changes.** Database migrations need a forward/backward-compatible plan,
  not a boolean. You cannot flag away a column that no longer exists.
- **When you will never remove it and the branches are cheap anyway.** One boolean in
  a five-line function is a reasonable constant. Fifty is not.

Feature flags are a small tool with a small contract: decouple deploy from release,
give yourself a kill switch and a progressive rollout, and then clean up. The
self-hosting part is almost an afterthought — one file, one hash, one env override —
which is exactly what makes it survivable. It fits the same philosophy as the rest of
[what I self-host in 2026](/posts/what-i-self-host-2026/): the boring local version
you fully understand beats the hosted one you rent and forget.

Write the flag, date its death, and delete it on time. That is the entire discipline,
and it is the part no vendor can do for you.
