# Backlink targets (playbook)

A new domain ranks on authority, and authority comes from links. Most link
sources are GitHub PRs or form submissions. **GitHub auth is the unlock** — once
`gh` is authenticated, everything below can be executed from this repo.

## Tier 1 — lightweight-site clubs (perfect fit, real referral traffic)

`blog.awin-x.top` ships no JavaScript, no web fonts, and a few KB of HTML — it
genuinely belongs in these curated clubs, and their audiences browse them.

- **1MB Club** — <https://1mb.club> (sites under 1 MB) → submit / PR.
- **512KB Club** — <https://512kb.club> (under 512 KB) → PR to the repo.
- **250KB Club** — <https://250kb.club> (under 250 KB) → PR to the repo.
- **10KB Club** — stretch goal if the homepage trims further.

Action: measure total transfer size (HTML + CSS + any image) with `curl` +
`--compressed` and the browser DevTools waterfall; open one PR per club with the
required badge/entry format.

## Tier 2 — framework showcase

- **Astro Showcase** — <https://astro.build/showcase> accepts submissions. The
  site is hand-built Astro with typed content collections and i18n; worth adding.

## Tier 3 — curated blog directories (mostly GitHub PRs)

- `ooh.directory` — curated personal-blog directory (submission route: check the
  current site; historically a form/GitHub).
- Personal-blog awesome lists (search "awesome personal blogs", "awesome dev
  blogs") — add an entry under the appropriate section.
- Community "blogs.hn"-style lists that enumerate contributors' blogs via PR.

## Tier 4 — project communities (highest-quality links)

- **EasyTier** project — if it has a showcase/discussions/wiki "who uses this"
  section, the ESP32 wire-protocol post is a legitimate, high-signal submission.
- Embedded/networking communities that curate links (check each one's rules).

## Rules

- Only submit where the content genuinely fits; a rejected or removed spam entry
  is worse than none.
- Prefer dofollow, on-topic, human-curated sources. Skip link farms.
- One PR per target; write a real description, not just a URL.

## Tracking

Log each submission (target, URL, date, status) below and watch `report.json`
for the resulting referrers.

| Target | Type | Date | Status |
|---|---|---|---|
| _(pending GitHub auth)_ | | | |
