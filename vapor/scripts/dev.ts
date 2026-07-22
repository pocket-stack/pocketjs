#!/usr/bin/env bun
// vapor/scripts/dev.ts — the visible oracle: run a Pocket Vapor app on REAL
// Vue Vapor, in a real browser, with a real DOM you can inspect.
//
//   bun vapor/scripts/dev.ts [component.tsx] [--port 4173]
//
// The page mounts the same component file the cartridges are compiled from,
// through the same vue-jsx-vapor pipeline — but onto the browser DOM: every
// <row> is a live element (devtools-inspectable), keyboard maps to the pad,
// and ?target=web|gba|gb|nes re-renders with that console's screen geometry
// and style lowering, so degradation is something you can SEE while
// debugging. Keys: arrows = d-pad, Z=A, X=B, Enter=Start, Shift=Select,
// A=L, S=R.

import { join, resolve } from "node:path";
import { jsxPlugin } from "../../framework/compiler/jsx-plugin.ts";
import { compileVaporApp, VAPOR_TARGETS, type VaporTargetName } from "../compiler/compile.ts";
import { styleTableCss } from "../compiler/styles.ts";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4173;
if (portIdx >= 0) args.splice(portIdx, 2);
const entry = resolve(args.find((a) => !a.startsWith("--")) ?? join(import.meta.dir, "..", "examples", "todo", "todo.tsx"));
const HOST_DIR = join(import.meta.dir, "..", "host");
const OUT = join(import.meta.dir, "..", "..", "dist", "vapor");

const TARGET_DIMS: Record<string, { w: number; h: number }> = {
  web: { w: 30, h: 20 },
  gba: { w: 30, h: 20 },
  gb: { w: 20, h: 18 },
  nes: { w: 22, h: 18 },
};

function pickTarget(url: URL): string {
  const t = url.searchParams.get("target") ?? "web";
  return t in TARGET_DIMS ? t : "web";
}

async function buildAppBundle(): Promise<string> {
  const devEntry = join(OUT, "dev-entry.ts");
  await Bun.write(
    devEntry,
    `import { createVaporApp } from "vue";
import App from ${JSON.stringify(entry)};
import { __dispatchButton } from ${JSON.stringify(join(HOST_DIR, "input.ts"))};
import { parseRowClass } from ${JSON.stringify(join(import.meta.dir, "..", "compiler", "styles.ts"))};

const screen = document.getElementById("screen")!;
const app = createVaporApp({ setup: () => (App as unknown as () => unknown)() });
app.mount(screen);

// decorate rows: cell positioning + pair id for the target stylesheet
const pairs = (globalThis as Record<string, unknown>).__vaporPairs as { ink: number; paper: number }[];
const W = Number((globalThis as Record<string, unknown>).__vaporScreenW);
function decorate() {
  for (const el of Array.from(screen.querySelectorAll("row")) as HTMLElement[]) {
    const y = Number(el.getAttribute("y") ?? 0);
    const x = Number(el.getAttribute("x") ?? 0);
    const { style } = parseRowClass(el.className ?? "");
    let id = pairs.findIndex((p) => p.ink === style.ink && p.paper === style.paper);
    if (id < 0) id = 0;
    const len = (el.textContent ?? "").length;
    const start = style.align === 1 ? (W - len) >> 1 : style.align === 2 ? W - len : x;
    el.style.setProperty("--y", String(y));
    el.style.paddingLeft = Math.max(0, start) + "ch";
    el.setAttribute("data-pal", String(id));
  }
}
// attributeFilter matters: decorate() writes style/data-pal, and observing
// those would re-trigger the observer forever (microtask livelock)
new MutationObserver(decorate).observe(screen, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["class", "y", "x"],
});
decorate();

const KEYMAP: Record<string, number> = {
  z: 0, Z: 0, x: 1, X: 1, Shift: 2, Enter: 3,
  ArrowRight: 4, ArrowLeft: 5, ArrowUp: 6, ArrowDown: 7,
  s: 8, S: 8, a: 9, A: 9,
};
addEventListener("keydown", (e) => {
  const b = KEYMAP[e.key];
  if (b !== undefined) {
    e.preventDefault();
    __dispatchButton(b);
  }
});
`,
  );
  const result = await Bun.build({
    entrypoints: [devEntry],
    format: "iife",
    target: "browser",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [jsxPlugin("vue-vapor")],
  });
  if (!result.success) throw new Error(`dev bundle failed:\n${result.logs.join("\n")}`);
  return await result.outputs[0].text();
}

function page(target: string): string {
  const dims = TARGET_DIMS[target];
  const source = Bun.file(entry);
  void source;
  const styles = compileVaporApp(entry, FILE_CACHE, "DEV", (target === "web" ? "gba" : target) as VaporTargetName).styles;
  const pairsJson = JSON.stringify(styles.pairs.map((p) => ({ ink: p.ink, paper: p.paper })));
  const picker = Object.keys(TARGET_DIMS)
    .map((t) => (t === target ? `<b>[${t}]</b>` : `<a href="/?target=${t}">${t}</a>`))
    .join(" ");
  return `<!doctype html>
<meta charset="utf-8"><title>pocket vapor dev — ${target}</title>
<style>
  :root { --ch-h: 22px; }
  body { background:#0b0e1a; color:#8b96ad; font: 14px ui-monospace, monospace; display:flex;
         flex-direction:column; align-items:center; gap:12px; padding:24px; }
  a { color:#42b883; } b { color:#e6edf3; }
  #screen { position:relative; width:${dims.w}ch; height:calc(${dims.h} * var(--ch-h));
            font: 18px/22px ui-monospace, monospace; background:#101423;
            outline:6px solid #1c2233; border-radius:2px; overflow:hidden; }
  #screen row { position:absolute; left:0; top:calc(var(--y, 0) * var(--ch-h));
                width:${dims.w}ch; height:var(--ch-h); white-space:pre; }
  ${styleTableCss(styles, target)}
</style>
<div>pocket vapor dev · target: ${picker}</div>
<div id="screen"></div>
<div>arrows=pad &nbsp; Z=A &nbsp; X=B &nbsp; Enter=Start &nbsp; Shift=Select &nbsp; A/S=L/R</div>
<script>
  globalThis.__vaporScreenW = ${dims.w};
  globalThis.__vaporScreenH = ${dims.h};
  globalThis.__vaporPairs = ${pairsJson};
</script>
<script src="/app.js"></script>`;
}

let FILE_CACHE = await Bun.file(entry).text();

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    FILE_CACHE = await Bun.file(entry).text(); // re-read: edit + refresh workflow
    if (url.pathname === "/app.js") {
      return new Response(await buildAppBundle(), { headers: { "content-type": "text/javascript" } });
    }
    return new Response(page(pickTarget(url)), { headers: { "content-type": "text/html" } });
  },
});

console.log(`pocket vapor dev host: http://localhost:${port}/  (entry: ${entry})`);
console.log(`targets: http://localhost:${port}/?target=web|gba|gb|nes — edit ${entry} and refresh`);
