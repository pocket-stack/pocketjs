// demos/youtube/host/img.ts — CLUT8 IMG-entry encoding for loadImgFile.
//
// The device's loadImgFile op (spec op 33) reads a self-contained IMG entry
// (compiler/pak.ts layout: u16 w, u16 h, u8 psm, u8 flags, u16 reserved,
// then the payload) from the svc directory. compiler/pak.ts encodes
// 8888/4444; the youtube host ships everything as PSM_T8 — quantized,
// PackBits-RLE'd (cards are mostly flat runs), bilinear-flagged.

import { IMG_FLAG_LINEAR, IMG_FLAG_RLE, packbitsEncode, PSM, TEX_MAX_DIM } from "../../../spec/spec.ts";
import { paletteBytes, quantize } from "./quant.ts";

/** Encode RGBA pixels as a PSM_T8 IMG entry (pow2 dims <= TEX_MAX_DIM). */
export function encodeImgT8(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (!pow2(w) || !pow2(h) || w > TEX_MAX_DIM || h > TEX_MAX_DIM) {
    throw new Error(`img: dims must be pow2 <= ${TEX_MAX_DIM}, got ${w}x${h}`);
  }
  const { palette, indices } = quantize(rgba, w, h);
  const rle = packbitsEncode(indices);
  // RLE only pays when it actually shrinks the stream (video-noisy thumbs
  // can inflate under RLE; the flag keeps both sides honest).
  const useRle = rle.length < indices.length;
  const stream = useRle ? rle : indices;
  const out = new Uint8Array(8 + 1024 + stream.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, w, true);
  dv.setUint16(2, h, true);
  out[4] = PSM.PSM_T8;
  out[5] = IMG_FLAG_LINEAR | (useRle ? IMG_FLAG_RLE : 0);
  out.set(paletteBytes(palette), 8);
  out.set(stream, 8 + 1024);
  return out;
}
