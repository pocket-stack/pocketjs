// saga/test/ppm2png.ts — convert the harness's P6 PPM screenshots to PNG.
//   bun test/ppm2png.ts dist/shots/*.ppm
import { encodePng } from "../compiler/png.ts";

export async function ppm2png(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  // P6\n<w> <h>\n255\n
  let o = 0;
  const token = (): string => {
    while (bytes[o] === 32 || bytes[o] === 10 || bytes[o] === 13 || bytes[o] === 9) o++;
    let s = "";
    while (o < bytes.length && ![32, 10, 13, 9].includes(bytes[o])) s += String.fromCharCode(bytes[o++]);
    return s;
  };
  if (token() !== "P6") throw new Error("not P6: " + path);
  const w = parseInt(token());
  const h = parseInt(token());
  token(); // maxval
  o++; // single whitespace after maxval
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = bytes[o + i * 3];
    rgba[i * 4 + 1] = bytes[o + i * 3 + 1];
    rgba[i * 4 + 2] = bytes[o + i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const out = path.replace(/\.ppm$/, ".png");
  await Bun.write(out, encodePng(rgba, w, h));
  return out;
}

if (import.meta.main) {
  for (const p of process.argv.slice(2)) console.log(await ppm2png(p));
}
