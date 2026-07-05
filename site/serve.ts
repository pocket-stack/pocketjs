// site/serve.ts — static preview server for site/dist (local verification only).
//   bun site/serve.ts            # http://127.0.0.1:8140
import { existsSync, statSync } from "node:fs";

const DIST = new URL("./dist/", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8140);
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", wasm: "application/wasm",
  svg: "image/svg+xml", png: "image/png", ttf: "font/ttf", map: "application/json",
  pak: "application/octet-stream",
};
const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;
function resolve(path: string): string | null {
  let p = DIST + path.replace(/^\/+/, "").replace(/\.\.+/g, "");
  if (p.endsWith("/")) p += "index.html";
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(p + "/index.html")) return p + "/index.html";
  if (existsSync(p + ".html")) return p + ".html";
  return null;
}
Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const file = resolve(url.pathname === "/" ? "/index.html" : url.pathname);
    if (!file) return new Response("not found: " + url.pathname, { status: 404 });
    const ext = file.slice(file.lastIndexOf(".") + 1);
    return new Response(Bun.file(file), {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
      },
    });
  },
});
console.log(`pocketjs.dev preview: http://127.0.0.1:${PORT}/`);
