// scripts/build.ts <app> — the TWO-PASS app build (DESIGN.md "Build pipeline").
//
//   bun scripts/build.ts demos/hero/app.tsx    (or just `hero`)
//   bun scripts/build.ts hero-main             (mounted demo entry)
//
// pass 1  transform & collect: framework-specific JSX + TS over every
//         .tsx/.ts reachable from the app entry (content-hash cached),
//         collecting candidate class strings + text codepoints from the AST.
// compile tailwind.ts -> styles.bin + src/styles.generated.ts;
//         bake-font.ts -> font atlas per used slot; demo images (PNG/SVG or a
//         placeholder); pak.ts packs it all -> dist/<app>.pak.
// pass 2  Bun.build (plugin serves the CACHED pass-1 transforms, iife,
//         target browser, minify false) -> dist/<app>.js.
//
// Flags:
//   --framework=solid|vue-vapor  select the framework for this build
//   --config=<path>              load a Pocket config file (default: pocket.config.ts)
//   --no-config                  ignore pocket.config.ts
//   --extra-chars=<string>       force extra codepoints into every atlas

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { PSM } from "../spec/spec.ts";
import {
  FRAMEWORKS,
  jsxPlugin,
  packagePath,
  parseFramework,
  transformFile,
  type PocketFramework,
} from "../compiler/jsx-plugin.ts";
import type { PocketConfig } from "../src/config.ts";
import { compileClasses, generateStylesModule } from "../compiler/tailwind.ts";
import { bakeAtlases } from "../compiler/bake-font.ts";
import { bakeSvg } from "../compiler/bake-svg.ts";
import {
  PAK_DTYPE,
  KEY_STYLES,
  decodePng,
  encodeImageEntry,
  keyFont,
  keyImage,
  pack,
  placeholderImage,
  type PakBlob,
} from "../compiler/pak.ts";

const ROOT = new URL("..", import.meta.url).pathname; // pocketjs/
const DIST = ROOT + "dist/";

interface PackageJson {
  name?: string;
}

const packageJson = await Bun.file(ROOT + "package.json").json() as PackageJson;
const packageName = packageJson.name ?? "@pocketjs/framework";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let extraChars = "";
let appArg = "";
let frameworkFlag: string | undefined;
let configPath = ROOT + "pocket.config.ts";
let useConfig = true;
for (const a of args) {
  if (a.startsWith("--extra-chars=")) extraChars = a.slice("--extra-chars=".length);
  else if (a.startsWith("--framework=")) frameworkFlag = a.slice("--framework=".length);
  else if (a.startsWith("--config=")) configPath = resolvePath(ROOT, a.slice("--config=".length));
  else if (a === "--no-config") useConfig = false;
  else if (!a.startsWith("-")) appArg = a;
}
if (!appArg) {
  console.error("usage: bun scripts/build.ts <app.tsx | app name> [--framework=solid|vue-vapor] [--extra-chars=...]");
  process.exit(1);
}

async function loadConfig(): Promise<PocketConfig> {
  if (!useConfig || !existsSync(configPath)) return {};
  const url = pathToFileURL(configPath);
  url.searchParams.set("mtime", String(statSync(configPath).mtimeMs));
  const mod = await import(url.href) as { default?: PocketConfig; config?: PocketConfig };
  return mod.default ?? mod.config ?? {};
}

const config = await loadConfig();
const framework: PocketFramework = frameworkFlag
  ? parseFramework(frameworkFlag, "--framework")
  : parseFramework(config.framework, "pocket.config.ts");
const frameworkConfig = FRAMEWORKS[framework];

function resolveEntry(arg: string): string {
  const normalized = arg.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  const bare = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  const isBareName = !arg.includes("/") && !arg.startsWith(".");
  const demoRel = normalized.replace(/^.*?demos\//, "");
  const demoName =
    demoRel.endsWith("/main")
      ? demoRel.slice(0, -"/main".length)
      : demoRel.endsWith("/app")
        ? demoRel.slice(0, -"/app".length)
        : bare.endsWith("-main")
          ? bare.slice(0, -"-main".length)
          : bare;
  const wantsMain = demoRel.endsWith("/main") || bare.endsWith("-main");
  const tries = [
    resolvePath(arg),
    resolvePath(ROOT, arg),
    wantsMain ? resolvePath(ROOT, "demos", demoName, "main.tsx") : "",
    !wantsMain ? resolvePath(ROOT, "demos", demoName, "app.tsx") : "",
    isBareName && !wantsMain ? resolvePath(ROOT, "demos", demoName, "main.tsx") : "",
    resolvePath(ROOT, "demos", arg),
    resolvePath(ROOT, "demos", arg + ".tsx"),
    resolvePath(ROOT, "demos", arg + ".ts"),
  ].filter(Boolean);
  for (const t of tries) {
    if (/\.tsx?$/.test(t) && existsSync(t) && statSync(t).isFile()) return t;
  }
  console.error(`PocketJS build: cannot resolve app "${arg}" (tried:\n  ${tries.join("\n  ")})`);
  process.exit(1);
}

const entry = resolveEntry(appArg);
function outputName(file: string): string {
  const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : file;
  const demo = rel.match(/^demos\/([^/]+)\/(app|main)\.tsx?$/);
  if (demo) return demo[2] === "main" ? `${demo[1]}-main` : demo[1];
  return file.split("/").pop()!.replace(/\.tsx?$/, "");
}

const appName = outputName(entry);
const outName = `${appName}${frameworkConfig.outputSuffix}`;
console.log(`PocketJS build: ${appName} (${entry}, framework=${framework})`);

// ---------------------------------------------------------------------------
// pass 1 — transform & collect over the entry's import graph
// ---------------------------------------------------------------------------

/** Extract import/re-export specifiers (our own code style — no dynamic import). */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*(["'])([^"']+)\1|(?:^|\n)\s*import\s*(["'])([^"']+)\3/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[2] ?? m[4]);
  return out;
}

/** Resolve a relative import the SAME way pass 2's Bun.build does (extension
 *  remapping like `./card.js` -> card.tsx included), so the two passes agree
 *  on the module graph by construction. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (spec === packageName || spec.startsWith(packageName + "/")) {
    const exported = packagePath(spec, framework);
    return exported && /\.tsx?$/.test(exported) ? exported : null;
  }
  if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) return null; // external bare
  let resolved: string;
  try {
    resolved = Bun.resolveSync(spec, fromFile.slice(0, fromFile.lastIndexOf("/")));
  } catch {
    return null;
  }
  return /\.tsx?$/.test(resolved) && !resolved.endsWith(".d.ts") ? resolved : null;
}

const classStrings: string[] = [];
const seenClass = new Set<string>();
const codepoints = new Set<number>();
const visited = new Set<string>();

async function walk(file: string): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  if (file.endsWith(".generated.ts")) return; // never scan generated output [R]
  const src = await Bun.file(file).text();
  const res = await transformFile(file, src, framework); // throws with code frame on lint errors
  for (const s of res.classStrings) {
    if (!seenClass.has(s)) {
      seenClass.add(s);
      classStrings.push(s);
    }
  }
  for (const cp of res.textCodepoints) codepoints.add(cp);
  for (const spec of importSpecifiers(src)) {
    const dep = resolveImport(file, spec);
    if (dep) await walk(dep);
  }
}

await walk(entry);
console.log(`  pass 1: ${visited.size} module(s), ${classStrings.length} candidate literal(s), ${codepoints.size} codepoint(s)`);

// ---------------------------------------------------------------------------
// compile styles + fonts + images
// ---------------------------------------------------------------------------

const styles = compileClasses(classStrings);
if (styles.records.length === 0) {
  console.warn("  tailwind: no class literals compiled — is the app unstyled?");
}
const generatedPath = ROOT + "src/styles.generated.ts";
await Bun.write(generatedPath, generateStylesModule(styles));
console.log(`  tailwind: ${styles.records.length} style record(s), ${Object.keys(styles.ids).length} literal(s) -> src/styles.generated.ts`);

const atlases = await bakeAtlases({
  codepoints,
  slots: styles.usedFontSlots,
  extraChars,
});
for (const a of atlases) {
  console.log(
    `  font: slot ${a.slot} (${a.px}px${a.bold ? " bold" : ""}) ${a.glyphCount} glyphs, cell ${a.cellW}x${a.cellH}, ${a.bytes.length} bytes`,
  );
}

// demo images: any collected literal ending .png/.svg is a candidate asset name
const blobs: PakBlob[] = [
  { key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: styles.bin },
  ...atlases.map((a) => ({ key: keyFont(a.slot), dtype: PAK_DTYPE.u8, data: a.bytes })),
];
const appDir = entry.slice(0, entry.lastIndexOf("/") + 1);
const imageNames = classStrings.filter((s) => /^[\w./-]+\.(?:png|svg)$/i.test(s));
for (const name of imageNames) {
  const candidates = [appDir + name, ROOT + "assets/images/" + name, ROOT + "assets/" + name];
  const found = candidates.find((c) => existsSync(c));
  let img;
  if (found) {
    if (/\.svg$/i.test(found)) {
      img = bakeSvg(await Bun.file(found).text());
      console.log(`  image: ${name} <- ${found} (${img.width}x${img.height}, svg)`);
    } else {
      img = decodePng(new Uint8Array(await Bun.file(found).arrayBuffer()));
      console.log(`  image: ${name} <- ${found} (${img.width}x${img.height})`);
    }
  } else {
    img = placeholderImage();
    console.log(`  image: ${name} not found (tried ${candidates.join(", ")}) — baking a 32x32 placeholder`);
  }
  blobs.push({ key: keyImage(name), dtype: PAK_DTYPE.u8, data: encodeImageEntry(img, PSM.PSM_8888) });
}

const pak = pack(blobs);
await Bun.write(DIST + outName + ".pak", pak);
console.log(`  pak: ${blobs.length} entries, ${pak.length} bytes -> dist/${outName}.pak`);

// ---------------------------------------------------------------------------
// pass 2 — bundle (served from the pass-1 cache)
// ---------------------------------------------------------------------------

// src/renderer.ts is owned by the js-runtime phase; if it does not exist yet,
// drop in the no-op placeholder so the bundle links (see DESIGN.md).
if (!existsSync(frameworkConfig.rendererPath)) {
  await Bun.write(frameworkConfig.rendererPath, placeholderRenderer());
  console.warn("  pass 2: renderer missing — wrote the no-op placeholder (js-runtime phase owns the real one)");
}

const result = await Bun.build({
  entrypoints: [entry],
  outdir: DIST,
  naming: `${outName}.js`,
  format: "iife",
  target: "browser",
  // solid-js MUST resolve via its "browser" export condition — the "node"
  // condition serves dist/server.js (SSR build) where reactive updates
  // silently no-op. See test/renderer.test.ts for the fail-fast guard.
  // Bun's bundler otherwise also enables the "development" condition, which
  // pulls Solid's dev builds and duplicates the root + universal runtimes.
  conditions: ["browser"],
  define: { "process.env.NODE_ENV": '"production"' },
  minify: false,
  sourcemap: "none",
  plugins: [jsxPlugin(framework, { entry })],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("PocketJS build: pass 2 bundling failed");
  process.exit(1);
}
const bundle = result.outputs.find((o) => o.path.endsWith(".js"));
console.log(`  pass 2: dist/${outName}.js (${bundle ? (await bundle.arrayBuffer()).byteLength : 0} bytes)`);
console.log("PocketJS build: done");

// ---------------------------------------------------------------------------

// Keep in sync with DESIGN.md's universal-renderer surface. This is ONLY a
// link-time stub for builds that run before the js-runtime phase lands.
function placeholderRenderer(): string {
  return `\
// placeholder, impl:js-runtime owns this — written by scripts/build.ts so
// pass-2 bundling links before src/renderer.ts is implemented. Every export
// is the no-op shape of Solid's universal-renderer output (createRenderer).
/* eslint-disable @typescript-eslint/no-unused-vars */

type Node = { type?: string; text?: string; children: Node[]; props: Record<string, unknown> };

const node = (type?: string, text?: string): Node => ({ type, text, children: [], props: {} });

export function render(code: () => unknown, _root?: unknown): () => void {
  code();
  return () => {};
}
export function effect<T>(fn: (prev?: T) => T, init?: T): void {
  fn(init);
}
export function memo<T>(fn: () => T): () => T {
  return fn;
}
export function createComponent(Comp: (props: unknown) => unknown, props: unknown): unknown {
  return Comp(props);
}
export function createElement(type: string): Node {
  return node(type);
}
export function createTextNode(value: string): Node {
  return node(undefined, value);
}
export function replaceText(n: Node, value: string): void {
  n.text = value;
}
export function insertNode(parent: Node, n: Node, _anchor?: Node): void {
  parent.children.push(n);
}
export function insert(_parent: Node, _accessor: unknown, _marker?: Node | null): void {}
export function spread(_n: Node, _props: unknown, _skipChildren?: boolean): void {}
export function setProp(n: Node, name: string, value: unknown, _prev?: unknown): unknown {
  n.props[name] = value;
  return value;
}
export function mergeProps(...sources: unknown[]): unknown {
  return Object.assign({}, ...sources);
}
export function use(fn: (el: Node) => void, el: Node): void {
  fn(el);
}
`;
}
