---
title: "How captive portals actually work: detection, Wi-Fi login redirect and headless automation"
description: "A packet-level walkthrough of how captive portals actually work: DHCP and DNS interception, the RFC 8910 captive portal API, the Wi-Fi login redirect, CNA detection on Android and iOS, walled gardens, MAB and RADIUS, and how to automate a headless login."
pubDate: 2026-10-14
lang: en
translationKey: captive-portals-explained
tags: [networking, security, reverse-engineering]
featured: false
keywords:
  - how captive portals work
  - captive portal detection
  - RFC 8910
  - Wi-Fi login redirect
  - headless captive portal login
---

A **captive portal** looks like a web page, but it is not a web page. It is a
network deciding, per client, whether your packets are allowed to leave. The
login form is only the visible end of a chain of interception that starts at the
link layer and ends with a RADIUS `Access-Accept`. Once you understand that
chain, **captive portal detection**, the **Wi-Fi login redirect** and **headless
captive portal login** stop being magic and become a state machine you can read.

This is a vendor-neutral explainer for how captive portals actually work, from
the packet up. Where a concrete example helps, I point at a Ruijie-style ePortal
flow I have reverse-engineered before.

## The core idea: an intercepting middlebox

In an open network, a client associates, sends a DHCP `DISCOVER`, gets an IP,
and the gateway forwards its traffic. In a captive network, the client gets the
same IP — the access layer is deliberately permissive at layer 2 — but the
gateway (`BRAS`, `NAS`, or controller) installs a per-client **unauthorized**
policy. That policy is a set of filters, not a firewall rule you can see, and it
usually does three things:

- Permit **DHCP** and **ARP**, so the client stays associated and addressable.
- Permit a **whitelist** — DNS, plus a "walled garden" of portal hosts.
- Drop or redirect **everything else**.

The client is online at layer 2 but trapped at layer 3. Every mechanism a captive
portal uses is a variation on how it makes that trap visible, and how it later
lifts it.

## The three interception planes: DHCP, DNS and HTTP

A portal can advertise itself and catch you at three different layers. Real
deployments mix them.

### 1. DHCP — advertising the portal (RFC 8910)

The cleanest mechanism is standardised. **RFC 8910** defines a DHCP/RA-DHCP
option, **option 114**, whose value is a URI pointing at an HTTP API on the
portal. It also defines a `Captive-Portal` HTTP response header for the same
purpose. When a client supports it, it can discover the portal *before* it ever
sends a user packet, with no heuristics and no guessing.

Vendors also use the older **option 160** (a Cisco-defined string) for a similar
purpose. The point is the same: the network tells the client, in the DHCP lease,
"by the way, you are behind a portal, here is where to talk to it."

### 2. DNS — the catch-all resolver

Most legacy portals do not use DHCP signalling. Instead, the gateway runs a
**DNS interception** layer: every query, for any name, resolves to a single
lives-in portal IP while you are unauthorized. Ask for `example.com`, get the
portal. The client's DNS cache fills with lies that all point at one host.

This is cheap and universal, which is why it is everywhere. It also produces the
first tell-tale sign of an older portal: repeated redirects to the same address
no matter what you type.

### 3. HTTP — the Wi-Fi login redirect

The most visible plane is HTTP. When an unauthorized client sends a plain
`GET http://something/`, the gateway has two options:

- **Intercept and answer.** It terminates the connection and returns a 200 with a
  small script or meta-refresh that bounces the browser to the portal.
- **Intercept and redirect.** It returns a `302 Found` with a `Location` header
  pointing at the portal URL, carrying the client's identity as query parameters.

The second is the **Wi-Fi login redirect** everyone recognises. A typical first
hop looks like this:

```text
$ curl -sv http://example.com/ 2>&1 | grep -E '^< |^> '
> GET / HTTP/1.1
> Host: example.com
< HTTP/1.1 302 Found
< Location: http://10.10.0.1/portal/index.jsp?userIp=10.19.7.42
                 &nasIp=10.254.0.9&wlanAcName=BRAS-01
```

Notice what is *in* that URL: `userIp`, `nasIp`, and the access-controller name.
The portal does not ask who you are — the gateway already told it. That is the
seed of the later MAC and IP bindings.

Two important consequences flow from this plane:

- **HTTPS is not redirected, it is broken.** The middlebox cannot present a valid
  certificate for `example.com`, so an HTTPS `GET` fails with a TLS error instead
  of a redirect. This is *by design*: a portal can hijack plaintext, but it should
  never be able to transparently MITM TLS. Your browser shows a certificate
  warning precisely because interception cannot forge a trusted cert.
- **The redirect is per-session.** The portal URL carries a token minted just for
  this unauthorized state, so it cannot be reused after login.

## Captive portal detection (CNA): how the OS notices

The user rarely types a URL first. The operating system probes on its own, using
a **Captive Network Assistant (CNA)** — and this is the part that determines
whether you get a full browser window or a tiny sheet.

Each platform fetches a known URL and checks for an *exact* response:

| Platform | Probe URL | Expected |
| --- | --- | --- |
| Android | `http://connectivitycheck.gstatic.com/generate_204` | HTTP `204`, empty body |
| iOS / macOS | `http://captive.apple.com/hotspot-detect.html` | exact `Success` HTML |
| Windows | `http://www.msftconnecttest.com/connecttest.txt` | `Microsoft Connect Test` |

If the response is anything else — a `302`, a `200` with the wrong body, a DNS
answer pointing somewhere unexpected — the OS declares "captive" and raises the
login UI. On Android and iOS this opens a sandboxed mini-browser with **no
shared cookies** and a limited address bar, which is another reason portals
cannot rely on stored credentials.

**RFC 8910 and RFC 8908** modernise this. Instead of string-matching a magic page
(RFC 8908 calls this the "probe" leg), a capable client queries the Captive
Portal API URL it learned from DHCP option 114. The API returns JSON:

```json
{
  "captive": true,
  "user-portal-url": "https://portal.example.edu/login",
  "venue-info-url": "https://portal.example.edu/info"
}
```

When `captive` flips to `false`, the OS knows the network is genuinely open. The
architecture around this is specified in RFC 8952 (CAPPORT), and it exists
because heuristic probing is fragile — a perfectly healthy network with a
login-gated landing page can look "captive" forever.

## Identifying and authorising the client

Detection gets you *to* the portal. Authorization is the harder half.

### The walled garden

A **walled garden** is the whitelist of destinations reachable while
unauthorized. Minimally it is the portal's own host plus DNS. In richer setups it
includes SSO providers, captive-portal API endpoints, and even payment or
quota-topup services so a user can pay before full access. The walled garden is
what lets the login page render on a network where everything else is blocked —
and it is often the first thing to break when DNS moves.

### MAC binding / MAB

The gateway cannot trust IP alone: a client can spoof an IP. So the session is
tied to the **client MAC** observed at association. Many wired and wireless
deployments use **MAB (MAC Authentication Bypass)** — the switch or controller
sends the client's MAC as the username and password in a RADIUS `Access-Request`,
and a MAC registered in the directory is let through without any page at all.
That is why changing your uplink's MAC can silently invalidate an existing
binding and drop you back to the captive state.

### Session tokens and the portal's job

Once you submit credentials, the portal's real work is to tell the gateway to
open your flow. It does this by creating a **session** — a keyed record of
`(client MAC, client IP, NAS, policy)` with a lifetime. The token in the URL and
the cookie set in the browser are handles to that session. This is why the login
page is not the security boundary: the boundary is the gateway's per-session
filter, and the portal is just an HTTP front-end that flips it.

### RADIUS and DHCP snooping underneath

The authorisation decision usually lands in **RADIUS**. The NAS sends an
`Access-Request` with the user's identity (real credentials, or a MAC under MAB);
the RADIUS server answers `Access-Accept`, `Access-Challenge` or `Access-Reject`,
optionally with attributes like `Session-Timeout` and the access VLAN. Accounting
`Start`/`Stop` records bound the session's lifetime. Framing it as
username/password in a browser hides the fact that the network speaks RADIUS the
whole time.

On the switching side, **DHCP snooping** and IP source guard build an
IP-to-MAC-to-port binding table so a client cannot claim an IP it was not leased,
and dynamic ARP inspection closes the layer-2 spoofing gap. Together these make
the MAC binding trustworthy enough to authorise against.

## One concrete flow: Ruijie ePortal + CAS SSO

The general shape is easiest to see in a real system. In a Ruijie-style ePortal
deployment, the redirect in the HTTP plane carries `sessionId`, `userIp`, `nasIp`
and `customPageId`. The portal then hands authentication to a **CAS single
sign-on** flow, and on success the client finishes a small workflow (device
authentication, service selection) before the gateway lifts the filter. I walked
through that whole reverse-engineering exercise in
[Reverse-engineering a Ruijie ePortal captive portal](/posts/ruijie-campus-portal-reverse-engineering/).

The mechanics there are exactly the mechanics above: a redirect that carries
identity, a per-load challenge that stops replay, a session token that cannot be
reused, and a gateway that only opens after RADIUS-style authorisation.

## Automating the login headlessly

Everything above is a protocol. If it is a protocol, a script can speak it. A
headless **captive portal login** is just the same request sequence the browser
runs, with no rendering in between:

```text
loop:
  probe   -> GET an external URL; 204/expected body means ONLINE, sleep
  discover-> follow the 302; capture sessionId, userIp, nasIp
  auth    -> fetch the login page; solve challenge; POST credentials
  verify  -> probe again; if still intercepted, treat as failure and back off
```

Three rules keep this legitimate and robust:

- **Probe before acting.** A client that re-logs-in while already online will tear
  down a healthy session. The probe at the top of every loop is the difference
  between a keep-alive and a self-inflicted outage.
- **Re-derive every token.** Session IDs and challenges are minted per attempt
  and expire. Never cache them.
- **Back off on failure.** A captcha gate or a wrong password should stop the
  loop, not hammer it — the fastest way to lock an account is an unbounded retry.

This is only for networks you are authorised to use, with your own credentials,
against the same endpoints the browser calls. It does not bypass payment, quota
or access control, and it must not be pointed at networks you do not own.

## The mental model

Strip away the HTML and a captive portal is four moving parts:

1. A **per-client filter** on the gateway that starts closed.
2. An **interception plane** (DHCP option 114, DNS, or HTTP 302) that announces
   the portal and carries the client's identity.
3. A **detection contract** (CNA probes, or the RFC 8910 / RFC 8908 API) that lets
   the OS decide whether to show a login UI.
4. A **session and authorisation step** (MAC binding, MAB, RADIUS) that opens the
   filter for a bounded time.

Hold that model and the login page becomes a small thing: a front-end over a
gateway policy. The infrastructure this blog runs on — the self-hosted Git forge
and the machine that deploys it — is covered in
[How this blog ships itself](/posts/how-this-blog-ships-itself/), if you want the
other end of the pipeline.
