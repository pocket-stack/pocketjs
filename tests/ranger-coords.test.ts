// tests/ranger-coords.test.ts — M1 coordinate acceptance (§2).
//
// Contract: bun test tests/ranger-coords.test.ts
// Pins §2.1 (S=8/15, OX=0, OY=32) via the real sim implementation,
// including the §2.5 verification pins verbatim.
import { describe, expect, test } from "bun:test";
import {
  CONTENT_H,
  CONTENT_W,
  GH,
  GW,
  GX,
  GY,
  INV_GX,
  INV_GY,
  OX,
  OY,
  S_DEN,
  S_NUM,
  toFontPx,
} from "../apps/ranger/sim/fixed.ts";

describe("ranger stage mapping pins (§2.5)", () => {
  test("stage mapping pins", () => {
    expect(GX(0)).toBe(0);
    expect(GX(600)).toBe(320);
    expect(GY(0)).toBe(32);
    expect(GY(330)).toBe(208); // 32+176
    expect(GY(300)).toBe(192); // 원본 지면선 300 → 192
  });
});

describe("ranger scale constants (§2.1)", () => {
  test("uniform scale is exactly 8/15 with letterbox OY=32", () => {
    expect(S_NUM).toBe(8);
    expect(S_DEN).toBe(15);
    expect(OX).toBe(0);
    expect(OY).toBe(32);
    expect(CONTENT_W).toBe(320);
    expect(CONTENT_H).toBe(176);
  });

  test("mapping uses floor only, no rounding mix", () => {
    // floor(1*8/15) = 0, floor(2*8/15) = 1: truncation, never round().
    expect(GX(1)).toBe(0);
    expect(GX(2)).toBe(1);
    expect(GY(1)).toBe(32);
    expect(GY(2)).toBe(33);
  });

  test("size mapping floors with min-1px lift", () => {
    expect(GW(600)).toBe(320);
    expect(GH(330)).toBe(176);
    expect(GW(0)).toBe(0);
    expect(GH(0)).toBe(0);
    // Positive source widths that floor to 0 are lifted to 1 (no 0-px nodes).
    expect(GW(1)).toBe(1);
    expect(GH(1)).toBe(1);
    expect(GW(2)).toBe(1);
  });

  test("inverse mapping round-trips device pins", () => {
    expect(INV_GX(0)).toBe(0);
    expect(INV_GX(320)).toBe(600);
    expect(INV_GY(32)).toBe(0);
    expect(INV_GY(208)).toBe(330);
    // Mapped stage corners land back inside the content box.
    expect(GX(INV_GX(160))).toBeLessThan(321);
    expect(GY(INV_GY(120))).toBeLessThan(209);
  });

  test("font rule floors with an 8px minimum (§2.4)", () => {
    expect(toFontPx(30)).toBe(Math.floor((30 * 8) / 15));
    expect(toFontPx(1)).toBe(8);
    expect(toFontPx(100)).toBeGreaterThanOrEqual(8);
  });
});
