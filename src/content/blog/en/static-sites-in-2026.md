---
title: "Static sites in 2026: why they came back, and when they're wrong"
description: "Static sites won the content web again thanks to CDNs, Core Web Vitals and a tiny attack surface — but they are not universal. A practical look at the static site generator comeback, Astro vs Hugo, JAMstack limits, and when you genuinely need a server."
pubDate: 2026-10-30
lang: en
translationKey: static-sites-in-2026
tags: [astro, seo, self-hosting]
featured: false
keywords:
  - static site generator
  - static sites 2026
  - Astro vs Hugo
  - JAMstack
  - Core Web Vitals
---

Every few years the web re-invents the wheel, then remembers the wheel was fine.
Right now the wheel is a folder of HTML files, and its name is the **static site
generator**. I build and run [a bilingual blog that ships
itself](/posts/how-this-blog-ships-itself/) on exactly this model, so I have
opinions. **Static sites** are not a nostalgia trip and not a compromise — for a
content site in 2026 they are the *correct* default, and the burden of proof is
on anyone reaching for a server. But "static by default" is not "static
everywhere," and the honest limits matter more than the hype.

Here is the arc, the toolkit, and where I would tell you to stop.

## The arc: static → dynamic CMS → static again

The first web was static by accident. You hand-wrote HTML, uploaded it with FTP,
and that was the job. It did not scale to editors or thousands of pages, so the
dynamic CMS ate it: WordPress, Drupal, Joomla. A database, a PHP runtime, a
theme layer, a plugin ecosystem. For a decade that was *the* way to publish, and
for non-technical editors it still is — nothing has replaced the WordPress
admin screen for a content team.

Then the wheel came back. The **JAMstack** framing (JavaScript, APIs, Markup)
around 2016–2019 said: pre-render the pages at build time, serve them from a
CDN, and push the dynamic parts to APIs or a build step. Gatsby, then Next.js,
then Astro and Hugo made it respectable. The pitch was never "static because
we're nostalgic." It was "static because the output is just files, and files are
the cheapest, fastest, safest thing to serve."

The important shift is *where the data work happens*. It did not disappear — it
moved from request time to build time. That is the whole trick. A page that
needed a database query on every request now needs that query once, at build, and
the result is baked into HTML.

## Why static sites came back

Five forces, roughly in order of how often they actually decide the argument.

### CDNs made "static" mean "global and instant"

A folder of files is trivially cacheable at the edge. There is no origin to warm
up, no cold start, no database connection pool to exhaust. You can put a static
site on any CDN, or on one small VPS behind nginx with `Cache-Control` doing the
work, and get sub-100ms responses worldwide. Dynamic rendering has to fight for
that; static gets it for free because the hard part already happened at build.

### Core Web Vitals and SEO turned speed into a ranking input

Google made page experience a ranking signal, and **Core Web Vitals** became the
scoreboard. Static HTML with zero or minimal JavaScript tends to win LCP, CLS and
INP by construction — there is simply less to go wrong. If your traffic is
organic search, this is not vanity; it is the product. That is why this blog
treats SEO as a [build
artifact](/posts/how-this-blog-ships-itself/) rather than an afterthought:
titles, canonical tags, `hreflang`, sitemaps and JSON-LD are generated per page
where they cannot be forgotten.

### Cost collapsed

A static site can be hosted for the price of a domain and a small box. It can
even be free on generous tiers. No application servers, no managed database, no
per-request compute billed at 3 a.m. by a crawler. For a **content site**, the
economics are not close.

### The security surface shrank to almost nothing

You cannot exploit a request handler that does not exist. No PHP, no plugins, no
admin login, no `?id=` parameter to inject. The most common way a content site
gets owned in 2026 is still a vulnerable CMS plugin — and a static site simply
does not have that class of bug. Fewer moving parts, fewer CVEs. I have written
about [self-hosting without Docker](/posts/self-hosting-without-docker/) for the
same reason: the parts you do not run cannot fall over.

### The "no server to fall over" property

This one is underrated. A dynamic app has uptime you have to defend: process
supervision, memory leaks, restarts, the 2 a.m. page. A static site behind nginx
is a set of files. If nginx is up, the site is up. If the build machine dies,
the *already-deployed* site keeps serving. That decoupling of build from serve is
a reliability property, not just an architecture choice.

## The modern static site generator toolkit

The **static site generator** market has settled into three honest answers,
which is a good sign for everyone.

- **Astro** — content-first, islands architecture, ships zero JS by default and
  adds interactivity only where you ask. Best when you want typed content
  collections, component-based templates, and a path to a few interactive
  islands without re-architecting.
- **Hugo** — a single Go binary, absurdly fast builds, no runtime dependency.
  Best for large sites and CI where build time *is* the constraint, or when you
  want no Node toolchain at all.
- **Eleventy (11ty)** — minimal, unopinionated, template-language-agnostic. Best
  when you want HTML, Markdown and a bit of data and nothing else imposed on you.

### Astro vs Hugo (and Eleventy) at a glance

| | Astro | Hugo | Eleventy |
|---|---|---|---|
| Language / runtime | JS/TS (Node) | Go (single binary) | JS (Node) |
| Build speed (10k pages) | Moderate | Very fast | Fast |
| JS shipped by default | None | None | None |
| Components / islands | Yes, first-class | Partial (shortcodes) | Via plugins |
| Best fit | Content + some interactivity | Huge sites, fast CI | Minimal, no opinions |
| Learning curve | Low–medium | Low (but Go templates) | Low |

My own rule: reach for **Hugo** when build time at scale is the blocker, **Astro**
when the site is content but the pages want real components, and **Eleventy**
when you want to stay close to plain HTML and data. All three produce the same
output — a folder of files — so the migration cost between them is mostly
templates, not architecture.

A minimal static build is genuinely this boring:

```bash
# The whole "deploy" story for a static site generator, roughly:
npm ci
npm run build          # renders every page to ./dist at build time
rsync -a --delete ./dist/ /var/www/site/   # atomic-ish swap served by nginx
```

No application server in that pipeline. That is the point.

## The honest limits

I will not pretend static is free. These are real, and they are the reasons
people bounce off it.

- **No per-user state without JavaScript or the edge.** A logged-in dashboard,
  a cart, a personalised feed — the page cannot vary per visitor unless you add
  client JS or an edge function. Pre-rendering means *one* output for everyone.
- **Build times at scale.** Ten thousand pages is fine; two hundred thousand
  with heavy image processing is a build that runs for a long time and a
  commit-to-live latency you have to manage. Incremental builds help; they do
  not erase the problem.
- **Comments, forms and search are bolt-ons.** Static comments mean a third
  party (or your own API), forms mean an external endpoint, and search means a
  prebuilt index (Pagefind, Lunr) or a hosted service. Each is small, but each
  is a dependency you now own.
- **Content preview and "publish now" lose their button.** Non-technical editors
  feel this most. A CMS or a git-based editor (Decap, Sveltia) can close the gap,
  but it is scaffolding you have to add.

If none of those hurt your project, static wins by default. If one of them is
your *core feature*, static is the wrong tool.

## When dynamic is genuinely required

Static is a default, not a religion. Reach for a server — SSR, a real
application, a database — when the requirement is genuinely dynamic:

- **Authenticated applications.** Anything behind a login with per-user data:
  dashboards, admin tools, SaaS. Auth is state; state needs a runtime.
- **Real-time interaction.** Chat, collaboration, live dashboards, multiplayer.
  WebSockets and subscriptions are servers by definition.
- **Heavy personalisation.** Recommendations, feeds, pricing or content chosen
  per visitor at request time. You *can* fake this at the edge, but past a point
  you are just building a server with extra steps.
- **Frequently changing shared state.** Inventories, booking, anything where two
  people must see the same number right now.

Notice what is *not* on that list: a blog, docs, a marketing site, a portfolio,
most landing pages. Those are content sites, and most content sites do not need
a server.

## SSG vs SSR is the wrong question — "what does the page actually need?"

The **SSG vs SSR** debate is usually framed as a religious war, and it should not
be. The right question is smaller: *does this page's HTML depend on who is asking
or when they ask?*

- If the answer is no — content that is the same for everyone — pre-render it.
  That is SSG, and it is the cheapest thing you can possibly serve.
- If the answer is yes — the page must vary by user or by the second — you need
  a runtime. That is SSR or a client app, and that is fine too.

Most sites are a mix, and the modern answer is to mix them: pre-render the
content, hydrate the one widget that needs state. Astro's islands exist exactly
for this. But reach for that hybrid only when a page has earned it.

## Choose the simplest thing that meets the requirement

The mistake I see most often is not choosing static or dynamic. It is choosing a
distributed system to serve a page that changes once a week. Kubernetes for a
blog is not a flex; it is a liability you now operate.

So my rule is unglamorous: **choose the simplest thing that meets the
requirement, and most content sites don't need a server.** Start with a static
site generator. Serve files from a CDN or one small nginx box. Add an API only
when a feature genuinely needs one. Treat every server as a promise to keep it
alive at 3 a.m.

Static came back because it is the smallest thing that works for the largest
category of sites. That is not a trend. It is just the correct answer, and it
took the industry fifteen years and three framework generations to remember it.
