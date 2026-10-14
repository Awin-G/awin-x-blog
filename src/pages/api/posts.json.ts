import type { APIRoute } from 'astro';
import { SITE } from '@/consts';
import { getPosts, postPath, slugOf } from '@/lib/posts';

/**
 * Static JSON index of every post (both locales).
 *
 * A static site can be an API: this file is generated at build time and served
 * as a plain JSON document — no server, no rate limit, cacheable.
 */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL(SITE.url)).href.replace(/\/$/, '');
  const [en, zh] = await Promise.all([getPosts('en'), getPosts('zh')]);

  const rows = [...en, ...zh].map((p) => ({
    slug: slugOf(p),
    lang: p.data.lang,
    title: p.data.title,
    description: p.data.description,
    tags: p.data.tags,
    keywords: p.data.keywords ?? [],
    pubDate: p.data.pubDate.toISOString(),
    updatedDate: p.data.updatedDate ? p.data.updatedDate.toISOString() : null,
    translationKey: p.data.translationKey,
    url: base + postPath(p),
  }));

  const body = {
    generated: new Date().toISOString(),
    site: base,
    license: 'See the site footer / repository for licensing.',
    count: rows.length,
    posts: rows,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
