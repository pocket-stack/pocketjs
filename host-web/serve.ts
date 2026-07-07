// host-web/serve.ts — tiny static dev server for the browser host.
//
//   bun host-web/serve.ts            # http://127.0.0.1:8130
//   PORT=9000 bun host-web/serve.ts
//
// Serves host-web/ at /, dist/ at /dist/, plus a /demos JSON manifest
// (every dist/*.js bundle; `mounts` marks bundles that actually call
// render() and install globalThis.frame — i.e. the *-main entries).
//
// DevTools (DEVTOOLS.md): /devtools serves the panel and /ws is the hub —
// a dumb relay between roles: every device line goes to every panel and
// vice versa (plus deviceConnected/deviceGone notices). No state, no
// parsing; the runtime shim (src/devtools.ts) and the panel own the
// protocol.
//
// Dev-tool only: binds 127.0.0.1, no cache, no livereload (reload the page
// after `bun scripts/build.ts <demo>` / `bun scripts/wasm.ts`).

import { existsSync, readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname; // PocketJS/
const HOST_DIR = ROOT + "host-web/";
const DIST_DIR = ROOT + "dist/";
const PORT = Number(process.env.PORT ?? 8130);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  wasm: "application/wasm",
  png: "image/png",
  pak: "application/octet-stream",
};

function fileResponse(path: string): Response {
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const ext = path.slice(path.lastIndexOf(".") + 1);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

function demoManifest(): { name: string; hasPak: boolean; mounts: boolean }[] {
  if (!existsSync(DIST_DIR)) return [];
  return readdirSync(DIST_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -3);
      // A mounting entry bundles src/index.ts, whose frame hookup goes
      // through installFrameHandler — cheap, reliable dev-tool heuristic.
      const src = readFileSync(DIST_DIR + f, "utf8");
      return {
        name,
        hasPak: existsSync(DIST_DIR + name + ".pak"),
        mounts: src.includes("installFrameHandler"),
      };
    });
}

// ---- DevTools WS hub ---------------------------------------------------

type Role = "panel" | "device";
type DevWS = Bun.ServerWebSocket<{ role: Role }>;
const peers: Record<Role, Set<DevWS>> = {
  panel: new Set(),
  device: new Set(),
};

function relay(from: Role, data: string | Buffer): void {
  const to: Role = from === "device" ? "panel" : "device";
  const text = typeof data === "string" ? data : data.toString("utf8");
  for (const ws of peers[to]) ws.send(text);
}

function notifyPanels(msg: object): void {
  const text = JSON.stringify(msg);
  for (const ws of peers.panel) ws.send(text);
}

const server = Bun.serve<{ role: Role }>({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\.\.+/g, ""); // no traversal
    if (path === "/ws") {
      const role: Role = url.searchParams.get("role") === "device" ? "device" : "panel";
      if (srv.upgrade(req, { data: { role } })) return undefined as unknown as Response;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    if (path === "/" || path === "/index.html") return fileResponse(HOST_DIR + "index.html");
    if (path === "/devtools" || path === "/devtools/") {
      return fileResponse(HOST_DIR + "devtools.html");
    }
    if (path === "/demos") {
      return Response.json(demoManifest(), { headers: { "cache-control": "no-store" } });
    }
    if (path.startsWith("/dist/")) return fileResponse(DIST_DIR + path.slice("/dist/".length));
    return fileResponse(HOST_DIR + path.slice(1));
  },
  websocket: {
    open(ws) {
      peers[ws.data.role].add(ws);
      if (ws.data.role === "device") notifyPanels({ t: "deviceConnected" });
    },
    message(ws, data) {
      relay(ws.data.role, data as string | Buffer);
    },
    close(ws) {
      peers[ws.data.role].delete(ws);
      if (ws.data.role === "device") notifyPanels({ t: "deviceGone" });
    },
  },
});

console.log(`PocketJS host-web: http://127.0.0.1:${server.port}/  (demos: ${demoManifest().map((d) => d.name).join(", ") || "none — build one first"})`);
console.log(`Pocket DevTools:   http://127.0.0.1:${server.port}/devtools`);
