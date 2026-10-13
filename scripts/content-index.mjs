#!/usr/bin/env node
/**
 * Content index + similarity tool.
 *
 * Builds:
 *   notes/content-index.json  machine-readable index of every article
 *   notes/content-index.md    human-readable index (by tag, with counts)
 *
 * Modes:
 *   node scripts/content-index.mjs                 # rebuild the index files
 *   node scripts/content-index.mjs --query "text"  # top-N most similar existing articles
 *   node scripts/content-index.mjs --dupes [N]     # most similar existing pairs (redundancy)
 *   node scripts/content-index.mjs --json          # machine output for query/dupes
 *
 * Purpose: before writing anything, check what already exists so we do not
 * duplicate a topic, and find the right existing posts to link to.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vec, cosine, shared, frontmatter, scalar, list } from './lib/similarity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content', 'blog');
const notesDir = path.join(root, 'notes');

/** Read every post into a compact record. */
export async function loadRecords() {
  const records = [];
  for (const lang of ['en', 'zh']) {
    let files = [];
    try {
      files = (await readdir(path.join(contentDir, lang))).filter((f) => /\.mdx?$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const slug = f.replace(/\.mdx?$/, '');
      const fm = frontmatter(await readFile(path.join(contentDir, lang, f), 'utf8'));
      if (!fm) continue;
      records.push({
        lang,
        slug,
        title: scalar(fm, 'title') ?? '',
        description: scalar(fm, 'description') ?? '',
        pubDate: scalar(fm, 'pubDate') ?? '',
        translationKey: scalar(fm, 'translationKey') ?? slug,
        tags: list(fm, 'tags'),
        keywords: list(fm, 'keywords'),
      });
    }
  }
  return records;
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const JSON_OUT = has('--json');

// Only run the CLI when invoked directly (so check-content can import safely).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const records = await loadRecords();

  if (has('--query')) {
    const q = valOf('--query') ?? '';
    const qv = vec({ title: q, keywords: [], tags: [], description: '' });
    const ranked = records
      .filter((r) => r.lang === 'en')
      .map((r) => {
        const rv = vec(r);
        return { r, score: cosine(qv, rv), shared: shared(qv, rv) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          ranked.map(({ r, score, shared: s }) => ({ slug: r.slug, title: r.title, score: +score.toFixed(3), shared: s })),
          null,
          2,
        ),
      );
    } else {
      console.log(`# closest existing articles to: "${q}"\n`);
      for (const { r, score, shared: s } of ranked) {
        console.log(
          `${(score * 100).toFixed(1).padStart(5)}%  ${r.slug}\n        ${r.title}\n        shared: ${s.slice(0, 12).join(', ') || '—'}`,
        );
      }
    }
    process.exit(0);
  }

  if (has('--dupes')) {
    const n = Number(valOf('--dupes')) || 15;
    const en = records.filter((r) => r.lang === 'en');
    const vecs = en.map((r) => vec(r));
    const pairs = [];
    for (let i = 0; i < en.length; i++) {
      for (let j = i + 1; j < en.length; j++) {
        const s = cosine(vecs[i], vecs[j]);
        if (s > 0.2) pairs.push({ a: en[i], b: en[j], score: s, shared: shared(vecs[i], vecs[j]) });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    const top = pairs.slice(0, n);
    if (JSON_OUT) {
      console.log(JSON.stringify(top.map((p) => ({ a: p.a.slug, b: p.b.slug, score: +p.score.toFixed(3), shared: p.shared })), null, 2));
    } else {
      console.log(`# most similar existing pairs (of ${pairs.length} pairs > 0.2)\n`);
      for (const p of top) {
        console.log(`${(p.score * 100).toFixed(1).padStart(5)}%  ${p.a.slug}  ~  ${p.b.slug}\n        shared: ${p.shared.slice(0, 14).join(', ')}`);
      }
      console.log(`\nmax pair similarity: ${(((top[0]?.score ?? 0) * 100).toFixed(1))}%`);
    }
    process.exit(0);
  }

  const en = records.filter((r) => r.lang === 'en').sort((a, b) => a.slug.localeCompare(b.slug));
  const zh = records.filter((r) => r.lang === 'zh').sort((a, b) => a.slug.localeCompare(b.slug));

  await mkdir(notesDir, { recursive: true });
  await writeFile(
    path.join(notesDir, 'content-index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: { en: en.length, zh: zh.length }, en, zh }, null, 2) + '\n',
  );

  const byTag = new Map();
  for (const r of en)
    for (const t of r.tags) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(r);
    }
  const tagLines = [...byTag.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([t, rs]) => `### ${t} (${rs.length})\n${rs.map((r) => `- ${r.slug} — ${r.title}`).join('\n')}`)
    .join('\n\n');

  const md = `# Content index

> Generated by \`scripts/content-index.mjs\` — do not edit by hand. Rebuild after adding posts.
> Counts: **${en.length} EN / ${zh.length} ZH**. Generated ${new Date().toISOString().slice(0, 10)}.

Use it to (a) avoid duplicating a topic and (b) pick real internal links.

- Find the closest existing articles to a proposed topic:
  \`node scripts/content-index.mjs --query "your proposed title or keywords"\`
- Audit redundancy already in the corpus:
  \`node scripts/content-index.mjs --dupes 20\`

## All articles (EN)

${en.map((r) => `- \`${r.slug}\` — ${r.title}`).join('\n')}

## By tag

${tagLines}
`;
  await writeFile(path.join(notesDir, 'content-index.md'), md);

  console.log(`index: ${en.length} en / ${zh.length} zh → notes/content-index.{json,md}`);
  console.log(`       ${byTag.size} tags`);
}
