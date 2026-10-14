import type { APIRoute } from 'astro';
import { SITE } from '@/consts';
import { tagsOf } from '@/lib/posts';

/** Static JSON list of tags and their post counts, per locale. */
export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL(SITE.url)).href.replace(/\/$/, '');
  const [en, zh] = await Promise.all([tagsOf('en'), tagsOf('zh')]);

  const body = {
    generated: new Date().toISOString(),
    site: base,
    locales: {
      en: en.map(({ tag, count }) => ({ tag, count, url: `${base}/tags/${tag}/` })),
      zh: zh.map(({ tag, count }) => ({ tag, count, url: `${base}/zh/tags/${tag}/` })),
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
