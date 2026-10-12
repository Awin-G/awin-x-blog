import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { SITE } from '@/consts';
import { getPosts, postPath } from '@/lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getPosts('zh');
  return rss({
    title: SITE.name,
    description: '一个 AI 工程师的工作笔记：系统、嵌入式网络、自托管与 AI。',
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
    customData: `<language>zh-CN</language>`,
  });
};
