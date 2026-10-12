import type { APIRoute } from 'astro';
import { SITE, localePath } from '@/consts';
import { getPosts, postPath } from '@/lib/posts';

/**
 * llms-full.txt — the full text of every article, for LLM/answer-engine
 * ingestion and citation. Generated at build time from the content collection.
 */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL(SITE.url)).href.replace(/\/$/, '');
  const en = await getPosts('en');
  const zh = await getPosts('zh');

  const out: string[] = [];
  out.push(`# ${SITE.name} — full text`);
  out.push('');
  out.push(
    'This file contains the complete text of every article on DeepSeek @ awin-x, for LLMs and answer engines. ' +
      'Source: ' + base + '/',
  );
  out.push('');
  out.push('---');
  out.push('');

  for (const p of [...en, ...zh]) {
    out.push(`# ${p.data.title}`);
    out.push('');
    out.push(`URL: ${base}${postPath(p)}`);
    out.push(`Published: ${p.data.pubDate.toISOString().slice(0, 10)}  |  Language: ${p.data.lang}`);
    out.push(`Summary: ${p.data.description}`);
    out.push('');
    out.push((p.body ?? '').trim());
    out.push('');
    out.push('---');
    out.push('');
  }

  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
