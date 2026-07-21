// compiler/pak.ts — standalone .pak writer (dreamcart-container-compatible).
//
// Byte-for-byte the dreamcart format (docs/pak-format.md v1; constants
// pinned in spec/spec.ts PAK_*), so existing tooling opens PocketJS packs.
// PocketJS entries:
//   ui:styles        styles.bin (compiler/tailwind.ts)
//   ui:font.<slot>   one FONT ATLAS blob per baked slot (compiler/bake-font.ts)
//   ui:img.<name>    demo image texture (IMG entry layout below)
//
// IMG entry layout (PocketJS addition — the container itself is unchanged):
//   off 0  u16  width   (texture dims; pow2, <= TEX_MAX_DIM)
//   off 2  u16  height
//   off 4  u8   psm     (spec.ts PSM: 2 = 4444, 3 = 8888)
//   off 5  u8   reserved (0)
//   off 6  u16  reserved (0)
//   off 8  ...  raw pixel rows (8888: RGBA bytes == ABGR u32 LE; 4444: u16 LE
//               with nibbles A<<12|B<<8|G<<4|R, the GE ABGR4444 layout)
//
// Also here: a minimal PNG decoder (8-bit RGB/RGBA/gray, non-interlaced —
// zlib via node:zlib inflateSync) for baking demo images. Palette/16-bit/
// interlaced PNGs are rejected with a clear error.

import { inflateSync } from "node:zlib";
import {
  PAK_ALIGN,
  PAK_DTYPE,
  PAK_ENTRY_SIZE,
  PAK_FNV1A_OFFSET_BASIS,
  PAK_FNV1A_PRIME,
  PAK_HEADER_SIZE,
  PAK_MAGIC,
  PAK_VERSION,
  PSM,
  TEX_MAX_DIM,
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  keyTileset,
  packbitsEncode,
} from "../spec/spec.ts";

export interface PakBlob {
  key: string;
  /** PAK_DTYPE code (advisory element type). */
  dtype: number;
  data: Uint8Array;
}

export function fnv1a(s: string): number {
  let h = PAK_FNV1A_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, PAK_FNV1A_PRIME);
  }
  return h >>> 0;
}

const align = (n: number): number => (n + (PAK_ALIGN - 1)) & ~(PAK_ALIGN - 1);

/** Pack blobs into .pak bytes. Entries sorted by key; blobs 16-aligned. */
export function pack(blobsIn: PakBlob[]): Uint8Array {
  const blobs = [...blobsIn].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  for (const b of blobs) {
    if (seen.has(b.key)) throw new Error("pak: duplicate key " + b.key);
    seen.add(b.key);
  }

  const enc = new TextEncoder();
  const names = blobs.map((b) => enc.encode(b.key));
  const dirOffset = PAK_HEADER_SIZE;
  const namesOffset = dirOffset + blobs.length * PAK_ENTRY_SIZE;
  let nameCursor = 0;
  const nameOffsets = names.map((n) => {
    const o = nameCursor;
    nameCursor += n.length;
    return o;
  });
  const blobsOffset = align(namesOffset + nameCursor);
  let blobCursor = blobsOffset;
  const blobOffsets = blobs.map((b) => {
    const o = blobCursor;
    blobCursor += align(b.data.length);
    return o;
  });

  const out = new Uint8Array(blobCursor);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PAK_MAGIC, true);
  dv.setUint16(4, PAK_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, blobs.length, true);
  dv.setUint32(12, dirOffset, true);
  dv.setUint32(16, namesOffset, true);
  dv.setUint32(20, blobsOffset, true);
  dv.setUint32(24, out.length, true);
  dv.setUint32(28, 0, true);

  for (let i = 0; i < blobs.length; i++) {
    const e = dirOffset + i * PAK_ENTRY_SIZE;
    dv.setUint32(e + 0, fnv1a(blobs[i].key), true);
    dv.setUint32(e + 4, blobOffsets[i], true);
    dv.setUint32(e + 8, blobs[i].data.length, true);
    dv.setUint32(e + 12, nameOffsets[i], true);
    dv.setUint16(e + 16, names[i].length, true);
    out[e + 18] = blobs[i].dtype & 0xff;
    out[e + 19] = 0;
    dv.setUint32(e + 20, 0, true);
    out.set(names[i], namesOffset + nameOffsets[i]);
    out.set(blobs[i].data, blobOffsets[i]);
  }
  return out;
}

/** Parse .pak bytes back into blobs (round-trips pack(); build-side only). */
export function unpack(file: Uint8Array): PakBlob[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0, true) !== PAK_MAGIC) throw new Error("pak: bad magic");
  if (dv.getUint16(4, true) !== PAK_VERSION) throw new Error("pak: unsupported version");
  const entryCount = dv.getUint32(8, true);
  const dirOff = dv.getUint32(12, true);
  const namesOff = dv.getUint32(16, true);
  const dec = new TextDecoder();
  const blobs: PakBlob[] = [];
  for (let i = 0; i < entryCount; i++) {
    const e = dirOff + i * PAK_ENTRY_SIZE;
    const blobOff = dv.getUint32(e + 4, true);
    const byteLen = dv.getUint32(e + 8, true);
    const nameOff = dv.getUint32(e + 12, true);
    const nameLen = dv.getUint16(e + 16, true);
    const key = dec.decode(file.subarray(namesOff + nameOff, namesOff + nameOff + nameLen));
    blobs.push({ key, dtype: file[e + 18], data: file.slice(blobOff, blobOff + byteLen) });
  }
  return blobs;
}

// ---------------------------------------------------------------------------
// Image entries
// ---------------------------------------------------------------------------

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes/px, row-major. */
  rgba: Uint8Array;
}

/** Encode an IMG entry blob (see layout at the top of this file).
 *  `flags`: spec IMG_FLAG_* — IMG_FLAG_LINEAR requests bilinear sampling
 *  (default nearest; the flag byte has always been in the layout, this is
 *  just the first cook path to set it). */
export function encodeImageEntry(
  img: DecodedImage,
  psm: number = PSM.PSM_8888,
  flags: number = 0,
): Uint8Array {
  const { width: w, height: h, rgba } = img;
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (!pow2(w) || !pow2(h) || w > TEX_MAX_DIM || h > TEX_MAX_DIM) {
    throw new Error(`pak image: dims must be pow2 <= ${TEX_MAX_DIM}, got ${w}x${h}`);
  }
  if (rgba.length !== w * h * 4) throw new Error("pak image: rgba length mismatch");
  const bpp = psm === PSM.PSM_8888 ? 4 : 2;
  const out = new Uint8Array(8 + w * h * bpp);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, w, true);
  dv.setUint16(2, h, true);
  out[4] = psm;
  out[5] = flags & 0xff;
  if (psm === PSM.PSM_8888) {
    out.set(rgba, 8); // RGBA byte order IS the ABGR u32 LE layout
  } else if (psm === PSM.PSM_4444) {
    for (let i = 0, n = w * h; i < n; i++) {
      const r = rgba[i * 4] >> 4;
      const g = rgba[i * 4 + 1] >> 4;
      const b = rgba[i * 4 + 2] >> 4;
      const a = rgba[i * 4 + 3] >> 4;
      dv.setUint16(8 + i * 2, (a << 12) | (b << 8) | (g << 4) | r, true);
    }
  } else {
    throw new Error(`pak image: unsupported psm ${psm}`);
  }
  return out;
}

export interface SpriteAtlas {
  /** Atlas texture dims (pow2, <= TEX_MAX_DIM). */
  atlasW: number;
  atlasH: number;
  /** Frames played (indices 0..frameCount-1, laid out in a `cols`-wide grid). */
  frameCount: number;
  /** Atlas grid columns; rows = ceil(frameCount/cols). */
  cols: number;
  /** Host frames (vblanks) each sprite frame stays on screen (>=1). */
  frameStep: number;
  /** RGBA atlas pixels, 4 bytes/px, row-major. */
  rgba: Uint8Array;
}

/**
 * Encode a SPRITE ATLAS pak entry — an animation the core auto-plays by
 * cycling UV sub-rects of one atlas texture. Header (16 bytes) then RGBA pixels:
 *   off 0  u16  atlasW      (pow2)
 *   off 2  u16  atlasH      (pow2)
 *   off 4  u8   psm         (spec PSM; 3 = 8888)
 *   off 5  u8   reserved (0)
 *   off 6  u16  frameCount
 *   off 8  u16  cols
 *   off 10 u16  frameStep
 *   off 12 u16  reserved (0)
 *   off 14 u16  reserved (0)
 *   off 16 ...  atlas pixels (8888: RGBA bytes == ABGR u32 LE)
 */
export function encodeSpriteEntry(a: SpriteAtlas, psm: number = PSM.PSM_8888): Uint8Array {
  const { atlasW: w, atlasH: h, rgba } = a;
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (!pow2(w) || !pow2(h) || w > TEX_MAX_DIM || h > TEX_MAX_DIM) {
    throw new Error(`pak sprite: atlas dims must be pow2 <= ${TEX_MAX_DIM}, got ${w}x${h}`);
  }
  if (psm !== PSM.PSM_8888 && psm !== PSM.PSM_4444) {
    throw new Error(`pak sprite: unsupported psm ${psm} (8888 or 4444)`);
  }
  if (rgba.length !== w * h * 4) throw new Error("pak sprite: rgba length mismatch");
  if (a.frameCount < 1 || a.cols < 1 || a.frameStep < 1) {
    throw new Error("pak sprite: frameCount/cols/frameStep must be >= 1");
  }
  if (a.frameCount > 0xffff || a.cols > 0xffff || a.frameStep > 0xffff) {
    throw new Error("pak sprite: frame metadata exceeds u16");
  }
  // The core tiles a UNIFORM cols x rows grid; the atlas must divide evenly or
  // UV cell edges land mid-texel (breaks clean sampling + byte-exactness).
  const rows = Math.ceil(a.frameCount / a.cols);
  if (w % a.cols !== 0 || h % rows !== 0) {
    throw new Error(`pak sprite: atlas ${w}x${h} not divisible by grid ${a.cols}x${rows}`);
  }
  if (a.frameCount > a.cols * rows) {
    throw new Error(`pak sprite: frameCount ${a.frameCount} exceeds grid ${a.cols}x${rows}`);
  }
  const bpp = psm === PSM.PSM_8888 ? 4 : 2;
  const out = new Uint8Array(16 + w * h * bpp);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, w, true);
  dv.setUint16(2, h, true);
  out[4] = psm;
  dv.setUint16(6, a.frameCount, true);
  dv.setUint16(8, a.cols, true);
  dv.setUint16(10, a.frameStep, true);
  if (psm === PSM.PSM_8888) {
    out.set(rgba, 16); // RGBA byte order IS the ABGR u32 LE layout
  } else {
    // PSM_4444 (16-bit) — halves texmem for PSP; the GE ABGR4444 nibble layout.
    for (let i = 0, n = w * h; i < n; i++) {
      const r = rgba[i * 4] >> 4;
      const g = rgba[i * 4 + 1] >> 4;
      const b = rgba[i * 4 + 2] >> 4;
      const av = rgba[i * 4 + 3] >> 4;
      dv.setUint16(16 + i * 2, (av << 12) | (b << 8) | (g << 4) | r, true);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tileset entries (spec.ts "TILESET pak entry")
// ---------------------------------------------------------------------------

/** One tile of a tileset, row-major grid order. */
export type TilesetTile =
  | { kind: "absent" } //                        no content: dir off = ABSENT
  | { kind: "solid"; paletteIndex: number } //   uniform color: dir len = 0
  | { kind: "pixels"; indices: Uint8Array }; //  tileW*tileH CLUT8 indices

export interface Tileset {
  /** Tile dims (pow2, <= TEX_MAX_DIM — each tile becomes one core texture). */
  tileW: number;
  tileH: number;
  /** Grid dims; tiles.length must equal cols*rows. */
  cols: number;
  rows: number;
  /** spec TILESET_FLAG_* (RLE applied here when the RLE bit is set). */
  flags: number;
  /** 256 x u32 ABGR shared palette (index 0 conventionally the background). */
  palette: Uint32Array;
  tiles: TilesetTile[];
}

/**
 * Encode a TILESET pak entry EXACTLY per spec/spec.ts: 32-byte 'PKTS' header,
 * 1024-byte shared palette, cols*rows x 8-byte directory, then the pixel
 * streams (PackBits-RLE when flags bit 0 is set). Solid and absent tiles cost
 * only their directory entry — which is the whole point: whitespace-heavy
 * deep-zoom canvases pay for ink, not area.
 */
export function encodeTilesetEntry(ts: Tileset): Uint8Array {
  const { tileW, tileH, cols, rows, flags, palette, tiles } = ts;
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (!pow2(tileW) || !pow2(tileH) || tileW > TEX_MAX_DIM || tileH > TEX_MAX_DIM) {
    throw new Error(`pak tileset: tile dims must be pow2 <= ${TEX_MAX_DIM}, got ${tileW}x${tileH}`);
  }
  if (cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff) {
    throw new Error(`pak tileset: bad grid ${cols}x${rows}`);
  }
  if (palette.length !== 256) throw new Error("pak tileset: palette must be 256 entries");
  if (tiles.length !== cols * rows) {
    throw new Error(`pak tileset: ${tiles.length} tiles != grid ${cols}x${rows}`);
  }
  const rle = (flags & TILESET_FLAG_RLE) !== 0;

  // Encode streams first so directory offsets (relative to dataOff) are known.
  // Identical tiles SHARE one stream: directory offsets are arbitrary, so two
  // entries may point at the same bytes — free wins on repetitive canvases
  // (component grids, ruled whitespace) at zero runtime cost.
  const streams: Uint8Array[] = [];
  const streamByContent = new Map<string, number>(); // exact bytes -> data offset
  const dir = new Uint32Array(tiles.length * 2); // [off, len] pairs
  let dataCursor = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.kind === "absent") {
      dir[i * 2] = TILESET_ABSENT;
      dir[i * 2 + 1] = 0;
    } else if (t.kind === "solid") {
      if (t.paletteIndex < 0 || t.paletteIndex > 255) {
        throw new Error(`pak tileset: solid tile ${i} palette index ${t.paletteIndex} out of range`);
      }
      dir[i * 2] = t.paletteIndex; // len == 0 disambiguates from a stream
      dir[i * 2 + 1] = 0;
    } else {
      if (t.indices.length !== tileW * tileH) {
        throw new Error(`pak tileset: tile ${i} has ${t.indices.length} indices, want ${tileW * tileH}`);
      }
      const stream = rle ? packbitsEncode(t.indices) : t.indices;
      if (stream.length === 0) throw new Error(`pak tileset: tile ${i} produced an empty stream`);
      const contentKey = Buffer.from(stream).toString("base64");
      const shared = streamByContent.get(contentKey);
      if (shared !== undefined) {
        dir[i * 2] = shared;
      } else {
        streamByContent.set(contentKey, dataCursor);
        dir[i * 2] = dataCursor;
        streams.push(stream);
        dataCursor += stream.length;
      }
      dir[i * 2 + 1] = stream.length;
    }
  }

  const paletteOff = TILESET_HEADER_SIZE;
  const dirOff = paletteOff + 256 * 4;
  const dataOff = dirOff + tiles.length * TILESET_DIR_ENTRY_SIZE;
  const out = new Uint8Array(dataOff + dataCursor);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, TILESET_MAGIC, true);
  dv.setUint16(4, TILESET_VERSION, true);
  dv.setUint16(6, flags, true);
  dv.setUint16(8, tileW, true);
  dv.setUint16(10, tileH, true);
  dv.setUint16(12, cols, true);
  dv.setUint16(14, rows, true);
  dv.setUint32(16, paletteOff, true);
  dv.setUint32(20, dirOff, true);
  dv.setUint32(24, dataOff, true);
  dv.setUint32(28, 0, true);
  for (let i = 0; i < 256; i++) dv.setUint32(paletteOff + i * 4, palette[i], true);
  for (let i = 0; i < dir.length; i++) dv.setUint32(dirOff + i * 4, dir[i], true);
  let o = dataOff;
  for (const s of streams) {
    out.set(s, o);
    o += s.length;
  }
  return out;
}

/** Procedural placeholder texture (missing demo image): 32x32 checkerboard. */
export function placeholderImage(): DecodedImage {
  const w = 32;
  const h = 32;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = ((x >> 3) + (y >> 3)) & 1;
      rgba[i] = on ? 0x63 : 0x1e; // indigo-500 / slate-800 checker
      rgba[i + 1] = on ? 0x66 : 0x29;
      rgba[i + 2] = on ? 0xf1 : 0x3b;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

// ---------------------------------------------------------------------------
// Minimal PNG decoder (build-time only)
// ---------------------------------------------------------------------------

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
    o += 12 + len; // len + type + crc
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
  const raw = new Uint8Array(inflateSync(zdata)); // IDAT is zlib-wrapped deflate

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

/** Standard PocketJS entry keys. */
export const KEY_STYLES = "ui:styles";
export const keyFont = (slot: number): string => `ui:font.${slot}`;
export const keyImage = (name: string): string => `ui:img.${name}`;
export const keySprite = (name: string): string => `ui:sprite.${name}`;
export { PAK_DTYPE, keyTileset };
