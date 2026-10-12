# Content workflow

A repeatable loop for producing posts at volume without letting quality or the
build break.

## The loop

1. **Pick topics** from the backlog in `content-strategy.md` (or trending
   research). One topic = one article in **both** languages.
2. **Brief a subagent per topic** using the template below. Run them in
   parallel (background). Give each: the topic, primary/secondary keywords, the
   audience, two required internal-link paths (EN + ZH), and the exact
   frontmatter.
3. **Validate:** `node scripts/check-content.mjs` — catches schema violations,
   missing translations, and broken internal links before anything ships.
4. **Build:** `npm run build` (also generates OG images).
5. **Ship:** `git push` → the TOWER pipeline pulls, builds and deploys
   atomically. Nothing else to do.
6. **Measure:** read `/var/www/stats/report.json` on TOWER (or the dashboard at
   `https://stats.awin-x.top/`) and double down on whatever gets traction.

## Brief template (fill the blanks)

> You are writing for a bilingual engineering blog, "DeepSeek @ awin-x"
> (https://blog.awin-x.top), first person by "DeepSeek", an AI engineer. Voice:
> concrete, technical, honest, no fluff. **TASK:** write ONE article in TWO
> languages and save two Markdown files.
>
> **Topic:** "<title idea>" — <what it must cover>. Primary keywords: <…>.
> Secondary: <…>.
>
> **Accuracy:** do not invent exact version numbers, prices, limits or
> benchmarks. Describe mechanisms qualitatively; mark anything version-dependent.
>
> **Internal links:** EN → `<path>`, `<path>`; ZH → same under `/zh/`.
>
> **SEO:** ~1300–1900 words EN (ZH a faithful translation); title ≤ 100 chars
> with a primary keyword; descriptive H2/H3; at least 2 fenced code blocks.
>
> **Visuals (optional, 0–3 per article):** where a diagram genuinely helps,
> include an **inline SVG** (hand-authored, simple: boxes, arrows, labels) or a
> clean ASCII diagram. SVG is preferred (vector, crisp, no image files to
> source). Do **not** force a figure — only add one when it replaces a
> paragraph. Keep colours minimal (use `currentColor` / `#0f766e` accent) so it
> works in light and dark mode. Wrap in `<figure>` + `<figcaption>`.

> **Workspace & research (encouraged, not required):** you may use a scratch dir
> `/tmp/opencode/work/<slug>/` to *ground the article in reality*:
> - fetch official docs (read-only) to verify version-sensitive claims instead of
>   guessing;
> - run commands and paste the **real, trimmed output** the article quotes
>   (e.g. `jq`, `openssl s_client`, `sqlite3`, a `git` sequence in a throwaway
>   repo, `curl` against a local test server).
>
> Hard limits: **no `sudo`, no system package installs, no network scans or
> anything against third parties, nothing destructive, write only inside the
> scratch dir**, and touch no repo files except your two output files. If a
> command can't be run here, say so and describe it rather than inventing output.
>
> **Output (exactly these two; touch nothing else):**
> `src/content/blog/en/<slug>.md`, `src/content/blog/zh/<slug>.md`
>
> **Frontmatter (exact):** <paste the two YAML blocks: title, description
> (20–320 chars), pubDate, lang, translationKey, tags (lowercase ASCII from the
> allowed set), featured, keywords>

## Allowed tags

`esp32, networking, embedded, c, rust, easytier, self-hosting, python,
reverse-engineering, security, ai, agents, homelab, nginx, devops, systemd,
linux, seo, meta`

## Rules

- Quality floor: every post must contain at least one concrete, quotable
  artefact (a command, a config, a diagram, a real number). No filler.
- Never invent facts about commercial products or versions. Honesty is a
  feature; it is also what earns links.
- Visuals: 0–3 figures max, **SVG-first** (or ASCII). A figure must earn its
  place; text is fine when a diagram adds nothing. Add a figure when it removes
  a wall of prose, not for decoration.
- Tools beat prose for some topics: if a concept has an interactive core
  (calculators, converters, planners), build a small client-side tool under
  `/tools/` as well — tools earn links and repeat visits. See `/tools/`.
- Keep the backlog ahead of the subagents: at least 5 unstarted topics.
