import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSingleLodStagePackage } from "../site/stage-package.ts";
import { BTN, PocketHost } from "../site/playground/host.js";
import {
  SITE_FOOTER_DESC,
  SITE_FOOTER_DESC_SLOT,
  injectSiteFooterDescription,
  renderPage,
} from "../site/templates.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGE = ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/";

function glbJson(path: string): any {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
  let offset = 12;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)).trim());
    }
    offset += 8 + length;
  }
  throw new Error("GLB has no JSON chunk");
}

test("homepage Stage package has one semantic screen and its declared suppression", () => {
  const profile = JSON.parse(readFileSync(PACKAGE + "profile.json", "utf8"));
  const gltf = glbJson(PACKAGE + profile.lods.orbit);
  type Material = { name?: string; extras?: Record<string, unknown> };
  const materials = gltf.materials as Material[];
  const primitiveMaterials: Material[] = gltf.meshes.flatMap((mesh: any) =>
    mesh.primitives.map((primitive: any) => materials[primitive.material]),
  );

  const screens = primitiveMaterials.filter((material) =>
    material.extras?.pocket3d_role === profile.screen.material_role ||
    material.name?.startsWith(profile.screen.material_name_prefix),
  );
  expect(screens).toHaveLength(profile.screen.expected_primitives);

  for (const entry of profile.suppressed_materials) {
    const matches = primitiveMaterials.filter((material) =>
      material.extras?.pocket3d_role === entry.material_role ||
      material.name?.startsWith(entry.material_name_prefix),
    );
    expect(matches).toHaveLength(entry.expected_primitives);
  }
});

test("homepage plays the machine collage", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  // The 3D stage moved to the playground; the homepage must not mount it.
  expect(home).not.toContain("data-pocket-stage");
  expect(home).not.toContain("lp-stage");
  // House style: no em dashes anywhere on the landing surfaces.
  for (const file of [
    "site/home.html",
    "site/for/shell.html",
    "site/for/interfaces.html",
    "site/for/games.html",
    "site/for/worlds.html",
    "site/for/agents.html",
  ]) {
    const source = readFileSync(ROOT + file, "utf8");
    expect(source).not.toContain("&mdash;");
    expect(source).not.toContain("—");
  }

  // The hero collage: eight machines, every screen a real capture. The Figma
  // screen is the zoomed-out page fit; the kit's cover art is never shown,
  // here or anywhere else on the site (site/bake-demo-wall.ts included).
  expect(home).toContain("data-collage");
  expect(home.match(/class="lp-dev /g)?.length).toBe(8);
  expect(home).toContain("/assets/blog/figma-psp-fit.png");
  for (const file of ["site/home.html", "site/bake-demo-wall.ts", "site/content/blog/pocket-figma.md"]) {
    expect(readFileSync(ROOT + file, "utf8")).not.toContain("figma-psp-cover-zoom");
  }
  expect(home).toContain("333 MHz / 32 MB");
  expect(home).toContain("4.19 MHz / 8 KB");
  expect(home).toContain("Rich interactive JavaScript where no browser fits.");
  expect(home).toContain("PocketJS is a compact JavaScript runtime");

  // The use-case cards link the four /for/ pages.
  for (const slug of ["interfaces", "games", "worlds", "agents"]) {
    expect(home).toContain(`href="/for/${slug}/"`);
  }
  // The retired sections stay retired.
  expect(home).not.toContain("Ship the application");
  expect(home).not.toContain("Built for every kind of impossible");
  expect(home).not.toContain("lp-pkg");
  expect(home).not.toContain("lp-imposs");

  // The /for/ pages are rendered with the homepage chrome.
  const build0 = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build0).toContain("renderForPage");
  expect(build0).toContain('for/shell.html');

  // The what-runs-where matrix is retired too.
  expect(home).not.toContain("data-mx");
  expect(home).not.toContain("What runs where");

  // The collage glue and styles.
  const homeGlue = readFileSync(ROOT + "site/assets/home.js", "utf8");
  expect(homeGlue).toContain("setupHeroCollage");
  expect(homeGlue).toContain("prefers-reduced-motion");
  expect(homeGlue).not.toContain("setupRotatingHero");
  expect(homeGlue).not.toContain("setupMachineMatrix");
  const homeCss = readFileSync(ROOT + "site/assets/home.css", "utf8");
  expect(homeCss).not.toContain(".lp-stage");
  expect(homeCss).not.toContain(".lp-rot");
  expect(homeCss).not.toContain(".lp-mx");
  expect(homeCss).toContain(".lp-dev");

  // The playground stage still ships the Pocket Launcher family as .pocket
  // packages (docs/LAUNCHER.md / docs/PLATFORM.md) — the deploy chain must
  // keep building and copying them.
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).toContain("dist/launcher-registry.json");
  expect(build).toContain('copy(source, `stage/apps/${output}.pocket`)');
  expect(build).toContain("emitSingleLodStagePackage");

  const adapter = readFileSync(ROOT + "site/assets/pocket-stage-web.js", "utf8");
  expect(adapter).toContain("profile.lods.orbit");
  expect(adapter).toContain("decodePocketPackage");

  const siteBuild = readFileSync(ROOT + "tools/site-build.ts", "utf8");
  expect(siteBuild).toContain('run("tools/launcher.ts", "pack")');
  expect(siteBuild).toContain('run("tools/build.ts", "hero")');

  for (const workflow of ["deploy.yml", "release.yml"]) {
    const source = readFileSync(ROOT + ".github/workflows/" + workflow, "utf8");
    expect(source).toContain("bun run site:build");
  }
});

test("playground wraps its live framebuffer in the PSP model", () => {
  const playground = readFileSync(ROOT + "site/playground/page.html", "utf8");
  for (const marker of [
    "data-pocket-stage",
    "data-stage-viewport",
    "data-stage-canvas",
    "data-stage-screen",
    "data-stage-status",
  ]) {
    expect(playground).toContain(marker);
  }
  expect(playground).toContain('id="pg-canvas" class="pg-stage__screen" data-stage-screen');
  expect(playground).toContain("Dibad");
  expect(playground).toContain("creativecommons.org/licenses/by/4.0");
  expect(playground).not.toContain("screen-emu");
  expect(playground).not.toContain("data-btn");

  // The stage is playground-only now: the homepage must not pull the module.
  const homeGlue = readFileSync(ROOT + "site/assets/home.js", "utf8");
  expect(homeGlue).not.toContain("pocket-stage-web.js");
  const playgroundGlue = readFileSync(ROOT + "site/playground/playground.js", "utf8");
  expect(playgroundGlue).toContain('import("/assets/pocket-stage-web.js")');
  expect(playgroundGlue).toContain("mountPocketStage");
  expect(playgroundGlue).toContain("host,");
  expect(playgroundGlue).toContain("stageController?.refreshScreen()");
  expect(playgroundGlue).toContain("stageController?.releaseInput();\n      host.reset();");

  const adapter = readFileSync(ROOT + "site/assets/pocket-stage-web.js", "utf8");
  expect(adapter).toContain("const stageHost = suppliedHost ?? new PocketHost()");
  expect(adapter).toContain("if (suppliedHost)");
  expect(adapter).toContain("const onSuppliedHostError = stageHost.onError");
  expect(adapter).toContain("releaseButton();\n        onSuppliedHostError(error);");
  expect(adapter).toContain("const modelUrl = STAGE_ROOT + profile.lods.orbit");
  expect(adapter).toContain("loader.loadAsync(modelUrl)");
  expect(adapter).toContain("screenCanvasId: screenCanvas.id || null");
  expect(adapter).toContain("lastPressedPart");
  expect(adapter).toContain("return { refreshScreen, releaseInput: releaseButton }");

  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).not.toContain("screen.css");
  expect(existsSync(ROOT + "site/assets/screen.css")).toBe(false);

  const css = readFileSync(ROOT + "site/assets/tailwind.css", "utf8");
  expect(css).toContain(".pg-stage.has-error .pg-stage__canvas { display: none; }");
  expect(css).toContain(".pg-stage.has-error .pg-stage__screen");
  expect(css).toContain(".pg-stage.has-error .pg-stage__viewport:focus-visible .pg-stage__screen");
});

test("playground spinner SVGs declare the browser image namespace", () => {
  const spinnerDir = ROOT + "assets/images/";
  const spinnerFiles = readdirSync(spinnerDir)
    .filter((file) => /^spinner-(?:0[0-7]|atlas)\.svg$/.test(file))
    .sort();
  expect(spinnerFiles).toEqual([
    "spinner-00.svg",
    "spinner-01.svg",
    "spinner-02.svg",
    "spinner-03.svg",
    "spinner-04.svg",
    "spinner-05.svg",
    "spinner-06.svg",
    "spinner-07.svg",
    "spinner-atlas.svg",
  ]);

  for (const file of spinnerFiles) {
    const svg = readFileSync(spinnerDir + file, "utf8");
    expect(svg).toMatch(/<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  }

  const compiler = readFileSync(ROOT + "site/playground/compiler-entry.ts", "utf8");
  expect(compiler).toContain("function svgImageBlob(source: string): Blob");
  expect(compiler).toContain("www.w3.org/2000/svg");
  expect(compiler).toContain("? svgImageBlob(await res.text())");
});

test("site build binds Vue Vapor runtime and JSX helper to the Pocket document", () => {
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).toContain('document: "globalThis.__pocketDocument"');

  const runtimeStart = build.indexOf("async function bundleVueVapor");
  const helperStart = build.indexOf("function patchVaporHelperCode");
  const writerStart = build.indexOf("function writeVueVaporHelpers");
  const headersStart = build.indexOf("function writeStaticHeaders");
  expect(runtimeStart).toBeGreaterThan(-1);
  expect(helperStart).toBeGreaterThan(runtimeStart);
  expect(writerStart).toBeGreaterThan(helperStart);
  expect(headersStart).toBeGreaterThan(writerStart);

  const runtimeBuild = build.slice(runtimeStart, helperStart);
  expect(runtimeBuild).toContain("...VUE_VAPOR_DOCUMENT_DEFINE");
  expect(runtimeBuild).toContain('if (!code.includes("globalThis.__pocketDocument"))');
  expect(runtimeBuild).toContain("Vue Vapor browser runtime does not target the PocketJS document facade");

  const helperBuild = build.slice(helperStart, writerStart);
  expect(helperBuild).toContain("define: VUE_VAPOR_DOCUMENT_DEFINE");

  const helperWriter = build.slice(writerStart, headersStart);
  expect(helperWriter).toContain("const isVaporHelper = id === vaporHelperId");
  expect(helperWriter).toContain("isVaporHelper ? patchVaporHelperCode(code) : code");
  expect(helperWriter).toContain(
    'if (isVaporHelper && !output.includes("globalThis.__pocketDocument"))',
  );
  expect(helperWriter).toContain("Vue Vapor JSX helper does not target the PocketJS document facade");
});

test("homepage and shared pages use one footer description", () => {
  const homeTemplate = readFileSync(ROOT + "site/home.html", "utf8");
  const siteBuild = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(homeTemplate).toContain(SITE_FOOTER_DESC_SLOT);
  expect(homeTemplate).not.toContain(SITE_FOOTER_DESC);
  expect(siteBuild).toContain('injectSiteFooterDescription(readFileSync(SITE + "home.html", "utf8"))');

  const homepage = injectSiteFooterDescription(homeTemplate);
  const sharedPage = renderPage({ title: "Docs", active: "docs", body: "" });
  for (const html of [homepage, sharedPage]) {
    expect(html.split(SITE_FOOTER_DESC)).toHaveLength(2);
    expect(html).not.toContain(SITE_FOOTER_DESC_SLOT);
  }

  expect(() => injectSiteFooterDescription("")).toThrow("found 0");
  expect(() => injectSiteFooterDescription(SITE_FOOTER_DESC_SLOT.repeat(2))).toThrow("found 2");
});

test("public PocketJS icon surfaces keep the metal mark on a black backing", () => {
  const favicon = readFileSync(ROOT + "site/assets/favicon.svg", "utf8");
  const backing = '<rect width="32" height="32" rx="7" fill="#0a0a0c"/>';
  expect(favicon).toContain(backing);
  expect(favicon.indexOf(backing)).toBeLessThan(favicon.indexOf('stroke="url(#pj-edge)"'));

  const readme = readFileSync(ROOT + "README.md", "utf8");
  expect(readme).toContain('src="./site/assets/favicon.svg"');

  const ogImage = readFileSync(ROOT + "site/assets/og-image.svg", "utf8");
  expect(ogImage).toContain('<rect width="1200" height="630" fill="#05070d"/>');
});

test("single-LOD web package rewrites every profile reference to a copied asset", () => {
  const output = mkdtempSync(join(tmpdir(), "pocketjs-stage-"));
  try {
    const profile = emitSingleLodStagePackage(PACKAGE, output, "psp-profile.json", "orbit");
    const lods = new Set(Object.values(profile.lods));
    expect(lods).toEqual(new Set(["psp_lod3_eco.glb"]));
    for (const file of lods) expect(existsSync(join(output, file))).toBe(true);
    expect(existsSync(join(output, profile.attribution))).toBe(true);
    expect(readdirSync(output).filter((file) => file.endsWith(".glb"))).toHaveLength(1);

    const emitted = JSON.parse(readFileSync(join(output, "psp-profile.json"), "utf8"));
    expect(emitted.lods).toEqual(profile.lods);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a fast button tap is released only after one guest turn observes it", () => {
  const host = new PocketHost();
  const seen: number[] = [];
  host.wasm = { tick() {}, drawHash: () => 0n };
  host.frameCb = (buttons: number) => seen.push(buttons);
  // Keep wake() from scheduling a real browser RAF in this deterministic test.
  host.rafId = 1;

  host.press(BTN.CIRCLE, true);
  const downTick = host.tickCount;
  host.afterNextTick(() => host.press(BTN.CIRCLE, false));
  expect(host.tickCount).toBe(downTick);
  expect(host.held & BTN.CIRCLE).toBe(BTN.CIRCLE);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE]);
  expect(host.held & BTN.CIRCLE).toBe(0);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE, 0]);
  host.rafId = 0;
});

test("a deferred button release can be canceled before a host reset", () => {
  const host = new PocketHost();
  host.wasm = { init() {}, ops: {}, tick() {}, drawHash: () => 0n };
  host.frameCb = () => {};
  host.rafId = 1;

  host.press(BTN.CIRCLE, true);
  const cancelRelease = host.afterNextTick(() => host.press(BTN.CIRCLE, false));
  const releaseInput = () => {
    cancelRelease();
    host.press(BTN.CIRCLE, false);
  };

  releaseInput();
  host.rafId = 0;
  host.reset();
  expect(host.held & BTN.CIRCLE).toBe(0);
});
