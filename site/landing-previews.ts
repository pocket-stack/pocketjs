import { renderPage } from "./templates.ts";
import { DEVICES, SHOWCASE_APPS, type ShowcaseApp, type ShowcaseDevice } from "./showcase.ts";

export const LANDING_STUDIES = [
  { id: "a", title: "应用优先", subtitle: "先看到能做什么，再选择自己的设备。", detail: "首屏并排展示 OpenStrike、Pocket Doc 和 Pocket Voxel，覆盖游戏、生产力、PSP、3DS 与 PS Vita。接着用社区案例 PSPMAN 建立生态感，完整应用目录提供设备筛选。", label: "The app collection" },
  { id: "b", title: "设备优先", subtitle: "我有一台 3DS，可以玩什么？", detail: "首屏按 Nintendo 3DS、PSP、PS Vita 分为三列，每列给出代表应用和进入该设备应用目录的入口。适合带着硬件来访、想尽快找到安装方式的用户。", label: "Choose your handheld" },
  { id: "c", title: "重点案例优先", subtitle: "用一张真机照片，打开一个新用途。", detail: "首屏用 Pocket Doc 的 3DS 真机照片讲一个完整用途，旁边点出 PSP 和 PS Vita 游戏。紧接着突出 PSPMAN 社区作品，再展示完整目录。适合持续更新的编辑精选。", label: "The field notes" },
] as const;
type Study = typeof LANDING_STUDIES[number]["id"];
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const app = (id: string) => SHOWCASE_APPS.find((item) => item.id === id)!;
const badges = (a: ShowcaseApp) => a.devices.map((d) => `<span>${DEVICES[d]}</span>`).join("");
const tryLink = (a: ShowcaseApp, label = "How to try") => `<a class="sc-try" href="${esc(a.href)}" data-open-app="${a.id}">${label}<span aria-hidden="true"> ↗</span><span class="sc-sr"> ${a.name}</span></a>`;

function card(a: ShowcaseApp, featured = false): string {
  return `<article class="sc-card ${a.community ? "sc-card-community" : ""}"${featured ? "" : ` data-app-card data-devices="${a.devices.join(" ")}"`}>
    <a class="sc-card-image sc-image-${a.id}" href="${esc(a.href)}" data-open-app="${a.id}" aria-label="Explore ${a.name}">
      <img src="${a.image}" alt="${esc(a.imageAlt)}" ${featured ? 'fetchpriority="high"' : 'loading="lazy"'} width="480" height="272">
      <span class="sc-image-label">${a.category}</span>
    </a>
    <div class="sc-card-body"><div class="sc-badges">${badges(a)}</div>
      <h3>${a.name}${a.community ? '<span class="sc-community-mark">Community</span>' : ""}</h3>
      <p>${a.description}</p><div class="sc-card-bottom"><span>${a.availability}</span>${tryLink(a)}</div>
    </div></article>`;
}

function reviewbar(current?: Study): string {
  return `<nav class="sc-reviewbar" aria-label="Landing page alternatives"><div class="sc-wrap">
    <a href="/_preview/landing/" class="sc-review-title">首页方案 <span> / </span></a>
    ${LANDING_STUDIES.map((s) => `<a href="/_preview/landing/${s.id}/"${s.id === current ? ' aria-current="page"' : ""}>${s.id.toUpperCase()}<span> ${s.title}</span></a>`).join("")}
    <a class="sc-original" href="/">现有首页 ↗</a></div></nav>`;
}

function community(): string {
  const a = app("pspman");
  return `<section class="sc-community sc-wrap" aria-labelledby="community-title">
    <div class="sc-community-image"><img src="/assets/showcase/pspman-hardware.png" width="640" height="360" loading="lazy" alt="PSPMAN playing music on a Sony PSP-3000, official ObsoleteSony product image"></div>
    <div><p class="sc-eyebrow">Made in the community <span> / </span> ObsoleteSony</p>
      <h2 id="community-title">Meet PSPMAN.</h2><p>A new life for your music library. A Walkman-inspired FLAC and MP3 player, built with PocketJS.</p>
      <div class="sc-community-actions">${tryLink(a, "Get the public alpha")}<span>PSP · Source currently private</span></div>
    </div><a class="sc-credit" href="${a.imageSource}">Images © ObsoleteSony ↗</a>
  </section>`;
}

function collection(): string {
  return `<section class="sc-collection sc-wrap" id="apps" aria-labelledby="apps-title">
    <div class="sc-section-heading"><div><p class="sc-eyebrow">The growing collection</p><h2 id="apps-title">Find your next app.</h2></div>
      <p>Pick your hardware.<br>Every app has a route to try it.</p></div>
    <div class="sc-filter-row"><div class="sc-filters" role="group" aria-label="Filter apps by device"><button type="button" data-filter="all" aria-pressed="true">All devices</button>${Object.entries(DEVICES).map(([id, label]) => `<button type="button" data-filter="${id}" aria-pressed="false">${label}</button>`).join("")}</div><span class="sc-count" role="status" aria-live="polite">${SHOWCASE_APPS.length} apps</span></div>
    <div class="sc-app-grid">${SHOWCASE_APPS.map((a) => card(a)).join("")}</div>
  </section>`;
}

function heroA(): string {
  return `<section class="sc-hero sc-wrap"><div class="sc-intro"><div><p class="sc-eyebrow"><span class="sc-status-dot"></span> Built with PocketJS</p><h1>UI runtime for<br><span>every kind of computer.</span></h1></div>
    <div class="sc-intro-copy"><p>New apps. Familiar hardware.<br> Games, creative tools, and everyday software on Nintendo 3DS, PSP, and PS Vita.</p><div class="sc-actions"><a class="sc-button" href="#apps">Find an app <span>↓</span></a><a class="sc-text-link" href="/docs/getting-started/">Build your own ↗</a></div></div></div>
    <div class="sc-feature-heading"><span>01 / In your hands</span><span>Games. Documents. Whole worlds.</span></div>
    <div class="sc-feature-grid">${["openstrike", "pocket-doc", "pocket-voxel"].map((id) => card(app(id), true)).join("")}</div>
  </section>`;
}

function heroB(): string {
  const lane = (id: ShowcaseDevice, headline: string, featured: string) => {
    const a = app(featured);
    const matches = SHOWCASE_APPS.filter((a) => a.devices.includes(id));
    return `<article class="sc-device sc-device-${id}" id="device-${id}"><div class="sc-device-title"><span class="sc-eyebrow">${id === "3ds" ? "01" : id === "psp" ? "02" : "03"} / ${matches.length} apps</span><h2>${DEVICES[id]}</h2><p>${headline}</p></div>
      <a class="sc-device-image" href="${a.href}" data-open-app="${a.id}"><img src="${a.image}" alt="${esc(a.imageAlt)}" width="480" height="272"><span>${a.name} ↗</span></a>
      <ul>${matches.map((a) => `<li><a href="${a.href}" data-open-app="${a.id}"><span>${a.name}</span><span>${a.community ? "Community" : a.category} ↗</span></a></li>`).join("")}</ul>
      <a class="sc-device-link" href="?device=${id}#apps" data-select-device="${id}">Explore ${DEVICES[id]} apps <span>↓</span></a></article>`;
  };
  return `<section class="sc-hero sc-wrap"><div class="sc-intro sc-device-intro"><div><p class="sc-eyebrow">Built with PocketJS</p><h1>Your handheld.<br><span>A whole new lineup.</span></h1></div><div class="sc-intro-copy"><p>Choose the hardware you have.<br> Discover what people are building for it,<br> and how to run it yourself.</p><a class="sc-text-link" href="/docs/getting-started/">Here to build? Start with the docs ↗</a></div></div><nav class="sc-device-jumps" aria-label="Jump to a handheld">${Object.entries(DEVICES).map(([id, label]) => `<a href="#device-${id}">${label} ↓</a>`).join("")}</nav><div class="sc-device-grid">${lane("3ds", "Two screens. Room to work.", "pocket-doc")}${lane("psp", "Press play. Then try something new.", "openstrike")}${lane("vita", "More pixels. Same curiosity.", "pocket-voxel")}</div></section>`;
}

function heroC(): string {
  const a = app("pocket-doc");
  return `<section class="sc-hero sc-wrap"><div class="sc-editorial-heading"><p class="sc-eyebrow">Built with PocketJS / Field notes No. 01</p><span>Nintendo 3DS · PSP · PS Vita</span></div>
    <div class="sc-editorial"><div class="sc-editorial-copy"><div class="sc-badges"><span>Nintendo 3DS</span><span>Productivity</span></div><h1>A second life.<br><span>Two screens.</span></h1><p>Your Markdown library, on a Nintendo 3DS. Pocket Doc turns the lower screen into an editing deck while your document stays in view above.</p><div class="sc-actions">${tryLink(a, "Try Pocket Doc")}<a class="sc-text-link" href="#apps">Explore all apps ↓</a></div><span class="sc-small">Homebrew Launcher + paired Mac over Wi-Fi</span></div>
    <figure><img src="${a.image}" alt="${esc(a.imageAlt)}" width="840" height="640" fetchpriority="high"><figcaption><span>Pocket Doc / Nintendo 3DS</span><span>Photographed on hardware</span></figcaption></figure></div>
    <div class="sc-editorial-next"><span class="sc-eyebrow">Also in your pocket</span>${["openstrike", "pocket-voxel", "pocket-figma"].map((id) => {const a = app(id);return `<a href="${a.href}" data-open-app="${a.id}"><img src="${a.image}" width="100" height="57" alt=""><span><strong>${a.name}</strong><small>PSP · PS Vita</small></span><span aria-hidden="true">↗</span></a>`;}).join("")}</div>
  </section>`;
}

function dialogs(): string {
  return SHOWCASE_APPS.map((a) => `<dialog class="sc-dialog" id="try-${a.id}" aria-labelledby="title-${a.id}"><form method="dialog"><button class="sc-close" aria-label="Close ${a.name} details" autofocus>Close ×</button></form>
    <div class="sc-dialog-content"><p class="sc-eyebrow">${a.community ? "Community / " : ""}${a.owner} · ${a.category}</p><h2 id="title-${a.id}">${a.name}</h2><p>${a.description}</p><div class="sc-badges">${badges(a)}</div>
    <div class="sc-requirement"><strong>${a.availability}</strong><span>${a.requirement}</span></div><h3>How to try it</h3><ol>${a.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="sc-actions"><a class="sc-button" href="${a.href}">${a.action} ↗</a>${a.source ? `<a class="sc-text-link" href="${a.source}">Source code ↗</a>` : ""}${a.story ? `<a class="sc-text-link" href="${a.story}">${a.community ? "About the project" : "Read the story"} ↗</a>` : ""}</div>
    <figure><img src="${a.image}" loading="lazy" width="480" height="272" alt="${esc(a.imageAlt)}"><figcaption><a href="${a.imageSource}">${a.imageCredit} ↗</a></figcaption></figure></div></dialog>`).join("");
}

export function renderLandingStudy(id: Study): string {
  const study = LANDING_STUDIES.find((s) => s.id === id)!;
  return renderPage({ title: `${study.label} (preview)`, active: "home", bodyClass: `showcase-page sc-layout-${id}`, path: `/_preview/landing/${id}/`, robots: "noindex,nofollow",
    head: '<link rel="stylesheet" href="/_preview/assets/showcase.css">',
    scripts: ['<script type="module" src="/_preview/assets/showcase.js"></script>'],
    body: reviewbar(id) + (id === "a" ? heroA() : id === "b" ? heroB() : heroC()) + community() + collection() +
      `<section class="sc-build sc-wrap"><div><p class="sc-eyebrow">Your turn</p><h2>What will you put<br>in someone's pocket?</h2><p>PocketJS brings modern component code to native pixels.<br>Write with Solid, Vue Vapor, or Octane. Start with one device.</p></div><div class="sc-actions"><a class="sc-button" href="/docs/getting-started/">Start building ↗</a><a class="sc-text-link" href="/playground/">Open the playground ↗</a></div></section>` + dialogs(),
  });
}

export function renderLandingStudyIndex(): string {
  return renderPage({ title: "Landing page alternatives", active: "home", bodyClass: "showcase-page sc-index", path: "/_preview/landing/", robots: "noindex,nofollow", head: '<link rel="stylesheet" href="/_preview/assets/showcase.css">',
    body: reviewbar() + `<section class="sc-wrap sc-study-index"><p class="sc-eyebrow">PocketJS / Homepage studies</p><h1>让应用走到首屏。</h1><p class="sc-index-lead">三种排列方式，同一份经过核实的应用目录。<br>点开任意方案，即可切换设备、查看案例和体验步骤。</p><div class="sc-study-grid">${LANDING_STUDIES.map((s) => `<a class="sc-study" href="/_preview/landing/${s.id}/"><div class="sc-study-visual sc-study-visual-${s.id}"><span>${s.id.toUpperCase()}</span><img src="${app(s.id === "a" ? "openstrike" : s.id === "b" ? "pocket-shell" : "pocket-doc").image}" alt="" width="480" height="272"></div><div class="sc-study-body"><span class="sc-eyebrow">${s.id === "a" ? "推荐 · " : ""}${s.label}</span><h2>${s.title} ↗</h2><strong>${s.subtitle}</strong><p>${s.detail}</p></div></a>`).join("")}</div><div class="sc-index-note"><p><strong>建议选 A：</strong>先用游戏、文档和 3D 世界展示用途，再通过设备筛选回答“我怎么体验”。PSPMAN 紧接首屏作为社区精选，和第一方应用一起构成生态。</p><p>3DS 文档应用按公开仓库名称标为 <a href="https://github.com/pocket-stack/pocket-doc">Pocket Doc</a>。PSPMAN 标注社区作者、公开 alpha 和源码未公开；需要自行构建的项目不会显示为直接下载。</p><p><a href="/docs/overview/">查看手机端文档导航修复 →</a> <span>窄屏顶部的 Browse docs 可展开完整目录。</span></p></div></section>`,
  });
}
