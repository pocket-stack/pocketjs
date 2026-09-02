// tools/sifli-bake.ts — bake a portable PocketJS pak's images into the
// SiFli native texture pak (`.epic`) that hosts/sifli registers with the GPU
// queue (POCKETJS_GPU_NATIVE_* in pocketjs_gpu_host.h).
//
//   bun tools/sifli-bake.ts <input.pak> <output.epic> [--opaque-rgb565=RRGGBB]
//
// Every `ui:img.<name>` entry becomes an 8-byte header (u16 width, u16
// height, u8 format, u8 flags, u16 reserved) plus EPIC-order pixels:
//   PSM_5650 -> format 0 (RGB565, red in the high bits);
//   PSM_8888 -> format 1 (BGRA8888), or format 0 when --opaque-rgb565
//               precomposites the alpha over that color at bake time;
//   PSM_4444 -> format 1 (BGRA8888, 4-bit channels expanded);
//   PSM_T8   -> format 2 (L8 indices behind a 1024-byte BGRA palette).
// The core keeps the portable bytes, so the software path stays exact; the
// native copy only feeds hardware blits. Optional: a guest without a .epic
// pak renders every texture through the portable path.

import { PSM } from "../contracts/spec/spec.ts";
import { pack, unpack, type PakBlob } from "../framework/compiler/pak.ts";

export const NATIVE_RGB565 = 0;
export const NATIVE_BGRA8888 = 1;
export const NATIVE_L8 = 2;
export const NATIVE_HEADER = 8;

export interface BakeOptions {
  /** Precomposite PSM_8888 alpha over this color and emit opaque RGB565. */
  readonly opaqueRgb?: readonly [number, number, number];
}

export function parseOpaqueRgb(hex: string): readonly [number, number, number] {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error("--opaque-rgb565 expects exactly six hexadecimal digits");
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function rgb565(red: number, green: number, blue: number): number {
  return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
}

/** Convert one `ui:img.*` blob; throws on a truncated or unsupported image. */
export function bakeImage(blob: PakBlob, options: BakeOptions = {}): PakBlob {
  if (blob.data.length < NATIVE_HEADER) throw new Error(`${blob.key}: truncated IMG header`);
  const src = blob.data;
  const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const width = srcView.getUint16(0, true);
  const height = srcView.getUint16(2, true);
  const psm = src[4];
  const pixels = width * height;
  let format: number;
  let payload: Uint8Array;

  if (psm === PSM.PSM_8888) {
    if (src.length < NATIVE_HEADER + pixels * 4) throw new Error(`${blob.key}: truncated PSM8888`);
    if (options.opaqueRgb) {
      const [bgRed, bgGreen, bgBlue] = options.opaqueRgb;
      format = NATIVE_RGB565;
      payload = new Uint8Array(pixels * 2);
      const out = new DataView(payload.buffer);
      for (let index = 0; index < pixels; index++) {
        const offset = NATIVE_HEADER + index * 4;
        const alpha = src[offset + 3];
        const inverse = 255 - alpha;
        const red = Math.round((src[offset] * alpha + bgRed * inverse) / 255);
        const green = Math.round((src[offset + 1] * alpha + bgGreen * inverse) / 255);
        const blue = Math.round((src[offset + 2] * alpha + bgBlue * inverse) / 255);
        out.setUint16(index * 2, rgb565(red, green, blue), true);
      }
    } else {
      format = NATIVE_BGRA8888;
      payload = src.slice(NATIVE_HEADER, NATIVE_HEADER + pixels * 4);
      for (let offset = 0; offset < payload.length; offset += 4) {
        [payload[offset], payload[offset + 2]] = [payload[offset + 2], payload[offset]];
      }
    }
  } else if (psm === PSM.PSM_5650) {
    if (src.length < NATIVE_HEADER + pixels * 2) throw new Error(`${blob.key}: truncated PSM5650`);
    format = NATIVE_RGB565;
    payload = new Uint8Array(pixels * 2);
    const out = new DataView(payload.buffer);
    for (let index = 0; index < pixels; index++) {
      const value = srcView.getUint16(NATIVE_HEADER + index * 2, true);
      out.setUint16(
        index * 2,
        ((value & 0x001f) << 11) | (value & 0x07e0) | ((value & 0xf800) >> 11),
        true,
      );
    }
  } else if (psm === PSM.PSM_4444) {
    if (src.length < NATIVE_HEADER + pixels * 2) throw new Error(`${blob.key}: truncated PSM4444`);
    format = NATIVE_BGRA8888;
    payload = new Uint8Array(pixels * 4);
    for (let index = 0; index < pixels; index++) {
      const value = srcView.getUint16(NATIVE_HEADER + index * 2, true);
      payload[index * 4] = ((value >> 8) & 0xf) * 17; // B
      payload[index * 4 + 1] = ((value >> 4) & 0xf) * 17; // G
      payload[index * 4 + 2] = (value & 0xf) * 17; // R
      payload[index * 4 + 3] = ((value >> 12) & 0xf) * 17; // A
    }
  } else if (psm === PSM.PSM_T8) {
    if (src.length < NATIVE_HEADER + 1024 + pixels) throw new Error(`${blob.key}: truncated PSM_T8`);
    format = NATIVE_L8;
    payload = src.slice(NATIVE_HEADER, NATIVE_HEADER + 1024 + pixels);
    for (let offset = 0; offset < 1024; offset += 4) {
      [payload[offset], payload[offset + 2]] = [payload[offset + 2], payload[offset]];
    }
  } else {
    throw new Error(`${blob.key}: unsupported PSM ${psm}`);
  }

  const data = new Uint8Array(NATIVE_HEADER + payload.length);
  const view = new DataView(data.buffer);
  view.setUint16(0, width, true);
  view.setUint16(2, height, true);
  data[4] = format;
  data[5] = src[5];
  data.set(payload, NATIVE_HEADER);
  return { key: blob.key, dtype: blob.dtype, data };
}

/** The native pak for every image entry of `pak`; deterministic for equal input. */
export function bakeNativePak(pak: Uint8Array, options: BakeOptions = {}): {
  readonly bytes: Uint8Array;
  readonly images: number;
} {
  const converted = unpack(pak)
    .filter((blob) => blob.key.startsWith("ui:img."))
    .map((blob) => bakeImage(blob, options));
  return { bytes: pack(converted), images: converted.length };
}

if (import.meta.main) {
  const [inputPath, outputPath, ...options] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error("usage: bun tools/sifli-bake.ts <input.pak> <output.epic> [--opaque-rgb565=RRGGBB]");
  }
  const opaque = options.find((option) => option.startsWith("--opaque-rgb565="));
  const baked = bakeNativePak(new Uint8Array(await Bun.file(inputPath).arrayBuffer()), {
    opaqueRgb: opaque ? parseOpaqueRgb(opaque.slice("--opaque-rgb565=".length)) : undefined,
  });
  await Bun.write(outputPath, baked.bytes);
  console.log(`native pak: ${baked.images} image(s), ${baked.bytes.length} bytes -> ${outputPath}`);
}
