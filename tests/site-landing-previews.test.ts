import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LANDING_STUDIES, renderLandingStudy } from "../site/landing-previews.ts";

const raw = readFileSync(new URL("../site/home.html", import.meta.url), "utf8");
const home = `<!doctype html><html><head><meta name="robots" content="index,follow"></head><body>${raw}<script type="module" src="/assets/landing.js"></script></body></html>`;
const hero = raw.match(/<section class="hero">[\s\S]*?<\/section>/)![0];
const heroContent = hero.slice(hero.indexOf('    <div class="col">'), hero.lastIndexOf("  </div>"));
const sections = [...raw.matchAll(/<section class="sect" id="([^"]+)">[\s\S]*?<\/section>/g)];

for (const study of LANDING_STUDIES) {
  test(`landing ${study.id} preserves the original hero content and complete technical chapters`, () => {
    const html = renderLandingStudy(study.id, home);
    expect(html).toContain(heroContent);
    expect(html).toContain(hero.match(/<div class="hero-bg"[\s\S]*?<\/div>/)![0]);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/assets/landing.js"></script>');
    let lastIndex = -1;
    for (const [section, id] of sections) {
      const index = html.indexOf(`<section class="sect" id="${id}">`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
      if (id !== "ecosystem") expect(html).toContain(section);
    }
    if (study.id === "c") expect(html).toContain(hero);
  });

  test(`landing ${study.id} retains existing case evidence and adds device setup routes`, () => {
    const html = renderLandingStudy(study.id, home);
    const ecosystem = sections.find(([, id]) => id === "ecosystem")![0];
    for (const [paragraph] of ecosystem.matchAll(/<p>[\s\S]*?<\/p>/g)) expect(html).toContain(paragraph);
    for (const [link] of ecosystem.matchAll(/<a class="story"[\s\S]*?<\/a>/g)) expect(html).toContain(link);
    expect(html.match(/data-app-card/g)).toHaveLength(10);
    for (const id of ["pocket-doc", "pocket-shell", "pocket-term", "pspman"]) {
      expect(html).toContain(`id="try-${id}"`);
    }
    expect(html).toContain('content="noindex,nofollow"');
  });
}

test("preview generation reports a changed homepage boundary instead of silently dropping content", () => {
  expect(() => renderLandingStudy("a", home.replace('id="write"', 'id="renamed"'))).toThrow("Expected one homepage marker");
});
