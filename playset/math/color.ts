// playset/math/color.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented from the standard formulas, not copied.
//
// Color management matches three@0.161 defaults: `ColorManagement.enabled`
// is true and the working color space is Linear-sRGB, so `new Color(hex)`,
// `set(hex)`, `setStyle(...)`, `getHex()` and `getHexString()` convert
// through the standard sRGB transfer function exactly like three, while
// `setRGB`/`setHSL`/`getHSL`/`offsetHSL`/`lerp` operate directly in the
// working space. Set `ColorManagement.enabled = false` for raw sRGB
// components (same escape hatch as three).
//
// Scope note: CSS color keywords ('rebeccapurple', ...) are not supported in
// setStyle — no GameBlocks module uses them (hex numbers only). Hex, rgb()/
// rgba() and hsl()/hsla() strings are supported.

import { clamp, euclideanModulo, lerp } from "./math-utils.ts";

export const SRGBColorSpace = "srgb";
export const LinearSRGBColorSpace = "srgb-linear";
export type ColorSpace = typeof SRGBColorSpace | typeof LinearSRGBColorSpace;

export type ColorRepresentation = Color | number | string;

export interface HSL {
  h: number;
  s: number;
  l: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Standard sRGB EOTF: gamma-encoded component → linear. */
export function SRGBToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** Standard sRGB OETF: linear component → gamma-encoded. */
export function LinearToSRGB(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

export const ColorManagement = {
  /** three@0.161 default: color management on. */
  enabled: true,
  workingColorSpace: LinearSRGBColorSpace as ColorSpace,

  convert(color: RGB, sourceColorSpace: ColorSpace, targetColorSpace: ColorSpace): RGB {
    if (
      this.enabled === false ||
      sourceColorSpace === targetColorSpace ||
      !sourceColorSpace ||
      !targetColorSpace
    ) {
      return color;
    }
    const fn = sourceColorSpace === SRGBColorSpace ? SRGBToLinear : LinearToSRGB;
    color.r = fn(color.r);
    color.g = fn(color.g);
    color.b = fn(color.b);
    return color;
  },

  toWorkingColorSpace(color: RGB, sourceColorSpace: ColorSpace): RGB {
    return this.convert(color, sourceColorSpace, this.workingColorSpace);
  },

  fromWorkingColorSpace(color: RGB, targetColorSpace: ColorSpace): RGB {
    return this.convert(color, this.workingColorSpace, targetColorSpace);
  },
};

/** Wikipedia HSL→RGB helper; p is the low value, q the high value. */
function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
  return p;
}

/**
 * An RGB color with components in the working color space (Linear-sRGB by
 * default, matching three). Mutating methods return `this`.
 */
export class Color {
  readonly isColor: true = true;

  r = 1;
  g = 1;
  b = 1;

  constructor(r?: ColorRepresentation, g?: number, b?: number) {
    if (r === undefined) return;
    if (g === undefined || b === undefined) {
      this.set(r);
    } else {
      this.setRGB(r as number, g, b);
    }
  }

  set(color: ColorRepresentation): this;
  set(r: number, g: number, b: number): this;
  set(color: ColorRepresentation, g?: number, b?: number): this {
    if (g !== undefined && b !== undefined) {
      return this.setRGB(color as number, g, b);
    }
    if (typeof color === "object" && color.isColor) {
      return this.copy(color);
    }
    if (typeof color === "number") {
      return this.setHex(color);
    }
    if (typeof color === "string") {
      return this.setStyle(color);
    }
    return this;
  }

  setScalar(scalar: number): this {
    this.r = scalar;
    this.g = scalar;
    this.b = scalar;
    return this;
  }

  setHex(hex: number, colorSpace: ColorSpace = SRGBColorSpace): this {
    hex = Math.floor(hex);
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    ColorManagement.toWorkingColorSpace(this, colorSpace);
    return this;
  }

  setRGB(r: number, g: number, b: number, colorSpace: ColorSpace = ColorManagement.workingColorSpace): this {
    this.r = r;
    this.g = g;
    this.b = b;
    ColorManagement.toWorkingColorSpace(this, colorSpace);
    return this;
  }

  setHSL(h: number, s: number, l: number, colorSpace: ColorSpace = ColorManagement.workingColorSpace): this {
    h = euclideanModulo(h, 1);
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);

    if (s === 0) {
      this.r = this.g = this.b = l;
    } else {
      const q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      this.r = hue2rgb(p, q, h + 1 / 3);
      this.g = hue2rgb(p, q, h);
      this.b = hue2rgb(p, q, h - 1 / 3);
    }

    ColorManagement.toWorkingColorSpace(this, colorSpace);
    return this;
  }

  /**
   * Parses '#rgb'/'#rrggbb' hex strings and rgb()/rgba()/hsl()/hsla()
   * functional notation. CSS color keywords are not supported (see header).
   */
  setStyle(style: string, colorSpace: ColorSpace = SRGBColorSpace): this {
    const fn = /^(\w+)\(([^)]*)\)$/.exec(style.trim());
    if (fn) {
      const name = fn[1]!;
      const components = fn[2]!;
      let m: RegExpExecArray | null;

      switch (name) {
        case "rgb":
        case "rgba":
          m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?$/.exec(components);
          if (m) {
            // rgb(255, 0, 0)
            return this.setRGB(
              Math.min(255, parseInt(m[1]!, 10)) / 255,
              Math.min(255, parseInt(m[2]!, 10)) / 255,
              Math.min(255, parseInt(m[3]!, 10)) / 255,
              colorSpace,
            );
          }
          m = /^\s*(\d+)%\s*,\s*(\d+)%\s*,\s*(\d+)%\s*(?:,\s*[\d.]+\s*)?$/.exec(components);
          if (m) {
            // rgb(100%, 0%, 0%)
            return this.setRGB(
              Math.min(100, parseInt(m[1]!, 10)) / 100,
              Math.min(100, parseInt(m[2]!, 10)) / 100,
              Math.min(100, parseInt(m[3]!, 10)) / 100,
              colorSpace,
            );
          }
          break;
        case "hsl":
        case "hsla":
          m = /^\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?$/.exec(components);
          if (m) {
            // hsl(120, 50%, 50%)
            return this.setHSL(
              parseFloat(m[1]!) / 360,
              parseFloat(m[2]!) / 100,
              parseFloat(m[3]!) / 100,
              colorSpace,
            );
          }
          break;
      }
      return this;
    }

    const hex = /^#([A-Fa-f\d]+)$/.exec(style.trim());
    if (hex) {
      const digits = hex[1]!;
      if (digits.length === 3) {
        // #ff0 shorthand
        return this.setRGB(
          parseInt(digits.charAt(0), 16) / 15,
          parseInt(digits.charAt(1), 16) / 15,
          parseInt(digits.charAt(2), 16) / 15,
          colorSpace,
        );
      }
      if (digits.length === 6) {
        return this.setHex(parseInt(digits, 16), colorSpace);
      }
    }
    return this;
  }

  clone(): Color {
    return new Color().copy(this);
  }

  copy(color: Color): this {
    this.r = color.r;
    this.g = color.g;
    this.b = color.b;
    return this;
  }

  getHex(colorSpace: ColorSpace = SRGBColorSpace): number {
    ColorManagement.fromWorkingColorSpace(_color.copy(this), colorSpace);
    return (
      Math.round(clamp(_color.r * 255, 0, 255)) * 65536 +
      Math.round(clamp(_color.g * 255, 0, 255)) * 256 +
      Math.round(clamp(_color.b * 255, 0, 255))
    );
  }

  getHexString(colorSpace: ColorSpace = SRGBColorSpace): string {
    return ("000000" + this.getHex(colorSpace).toString(16)).slice(-6);
  }

  getHSL(target: HSL, colorSpace: ColorSpace = ColorManagement.workingColorSpace): HSL {
    ColorManagement.fromWorkingColorSpace(_color.copy(this), colorSpace);
    const r = _color.r, g = _color.g, b = _color.b;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let hue = 0;
    let saturation = 0;
    const lightness = (min + max) / 2.0;

    if (min !== max) {
      const delta = max - min;
      saturation = lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
      switch (max) {
        case r:
          hue = (g - b) / delta + (g < b ? 6 : 0);
          break;
        case g:
          hue = (b - r) / delta + 2;
          break;
        case b:
          hue = (r - g) / delta + 4;
          break;
      }
      hue /= 6;
    }

    target.h = hue;
    target.s = saturation;
    target.l = lightness;
    return target;
  }

  getRGB(target: RGB, colorSpace: ColorSpace = ColorManagement.workingColorSpace): RGB {
    ColorManagement.fromWorkingColorSpace(_color.copy(this), colorSpace);
    target.r = _color.r;
    target.g = _color.g;
    target.b = _color.b;
    return target;
  }

  /** Adds the given h/s/l deltas to this color (hue wraps, s/l clamp). */
  offsetHSL(h: number, s: number, l: number): this {
    this.getHSL(_hsl);
    return this.setHSL(_hsl.h + h, _hsl.s + s, _hsl.l + l);
  }

  lerp(color: Color, alpha: number): this {
    this.r += (color.r - this.r) * alpha;
    this.g += (color.g - this.g) * alpha;
    this.b += (color.b - this.b) * alpha;
    return this;
  }

  lerpColors(color1: Color, color2: Color, alpha: number): this {
    this.r = lerp(color1.r, color2.r, alpha);
    this.g = lerp(color1.g, color2.g, alpha);
    this.b = lerp(color1.b, color2.b, alpha);
    return this;
  }

  multiplyScalar(s: number): this {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }

  equals(c: Color): boolean {
    return c.r === this.r && c.g === this.g && c.b === this.b;
  }
}

// Module-level scratch temporaries (three's own pattern).
const _color = /*@__PURE__*/ new Color();
const _hsl: HSL = { h: 0, s: 0, l: 0 };
