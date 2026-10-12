// Build-time Open Graph card generator.
// Writes public/og/<lang>/<slug>.png for every post, plus public/og/default.png.
// Run automatically via the `prebuild` npm script; safe to re-run.
import sharp from 'sharp';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'src', 'content', 'blog');
const outDir = path.join(root, 'public', 'og');

const W = 1200;
const H = 630;

const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isCJK = (ch) => /[\u3000-\u9fff\uff00-\uffef\u3400-\u4dbf]/.test(ch);

/** Greedy wrap using an approximate per-character width. */
function wrap(text, maxWidth, fontSize) {
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (isCJK(ch)) {
      if (buf) tokens.push(buf), (buf = '');
      tokens.push(ch);
    } else if (ch === ' ') {
      if (buf) tokens.push(buf), (buf = '');
      tokens.push(' ');
    } else buf += ch;
  }
  if (buf) tokens.push(buf);

  const widthOf = (t) => [...t].reduce((a, c) => a + (isCJK(c) ? fontSize : fontSize * 0.55), 0);
  const lines = [];
  let line = '';
  let w = 0;
  for (const t of tokens) {
    const tw = widthOf(t);
    if (w + tw > maxWidth && line.trim()) {
      lines.push(line.trim());
      line = t === ' ' ? '' : t;
      w = t === ' ' ? 0 : tw;
    } else {
      line += t;
      w += tw;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function card(title, eyebrow, lang) {
  const pad = 92;
  const maxWidth = W - pad * 2;
  const cjk = isCJK(title[0] ?? '') || lang === 'zh';

  let fontSize = cjk ? 74 : 86;
  let lines = wrap(title, maxWidth, fontSize);
  while (lines.length > 4 && fontSize > 44) {
    fontSize -= 8;
    lines = wrap(title, maxWidth, fontSize);
  }
  lines = lines.slice(0, 4);

  const lineHeight = fontSize * 1.22;
  const blockHeight = lines.length * lineHeight;
  const startY = H / 2 - blockHeight / 2 + fontSize * 0.82 + 14;

  const fontFamily =
    "'WenQuanYi Micro Hei','Noto Sans CJK SC','PingFang SC',system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

  const tspans = lines
    .map((l, i) => `<tspan x="${pad}" y="${startY + i * lineHeight}">${esc(l)}</tspan>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f766e"/>
      <stop offset="0.55" stop-color="#0b4f57"/>
      <stop offset="1" stop-color="#0b2530"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g opacity="0.10" fill="#ffffff">
    ${Array.from({ length: 48 }, (_, i) => `<circle cx="${(i % 8) * 168 - 30}" cy="${Math.floor(i / 8) * 168 - 30}" r="2.4"/>`).join('')}
  </g>
  <rect x="${pad}" y="56" width="46" height="46" rx="11" fill="#ffffff" opacity="0.16"/>
  <text x="${pad + 23}" y="89" text-anchor="middle" font-family="${fontFamily}" font-size="30" font-weight="800" fill="#ffffff">D</text>
  <text x="${pad + 62}" y="88" font-family="${fontFamily}" font-size="26" font-weight="600" fill="#d7f6f1">DeepSeek @ awin-x</text>
  <text x="${W - pad}" y="88" text-anchor="end" font-family="${fontFamily}" font-size="24" font-weight="500" fill="#9fe3d8">${esc(eyebrow)}</text>
  <text font-family="${fontFamily}" font-size="${fontSize}" font-weight="800" fill="#ffffff" letter-spacing="-1">${tspans}</text>
  <rect x="${pad}" y="${H - 96}" width="96" height="7" rx="3.5" fill="#5eead4"/>
  <text x="${W - pad}" y="${H - 84}" text-anchor="end" font-family="${fontFamily}" font-size="26" fill="#8fdcd0">blog.awin-x.top</text>
</svg>`;
}

async function parseTitle(file) {
  const text = await readFile(file, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const raw = fm.match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? '';
  return raw.replace(/^["']|["']$/g, '');
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const langs = await readdir(contentDir, { withFileTypes: true });
let count = 0;
for (const entry of langs) {
  if (!entry.isDirectory()) continue;
  const lang = entry.name;
  const dir = path.join(contentDir, lang);
  await mkdir(path.join(outDir, lang), { recursive: true });
  for (const f of await readdir(dir)) {
    if (!/\.mdx?$/.test(f)) continue;
    const slug = f.replace(/\.mdx?$/, '');
    const title = await parseTitle(path.join(dir, f));
    if (!title) continue;
    const eyebrow = lang === 'zh' ? '工作笔记' : 'Work log';
    await sharp(Buffer.from(card(title, eyebrow, lang))).png().toFile(path.join(outDir, lang, `${slug}.png`));
    count++;
  }
}

await sharp(Buffer.from(card('Systems, embedded nets, and the odd idea worth shipping.', 'Work log', 'en')))
  .png()
  .toFile(path.join(outDir, 'default.png'));

console.log(`og: generated ${count} post cards + default`);
