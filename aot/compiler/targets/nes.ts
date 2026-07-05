// aot/compiler/targets/nes.ts — the NES backend.
//
// Like the GB backend, all game data is residualized into C arrays; unlike
// the GB (whose linker autobanks), the COMPILER assigns UNROM banks here:
// big read-only blobs (glyphs, tiles, texts, per-map tiles) are first-fit
// packed into 16 KB switchable banks (segments BANK0..n at $8000), while
// code, collision (bit-packed), actors/warps, scripts, and the sprite/map
// tables live in the fixed bank ($C000). The linker config and iNES header
// are generated to match.
//
// Pixel policy: the authored 16-color art is luminance-clustered to the
// NES's 4-color palettes — BG palette 0 for the map (backdrop = darkest
// cluster), palette 1 for the textbox, and up to 4 OBJ palettes deduped
// across sprites.

import { mkdir } from "node:fs/promises";
import { $ } from "bun";
import {
  BG_TILE_BUDGET,
  BUDGET,
  OBJ_TILE_BUDGET,
  TILE_2BPP_BYTES,
  TOK_ASCII_MIN,
} from "../../spec/pjgb.ts";
import { halfcellPixels, unifontGlyph } from "../cjk.ts";
import { tokenize } from "../text.ts";
import { shadeOf, tileShadeMapper } from "./gb.ts";
import type { CompileOutput } from "../index.ts";
import type { Rgb } from "../context.ts";
import type { TargetBuildResult } from "./index.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
const RT = ROOT + "aot/runtime/nes";
const BANK_SIZE = 16 * 1024;
const BANK_CAP = BANK_SIZE - 64; // headroom for alignment/slop

// The canonical 2C02 master palette (NesDev wiki reference values).
const NES_PAL: Rgb[] = [
  [84, 84, 84], [0, 30, 116], [8, 16, 144], [48, 0, 136], [68, 0, 100], [92, 0, 48], [84, 4, 0], [60, 24, 0],
  [32, 42, 0], [8, 58, 0], [0, 64, 0], [0, 60, 0], [0, 50, 60], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  [152, 150, 152], [8, 76, 196], [48, 50, 236], [92, 30, 228], [136, 20, 176], [160, 20, 100], [152, 34, 32], [120, 60, 0],
  [84, 90, 0], [40, 114, 0], [8, 124, 0], [0, 118, 40], [0, 102, 120], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  [236, 238, 236], [76, 154, 236], [120, 124, 236], [176, 98, 236], [228, 84, 236], [236, 88, 180], [236, 106, 100], [212, 136, 32],
  [160, 170, 0], [116, 196, 0], [76, 208, 32], [56, 204, 108], [56, 180, 204], [60, 60, 60], [0, 0, 0], [0, 0, 0],
  [236, 238, 236], [168, 204, 236], [188, 188, 236], [212, 178, 236], [236, 174, 236], [236, 174, 212], [236, 180, 176], [228, 196, 144],
  [204, 210, 120], [180, 222, 120], [168, 226, 144], [152, 226, 180], [160, 214, 228], [160, 162, 160], [0, 0, 0], [0, 0, 0],
];

function nearestNes(c: Rgb): number {
  let best = 0x0f;
  let bestD = Infinity;
  NES_PAL.forEach((p, i) => {
    if ((i & 0x0f) >= 0x0e) return; // skip the black mirrors
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function avg(colors: Rgb[]): Rgb {
  if (!colors.length) return [128, 128, 128];
  const s = colors.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]] as Rgb, [0, 0, 0] as Rgb);
  return [s[0] / colors.length, s[1] / colors.length, s[2] / colors.length];
}

/** NES planar 2bpp tile: 8 bytes plane 0 then 8 bytes plane 1. */
export function tile2nes(px: number[], toVal: (v: number, x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(TILE_2BPP_BYTES);
  for (let row = 0; row < 8; row++) {
    let p0 = 0;
    let p1 = 0;
    for (let x = 0; x < 8; x++) {
      const v = toVal(px[row * 8 + x], x, row) & 3;
      p0 |= (v & 1) << (7 - x);
      p1 |= ((v >> 1) & 1) << (7 - x);
    }
    out[row] = p0;
    out[row + 8] = p1;
  }
  return out;
}

// Textbox glyphs in BG palette 1: bg = color 1 (black), ink = color 3 (white).
const GLYPH_INK = 3;
const GLYPH_BG = 1;

function cBytes(name: string, bytes: ArrayLike<number>): string {
  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice: string[] = [];
    for (let j = i; j < Math.min(i + 16, bytes.length); j++) slice.push(`0x${(bytes[j] & 0xff).toString(16).padStart(2, "0")}`);
    rows.push("  " + slice.join(",") + ",");
  }
  return [`const unsigned char ${name}[] = {`, ...rows, "};"].join("\n");
}
function cWords(name: string, words: number[]): string {
  const rows: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    rows.push("  " + words.slice(i, i + 12).map((w) => `0x${(w & 0xffff).toString(16)}`).join(",") + ",");
  }
  return [`const unsigned int ${name}[] = {`, ...rows, "};"].join("\n");
}

interface BankItem {
  name: string; // symbol-ish label
  code: string; // C source for this item's arrays
  size: number;
  symbols: string[]; // symbols defined (for PJ_BANK_* defines)
}

export async function buildNes(out: CompileOutput, outPath: string): Promise<TargetBuildResult> {
  const { ctx, model, game } = out;
  const t = ctx.target;

  // --- text bank first (completes the glyph set) ---
  const texts = ctx.texts.list().map((s) => tokenize(s, ctx.fullGlyphId));
  const textBlob: number[] = [];
  const textOffs: number[] = [];
  for (const tk of texts) {
    textOffs.push(textBlob.length);
    textBlob.push(...tk);
  }

  // --- palettes ---
  const bgClasses: Rgb[][] = [[], [], [], []];
  ctx.bgPaletteRgb.forEach((c) => bgClasses[shadeOf(c)].push(c));
  const bgRep = (cls: number, fallback: Rgb): number => nearestNes(bgClasses[cls].length ? avg(bgClasses[cls]) : fallback);
  const pal0 = [
    bgRep(3, [20, 20, 20]),
    bgRep(2, [88, 88, 88]),
    bgRep(1, [160, 160, 160]),
    bgRep(0, [236, 238, 236]),
  ];
  const palBox = [pal0[0], 0x0f, 0x2d, 0x30];

  // OBJ palettes: per sprite, dedupe to <= 4
  const objPals: number[][] = [];
  const spritePal: number[] = [];
  ctx.spriteProtos.forEach((sp) => {
    const cls: Rgb[][] = [[], [], []]; // slots 1..3 (light, mid, dark)
    sp.palette.forEach((c, i) => {
      if (i === 0) return;
      const s = shadeOf(c);
      cls[s === 0 ? 0 : s - 1 > 2 ? 2 : s - 1].push(c);
    });
    const p = [
      pal0[0],
      nearestNes(cls[0].length ? avg(cls[0]) : [236, 238, 236]),
      nearestNes(cls[1].length ? avg(cls[1]) : [136, 136, 136]),
      nearestNes(cls[2].length ? avg(cls[2]) : [32, 32, 32]),
    ];
    const key = p.join(",");
    let idx = objPals.findIndex((q) => q.join(",") === key);
    if (idx < 0) {
      if (objPals.length < 4) {
        objPals.push(p);
        idx = objPals.length - 1;
      } else {
        // merge into the nearest existing palette
        let best = 0;
        let bestD = Infinity;
        objPals.forEach((q, qi) => {
          let d = 0;
          for (let k = 1; k < 4; k++) {
            const a = NES_PAL[q[k]];
            const b = NES_PAL[p[k]];
            d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          }
          if (d < bestD) {
            bestD = d;
            best = qi;
          }
        });
        idx = best;
      }
    }
    spritePal.push(idx);
  });
  while (objPals.length < 4) objPals.push(palBox);

  const palettes = [
    pal0[0], pal0[1], pal0[2], pal0[3],
    palBox[0], palBox[1], palBox[2], palBox[3],
    palBox[0], palBox[1], palBox[2], palBox[3],
    palBox[0], palBox[1], palBox[2], palBox[3],
    ...objPals.flat(),
  ];

  // --- BG tiles ---
  const bgTiles: Uint8Array[] = ctx.bgTilePx.map((px) => {
    const shade = tileShadeMapper(px, ctx.bgPaletteRgb);
    return tile2nes(px, (v, x, y) => 3 - shade(v, x, y));
  });
  const boxTile = bgTiles.length;
  bgTiles.push(tile2nes(new Array(64).fill(0), () => GLYPH_BG));
  const slotBase = bgTiles.length;
  const slotTiles = t.glyphSlots * 2;

  // --- glyphs ---
  const glyphHalf: number[] = [];
  for (let c = TOK_ASCII_MIN; c <= 0x7e; c++) {
    const [top, bottom] = halfcellPixels(unifontGlyph(c), 0, GLYPH_INK, GLYPH_BG);
    glyphHalf.push(...tile2nes(top, (v) => v), ...tile2nes(bottom, (v) => v));
  }
  const glyphFull: number[] = [];
  for (const ch of ctx.fullGlyphs.list()) {
    const gl = unifontGlyph(ch.codePointAt(0)!);
    for (const half of [0, 1] as const) {
      const [top, bottom] = halfcellPixels(gl, half, GLYPH_INK, GLYPH_BG);
      glyphFull.push(...tile2nes(top, (v) => v), ...tile2nes(bottom, (v) => v));
    }
  }

  // --- OBJ tiles: per frame L(top,bottom), R(top,bottom) ---
  const objTiles: number[] = [];
  ctx.spriteProtos.forEach((sp, si) => {
    const pal = sp.palette;
    const objVal = (v: number): number => {
      if (v === 0) return 0;
      const s = shadeOf(pal[v] ?? [0, 0, 0]);
      return s === 0 ? 1 : s;
    };
    for (const grid of ctx.spriteFrames16[si]) {
      for (const [ox, oy] of [
        [0, 0],
        [0, 8],
        [8, 0],
        [8, 8],
      ]) {
        const tpx: number[] = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) tpx.push(grid[(oy + y) * 16 + (ox + x)]);
        objTiles.push(...tile2nes(tpx, objVal));
      }
    }
  });
  const objTileCount = objTiles.length / TILE_2BPP_BYTES;

  // --- validation ---
  const err: string[] = [];
  if (slotBase + slotTiles > BG_TILE_BUDGET.nes) err.push(`BG tiles ${slotBase}+${slotTiles} slots > ${BG_TILE_BUDGET.nes}`);
  if (objTileCount > OBJ_TILE_BUDGET.nes) err.push(`OBJ tiles ${objTileCount} > ${OBJ_TILE_BUDGET.nes}`);
  if (ctx.fullGlyphs.size > BUDGET.MAX_FULL_GLYPHS) err.push(`too many CJK glyphs (${ctx.fullGlyphs.size})`);
  for (const m of model.maps) {
    if (m.w > t.maxMapW || m.h > t.maxMapH) err.push(`map "${m.name}" ${m.w}x${m.h} exceeds ${t.maxMapW}x${t.maxMapH} (NES nametable)`);
    if (m.actors.length > BUDGET.MAX_ACTORS_PER_MAP) err.push(`map "${m.name}" has ${m.actors.length} actors`);
  }
  if (err.length) throw new Error("NES lowering failed:\n  - " + err.join("\n  - "));

  // --- banked items (first-fit) ---
  const items: BankItem[] = [];
  const pushBytes = (sym: string, bytes: ArrayLike<number>): void => {
    items.push({ name: sym, code: cBytes(sym, bytes.length ? bytes : [0]), size: Math.max(bytes.length, 1), symbols: [sym] });
  };
  pushBytes("pj_glyphs_full", glyphFull);
  pushBytes("pj_glyphs_half", glyphHalf);
  pushBytes("pj_bg_tiles", bgTiles.flatMap((b) => [...b]));
  pushBytes("pj_obj_tiles", objTiles);
  items.push({
    name: "pj_texts",
    code: [cWords("pj_text_offs", textOffs.length ? textOffs : [0]), "", cBytes("pj_texts", textBlob.length ? textBlob : [0])].join("\n"),
    size: textBlob.length + textOffs.length * 2 + 2,
    symbols: ["pj_texts", "pj_text_offs"],
  });
  model.maps.forEach((m) => {
    pushBytes(`pj_map${m.index}_tiles`, m.tiles);
  });

  const banks: BankItem[][] = [];
  const bankOf = new Map<string, number>();
  for (const it of items) {
    if (it.size > BANK_CAP) throw new Error(`NES: data item ${it.name} (${it.size}B) exceeds a 16KB bank`);
    let placed = -1;
    for (let b = 0; b < banks.length; b++) {
      const used = banks[b].reduce((a, x) => a + x.size, 0);
      if (used + it.size <= BANK_CAP) {
        placed = b;
        break;
      }
    }
    if (placed < 0) {
      banks.push([]);
      placed = banks.length - 1;
    }
    banks[placed].push(it);
    for (const s of it.symbols) bankOf.set(s, placed);
  }
  const nDataBanks = banks.length;
  let prgTotal = 2;
  while (prgTotal < nDataBanks + 1) prgTotal *= 2;
  if (prgTotal > 16) throw new Error(`NES: game needs ${nDataBanks + 1} PRG banks (> UNROM's 16)`);

  // --- fixed-bank data ---
  const scriptBlob: number[] = [];
  const scriptOffs: number[] = [];
  for (const s of ctx.scripts) {
    scriptOffs.push(scriptBlob.length);
    scriptBlob.push(...s.bytecode);
  }
  scriptOffs.push(scriptBlob.length);

  const fixedParts: string[] = [];
  fixedParts.push(cBytes("pj_palettes", palettes));
  fixedParts.push(cWords("pj_script_offs", scriptOffs));
  fixedParts.push(cBytes("pj_scripts", scriptBlob.length ? scriptBlob : [0]));
  const mapInfos: string[] = [];
  model.maps.forEach((m) => {
    // bit-packed collision
    const packed = new Array(Math.ceil((m.w * m.h) / 8)).fill(0);
    m.collision.forEach((c, i) => {
      if (c) packed[i >> 3] |= 1 << (i & 7);
    });
    const actors: number[] = [];
    for (const a of m.actors) {
      actors.push(a.x & 0xff, a.x >> 8, a.y & 0xff, a.y >> 8, a.spriteId, a.facing, a.movement, a.flags, a.onTalk & 0xff, (a.onTalk >> 8) & 0xff, 0, 0);
    }
    const warps: number[] = [];
    for (const wp of m.warps) {
      warps.push(wp.x & 0xff, wp.x >> 8, wp.y & 0xff, wp.y >> 8, wp.destMapIdx!, wp.destDir!, wp.destX! & 0xff, wp.destX! >> 8, wp.destY! & 0xff, wp.destY! >> 8, 0, 0);
    }
    fixedParts.push(cBytes(`pj_map${m.index}_coll`, packed));
    fixedParts.push(cBytes(`pj_map${m.index}_actors`, actors.length ? actors : [0]));
    fixedParts.push(cBytes(`pj_map${m.index}_warps`, warps.length ? warps : [0]));
    mapInfos.push(
      `  { ${m.w}, ${m.h}, 0x${m.onEnter.toString(16)}, ${m.actors.length}, ${m.warps.length}, ${bankOf.get(`pj_map${m.index}_tiles`)}, ` +
        `pj_map${m.index}_tiles, pj_map${m.index}_coll, (const PjActor *)pj_map${m.index}_actors, (const PjWarp *)pj_map${m.index}_warps },`,
    );
  });
  fixedParts.push(`const PjMapInfo pj_maps[] = {\n${mapInfos.join("\n")}\n};`);
  fixedParts.push(
    `const PjSprite pj_sprites[] = {\n` +
      (ctx.spriteProtos.map((sp, i) => `  { ${sp.tileBase * 4}, ${sp.frames}, ${spritePal[i]} },`).join("\n") || "  { 0, 1, 0 },") +
      `\n};`,
  );

  // --- gen_data.h ---
  const header = [
    "/* GENERATED by @pocketjs/aot (nes backend) — do not edit. */",
    "#ifndef PJ_GEN_DATA_H",
    "#define PJ_GEN_DATA_H",
    "",
    "typedef struct { unsigned int x, y; unsigned char sprite, facing, move, flags; unsigned int on_talk, rsv; } PjActor;",
    "typedef struct { unsigned int x, y; unsigned char dest_map, dest_dir; unsigned int dest_x, dest_y, rsv; } PjWarp;",
    "typedef struct { unsigned char w, h, on_enter, n_actors, n_warps, tiles_bank;",
    "                 const unsigned char *tiles; const unsigned char *coll;",
    "                 const PjActor *actors; const PjWarp *warps; } PjMapInfo;",
    "typedef struct { unsigned int tile_base; unsigned char frames; unsigned char pal; } PjSprite;",
    "",
    `#define PJ_MAP_COUNT ${model.maps.length}`,
    `#define PJ_SPRITE_COUNT ${ctx.spriteProtos.length}`,
    `#define PJ_TEXT_COUNT ${texts.length}`,
    `#define PJ_SCRIPT_COUNT ${ctx.scripts.length}`,
    `#define PJ_START_MAP ${model.start.map}`,
    `#define PJ_START_X ${model.start.x}`,
    `#define PJ_START_Y ${model.start.y}`,
    `#define PJ_START_DIR ${model.start.dir}`,
    `#define PJ_BG_TILE_COUNT ${bgTiles.length}`,
    `#define PJ_OBJ_TILE_COUNT ${objTileCount}`,
    `#define PJ_BOX_TILE ${boxTile}`,
    `#define PJ_SLOT_BASE ${slotBase}`,
    `#define PJ_FULL_GLYPH_COUNT ${ctx.fullGlyphs.size}`,
    `#define PJ_BANK_GLYPHS_FULL ${bankOf.get("pj_glyphs_full")}`,
    `#define PJ_BANK_GLYPHS_HALF ${bankOf.get("pj_glyphs_half")}`,
    `#define PJ_BANK_BG_TILES ${bankOf.get("pj_bg_tiles")}`,
    `#define PJ_BANK_OBJ_TILES ${bankOf.get("pj_obj_tiles")}`,
    `#define PJ_BANK_TEXTS ${bankOf.get("pj_texts")}`,
    "",
    "extern const unsigned char pj_palettes[];",
    "extern const PjMapInfo pj_maps[];",
    "extern const PjSprite pj_sprites[];",
    "extern const unsigned char pj_scripts[];",
    "extern const unsigned int pj_script_offs[];",
    "extern const unsigned char pj_glyphs_full[];",
    "extern const unsigned char pj_glyphs_half[];",
    "extern const unsigned char pj_bg_tiles[];",
    "extern const unsigned char pj_obj_tiles[];",
    "extern const unsigned char pj_texts[];",
    "extern const unsigned int pj_text_offs[];",
    ...model.maps.flatMap((m) => [
      `extern const unsigned char pj_map${m.index}_tiles[];`,
      `extern const unsigned char pj_map${m.index}_coll[];`,
      `extern const unsigned char pj_map${m.index}_actors[];`,
      `extern const unsigned char pj_map${m.index}_warps[];`,
    ]),
    "",
    "#endif",
    "",
  ].join("\n");

  // --- generated linker config + iNES header ---
  const memBanks = Array.from({ length: prgTotal - 1 }, (_, i) => `  PRG${i}: start=$8000, size=$4000, file=%O, fill=yes, fillval=$FF;`);
  const segBanks = banks.map((_, i) => `  BANK${i}: load=PRG${i}, type=ro;`);
  const cfg = [
    "MEMORY {",
    "  ZP: start=$0002, size=$001E, type=rw, define=yes;",
    "  MAIN: start=$0300, size=$0400, type=rw, define=yes;",
    "  HDR: start=$0000, size=$0010, file=%O, fill=yes;",
    ...memBanks,
    "  PRGFIX: start=$C000, size=$3FFA, file=%O, fill=yes, fillval=$FF;",
    "  VEC: start=$FFFA, size=$0006, file=%O, fill=yes;",
    "}",
    "SEGMENTS {",
    "  HEADER: load=HDR, type=ro;",
    ...segBanks,
    "  STARTUP: load=PRGFIX, type=ro, define=yes;",
    "  ONCE: load=PRGFIX, type=ro, optional=yes;",
    "  LOWCODE: load=PRGFIX, type=ro, optional=yes;",
    "  CODE: load=PRGFIX, type=ro, define=yes;",
    "  RODATA: load=PRGFIX, type=ro, define=yes;",
    "  DATA: load=PRGFIX, run=MAIN, type=rw, define=yes;",
    "  VECTORS: load=VEC, type=ro;",
    "  BSS: load=MAIN, type=bss, define=yes;",
    "  ZEROPAGE: load=ZP, type=zp;",
    "}",
    "",
  ].join("\n");

  const ines = [
    "; GENERATED iNES header (UNROM, CHR-RAM)",
    '.segment "HEADER"',
    `.byte $4E,$45,$53,$1A, ${prgTotal}, 0, $20, $00`,
    ".byte 0,0,0,0,0,0,0,0",
    "",
  ].join("\n");

  // --- write generated sources + build ---
  const BUILD = ROOT + "aot/dist/nes-build";
  await mkdir(BUILD, { recursive: true });
  const gen: string[] = [];
  const writeGen = async (name: string, contents: string): Promise<void> => {
    await Bun.write(`${BUILD}/${name}`, contents);
    gen.push(name);
  };
  await writeGen("gen_data.h", header);
  await writeGen("gen_ines.s", ines);
  await writeGen("gen_nes.cfg", cfg);
  await writeGen(
    "gen_fixed.c",
    ['/* GENERATED by @pocketjs/aot (nes backend) */', '#include "gen_data.h"', "", ...fixedParts, ""].join("\n"),
  );
  for (let b = 0; b < banks.length; b++) {
    await writeGen(
      `gen_bank${b}.c`,
      [
        "/* GENERATED by @pocketjs/aot (nes backend) */",
        `#pragma rodata-name ("BANK${b}")`,
        "",
        ...banks[b].map((it) => it.code),
        "",
      ].join("\n"),
    );
  }

  const cc65home =
    process.env.CC65_HOME ?? ((await $`brew --prefix cc65`.quiet().text().catch(() => "")).trim() || "/opt/homebrew/opt/cc65");
  const nesLib = `${cc65home}/share/cc65/lib/nes.lib`;

  const cFiles = [
    { src: `${RT}/nesrt.c`, o: "nesrt" },
    { src: `${RT}/vm.c`, o: "vm" },
    { src: `${RT}/textbox.c`, o: "textbox" },
    { src: `${RT}/main.c`, o: "main" },
    { src: `${BUILD}/gen_fixed.c`, o: "gen_fixed" },
    ...banks.map((_, b) => ({ src: `${BUILD}/gen_bank${b}.c`, o: `gen_bank${b}` })),
  ];
  const objs: string[] = [];
  for (const f of cFiles) {
    await $`cc65 -t nes -Osir -I ${RT} -I ${BUILD} -o ${BUILD}/${f.o}.s ${f.src}`.quiet();
    await $`ca65 -t nes -o ${BUILD}/${f.o}.o ${BUILD}/${f.o}.s`.quiet();
    objs.push(`${BUILD}/${f.o}.o`);
  }
  for (const s of [`${RT}/crt0.s`, `${BUILD}/gen_ines.s`]) {
    const o = `${BUILD}/${s.split("/").pop()!.replace(/\.s$/, "")}.o`;
    await $`ca65 -t nes -o ${o} ${s}`.quiet();
    objs.unshift(o);
  }
  await $`ld65 -C ${BUILD}/gen_nes.cfg -o ${outPath} ${objs} ${nesLib}`.quiet();

  const size = (await Bun.file(outPath).arrayBuffer()).byteLength;
  return { rom: outPath, size };
}
