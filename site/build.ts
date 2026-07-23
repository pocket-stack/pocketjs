// site/build.ts — the pocketjs.dev static-site generator.
//
//   bun site/build.ts            # -> site/dist/  (the deployable tree)
//
// Produces:
//   /pg/runtime.js        the ONE PocketJS runtime bundle (import-map target)
//   /pg/compiler.js       the in-browser build pipeline (babel+tailwind+bake)
//   /pg/playground.bundle.js  CodeMirror editor + host loop + glue
//   /pg/pocketjs.wasm     Rust core + software rasterizer
//   /pg/fonts/*.ttf       Inter (the browser font baker fetches these)
//   /demo-assets/*        demo images (the browser image baker fetches these)
//   /pg/demos.json        editable single-file demos (name/title/source)
//   /playground/          the live editor page
//   /docs/*, /index.html  rendered from site/content (added below)

import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { marked } from "marked";
import { createHighlighter } from "shiki";
import {
  propsHelperCode,
  propsHelperId,
  ssrHelperCode,
  ssrHelperId,
  vaporHelperCode,
  vaporHelperId,
  vdomHelperCode,
  vdomHelperId,
} from "@vue-jsx-vapor/runtime/raw";
import { OG_IMAGE_URL, SITE_DESC, SITE_TITLE, SITE_URL, renderPage } from "./templates.ts";
import { BLOG_POSTS, DOC_NAV, type DocSection } from "./nav.ts";
import { emitSingleLodStagePackage } from "./stage-package.ts";

const ROOT = new URL("..", import.meta.url).pathname; // repo root
const SITE = ROOT + "site/";
const OUT = SITE + "dist/";
const SHIMS = SITE + "playground/babel-shims/";

const write = (rel: string, data: string | Uint8Array) => {
  const p = OUT + rel;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const copy = (from: string, toRel: string) => {
  const p = OUT + toRel;
  mkdirSync(dirname(p), { recursive: true });
  cpSync(from, p, { recursive: true });
};

// --- node-builtin shims: let @babel/core + preset-solid bundle for the browser
const SHIM_MAP: Record<string, string> = { assert: "assert.js", "node:assert": "assert.js", path: "path.js", "node:path": "path.js" };
const SHIM_EMPTY = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises", "os", "node:os", "module", "node:module",
  "url", "node:url", "util", "node:util", "zlib", "node:zlib", "stream", "node:stream",
  "tty", "node:tty", "crypto", "node:crypto", "v8", "node:v8", "process", "node:process",
]);
const shimPlugin: import("bun").BunPlugin = {
  name: "node-shims",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.path === "@vue-jsx-vapor/compiler-rs-wasm32-wasi") {
        return { path: SITE + "playground/vue-vapor-wasi.ts" };
      }
      if (SHIM_MAP[a.path]) return { path: SHIMS + SHIM_MAP[a.path] };
      if (SHIM_EMPTY.has(a.path)) return { path: SHIMS + "empty.js" };
      return undefined;
    });
  },
};

// A `process` shim, prepended before any bundled import runs (babel reads the
// global process.* at module-eval time — a define/import shim is too late).
const PROCESS_PRELUDE =
  `globalThis.process||=({env:{NODE_ENV:"production"},platform:"browser",arch:"wasm32",` +
  `versions:{node:"20.0.0"},version:"v20.0.0",argv:[],argv0:"",execPath:"",cwd:function(){return"/"},` +
  `chdir:function(){},nextTick:function(f){var a=[].slice.call(arguments,1);` +
  `Promise.resolve().then(function(){f.apply(null,a)})},on:function(){},once:function(){},off:function(){},` +
  `removeListener:function(){},emit:function(){},emitWarning:function(){},exit:function(){},` +
  `hrtime:function(){return[0,0]},browser:true});globalThis.global||=globalThis;\n`;

async function bundle(
  entry: string,
  outfile: string,
  opts: { shims?: boolean; prelude?: string; external?: string[] } = {},
) {
  const res = await Bun.build({
    entrypoints: [SITE + entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"', "process.env.BABEL_ENV": '"production"', "process.platform": '"browser"' },
    external: opts.external,
    minify: true,
    sourcemap: "none",
    plugins: opts.shims ? [shimPlugin] : [],
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error(`bundle failed: ${entry}`);
  }
  const code = (opts.prelude ?? "") + (await res.outputs[0].text());
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleSolid(outfile: string) {
  const packageJsonPath = Bun.resolveSync("solid-js/package.json", ROOT);
  const packageDir = dirname(packageJsonPath);
  const packageJson = await Bun.file(packageJsonPath).json() as {
    exports?: { "."?: { browser?: { import?: string }; import?: string } };
  };
  const browserEntry = packageJson.exports?.["."]?.browser?.import ?? packageJson.exports?.["."]?.import;
  if (!browserEntry) throw new Error("solid-js browser entry not found");
  const entry = join(packageDir, browserEntry);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: solid-js");
  }
  const code = await res.outputs[0].text();
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleSolidUniversal(outfile: string) {
  const entry = Bun.resolveSync("solid-js/universal", ROOT);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    external: ["solid-js"],
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: solid-js/universal");
  }
  const code = await res.outputs[0].text();
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleVueVapor(outfile: string) {
  const entry = Bun.resolveSync("vue/dist/vue.runtime-with-vapor.esm-browser.prod.js", ROOT);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: vue-vapor");
  }
  const code = await res.outputs[0].text();
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

function patchVaporHelperCode(code: string): string {
  return code.replace(
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        return Reflect.get`,
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        if (i && i.appContext.vapor && p === "inheritAttrs") {
          return false;
        }
        return Reflect.get`,
  );
}

function writeVueVaporHelpers(): void {
  const helpers = new Map([
    [propsHelperId, propsHelperCode],
    [vdomHelperId, vdomHelperCode],
    [vaporHelperId, patchVaporHelperCode(vaporHelperCode)],
    [ssrHelperId, ssrHelperCode],
  ]);
  for (const [id, code] of helpers) {
    const name = id.split("/").pop();
    if (!name) continue;
    write(`pg/vue-jsx-vapor/${name}.js`, code);
  }
  console.log("  pg/vue-jsx-vapor/*  (4 helpers)");
}

function writeStaticHeaders(): void {
  write(
    "_headers",
    `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`,
  );
}

// --- editable demos (mostly single-file; gallery inlines generated tile data)
type SpriteMeta = Record<string, { cols: number; rows: number; frames: number; step: number; psm?: number }>;
type DemoVariant = { framework: "solid" | "vue-vapor"; source: string; spriteMeta?: SpriteMeta };
type DemoEntry = { name: string; title: string; variants: DemoVariant[] };

function inlinePlaygroundImports(name: string, source: string): string | null {
  if (!/from\s+["']\.\.?\//.test(source)) return source;
  if (name !== "gallery") return null;
  const tilesPath = ROOT + "apps/gallery/tiles.ts";
  const tiles = readFileSync(tilesPath, "utf8").replace(/^export\s+/gm, "");
  return source.replace(
    /import\s+\{\s*GALLERY_PAGES,\s*TILES_PER_PAGE,\s*TILE_SRCS\s*\}\s+from\s+["']\.\/tiles\.ts["'];\n?/,
    tiles + "\n",
  );
}

function demoSpriteMeta(name: string): SpriteMeta | undefined {
  const path = ROOT + "apps/" + name + "/sprites.json";
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as SpriteMeta;
}

function demoManifest() {
  const dir = ROOT + "apps/";
  const out: DemoEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const app = dir + name + "/app.tsx";
    const vueApp = dir + name + "/app.vue-vapor.tsx";
    const main = dir + name + "/main.tsx";
    if (!existsSync(app)) continue;
    // The playground (and every demo shelf on the site) shows only
    // PSP-admissible demos: a committed manifest that does not resolve
    // against the psp target (desktop-only capabilities, non-console
    // viewport) keeps its demo off the site.
    const manifestPath = dir + name + "/pocket.json";
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!validateAndResolveBuildPlan(manifest, { target: "psp" }).ok) continue;
    }
    const source = inlinePlaygroundImports(name, readFileSync(app, "utf8"));
    if (source === null) continue; // multi-file demo
    let title = name[0].toUpperCase() + name.slice(1);
    if (existsSync(main)) {
      const mainSource = readFileSync(main, "utf8");
      if (/@playground\s+false\b/.test(mainSource)) continue;
      const m = mainSource.match(/@title\s+PocketJS:\s*(.+)/);
      if (m) title = m[1].trim();
    }
    const spriteMeta = demoSpriteMeta(name);
    const variants: DemoVariant[] = [{ framework: "solid", source, spriteMeta }];
    if (existsSync(vueApp)) {
      const vueSource = inlinePlaygroundImports(name, readFileSync(vueApp, "utf8"));
      if (vueSource !== null) {
        variants.push({ framework: "vue-vapor", source: vueSource, spriteMeta });
      }
    }
    out.push({ name, title, variants });
  }
  return out;
}

function copyDemoAssets(): void {
  const demosDir = ROOT + "apps/";
  for (const name of readdirSync(demosDir)) {
    const dir = demosDir + name + "/";
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (/\.(?:png|svg)$/i.test(file)) copy(dir + file, "demo-assets/" + file);
    }
  }
}

async function main() {
  console.log("pocketjs.dev build:");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeStaticHeaders();

  // 1. bundles
  await bundleSolid("pg/solid.js");
  await bundleSolidUniversal("pg/solid-universal.js");
  await bundleVueVapor("pg/vue-vapor.js");
  writeVueVaporHelpers();
  await bundle("playground/runtime-entry.ts", "pg/runtime.js", { external: ["solid-js", "solid-js/universal"] });
  await bundle("playground/runtime-vue-vapor-entry.ts", "pg/runtime-vue-vapor.js", { external: ["vue"] });
  await bundle("playground/compiler-entry.ts", "pg/compiler.js", { shims: true, prelude: PROCESS_PRELUDE });
  await bundle("playground/playground.js", "pg/playground.bundle.js");
  await bundle("assets/pocket-stage-web.js", "assets/pocket-stage-web.js");

  // 2. runtime assets
  // Keep the editor-facing URL byte-identical to the schema used by the
  // validator. The deployed path is POCKET_MANIFEST_SCHEMA_ID.
  copy(ROOT + "contracts/schema/pocket-2.json", "contracts/schema/pocket-2.json");
  copy(ROOT + "hosts/web/pocketjs.wasm", "pg/pocketjs.wasm");
  copy(ROOT + "assets/fonts/Inter-Regular.ttf", "pg/fonts/Inter-Regular.ttf");
  copy(ROOT + "assets/fonts/Inter-Bold.ttf", "pg/fonts/Inter-Bold.ttf");
  for (const f of readdirSync(ROOT + "assets/images/")) copy(ROOT + "assets/images/" + f, "demo-assets/" + f);
  copyDemoAssets();

  // Homepage Pocket Stage package: the Pocket Launcher plus every admitted
  // app (docs/LAUNCHER.md) — the same deck the PSP EBOOT ships, wasm-rendered.
  // The deploy workflow builds the launcher family first; fail here instead
  // of silently publishing a shell with a missing screen app when
  // site/build.ts is run by hand.
  const registryPath = ROOT + "dist/launcher-registry.json";
  if (!existsSync(registryPath)) {
    throw new Error("missing dist/launcher-registry.json — run: bun tools/launcher.ts covers");
  }
  const launcherRegistry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    apps: { output: string; id: string; title: string }[];
  };
  const stageApps = ["launcher-main", ...launcherRegistry.apps.map((a) => a.output)];
  for (const output of stageApps) {
    const source = ROOT + `dist/packages/${output}.pocket`;
    if (!existsSync(source)) {
      throw new Error(`missing dist/packages/${output}.pocket — run: bun tools/launcher.ts pack`);
    }
    copy(source, `stage/apps/${output}.pocket`);
  }
  write(
    "stage/apps/apps.json",
    JSON.stringify({
      apps: launcherRegistry.apps.map(({ output, id, title }) => ({ output, id, title })),
    }),
  );
  const pspPackage = ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/";
  emitSingleLodStagePackage(pspPackage, OUT + "stage/", "psp-profile.json", "orbit");

  // 3. demos manifest
  const demos = demoManifest();
  write("pg/demos.json", JSON.stringify(demos));
  console.log(`  pg/demos.json  (${demos.length} demos: ${demos.map((d) => d.name).join(", ")})`);

  // 4. static assets + Tailwind CSS (compiled AFTER pages exist so the content
  //    scan sees every class; we render pages to a temp first, then compile).
  for (const asset of ["favicon.svg", "og-image.svg", "og-image.png"]) {
    if (existsSync(SITE + "assets/" + asset)) copy(SITE + "assets/" + asset, asset);
  }
  // OpenStrike desktop screenshot (referenced by the shipping-openstrike post).
  copy(SITE + "assets/os-dust2.jpg", "assets/os-dust2.jpg");
  // The original hardware capture (embedded by the introducing-pocketjs post).
  copy(SITE + "assets/pocketjs-hardware-demo.mp4", "assets/pocketjs-hardware-demo.mp4");
  // The hero demo wall + its poster frame (baked by site/bake-demo-wall.ts).
  copy(SITE + "assets/pocketjs-demo-wall.mp4", "assets/pocketjs-demo-wall.mp4");
  copy(SITE + "assets/pocketjs-demo-wall.jpg", "assets/pocketjs-demo-wall.jpg");
  // The Pocket Vapor promo film (embedded at the top of the pocket-vapor post;
  // rendered by vapor/scripts/promo/, poster frame lives in assets/blog/).
  copy(SITE + "assets/pocket-vapor-promo.mp4", "assets/pocket-vapor-promo.mp4");
  // Blog illustration loops (animated GIFs rendered by the engine itself).
  if (existsSync(SITE + "assets/blog/")) {
    for (const f of readdirSync(SITE + "assets/blog/")) copy(SITE + "assets/blog/" + f, "assets/blog/" + f);
  }

  // 5. playground page
  write("playground/index.html", renderPage({
    title: "Playground",
    active: "playground",
    body: readFileSync(SITE + "playground/page.html", "utf8"),
    bodyClass: "pg-page",
    head: IMPORT_MAP + '\n<link rel="stylesheet" href="/assets/screen.css">',
    scripts: ['<script type="module" src="/pg/playground.bundle.js"></script>'],
    path: "/playground/",
  }));
  copy(SITE + "assets/screen.css", "assets/screen.css");

  // 6. homepage — bespoke "cinematic" design: its own chrome + home.css +
  //    home.js (the baked demo wall + lazy Pocket Stage). Not wrapped in the shared
  //    header/footer (those stay for docs + playground).
  write("index.html", renderHome());
  copy(SITE + "assets/home.css", "assets/home.css");
  await bundle("assets/home.js", "assets/home.js");

  // 7. docs + blog (setupMarkdown installs the shared marked/shiki renderer)
  const highlight = await setupMarkdown();
  await buildDocs(highlight);
  await buildBlog();
  buildChangelog();

  // 7b. 404
  write("404.html", renderPage({
    title: "Not found",
    active: "",
    bodyClass: "",
    head: "",
    scripts: [],
    path: "/404.html",
    body: `<section class="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-5 py-24 text-center">
      <div class="font-mono text-6xl font-bold text-gradient">404</div>
      <h1 class="mt-4 text-2xl font-bold text-slate-100">This screen doesn't exist.</h1>
      <p class="mt-2 text-slate-400">The page you're looking for isn't in the tree — try the docs or head home.</p>
      <div class="mt-7 flex gap-3"><a href="/" class="btn btn-primary px-5 py-2.5">Home</a><a href="/docs/overview/" class="btn px-5 py-2.5">Docs</a></div>
    </section>`,
  }));

  // 8. Tailwind CSS (@source in tailwind.css scans the site/ SOURCE for classes)
  await compileCss();

  console.log("pocketjs.dev build: done -> site/dist/");
}

// The homepage is a standalone document (cinematic design owns its own header +
// footer + CSS). site/home.html holds the body; site/assets/home.css the styles.
const HOME_DESC = SITE_DESC;
function renderHome(): string {
  const body = readFileSync(SITE + "home.html", "utf8");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "PocketJS",
    description: SITE_DESC,
    url: SITE_URL,
    codeRepository: "https://github.com/pocket-stack/pocketjs",
    programmingLanguage: ["TypeScript", "JavaScript", "Rust"],
    runtimePlatform: ["Sony PSP", "Sony PS Vita", "PPSSPP", "Vita3K", "WebAssembly", "Bun"],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_TITLE}</title>
<meta name="description" content="${HOME_DESC}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${SITE_URL}/">
<meta property="og:title" content="${SITE_TITLE}">
<meta property="og:description" content="${HOME_DESC}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="PocketJS — Bare Metal Modern Web">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SITE_TITLE}">
<meta name="twitter:description" content="${HOME_DESC}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#05070d">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/home.css">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
${body}
<script type="module" src="/assets/home.js"></script>
</body>
</html>`;
}

async function compileCss() {
  const proc = Bun.spawnSync(
    ["bunx", "@tailwindcss/cli", "-i", SITE + "assets/tailwind.css", "-o", OUT + "assets/site.css", "--minify"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    throw new Error("tailwind build failed");
  }
  const bytes = Bun.file(OUT + "assets/site.css").size;
  console.log(`  assets/site.css  (${(bytes / 1024).toFixed(0)} KiB)`);
}

// import-map so compiled apps resolve PocketJS to one runtime and Solid to its
// own dependency bundle.
const IMPORT_MAP = `<script type="importmap">
{"imports":{
  "solid-js":"/pg/solid.js",
  "solid-js/universal":"/pg/solid-universal.js",
  "vue":"/pg/vue-vapor.js",
  "/vue-jsx-vapor/props":"/pg/vue-jsx-vapor/props.js",
  "/vue-jsx-vapor/vdom":"/pg/vue-jsx-vapor/vdom.js",
  "/vue-jsx-vapor/vapor":"/pg/vue-jsx-vapor/vapor.js",
  "/vue-jsx-vapor/ssr":"/pg/vue-jsx-vapor/ssr.js",
  "@pocketjs/framework":"/pg/runtime.js",
  "@pocketjs/framework/components":"/pg/runtime.js",
  "@pocketjs/framework/animation":"/pg/runtime.js",
  "@pocketjs/framework/lifecycle":"/pg/runtime.js",
  "@pocketjs/framework/input":"/pg/runtime.js",
  "@pocketjs/framework/renderer":"/pg/runtime.js",
  "@pocketjs/framework/solid":"/pg/runtime.js",
  "@pocketjs/framework/solid/components":"/pg/runtime.js",
  "@pocketjs/framework/solid/lifecycle":"/pg/runtime.js",
  "@pocketjs/framework/solid/renderer":"/pg/runtime.js",
  "@pocketjs/framework/vue-vapor":"/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/animation":"/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/components":"/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/input":"/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/lifecycle":"/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/renderer":"/pg/runtime-vue-vapor.js"
}}
</script>`;

type Highlight = (text: string, rawLang: string) => string;

// Syntax highlighting: Shiki (build-time, self-contained themed HTML) matched
// to the playground editor's one-dark-pro. Installs marked's code renderer so
// every fenced block (docs + blog) becomes a highlighted <pre class="shiki">.
async function setupMarkdown(): Promise<Highlight> {
  const highlighter = await createHighlighter({
    themes: ["one-dark-pro"],
    langs: ["tsx", "typescript", "jsx", "javascript", "json", "bash", "rust", "toml", "html", "css", "diff"],
  });
  const LANG_ALIAS: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", console: "bash", jsonc: "json", rs: "rust", text: "text", txt: "text" };
  const loaded = new Set(highlighter.getLoadedLanguages());
  const highlight = (text: string, rawLang: string) => {
    const raw = rawLang.trim().split(/\s+/)[0].toLowerCase();
    const lang = LANG_ALIAS[raw] ?? raw;
    const use = loaded.has(lang) ? lang : "text";
    return highlighter.codeToHtml(text, { theme: "one-dark-pro", lang: use });
  };
  marked.use({
    renderer: {
      code(token: { text?: string; lang?: string }) {
        const text = token.text ?? "";
        return highlight(text, token.lang ?? "");
      },
      // GitHub-style heading slugs so in-page anchors (#3d-transforms) and
      // deep links into docs sections work.
      heading(token: { tokens?: unknown[]; depth?: number; text?: string }) {
        const depth = token.depth ?? 1;
        const html = this.parser!.parseInline(token.tokens as never);
        const slug = (token.text ?? "")
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[`*_]/g, "")
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        return `<h${depth} id="${slug}">${html}</h${depth}>\n`;
      },
    },
  });
  return highlight;
}

async function buildDocs(highlight: Highlight) {
  let frameworkCodeId = 0;
  const renderFrameworkCode = (markdown: string) =>
    markdown.replace(/:::framework-code\n([\s\S]*?)\n:::/g, (_match, body: string) => {
      const variants: { framework: "solid" | "vue-vapor"; code: string; lang: string; label: string }[] = [];
      body.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_fence, meta: string, code: string) => {
        const parts = meta.trim().split(/\s+/);
        const framework = parts.find((part: string) => part === "solid" || part === "vue-vapor") as
          | "solid"
          | "vue-vapor"
          | undefined;
        if (!framework) return "";
        variants.push({
          framework,
          code: code.replace(/\n$/, ""),
          lang: parts[0] || "text",
          label: framework === "solid" ? "Solid" : "Vue Vapor",
        });
        return "";
      });
      if (variants.length === 0) return body;
      const id = frameworkCodeId++;
      const group = `doc-fw-code-${id}`;
      const inputs = variants
        .map((variant, i) =>
          `<input class="doc-fw-radio doc-fw-radio-${variant.framework}" type="radio" name="${group}" id="${group}-${variant.framework}"${i === 0 ? " checked" : ""}>`,
        )
        .join("");
      const tabs = variants
        .map(
          (variant) =>
            `<label class="doc-fw-tab doc-fw-tab-${variant.framework}" for="${group}-${variant.framework}">${variant.label}</label>`,
        )
        .join("");
      const panels = variants
        .map(
          (variant) =>
            `<div class="doc-fw-panel doc-fw-panel-${variant.framework}" data-framework="${variant.framework}">${highlight(variant.code, variant.lang)}</div>`,
        )
        .join("");
      return `<div class="doc-fw-code">${inputs}<div class="doc-fw-tabs" role="tablist">${tabs}</div><div class="doc-fw-panels">${panels}</div></div>`;
    });
  type DocsTree = {
    active: string;
    docsDir: string;
    head: string;
    nav: DocSection[];
    outPrefix: string;
    robots?: string;
    transformFrameworkCode: boolean;
  };
  const buildTree = async (tree: DocsTree) => {
    if (!existsSync(tree.docsDir)) return;
    const hrefFor = (slug: string) => `/${tree.outPrefix}/${slug}/`;
    const sidebarFor = (active: string) =>
      tree.nav.map(
        (sec) =>
          `<div class="doc-sec"><div class="doc-sec-t">${sec.title}</div>` +
          sec.items
            .map((it) => `<a href="${hrefFor(it.slug)}" class="${it.slug === active ? "on" : ""}">${it.title}</a>`)
            .join("") +
          `</div>`,
      ).join("");
    const allSlugs = tree.nav.flatMap((s) => s.items);
    for (let i = 0; i < allSlugs.length; i++) {
      const { slug, title } = allSlugs[i];
      const md = tree.docsDir + slug + ".md";
      if (!existsSync(md)) {
        console.warn(`  ${tree.outPrefix}: MISSING ${slug}.md`);
        continue;
      }
      const source = readFileSync(md, "utf8");
      const html = await marked.parse(tree.transformFrameworkCode ? renderFrameworkCode(source) : source);
      const prev = allSlugs[i - 1];
      const next = allSlugs[i + 1];
      const pager =
        `<nav class="doc-pager">` +
        (prev ? `<a href="${hrefFor(prev.slug)}" class="prev"><span>Previous</span>${prev.title}</a>` : `<span></span>`) +
        (next ? `<a href="${hrefFor(next.slug)}" class="next"><span>Next</span>${next.title}</a>` : `<span></span>`) +
        `</nav>`;
      const body =
        `<div class="doc-shell"><aside class="doc-nav">${sidebarFor(slug)}</aside>` +
        `<article class="doc-body" data-slug="${slug}"><div class="prose prose-invert max-w-none doc-content">${html}</div>${pager}</article></div>`;
      write(`${tree.outPrefix}/${slug}/index.html`, renderPage({
        title,
        active: tree.active,
        body,
        bodyClass: "doc-page",
        head: tree.head,
        scripts: [],
        path: hrefFor(slug),
        robots: tree.robots,
      }));
    }
    if (allSlugs.length > 0) {
      const robotsMeta = tree.robots ? `<meta name="robots" content="${tree.robots}">` : "";
      write(
        `${tree.outPrefix}/index.html`,
        `<!doctype html><meta charset="utf-8">${robotsMeta}<meta http-equiv="refresh" content="0; url=${hrefFor(allSlugs[0].slug)}">`,
      );
    }
    console.log(`  ${tree.outPrefix}  (${allSlugs.length} pages)`);
  };

  await buildTree({
    active: "docs",
    docsDir: SITE + "content/docs/",
    head: IMPORT_MAP,
    nav: DOC_NAV,
    outPrefix: "docs",
    transformFrameworkCode: true,
  });
}

// --- blog: /blog/ index + one page per post from site/content/blog/<slug>.md.
// Relies on the marked/shiki renderer installed by setupMarkdown().
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatPostDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const BLOG_DESC = "Announcements and engineering notes from the PocketJS team.";
function buildChangelog() {
  const md = SITE + "content/changelog.md";
  if (!existsSync(md)) return;
  const html = marked.parse(readFileSync(md, "utf8")) as string;
  write("changelog/index.html", renderPage({
    title: "Changelog",
    active: "changelog",
    desc: "Engine and site milestones — what shipped in each PocketJS release.",
    path: "/changelog/",
    body:
      `<main class="mx-auto w-full max-w-3xl px-6 py-14">` +
      `<article class="prose prose-invert max-w-none doc-content">${html}</article>` +
      `</main>`,
  }));
  console.log("  changelog  (1 page)");
}

async function buildBlog() {
  const dir = SITE + "content/blog/";
  const posts = [...BLOG_POSTS].sort((a, b) => (a.date < b.date ? 1 : -1));
  const rendered: typeof posts = [];
  for (const post of posts) {
    const md = dir + post.slug + ".md";
    if (!existsSync(md)) {
      console.warn(`  blog: MISSING ${post.slug}.md`);
      continue;
    }
    const html = await marked.parse(readFileSync(md, "utf8"));
    const body =
      `<article class="mx-auto max-w-3xl px-5 py-14">` +
      `<a href="/blog/" class="text-sm text-slate-400 hover:text-brand-2">&larr; Blog</a>` +
      `<header class="mt-4 border-b border-line pb-8">` +
      `<time datetime="${post.date}" class="font-mono text-xs uppercase tracking-wide text-slate-500">${formatPostDate(post.date)}</time>` +
      `<h1 class="mt-3 text-4xl font-bold tracking-tight text-slate-100">${post.title}</h1>` +
      `<p class="mt-4 text-lg text-slate-400">${post.description}</p>` +
      `<p class="mt-4 text-sm text-slate-400">Written by <a class="font-semibold text-slate-200 hover:text-brand-2" href="${post.author.url}" target="_blank" rel="noreferrer">${post.author.name}</a></p>` +
      `</header>` +
      `<div class="prose prose-invert max-w-none doc-content mt-8">${html}</div>` +
      `</article>`;
    write(`blog/${post.slug}/index.html`, renderPage({
      title: post.title,
      active: "blog",
      body,
      bodyClass: "",
      head: "",
      scripts: [],
      path: `/blog/${post.slug}/`,
      description: post.description,
    }));
    rendered.push(post);
  }
  const cards = rendered
    .map(
      (p) =>
        `<a href="/blog/${p.slug}/" class="group block rounded-xl border border-line bg-surface/60 p-6 transition-colors hover:border-brand">` +
        `<time datetime="${p.date}" class="font-mono text-xs uppercase tracking-wide text-slate-500">${formatPostDate(p.date)}</time>` +
        `<h2 class="mt-2 text-2xl font-bold text-slate-100 group-hover:text-brand-2">${p.title}</h2>` +
        `<p class="mt-2 text-slate-400">${p.description}</p>` +
        `<span class="mt-4 inline-block text-sm font-semibold text-brand-2">Read post &rarr;</span>` +
        `</a>`,
    )
    .join("");
  write("blog/index.html", renderPage({
    title: "Blog",
    active: "blog",
    body:
      `<section class="mx-auto max-w-3xl px-5 pb-20 pt-14">` +
      `<h1 class="text-4xl font-bold tracking-tight text-slate-100">Blog</h1>` +
      `<p class="mt-3 text-slate-400">${BLOG_DESC}</p>` +
      `<div class="mt-10 grid gap-5">${cards}</div>` +
      `</section>`,
    bodyClass: "",
    head: "",
    scripts: [],
    path: "/blog/",
    description: BLOG_DESC,
  }));
  console.log(`  blog  (${rendered.length} posts)`);
}

await main();
