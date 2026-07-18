// sessions/templates.ts — shared HTML shell for sessions.pocketjs.dev.
// Mirrors site/templates.ts (same brand, same theme tokens) but with its own
// nav: this is the standalone "development sessions" deep-wiki companion site.

import { LOGO } from "../site/templates.ts";

const GH = "https://github.com/pocket-stack/pocketjs";
const MAIN_SITE = "https://pocketjs.dev";
export const SITE_URL = "https://sessions.pocketjs.dev";
export const SITE_TITLE = "PocketJS Sessions — 从零到发布的完整开发档案";
export const SITE_DESC =
  "PocketJS 如何在两周内被一个作者和一群 coding agent 从零做到首个 release —— 基于全部真实开发 session 转录的深度档案（deep wiki）。";
export const OG_IMAGE_URL = `${MAIN_SITE}/og-image.png`;

export interface PageOpts {
  title: string | null;
  active: string; // "home" | "story" | "timeline" | "sessions" | "numbers"
  body: string;
  bodyClass?: string;
  head?: string;
  path?: string;
  description?: string;
}

function header(active: string): string {
  const ghIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>';
  const link = (href: string, label: string, key: string) =>
    `<a href="${href}" class="site-nav__link ${active === key ? "on" : ""}">${label}</a>`;
  return `<header class="site-nav">
  <div class="site-nav__in">
    <a href="/" class="site-brand" aria-label="PocketJS Sessions home">
      ${LOGO}<span class="text-[17px]">PocketJS</span><span class="brand-sub">Sessions</span>
    </a>
    <nav class="site-nav__links" aria-label="Primary">
      ${link("/prehistory/", "编年史", "story")}
      ${link("/timeline/", "时间线", "timeline")}
      ${link("/sessions/", "档案馆", "sessions")}
      ${link("/numbers/", "数字", "numbers")}
      <a href="${MAIN_SITE}" target="_blank" rel="noreferrer" class="site-nav__link site-nav__optional">pocketjs.dev ↗</a>
      <a href="${GH}" target="_blank" rel="noreferrer" class="site-nav__link site-nav__gh" aria-label="PocketJS on GitHub">${ghIcon}</a>
    </nav>
  </div>
</header>`;
}

const footer = `<footer class="mt-24 border-t border-line/70 bg-ink-2/60">
  <div class="mx-auto max-w-6xl px-5 py-12">
    <div class="grid gap-10 sm:grid-cols-3">
      <div>
        <div class="flex items-center gap-2 font-semibold text-slate-100">${LOGO}<span>PocketJS Sessions</span></div>
        <p class="mt-3 max-w-xs text-sm text-slate-400">一个框架诞生的全过程，以开发 session 为一手史料。</p>
      </div>
      <div class="text-sm">
        <h4 class="mb-3 font-semibold text-slate-200">编年史</h4>
        <ul class="space-y-2 text-slate-400">
          <li><a class="hover:text-brand-2" href="/prehistory/">前史：dreamcart 与 psp-ui</a></li>
          <li><a class="hover:text-brand-2" href="/big-bang/">7 月 5 日大爆炸</a></li>
          <li><a class="hover:text-brand-2" href="/first-release/">首个 release</a></li>
          <li><a class="hover:text-brand-2" href="/epilogue/">后记</a></li>
        </ul>
      </div>
      <div class="text-sm">
        <h4 class="mb-3 font-semibold text-slate-200">链接</h4>
        <ul class="space-y-2 text-slate-400">
          <li><a class="hover:text-brand-2" href="${MAIN_SITE}" target="_blank" rel="noreferrer">pocketjs.dev</a></li>
          <li><a class="hover:text-brand-2" href="${MAIN_SITE}/blog/" target="_blank" rel="noreferrer">Blog</a></li>
          <li><a class="hover:text-brand-2" href="${GH}" target="_blank" rel="noreferrer">GitHub</a></li>
          <li><a class="hover:text-brand-2" href="/colophon/">本站如何生成</a></li>
        </ul>
      </div>
    </div>
    <div class="mt-10 flex flex-col gap-2 border-t border-line/60 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-end">
      <span>© 2026 PocketJS · 史料出自作者本人的 Claude Code session 存档</span>
    </div>
  </div>
</footer>`;

export function renderPage(o: PageOpts): string {
  const fullTitle = o.title ? `${o.title} · PocketJS Sessions` : SITE_TITLE;
  const desc = o.description ?? SITE_DESC;
  const canonical = `${SITE_URL}${o.path ?? "/"}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS Sessions">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#05070d">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
${o.head ?? ""}
</head>
<body class="min-h-screen ${o.bodyClass ?? ""}">
${header(o.active)}
<main>${o.body}</main>
${footer}
</body>
</html>`;
}
