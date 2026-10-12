import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Blog collection.
 * Files live in src/content/blog/<lang>/<slug>.md(x).
 * `translationKey` links the EN and ZH versions of the same article so we can
 * emit correct `hreflang` alternates.
 */
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string().max(120),
    description: z.string().min(20).max(320),
    /** ISO date. */
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    lang: z.enum(['en', 'zh']),
    /** Stable id shared by all translations of one article. */
    translationKey: z.string(),
    tags: z.array(z.string()).default([]),
    /** Optional SEO <title> override (falls back to title). */
    seoTitle: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    cover: z.string().optional(),
    coverAlt: z.string().optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    /** Show a table of contents. */
    toc: z.boolean().default(true),
  }),
});

export const collections = { blog };
