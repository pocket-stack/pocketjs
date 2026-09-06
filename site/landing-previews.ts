import { renderPage } from "./templates.ts";
import { DEVICES, SHOWCASE_APPS, type ShowcaseApp } from "./showcase.ts";

export const LANDING_STUDIES = [
  { id: "a", title: "右侧案例栏", subtitle: "原 Hero 右侧，补一列可体验的应用。", detail: "视频、像素标题、说明和按钮保持原样。桌面右侧增加四条应用入口；手机端接在原按钮之后。后续技术章节全部沿用。", label: "Hero side panel" },
  { id: "b", title: "Hero 内应用条", subtitle: "原按钮下方，加一条紧凑的案例预览。", detail: "在原 Hero 内追加一行应用缩略图、名称、设备和体验入口。首屏主体仍然是原来的标题与视频，往下仍然先读 Modern DX。", label: "Hero app strip" },
  { id: "c", title: "Hero 后案例带", subtitle: "Hero 完全原样，案例放在紧接着的一小段。", detail: "整个 Hero 连布局都保持原样。在它与 Modern DX 之间加一条案例带，给愿意继续浏览的人一个应用入口，之后接回完整技术介绍。", label: "After-hero app strip" },
] as const;
type Study = typeof LANDING_STUDIES[number]["id"];
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const app = (id: string) => SHOWCASE_APPS.find((item) => item.id === id)!;
const badges = (a: ShowcaseApp) => a.devices.map((d) => `<span>${DEVICES[d]}</span>`).join("");
const tryLink = (a: ShowcaseApp, label = "How to try") => `<a class="sc-try" href="${esc(a.href)}" data-open-app="${a.id}">${label}<span aria-hidden="true"> ↗</span><span class="sc-sr"> ${a.name}</span></a>`;

function once(html: string, marker: string, replacement: string): string {
  if (html.split(marker).length !== 2) throw new Error(`Expected one homepage marker: ${marker}`);
  return html.replace(marker, () => replacement);
}

function reviewbar(current?: Study): string {
  return `<nav class="pe-review" aria-label="Landing page alternatives"><span>局部增强</span>${LANDING_STUDIES.map((s) => `<a href="/_preview/landing/${s.id}/"${s.id === current ? ' aria-current="page"' : ""}>${s.id.toUpperCase()}<span> ${s.title}</span></a>`).join("")}<a href="/_preview/landing/">对比</a><a href="/">原版 ↗</a></nav>`;
}

function appEntry(a: ShowcaseApp): string {
  return `<a class="pe-entry" href="${esc(a.href)}" data-open-app="${a.id}"><img src="${a.image}" alt="${esc(a.imageAlt)}" width="80" height="50"><span class="pe-entry-copy"><strong>${a.name}</strong><span>${a.devices.map(d => DEVICES[d]).join(" · ")}${a.community ? " · Community" : ""}</span><small>${a.community ? "Public alpha · ObsoleteSony" : a.id === "pocket-voxel" ? "Web player + console export" : "Setup guide"}</small></span><span class="pe-arrow" aria-hidden="true">↗</span></a>`;
}

function appShelf(style: "side" | "strip" | "band"): string {
  return `<aside class="pe-shelf pe-${style}" aria-label="Apps built with PocketJS"><div class="pe-shelf-heading"><span class="hud">Built with PocketJS</span><a href="#ecosystem">All cases ↓</a></div><div class="pe-entries">${["pocket-doc", "openstrike", "pocket-voxel", "pspman"].map(id => appEntry(app(id))).join("")}</div></aside>`;
}

function ecosystemCard(a: ShowcaseApp): string {
  return `<article class="ecard" data-app-card data-devices="${a.devices.join(" ")}"><div class="scr pe-image-${a.id}"><img src="${a.image}" alt="${esc(a.imageAlt)}" loading="lazy"></div><div class="bd"><div class="sc-badges">${badges(a)}</div><h4>${a.name}<span>${a.community ? "community" : a.category}</span></h4><p>${a.description}${a.community ? " By ObsoleteSony. Public alpha; source currently private." : ""}</p>${tryLink(a)}<a class="story" href="${a.imageSource}">${a.community ? "Project & image credit" : "Project & capture details"} ↗</a></div></article>`;
}

function enhanceEcosystem(home: string): string {
  const start = home.indexOf('<section class="sect" id="ecosystem">');
  const end = home.indexOf("</section>", start) + "</section>".length;
  if (start < 0 || end < start) throw new Error("Missing original Ecosystem section");
  const original = home.slice(start, end);
  // Keep the six original cards, including their technical copy and story links.
  let content = original.replace(/<article class="ecard">[\s\S]*?<\/article>/g, (card) => {
    const a = SHOWCASE_APPS.find(a => card.includes(`<h4>${a.name}<span>`));
    let result = card.replace('<article class="ecard">', `<article class="ecard" data-app-card data-devices="${a ? a.devices.join(" ") : "other"}">`);
    if (!a) return result;
    result = result.replace(`<h4>${a.name}`, `<div class="sc-badges">${badges(a)}</div><h4>${a.name}`);
    return result.replace(/(\s*<\/div>\s*<\/article>)$/, `${tryLink(a)}$1`);
  });
  const filters = `<div class="pe-filters" role="group" aria-label="Filter ecosystem by device"><button type="button" data-filter="all" aria-pressed="true">All cases</button>${Object.entries(DEVICES).map(([id,label]) => `<button type="button" data-filter="${id}" aria-pressed="false">${label}</button>`).join("")}<span class="sc-count" role="status" aria-live="polite">10 cases</span></div>`;
  content = once(content, '<div class="eco">', filters + '<div class="eco">');
  const tail = '    </div>\n    <div class="labband">';
  content = once(content, tail, ["pocket-doc", "pocket-shell", "pocket-term", "pspman"].map(id => ecosystemCard(app(id))).join("\n") + "\n" + tail);
  return home.slice(0, start) + content + home.slice(end);
}

function dialogs(): string {
  return SHOWCASE_APPS.map((a) => `<dialog class="sc-dialog" id="try-${a.id}" aria-labelledby="title-${a.id}"><form method="dialog"><button class="sc-close" aria-label="Close ${a.name} details" autofocus>Close ×</button></form>
    <div class="sc-dialog-content"><p class="sc-eyebrow">${a.community ? "Community / " : ""}${a.owner} · ${a.category}</p><h2 id="title-${a.id}">${a.name}</h2><p>${a.description}</p><div class="sc-badges">${badges(a)}</div>
    <div class="sc-requirement"><strong>${a.availability}</strong><span>${a.requirement}</span></div><h3>How to try it</h3><ol>${a.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><div class="sc-actions"><a class="sc-button" href="${a.href}">${a.action} ↗</a>${a.source ? `<a class="sc-text-link" href="${a.source}">Source code ↗</a>` : ""}${a.story ? `<a class="sc-text-link" href="${a.story}">${a.community ? "About the project" : "Read the story"} ↗</a>` : ""}</div>
    <figure><img src="${a.image}" loading="lazy" width="480" height="272" alt="${esc(a.imageAlt)}"><figcaption><a href="${a.imageSource}">${a.imageCredit} ↗</a></figcaption></figure></div></dialog>`).join("");
}


// Extend the actual production HTML rather than keeping a separate homepage.
// Every technical section, shared asset and original hero child comes from it.
export function renderLandingStudy(id: Study, homeHtml: string): string {
  let home = enhanceEcosystem(homeHtml);
  const heroEnd = '  </div>\n</section>\n\n<section class="sect" id="write">';
  const addition = id === "c"
    ? `  </div>\n</section>\n<div class="pe-band-wrap"><div class="wrap">${appShelf("band")}</div></div>\n\n<section class="sect" id="write">`
    : `    ${appShelf(id === "a" ? "side" : "strip")}\n${heroEnd}`;
  home = once(home, heroEnd, addition);
  home = once(home, '<meta name="robots" content="index,follow">', '<meta name="robots" content="noindex,nofollow">');
  home = once(home, "</head>", '<link rel="stylesheet" href="/_preview/assets/showcase.css">\n</head>');
  home = once(home, "<body>", `<body class="pe-preview pe-layout-${id}">`);
  return once(home, "</body>", reviewbar(id) + dialogs() + '<script type="module" src="/_preview/assets/showcase.js"></script>\n</body>');
}

export function renderLandingStudyIndex(): string {
  return renderPage({ title: "Homepage additions", active: "home", bodyClass: "sc-index", path: "/_preview/landing/", robots: "noindex,nofollow", head: '<link rel="stylesheet" href="/_preview/assets/showcase.css">',
    body: `<section class="wrap pe-index"><p class="hud">PocketJS / Homepage additions</p><h1>原来的首页，<br>补上应用入口。</h1><p class="pe-index-lead">视频 Hero、像素标题、原按钮和全部技术章节都保留。<br>这次只比较一件事：案例入口放在哪里。</p><div class="pe-study-grid">${LANDING_STUDIES.map(s => `<a class="pe-study" href="/_preview/landing/${s.id}/"><div class="pe-mini pe-mini-${s.id}" aria-hidden="true"><span class="pe-mini-title">UI runtime for<br>every kind of<br>computer</span><span class="pe-mini-add">${s.id === "a" ? "案例栏" : s.id === "b" ? "应用条" : "Hero 后案例带"}</span><span class="pe-mini-tech">Modern DX · Motion · Architecture · Compatibility</span></div><div class="pe-study-copy"><span class="hud">${s.id.toUpperCase()} / ${s.label}</span><h2>${s.title} ↗</h2><strong>${s.subtitle}</strong><p>${s.detail}</p></div></a>`).join("")}</div><div class="pe-index-note"><p>三版都在原来的 <strong>Ecosystem</strong> 中保留既有案例与技术说明，增加 Pocket Doc、Pocket Shell、Pocket Term、PSPMAN，并补上设备筛选、运行条件和体验入口。</p><p><a href="/">查看原版首页 ↗</a> · <a href="/docs/overview/">查看手机文档目录修复 ↗</a></p></div></section>` + reviewbar(),
  });
}
