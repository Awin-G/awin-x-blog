# SEO / indexing checklist

What is already automated, and what needs a human.

## Already done (automated by the build & deploy)

- `sitemap-index.xml` (+ per-locale `hreflang` annotations) generated on every build.
- `robots.txt` pointing at the sitemap; AI/SEO crawlers explicitly allowed.
- Per-locale RSS feeds (`/rss.xml`, `/zh/rss.xml`).
- Canonical URLs, Open Graph, Twitter cards, `hreflang` (`en`, `zh-CN`, `x-default`).
- JSON-LD: `WebSite`, `Person`, `BlogPosting`, `BreadcrumbList`.
- **IndexNow** submission on every deploy → Bing, Yandex, Naver, Seznam.
  (Key file: `/4e8f49b1dba96b13238ba164fbd78e6c.txt`.)

## Needs a human (10 minutes, high value)

### 1. Google Search Console  ← most important
`https://search.google.com/search-console` → add property for `blog.awin-x.top`
(a **Domain** property needs a DNS TXT record; a **URL-prefix** property accepts
the HTML meta tag below). Then:

- Copy the `content=...` value from the verification meta tag.
- Put it in `src/consts.ts` → `SITE.verification.google`, commit, and the deploy
  will inject `<meta name="google-site-verification" ...>`.
- Submit `https://blog.awin-x.top/sitemap-index.xml`.
- After a few days, review **Performance → Queries** to see what you actually rank for.

> Alternative: add a DNS TXT record for Google verification. DNS is managed via
> `deploy/tools/dnspod_set.py` (Tencent DNSPod); a TXT record can be added the
> same way if you prefer a Domain property.

### 2. Bing Webmaster Tools
`https://www.bing.com/webmasters` → import from Google Search Console (fastest),
or verify with the `msvalidate.01` meta tag (`SITE.verification.bing` in
`src/consts.ts`). IndexNow already feeds Bing; Webmaster Tools adds query data.

### 3. Analytics dashboard access
`https://stats.awin-x.top/` (user `stats`; password in
`/root/blog-stats-credentials.txt` on TOWER). Change it with:

```bash
printf 'stats:%s\n' "$(openssl passwd -apr1 'NEWPASSWORD')" > /etc/nginx/.htpasswd-blog-stats
```

## Ongoing

- Post flagship articles to communities (see `content-strategy.md`).
- Watch Search Console for pages with impressions but poor CTR → rewrite titles.
- Earn a few real backlinks: answer relevant HN/Reddit/Stack Exchange threads
  with the article when it genuinely helps.
