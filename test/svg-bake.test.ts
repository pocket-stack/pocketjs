import { describe, expect, test } from "bun:test";
import { bakeSvg } from "../compiler/bake-svg.ts";

describe("svg bake", () => {
  test("circle edges are supersampled into subpixel alpha", () => {
    const img = bakeSvg(`
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8.25" cy="8" r="5.25" fill="#2563eb" />
      </svg>
    `);
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);

    let edge = 0;
    let solid = 0;
    for (let i = 3; i < img.rgba.length; i += 4) {
      const a = img.rgba[i];
      if (a > 0 && a < 255) edge++;
      if (a === 255) solid++;
    }
    expect(edge).toBeGreaterThan(0);
    expect(solid).toBeGreaterThan(0);
  });
});
