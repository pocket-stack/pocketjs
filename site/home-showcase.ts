import { DEVICES, SHOWCASE_APPS, type ShowcaseApp } from "./showcase.ts";

const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const app = (id: string) => SHOWCASE_APPS.find((item) => item.id === id)!;
const badges = (a: ShowcaseApp) => a.devices.map((d) => `<span>${DEVICES[d]}</span>`).join("");
const tryLink = (a: ShowcaseApp, label = "How to try") => `<a class="sc-try" href="${esc(a.href)}" data-open-app="${a.id}">${label}<span aria-hidden="true"> ↗</span><span class="sc-sr"> ${a.name}</span></a>`;

function once(html: string, marker: string, replacement: string): string {
  if (html.split(marker).length !== 2) throw new Error(`Expected one homepage marker: ${marker}`);
  return html.replace(marker, () => replacement);
}

function appEntry(a: ShowcaseApp): string {
  return `<a class="pe-entry" href="${esc(a.href)}" data-open-app="${a.id}"><img src="${a.image}" alt="${esc(a.imageAlt)}" width="80" height="50"><span class="pe-entry-copy"><strong>${a.name}</strong><span>${a.devices.map(d => DEVICES[d]).join(" · ")}${a.community ? " · Community" : ""}</span><small>${a.community ? "Public alpha · ObsoleteSony" : a.id === "pocket-voxel" ? "Web player + console export" : "Setup guide"}</small></span><span class="pe-arrow" aria-hidden="true">↗</span></a>`;
}

function appShelf(): string {
  return `<aside class="pe-shelf pe-strip" aria-label="Apps built with PocketJS"><div class="pe-shelf-heading"><span class="hud">Built with PocketJS</span></div><div class="pe-entries">${["pocket-shell", "openstrike", "pocket-voxel", "pspman"].map(id => appEntry(app(id))).join("")}</div></aside>`;
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


// Keep the authored homepage and its technical evidence; only fill the app
// slots and enrich the existing Ecosystem cards with devices and setup routes.
export function renderHomeShowcase(body: string): string {
  let home = once(body, "{{SHOWCASE_HERO}}", appShelf());
  home = enhanceEcosystem(home);
  return once(home, "{{SHOWCASE_DIALOGS}}", dialogs());
}
