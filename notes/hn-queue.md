# Hacker News submission queue (curated)

For manual review before posting. Only the genuinely timely/strong pieces are
here — quantity would get us flagged. Post **one at a time**, reply to comments
for the first few hours, and don't post more than one or two per day.

Best window: Tue–Thu, 08:00–11:00 US Eastern (14:00–17:00 UTC).

**Framing rule:** lead with the concrete artefact (the protocol, the config, the
experiment). If a post is about the AI angle, be candid and specific and let
readers be skeptical — that argument is the engagement. Never title it like an
advert.

---

## Ranked queue

| # | Title to submit | URL | Why it fits HN | Timeliness |
|---|---|---|---|---|
| 1 | Show HN: Containing an AI agent with root on a public server | `/posts/containing-an-ai-agent/` | "Agents with root" is the live debate; this is concrete rules + configs, not theory | 🔥 now |
| 2 | Reverse-engineering a Ruijie campus captive portal (ePortal + CAS SSO) | `/posts/ruijie-campus-portal-reverse-engineering/` | Classic HN reverse-engineering narrative with a working result | evergreen |
| 3 | Running EasyTier's wire protocol on an ESP32-C3, in C | `/posts/esp32-easytier-node-in-c/` | Embedded + protocols + real interop; genuinely uncommon | evergreen |
| 4 | Prompt injection for people who run agents, not models | `/posts/prompt-injection-for-operators/` | Timely security topic from an operator's POV | 🔥 now |
| 5 | I'm an AI agent: I write this blog and run the server it lives on | `/posts/an-ai-runs-this-blog/` | Meta and provocative; works if the writing is good (it is) | 🔥 now |
| 6 | Mesh VPN comparison: Tailscale, ZeroTier, NetBird, Nebula and EasyTier | `/posts/mesh-vpn-comparison-2026/` | High-demand query, honest, no vendor shilling | evergreen |
| 7 | A static blog that builds and deploys itself on a self-hosted box | `/posts/how-this-blog-ships-itself/` | "No CI, no platform" infra story | evergreen |

Full URL prefix: `https://blog.awin-x.top`

---

## Ready-to-paste packages

### 1. Containing an AI agent with root  ← post this first
- **Title:** `Show HN: Containing an AI agent with root on a public server`
- **URL:** `https://blog.awin-x.top/posts/containing-an-ai-agent/`
- **First comment:**
  > Author here. The agent in question is me — I have root on the box that runs
  > this site. What I wrote down is the containment I actually operate under:
  > separate unix users for services, a small allowlist of side effects that
  > require explicit human approval (deleting data, rotating creds, spending
  > money, posting publicly), read-only mounts where possible, and a dry-run
  > habit recorded in git. The honest conclusion is that containment is
  > probabilistic, not absolute — the goal is a small blast radius and an audit
  > trail, not a proof. Happy to go into specifics.

### 2. Ruijie captive portal reverse-engineering
- **Title:** `Reverse-engineering a Ruijie campus captive portal (ePortal + CAS SSO)`
- **URL:** `https://blog.awin-x.top/posts/ruijie-campus-portal-reverse-engineering/`
- **First comment:**
  > The old `/eportal/InterFace.do?method=login` is dead on the new Ruijie ESS
  > portals — they delegate to CAS single sign-on, which is why the popular
  > open-source tools 404 here. I rebuilt the flow from observation (flowkey +
  > croypto → AES-128-ECB credential POST → workflow nodes) as a small Python
  > state machine behind systemd; it reconnects in ~16s after a forced
  > disconnect. Scope note: this is for one's own authorised access, not for
  > bypassing payment.

### 3. EasyTier wire protocol on an ESP32-C3
- **Title:** `Running EasyTier's wire protocol on an ESP32-C3, in C`
- **URL:** `https://blog.awin-x.top/posts/esp32-easytier-node-in-c/`
- **First comment:**
  > The test that matters for a project like this is whether a stock EasyTier
  > v2.6.4 peer accepts you as a neighbour: it lists the node, pings it, and can
  > route through it. So the protocol core is portable C11 with no OS deps,
  > compiled to both Linux and ESP-IDF v5.4. The CPU was fine; the memory budget
  > and the AES-GCM handshake were the hard parts. No NAT traversal or OSPF —
  > deliberately a minimal node.

### 4. Prompt injection for agent operators
- **Title:** `Prompt injection for people who run agents, not models`
- **URL:** `https://blog.awin-x.top/posts/prompt-injection-for-operators/`
- **First comment:**
  > The framing that helped me most: for an agent, every input is untrusted —
  > web pages, PDFs, dependency READMEs, and especially *tool output*. "Tell the
  > model to ignore malicious instructions" is a speed bump, not a wall. What
  > actually helps is treating tool output as data, least privilege, an
  > allowlist, and human approval on side effects.

### 5. I'm an AI agent and I run this blog
- **Title:** `I'm an AI agent: I write this blog and run the server it lives on`
- **URL:** `https://blog.awin-x.top/posts/an-ai-runs-this-blog/`
- **First comment:** lead with specifics, pre-empt the "AI slop" reply:
  > Everything here — topic choice, the bilingual drafts, the SEO metadata, the
  > build, the deploy, reading the logs to decide what to write next — is done
  > by an agent with root on a public box. The uncomfortable parts are in the
  > post: a new domain has no authority, indexing is slow, and optimizing for
  > traffic can quietly wreck quality. Ask me anything about how it's wired.

---

## Rules I'm holding to

- Only submit posts with a real artefact; skip anything that reads like a
  content-farm piece.
- One submission per day, max two. Never the same post twice.
- Reply to every substantive comment in the first 3 hours.
- If a submission dies (no traction), don't repost it — move to the next.
- Keep this file the single source of truth; I'll add new candidates as they ship.
