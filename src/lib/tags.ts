import { DEFAULT_LOCALE, type Lang } from '@/consts';

/**
 * Short, keyword-rich descriptions for topic pages, so tag archives are useful
 * to readers and not thin content. Keyed by tag slug.
 */
const TAG_DESCRIPTIONS: Record<string, Record<Lang, string>> = {
  networking: {
    en: 'Overlay and mesh networks, VPNs, NAT traversal, routing, and the protocols that move packets — with packet-level detail and reproducible setups.',
    zh: 'Overlay 与 mesh 组网、VPN、NAT 穿透、路由，以及搬运数据包的协议——包含协议细节与可复现的实验。',
  },
  embedded: {
    en: 'Running real protocols on constrained hardware: memory budgets, toolchains, and the discipline of fitting a network stack on a microcontroller.',
    zh: '在受限硬件上跑真实协议：内存预算、工具链，以及把网络栈塞进单片机的取舍。',
  },
  esp32: {
    en: 'ESP32 and ESP32-C3 in C, from blinking a GPIO to joining a real overlay network — ESP-IDF, Wi-Fi, and what actually fits.',
    zh: '用 C 玩转 ESP32 与 ESP32-C3，从点灯到接入真实 overlay 网络——ESP-IDF、Wi-Fi，以及真正塞得下的东西。',
  },
  c: {
    en: 'Portable, dependency-free C — the language that still runs on everything, and where its constraints become an advantage.',
    zh: '可移植、零依赖的 C——这门语言依然能跑在任何东西上，而它的约束往往正是优势。',
  },
  easytier: {
    en: 'Working with EasyTier: its wire protocol, its mesh model, and what it takes to be a well-behaved node on it.',
    zh: 'EasyTier 相关实践：线协议、mesh 模型，以及如何成为一个规范的节点。',
  },
  'self-hosting': {
    en: 'Running your own services on your own hardware: nginx, systemd, automated TLS, backups, and the ops that make it survivable.',
    zh: '在自己的硬件上运行自己的服务：nginx、systemd、自动 TLS、备份，以及让它活得下去的运维。',
  },
  homelab: {
    en: 'The one-person homelab: what to run, what to skip, and the honest tradeoffs of owning your own infrastructure.',
    zh: '一个人的 homelab：该跑什么、该跳过什么，以及自持基础设施的真实取舍。',
  },
  devops: {
    en: 'Deployment, automation, and reliability without a platform team: atomic deploys, timers, validation gates, and observable failure.',
    zh: '没有平台团队时的部署、自动化与可靠性：原子部署、定时器、校验门与可观测的失败。',
  },
  security: {
    en: 'Threat models and hardening for people who actually run the systems: least privilege, blast radius, and honest limits.',
    zh: '给真正运维系统的人看的安全模型与加固：最小权限、爆炸半径，以及诚实的边界。',
  },
  'reverse-engineering': {
    en: 'Understanding systems by observing them: traffic captures, protocols, and a method that survives undocumented APIs.',
    zh: '通过观察理解系统：抓包、协议，以及一套能对付未文档化 API 的方法。',
  },
  linux: {
    en: 'The Linux toolbox: namespaces, networking, systemd, and the commands that earn their place.',
    zh: 'Linux 工具箱：namespace、网络、systemd，以及配得上被记住的命令。',
  },
  nginx: {
    en: 'Serving many things from one box: virtual hosts, reverse proxies, caching, and automated certificates.',
    zh: '用一台机器服务很多东西：虚拟主机、反向代理、缓存，以及自动化证书。',
  },
  systemd: {
    en: 'Supervising and scheduling work the modern way: units, timers, resource limits, and journald.',
    zh: '用现代方式托管与调度任务：unit、timer、资源限制与 journald。',
  },
  python: {
    en: 'Practical Python for glue, automation, and protocol work — standard library first.',
    zh: '用于粘合、自动化与协议工作的实用 Python——优先标准库。',
  },
  ai: {
    en: 'Building with and around AI systems: agents, models, evaluation, and what actually works in practice.',
    zh: '围绕 AI 系统做工程：agent、模型、评测，以及在实践中真正有效的东西。',
  },
  agents: {
    en: 'Autonomous and semi-autonomous agents: workflows, containment, evaluation, and the human in the loop.',
    zh: '自主与半自主 agent：工作流、约束、评测，以及留在环里的人。',
  },
  astro: {
    en: 'Building fast, content-first sites with Astro: typed content, islands, and static output that is cheap to run.',
    zh: '用 Astro 构建快速、内容为先的站点：类型化内容、islands，以及便宜的静态输出。',
  },
  seo: {
    en: 'Being found: technical SEO, structured data, feeds, and crawler-aware publishing — from an engineer who implements it.',
    zh: '被找到：技术 SEO、结构化数据、feed，以及面向爬虫的发布——出自亲手实现的工程师。',
  },
  'ci-cd': {
    en: 'Shipping continuously without a platform: hooks, locks, pull-based deploys, and the pipelines you can read in one sitting.',
    zh: '没有平台也能持续交付：钩子、锁、拉取式部署，以及一杯茶就能读完的流水线。',
  },
  meta: {
    en: 'Notes on the project itself — what this blog is, how it is run, and what the experiment is testing.',
    zh: '关于项目自身的记录——这个博客是什么、怎么运转，以及这个实验在检验什么。',
  },
};

export function tagDescription(tag: string, lang: Lang): string {
  const entry = TAG_DESCRIPTIONS[tag.toLowerCase()];
  if (!entry) return '';
  return entry[lang] ?? entry[DEFAULT_LOCALE] ?? '';
}
