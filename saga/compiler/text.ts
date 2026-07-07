// saga/compiler/text.ts — caption text bank: wrap, tokenize, glyph interning.
// Captions are at most C_CAP_LINES x CAP_COLS cells; the compiler wraps and
// validates at build time so the runtime never measures anything.

import { CAP_COLS, CAP_LINES, TOK_END, TOK_NL, ByteWriter } from "../spec/saga.ts";
import { unifontGlyph, halfcellPixels } from "./cjk.ts";

// Anything outside printable ASCII goes through the fullwidth-glyph path and
// occupies 2 cells (halfwidth Unifont glyphs get a blank right half).
const isAscii = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x20 && cp <= 0x7e;
};
const cellW = (ch: string): number => (isAscii(ch) ? 1 : 2);

/** Wrap into <= maxLines lines of <= cols cells. Manual "\n" respected. */
export function wrapText(text: string, cols = CAP_COLS, maxLines = CAP_LINES): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let w = 0;
    // units: ASCII runs stay whole; CJK breaks anywhere
    const units = para.match(/[\x21-\x7e]+| +|[^\x20-\x7e]/g) ?? [];
    for (const u of units) {
      const uw = [...u].reduce((n, c) => n + cellW(c), 0);
      if (w + uw > cols && w > 0) {
        out.push(line);
        line = u === " " || /^ +$/.test(u) ? "" : u;
        w = line ? uw : 0;
      } else {
        line += u;
        w += uw;
      }
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length > maxLines) {
    throw new Error(`caption overflows ${maxLines} lines: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
  }
  return out;
}

export class TextBank {
  private ids = new Map<string, number>();
  readonly entries: { raw: string; lines: string[] }[] = [];
  /** fullwidth glyph interner: char -> glyph id */
  private glyphIds = new Map<string, number>();
  readonly glyphChars: string[] = [];

  intern(text: string, opts: { cols?: number; maxLines?: number } = {}): number {
    const key = text;
    const hit = this.ids.get(key);
    if (hit !== undefined) return hit;
    const lines = wrapText(text, opts.cols ?? CAP_COLS, opts.maxLines ?? CAP_LINES);
    const id = this.entries.length;
    this.entries.push({ raw: text, lines });
    this.ids.set(key, id);
    for (const line of lines) {
      for (const ch of line) {
        if (isAscii(ch)) continue;
        if (!this.glyphIds.has(ch)) {
          this.glyphIds.set(ch, this.glyphChars.length);
          this.glyphChars.push(ch);
        }
      }
    }
    return id;
  }

  tokenize(id: number): Uint8Array {
    const w = new ByteWriter();
    const { lines } = this.entries[id];
    lines.forEach((line, i) => {
      if (i > 0) w.u8(TOK_NL);
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        if (isAscii(ch)) {
          w.u8(cp);
        } else {
          const gid = this.glyphIds.get(ch);
          if (gid === undefined) throw new Error(`glyph not interned: ${ch}`);
          w.u8(0x80 | ((gid >> 8) & 0x7f)).u8(gid & 0xff);
        }
      }
    });
    w.u8(TOK_END);
    return w.toUint8Array();
  }

  /** Glyph store: 95 ASCII halfcells + 2 halfcells per fullwidth glyph.
   * Each halfcell = two stacked 4bpp 8x8 tiles (64 bytes), ink/bg indices. */
  bakeGlyphStore(ink: number, bg: number): Uint8Array {
    const halfcells: Uint8Array[] = [];
    const pack = (px: number[]): Uint8Array => {
      const t = new Uint8Array(32);
      for (let row = 0; row < 8; row++)
        for (let c = 0; c < 4; c++) {
          const lo = px[row * 8 + c * 2] & 0xf;
          const hi = px[row * 8 + c * 2 + 1] & 0xf;
          t[row * 4 + c] = lo | (hi << 4);
        }
      return t;
    };
    const bake = (cp: number | null, half: 0 | 1): Uint8Array => {
      const glyph = cp === null ? null : unifontGlyph(cp);
      const [top, bottom] = halfcellPixels(glyph, half, ink, bg);
      const out = new Uint8Array(64);
      out.set(pack(top), 0);
      out.set(pack(bottom), 32);
      return out;
    };
    for (let cp = 0x20; cp <= 0x7e; cp++) halfcells.push(bake(cp, 0));
    for (const ch of this.glyphChars) {
      const cp = ch.codePointAt(0)!;
      const g = unifontGlyph(cp);
      if (g && g.width === 8) {
        halfcells.push(bake(cp, 0), bake(null, 0)); // halfwidth glyph + blank right half
      } else {
        halfcells.push(bake(cp, 0), bake(cp, 1));
      }
    }
    const blob = new Uint8Array(halfcells.length * 64);
    halfcells.forEach((hc, i) => blob.set(hc, i * 64));
    return blob;
  }

  buildBlob(): { offs: number[]; blob: Uint8Array } {
    const offs: number[] = [];
    const parts: Uint8Array[] = [];
    let cur = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const t = this.tokenize(i);
      offs.push(cur);
      parts.push(t);
      cur += t.length;
    }
    const blob = new Uint8Array(cur);
    let o = 0;
    for (const p of parts) {
      blob.set(p, o);
      o += p.length;
    }
    return { offs, blob };
  }
}
