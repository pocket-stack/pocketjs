// saga/pixellab/walkers.ts — assemble walker sheets from the generated stills.
//   bun pixellab/walkers.ts [--force]
//
// hero: real 4-frame walk cycles per direction via /animate-with-text
//       (64x64 minimum -> 2x nearest-neighbor round trip) -> spr_hero.png
//       384x32, rows DOWN,UP,SIDE x 4 frames (walkFpd 4). Frame 0 of each
//       row is the standing still.
// npcs: 3-frame sheets [south, north, east] (walkFpd 1) -> spr_<who>.png.

import { apiKey } from "./client.ts";
import { decodePng, encodePng } from "../compiler/png.ts";

const ART = new URL("../game/art/", import.meta.url).pathname;
const FRAME = 32;

function nn(rgba: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint8Array(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++)
    for (let x = 0; x < w * k; x++) {
      const si = (Math.floor(y / k) * w + Math.floor(x / k)) * 4;
      out.set(rgba.subarray(si, si + 4), (y * w * k + x) * 4);
    }
  return out;
}
function shrink2(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array((w / 2) * (h / 2) * 4);
  for (let y = 0; y < h / 2; y++)
    for (let x = 0; x < w / 2; x++) {
      out.set(rgba.subarray((y * 2 * w + x * 2) * 4, (y * 2 * w + x * 2) * 4 + 4), (y * (w / 2) + x) * 4);
    }
  return out;
}

async function loadFrame(path: string): Promise<Uint8Array> {
  const d = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
  if (d.width !== FRAME || d.height !== FRAME) throw new Error(`${path}: expected ${FRAME}x${FRAME}`);
  return d.rgba;
}

function sheet(frames: Uint8Array[]): Uint8Array {
  const w = FRAME * frames.length;
  const out = new Uint8Array(w * FRAME * 4);
  frames.forEach((f, i) => {
    for (let y = 0; y < FRAME; y++)
      for (let x = 0; x < FRAME; x++) {
        out.set(f.subarray((y * FRAME + x) * 4, (y * FRAME + x) * 4 + 4), (y * w + i * FRAME + x) * 4);
      }
  });
  return encodePng(out, w, FRAME);
}

async function animate(still: Uint8Array, look: string, direction: string): Promise<Uint8Array[]> {
  const big = encodePng(nn(still, FRAME, FRAME, 2), FRAME * 2, FRAME * 2);
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.pixellab.ai/v1/animate-with-text", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        image_size: { width: FRAME * 2, height: FRAME * 2 },
        description: look,
        action: "walk",
        reference_image: { type: "base64", base64: Buffer.from(big).toString("base64") },
        view: "low top-down",
        direction,
        n_frames: 4,
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { images?: { base64?: string }[] };
      return (body.images ?? []).map((img) => {
        const d = decodePng(new Uint8Array(Buffer.from(img.base64!, "base64")));
        return shrink2(d.rgba, d.width, d.height);
      });
    }
    lastErr = `${res.status} ${await res.text()}`;
    if (res.status === 422 || res.status === 401) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`animate-with-text(${direction}): ${lastErr}`);
}

const force = process.argv.includes("--force");
const HERO_LOOK = "young man, shoulder-length dark brown hair, short beard, white collared shirt, blue jeans";

// hero: 4-frame cycles, standing still as frame 0 of each row
{
  const out = ART + "spr_hero.png";
  if (!force && (await Bun.file(out).exists())) {
    console.log("skip spr_hero (cached)");
  } else {
    const rows: Uint8Array[] = [];
    for (const [suffix, dir] of [
      ["s", "south"],
      ["n", "north"],
      ["e", "east"],
    ] as const) {
      const still = await loadFrame(`${ART}walk_hero_${suffix}.png`);
      process.stdout.write(`  animate hero ${dir}... `);
      const frames = await animate(still, HERO_LOOK, dir);
      if (frames.length < 3) throw new Error(`only ${frames.length} frames for ${dir}`);
      // row = still + walk frames 2,3,4 (frame 1 is usually closest to the still)
      rows.push(still, ...frames.slice(1, 4));
      console.log(`ok (${frames.length} frames)`);
    }
    await Bun.write(out, sheet(rows));
    console.log("wrote spr_hero.png (12 frames)");
  }
}

// npcs: 3-still sheets
for (const who of ["kid", "dad", "woz", "res", "team"]) {
  const out = `${ART}spr_${who}.png`;
  if (!force && (await Bun.file(out).exists())) {
    console.log(`skip spr_${who} (cached)`);
    continue;
  }
  const frames = await Promise.all(
    (["s", "n", "e"] as const).map((sfx) => loadFrame(`${ART}walk_${who}_${sfx}.png`)),
  );
  await Bun.write(out, sheet(frames));
  console.log(`wrote spr_${who}.png (3 frames)`);
}
