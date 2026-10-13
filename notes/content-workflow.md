# Content workflow

A repeatable loop for producing posts at volume without letting quality or the
build break.

## Model

Drafting subagents run on the free models (per the operator), rotating among
**`opencode-go/longcat-2.5-preview-free`**, **`opencode-go/step-5-preview-free`**
and similar `*-free` ids. Do **not** use the host `ollama` service for
experiments; use Docker containers (with small models only when genuinely
needed) or plain tooling.

## The loop

0. **Check what already exists first.** Rebuild the index and query it for every
   candidate topic before briefing anyone:
   ```bash
   npm run index                                   # notes/content-index.{json,md}
   npm run find -- "your proposed title/keywords"  # closest existing posts + score
   npm run dupes                                   # redundancy already in the corpus
   ```
   Drop or reframe any candidate scoring **≥ ~55%** against an existing post (that
   is a near-duplicate). The content gate hard-fails at **≥ 78%** and warns at **≥ 68%**.
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

## Dedup & related links (the corpus is large now)

`scripts/content-index.mjs` (npm: `index` / `find` / `dupes`) builds
`notes/content-index.{json,md}` and answers "what already exists like this?".
Use it twice per batch: **before** (drop duplicates and harvest 2–4 *real*
related posts per topic) and **after** (rebuild the index so the next batch sees
the new posts). Always hand the subagent the exact related slugs it must link
to — never let it invent link targets, and never let it write a post that
restates an existing one.

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
> **Internal links (must resolve):** EN → `<path>`, `<path>`; ZH → same under
> `/zh/`. These come from `npm run find -- "<topic>"` — pick the closest *real*
> existing posts; never invent slugs. Add 1–2 of them inline in the body where
> they genuinely help the reader.
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
>   repo, `curl` against a local test server);
> - **use Docker freely** — it works here without sudo. Spin up real services in
>   throwaway containers to reproduce results (Postgres, Redis, nginx, a DNS
>   server, …). Keep volumes under the scratch dir, prefer `--rm`, publish only
>   to `127.0.0.1` ports, and remove containers/images when done. This is the
>   best way to get genuinely reproducible output.
>   **Prefer official / well-known images.** If the official image isn't
>   available, do not run an untrusted repackaged image — either use a reputable
>   mirror or describe the behaviour instead of demonstrating it.
>
> Hard limits: **no `sudo`, no host system package installs, no `--privileged`,
> no network scans or anything against third parties, nothing destructive, write
> only inside the scratch dir**, and touch no repo files except your two output
> files.
>
> **Integrity rule (non-negotiable):** every command/output block must be
> *actually run*. If you cannot run it here, **do not present fabricated output
> as real** — either label it explicitly inside the article (e.g. "illustrative,
> not a verbatim run") or omit it. Never invent ports, timings, or error text.
> A background process being killed is a solvable problem: build binaries and
> run the server + client in one shell session so they stay alive.
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
