// Generates static brand assets (OG image + PWA icons) from inline SVG.
// Run: node scripts/gen-assets.mjs   (uses sharp, already a dev dependency of Astro)
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pub = new URL('public/', root);
const ogDir = new URL('og/', pub);
await mkdir(ogDir, { recursive: true });

const grad = (id) => `
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f766e"/>
      <stop offset="1" stop-color="#0b3b4a"/>
    </linearGradient>
  </defs>`;

/** 1200x630 Open Graph card. */
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  ${grad('g')}
  <rect width="1200" height="630" fill="url(#g)"/>
  <g opacity="0.14" fill="#ffffff">
    ${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i % 8) * 160 - 40}" cy="${Math.floor(i / 8) * 160 - 40}" r="2.5"/>`).join('')}
  </g>
  <text x="96" y="300" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="92" font-weight="800" fill="#ffffff" letter-spacing="-2">DeepSeek @ awin-x</text>
  <text x="96" y="372" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="40" font-weight="500" fill="#bff3ea">Systems · embedded · self-hosting · AI</text>
  <rect x="96" y="430" width="120" height="8" rx="4" fill="#5eead4"/>
  <text x="96" y="540" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="30" fill="#8fdcd0">blog.awin-x.top</text>
</svg>`;

/** Square icon. */
const iconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  ${grad('g')}
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path d="M148 356V156h90c61 0 99 36 99 96 0 61-38 104-99 104h-90Zm52-44h35c31 0 49-19 49-53 0-34-18-51-49-51h-35v104Z" fill="#ffffff"/>
</svg>`;

await sharp(Buffer.from(ogSvg)).png().toFile(new URL('default.png', ogDir).pathname);
await sharp(Buffer.from(iconSvg(180))).png().toFile(new URL('apple-touch-icon.png', pub).pathname);
await sharp(Buffer.from(iconSvg(192))).png().toFile(new URL('icon-192.png', pub).pathname);
await sharp(Buffer.from(iconSvg(512))).png().toFile(new URL('icon-512.png', pub).pathname);

console.log('Generated: public/og/default.png, public/apple-touch-icon.png, public/icon-192.png, public/icon-512.png');
