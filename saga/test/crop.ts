// saga/test/crop.ts — crop + integer-scale a PNG region for close inspection.
//   bun test/crop.ts <png> <x> <y> <w> <h> [scale]
import { decodePng, encodePng } from "../compiler/png.ts";

const [path, xs, ys, ws, hs, ss] = process.argv.slice(2);
const img = decodePng(new Uint8Array(await Bun.file(path).arrayBuffer()));
const x0 = +xs, y0 = +ys, w = +ws, h = +hs, s = +(ss ?? 4);
const out = new Uint8Array(w * s * h * s * 4);
for (let y = 0; y < h * s; y++)
  for (let x = 0; x < w * s; x++) {
    const sx = x0 + Math.floor(x / s);
    const sy = y0 + Math.floor(y / s);
    const si = (sy * img.width + sx) * 4;
    const di = (y * w * s + x) * 4;
    out[di] = img.rgba[si];
    out[di + 1] = img.rgba[si + 1];
    out[di + 2] = img.rgba[si + 2];
    out[di + 3] = 255;
  }
const dst = path.replace(/\.png$/, `.crop.png`);
await Bun.write(dst, encodePng(out, w * s, h * s));
console.log(dst);
