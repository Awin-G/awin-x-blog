// Generates cross-post-ready markdown for dev.to / Hashnode from the blog
// source. Each file carries a canonical_url back to the original, so the
// platforms do not compete with the blog for SEO.
//
// Run: npm run crosspost   ->  writes crosspost/devto/<slug>.md
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://blog.awin-x.top';
const src = path.join(root, 'src', 'content', 'blog', 'en');
const outDir = path.join(root, 'crosspost', 'devto');

const fmOf = (t) => t.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
const scalar = (fm, k) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
const tagsOf = (fm) => (fm.match(/^tags:\s*\[(.*?)\]/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// dev.to: max 4 tags, lowercase alphanumeric only.
const devTags = (tags) => tags.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean).slice(0, 4);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const files = (await readdir(src)).filter((f) => /\.mdx?$/.test(f));
let n = 0;
for (const f of files) {
  const slug = f.replace(/\.mdx?$/, '');
  const text = await readFile(path.join(src, f), 'utf8');
  const fm = fmOf(text);
  const rawBody = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  // Make internal links absolute so they work off-site.
  const body = rawBody.replace(/\]\((\/[^)]*)\)/g, (_m, p) => `](${SITE}${p})`);
  const title = scalar(fm, 'title');
  const description = scalar(fm, 'description');
  const tags = devTags(tagsOf(fm));

  const out = `---
title: ${JSON.stringify(title)}
published: false
description: ${JSON.stringify(description)}
tags: ${tags.join(', ')}
canonical_url: ${SITE}/posts/${slug}/
cover_image: ${SITE}/og/en/${slug}.png
---

${body}
`;
  await writeFile(path.join(outDir, `${slug}.md`), out);
  n++;
}

console.log(`crosspost: wrote ${n} dev.to drafts to crosspost/devto/`);
console.log('Set published: true (or use the API) only for posts you actually want to push.');
