---
title: "XSS and CSRF for backend engineers: output encoding, SameSite cookie, CSP"
description: "XSS and CSRF for backend engineers: the three flavours of XSS, why context-aware output encoding beats a generic escape(), Content-Security-Policy as defence in depth, why cookies make you vulnerable to CSRF, SameSite cookie behaviour, CSRF tokens, and why an XSS defeats them."
pubDate: 2026-11-20
lang: en
translationKey: csrf-and-xss
tags: [security, devops, python]
featured: false
keywords:
  - CSRF
  - XSS
  - output encoding
  - SameSite cookie
  - Content-Security-Policy
---

Every backend engineer eventually gets the two-attack briefing, usually as acronyms to tick off a compliance sheet. Here is the version I wish I had early. **XSS** (cross-site scripting) is about what *you* put into the page: it turns your own origin into an attacker's execution environment. **CSRF** (cross-site request forgery) is about what the *browser* attaches to a request you never intended: it turns your session into the attacker's credential. The fixes are different enough that doing one well buys nothing on the other. **Output encoding** kills XSS; a **SameSite cookie** and **CSRF tokens** kill CSRF. And one XSS quietly deletes your entire CSRF defence.

## The three flavours of XSS

All XSS is the same bug — untrusted data treated as code by the browser — but *where* the data lands changes who gets hit and where you fix it.

### Reflected XSS

The payload travels in the request and bounces back in the response: a search page echoing `?q=<script>…</script>` into its results. The attacker must get a victim to click a crafted link (phishing, a shortened URL), so exploitation needs delivery. Fix at the sink — encode the value for the context it lands in.

### Stored XSS

The payload is saved — a comment, a display name, a filename — and served to everyone who later loads the page. No per-victim link is needed, so this is the dangerous one: one poisoned record is a landmine for every reader, admins included. Fix it on the way *out*, by encoding at render.

### DOM XSS

The server never sees the payload. Client-side JavaScript reads an attacker-controlled source (`location.hash`, `postMessage`, `document.referrer`) and hands it to a dangerous sink (`innerHTML`, `eval`, `document.write`). Because the bug lives in the browser, server-side escaping cannot touch it. Keep sources away from sinks: use `textContent` and the `URL` API instead of `innerHTML`.

## The real fix: context-aware output encoding

"Encode your output" is the whole rule, and the word carrying the weight is **context**. HTML has several parsing contexts, each with a different escape, so a value is only safe relative to where it is inserted:

- **HTML text** — `<h1>{{ name }}</h1>` — encode `&`, `<`, `>`.
- **HTML attribute** — `<a title="{{ t }}">` — encode `&`, `<`, `>`, `"`, and always quote the attribute.
- **URL** — `<a href="{{ url }}">` — percent-encode, and allow-list the *scheme*.
- **JavaScript** — inside `<script>` or an `on*` handler — use a JSON encoder, not HTML escaping.
- **CSS** — rare, but a context of its own; avoid interpolating user data at all.

The practical version: let a real template engine do it.

```python
# VULNERABLE — one string, four contexts, no single encoder fits them all.
from flask import Flask, request
app = Flask(__name__)

@app.get("/hi")
def hi():
    name = request.args.get("name", "")
    return (
        f'<h1>Hi {name}</h1>'
        f'<div class={name}>profile</div>'
        f'<a href="/u?name={name}">me</a>'
        f'<script>var user = "{name}";</script>'
    )
```

```python
# FIXED — the template engine owns the HTML and JavaScript contexts.
from flask import Flask, render_template
app = Flask(__name__)

@app.get("/hi")
def hi():
    return render_template("hi.html", name=request.args.get("name", ""))
```

```html
<!-- templates/hi.html — autoescape is ON; {{ }} encodes text and attributes -->
<h1>Hi {{ name }}</h1>
<div class="{{ name }}">profile</div>
<a href="{{ url_for('me', name=name) }}">me</a>
<script>var user = {{ name | tojson }};</script>
```

Two different encoders on one page: `{{ name }}` HTML-encodes, `{{ name | tojson }}` serialises to JavaScript. That difference *is* the lesson.

### Why escaping the wrong context fails

People reach for one helper — usually an HTML escaper — and assume it covers everything. It does not:

- **URLs.** `href="{{ url }}"` with `url = javascript:alert(document.cookie)` is fully HTML-escaped and still runs on click; the colon and letters are ordinary characters. Only scheme allow-listing helps.
- **Unquoted attributes.** `<div class={{ name }}>` with `name = x onmouseover=alert(1)` injects a whole new attribute, because HTML escaping never removes the space.
- **JavaScript strings.** HTML-escape a value into `<script>var x = "{{ name }}";</script>` and the entities are not decoded inside a script block — the browser sees a literal `&quot;`, the string is now wrong, and the temptation is to `|safe` it, which removes the escaping entirely.

`escape()` is not a spell; it is one encoder for one context. Match the encoder to the sink, and when the framework has a helper for that sink, use it and stop hand-rolling.

## Content-Security-Policy is the seatbelt, not the brakes

Even with perfect encoding, one missed sink or one new template is another bug. **Content-Security-Policy** is defence in depth: a header telling the browser which script sources it may run, so an injected `<script>` fails even when your escaping did not. It does not replace encoding — a CSP that needs `unsafe-inline` protects nothing — but it turns "one XSS is script execution in the browser" into "a blocked request and a violation report".

```nginx
# Ship a strict policy; run report-only first, then enforce the same string.
add_header Content-Security-Policy "default-src 'none';
    script-src 'self';
    style-src 'self';
    img-src 'self' data:;
    connect-src 'self';
    base-uri 'none';
    form-action 'self';
    frame-ancestors 'none';
    object-src 'none';
    upgrade-insecure-requests" always;
```

`script-src 'self'` with no `unsafe-inline` and no `unsafe-eval` is the line that does the work: attacker inline scripts are refused. If the app must emit inline scripts, give each a per-request **nonce** and list it — do not open the door with `unsafe-inline`. I go deeper on the surrounding headers, the nginx `add_header` inheritance trap, and how to test all of it in [web security headers](/posts/web-security-headers/).

## CSRF: your cookie is the vulnerability

The web's authentication model is "the browser attaches your cookies to every request to a site, automatically, no matter who caused the request". That is what makes sessions work — and exactly what CSRF abuses. The attacker does not need to *read* your cookie; they need your *browser* to send it. A form on `evil.example` auto-submits `POST https://bank.example/transfer`, the browser helpfully attaches the session cookie because it is a normal cross-site request, and the transfer goes through.

Two things to internalise:

- **It is about state changes.** Reading data cross-origin runs into the same-origin policy; submitting a form does not. So the damage is in actions: transfer, delete, change email, change password.
- **`SameSite` is the browser's default answer now.** Modern browsers default cookies to `SameSite=Lax`, blocking cookies on cross-site `POST` — the most common CSRF shape. That default saves a lot of code; still do not rely on it blindly.

### SameSite cookie: the one-line fix with caveats

A **SameSite cookie** declares when the browser may attach it to a cross-site request:

- `Lax` — sent on top-level navigations (clicking a link), but not on cross-site `POST`s or subresources. The right default for a session cookie.
- `Strict` — never sent cross-site at all. Strongest, but it breaks flows that arrive via an external link and already need the session (an OAuth redirect can land the user logged out).
- `None` — sent everywhere, so it must be paired with `Secure`; needed when a third party legitimately requires your cookie.

```python
# Session cookie: the attributes matter as much as the value.
response.set_cookie(
    "session",
    token,
    httponly=True,          # JavaScript cannot read it — limits XSS damage
    secure=True,            # never sent over plain HTTP
    samesite="Lax",         # not attached to cross-site POSTs
    max_age=60 * 60 * 24 * 7,
)
```

`SameSite=Lax` alone covers the classic form and `fetch` forge for most apps. It does not cover old browsers, the `None` cookies you had to set, or the *sibling subdomain* case, where `evil.yourdomain.example` can send same-site requests. For a real guarantee you want tokens too.

### CSRF token: the thing that proves intent

A **CSRF token** is a random value tied to the session, embedded in a page the attacker cannot read, and required on every state-changing request. The forged request cannot include it, because the same-origin policy stops the attacker reading your HTML. Generate it at login, store it with the session, render it into every form, send it as a header for XHR, and compare in constant time.

```python
import secrets
from hmac import compare_digest

def check_csrf(request, session):
    sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    expected = session.get("csrf_token")
    # compare_digest avoids a timing side channel on the comparison itself.
    if not sent or not expected or not compare_digest(sent, expected):
        return False
    return True
```

The detail people skip: **bind the token to the session** — a token valid for anyone is no better than none — and make it unpredictable (`secrets.token_urlsafe(32)`, not a hash of the user ID).

### Why "we use JSON APIs" is not automatically safe

This is the myth worth killing. Moving a request to `Content-Type: application/json` does shift it from "simple" to "requires preflight" in CORS terms, and a cross-site `fetch` with a custom content type triggers an `OPTIONS` your server can refuse. But:

- **A form can still post.** HTML forms send only `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain` — never JSON. So if the endpoint accepts form-encoded bodies, or you never actually require the JSON content type, preflight is not in the picture at all.
- **`text/plain` is a bypass.** A form with `enctype="text/plain"` sends JSON-shaped bytes without triggering preflight; a lenient parser accepts them.
- **CORS is a browser read rule**, not server-side CSRF protection. `curl` and other servers ignore it completely.

A token is the only thing that actually asserts user intent, and it is cheap.

## An XSS defeats CSRF tokens, so XSS is the bigger fish

Here is the interaction that orders your priorities.

<figure>
<svg viewBox="0 0 660 150" width="100%" role="img" aria-label="An XSS payload becomes script running as your origin, reads the CSRF token from the page, and sends a valid forged request that the server accepts.">
  <defs>
    <marker id="xss-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.5" fill="none" opacity="0.55">
    <rect x="8"   y="52" width="120" height="52" rx="8"/>
    <rect x="166" y="52" width="150" height="52" rx="8"/>
    <rect x="354" y="52" width="130" height="52" rx="8"/>
    <rect x="522" y="52" width="130" height="52" rx="8"/>
    <path d="M128 78 H166" marker-end="url(#xss-arrow)"/>
    <path d="M316 78 H354" marker-end="url(#xss-arrow)"/>
    <path d="M484 78 H522" marker-end="url(#xss-arrow)"/>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="12.5">
    <text x="68"  y="74" text-anchor="middle">XSS sink</text>
    <text x="68"  y="92" text-anchor="middle">on your origin</text>
    <text x="241" y="74" text-anchor="middle">script runs</text>
    <text x="241" y="92" text-anchor="middle">as your origin</text>
    <text x="419" y="74" text-anchor="middle">CSRF token</text>
    <text x="419" y="92" text-anchor="middle">read from the page</text>
    <text x="587" y="74" text-anchor="middle">valid forged</text>
    <text x="587" y="92" text-anchor="middle">request accepted</text>
  </g>
  <g fill="currentColor" font-family="system-ui, sans-serif" font-size="11.5" opacity="0.7">
    <text x="68" y="34" text-anchor="middle">attacker payload</text>
  </g>
</svg>
<figcaption>An XSS runs in the victim's browser <em>as your origin</em>, so it can read the CSRF token from the page itself and send a request the server has no reason to reject. An <code>httpOnly</code> cookie does not save you — the script never needed the cookie, only the same-origin context.</figcaption>
</figure>

Walk it through: the attacker finds one XSS sink on your origin. They do not need to steal the cookie — it is `httpOnly`, good — because their script now executes *as your origin* in the victim's browser. It reads the CSRF token out of the page, reads the double-submit cookie if you left it readable, and issues a same-origin `fetch` with a valid token attached. Every CSRF defence you built assumed the attacker could not read your page. XSS is exactly the bug that lets them. That is why XSS comes first, and why CSP is non-negotiable: an XSS is not one bug, it is a skeleton key that disarms the rest of your defences — and it can exfiltrate data directly, which CSRF never can.

## Hardening checklist

- **Cookies:** `httpOnly` + `Secure` + `SameSite=Lax` (or `Strict`) on the session cookie.
- **Content-Security-Policy:** strict, no `unsafe-inline`/`unsafe-eval`, nonce the inline scripts you truly need, Report-Only until the reports are clean.
- **Encode output, per context:** HTML, attribute, URL, JS, and CSS each get the right encoder; leave template autoescaping on.
- **Validate input** for correctness, but never confuse it with output encoding; serve files with `X-Content-Type-Options: nosniff`.
- **CSRF tokens** on every state-changing request, bound to the session, constant-time compared, plus an explicit `Content-Type` check.
- **Don't roll your own:** use the framework's engine, session cookie, CSRF middleware, and password hashing.

XSS and CSRF look like a matched pair, but they are ranked: fix XSS first, because it deletes CSRF protection and exfiltrates data on its own. With context-aware output encoding, a strict CSP, and a `SameSite`-plus-token CSRF defence, the two bugs that most often turn a small app into a breach are closed. It stacks on the [headers](/posts/web-security-headers/) and [server hardening](/posts/hardening-a-public-server/) I already run.
