// site/templates.ts — the shared HTML shell (header, footer, <head>). Every
// page is renderPage(...)'d so nav/branding/theme stay in one place. Styling is
// Tailwind (utilities inline + a few component classes in assets/tailwind.css).

const YEAR = 2026;
const GH = "https://github.com/pocket-stack/pocketjs";

export interface PageOpts {
  title: string | null; // null uses the bare wordmark (homepage)
  active: string; // "home" | "docs" | "playground"
  body: string;
  bodyClass?: string;
  head?: string;
  scripts?: string[];
}

export const LOGO = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
  <defs>
    <linearGradient id="pj-shell-edge" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#eef6ff"/><stop offset="0.38" stop-color="#b7c8e2"/><stop offset="0.58" stop-color="#7487a0"/><stop offset="0.78" stop-color="#aec0d6"/><stop offset="1" stop-color="#dbe8f6"/></linearGradient>
    <linearGradient id="pj-shell-lens" x1="7" y1="13" x2="13" y2="19" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e4edf8"/><stop offset="0.55" stop-color="#a7b8cf"/><stop offset="1" stop-color="#53677f"/></linearGradient>
    <linearGradient id="pj-shell-bar" x1="16" y1="12" x2="24" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d7e3f1"/><stop offset="1" stop-color="#71849d"/></linearGradient>
  </defs>
  <rect x="2" y="6" width="28" height="20" rx="6" fill="none" stroke="url(#pj-shell-edge)" stroke-width="2.6" stroke-linejoin="round"/>
  <circle cx="10" cy="16" r="3.1" fill="url(#pj-shell-lens)"/>
  <rect x="16" y="12.6" width="10" height="2.2" rx="1.1" fill="url(#pj-shell-bar)"/>
  <rect x="16" y="17.2" width="6.5" height="2.2" rx="1.1" fill="url(#pj-shell-bar)"/>
</svg>`;

function header(active: string): string {
  const on = "text-white bg-surface-2";
  const link = (href: string, label: string, key: string, ext = false) =>
    `<a href="${href}"${ext ? ' target="_blank" rel="noreferrer"' : ""} ` +
    `class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white transition-colors ${active === key ? on : ""}">${label}</a>`;
  return `<header class="sticky top-0 z-50 border-b border-line/70 bg-ink/75 backdrop-blur-md">
  <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
    <a href="/" class="flex items-center gap-2 font-semibold tracking-tight text-slate-100" aria-label="PocketJS home">
      ${LOGO}<span class="text-[17px]">PocketJS</span>
    </a>
    <nav class="flex items-center gap-1 text-sm font-medium">
      ${link("/docs/overview/", "Docs", "docs")}
      ${link("/playground/", "Playground", "playground")}
      ${link(GH, "GitHub", "github", true)}
    </nav>
  </div>
</header>`;
}

const footer = `<footer class="mt-24 border-t border-line/70 bg-ink-2/60">
  <div class="mx-auto max-w-6xl px-5 py-12">
    <div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <div class="flex items-center gap-2 font-semibold text-slate-100">${LOGO}<span>PocketJS</span></div>
        <p class="mt-3 max-w-xs text-sm text-slate-400">Solid and Tailwind UI for a 32 MB Sony PSP, rendered through a tiny native core.</p>
      </div>
      <div class="text-sm">
        <h4 class="mb-3 font-semibold text-slate-200">Docs</h4>
        <ul class="space-y-2 text-slate-400">
          <li><a class="hover:text-brand-2" href="/docs/overview/">Overview</a></li>
          <li><a class="hover:text-brand-2" href="/docs/getting-started/">Getting started</a></li>
          <li><a class="hover:text-brand-2" href="/docs/architecture/">Architecture</a></li>
          <li><a class="hover:text-brand-2" href="/docs/api/">API reference</a></li>
        </ul>
      </div>
      <div class="text-sm">
        <h4 class="mb-3 font-semibold text-slate-200">Explore</h4>
        <ul class="space-y-2 text-slate-400">
          <li><a class="hover:text-brand-2" href="/playground/">Playground</a></li>
          <li><a class="hover:text-brand-2" href="/docs/components/">Components</a></li>
          <li><a class="hover:text-brand-2" href="/docs/styling/">Styling</a></li>
          <li><a class="hover:text-brand-2" href="/docs/animation/">Animation</a></li>
        </ul>
      </div>
      <div class="text-sm">
        <h4 class="mb-3 font-semibold text-slate-200">Project</h4>
        <ul class="space-y-2 text-slate-400">
          <li><a class="hover:text-brand-2" href="${GH}" target="_blank" rel="noreferrer">GitHub</a></li>
          <li><a class="hover:text-brand-2" href="/docs/native-contract/">Native contract</a></li>
          <li><a class="hover:text-brand-2" href="/docs/build-pipeline/">Build pipeline</a></li>
        </ul>
      </div>
    </div>
    <div class="mt-10 flex flex-col gap-2 border-t border-line/60 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
      <span>Solid UI, native pixels</span>
      <span>© ${YEAR} PocketJS · MIT</span>
    </div>
  </div>
</footer>`;

export function renderPage(o: PageOpts): string {
  const fullTitle = o.title ? `${o.title} · PocketJS` : "PocketJS — Bare Metal Modern Web";
  const desc =
    "PocketJS builds Solid and Tailwind interfaces for a 32 MB Sony PSP, with native flexbox, sub-pixel text, animation and deterministic rendering.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#05070d">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
${o.head ?? ""}
</head>
<body class="min-h-screen ${o.bodyClass ?? ""}">
${header(o.active)}
<main>${o.body}</main>
${footer}
${(o.scripts ?? []).join("\n")}
</body>
</html>`;
}
