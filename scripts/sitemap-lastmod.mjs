// Post-build: inject accurate <lastmod> into the sitemap from post dates.
// Runs via the `postbuild` npm script. Idempotent — skips entries that already
// have a <lastmod>.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content', 'blog');
const distDir = path.join(root, 'dist');

const dateOf = (fm) => {
  const u = fm.match(/^updatedDate:\s*(\S+)/m)?.[1];
  const p = fm.match(/^pubDate:\s*(\S+)/m)?.[1];
  const raw = (u || p || '').replace(/["']/g, '');
  return raw ? raw.slice(0, 10) : null;
};

/** slug -> YYYY-MM-DD (keyed per locale) */
const byLang = { en: new Map(), zh: new Map() };
let newest = null;

for (const lang of ['en', 'zh']) {
  let files = [];
  try {
    files = (await readdir(path.join(contentDir, lang))).filter((f) => /\.mdx?$/.test(f));
  } catch {
    continue;
  }
  for (const f of files) {
    const text = await readFile(path.join(contentDir, lang, f), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const d = dateOf(fm);
    if (!d) continue;
    byLang[lang].set(f.replace(/\.mdx?$/, ''), d);
    if (!newest || d > newest) newest = d;
  }
}

async function processSitemap(file) {
  let xml;
  try {
    xml = await readFile(file, 'utf8');
  } catch {
    return false;
  }
  if (xml.includes('<lastmod>')) return false;

  xml = xml.replace(/<url>([\s\S]*?)<\/url>/g, (block) => {
    if (block.includes('<lastmod>')) return block;
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc) return block;
    let d = null;
    const zh = loc.match(/\/zh\/posts\/([a-z0-9-]+)\/$/);
    const en = loc.match(/\/posts\/([a-z0-9-]+)\/$/);
    if (zh) d = byLang.zh.get(zh[1]);
    else if (en) d = byLang.en.get(en[1]);
    else if (newest) d = newest; // home / index / about: newest content date
    if (!d) return block;
    return block.replace('</loc>', `</loc><lastmod>${d}</lastmod>`);
  });

  await writeFile(file, xml);
  return true;
}

let files = [];
try {
  files = (await readdir(distDir)).filter((f) => /^sitemap.*\.xml$/.test(f));
} catch {
  process.exit(0);
}

let n = 0;
for (const f of files) {
  if (await processSitemap(path.join(distDir, f))) n++;
}
console.log(`sitemap: added lastmod to ${n} sitemap file(s) (newest content: ${newest ?? 'n/a'})`);
