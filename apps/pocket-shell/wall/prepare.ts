// apps/pocket-shell/wall/prepare.ts — cook the Omarchy tokyo-night backgrounds
// into pak-ready textures.
//
//   bun apps/pocket-shell/wall/prepare.ts <source-dir>
//
// <source-dir> holds the originals from /usr/share/omarchy/themes/tokyo-night/
// backgrounds/ (0-winding-road.jpg, 3-sunset-lake.png, 2-swirl-buck.jpg).
// Each is scaled to a 240 px height, centre-cropped to the 400x240 top
// screen (sips does both), then padded into a 512x256 opaque envelope:
// framework/compiler/pak.ts only accepts power-of-two images, and
// images.json bakes these as PSM_5650, which needs every pixel opaque. The
// stage draws the texture at its full 512x256 size under an overflow-hidden
// root, so the padding never shows.

import { $ } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng } from "../../../framework/compiler/pak.ts";
import { encodePNG } from "../../../tests/png.ts";

const OUT_W = 512;
const OUT_H = 256;
const SCREEN_W = 400;
const SCREEN_H = 240;

const SOURCES: Record<string, string> = {
  "road.png": "0-winding-road.jpg",
  "lake.png": "3-sunset-lake.png",
  "swirl.png": "2-swirl-buck.jpg",
};

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error("usage: bun apps/pocket-shell/wall/prepare.ts <dir with the tokyo-night backgrounds>");
  process.exit(1);
}
const here = new URL(".", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "pocket-shell-wall-"));

for (const [target, source] of Object.entries(SOURCES)) {
  const scaled = join(work, `${target}.scaled.png`);
  // Height first, then a centred crop to the screen's aspect.
  await $`sips -s format png --resampleHeight ${SCREEN_H} ${join(sourceDir, source)} --out ${scaled}`.quiet();
  await $`sips -c ${SCREEN_H} ${SCREEN_W} ${scaled} --out ${scaled}`.quiet();
  const img = decodePng(new Uint8Array(await Bun.file(scaled).arrayBuffer()));
  if (img.width !== SCREEN_W || img.height !== SCREEN_H) {
    throw new Error(`${source}: expected ${SCREEN_W}x${SCREEN_H} after crop, got ${img.width}x${img.height}`);
  }
  const rgba = new Uint8Array(OUT_W * OUT_H * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // opaque black padding
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const s = (y * SCREEN_W + x) * 4;
      const d = (y * OUT_W + x) * 4;
      rgba[d] = img.rgba[s];
      rgba[d + 1] = img.rgba[s + 1];
      rgba[d + 2] = img.rgba[s + 2];
      rgba[d + 3] = 255;
    }
  }
  writeFileSync(join(here, target), encodePNG(rgba, OUT_W, OUT_H));
  console.log(`${target} <- ${source} (${SCREEN_W}x${SCREEN_H} in a ${OUT_W}x${OUT_H} envelope)`);
}
