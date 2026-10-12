import type { APIRoute } from 'astro';
import { SITE, t, localePath } from '@/consts';
import { getPosts, postPath } from '@/lib/posts';

export const GET: APIRoute = async ({ site }) => {
  const base = (site ?? new URL(SITE.url)).href.replace(/\/$/, '');
  const posts = await getPosts('zh');
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: SITE.name,
    home_page_url: base + localePath('zh', '/'),
    feed_url: base + '/zh/feed.json',
    description: t('zh', 'site.description'),
    language: 'zh-CN',
    authors: [{ name: SITE.author, url: SITE.humanUrl }],
    items: posts.map((p) => ({
      id: base + postPath(p),
      url: base + postPath(p),
      title: p.data.title,
      summary: p.data.description,
      date_published: p.data.pubDate.toISOString(),
      date_modified: (p.data.updatedDate ?? p.data.pubDate).toISOString(),
      tags: p.data.tags,
      language: 'zh-CN',
    })),
  };
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
};
