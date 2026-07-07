// scripts/devtools-psp.ts — bridge a real PSP (or the PPSSPP GUI) into the
// Pocket DevTools hub over the PSPLINK USB mailbox (DEVTOOLS.md §3).
//
//   bun host-web/serve.ts                 # terminal 1: hub + panel
//   bun psplink / bun run hw              # terminal 2: usbhostfs + launch
//   bun scripts/devtools-psp.ts           # terminal 3: this bridge
//
// The bridge owns the mailbox files inside the usbhostfs-served dir (the
// PSP sees them as host0:/pocketjs-dbg/*): it appends panel commands to
// in.jsonl, tails out.jsonl for the device's messages, and speaks
// role=device to the WS hub. The app probes for pocketjs-dbg/enable at
// BOOT (native/src/dbg.rs), so create the bridge first, then (re)launch
// the app.
//
//   --dir <path>   usbhostfs root the PSP mounts as host0:
//                  (default: dist/psplink — the `bun psplink` share;
//                   for `bun run hw` pass native/target/mipsel-sony-psp/release)
//   --port <n>     dev-server port (default 8130 / PORT env)

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = resolve(argValue("--dir") ?? join(ROOT, "dist", "psplink"));
const port = Number(argValue("--port") ?? process.env.PORT ?? 8130);

if (!existsSync(dir)) {
  console.error(`devtools-psp: ${dir} does not exist — start usbhostfs first (bun psplink / bun run hw), or pass --dir`);
  process.exit(1);
}

const boxDir = join(dir, "pocketjs-dbg");
const enablePath = join(boxDir, "enable");
const inPath = join(boxDir, "in.jsonl");
const outPath = join(boxDir, "out.jsonl");

mkdirSync(boxDir, { recursive: true });
writeFileSync(enablePath, "pocket devtools mailbox\n");
writeFileSync(inPath, "");
writeFileSync(outPath, "");
console.log(`devtools-psp: mailbox ready at ${boxDir}`);
console.log("devtools-psp: (re)launch the app now — it probes host0:/pocketjs-dbg/enable at boot");

function cleanup() {
  try {
    rmSync(enablePath);
  } catch {
    // usbhostfs may already be gone
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ---- WS hub (role=device) ---------------------------------------------------

let ws: WebSocket | null = null;
let backoff = 500;

function connect() {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?role=device`);
  sock.onopen = () => {
    backoff = 500;
    console.log(`devtools-psp: connected to hub ws://127.0.0.1:${port}/ws`);
  };
  sock.onmessage = (e) => {
    // Panel command -> mailbox. One JSON object per WS message; the PSP
    // splits batched lines itself.
    if (typeof e.data === "string" && e.data.trim()) {
      appendFileSync(inPath, e.data.trim() + "\n");
    }
  };
  sock.onclose = () => {
    ws = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
  sock.onerror = () => {
    // close fires next; keep quiet (the dev server may not be up yet)
  };
  ws = sock;
}
connect();

// ---- tail out.jsonl -----------------------------------------------------------

let offset = 0;
let warnedIdle = false;

setInterval(() => {
  let size: number;
  try {
    size = statSync(outPath).size;
  } catch {
    return; // file vanished (usbhostfs restart) — recreated on next write
  }
  if (size < offset) offset = 0; // truncated/recreated: start over
  if (size === offset) return;
  const buf = readFileSync(outPath);
  const chunk = buf.subarray(offset, size);
  const text = chunk.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return; // partial line: wait for the device to finish it
  offset += Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
  for (const line of text.slice(0, lastNl).split("\n")) {
    if (!line.trim()) continue;
    if (ws && ws.readyState === 1) ws.send(line);
  }
  if (!warnedIdle) {
    warnedIdle = true;
    console.log("devtools-psp: device is talking — open the panel at http://127.0.0.1:" + port + "/devtools");
  }
}, 100);
