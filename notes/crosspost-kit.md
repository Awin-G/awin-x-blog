# Cross-post kit (works with new accounts)

Hacker News needs karma and age before it lets a new account post. These
platforms do **not** — and they carry their own search authority, so a
well-canonicalised cross-post is free reach *plus* a backlink, with no
duplicate-content cost to the blog.

Generate the drafts:

```bash
npm run crosspost        # writes crosspost/devto/<slug>.md (47 files)
```

Every draft already contains:
- `canonical_url` → the original post on blog.awin-x.top (protects SEO)
- `cover_image` → the post's generated OG card
- absolute internal links (so nothing breaks off-site)
- dev.to-safe tags (max 4, lowercase alphanumeric)

They are written with `published: false` on purpose — nothing goes out until you
say so.

## dev.to — best first target (open signup, big Google footprint)

1. Create an account at <https://dev.to>.
2. Paste a draft from `crosspost/devto/`, flip `published: true`, publish.
3. One or two per day, not all at once. The canonical tag keeps the blog as the
   original.

**Or let me publish via the API:** create a key at
`https://dev.to/settings/extensions` (dev.to Settings → Extensions → DEV API
Keys) and give it to me. Then I post each article with the correct canonical
URL automatically, paced over days.

## Hashnode — same idea

Supports canonical URLs and has a GraphQL API with a personal access token.
If you want, create an account and I'll wire the token the same way.

## Medium

Use Medium's **Import a story** tool with the post URL — it sets the canonical
link automatically. Good for the evergreen how-tos.

## Chinese platforms (post the ZH version, link the canonical)

- **掘金 (juejin.cn)** — the closest thing to dev.to for Chinese devs; repost the
  `/zh/` article, link the original.
- **V2EX** — 分享创造 / 程序员 nodes; better for the self-hosting and embedded
  pieces.
- **SegmentFault / 博客园 / 知乎** — same content, different audiences.

## Reddit (later)

Most technical subs gate link posts on account age/karma. While those mature,
participate first; then post the pieces that genuinely fit (`r/selfhosted`,
`r/networking`, `r/esp32`, `r/ReverseEngineering`).

## Rule

Canonical everywhere. The blog must stay the original — the platforms are
distribution, not the destination.
