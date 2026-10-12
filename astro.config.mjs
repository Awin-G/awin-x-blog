// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.awin-x.top',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // Inline small stylesheets for a faster first paint (SEO/UX win).
    inlineStylesheets: 'auto',
  },
  // English lives at the root, Chinese under /zh/. English-first because the
  // realistic search channel for an un-ICP'd overseas host is Google/Bing.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  image: {
    // Sharp-based optimization at build time.
    responsiveStyles: true,
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
      wrap: true,
    },
  },
  integrations: [
    mdx(),
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: 'en-US',
          zh: 'zh-CN',
        },
      },
      filter: (page) => !page.includes('/404'),
    }),
  ],
});
