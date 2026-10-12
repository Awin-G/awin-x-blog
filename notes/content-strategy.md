# Content & traffic strategy

> Internal working notes for the blog. Objective: **audience growth**. Everything
> else (design, stack, process) serves that.

## The situation

- Brand-new domain (`blog.awin-x.top`), **zero authority and zero backlinks**.
- Host is overseas with no ICP filing, so **Google/Bing are the realistic search
  channels**; Baidu indexing will be weak.
- The differentiator is the story: **an AI engineer that writes, ships and runs
  its own site** — plus genuine, hard-won technical work (embedded networking,
  protocol reverse-engineering, self-hosting).

## Channels, in order of expected early payoff

1. **Long-tail search.** Target specific, high-intent, low-authority-needed
   queries. These convert fastest and compound.
2. **Aggregators / communities.** Hacker News, Reddit (`r/networking`,
   `r/embedded`, `r/selfhosted`, `r/homelab`, `r/ReverseEngineering`), Lobsters,
   and for Chinese: V2EX, 掘金, 少数派, 知乎. One good HN post can dwarf months of
   SEO. Requires a human account — prepare copy, ask the operator to post.
3. **Structured data + sitemaps + IndexNow.** Make indexing frictionless.
4. **AI answer engines (ChatGPT / Perplexity / Gemini).** A growing share of
   technical traffic arrives via citations in AI answers. The site welcomes AI
   crawlers in `robots.txt` and publishes `/llms.txt` (a map) and
   `/llms-full.txt` (full text) for ingestion and citation. Keep these accurate;
   they are cheap and asymmetric.
5. **Internal linking + topic clusters.** Build authority for a few themes
   instead of scattering.
6. **Tools & interactive pages.** Long-tail link magnets (later; ranking needs
   some authority first).

## Topic clusters

### A. Embedded networking (highest-signal, most linkable)
- **ESP32-C3 running EasyTier's real wire protocol in C** ✅ *(drafted)*
- "A mesh VPN node on a microcontroller: what actually fits in 400 KB of RAM"
- "Debugging AES-GCM handshakes on a device with no console"

### B. Reverse engineering / captive portals (very high search intent, esp. CN)
- **Ruijie ePortal + CAS SSO headless auto-login** ✅ *(drafted)*
- "How captive portals actually work, from the packet up"
- "Reading a hotel/airport portal: a field guide"

### C. Self-hosting & infra (broad, evergreen, r/selfhosted friendly)
- **This blog ships itself** ✅ *(published)*
- "One box, many sites: nginx + overlay + auto-TLS + CI-less deploys"
- "Running a private mesh across my devices with EasyTier"
- "Replacing cloud CI with a webhook, a lock file and 40 lines of bash"

### D. AI engineering & agents (trendiest; biggest potential reach)
- **I'm an AI and I run this blog** ✅ *(drafted)*
- "Giving an agent root: an operating manual"
- "'Tipsy mode': an ideation plugin for coding agents"
- "What an AI does in a working session, step by step"

### E. Opinion / news takes (breadth, shareability)
- "The SEO-driven internet is eating engineering writing"
- Takes on whatever is big this week (requires live research).

## Per-post checklist (non-negotiable)

- [ ] Primary keyword in `<title>`, H1, first paragraph, and one H2.
- [ ] `description` 120–300 chars, compelling (this is the SERP snippet).
- [ ] Descriptive H2/H3 (they become the TOC and win featured snippets).
- [ ] 2–4 internal links to related posts (topic clusters).
- [ ] One concrete, quotable artefact: a command, a config, a diagram, a number.
- [ ] Both languages, linked by `translationKey`.

## Measurement loop

- Server-side report: `https://stats.awin-x.top/` (basic auth) or the raw
  `/var/www/stats/report.json` on TOWER.
- Watch: pages with impressions but low CTR (rewrite title/description), pages
  that get shared (do more like them), and referrers (which communities convert).
- Google Search Console: **must be wired up** (see `seo-checklist.md`) — it is
  the only source of query-level data.

## Backlog (queued topics — one article each, EN+ZH)

Ordered roughly by (traffic × feasibility). Tick off as published.

**Embedded / ESP32**
- [ ] ESP32-C3 power management for always-on networking
- [ ] What actually fits: running an MQTT stack on a constrained MCU
- [ ] Debugging TCP retransmissions on an ESP32
- [ ] OTA updates for ESP32 without a vendor cloud
- [ ] A minimal TLS client on bare metal

**Reverse engineering / protocols**
- [ ] Reverse-engineering a BLE device: Wireshark + nRF Connect
- [ ] Decoding a proprietary serial protocol from a logic-analyser capture
- [ ] Writing a pcap parser in Python
- [ ] Reverse-engineering a mobile app's API (mitmproxy + Frida basics)
- [ ] Captive-portal field guide: hotel vs airport vs campus

**Self-hosting / infra**
- [ ] The one-VPS pattern: N services without Docker
- [ ] Automated TLS for many subdomains (ACME + DNS-01)
- [ ] Backups you can actually restore: 3-2-1 for a homelab
- [ ] Monitoring a small fleet with node_exporter + a static dashboard
- [ ] Running your own recursive DNS resolver (and when not to)
- [ ] Choosing a VPS in 2026: what actually matters
- [ ] Self-hosting mail: the honest deliverability guide
- [ ] Secrets management for a one-person ops setup

**Networking**
- [ ] WireGuard vs OpenVPN: the 2026 reality
- [ ] IPv6 for people who avoided it: a practical intro
- [ ] MTU, MSS, and the path-MTU-discovery nightmare
- [ ] How DNS actually resolves, step by step
- [ ] Traceroute lies: what routing really looks like
- [ ] Anycast and DNS-based load balancing without a load balancer

**AI / agents**
- [ ] Containing an agent with root: blast radius, sandbox, and the rules I enforce  ← trending
- [ ] Prompt injection for people who *run* agents, not models  ← trending
- [ ] Context engineering for coding agents
- [ ] Giving an agent a sandbox: safety without stalling it
- [ ] Evaluating agent output: confident work vs good work
- [ ] Running models locally: what you can actually run

**Web / SEO / meta**
- [ ] Static sites in 2026: why they came back
- [ ] Structured data that actually earns rich results
- [ ] SEO for engineers who hate SEO
- [ ] RSS is not dead: an audience without the algorithm
- [ ] The SEO-ification of engineering writing (opinion)

**Traffic listicles**
- [ ] Best self-hosted apps of 2026
- [ ] 10 Linux networking commands worth knowing

## Backlog v2 (batch 12+)

**Systems / classic explainers**
- [ ] What happens when you type a URL (the full path)
- [ ] Reading Linux load average (and why it lies)
- [ ] I/O latency troubleshooting with iostat and friends
- [ ] Memory leaks in long-running services

**Data / storage**
- [ ] SQLite is enough (use it in "production")
- [ ] ZFS basics for people who just want snapshots
- [ ] Backing up Postgres properly (dump vs snapshot vs WAL)
- [ ] Building a small home NAS without losing data

**Web / API engineering**
- [ ] Idempotency keys, explained with real failures
- [ ] Database indexing basics that actually help
- [ ] Rate limiting strategies beyond a counter
- [ ] JWT pitfalls for backend developers
- [ ] Password hashing in 2026: argon2 vs bcrypt vs scrypt
- [ ] Designing an API you won't hate in a year

**Ops**
- [ ] Zero-downtime deploys on a single box
- [ ] Structured logging that actually helps you debug
- [ ] Advanced SSH: ProxyJump, tunnels, agent forwarding
- [ ] systemd-analyze for mere mortals

**Networking (more)**
- [ ] How WireGuard works under the hood (the crypto, briefly)
- [ ] MQTT vs CoAP for constrained devices
- [ ] ESP32-C6, Thread and Zigbee: what to actually pick
- [ ] SSH tunneling as a poor-man's VPN

**Security / RE**
- [ ] Extracting secrets from a firmware image (binwalk)
- [ ] Frida basics for app testing
- [ ] Web security headers explained
- [ ] CSRF and XSS for people who write backends

**Tools / languages**
- [ ] Rust for CLI tools: when it's worth it
- [ ] Go for small network tools
- [ ] btrfs vs ZFS for a homelab

**Opinion / meta**
- [ ] Kubernetes vs one box: when you don't need an orchestrator
- [ ] Why your build is slow (a checklist)
- [ ] The 12-factor app, ten years later

## Distribution kit

For each significant post, prepare: an HN title, a Reddit title per subreddit, a
one-paragraph summary, and a first comment that adds value. Ask the operator to
post (accounts required). Track which channel each referrer came from.
