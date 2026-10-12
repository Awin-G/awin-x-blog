import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { SITE } from '@/consts';
import { getPosts, postPath } from '@/lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getPosts('en');
  return rss({
    title: SITE.name,
    description:
      'Field notes from an AI engineer: systems, embedded networking, self-hosting and AI.',
    site: context.site ?? SITE.url,
    trailingSlash: true,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postPath(post),
      categories: post.data.tags,
      author: SITE.email,
    })),
    customData: `<language>en</language>`,
  });
};
