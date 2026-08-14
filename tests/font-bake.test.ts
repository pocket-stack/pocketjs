import { describe, expect, test } from "bun:test";
import { parse as parseFont } from "opentype.js";
import { bakeSlot, DEFAULT_REGULAR } from "../framework/compiler/bake-font.ts";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
} from "../contracts/spec/spec.ts";

const font = parseFont(await Bun.file(DEFAULT_REGULAR).arrayBuffer());
const codepoints = [0x41, 0x42, 0xee]; // A, B, and a negative-LSB accent.

describe("font atlas density", () => {
  test("v3 increases coverage while preserving logical metrics and cmap", () => {
    const one = bakeSlot(font, 0, 16, false, codepoints, 1);
    const two = bakeSlot(font, 0, 16, false, codepoints, 2);
    const oneView = new DataView(one.bytes.buffer, one.bytes.byteOffset, one.bytes.byteLength);
    const twoView = new DataView(two.bytes.buffer, two.bytes.byteOffset, two.bytes.byteLength);

    expect(oneView.getUint32(0, true)).toBe(FONT_MAGIC);
    expect(oneView.getUint16(4, true)).toBe(FONT_VERSION);
    expect(twoView.getUint16(4, true)).toBe(FONT_VERSION);
    expect(one.bytes[14]).toBe(1);
    expect(two.bytes[14]).toBe(2);

    expect([two.cellW, two.cellH]).toEqual([one.cellW, one.cellH]);
    expect([two.coverageW, two.coverageH]).toEqual([one.cellW * 2, one.cellH * 2]);
    expect(two.rasterDensity).toBe(2);
    // Header logical metrics (cell, baseline, line-height, slot, flags) are
    // identical. Density lives only in byte 14.
    expect([...two.bytes.subarray(8, 14)]).toEqual([...one.bytes.subarray(8, 14)]);

    const cmapEnd = FONT_HEADER_SIZE + one.glyphCount * FONT_CMAP_ENTRY_SIZE;
    expect([...two.bytes.subarray(FONT_HEADER_SIZE, cmapEnd)]).toEqual([
      ...one.bytes.subarray(FONT_HEADER_SIZE, cmapEnd),
    ]);
    expect(two.bytes.length).toBe(
      cmapEnd + two.glyphCount * two.coverageW * two.coverageH,
    );
    expect(two.bytes.length).toBeGreaterThan(one.bytes.length);

    const coverage = two.bytes.subarray(cmapEnd);
    expect(coverage.some((sample) => sample > 0)).toBe(true);
    expect(coverage.some((sample) => sample > 0 && sample < 255)).toBe(true);
  });

  test("rejects densities outside the one-byte v3 contract", () => {
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 0)).toThrow(/rasterDensity/);
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 1.5)).toThrow(/rasterDensity/);
    expect(() => bakeSlot(font, 0, 16, false, codepoints, 256)).toThrow(/rasterDensity/);
  });
});

describe("open contours", () => {
  /**
   * A face whose one glyph is exactly the commands given.
   *
   * The point is the command list, not the face: opentype.js emits no `Z` for
   * either outline format, and a TrueType contour returns to its start point on
   * its own while a CFF contour does not. So the difference between the two
   * formats, as this module sees it, is precisely the presence of that last
   * point — which is what these two paths are.
   */
  const face = (commands: unknown[]): typeof font => {
    const glyph = { advanceWidth: 600, getPath: () => ({ commands }) };
    return {
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      tables: { hhea: { lineGap: 0 } },
      charToGlyphIndex: (ch: string) => (ch === "A" ? 1 : 0),
      glyphs: { get: () => glyph },
    } as unknown as typeof font;
  };

  const SQUARE = [
    { type: "M", x: 2, y: 2 },
    { type: "L", x: 12, y: 2 },
    { type: "L", x: 12, y: 12 },
    { type: "L", x: 2, y: 12 },
  ];
  const CLOSED = [...SQUARE, { type: "L", x: 2, y: 2 }];

  const bake = (commands: unknown[]) => bakeSlot(face(commands), 0, 16, false, [0x41], 1);

  test("bake the same coverage as the closed outline they mean", () => {
    const open = bake(SQUARE);
    const closed = bake(CLOSED);
    expect([...open.bytes]).toEqual([...closed.bytes]);
  });

  test("and that coverage is the filled square, not an empty cell", () => {
    // Without this the assertion above is satisfied by two empty cells.
    const { bytes, glyphCount, coverageW, coverageH } = bake(SQUARE);
    const coverage = bytes.subarray(
      FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE + coverageW * coverageH, // gid 1
    );
    const inked = coverage.filter((sample) => sample > 0).length;
    // 10x10 px of ink, minus antialiasing at the edges; assert the order of
    // magnitude rather than the exact count.
    expect(inked).toBeGreaterThan(80);
    expect(coverage.some((sample) => sample === 255)).toBe(true);
  });
});
