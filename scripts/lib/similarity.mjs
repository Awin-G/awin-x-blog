/**
 * Shared text-similarity helpers for content dedup and related-post discovery.
 * Used by scripts/content-index.mjs and scripts/check-content.mjs.
 */

export const STOP = new Set(
  `a an the and or of to in on for with without from into over under is are be been being it its this that these those
   how why what when which who whom you your we our they their he she them us as at by not no do does did done can could
   should would may might must will shall have has had more most much many few less least very just only also than then
   there here about above below between during before after again further once same so too use used using make made get
   got give given take taken one two three first second new old good best better via vs versus part parts thing things
   way ways really quite still even ever never always case cases example examples just like real actually`.split(/\s+/),
);

export function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[`*_>#[\](){}"'“”‘’、。，：；！？·—–/\\|@+^~%$<>=]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]+/g, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Weighted term vector: title and keywords dominate, tags next, description last. */
export function vec(rec) {
  const w = new Map();
  const add = (text, weight) => {
    for (const t of tokenize(text)) w.set(t, (w.get(t) ?? 0) + weight);
  };
  add(rec.title, 3);
  add((rec.keywords ?? []).join(' '), 3);
  add((rec.tags ?? []).join(' '), 2);
  add(rec.description, 1);
  return w;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y) dot += x * y;
  }
  for (const [, y] of b) nb += y * y;
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function shared(a, b) {
  const out = [];
  for (const t of a.keys()) if (b.has(t)) out.push(t);
  return out.sort();
}

/** Parse the frontmatter block out of a markdown file's text. */
export function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

export function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

export function list(fm, key) {
  const inline = fm.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm'));
  if (inline)
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-.*\\n?)+)`, 'm'));
  if (block)
    return block[1]
      .split('\n')
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  return [];
}
