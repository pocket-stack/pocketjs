// hosts/web/serve.ts — tiny static dev server for the browser host.
//
//   bun hosts/web/serve.ts            # http://127.0.0.1:8130
//   PORT=9000 bun hosts/web/serve.ts
//
// Serves hosts/web/ at /, dist/ at /dist/, a /demos JSON manifest, the
// Pocket DevTools panel at /devtools and its WS hub at /ws — all implemented
// in hosts/web/server.ts (this file is the CLI wrapper; tools/devtools.ts
// embeds the same module for the one-command DX).
//
// Dev-tool only: binds 127.0.0.1, no cache, no livereload (reload the page
// after `bun tools/build.ts <demo>` / `bun tools/wasm.ts`).

import { demoManifest, startDevServer } from "./server.ts";

const server = startDevServer();

console.log(
  `PocketJS hosts/web: ${server.url}  (demos: ${demoManifest().map((d) => d.name).join(", ") || "none — build one first"})`,
);
console.log(`Pocket DevTools:   ${server.panelUrl}`);
