# Interactive & visual forms for the blog

**Why this exists.** The operator's verdict on the current output (260 articles: topic → real
experiment → honest conclusion, ~1500 words, one static SVG) is *unremarkable, flat, long,
boring*. The diagnosis is not "the topics are bad" or "the writing is bad" — it is that the
**form is the most copyable thing on the internet**. Anyone can generate a 1500-word
experiment write-up. Almost nobody ships a correct, dependency-free, bilingual interactive
model of the thing they are writing about. That gap is the whole opportunity.

This report is the research behind a bet: **a small number of interactive/visual forms, built
on reusable framework-free components, are the most defensible and most shareable thing this
blog can produce.** Everything below is grounded in real examples with URLs, then reduced to
what is actually buildable on a static Astro site with no server.

Date: 2026-10-15. Research by the orchestrator session. Status: proposal, not yet started.

---

## 0. Executive summary

- The best model for *this* blog is **Sam Rose (samwho.dev)**: same subject matter
  (systems/networking/memory), same "one person, no framework, no server" constraints, and he
  measured the payoff — his posts hit the HN/Lobsters front page, and in 2025 he rewrote them
  to be dependency-free and **70–95% smaller** while scoring 100 on Lighthouse. Interactive ≠
  heavy.
- The two cheapest high-leverage forms are **(1) a reusable simulator engine** (one component,
  many future posts) and **(2) a hand-built interactive diagram** (drag a handle, watch the
  picture change). Both are pure SVG/Canvas + vanilla JS and match the repo's existing
  `src/components/tools/*.astro` pattern exactly.
- The single biggest enabler found in the repo: **MDX is installed, wired into the content
  loader, and accepted by the gate — but unused.** An interactive article can ship as
  `src/content/blog/{en,zh}/<slug>.mdx` importing an Astro component, with **zero pipeline
  changes**. See §5.
- Do **not** chase Distill-style "everything is interactive" or 3D/WebGL per article. Distill
  went on indefinite hiatus in 2021 precisely because the per-article effort was
  unsustainable. The winning move is a *small* set of forms applied repeatedly.
- Three first candidates (§6): **TCP congestion control simulator**, **memory-layout /
  byte-order interactive diagram**, and **the `curl -v` request ladder as a scroll-driven
  timeline**.

---

## 1. Real examples (what works, and what imitation costs)

Ranked roughly by how directly they transfer to this blog.

### 1.1 Sam Rose — visual, interactive software essays · https://samwho.dev/

- **URLs**: https://samwho.dev/load-balancing/ · https://samwho.dev/memory-allocation/ ·
  https://samwho.dev/hashing/ · https://samwho.dev/bloom-filters/ ·
  https://samwho.dev/turing-machines/ · https://samwho.dev/big-o/ ·
  https://samwho.dev/reservoir-sampling/ · index https://samwho.dev/blog
- **What makes it work**:
  - **Bottom-up**: every post starts from the simplest possible example and builds up. The
    first simulation is usually "one load balancer, one server, one request per second".
  - **One engine per post, reused across the whole essay**: a live simulation with controls
    *below* it (play/pause, speed, parameters). The prose refers to what you just watched.
  - **Honest visuals**: the darker a server is, the slower it is; dropped requests visibly
    fall off. The picture *is* the argument.
  - **He measured the cost of interactivity and then eliminated it.** He reworked the whole
    site (late 2025): `/load-balancing` went from **1316 KiB → 71.6 KiB (−94.6%)** and
    Lighthouse perf 78 → 100; `/memory-allocation` 272 → 82 KiB (−70%); all posts hit
    accessibility 100 by enforcing 4.5:1 contrast in automated tests. (Source: his own
    Bluesky thread, mirrored at https://plumblines.uk/profile/samwho.dev.)
  - **Spread**: front page of **Lobsters** (https://lobste.rs/s/kydugs/load_balancing, 83
    points, 15 comments) and Hacker News; guests on Hanselminutes and others. He says each
    post takes **one to three months** and that `Load Balancing` was "like nothing else I'd
    experienced" in 12 years of blogging.
- **What it would take to imitate**: the highest-value, highest-fit model. A single vanilla
  simulation component + a bottom-up script. The discipline is editorial (cut to the simplest
  example) not technical. Budget: days per post for a *reused* engine, not months, because we
  build the engine once.

### 1.2 Bartosz Ciechanowski — bespoke physics explainers · https://ciechanow.ski/

- **URLs**: https://ciechanow.ski/cameras-and-lenses/ · https://ciechanow.ski/gears/ ·
  https://ciechanow.ski/mechanical-watch/ · https://ciechanow.ski/airfoil/ ·
  https://ciechanow.ski/moon/ · archive https://ciechanow.ski/index.html
- **What makes it work**:
  - A **purpose-built simulation per article** (real optics, real gear geometry, real gravity
    integration), not a library demo. You drag and it responds physically.
  - **Progressive enhancement**: "words you can read in any browser… images… interactive
    JavaScript widgets" (Adactio's framing, https://adactio.com/links/17689). The article is
    fully readable with JS off.
  - Deliberate motion control: every animation has a play/pause button and a global "pause all
    animations" setting for distraction/power reasons.
  - **Spread**: picked up by Kottke, Boing Boing, Adafruit, and repeatedly front-paged on HN.
- **What it would take to imitate**: the *philosophy* (progressive enhancement, per-figure
  play/pause, real physics) is cheap and should be copied. The *effort* (months per article,
  full-time, Patreon-funded) is not sustainable here — do not copy that.

### 1.3 Distill.pub — interactive research journal (and why it died)

- **URLs**: https://distill.pub/2016/misread-tsne/ ·
  https://distill.pub/2016/momentum/ (Goh, *Why Momentum Really Works*) ·
  https://distill.pub/2020/communicating-with-interactive-articles (the theory paper) ·
  hiatus: https://distill.pub/2021/distill-hiatus · archive https://distill.pub/archive
- **What makes it work**: interactivity that lets the reader *explore a parameter space* (the
  t-SNE playground, the momentum optimizer) rather than just look. DOIs + citations made it
  academically legitimate and preservable.
- **Why it died (the lesson)**: the 2021 hiatus note says running it as a journal created
  "structural friction"; the community's read is that the **per-article effort and skill were
  the bottleneck**, and there was "limited empirical evaluation of the effectiveness of
  interactive articles" (their own words). It is a warning, not a template.
- **What it would take to imitate**: read https://distill.pub/2020/communicating-with-interactive-articles
  and steal its **five affordances** — connecting people and data, making systems playful,
  prompting self-reflection, personalizing reading, reducing cognitive load. Ignore the
  journal apparatus.

### 1.4 Nicky Case — explorable explanations · https://ncase.me/

- **URLs**: https://ncase.me/trust/ (Evolution of Trust) · https://ncase.me/polygons/ ·
  hub https://ncase.me/explorable-explanations/ · design patterns
  https://blog.ncase.me/explorable-explanations/ ·
  https://blog.ncase.me/explorable-explanations-4-more-design-patterns
- **What makes it work**: the **interest curve** (hook → build mechanics in isolation → combine
  → conclude), **"See, Model, Apply"** (let the reader generate their own data points and form
  their own model), and **cognitive gates** (withhold content so the reader learns by
  predicting). Everything is public-domain and dependency-light.
- **Spread**: Salon, Forbes 30 Under 30, Mashable, Wikipedia entries; Imgur front page for the
  shadow explainer. The format itself is the story.
- **What it would take to imitate**: the *design patterns* are the most transferable asset on
  this whole list and cost nothing. For systems topics the "See, Model, Apply" pattern maps
  directly: let the reader predict the sawtooth, then run it.

### 1.5 The Pudding — scroll-driven visual essays · https://pudding.cool/

- **URLs**: https://pudding.cool/ · how-to https://pudding.cool/process/how-to-implement-scrollytelling/ ·
  scrollama https://github.com/russellgoldenberg/scrollama ·
  responsive scrollytelling https://github.com/the-pudding/responsive-scrollytelling
- **What makes it work**: **sticky graphic + stepper text** — one visual stays pinned while
  text steps scroll past, each step advancing the graphic one state. The reader controls pace
  by scrolling, so it works on mobile and requires no clicking. They open-source the technique.
- **What it would take to imitate**: low. This is now native CSS (`animation-timeline: view()`
  / `scroll()`), so a scroll-driven figure can be **zero-JS and zero-dependency** with a
  graceful static fallback. See §3 Form C.

### 1.6 cpu.land — "Putting the 'You' in CPU" · https://cpu.land/

- By Lexi Mattick / Hack Club, July 2023. Long-form systems narrative (syscalls, user vs kernel
  mode, memory, how Linux loads executables) carried by **custom illustrated diagrams** rather
  than interactivity. Proves that *visual narrative* alone (not widgets) already differentiates
  a systems article — and that a good one circulates widely.

### 1.7 Learn Git Branching · https://learngitbranching.js.org/

- A git **visualizer + sandbox + levels**. You type real commands and the commit tree updates
  live; then you solve levels against a goal. **Ships zh_CN** (`?locale=zh_CN`) — direct proof
  that a bilingual interactive is normal and expected. Open source: https://github.com/pcottle/learnGitBranching

### 1.8 VisuAlgo · https://visualgo.net/en

- Algorithm/data-structure animations with **step / play / rewind / speed** controls and
  "e-Lecture mode". **EN / 中文 / ID** (https://visualgo.net/zh). 24 modules, 120k+ learners.
  Proof that a *scrubber over a precomputed trace* is the workhorse interaction for
  algorithm-style content.

### 1.9 Setosa "Explained Visually" · https://setosa.io/ev/

- https://setosa.io/ev/eigenvectors-and-eigenvalues · https://setosa.io/ev/markov-chains ·
  https://setosa.io/ev/principal-component-analysis
- Small, focused widgets where you **drag a point and watch the whole system respond** ("drag
  `v` to be an eigenvector"). Minimal chrome, maximum concept-per-pixel. The most imitable
  visual style on this list.

### 1.10 TCP congestion control — a cluster of ready-made precedents

- **Congestion Lab** — https://andifathulms.github.io/tcp-congestion/en — packet-level
  simulator; move a slider and *every packet is re-simulated*; explicit trace / queue-AQM /
  compare-algorithms / fairness modes; **EN + ID**.
- **Transport Layer Playground** — https://transport-play.komal.link/ — handshake, sliding
  window, slow start, retransmission; scenario buttons (Clean / Out-of-Order / DupACK).
- **TCP Visualiser** — https://krunalkumar.dpdns.org/labs/tcp-congestion — real seq/ack
  arithmetic checked against RFC 793 worked examples; Reno slow start/fast recovery/timeout.
- **AIMD sawtooth** — https://aimd-sawtooth.vercel.app/ — single-flow cwnd + buffer occupancy.
- These are the direct competition and the direct proof of demand. None of them are bilingual
  *and* have the blog's "real experiment" credibility; that is the wedge.

### 1.11 Others worth stealing from

- **The Animated Elliptic Curve** — https://curves.xargs.org/ and https://x25519.xargs.org/ —
  steps through the algebra of EC point addition with a scrubber; HN-discussed.
- **howdns.works / howhttps.works** (DNSimple) — https://howdns.works/ ·
  https://howhttps.works/ · translated to **zh-Hans** (https://howdns.works/zh-hans/) ·
  the team reports it ranks **#2 for "how DNS works"** and pulls ~15k readers/month with no SEO
  work (https://blog.dnsimple.com/2016/09/how-dns-works). Best evidence that the *format* earns
  rank and links on its own.
- **NandGame** — https://www.nandgame.com/ — build a computer from NAND gates; **8 languages
  incl. 中文**; inspired by *nand2tetris*.
- **Transformer Explainer** — https://poloclub.github.io/transformer-explainer/ — a real GPT-2
  running **client-side in the browser**, with a step walkthrough; **490,000+ users** and a
  90-participant study showing significant gains in understanding and engagement.
  Also **CNN Explainer** — https://poloclub.github.io/cnn-explainer/.
- **bbycroft LLM Visualization** — https://bbycroft.net/llm — 3D (Three.js), 5.6k GitHub stars.
  Impressive, but the 3D is most of the cost; treat as a cautionary ceiling, not a target.
- **Python Tutor** — https://pythontutor.com/ — step-through of stack/heap/pointers for
  Python/Java/**C/C++** (via Valgrind), 25M+ users. **Critical caveat: it executes code on a
  server**, which we cannot do — copy the *interaction*, generate the trace at build time (§3 Form D).
- **Seeing Theory** — https://seeing-theory.brown.edu/ — EN / **中文** / ES; Webby winner.
- **3Blue1Brown / Manim** — https://github.com/3b1b/manim · community fork
  https://www.manim.community/ — animation, not interaction; relevant only as a *rendered*
  figure source (and it needs a render step, so it belongs in the build, not the browser).
- **Julia Evans / Wizard Zines** — https://wizardzines.com/comics ·
  https://jvns.ca/blog/2019/02/10/a-few-networking-tool-comics/ — hand-drawn diagrams as a
  **cheap** differentiator. "Here are the 5 options of `openssl` you actually need" beats a
  4000-word man page. Relevant as the *low-effort* end of the visual spectrum.

---

## 2. What actually makes these spread

Patterns that recur across the examples, i.e. the mechanics to optimise for:

1. **"I made a thing you can play with" is a first-class HN/Lobsters submission.** Evidence:
   Lobsters front page for samwho's Load Balancing; HN "Show HN: Microgpt is a GPT you can
   visualize in the browser" (193 points); "Beautiful interactive explainers generated with
   Claude Code"; cpu.land; bbycroft. Static experiment write-ups compete with everyone's
   writing; interactives compete with very few.
2. **The visual *is* the argument.** When the picture carries the reasoning (slow servers go
   dark, dropped packets fall off, cwnd saws), the reader re-derives the conclusion instead of
   being told it. That is what gets screenshotted and quoted.
3. **A reusable, embeddable artifact earns links.** howdns.works ranks #2 for its head term
   and gets cited/taught; Transformer Explainer got 490k users; VisuAlgo is assigned by
   universities. Being *linkable and teachable* beats being merely readable.
4. **Bilingual is a moat, not a chore.** LearnGitBranching, VisuAlgo, Seeing Theory, NandGame,
   howdns.works and Congestion Lab all ship a second language. Almost none of the
   "indie interactive blog" competitors do. ZH parity multiplies the reachable audience with
   no marginal runtime cost.
5. **Press/pickup follows the format, not the topic**: Kottke/Boing Boing/Adafruit for
   Ciechanowski, Salon/Forbes/Mashable for Nicky Case, HN/Lobsters for samwho. The format is
   the news hook.
6. **Small and fast is a differentiator, not a compromise.** samwho cut 95% of the bytes off
   his own interactives and improved them. Heavy JS is now the *easy*, undifferentiated choice.

---

## 3. Five forms, ordered by (differentiation × feasibility)

Ranking logic: **A** is the strategic bet (highest differentiation *and* it compounds — one
engine serves many future posts, and it fits systems/networking exactly). **B** is the highest
feasibility with real differentiation. **D** unlocks systems topics that are impossible as
prose. **C** is near-free (native CSS) and maximally article-native. **E** has the highest
ceiling but the worst effort/risk ratio, so it goes last.

Constraints applied to every form: **no server; must stay fast; must work in light + dark;
must work in EN + ZH.**

---

### Form A — The reusable simulator engine ("one engine, many posts")

**What the reader does.** Watches a live model run, then changes it: play/pause, speed, and one
to three meaningful parameters (RTT, buffer size, loss rate, number of servers, tick rate…).
The model recomputes in real time and the picture changes. The prose refers to what they just
saw.

**Why it beats prose.** Systems behaviour is *emergent* — the sawtooth, queue collapse,
fairness, starvation are consequences of a loop, and a loop cannot be explained in a
paragraph. A paragraph asserts the consequence; a simulator lets the reader *cause* it and
refute their own wrong intuition (the "See, Model, Apply" pattern from Nicky Case).

**Real examples.** samwho.dev/load-balancing, /memory-allocation, /hashing, /bloom-filters;
https://andifathulms.github.io/tcp-congestion/en; https://transport-play.komal.link/.

**Implementation approach.**
- One Astro component, e.g. `src/components/interactive/Simulator.astro`, taking a `lang` prop
  and a `kind` + params. The engine is **vanilla TS in an inline `<script>`** — exactly the
  pattern already used by `src/components/tools/EndianVisualizer.astro` (typed inline script,
  scoped `<style>`, `data-*` hooks, `lang`-driven `L` dictionary).
- Rendering: **Canvas 2D** for anything with many moving elements (packets, requests,
  particles); **SVG** for a small fixed number of elements. No libraries.
- Loop: `requestAnimationFrame` with a **fixed timestep** accumulator so the model is
  deterministic and speed-scalable; pause via `IntersectionObserver` when off-screen; honour
  `prefers-reduced-motion` by rendering a static representative frame plus a manual step button.
- Theme: read colours from **CSS custom properties** (`getComputedStyle(root).getPropertyValue('--accent')`)
  so it inherits `global.css` + `theme.css` and works in light and dark with no duplicated palette.
  Never hardcode hex in canvas code.
- Bilingual: all labels come from the `L` dictionary keyed on `lang`; the *engine is shared*, so
  ZH is a translation of ~15 strings, not a fork.
- Deep-linkable state: encode params in the URL hash (`#rtt=50&buf=2bdp`) so a specific
  scenario can be linked from the article, from HN comments, and from the other language.

**Cost/risk.** Highest engineering cost of the cheap forms, but it is paid **once** and then
amortised across every future simulator post. Risk: a wrong model is worse than no model
(see §4) — the physics/algorithm must be verifiable against a reference.

---

### Form B — The hand-built interactive diagram ("drag the handle")

**What the reader does.** Manipulates a small number of draggable handles (or hover targets) on
a single carefully drawn figure and watches the geometry/logic respond: drag a subnet boundary
and watch the host range change; drag struct fields to reorder and watch offsets/padding
change; hover a packet field and see the byte it maps to.

**Why it beats prose.** Layouts, addresses and bit-fields are *spatial*, and prose is
one-dimensional. "Byte 8 is padding because the alignment of the `double` is 8" is a sentence
you must decode; dragging the `double` up and watching the padding box vanish is a fact you
*see*. This is the cheapest way to make a static SVG (which the blog already ships) earn its
keep.

**Real examples.** https://setosa.io/ev/eigenvectors-and-eigenvalues (drag `v`),
https://setosa.io/ev/principal-component-analysis, https://ciechanow.ski/gears (drag/scrub),
and the blog's own `EndianVisualizer` / `SubnetCalculator` — already 80% of the way there.

**Implementation approach.**
- **Inline SVG** with `viewBox`, so it is crisp at any size and styleable by CSS vars.
- Pointer Events (`pointerdown/move/up` + `setPointerCapture`) so mouse, touch and pen are one
  code path; add keyboard handles (arrow keys + focus ring) for accessibility.
- Labels in `<text>`/`<tspan>` from the `L` dict; numbers formatted with `Intl.NumberFormat`
  per locale.
- No JS required to *read* it: ship the default state as the static SVG, enhance on top
  (progressive enhancement — crawlers and no-JS readers get the figure).
- Reuse across posts: make it a component with a `kind` prop (subnet / memory-layout / packet /
  window) rather than four one-offs.

**Cost/risk.** Low-to-medium. The risk is over-investing in visual polish; the test is whether
the reader can *change their mind* by dragging, not whether it looks nice.

---

### Form C — Scroll-driven "ladder of abstraction" (sticky figure + stepper text)

**What the reader does.** Scrolls. A figure pins to the viewport while text steps pass by, each
step advancing the figure one state: DNS → TCP → TLS → HTTP; one instruction through
fetch/decode/execute; a packet crossing a hop. No clicking, works on phones.

**Why it beats prose.** It gives *sequence* and *level-of-detail control* to the reader (Bret
Victor's "ladder of abstraction", https://worrydream.com/LadderOfAbstraction) without
demanding any input. It also turns the existing long-article shape into something with rhythm —
directly addressing "long, boring" — because the reader's own scrolling paces the explanation.

**Real examples.** https://pudding.cool/ (sticky + stepper), https://worrydream.com/LadderOfAbstraction,
https://ciechanow.ski/moon/ (scroll-paced demonstrations).

**Implementation approach.**
- **Native CSS scroll-driven animations**: `animation-timeline: view()` / `scroll()` with
  `animation-range` — now baseline in all major browsers (MDN: Scroll-driven animations,
  https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations). This means
  **zero JavaScript and zero dependencies** for the common case.
- Progressive enhancement is mandatory: wrap in `@supports (animation-timeline: view())`; without
  support, show the final/representative state as a normal figure. Never let the article become
  unreadable.
- For complex state changes, an `IntersectionObserver` stepper (the scrollama idea,
  https://github.com/russellgoldenberg/scrollama) is the fallback — still dependency-free, ~30 lines.
- Keep the text in the article prose (so it is indexed and translated normally); only the figure
  labels come from the `L` dict.

**Cost/risk.** Lowest cost, high article-fit. Risk: scroll effects that *hijack* scroll or move
content unexpectedly are hostile — the graphic pins, the scroll speed never changes.

---

### Form D — Step-through visualizer over a build-time trace

**What the reader does.** Presses ◀ / ▶ or drags a scrubber and watches state evolve one step at
a time: the stack and heap as a C program runs; the congestion window per RTT; the routing table
per DNS hop; the bytes of a packet as it is assembled. Every step is deep-linkable.

**Why it beats prose.** Many systems topics are *state machines*, and the failure mode readers
have is not knowing "what happens next" but "what is true *at this instant*". A scrubber makes
the instantaneous state inspectable and lets the reader go backwards — which is impossible in a
real debugger without a replay, and impossible in prose at all.

**Real examples.** https://visualgo.net/en (step/rewind/speed), https://pythontutor.com/ (stack,
heap, pointers, C/C++), https://bbycroft.net/llm (step walkthrough), https://curves.xargs.org/.

**Implementation approach — and the crucial trick.**
- Python Tutor runs code on a **server**; we cannot. Instead, **generate the trace at build time**
  with a Node script in `scripts/`, and embed it as JSON in the page. This also satisfies the
  blog's golden rule (real output only): the trace is the output of a real run, captured, not
  invented.
- Renderer: SVG (stack frames, boxes, arrows) or Canvas (byte grids, timelines). Prev/next +
  scrubber + keyboard shortcuts; state encoded in the URL hash so each step is linkable.
- Keep the embedded trace small (compress, cap steps, quantise floats) so the page stays fast.
- Bilingual: step *labels* from the `L` dict; the trace itself is language-neutral.
- Where the "real run" must be reproducible, have the script assert a checksum so a future
  dependency change fails the build rather than silently drifting.

**Cost/risk.** Medium. The build-time trace generator is the real work; the renderer is
reusable. Risk: build-time scripts must be deterministic and fast (they run before every build,
including on the deploy box's constraints — see §5).

---

### Form E — The mini-game / puzzle (goal, attempt, verify)

**What the reader does.** Is given a goal and has to achieve it: wire up a working load
balancer; place a packet so it passes the firewall; fix the struct so it is 24 bytes with no
padding; get the connection to complete despite 10% loss. Success is verified locally.

**Why it beats prose.** A goal converts reading into *doing*, and a verified success is a
memory. It is also the most shareable ("I beat it in 4 moves") and the most pressable.

**Real examples.** https://www.nandgame.com/ (build a computer from NAND), 
https://learngitbranching.js.org/ (levels + sandbox), https://ncase.me/trust/.

**Implementation approach.** A small explicit state machine + a validator, all client-side in
vanilla JS. Persist progress in `localStorage`. Keep the whole thing under a few KB. Bilingual
via the `L` dict.

**Cost/risk.** Highest ceiling, worst effort/risk ratio, and the highest chance of being a
*gimmick* (see §4). Only build when the goal itself is genuinely the concept being taught —
"NAND gate → computer" is, "click the packets in the right order" is not.

---

### Honourable mention (cheap, not one of the five): the scrubbed animated figure

A single animated figure (like a Manim clip) with a **scrubber** instead of autoplay: the reader
drags through time. This is the poor man's Ciechanowski and can be produced from a build-time
render or from a keyframed SVG/WAAPI animation. Cheap, non-gimmicky, and a good stepping stone
while the reusable engine (Form A) is being built.

---

## 4. What NOT to do

The failure mode is not "not enough interactivity" — it is **interactivity that costs effort and
adds no understanding**. Concretely, do not:

1. **Fake the model.** An animation with invented numbers ("roughly 300ms") violates the
   golden rule and readers detect it. If it can't be a real, checkable model, make it a static
   diagram instead. (Recall the fabricated-output repair in `tcp-proxy-in-go`.)
2. **Ship "click to reveal" and call it interactive.** Hiding text behind a click is a gimmick.
   Interactivity must expose a **cause→effect loop** the reader can manipulate, not just gate
   content.
3. **Use a heavy JS framework per article.** No React/Svelte/D3/GSAP/Three for a blog post.
   The site's identity is fast, static, dependency-free, hand-written CSS. A 200 KB bundle per
   post destroys that — and samwho proved you don't need it (94.6% smaller after dropping
   libs). Framework-free SVG/Canvas + WAAPI + native CSS scroll-driven animations only.
4. **Hijack scroll.** No scroll-jacking, no forced scroll speed, no parallax for its own sake.
   The Pudding's rule: scrollytelling "does not alter scroll behavior".
5. **Autoplay forever / ignore motion preferences.** Always provide play/pause and a global
   pause; honour `prefers-reduced-motion`; pause when off-screen (battery, and on the deploy
   box's users' phones).
6. **Require a server.** No Python-Tutor-style execution. Generate traces at build time.
7. **Make JS mandatory.** Every interactive must degrade to a readable static figure. Reason:
   SEO crawlers, no-JS readers, reduced-motion users, and ZH parity (a broken EN widget must not
   leave the ZH article empty).
8. **Fork the work per language.** Build the engine once; translate only the label dictionary.
   If an interactive cannot be shared across EN/ZH, it is too expensive.
9. **Break light/dark.** Hardcoded colours in canvas are the classic bug. Read CSS vars.
10. **Build a one-off bespoke engine per post.** Distill died of exactly this. Prefer a small
    number of reusable forms over brilliance per article.
11. **Choose 3D/WebGL because it looks impressive.** bbycroft's 3D is the exception, not the
    rule; the payload, maintenance and mobile cost are real, and 3D rarely adds understanding
    that a 2D schematic would not.
12. **Make the interaction the whole article.** The text must still explain, and must still be
    the thing that ranks in search. Interaction is an *illustration of* the argument, not a
    replacement for it.
13. **Chase a game when a slider teaches the same thing.** Form E only when the goal *is* the
    concept.
14. **Skip verification.** If the widget's model is wrong, the post is worse than the boring
    version it replaced. Cross-check against a reference (RFC, textbook, real program output)
    and, where possible, assert it in the build.

---

## 5. Repo reality check (what's actually available)

Facts found by reading the repo, which make the above concrete:

- **MDX is already available and unused.** `astro.config.mjs` includes `@astrojs/mdx`; the
  content loader is `glob({ pattern: '**/*.{md,mdx}' })`; and `scripts/check-content.mjs`
  already filters `/\.mdx?$/`. **All 260 posts are `.md` (0 `.mdx`).** So an interactive article
  can ship as `src/content/blog/{en,zh}/<slug>.mdx` that imports an Astro component — **no
  pipeline, gate, or config change needed.** This is the single most important enabler.
- **The component pattern already exists.** `src/components/tools/*.astro` are framework-free:
  a typed inline `<script>` (vanilla TS), scoped `<style>`, `data-*` hooks, and a `lang` prop
  driving an `L` dictionary (see `EndianVisualizer.astro`). Interactive articles should reuse
  this exact shape. `ToolShell.astro` is the page wrapper.
- **Theme is CSS-variable based** (`src/styles/global.css` + `theme.css`): `--fg-muted`,
  `--accent`, `--bg-soft`, `--border-strong`, `--font-mono`, warm light / green-black dark.
  Canvas/SVG code must read these vars so light+dark and any future re-theme come for free.
- **No client framework anywhere** — no React/Svelte/Vue, no D3, no animation library. Adding
  one per post contradicts the stated design identity ("No web fonts. No heavy JS.").
- **Build runs on BOOK, deploy on TOWER** (981 MB RAM, swap added because the build already
  peaks ~790 MB). Any new **build-time trace script must be fast and deterministic** and must
  not blow the memory budget. Prefer generating traces once and committing the JSON over
  regenerating a heavy model on every deploy.
- **Analytics is server-side GoAccess** (no per-element events) plus a daily snapshot TSV. There
  is **no way to measure "did they play the simulator"** without adding a tiny beacon or a
  privacy-light event endpoint — which would be the first third-party-ish JS on the site.
  Honest options: (a) measure time-on-page and scroll depth only, (b) add a single self-hosted
  one-line beacon, (c) infer from HN/Lobsters response. Decide before building, because it
  changes what "did this work?" means.
- **Pagefind runs postbuild; the sitemap excludes `*.json`/`/api/`.** Embedded trace JSON is
  fine but must not be exposed as a crawlable endpoint.
- **Bilingual is enforced by the gate** (`translationKey` pairing). An interactive post is two
  files; the component is shared and the `L` dict is the only translation surface.

---

## 6. The 3 best first candidates

Chosen so that each is (a) genuinely *better* interactive than as prose, (b) squarely inside the
blog's material (networking / C-memory / self-hosting), (c) buildable with the existing
patterns, and (d) exercises a *different* form — so building them produces three reusable
engines, not three one-offs.

### Candidate 1 — **TCP congestion control, you drive the network** (Form A: simulator)

- **Exact topic.** Why TCP ramps up, overshoots, halves and saws — and why a bigger buffer makes
  latency worse (bufferbloat). Frame it around the blog's real material: a measured
  `curl`/`iperf3` transfer over the blog's own server or a Docker-netem link.
- **The interaction.** Sliders for RTT, bottleneck rate, buffer size (in BDP), loss; a dropdown
  for Reno / CUBIC; play/pause/speed. Two linked charts — `cwnd` over time (the sawtooth) and
  queue depth / RTT over time. Reader predicts the shape, then causes it.
- **Why it wins.** The single most-requested "I wish I could see this" systems topic; a cluster
  of existing sims proves demand; none of them combine a real experiment with bilingual
  treatment. The sawtooth is *the* canonical "prose fails, a loop succeeds" example.
- **Rough build plan.**
  1. Write the model as a pure function in TS (sender state machine, drop-tail queue, ACK
     clock), fixed timestep, unit-tested against the known Reno sawtooth period and the
     steady-state utilisation formula (the Congestion Lab author reports matching the AIMD
     derivation within 1% — use that as a check).
  2. Render with Canvas 2D: packet dots along a link, a queue bar, two time-series charts.
  3. Controls + `L` dict + URL-hash state; pause off-screen; reduced-motion shows a frozen
     representative sawtooth.
  4. Capture a real `iperf3`/`curl` trace (and optionally a `tc netem` run) to anchor the
     article's numbers; label the sim as the model and the capture as the measurement.
  5. Article as `.mdx` in both languages, importing the component; internal links to the
     existing networking posts.
- **Effort:** the engine is the big item (~a few days); the model is the risky part and needs
  the verification in step 1.

### Candidate 2 — **Memory layout: drag the struct, watch the padding** (Form B: interactive diagram)

- **Exact topic.** Why `struct`s are not the sum of their fields: alignment, padding, offsets,
  and the byte-order view. Directly extends the blog's existing `EndianVisualizer` and the
  `memory-alignment-and-padding-in-c` post, and fits the `embedded`/`C`/ESP32 material.
- **The interaction.** Drag fields to reorder them; each field has a width and an alignment.
  The hexdump re-lays-out live, showing offsets, inserted padding bytes (highlighted), total
  size, and a little-endian vs big-endian byte view. Toggle 32-bit vs 64-bit ABI (and x86 vs
  the ESP32's alignment rules). Reader discovers *why* reordering saves bytes.
- **Why it wins.** Spatial + immediate; the "aha" is a physical rearrangement. Cheap to build
  on top of an existing component, and the same figure serves a post, a tool, and an internal
  link target. It is the lowest-risk way to prove the whole interactive direction.
- **Rough build plan.**
  1. Compute layout in TS (sorted-by-alignment packing, exactly as a real compiler does);
     cross-check offsets against a compiled `sizeof`/`offsetof` run so the figure cannot lie.
  2. Inline SVG: field boxes with drag handles (Pointer Events + keyboard), a padding hatch
     pattern, offset ruler.
  3. ABI/endianness toggles; `L` dict; static default state as the no-JS fallback.
  4. Wrap as a reusable `interactive` component (also reusable for packet fields and subnet
     boundaries).
  5. `.mdx` article in EN + ZH, linking to the existing padding/endianness posts and the
     endianness tool.
- **Effort:** low-to-medium (a day or two), and it produces the reusable Form-B component.

### Candidate 3 — **The request ladder: a real `curl -v` as a scroll-driven timeline** (Form C: scroll-driven)

- **Exact topic.** What actually happens when you type a URL / run `curl -v`: DNS → TCP
  handshake → TLS handshake → HTTP request/response → connection close — hop by hop, record by
  record, on the blog's own nginx/self-hosted stack.
- **The interaction.** Scroll. A pinned figure advances through the real captured trace; each
  text step highlights the corresponding record and its bytes. Hovering a field explains it.
  A second axis shows "where it can go wrong" (the NXDOMAIN, the expired cert, the
  `curl --resolve` trick — all from the blog's existing nginx/security material).
- **Why it wins.** The DNSimple comics rank #2 for a head term and translate; a *scroll-driven,
  real-trace* version is the natural upgrade and is nearly free to build (native CSS). It turns
  the blog's longest, flattest articles into something with rhythm, and it links directly into
  the existing networking/nginx/self-hosting posts and tools.
- **Rough build plan.**
  1. Capture a real `curl -v` (and `dig` + `openssl s_client -connect`) transcript against
     `blog.awin-x.top`; commit it as the source of truth. Optionally precompute an annotated
     JSON of records from it.
  2. Inline SVG "ladder" figure (host → resolver → server; or client → server with the record
     stack), styled from CSS vars, static-final-state fallback.
  3. Drive it with `animation-timeline: view()` under `@supports`, with a ~30-line
     IntersectionObserver fallback; never alter scroll speed.
  4. `.mdx` article EN + ZH; steps are prose (translated), labels from the `L` dict.
- **Effort:** low (the cheapest of the three), and it produces the reusable Form-C pattern plus
  a genuinely differentiating "signature" article.

**If only one ships:** Candidate 3 (cheapest, safest, immediately differentiates the long
articles, native CSS, no engine risk), with Candidate 2 close behind because it produces the
most reusable component. Candidate 1 is the biggest prize but should wait until the engine
pattern from 2/3 is proven.

---

## 7. Suggested next steps (for the orchestrator)

1. **Prototype Candidate 3 as a `.mdx` spike** to prove the MDX path end-to-end (gate → build →
   deploy) before committing to any engine. Zero new dependencies, native CSS only.
2. **Decide the measurement question** (§5): time-on-page only, or a self-hosted beacon. This
   determines whether we can ever tell if interactives work.
3. **Extract two reusable components** from the spike: `interactive/ScrollLadder.astro` and
   `interactive/DragDiagram.astro`. Reuse them before building a bespoke engine.
4. **Then** build the TCP simulator (Candidate 1) on the proven pattern, with the model verified
   against a reference before any pixels are drawn.
5. Keep a running tally in `AGENTS.md` of which forms shipped, their payload size, and their
   analytics — so the "which form performs" question is answerable over the observation window
   rather than guessed.
