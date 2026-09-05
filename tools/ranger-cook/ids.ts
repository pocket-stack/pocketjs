// tools/ranger-cook/ids.ts — M1 stable-ID assignment table (hand-written).
//
// §4.2: IDs derive mechanically from SWF tag IDs, never from names/order.
// File/JSON keys use the stable ID 1:1 (lowercase, .png fixed). The cook
// FAILS on IDs outside this table (no invented IDs); adding a clip to the
// ported range starts with a row-adding commit here.
//
// This table covers exactly the selected LINKAGE (apps/ranger/scope.ts):
// every entry's base is `v<characterId>` and matches the M0 exportAssets
// evidence. `pieces` counts locally evidenced `v<id>p<i>.png` rasters
// (on-disk PNGs in apps/ranger/); 0 means no local raster yet — the
// M-slice confirm-or-drop rule from LINKAGE_EVIDENCE, not a claim.
// Inner-clip IDs (e.g. v328p0, referenced by fighters.* frames) are NOT
// linkage roots; they are validated by grammar + disk existence in
// cook.ts, not by membership here.

import {
  LINKAGE,
  OUT_OF_SCOPE_IDS,
  assertCookLinkage,
  validateCookScope,
} from "../../apps/ranger/scope.ts";

export { LINKAGE, OUT_OF_SCOPE_IDS, assertCookLinkage, validateCookScope };

export interface StableIdEntry {
  /** ExportAssets linkage name (LINKAGE key). */
  linkage: string;
  /** SWF characterId (DefineSprite tag id). */
  characterId: number;
  /** Stable base id: always `v<characterId>` (§4.2). */
  base: string;
  /** Locally evidenced `v<id>p<i>.png` piece count (0 = none yet). */
  pieces: number;
}

const row = (linkage: string, characterId: number, pieces = 0): StableIdEntry => ({
  linkage,
  characterId,
  base: `v${characterId}`,
  pieces,
});

/** Exhaustive stable-ID table for the selected LINKAGE (20 rows, M0 §10). */
export const STABLE_IDS: readonly StableIdEntry[] = [
  row("player1", 546),
  row("enemy1", 1158),
  row("hits", 3),
  row("hits2", 2),
  row("hits3", 1),
  // ef_hit1: base + 4 pieces evidenced on disk (v370.png, v370p0..p3.png).
  row("ef_hit1", 370, 4),
  row("ef_hit2", 1172),
  row("ef_hit3", 1175),
  row("ef_hit4", 1177),
  row("ef_hit5", 1178),
  row("ef_hit6", 1182),
  row("ef_hit7", 1183),
  row("ef_hit11", 1185),
  row("ef_hit12", 1171),
  // tobi1: base raster only on disk (v185.png), no pieces.
  row("tobi1", 185),
  row("yararekie1", 426),
  row("p_hpb", 1190),
  row("e_hpb", 1193),
  row("jimen", 446),
  row("haikei_front1", 1170),
];

export const STABLE_ID_BY_LINKAGE: Readonly<Record<string, StableIdEntry>> =
  Object.fromEntries(STABLE_IDS.map((e) => [e.linkage, e]));

/** Stable sheet files for one entry: base (+ pieces when evidenced). */
export function stableSheetFiles(entry: StableIdEntry): readonly string[] {
  const files = [`${entry.base}.png`];
  for (let i = 0; i < entry.pieces; i++) files.push(`${entry.base}p${i}.png`);
  return files;
}

// --- Stable-ID grammar (§4.2-1) ---

/** Sprite character base: `v<characterId>` (e.g. v328, v1144). */
export function isSpriteBaseId(s: string): boolean {
  return /^v\d+$/.test(s);
}
/** Sprite raster piece file: `v<characterId>p<placeIndex>.png` (placeIndex 0-based). */
export function isSpritePieceFile(s: string): boolean {
  return /^v\d+p\d+\.png$/.test(s);
}
/** Any sprite sheet file: base render or piece (`v370.png`, `v370p0.png`). */
export function isSpriteSheetFile(s: string): boolean {
  return /^v\d+(\.png|p\d+\.png)$/.test(s);
}
/** Lossless bitmap: `b<bitmapId>`. */
export function isBitmapId(s: string): boolean {
  return /^b\d+$/.test(s);
}
/** Sound: `s<soundId>` + optional `_<slot>` alias (e.g. s12_hit). */
export function isSoundId(s: string): boolean {
  return /^s\d+(_[a-z0-9]+)?$/.test(s);
}
/** Font: `f<fontId>_<size>`. */
export function isFontId(s: string): boolean {
  return /^f\d+_\d+$/.test(s);
}
