// site/bake-demo-wall.ts — bakes the landing hero's "demo wall": every demo
// tiled into one looping background video.
//
//   bun site/bake-demo-wall.ts
//
// Every stream is ENGINE OUTPUT — no camera, no hands, no hardware (those
// captures are social-media material, not landing-page material): headless
// sim recordings of the in-repo demos (site/record-sim-clips.ts, recorded on
// demand into gitignored site/.cache/demo-wall/sim/), the engine-rendered
// GIF loops from site/assets/blog/, and the Pocket Character desktop-widget
// screen capture from R2. The two outputs ARE committed, like the old hero
// mp4 was:
//
//   site/assets/pocketjs-demo-wall.mp4   4x4 wall of 480x272 tiles, 24 s loop
//   site/assets/pocketjs-demo-wall.jpg   poster frame for first paint
//
// Every tile is normalized to the same clock (24 fps, exactly 24 s, cover-
// cropped to PSP-shaped 480x272) so the xstack grid never drifts; small
// 154x121 motion-study GIFs are packed four-up into 2x2 sub-grids.

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { ensureSimClip } from "./record-sim-clips.ts";

const SITE = new URL(".", import.meta.url).pathname;
const ROOT = SITE + "../";
const CACHE = SITE + ".cache/demo-wall/";
const BLOG = SITE + "assets/blog/";

const OUT_MP4 = SITE + "assets/pocketjs-demo-wall.mp4";
const OUT_JPG = SITE + "assets/pocketjs-demo-wall.jpg";

const TILE_W = 480; // one PSP screen per tile
const TILE_H = 272;
const COLS = 4;
const ROWS = 4;
const DUR = 24; // seconds — every tile hard-cuts together at the loop point
const FPS = 24;
const CRF = 32; // background texture, not a feature video — bias small

// The Pocket Character desktop-widget capture the blog embeds from R2 (a
// clean screen recording — the only non-repo stream on the wall).
const R2 = "https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/";
async function r2(name: string): Promise<string> {
  const path = CACHE + name;
  if (!existsSync(path)) {
    console.log(`  fetch ${name}`);
    const res = await fetch(R2 + name);
    if (!res.ok) throw new Error(`R2 ${name}: HTTP ${res.status}`);
    await Bun.write(path, res);
  }
  return path;
}

// A clip is one video stream, replayed from its start until the wall's cut
// point (sim clips are exactly one wall period long; GIFs loop).
type Clip = { src: string };
const loop = (src: string): Clip => ({ src });
const sim = (app: string): Clip => ({ src: ensureSimClip(app) });

async function main() {
  mkdirSync(CACHE, { recursive: true });

  const character = await r2("pocket-character-widget-c6cf80c4.mp4");

  // Row-major 4x4 grid: 9 headless sim recordings of the in-repo demos, six
  // engine-rendered GIF loops, and the Pocket Character widget. Light
  // motion-study tiles sit far apart so the wall reads as many demos.
  const tiles: (Clip | Clip[])[] = [
    // row 1
    sim("music-main"), // EVERGREEN grid -> Now Playing, track skips
    [loop(BLOG + "menu.gif"), loop(BLOG + "spin.gif"), loop(BLOG + "reveal.gif"), loop(BLOG + "room.gif")],
    sim("im-main"), // Pocket Talk: thread scroll -> OSK typing -> sent
    loop(ROOT + "assets/screenshots/motions-53.gif"),
    // row 2
    loop(character), // Pocket Character breathing on the desktop
    sim("gallery-main"), // photo pages under the shoulder buttons
    loop(BLOG + "devtools-highlight-glide.gif"),
    sim("cards-main"), // Feature Cards focus walk
    // row 3
    sim("stats-main"), // Mission Control dashboard tabs
    loop(BLOG + "page-3d.gif"),
    sim("settings-main"), // toggles, sliders and theme swaps
    loop(BLOG + "pocket-youtube-journey.gif"),
    // row 4
    sim("library-main"), // Game Library covers and detail pages
    sim("notifications-main"),
    sim("hero-main"), // "JSX at 60 FPS." counter card
    [loop(BLOG + "share.gif"), loop(BLOG + "reload.gif"), loop(BLOG + "dpad.gif"), loop(BLOG + "spin.gif")],
  ];

  const inputs: string[] = [];
  const filters: string[] = [];
  let idx = 0;
  const addInput = (c: Clip): number => {
    // -t caps the read with margin; tpad+trim below make every stream exactly
    // DUR long so the two xstack layers can never end early or drift.
    inputs.push("-stream_loop", "-1", "-t", String(DUR + 2), "-i", c.src);
    return idx++;
  };
  const norm = (w: number, h: number) =>
    `fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
    `tpad=stop_mode=clone:stop_duration=2,trim=duration=${DUR},setpts=PTS-STARTPTS`;

  tiles.forEach((tile, t) => {
    if (Array.isArray(tile)) {
      const cw = TILE_W / 2;
      const ch = TILE_H / 2;
      const cells = tile.map(addInput);
      cells.forEach((input, c) => filters.push(`[${input}:v]${norm(cw, ch)}[q${t}_${c}]`));
      filters.push(
        `[q${t}_0][q${t}_1][q${t}_2][q${t}_3]xstack=inputs=4:layout=0_0|${cw}_0|0_${ch}|${cw}_${ch}[t${t}]`,
      );
    } else {
      filters.push(`[${addInput(tile)}:v]${norm(TILE_W, TILE_H)}[t${t}]`);
    }
  });
  const layout = tiles.map((_, i) => `${(i % COLS) * TILE_W}_${Math.floor(i / COLS) * TILE_H}`).join("|");
  filters.push(
    `[${tiles.map((_, i) => `t${i}`).join("][")}]xstack=inputs=${COLS * ROWS}:layout=${layout},format=yuv420p[wall]`,
  );

  console.log(`demo wall: ${tiles.length} tiles, ${idx} streams -> ${COLS * TILE_W}x${ROWS * TILE_H} @ ${DUR}s`);
  await $`ffmpeg -y -v error ${inputs} -filter_complex ${filters.join(";")} -map [wall] -r ${FPS} -c:v libx264 -preset slow -crf ${CRF} -movflags +faststart -an ${OUT_MP4}`;
  await $`ffmpeg -y -v error -ss 12 -i ${OUT_MP4} -frames:v 1 -vf scale=1280:-2 -q:v 5 ${OUT_JPG}`;

  for (const out of [OUT_MP4, OUT_JPG]) {
    console.log(`  ${out.slice(SITE.length)}  (${(Bun.file(out).size / 1024 / 1024).toFixed(1)} MiB)`);
  }
}

await main();
