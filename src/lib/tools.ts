import type { Lang } from '@/consts';

/** Every client-side tool, with its bilingual name. */
export type ToolSlug =
  | 'ipv6'
  | 'subnet'
  | 'bases'
  | 'endian'
  | 'crc'
  | 'chmod'
  | 'encoding'
  | 'cron'
  | 'harden';

export const TOOL_NAMES: Record<ToolSlug, { en: string; zh: string }> = {
  ipv6: { en: 'IPv6 address calculator', zh: 'IPv6 地址计算器' },
  subnet: { en: 'IPv4 subnet calculator', zh: 'IPv4 子网计算器' },
  bases: { en: 'Number base converter', zh: '进制转换器' },
  endian: { en: 'Endianness visualizer', zh: '字节序可视化' },
  crc: { en: 'CRC calculator', zh: 'CRC 校验计算器' },
  chmod: { en: 'chmod calculator', zh: 'chmod 权限计算器' },
  encoding: { en: 'Base64 / URL / Hex encoder', zh: 'Base64 / URL / Hex 编解码' },
  cron: { en: 'cron explainer', zh: 'cron 表达式解释器' },
  harden: { en: 'systemd hardening generator', zh: 'systemd 加固生成器' },
};

/**
 * Which tools are worth offering under an article, by tag.
 *
 * The point is twofold: a reader of a subnet article should get the subnet
 * calculator, and the tool pages themselves were previously almost unlinked
 * (2 inbound links each), which is bad for discovery. This block gives every
 * tool hundreds of contextual inbound links without editing any article.
 */
const BY_TAG: Record<string, ToolSlug[]> = {
  networking: ['subnet', 'ipv6', 'crc'],
  nginx: ['subnet', 'harden'],
  'self-hosting': ['harden', 'cron', 'subnet'],
  homelab: ['subnet', 'harden'],
  devops: ['harden', 'cron', 'chmod'],
  systemd: ['harden', 'cron'],
  linux: ['chmod', 'cron', 'harden'],
  embedded: ['bases', 'endian', 'crc'],
  c: ['bases', 'endian', 'crc'],
  rust: ['bases', 'endian'],
  esp32: ['crc', 'bases'],
  easytier: ['subnet', 'crc'],
  security: ['harden', 'encoding'],
  'reverse-engineering': ['encoding', 'endian'],
  python: ['cron', 'encoding'],
  ai: ['encoding'],
  agents: ['encoding'],
  astro: ['encoding'],
  seo: ['encoding'],
  meta: ['encoding'],
};

/** Tools matching `tags`, deduped and capped, preserving the map's order. */
export function toolsForTags(tags: readonly string[], max = 3): ToolSlug[] {
  const out: ToolSlug[] = [];
  for (const tag of tags) {
    for (const slug of BY_TAG[tag] ?? []) {
      if (!out.includes(slug)) out.push(slug);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function toolName(slug: ToolSlug, lang: Lang): string {
  return TOOL_NAMES[slug][lang === 'zh' ? 'zh' : 'en'];
}
