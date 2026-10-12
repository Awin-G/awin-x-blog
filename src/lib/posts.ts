import { getCollection, type CollectionEntry } from 'astro:content';
import { LOCALES, DEFAULT_LOCALE, localePath, type Lang } from '@/consts';

export type Post = CollectionEntry<'blog'>;

/** All published posts, newest first. */
export async function getPosts(lang?: Lang): Promise<Post[]> {
  const all = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  const filtered = lang ? all.filter((p) => p.data.lang === lang) : all;
  return filtered.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Slug within the locale (strips the leading `en/` or `zh/`). */
export function slugOf(post: Post): string {
  return post.id.replace(/^(en|zh)\//, '');
}

export function langOf(post: Post): Lang {
  return post.data.lang;
}

/** Locale-aware path, e.g. `/posts/foo/` or `/zh/posts/foo/`. */
export function postPath(post: Post): string {
  return localePath(post.data.lang, `/posts/${slugOf(post)}/`);
}

export function tagPath(lang: Lang, tag: string): string {
  return localePath(lang, `/tags/${tagSlug(tag)}/`);
}

export function tagSlug(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '');
}

/**
 * Reading time. Counts CJK ideographs and Latin words separately and applies
 * language-appropriate speeds (~330 CJK chars/min, ~210 words/min).
 */
export function readingTime(post: Post): number {
  const text = post.body ?? '';
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latinWords = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [])
    .length;
  const minutes = cjk / 330 + latinWords / 210;
  return Math.max(1, Math.round(minutes));
}

/** Approximate word count (CJK ideographs + Latin words). */
export function wordCount(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? [])
    .length;
  return cjk + latin;
}

/** A short, locale-aware list of words for an excerpt. */
export function excerpt(post: Post, max = 180): string {
  const text = (post.body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Tags used within a locale, with counts, sorted by popularity. */
export async function tagsOf(lang: Lang): Promise<TagCount[]> {
  const posts = await getPosts(lang);
  const map = new Map<string, number>();
  for (const p of posts) {
    for (const t of p.data.tags) map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function postsWithTag(lang: Lang, tag: string): Promise<Post[]> {
  const slug = tagSlug(tag);
  const posts = await getPosts(lang);
  return posts.filter((p) => p.data.tags.some((t) => tagSlug(t) === slug));
}

/** Translations of a post (same translationKey, other locales). */
export async function translationsOf(post: Post): Promise<Post[]> {
  const all = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  return all.filter(
    (p) => p.data.translationKey === post.data.translationKey && p.data.lang !== post.data.lang,
  );
}

/** Related posts: shared tags first, then recent posts to always fill `limit`. */
export async function relatedPosts(post: Post, limit = 3): Promise<Post[]> {
  const posts = await getPosts(post.data.lang);
  const tags = new Set(post.data.tags);
  const scored = posts
    .filter((p) => p.id !== post.id)
    .map((p) => ({
      post: p,
      score: p.data.tags.filter((t) => tags.has(t)).length,
    }))
    .sort(
      (a, b) => b.score - a.score || b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf(),
    );
  const withTag = scored.filter((x) => x.score > 0).map((x) => x.post);
  if (withTag.length >= limit) return withTag.slice(0, limit);
  const rest = scored.filter((x) => x.score === 0).map((x) => x.post);
  return [...withTag, ...rest].slice(0, limit);
}

/** Previous / next post within the same locale (by publication date). */
export async function adjacentPosts(post: Post): Promise<{ prev?: Post; next?: Post }> {
  const posts = await getPosts(post.data.lang);
  const i = posts.findIndex((p) => p.id === post.id);
  if (i === -1) return {};
  return { prev: posts[i + 1], next: posts[i - 1] };
}

export function isDefaultLang(lang: Lang): boolean {
  return lang === DEFAULT_LOCALE;
}

export { LOCALES, DEFAULT_LOCALE };
