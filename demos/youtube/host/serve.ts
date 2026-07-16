// demos/youtube/host/serve.ts — the Pocket YouTube macOS host service.
//
//   bun demos/youtube/host/serve.ts --dir <usbhostfs-root>   (PSP over USB)
//   bun demos/youtube/host/serve.ts --dir ~/ppsspp-memstick  (PPSSPP)
//   bun demos/youtube/host/serve.ts --http 8620              (browser dev)
//
// The PSP has no WiFi in this design: the Mac owns YouTube's protocol layer
// (yt-dlp), decode (ffmpeg) and pixels (quant.ts), and shares the results
// through the usbhostfs directory the PSP already mounts under PSPLINK —
// control as JSON lines (spec.ts SVC), search cards as IMG side files,
// playback as a .pkst ring stream (media.ts). Point --dir at whatever
// directory the device sees as host0:
//   bun run hw youtube        -> native/target/mipsel-sony-psp/<profile>
//   bun psplink               -> dist/psplink            (the default here)
//
// --http additionally serves the same dispatch over localhost for the
// browser host (the app's driver falls back to fetch when the svc ops are
// absent): POST /cmd -> reply JSON, GET /events?since= -> push queue,
// GET /svc/<rel> -> side-file bytes.

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { DeviceCmd, HostMsg, ResultItem } from "../protocol.ts";
import { CARD_H, CARD_W, fetchThumbRGBA, renderCard } from "./cards.ts";
import { encodeImgT8 } from "./img.ts";
import { FPS, PlaySession } from "./media.ts";
import { resolve as resolveVideo, search, thumbnailUrl } from "./yt.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let dir = ROOT + "dist/psplink";
let httpPort: number | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dir") dir = resolvePath(argv[++i] ?? "");
  else if (argv[i]?.startsWith("--dir=")) dir = resolvePath(argv[i].slice("--dir=".length));
  else if (argv[i] === "--http") httpPort = Number(argv[++i] ?? 8620);
  else if (argv[i]?.startsWith("--http=")) httpPort = Number(argv[i].slice("--http=".length));
  else {
    console.error("usage: bun demos/youtube/host/serve.ts [--dir <usbhostfs-root>] [--http <port>]");
    process.exit(1);
  }
}

const svcDir = `${dir}/pocket-svc/youtube`;
mkdirSync(`${svcDir}/thumbs`, { recursive: true });
mkdirSync(`${svcDir}/media`, { recursive: true });
// Fresh session: the device seeks in.jsonl to EOF at svcOpen, we tail
// out.jsonl from 0 — truncate both so offsets and history agree.
writeFileSync(`${svcDir}/in.jsonl`, "");
writeFileSync(`${svcDir}/out.jsonl`, "");
writeFileSync(`${svcDir}/enable`, "");
console.log(`pocket-youtube host: svc dir ${svcDir}`);

// ---------------------------------------------------------------------------
// State + replies
// ---------------------------------------------------------------------------

let session: PlaySession | null = null;
let playSerial = 0;
/** Push queue for the HTTP transport (mailbox pushes append directly). */
const httpEvents: HostMsg[] = [];

function post(msg: HostMsg): void {
  appendFileSync(`${svcDir}/in.jsonl`, JSON.stringify(msg) + "\n");
  if (httpPort !== null) httpEvents.push(msg);
  if (msg.t !== "state") console.log("->", JSON.stringify(msg).slice(0, 140));
}

function fail(id: number, e: unknown): HostMsg {
  const message = e instanceof Error ? e.message : String(e);
  console.error("  error:", message);
  return { t: "error", id, message: message.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Command dispatch (shared by mailbox and HTTP)
// ---------------------------------------------------------------------------

async function doSearch(id: number, q: string): Promise<HostMsg> {
  console.log(`search: "${q}"`);
  const found = await search(q, 12);
  const items: ResultItem[] = await Promise.all(
    found.map(async (f) => {
      const thumb = await fetchThumbRGBA(thumbnailUrl(f.videoId), `${svcDir}/thumbs`);
      const rgba = await renderCard({
        title: f.title,
        channel: f.channel,
        durationS: f.durationS,
        views: f.views,
        thumbRgba: thumb,
      });
      const rel = `thumbs/${f.videoId}.img`;
      writeFileSync(`${svcDir}/${rel}`, encodeImgT8(rgba, CARD_W, CARD_H));
      return { ...f, card: rel };
    }),
  );
  console.log(`  ${items.length} result(s), cards rendered`);
  return { t: "results", id, items };
}

async function doPlay(id: number, videoId: string): Promise<HostMsg> {
  console.log(`play: ${videoId}`);
  session?.close();
  session = null;
  const stream = await resolveVideo(videoId);
  const rel = `media/play-${++playSerial}.pkst`;
  session = new PlaySession(stream, svcDir, rel, {
    onEnd: () => post({ t: "ended" }),
  });
  console.log(`  streaming "${stream.title}" (${stream.durationS}s) -> ${rel}`);
  return {
    t: "playing",
    id,
    videoId,
    title: stream.title,
    durationS: stream.durationS,
    fps: FPS,
    stream: rel,
    position: 0,
  };
}

async function dispatch(cmd: DeviceCmd): Promise<HostMsg | null> {
  switch (cmd.t) {
    case "hello":
      return { t: "ready", id: cmd.id };
    case "search":
      try {
        return await doSearch(cmd.id, cmd.q);
      } catch (e) {
        return fail(cmd.id, e);
      }
    case "play":
      try {
        return await doPlay(cmd.id, cmd.videoId);
      } catch (e) {
        return fail(cmd.id, e);
      }
    case "pause":
      session?.pause();
      return { t: "state", id: cmd.id, playing: false, position: session?.positionBase ?? 0 };
    case "resume":
      session?.resume();
      return { t: "state", id: cmd.id, playing: true, position: session?.positionBase ?? 0 };
    case "seek":
      if (session) {
        session.seek(cmd.to);
        return { t: "state", id: cmd.id, playing: true, position: session.positionBase };
      }
      return { t: "state", id: cmd.id, playing: false, position: 0 };
    case "stop":
      session?.close();
      session = null;
      return { t: "state", id: cmd.id, playing: false, position: 0 };
  }
}

// ---------------------------------------------------------------------------
// Mailbox tail (same offset/truncation handling as scripts/devtools-bridge.ts)
// ---------------------------------------------------------------------------

let tailOff = 0;
let pending = "";

async function pollMailbox(): Promise<void> {
  const path = `${svcDir}/out.jsonl`;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < tailOff) tailOff = 0; // truncated/recreated
  if (size === tailOff) return;
  const file = Bun.file(path);
  const chunk = await file.slice(tailOff, size).text();
  tailOff = size;
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let cmd: DeviceCmd;
    try {
      cmd = JSON.parse(line) as DeviceCmd;
    } catch {
      console.error("bad line from device:", line.slice(0, 120));
      continue;
    }
    const reply = await dispatch(cmd);
    if (reply) post(reply);
  }
}

let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void pollMailbox().finally(() => {
    polling = false;
  });
}, 100);

// ---------------------------------------------------------------------------
// HTTP transport (browser-host dev; same dispatch)
// ---------------------------------------------------------------------------

if (httpPort !== null) {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
  };
  Bun.serve({
    port: httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (req.method === "POST" && url.pathname === "/cmd") {
        const cmd = (await req.json()) as DeviceCmd;
        const reply = await dispatch(cmd);
        return Response.json(reply, { headers: CORS });
      }
      if (url.pathname === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return Response.json(
          { next: httpEvents.length, events: httpEvents.slice(since) },
          { headers: CORS },
        );
      }
      if (url.pathname.startsWith("/svc/")) {
        const rel = url.pathname.slice("/svc/".length);
        if (rel.includes("..") || rel.startsWith("/")) return new Response(null, { status: 400 });
        const path = `${svcDir}/${rel}`;
        if (!existsSync(path)) return new Response(null, { status: 404 });
        return new Response(Bun.file(path), { headers: CORS });
      }
      return new Response(null, { status: 404 });
    },
  });
  console.log(`pocket-youtube host: http on http://127.0.0.1:${httpPort}`);
}

console.log("pocket-youtube host: waiting for the device (svcOpen probes the enable file)");

process.on("SIGINT", () => {
  session?.close();
  process.exit(0);
});
