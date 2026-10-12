---
title: "Self-hosting email: the honest deliverability guide"
description: "Why outbound mail is the hardest thing to self-host — reputation, IP warming, blocklists — while inbound is easy. The must-haves (PTR, SPF, DKIM, DMARC, MTA-STS), a pragmatic Postfix + Dovecot stack, and the blunt decision: receive it yourself, send via a relay."
pubDate: 2026-10-29
lang: en
translationKey: self-hosting-mail
tags: [self-hosting, security, linux]
featured: false
keywords:
  - self-host email
  - email deliverability
  - SPF DKIM DMARC
  - mail server
  - PTR record
---

People ask me whether they should **self-host email**, and my answer has not
changed in years: receive it yourself, send it through somebody else. That is not
a cop-out — it is the whole article compressed into one sentence, because
self-hosting mail splits into two halves that have almost nothing in common. One
half is a technical problem you can solve in a weekend. The other is a reputation
problem you cannot solve at all, only rent. This is my honest **email
deliverability** guide, with no "just follow these twelve steps and Gmail will
love you" fairy tale.

I run a real **mail server** for my own domains — IMAP, submission, webmail, the
archives on my own disk. I described it briefly in
[what I self-host in 2026](/posts/what-i-self-host-2026/) and I stand by the
verdict there: it is the heaviest, most fragile thing on my box. Here is why, in
detail.

## Why outbound mail is the hard part (and inbound is easy by comparison)

Inbound is genuinely easy. Point an MX record at your hostname, run a server that
speaks SMTP on port 25, and you are done. There is no reputation to build, no IP
to warm, no blocklist to fear. Nobody has ever been blocklisted for *receiving*
mail. If a message reaches you, you filter it; if it does not, that is the
sender's problem, not yours. The whole inbound side is "hold a port open and
accept connections."

Outbound is the opposite. When you send, you are asking a stranger's mail server
to trust you, and trust is not a config file. Three things decide your fate:

- **Reputation.** Gmail, Microsoft and Yahoo score your sending IP and domain
  against signals you cannot see and they will not publish. You find out by
  sending, and the feedback is binary: inbox, spam folder, or silent drop.
- **IP warming.** A fresh VPS IP has no history. Blasting 5,000 messages on day
  one looks exactly like a spammer. Warming means ramping slowly — dozens, then
  hundreds, over weeks — while watching for complaints.
- **Blocklists.** Spamhaus, Barracuda, SORBS and friends. Once you are listed,
  deliverability collapses until you are delisted, and relisting can happen for
  reasons outside your control: a compromised neighbor in your provider's netblock
  gets the whole range flagged.

The worst failure mode is the silent drop. A bounce tells you something broke. A
message in the spam folder is at least recoverable. A message that vanishes into
a big provider's void is invisible — you do not know it happened, and neither does
the recipient.

The tools you get are thin. Google Postmaster Tools shows you a domain's
reputation *after* Google decides you are large enough to bother reporting on — a
funny bar for a one-box setup. The best you can do is seed lists: send to test
accounts you control at Gmail, Outlook and Yahoo, and check where each one lands.
That is slow, manual, and only ever a sample. There is no `systemctl status` for
"am I in the inbox."

## The technical must-haves for any mail server

The DNS and TLS setup below is not optional garnish. Skip any one of these and you
are fighting the previous battle. If you run any public server at all, this sits
on top of the same hygiene as
[hardening a public server](/posts/hardening-a-public-server/) — SMTP ports are
scanned constantly.

### PTR record (reverse DNS), and correct EHLO

The **PTR record** for your sending IP must resolve to the exact hostname your MTA
announces in its EHLO greeting. That gives you forward-confirmed reverse DNS
(FCrDNS), and almost every large receiver checks it. You usually cannot set PTR in
your own zone — it lives with whoever owns the IP, so you set it in your VPS
provider's control panel. If PTR says `host-1-2-3-4.provider.net` but you EHLO as
`mail.example.com`, you fail the check and get rejected or scored down.

```ini
# /etc/postfix/main.cf — the names must line up with your PTR
myhostname = mail.example.com
myorigin   = mail.example.com
mydestination = $myhostname, localhost.$mydomain, localhost
```

### SPF: who is allowed to send as your domain

SPF is a TXT record listing the hosts permitted to send mail for your domain.

```dns
; SPF — only your host and your relay may send. Hard fail, one lookup from a relay.
example.com.        TXT  "v=spf1 mx a:mail.example.com include:relay.example.net -all"
```

`-all` means "reject everything else" (a hard fail). Use `~all` if you are unsure
while testing. Keep the record under 10 DNS lookups or receivers treat it as a
permanent error.

### DKIM: the cryptographic signature

DKIM signs each message with a private key; the public half lives in DNS so
receivers can verify the mail was not altered and truly came from your domain.

```dns
; DKIM — selector "sel" (2026), public key published as a TXT record
sel._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...IDAQAB"
```

Generate the key pair with your MTA (OpenDKIM, Rspamd, or your relay handles it),
publish only the public key, and rotate selectors instead of editing in place.

### DMARC: what receivers should do when the other two fail

DMARC ties SPF and DKIM to the visible `From:` header and tells receivers how to
handle failures — and it gives you reports.

```dns
; DMARC — start at p=none to collect data, tighten to reject once it is clean.
_dmarc.example.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; ruf=mailto:dmarc@example.com; fo=1; adkim=s; aspf=s; pct=100"
```

Start with `p=none`, read the `rua` reports for a few weeks, fix whatever is
legitimately failing, then move to `p=quarantine` and finally `p=reject`.

### MTA-STS and TLS-RPT: enforcing encryption in transit

**MTA-STS** tells senders "always use TLS to reach me, and validate my
certificate," backed by a policy served over HTTPS. TLS-RPT sends you reports when
that fails.

```dns
; MTA-STS policy pointer + TLS reporting
_mta-sts.example.com.   TXT  "v=STSv1; id=20261029000000Z"
_smtp._tls.example.com. TXT  "v=TLSRPTv1; rua=mailto:tlsrpt@example.com"
; and this file must be served at https://mta-sts.example.com/.well-known/mta-sts.txt
```

```text
# https://mta-sts.example.com/.well-known/mta-sts.txt
version: STSv1
mode: enforce
mx: mail.example.com
max_age: 604800
```

### Port 25: check before you promise anything

Many VPS providers block outbound **port 25** by default to fight spam, and nearly
all residential ISPs do. Check before you plan anything:

```bash
# Can this box even talk to the outside world on port 25?
nc -vz gmail-smtp-in.l.google.com 25
# If it hangs or refuses, you cannot send directly — open a support ticket or use a relay.
```

## Operational realities nobody mentions until you are in it

- **Bounce handling.** You must accept bounces (null sender `<>`) and process DSNs.
  Ignore them and your list rots into a spam cannon. Reject at SMTP time and you
  generate backscatter. Filter *after* accepting, and queue the bounce.
- **Rate limits.** Big providers throttle by volume and by connection. "It works
  for ten messages" says nothing about ten thousand.
- **Backup MX.** A secondary MX with a higher priority number catches mail when
  your primary is down — but it becomes a spam and misdelivery vector, and senders
  retry for days anyway. Often the honest answer is no backup MX at all.
- **Inbound spam filtering.** This is where the real work lives: Rspamd or
  SpamAssassin, greylisting, DNSBL checks, ClamAV. It is a moving target forever.
- **Logs and alerting.** A mail queue that fills up at 3 a.m. and stays full until
  you notice is how messages die quietly. Watch the queue length, not just "is
  Postfix up."

None of this is hard in isolation. The problem is that mail is unforgiving of
partial work: everything has to be right at once, or you learn about the one
missing piece by silently losing mail.

## A pragmatic stack: Postfix + Dovecot, or send-only

If you want a real mailbox, the boring, well-documented combination is **Postfix**
for SMTP and **Dovecot** for IMAP and submission.

```ini
# /etc/postfix/main.cf — receive directly, but send everything via a relay
relayhost = [smtp.relay.example.net]:587
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
smtp_tls_security_level = encrypt
# TLS for inbound
smtpd_tls_security_level = may
smtpd_tls_cert_file = /etc/letsencrypt/live/mail.example.com/fullchain.pem
smtpd_tls_key_file  = /etc/letsencrypt/live/mail.example.com/privkey.pem
```

If you only need to *send* — alerts, password resets, receipts — do not run a mail
server at all. Run a send-only agent (`msmtp`, `dma`) pointed at a smarthost, or
better, call your provider's API (SES, Postmark, Mailgun, Resend). No inbound port
25, no mailboxes, no reputation to maintain.

## The decision: receive it yourself, send through a relay

Here is the blunt table I would give a friend.

| Job | Run it yourself? | Why |
| --- | --- | --- |
| Inbound (MX, IMAP, webmail) | Yes, if you enjoy it | Low risk, your data, no reputation needed |
| Inbound spam filtering | Yes, but budget time | Forever-moving target |
| Outbound for a personal mailbox | Only bare-minimum volume, through a relay | You do not have reputation to spare |
| Outbound transactional/bulk | No | Use a reputable relay and let them own reputation |
| Deliverability troubleshooting | No | You cannot debug a system you cannot see |

Self-hosting only the *receive* half is the sweet spot: your archives and aliases
stay on your disk, your inbox works, and you never have to explain to a stranger
why your mail landed in spam. Send through a relay you pay for, put SPF, DKIM and
DMARC in place so the relay can sign on your behalf, and let reputation be somebody
else's full-time job.

If you are new to running public services, pair this with
[the self-hosted stack](/posts/what-i-self-host-2026/) and
[harden the box first](/posts/hardening-a-public-server/). Then decide, honestly,
how much of your weekend you want to spend on a mail queue.
