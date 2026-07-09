// site/templates.ts — the shared HTML shell (header, footer, <head>). Every
// page is renderPage(...)'d so nav/branding/theme stay in one place. Styling is
// Tailwind (utilities inline + a few component classes in assets/tailwind.css).

const YEAR = 2026;
const GH = "https://github.com/pocket-stack/pocketjs";
const X_URL = "https://x.com/pocket_js";
export const SITE_URL = "https://pocketjs.dev";
export const SITE_TITLE = "PocketJS — Bare Metal Modern Web";
export const SITE_DESC =
  "High-performance JSX UI outside the browser, with native rendering, standard Vue Vapor and Solid support, a Tailwind design system, and 60 FPS animation under an 8 MB memory budget.";
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;

export interface PageOpts {
  title: string | null; // null uses the bare wordmark (homepage)
  active: string; // "home" | "docs" | "aot" | "playground" | "blog"
  body: string;
  bodyClass?: string;
  head?: string;
  scripts?: string[];
  path?: string;
  description?: string;
  robots?: string;
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
  const ghIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>';
  const xIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const link = (href: string, label: string, key: string, ext = false) =>
    `<a href="${href}"${ext ? ' target="_blank" rel="noreferrer"' : ""} ` +
    `class="site-nav__link ${active === key ? "on" : ""}">${label}</a>`;
  return `<header class="site-nav">
  <div class="site-nav__in">
    <a href="/" class="site-brand" aria-label="PocketJS home">
      ${LOGO}<span class="text-[17px]">PocketJS</span>
    </a>
    <nav class="site-nav__links" aria-label="Primary">
      ${link("/docs/overview/", "Docs", "docs")}
      ${link("/playground/", "Playground", "playground")}
      ${link("/blog/", "Blog", "blog")}
      ${link("/changelog/", "Changelog", "changelog")}
      <a href="${GH}" target="_blank" rel="noreferrer" class="site-nav__link site-nav__gh">${ghIcon}<span class="site-nav__ghlabel">GitHub</span></a>
      <a href="${X_URL}" target="_blank" rel="noreferrer" class="site-nav__link site-nav__x" aria-label="PocketJS on X">${xIcon}</a>
    </nav>
  </div>
</header>`;
}

const footer = `<footer class="mt-24 border-t border-line/70 bg-ink-2/60">
  <div class="mx-auto max-w-6xl px-5 py-12">
    <div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <div class="flex items-center gap-2 font-semibold text-slate-100">${LOGO}<span>PocketJS</span></div>
        <p class="mt-3 max-w-xs text-sm text-slate-400">Vue Vapor and Solid UI under 8 MB RAM, rendered through a tiny native core.</p>
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
        <h4 class="mb-3 font-semibold text-slate-200">Framework</h4>
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
          <li><a class="hover:text-brand-2" href="/blog/">Blog</a></li>
          <li><a class="hover:text-brand-2" href="${GH}" target="_blank" rel="noreferrer">GitHub</a></li>
          <li><a class="hover:text-brand-2" href="${X_URL}" target="_blank" rel="noreferrer">X (Twitter)</a></li>
          <li><a class="hover:text-brand-2" href="/docs/native-contract/">Native contract</a></li>
          <li><a class="hover:text-brand-2" href="/docs/build-pipeline/">Build pipeline</a></li>
        </ul>
      </div>
    </div>
    <div class="mt-10 flex flex-col gap-2 border-t border-line/60 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-end">
      <span>© ${YEAR} PocketJS · MIT</span>
    </div>
  </div>
</footer>`;

export function renderPage(o: PageOpts): string {
  const fullTitle = o.title ? `${o.title} · PocketJS` : SITE_TITLE;
  const desc = o.description ?? SITE_DESC;
  const canonical = `${SITE_URL}${o.path ?? "/"}`;
  const robots = o.robots ?? "index,follow";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "PocketJS",
    description: SITE_DESC,
    url: SITE_URL,
    codeRepository: GH,
    programmingLanguage: ["TypeScript", "JavaScript", "Rust"],
    runtimePlatform: ["Sony PSP", "PPSSPP", "WebAssembly", "Bun"],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="PocketJS — Bare Metal Modern Web">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#05070d">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">${jsonLd}</script>
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
