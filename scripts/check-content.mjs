#!/usr/bin/env node
/**
 * Content gate. Validates every post before it can ship:
 *   - required frontmatter, description length, title length
 *   - lang matches its directory, tags are lowercase ASCII
 *   - every translationKey has BOTH en and zh
 *   - internal post links resolve to real files
 *   - no near-duplicate topics (scripts/lib/similarity.mjs)
 * Exits non-zero on any error. Run: node scripts/check-content.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { list, vec, cosine } from './lib/similarity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content', 'blog');

const errors = [];
const warnings = [];

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}
const scalar = (fm, key) => {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
};

const posts = []; // { lang, slug, fm }
const byLang = { en: new Set(), zh: new Set() };

for (const lang of ['en', 'zh']) {
  let files = [];
  try {
    files = (await readdir(path.join(contentDir, lang))).filter((f) => /\.mdx?$/.test(f));
  } catch {
    errors.push(`missing content directory for locale "${lang}"`);
    continue;
  }
  for (const f of files) {
    const slug = f.replace(/\.mdx?$/, '');
    byLang[lang].add(slug);
    const text = await readFile(path.join(contentDir, lang, f), 'utf8');
    const fm = frontmatter(text);
    if (!fm) {
      errors.push(`${lang}/${f}: no frontmatter`);
      continue;
    }
    const data = {
      title: scalar(fm, 'title'),
      description: scalar(fm, 'description'),
      pubDate: scalar(fm, 'pubDate'),
      lang: scalar(fm, 'lang'),
      translationKey: scalar(fm, 'translationKey'),
      tagsRaw: fm.match(/^tags:\s*\[(.*?)\]/m)?.[1] ?? '',
    };
    if (!data.title) errors.push(`${lang}/${f}: missing title`);
    if (!data.description) errors.push(`${lang}/${f}: missing description`);
    if (!data.pubDate) errors.push(`${lang}/${f}: missing pubDate`);
    if (!data.translationKey) errors.push(`${lang}/${f}: missing translationKey`);
    if (data.title && data.title.length > 120) errors.push(`${lang}/${f}: title > 120 chars`);
    if (data.description && (data.description.length < 20 || data.description.length > 320))
      errors.push(`${lang}/${f}: description ${data.description.length} chars (need 20-320)`);
    if (data.lang !== lang) errors.push(`${lang}/${f}: lang="${data.lang}" != directory "${lang}"`);

    const tags = data.tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of tags) {
      if (!/^[a-z0-9-]+$/.test(t)) errors.push(`${lang}/${f}: tag "${t}" is not lowercase ASCII`);
    }
    posts.push({ lang, slug, data, file: `${lang}/${f}`, text });
  }
}

// duplicate titles within a locale
for (const lang of ['en', 'zh']) {
  const seen = new Map();
  for (const p of posts.filter((x) => x.lang === lang)) {
    const t = (p.data.title ?? '').toLowerCase();
    if (!t) continue;
    if (seen.has(t)) errors.push(`duplicate ${lang} title "${p.data.title}" in ${p.file} and ${seen.get(t)}`);
    else seen.set(t, p.file);
  }
}

// near-duplicate topics (EN only — translations share a topic by design).
// Guard rail: a batch must not re-tell a story the corpus already covers.
{
  const en = posts.filter((p) => p.lang === 'en');
  const recs = en.map((p) => {
    const fm = frontmatter(p.text) ?? '';
    return {
      slug: p.slug,
      title: scalar(fm, 'title') ?? '',
      description: scalar(fm, 'description') ?? '',
      tags: list(fm, 'tags'),
      keywords: list(fm, 'keywords'),
    };
  });
  const vecs = recs.map((r) => vec(r));
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const s = cosine(vecs[i], vecs[j]);
      if (s < 0.68) continue;
      const msg = `near-duplicate topics (${Math.round(s * 100)}%): ${recs[i].slug} ~ ${recs[j].slug}`;
      if (s >= 0.78) errors.push(msg);
      else warnings.push(msg);
    }
  }
}

// translationKey must exist in both locales
const keys = {};
for (const p of posts) {
  const k = p.data.translationKey;
  if (!k) continue;
  keys[k] ??= new Set();
  keys[k].add(p.lang);
}
for (const [k, langs] of Object.entries(keys)) {
  if (!langs.has('en') || !langs.has('zh')) {
    warnings.push(`translationKey "${k}" exists only in: ${[...langs].join(', ')}`);
  }
}

// internal post links must resolve
for (const p of posts) {
  const re = /\]\((\/(?:zh\/)?posts\/[a-z0-9-]+\/)\)/gi;
  for (const m of p.text.matchAll(re)) {
    const url = m[1];
    const zh = url.startsWith('/zh/');
    const slug = url.replace(/^\/zh\/posts\//, '').replace(/^\/posts\//, '').replace(/\/$/, '');
    const target = zh ? byLang.zh : byLang.en;
    if (!target.has(slug)) errors.push(`${p.file}: broken internal link -> ${url}`);
  }
}

for (const w of warnings) console.log(`warn: ${w}`);
if (errors.length) {
  console.error(`\ncontent check FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`content check passed: ${posts.length} posts (${byLang.en.size} en / ${byLang.zh.size} zh)`);
