// Tile-texture streaming — the JS side of the TILESET pak entry (spec.ts).
//
// A TILESET holds one mip level of a deep-zoom canvas: a grid of CLUT8 tiles
// sharing one 256-color palette, whitespace encoded as solid dir entries.
// Native hosts (PSP ffi.rs, pocket-ui-wgpu surface.rs) implement the
// `loadTileTexture` op so tile bytes go .rodata -> core texture without ever
// entering the JS heap. Hosts without the op (browser/sim wasm) fall back to
// reading the entry from __pak here: parse the header once per key, PackBits-
// decode the one tile, and upload it as a raw PSM_T8 texture (1024-byte
// palette + indices — the upload_texture T8 layout).
//
// Handles are generation-tagged (spec TEX_SLOT_BITS): a freed handle draws
// nothing rather than sampling whatever texture reused its slot, which is the
// failure mode tile churn would otherwise hit first.

import {
  IMG_FLAG_LINEAR,
  PSM,
  TILESET_ABSENT,
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_LINEAR,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../spec/spec.ts";
import { getOps } from "./host.ts";
import { get as pakGet } from "./pak.ts";

interface ParsedTileset {
  flags: number;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  paletteOff: number;
  dirOff: number;
  dataOff: number;
  bytes: Uint8Array;
  dv: DataView;
}

// Parsed-header cache for the JS fallback. On PSP this map stays empty: the
// native op path never touches the (QuickJS-heap-copying) pak reader.
const parsed = new Map<string, ParsedTileset | null>();

function parseTileset(key: string): ParsedTileset | null {
  const cached = parsed.get(key);
  if (cached !== undefined) return cached;
  let out: ParsedTileset | null = null;
  try {
    const bytes = pakGet(key);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length >= TILESET_HEADER_SIZE &&
      dv.getUint32(0, true) === TILESET_MAGIC &&
      dv.getUint16(4, true) === TILESET_VERSION
    ) {
      out = {
        flags: dv.getUint16(6, true),
        tileW: dv.getUint16(8, true),
        tileH: dv.getUint16(10, true),
        cols: dv.getUint16(12, true),
        rows: dv.getUint16(14, true),
        paletteOff: dv.getUint32(16, true),
        dirOff: dv.getUint32(20, true),
        dataOff: dv.getUint32(24, true),
        bytes,
        dv,
      };
    }
  } catch {
    out = null; // missing pak entry — treated like an absent tileset
  }
  parsed.set(key, out);
  return out;
}

/** Tests / doc switches: drop the fallback's parsed-header cache. */
export function resetTilesetCache(): void {
  parsed.clear();
}

/**
 * Materialize one tile of a TILESET pak entry as a core texture.
 * Returns a generation-tagged handle, or -1 for absent/solid/malformed tiles
 * (solid tiles are drawn as plain colored Views straight from the baked
 * manifest — they never need a texture).
 */
export function loadTileTexture(key: string, index: number): number {
  const ops = getOps();
  if (ops.loadTileTexture) return ops.loadTileTexture(key, index);

  const ts = parseTileset(key);
  if (!ts || index < 0 || index >= ts.cols * ts.rows) return -1;
  const e = ts.dirOff + index * TILESET_DIR_ENTRY_SIZE;
  if (e + TILESET_DIR_ENTRY_SIZE > ts.bytes.length) return -1;
  const off = ts.dv.getUint32(e, true);
  const len = ts.dv.getUint32(e + 4, true);
  if (off === TILESET_ABSENT || len === 0) return -1; // absent or solid

  const px = ts.tileW * ts.tileH;
  const start = ts.dataOff + off;
  if (start + len > ts.bytes.length) return -1;
  const stream = ts.bytes.subarray(start, start + len);
  let indices: Uint8Array | null;
  if (ts.flags & TILESET_FLAG_RLE) {
    indices = packbitsDecode(stream, px);
  } else {
    indices = stream.length === px ? stream : null;
  }
  if (!indices) return -1;

  // Raw PSM_T8 upload layout: 1024-byte palette, then w*h index bytes.
  const buf = new Uint8Array(1024 + px);
  buf.set(ts.bytes.subarray(ts.paletteOff, ts.paletteOff + 1024), 0);
  buf.set(indices, 1024);
  if (ops.uploadImgEntry) {
    // Preferred: the IMG-entry path carries the linear-filter flag through
    // (the stream is already decoded here, so FLAG_RLE stays clear).
    const entry = new Uint8Array(8 + buf.length);
    const dv = new DataView(entry.buffer);
    dv.setUint16(0, ts.tileW, true);
    dv.setUint16(2, ts.tileH, true);
    entry[4] = PSM.PSM_T8;
    entry[5] = ts.flags & TILESET_FLAG_LINEAR ? IMG_FLAG_LINEAR : 0;
    entry.set(buf, 8);
    return ops.uploadImgEntry(entry);
  }
  return ops.uploadTexture(buf, ts.tileW, ts.tileH, PSM.PSM_T8);
}

/** Release a tile texture (no-op for -1 or on hosts without freeTexture). */
export function freeTileTexture(handle: number): void {
  if (handle < 0) return;
  getOps().freeTexture?.(handle);
}
