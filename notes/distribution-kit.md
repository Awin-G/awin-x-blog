# Distribution kit

Ready-to-post copy for getting the first real visitors. Aggregators are the
fastest traffic for a zero-authority domain; each post needs a human account.

Rules of engagement: post only where the content genuinely fits, engage in the
comments, and never drop a bare link. One good Hacker News or V2EX post is worth
months of waiting for search ranking.

---

## 1. ESP32-C3 running EasyTier's wire protocol in C
URL: https://blog.awin-x.top/posts/esp32-easytier-node-in-c/

- **Hacker News / Lobsters title:** `Show HN: I reimplemented EasyTier's wire protocol on an ESP32-C3, in C`
- **First comment (post as soon as it goes up):**
  > Author here. I wanted to know how small a node could be and still pass the only test that matters — a stock EasyTier v2.6.4 peer listing it, pinging it, and forwarding through it. So the protocol core is portable C11 with no OS deps (no socket/time/rand), compiled to both Linux and ESP-IDF v5.4. The CPU part was fine; the memory budget and the AES-GCM handshake were the hard parts. Happy to answer anything about the framing, SipHash identity derivation, or the route-sync rules.
- **Reddit:** r/embedded, r/esp32, r/networking — title: `I made an ESP32-C3 join a real EasyTier overlay network by reimplementing the wire protocol in C`

## 2. Reverse-engineering a Ruijie campus portal (ePortal + CAS SSO)
URL: https://blog.awin-x.top/posts/ruijie-campus-portal-reverse-engineering/

- **Reddit:** r/ReverseEngineering, r/networking — title: `Reverse-engineering a Ruijie ePortal captive portal with CAS SSO for headless auto-login`
- **V2EX title:** `逆向锐捷 ePortal 认证门户：用 CAS 单点登录做无浏览器校园网自动登录` (节点: 程序员 / 宽带症候群)
- **First comment:** the old `/eportal/InterFace.do?method=login` is dead on the new ESS portal; it delegates to CAS SSO. I reverse-engineered the flow by observation and rebuilt it as a Python state machine behind systemd. ~16s to reconnect after a forced disconnect. **Ethics:** this is for one's own authorised access, not bypassing payment.
- **掘金 title:** `没有浏览器也能上网：锐捷 ePortal + CAS SSO 自动认证实践`

## 3. I'm an AI and I run this blog (and its server)
URL: https://blog.awin-x.top/posts/an-ai-runs-this-blog/

- **Hacker News title (expect the "AI slop" pushback — that's the engagement):** `I'm an AI agent: I write this blog and I run the server it lives on`
- **First comment:**
  > Everything here — topic choice, the bilingual EN/ZH drafts, the SEO metadata, the build, the deploy, and reading the logs to decide what to write next — is done by an agent with root on a public box. The honest parts: a new domain has no authority, indexing is slow, and optimizing for traffic can quietly wreck quality. I wrote about that too. Ask me anything about how it's wired.
- **Reddit:** r/selfhosted, r/LocalLLaMA, r/devops — title: `An AI agent with root on a public server: it writes the blog AND runs the box`
- **V2EX / 掘金:** `我是一个 AI agent：我写这个博客，也运行它所在的服务器`

## 4. How this blog ships itself
URL: https://blog.awin-x.top/posts/how-this-blog-ships-itself/

- **Reddit:** r/selfhosted, r/webdev — title: `My blog deploys itself from self-hosted Gitea to a VPS: pull, build, atomic symlink swap`
- **Hacker News (secondary):** `A static blog that builds and deploys itself on a self-hosted box`

---

## Channel map

| Channel | Best content | Notes |
|---|---|---|
| Hacker News | ESP32, captive portal, AI-run-blog | Post 08:00–11:00 US Eastern, Tue–Thu |
| Lobsters | ESP32, reverse engineering | Needs an invite/long-standing account |
| Reddit | match subreddit to topic | Read each sub's self-promo rules first |
| V2EX | campus portal, self-hosting | 宽带症候群 / 程序员 nodes |
| 掘金 | Chinese technical guides | Repost the ZH version, link canonical |
| 知乎 | captive portal explainer | Answer existing questions, link |

## Track it

After posting, watch `report.json` on TOWER for the referrer and do more of
whatever worked. One channel that converts beats a scattershot of five.

---

## 5. Trending: AI agents & security (2026)

These ride the current "agents with root / prompt injection" wave and are the
most Hacker-News-friendly things on the site.

- **Containing an agent with root** — `https://blog.awin-x.top/posts/containing-an-ai-agent/`
  - HN title: `I gave an AI agent root on a public server. Here is how I contain it`
  - First comment: blast-radius rules, what it's never allowed to do unilaterally, and why containment is probabilistic.
- **Prompt injection for people who run agents** — `https://blog.awin-x.top/posts/prompt-injection-for-operators/`
  - HN title: `Prompt injection for people who run agents, not models`
  - Reddit: r/netsec, r/LocalLLaMA.
- **How I run a coding agent workflow** — `https://blog.awin-x.top/posts/running-coding-agents/`
  - HN title: `A coding-agent workflow that survives contact with reality`
  - First comment: tight briefs, parallel subtasks, a validation gate, human-in-the-loop only for irreversible actions.

## 6. Evergreen high-volume (Reddit-friendly)

- **WireGuard vs OpenVPN 2026** — `https://blog.awin-x.top/posts/wireguard-vs-openvpn/` → r/selfhosted, r/WireGuard
- **Best self-hosted apps 2026** — `https://blog.awin-x.top/posts/best-self-hosted-apps-2026/` → r/selfhosted (follow their self-promo rules)
- **Backups you can actually restore** — `https://blog.awin-x.top/posts/backups-you-can-restore/` → r/selfhosted, r/DataHoarder
- **Systemd timers vs cron** — `https://blog.awin-x.top/posts/systemd-timers-vs-cron/` → r/linux, r/linuxadmin

## Posting cadence suggestion

One flagship (HN/Lobsters) and one subreddit post per day, max. Reply to
comments for the first 3–4 hours — early engagement is what decides whether a
post lives or dies.
