import { describe, expect, test } from "bun:test";
import { parse as parseFont } from "opentype.js";
import { bakeSlot, DEFAULT_REGULAR } from "../compiler/bake-font.ts";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
} from "../spec/spec.ts";

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
