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
- Keep the backlog ahead of the subagents: at least 5 unstarted topics.
