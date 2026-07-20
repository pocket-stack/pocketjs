import { describe, expect, test } from "bun:test";
import { bakeSvg } from "../compiler/bake-svg.ts";
import {
  assertDensityVariantDimensions,
  densityVariantPath,
} from "../compiler/raster-assets.ts";

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

  test("raster density increases pixels without changing SVG coordinates", () => {
    const svg = `
      <svg width="16" height="8" viewBox="0 0 16 8">
        <rect x="2" y="1" width="4" height="3" fill="#2563eb" />
      </svg>
    `;
    const one = bakeSvg(svg);
    const two = bakeSvg(svg, 2);
    expect([one.width, one.height]).toEqual([16, 8]);
    expect([two.width, two.height]).toEqual([32, 16]);

    const alpha = (img: typeof one, x: number, y: number) =>
      img.rgba[(y * img.width + x) * 4 + 3];
    expect(alpha(one, 2, 1)).toBe(255);
    expect(alpha(two, 4, 2)).toBe(255);
    expect(alpha(one, 1, 1)).toBe(0);
    expect(alpha(two, 3, 2)).toBe(0);
  });

  test("rejects invalid raster densities", () => {
    const svg = `<svg width="8" height="8"><rect width="8" height="8" fill="#fff" /></svg>`;
    expect(() => bakeSvg(svg, 0)).toThrow("rasterDensity must be an integer");
    expect(() => bakeSvg(svg, 1.5)).toThrow("rasterDensity must be an integer");
  });
});

describe("PNG density variants", () => {
  test("inserts the density suffix before the extension", () => {
    expect(densityVariantPath("icons/logo.png", 2)).toBe("icons/logo@2x.png");
    expect(densityVariantPath("tiles/overview", 2)).toBe("tiles/overview@2x");
    expect(densityVariantPath("icons/logo.png", 1)).toBe("icons/logo.png");
  });

  test("requires a variant to preserve the base logical dimensions", () => {
    expect(() =>
      assertDensityVariantDimensions(
        { width: 32, height: 16 },
        { width: 64, height: 32 },
        2,
        "logo.png",
        "logo@2x.png",
      )
    ).not.toThrow();
    expect(() =>
      assertDensityVariantDimensions(
        { width: 32, height: 16 },
        { width: 64, height: 31 },
        2,
        "logo.png",
        "logo@2x.png",
      )
    ).toThrow("expected 64x32 for logo.png");
  });
});
