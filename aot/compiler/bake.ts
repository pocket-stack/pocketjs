// aot/compiler/bake.ts — Stage 7a: lower tilesets/sprites/font to GBA 4bpp
// tiles + BGR555 palettes. Fills ctx.bgTiles/objTiles/palettes/tileNameToId/
// spriteProtos/fontBase/boxTile.

import { rgb555 } from "../spec/pjgb.ts";
import { FIRST_CHAR, LAST_CHAR, glyphPixels } from "./font.ts";
import type { Ctx } from "./context.ts";
import type { Registry } from "../dsl/index.ts";

// GBA 4bpp tile: 32 bytes, 4 bytes/row, low nibble = left pixel.
export function tile4(px: number[]): Uint8Array {
  const out = new Uint8Array(32);
  for (let row = 0; row < 8; row++) {
    for (let c = 0; c < 4; c++) {
      const lo = px[row * 8 + c * 2] & 0xf;
      const hi = px[row * 8 + c * 2 + 1] & 0xf;
      out[row * 4 + c] = lo | (hi << 4);
    }
  }
  return out;
}

function parseRows(rows: string[], w: number, h: number): number[] {
  if (rows.length !== h) throw new Error(`tile grid: expected ${h} rows, got ${rows.length}`);
  const px: number[] = [];
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    if (r.length !== w) throw new Error(`tile grid row ${y}: expected ${w} cols, got ${r.length} ("${r}")`);
    for (let x = 0; x < w; x++) px.push(parseInt(r[x], 16) & 0xf);
  }
  return px;
}

// Textbox palette (BG bank 15): 0 transparent, 1 ink/white, 2 box background.
const TEXT_INK = 1;
const TEXT_BG = 2;

export function bake(ctx: Ctx, registry: Registry): void {
  const game = registry.game!;
  // v1: every map shares one tileset.
  const tilesetNames = new Set(registry.maps.map((m) => m.tileset));
  if (tilesetNames.size !== 1) {
    throw new Error(`v1 supports one tileset per game (found: ${[...tilesetNames].join(", ")})`);
  }
  const tileset = registry.tilesets.get([...tilesetNames][0]);
  if (!tileset) throw new Error(`tileset "${[...tilesetNames][0]}" not defined`);

  // --- BG tiles: blank, tileset tiles, font glyphs, box fill ---
  ctx.bgTiles.push(tile4(new Array(64).fill(0))); // id 0 blank
  for (const [name, decl] of Object.entries(tileset.tiles)) {
    const px = parseRows(decl.px, 8, 8);
    ctx.tileNameToId.set(name, ctx.bgTiles.length);
    ctx.bgTiles.push(tile4(px));
  }

  ctx.fontBase = ctx.bgTiles.length;
  for (let ch = FIRST_CHAR; ch <= LAST_CHAR; ch++) {
    ctx.bgTiles.push(tile4(glyphPixels(ch, TEXT_INK, TEXT_BG)));
  }
  ctx.boxTile = ctx.bgTiles.length;
  ctx.bgTiles.push(tile4(new Array(64).fill(TEXT_BG)));

  // --- BG palette: bank 0 = tileset; bank 15 = textbox ---
  tileset.palette.forEach((rgb, i) => {
    if (i < 16) ctx.bgPalette[i] = rgb555(rgb[0], rgb[1], rgb[2]);
  });
  ctx.bgPalette[240 + 0] = rgb555(0, 0, 0);
  ctx.bgPalette[240 + TEXT_INK] = rgb555(248, 248, 248);
  ctx.bgPalette[240 + TEXT_BG] = rgb555(24, 32, 72);

  // --- sprites: OBJ tiles + palette bank per sprite ---
  let spriteIdx = 0;
  for (const [name, decl] of registry.sprites) {
    const [w, h] = decl.size;
    if (w !== 16 || h !== 16) throw new Error(`v1 sprites must be 16x16 ("${name}" is ${w}x${h})`);
    const palbank = spriteIdx; // one OBJ palette bank per sprite
    decl.palette.forEach((rgb, i) => {
      if (i < 16) ctx.objPalette[palbank * 16 + i] = rgb555(rgb[0], rgb[1], rgb[2]);
    });
    const tileBase = ctx.objTiles.length;
    const dirs = ["down", "up", "left", "right"] as const;
    const frames = decl.facings.down.length;
    for (const d of dirs) {
      const fr = decl.facings[d];
      if (fr.length !== frames) throw new Error(`sprite "${name}" facing ${d}: frame count mismatch`);
      for (const frame of fr) {
        const grid = parseRows(frame, 16, 16);
        // split 16x16 into 4 tiles: TL, TR, BL, BR (1D OBJ mapping order)
        for (const [ox, oy] of [
          [0, 0],
          [8, 0],
          [0, 8],
          [8, 8],
        ]) {
          const t: number[] = [];
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) t.push(grid[(oy + y) * 16 + (ox + x)]);
          ctx.objTiles.push(tile4(t));
        }
      }
    }
    ctx.spriteProtos.push({ name, id: spriteIdx, w, h, palbank, frames, tileBase });
    ctx.spriteIds.set(name, spriteIdx);
    spriteIdx++;
  }

  // Pre-seed declared flags/items/battles/vars so ids are stable.
  (game.flags ?? []).forEach((f) => ctx.flagId(f));
  (game.vars ?? []).forEach((v) => ctx.varIdOf(v));
  (game.items ?? []).forEach((it) => ctx.items.intern(it));
  (game.battles ?? []).forEach((b) => ctx.battles.intern(b));
}
