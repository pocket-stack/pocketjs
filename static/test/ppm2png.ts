#!/usr/bin/env bun
// static/test/ppm2png.ts — convert harness PPM screenshots to PNG.
//   bun static/test/ppm2png.ts <in.ppm...>   (writes siblings with .png)

import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function ppmToPng(ppm: Uint8Array): Uint8Array {
  const header = new TextDecoder().decode(ppm.subarray(0, 64));
  const m = header.match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) throw new Error("not a P6 PPM");
  const [, ws, hs] = m;
  const w = Number(ws);
  const h = Number(hs);
  const dataStart = m[0].length;
  const pixels = ppm.subarray(dataStart, dataStart + w * h * 3);

  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    raw.set(pixels.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

if (import.meta.main) {
  for (const arg of process.argv.slice(2)) {
    const ppm = new Uint8Array(await Bun.file(arg).arrayBuffer());
    const png = ppmToPng(ppm);
    const out = arg.replace(/\.ppm$/, ".png");
    await Bun.write(out, png);
    console.log(`${out} (${png.length} bytes)`);
  }
}
