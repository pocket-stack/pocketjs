// saga/compiler/png.ts — minimal PNG codec (build-time only), self-contained so
// @pocketjs/saga stays independent. Decoder adapted from compiler/pak.ts,
// encoder from scripts/psp-all.ts.

import { inflateSync, deflateSync } from "node:zlib";

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes/px, row-major. */
  rgba: Uint8Array;
}

/** Decode an 8-bit RGB/RGBA/grayscale non-interlaced PNG to RGBA. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error("png: bad signature");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o, false);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(o + 8, false);
      height = dv.getUint32(o + 12, false);
      bitDepth = bytes[o + 16];
      colorType = bytes[o + 17];
      if (bytes[o + 20] !== 0) throw new Error("png: interlaced PNGs unsupported");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`png: only 8-bit supported (got ${bitDepth})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`png: unsupported color type ${colorType} (palette PNGs: re-export as RGBA)`);

  const zdata = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let zo = 0;
  for (const c of idat) {
    zdata.set(c, zo);
    zo += c.length;
  }
  const raw = new Uint8Array(inflateSync(zdata));

  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ro++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[ro + x];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`png: bad filter ${filter}`);
      }
      line[x] = v & 0xff;
    }
    ro += stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const s = x * channels;
      switch (colorType) {
        case 0: rgba[i] = rgba[i + 1] = rgba[i + 2] = line[s]; rgba[i + 3] = 255; break;
        case 2: rgba[i] = line[s]; rgba[i + 1] = line[s + 1]; rgba[i + 2] = line[s + 2]; rgba[i + 3] = 255; break;
        case 4: rgba[i] = rgba[i + 1] = rgba[i + 2] = line[s]; rgba[i + 3] = line[s + 1]; break;
        case 6: rgba[i] = line[s]; rgba[i + 1] = line[s + 1]; rgba[i + 2] = line[s + 2]; rgba[i + 3] = line[s + 3]; break;
      }
    }
    prev.set(line);
  }
  return { width, height, rgba };
}

// --- encoder -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(body), false);
  return out;
}

export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w, false);
  dv.setUint32(4, h, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
