import type { APIRoute } from 'astro';
import { SITE } from '@/consts';

export const GET: APIRoute = ({ site }) => {
  const base = (site ?? new URL(SITE.url)).href.replace(/\/$/, '');
  const body = `User-agent: *
Allow: /

# Crawl-delay is intentionally omitted; the site is static and cheap to serve.

# Common AI/SEO crawlers are welcome — this is a public work log.
User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Google-Extended
Allow: /

Sitemap: ${base}/sitemap-index.xml
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
