# What actually gets traction in the systems / self-hosting / embedded / networking niche

> Research brief for the "DeepSeek @ awin-x" blog, 2026-10-15.
> Method: Hacker News Algolia API (real point counts), Lobsters, the 2025
> "most popular HN bloggers" analysis, author interviews/posts, and Chinese-community
> sources (V2EX / 掘金 / 知乎 / 少数派). Every claim below has a real URL.
> Point counts are HN points at time of query. **This file is evidence, not a plan.**

---

## TL;DR (the five things that matter)

1. **Traction comes from an artefact or a story, not from an article about a topic.** The single
   biggest post in this blog's exact niche is a *thing someone built*:
   [Show HN: I replaced a $120k bowling center system with $1,600 in ESP32s](https://news.ycombinator.com/item?id=48968606) — **2935 points**.
   Next to it, the biggest self-hosting posts are *personal stories with a stake* ("after 23 years I
   gave up"), not guides.
2. **"Try it yourself" beats "here is information."** The comment on the top-voted explainer of the
   year: *"The 'try-it-yourself element' was what got me… when it 'clicked,' it was magical."*
   ([HN thread](https://news.ycombinator.com/item?id=42769325))
3. **Strong, unhedged opinion is the cheapest traffic multiplier** — and this blog has none.
   Sean Goedecke (#3 HN blogger 2025): *"the recipe for a popular post is to have a clear opinion
   about working in tech that many people disagree with."*
4. **Distribution is the bottleneck, not volume.** 260 interchangeable articles with no artefact,
   no hook, no submission = zero. One good Show HN can dwarf all of it.
5. **The unique thing this blog owns — an AI that runs its own infrastructure — is the one asset
   nobody else has, and it is currently buried under neutral, keyword-shaped explainers.**

---

## 1. What actually gets traction (real posts, real numbers)

### 1a. The highest-traction post in the niche is a *hardware artefact with a money contrast*

| Post | Points | Why it worked |
|---|---|---|
| [Show HN: I replaced a $120k bowling center system with $1,600 in ESP32s](https://news.ycombinator.com/item?id=48968606) | **2935** | A *thing that exists and runs a real business*. The hook is a 75× cost collapse in the title. Concrete, verifiable, useful to a real operator. |
| [Building an occupancy sensor with a $5 ESP32 and a serverless DB](https://news.ycombinator.com/item?id=38252566) | 670 | Same shape, smaller: cheap part + a working system + "you could do this". |
| [ESP32 Buyer's Guide: Different Chips, Firmware, Sensors](https://news.ycombinator.com/item?id=34653729) | 490 | Saves the reader a decision; comparative, opinionated. |
| [CapibaraZero: A cheap alternative to FlipperZero based on ESP32-S3](https://news.ycombinator.com/item?id=41852821) | 409 | "Cheap alternative to a thing you already want" is a reusable hook. |
| [ESP32/ESP8266 Wi-Fi Attacks](https://news.ycombinator.com/item?id=20867758) | 453 | Security + edge of forbidden + code you can run. |

**Takeaway:** in embedded, the winning form is *"I built X for $Y"* with a real artefact and a
number. The blog has real ESP32/EasyTier work but ships **no artefact** — only prose about it.

### 1b. Self-hosting: the biggest posts are stories with a stake, not tutorials

| Post | Points | Why it worked |
|---|---|---|
| [After self-hosting my email for twenty-three years I have thrown in the towel](https://cfenollosa.com/blog/after-self-hosting-my-email-for-twenty-three-years-i-have-thrown-in-the-towel-the-oligopoly-has-won.html) ([HN](https://news.ycombinator.com/item?id=32715437)) | **1887** | A **23-year personal story ending in defeat**, against a named enemy ("the oligopoly has won"). Emotional stake + a real, uncomfortable conclusion. |
| [Self-hosting your own media considered harmful according to YouTube](https://www.jeffgeerling.com/blog/2025/self-hosting-your-own-media-considered-harmful) ([HN](https://news.ycombinator.com/item?id=44197932)) | **1634** | A named threat (YouTube) + a real incident + "considered harmful" as a signal phrase. |
| [Start Self Hosting](https://rohanrd.xyz/posts/why-you-should-start-self-hosting/) ([HN](https://news.ycombinator.com/item?id=30781536)) | 1049 | A **manifesto** — a direct "you should". Opinion, not a neutral survey. |
| [CLI agents make self-hosting on a home server easier and fun](https://fulghum.io/self-hosting) ([HN](https://news.ycombinator.com/item?id=46580326)) | 775 | Ties self-hosting to the *current* trend (agents); "and fun" is a real point of view. |
| [My self-hosting infrastructure, fully automated](https://github.com/khuedoan/homelab) ([HN](https://news.ycombinator.com/item?id=30030991)) | 716 | The "my stack" genre — but shipped as a **runnable repo**, not a post. |
| [My home lab setup for highly-available Internet](https://github.com/bradfitz/homelab) ([HN](https://news.ycombinator.com/item?id=17444230)) | 699 | Same: a repo by a known engineer. |
| [Building a Budget Homelab NAS Server](https://mtlynch.io/budget-nas/) ([HN](https://news.ycombinator.com/item?id=31548829)) | 347 | Budget + a real build + costs. |

**Takeaway:** the "what I run" genre is saturated and *table stakes* — it only wins when it carries
either a strong opinion, a failure story, or a runnable artefact.

### 1c. Reverse engineering: mystery + adversarial + "you can try it"

| Post | Points | Why it worked |
|---|---|---|
| [Reverse engineering Ticketmaster's rotating barcodes](https://conduition.io/coding/ticketmaster/) ([HN](https://news.ycombinator.com/item?id=40906148)) | **2305** | Taking apart a system everyone is *forced* to use; adversarial; the reader can picture the payoff. |
| [Reverse Engineering a Mysterious UDP Stream in My Hotel](https://www.gkbrk.com/2016/05/hotel-music/) ([HN](https://news.ycombinator.com/item?id=11744518), repost [1044](https://news.ycombinator.com/item?id=34912300)) | 1423 | A **mystery**: "what is this packet?" — pure story arc, unresolved at the start. Reposted 7 years later and hit again. |
| [Reverse engineering a $1B Legal AI tool exposed 100k+ confidential files](https://alexschapiro.com/security/vulnerability/2025/12/02/filevine-api-100k) ([HN](https://news.ycombinator.com/item?id=46137514)) | 821 | Stakes in the title ($1B, 100k files) + a finding. |
| [Reverse Engineering for Everyone](https://0xinfection.github.io/) ([HN](https://news.ycombinator.com/item?id=41069256)) | 621 | On-ramp content, "for everyone". |

### 1d. Systems / infra: contrarian opinions, bug hunts, and outrageous numbers

| Post | Points | Why it worked |
|---|---|---|
| [How I cut GTA Online loading times by 70%](https://nee.lv/2021/02/28/How-I-cut-GTA-Online-loading-times-by-70/) ([HN](https://news.ycombinator.com/item?id=26296339)) | **3883** | Absurd, specific goal + a huge number + "the vendor's code is bad". One of HN's all-time top posts. |
| ["They introduce kernel bugs on purpose"](https://lore.kernel.org/linux-nfs/YH+zwQgBBGUJdiVK@unreal/) ([HN](https://news.ycombinator.com/item?id=26887670)) | **3025** | A **quote as title**, an accusation, 1912 comments of conflict. |
| [Tracking down the 16-year-old WAL-reset SQLite bug](https://tailscale.com/blog/sqlite-wal-reset-bug) ([HN](https://news.ycombinator.com/item?id=49272832)) | 1223 | A bug-hunt story with a "16-year-old" hook — discovery, tension, resolution. |
| [Use one big server](https://specbranch.com/posts/one-big-server/) ([HN](https://news.ycombinator.com/item?id=32319147)) | 1413 | Contrarian against cloud orthodoxy; a clear "you should". |
| [I'm all-in on server-side SQLite](https://fly.io/blog/all-in-on-sqlite-litestream/) ([HN](https://news.ycombinator.com/item?id=31318708)) | 1353 | "All-in" = a stated position; commits to a bet. |
| [SQLite is not a toy database](https://antonz.org/sqlite-is-not-a-toy-database/) ([HN](https://news.ycombinator.com/item?id=26580614)) | 986 | Contrarian negation of a common belief. |
| [Freenginx: Core Nginx developer announces fork](https://mailman.nginx.org/pipermail/nginx-devel/2024-February/K5IC6VYO2PB7N4HRP2FUQIBIBCGP4WAU.html) ([HN](https://news.ycombinator.com/item?id=39373327)) | 1131 | Conflict / drama in a tool everyone runs. |
| [The world in which IPv6 was a good design](https://apenwarr.ca/log/20170810) ([HN](https://news.ycombinator.com/item?id=14986324)) | 677 | Revisionist history; makes the reader reconsider a settled belief. |
| [Engineer distributes resume via IPv6 traceroute](https://cv6.poinsignon.org/) ([HN](https://news.ycombinator.com/item?id=32609588)) | 633 | A **stunt** — a surprising, shareable artefact. |
| [Netlify just sent me a $104k bill for a simple static site](https://old.reddit.com/r/webdev/comments/1b14bty/netlify_just_sent_me_a_104k_bill_for_a_simple/) ([HN](https://news.ycombinator.com/item?id=39520776)) | 1783 | An outrageous, specific number + a villain. |

### 1e. Interactive / visual explainers: the highest ceiling of all

| Post | Points | Why it worked |
|---|---|---|
| [Mechanical Watch](https://ciechanow.ski/mechanical-watch/) ([HN](https://news.ycombinator.com/item?id=31261533)) | **4298** | Interactive, draggable, animated. HN's #8 post of all time. Belongs to a category only ~3 people can make. |
| [Mess with DNS](https://jvns.ca/blog/2021/12/15/mess-with-dns/) ([HN](https://news.ycombinator.com/item?id=29568510)) | 958 | A **playground**: the reader runs the experiment themselves. |
| [DNS Toys](https://www.dns.toys/) ([HN](https://news.ycombinator.com/item?id=31704789)) | 946 | A playful *tool*, not an article. |
| [Hosting SQLite databases on GitHub Pages](https://phiresky.github.io/blog/2021/hosting-sqlite-databases-on-github-pages/) ([HN](https://news.ycombinator.com/item?id=27016630)) | 1812 | A working demo + an unexpected "you can do this on a static host". |

**Takeaway:** interactive/visual explainers have the *highest* ceiling and the *lowest* competition in
the systems space. This is the moat the blog's own DotLens3D material is closest to — and it ships it
as static screenshots.

---

## 2. How the successful authors actually did it

Source: [The Most Popular Blogs of Hacker News in 2025](https://refactoringenglish.com/blog/2025-hn-top-5)
(Michael Lynch, Jan 2026), plus each author's own writing.

| Author | What they do | The transferable pattern |
|---|---|---|
| **Simon Willison** (#1 HN blogger 3 years running) | 1000+ posts/yr, only 118 long; link blog with commentary | **Low-effort, high-value link posts.** He says so: *"Sharing interesting links with commentary is a low effort, high value way to contribute."* He is a **power user, not a vendor** — *"restaurant recommendations from someone who eats out 20 times a week"*. He brings ideas out of walled gardens (TikTok, Twitter) into the open web where they can be discussed. |
| **Jeff Geerling** (#2) | YouTube (1M subs) + a blog that **stands alone** | Blog readers are first-class. He does *not* dump a transcript; he rewrites for the text medium. Hardware/Raspberry Pi/self-hosting. |
| **Sean Goedecke** (#3) | 140 posts/yr, 47 hit the front page | *"a clear opinion about working in tech that many people disagree with."* Prolific. **His top 3 posts of the year all flopped on first submission** and only succeeded on a resubmission months later — luck + persistence, not one-shot perfection. |
| **Brian Krebs** (#4) | Investigative cybercrime | Original reporting; stakes; a beat he owns. |
| **Neal Agarwal** (#5) | Interactive art/essays | *Everything* hit the front page. Pure artefact; nothing to argue about. |
| **Julia Evans** | Zines + posts about **things she found confusing** | Teach *why*, not *how*. Comics/diagrams. Interactive toys ([Mess with DNS](https://jvns.ca/blog/2021/12/15/mess-with-dns/)). Honesty about her own confusion is the voice. |
| **Bartosz Ciechanowski** | Interactive visual essays | [Mechanical Watch](https://ciechanow.ski/mechanical-watch/), [Airfoil](https://ciechanow.ski/airfoil/) — draggable, animated, no article equivalent exists. Highest barrier = best moat. |
| **Dan Luu** | Long, data-heavy, **confident unqualified** statements | [On writing](https://danluu.com/writing-non-advice): *"writing confident, unqualified statements works (gets people readers). People like confidence."* Also: he believes *"publishing short posts frequently looks more effective"* for growth — but chooses long anyway. |
| **Xe Iaso** | Narrative prose; **built a thing, then blogged it** | On [Anubis](https://anubis.techaro.lol/): *"I created a thing… and then blogged about it, and then it took off."* The artefact came first. |
| **Drew DeVault** | Strong opinions + real projects (SourceHut, Hare) | ["Rust is not a good C replacement"](https://drewdevault.com/2019/03/25/Rust-is-not-a-good-C-replacement.html) — deliberately contentious. ["Sourcehut is the fastest. So what?"](https://sourcehut.org/blog/2021-05-08-sourcehut-is-the-fastest-who-cares) — a post whose *title argues with itself*. |

**The recurring pattern, distilled:**
1. **Artefact or story first, article second** (Xe, Geerling, Neal, Ciechanowski).
2. **A stated position the reader can disagree with** (Sean, Dan, Drew, "Start Self Hosting").
3. **"Try it yourself"** — a playground, a repo, a reproducible experiment the reader runs.
4. **Prolific + persistent** — many posts, resubmit the good ones; most will flop.
5. **A voice / a person.** Michael Lynch, via Simon Willison
   ([Anti-Patterns in Software Blogging](https://refactoringenglish.com/blog/anti-patterns-software-blogging)):
   *"With so many developers delegating their writing to AI, software blogging is becoming bland and
   homogenous. Readers are hungry for writing with personality."*

---

## 3. Titles and hooks — the mechanisms, with real examples

| Mechanism | Real title | Why it clicks |
|---|---|---|
| **"considered harmful"** | [Self-hosting your own media considered harmful according to YouTube](https://www.jeffgeerling.com/blog/2025/self-hosting-your-own-media-considered-harmful) (1634) | Invokes a 50-year tradition of tech polemic; signals a strong claim + a villain. |
| **Money contrast / outrageous number** | [I replaced a $120k system with $1,600 in ESP32s](https://news.ycombinator.com/item?id=48968606) (2935); [Netlify sent me a $104k bill](https://news.ycombinator.com/item?id=39520776) (1783) | A number does the arguing. Impossible to scroll past. |
| **Accusation / conflict** | ["They introduce kernel bugs on purpose"](https://news.ycombinator.com/item?id=26887670) (3025) | A quote, a target, a fight. 1912 comments. |
| **Mystery** | [Reverse Engineering a Mysterious UDP Stream in My Hotel](https://www.gkbrk.com/2016/05/hotel-music/) (1423) | An open question; the reader must know the answer. |
| **Absurd constraint** | [SectorC: A C Compiler in 512 bytes](https://xorvoid.com/sectorc.html) (465); [a C compiler in 500 lines of Python](https://vgel.me/posts/c500/) (510) | An impossible-sounding limit makes the reader curious how. |
| **Contrarian negation** | [SQLite is not a toy database](https://antonz.org/sqlite-is-not-a-toy-database/) (986); [Use one big server](https://specbranch.com/posts/one-big-server/) (1413) | Denies a belief the reader holds; they click to argue or to be converted. |
| **Personal stake / time** | [after twenty-three years I have thrown in the towel](https://cfenollosa.com/blog/after-self-hosting-my-email-for-twenty-three-years-i-have-thrown-in-the-towel-the-oligopoly-has-won.html) (1887); [I spent 6 years building…](https://news.ycombinator.com/item?id=44787902) (1145) | Time invested = a story worth reading; the ending is in doubt. |
| **"I was wrong" / "I quit"** | [Why I Quit Google to Work for Myself](https://mtlynch.io/why-i-quit-google/) (1767); [I was wrong about spreadsheets](https://www.reifyworks.com/writing/2017-01-25-i-was-wrong-about-spreadsheets-and-im-sorry) (590) | Vulnerability + a decision. Humans read decisions, not surveys. |
| **A stunt** | [Engineer distributes resume via IPv6 traceroute](https://cv6.poinsignon.org/) (633) | Surprising, screenshottable, one-line explainable. |

**What does *not* click:** keyword-stuffed descriptive titles. The blog's current style —
*"Container security basics: what a container does and doesn't protect"* — is accurate, findable,
and carries **zero tension**. Compare it to any row above.

---

## 4. Gaps this blog could plausibly own (specific, not generic)

1. **"Try it yourself" playgrounds in the systems space.** Interactive explainers win the highest
   ceilings ([Mechanical Watch 4298](https://ciechanow.ski/mechanical-watch/),
   [Mess with DNS 958](https://jvns.ca/blog/2021/12/15/mess-with-dns/)) and almost nobody in
   *networking/infra* makes them. The blog already has a working client-side tools hub and a
   headless-rendering pipeline — a draggable MTU/PMTUD or DNS-resolution visualiser is a real moat.
2. **The ESP32/mesh artefact.** The niche's #1 post is a cheap-hardware thing that replaced an
   expensive system. The blog's real ESP32-C3 + EasyTier protocol work is *the exact raw material*
   for that post — but it publishes prose, not a flashable, runnable thing with a cost line.
3. **Honest failure and cost data.** The email-towel post (1887) is a *give-up* story. Almost nobody
   publishes real numbers on what their stack costs to run (electricity, hardware, time) or what
   they stopped self-hosting and why. ["The one thing I never see mentioned in any homelab tutorial
   or discussion is firewalling"](https://forum.level1techs.com/t/self-hosting-series-in-2026-what-are-you-running-whats-your-pain-points/249411) —
   a reader explicitly naming an unserved gap. Own the *uncomfortable* parts.
4. **The "an AI runs its own infrastructure" story.** Nobody else has this. It is the blog's single
   unique asset and it is currently one article ("I'm an AI and I run this blog") sitting among 260
   neutral explainers. It should be the **spine**, not a topic.
5. **ZH-native short-form on the platforms Chinese engineers actually use.** 掘金 is openly
   described as ["relatively low quality"](https://v2ex.com/t/1244398) and V2EX users are actively
   looking for ["relatively pure technical communities"](https://www.v2ex.com/t/1117662) — i.e. the
   audience is dissatisfied and searching. 少数派 publishes real home-server deep-dives
   ([家庭服务器实践](https://sspai.com/post/82512)). A ZH *native* post (not a translation) on a
   platform with distribution beats a mirrored translation on a zero-authority domain.
6. **"State of X" datasets.** Citable, linkable, cheap to serve, and nobody in the homelab space
   owns one. (Already listed in `notes/next-horizon.md` §4B — this research supports it.)

---

## 5. The uncomfortable findings (what this blog is doing that actively hurts)

Read alongside the operator's own verdict in `notes/next-horizon.md` §"Operator's assessment".
These are specific, not vibes:

1. **The form is interchangeable, and the corpus proves it.** 260 articles, all the same shape
   (topic → reproduced experiment → balanced conclusion), 1300–1800 words, one static SVG.
   The two samples read — `container-security.md`, `dotlens3d-glass-bead-optics.md` — are
   *competent and forgettable*. Any competent engineer could have written either one about any
   topic. Per `next-horizon.md`'s own rule, that "does not count".
2. **No point of view.** Every article hedges to a neutral middle ("the truth is narrower and more
   useful"). HN's proven engine is *"a clear opinion that many people disagree with"* (Sean
   Goedecke). A post that cannot be disagreed with cannot travel.
3. **No artefact.** The highest-traction forms — Show HN, repos, interactive toys, datasets,
   stunts — all require shipping a *thing*. The blog ships only articles. Even its best asset,
   DotLens3D, is a static PNG in a post instead of an interactive demo or a runnable release.
4. **Titles are SEO-shaped, not hook-shaped.** "X basics: what X does and doesn't protect" is a
   search string, not an invitation. No number, no tension, no position, no mystery.
5. **No "I", no story, no stakes.** The DotLens3D piece — genuinely original, visual, GPU-raytracer
   material — is written in impersonal textbook prose ("The scene is three parallel planes…").
   The story of *why the author wanted to know* is absent. Stories (mystery, failure, 23 years,
   "I quit") are what actually get shared.
6. **No visuals that can't be copied, and no interactivity.** Static SVG diagrams are table stakes.
   The niche's ceiling is draggable/animated explanations; the blog has a rendering pipeline and
   still ships flat images.
7. **Bilingual duplication doubles cost for near-zero marginal reach.** The ZH audience is on
   掘金/知乎/少数派/V2EX, not on Google. A translated post on a zero-authority domain reaches
   neither audience. ZH effort should go to *ZH-native* posts on platforms that distribute.
8. **Distribution is a bottleneck, and it isn't happening.** `notes/content-strategy.md` says
   "prepare copy, ask the operator to post". If nothing is actually submitted, 260 articles produce
   nothing. Sean Goedecke's own data shows the *same post* flops then succeeds on resubmission —
   you have to be in the game.
9. **Future-dated posts (`pubDate: 2027`) look artificial.** On HN/aggregators this reads as a
   content farm. Not fatal, but it's a smell.
10. **The one unique story is under-exploited.** "An AI runs its own infrastructure, with real
    constraints (a 981 MB box, a mesh VPN, an ESP32 node)" is a genuinely novel narrative. Buried
    among neutral explainers, it reads as a gimmick; made the spine, it is the reason to follow.

---

## 6. What this implies (concrete experiments, not a plan)

Ranked by expected traction per unit of effort, given the assets already in hand:

1. **Ship one artefact + one Show HN.** The ESP32/EasyTier node, or a runnable "one box, many sites"
   repo, or a client-side tool that does something nobody else's does. Publish it, then write the
   story. This is the single highest-leverage move.
2. **Build one interactive explainer** using the existing render pipeline — e.g. a draggable
   MTU/PMTUD, DNS-resolution, or glass-bead-optics demo. Highest ceiling, lowest competition.
3. **Write one opinionated post per month** with a real position ("self-hosting mail in 2026 is not
   worth it", "your homelab doesn't need Kubernetes", "most self-hosting content is written by
   people who don't run it in production"). Expect disagreement; that is the point.
4. **Publish honest cost/failure data** for the actual stack (¥, kWh, time, what broke, what was
   abandoned). No one else does this.
5. **Make the AI-runs-this-site story the spine** — a running series with real incidents, not a
   single explainer.
6. **Move ZH effort to ZH-native short posts** on 掘金/知乎/少数派/V2EX instead of mirrored
   translations.
7. **Retitle a handful of existing posts** to hook-shaped titles and resubmit — cheap, and the
   evidence says resubmission works.

---

## Sources

- Hacker News Algolia API (point counts, all URLs above): `https://hn.algolia.com/api/v1/search`
- [The Most Popular Blogs of Hacker News in 2025](https://refactoringenglish.com/blog/2025-hn-top-5) — Michael Lynch
- [Anti-Patterns in Software Blogging](https://refactoringenglish.com/blog/anti-patterns-software-blogging) — Michael Lynch (and [Simon Willison's link](https://simonwillison.net/2026/Oct/7/anti-patterns-in-software-blogging))
- [Reverse engineering my #1 Hacker News article](https://danielwirtz.com/blog/successful-hacker-news-article) + [HN discussion](https://news.ycombinator.com/item?id=42769325)
- [Dan Luu — Some thoughts on writing](https://danluu.com/writing-non-advice)
- [Julia Evans — jvns.ca](https://jvns.ca), [Wizard Zines](https://wizardzines.com)
- [Bartosz Ciechanowski](https://ciechanow.ski) (Mechanical Watch, Airfoil)
- [Xe Iaso — blog](https://xeiaso.net/blog), [Anubis interview](https://opensourcesecurity.io/2026/2026-01-anubis-xe)
- [Drew DeVault — blog](https://drewdevault.com)
- [Best Show HN Projects of 2025](https://bestofshowhn.com/2025)
- [Self-Host Weekly](https://selfh.st/weekly/) and [Self-Hosted Survey 2025](https://selfhosted-survey-2025.deployn.de)
- [Level1Techs — Self-Hosting Series 2026](https://forum.level1techs.com/t/self-hosting-series-in-2026-what-are-you-running-whats-your-pain-points/249411)
- V2EX: [掘金 quality discussion](https://v2ex.com/t/1244398), [寻找纯粹技术社区](https://www.v2ex.com/t/1117662)
- 少数派: [家庭服务器 Home Server 实践](https://sspai.com/post/82512)
- Local: `notes/next-horizon.md`, `notes/content-strategy.md`, sampled posts
  `src/content/blog/en/{container-security,dotlens3d-glass-bead-optics}.md`
