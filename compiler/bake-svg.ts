// compiler/bake-svg.ts — tiny offline SVG rasterizer for baked UI icons.
//
// This is deliberately scoped to the assets we want to ship in dcpak today:
// pow2-sized SVGs containing filled <circle> elements. Edges are supersampled
// before being written as straight-alpha RGBA, so icons keep subpixel coverage
// on both the wasm rasterizer and the PSP texture path.

import type { DecodedImage } from "./dcpak.ts";

export const SVG_SUPERSAMPLE = 4;

interface Circle {
  cx: number;
  cy: number;
  r: number;
  rgba: [number, number, number, number];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = m[2] ?? m[3] ?? "";
  return out;
}

function num(v: string | undefined, name: string): number {
  if (v === undefined) throw new Error(`svg bake: missing ${name}`);
  const n = Number(v.replace(/px$/, ""));
  if (!Number.isFinite(n)) throw new Error(`svg bake: invalid ${name}="${v}"`);
  return n;
}

function parseColor(value: string | undefined): [number, number, number, number] {
  const s = value ?? "#000000";
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return [
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
      parseInt(s[3] + s[3], 16),
      255,
    ];
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    return [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
      s.length === 9 ? parseInt(s.slice(7, 9), 16) : 255,
    ];
  }
  throw new Error(`svg bake: unsupported fill "${s}"`);
}

function parseOpacity(v: string | undefined): number {
  if (v === undefined) return 1;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`svg bake: invalid opacity="${v}"`);
  return Math.max(0, Math.min(1, n));
}

function sourceOver(px: Uint8Array, i: number, src: [number, number, number, number], srcA01: number): void {
  if (srcA01 <= 0) return;
  const dstA01 = px[i + 3] / 255;
  const outA = srcA01 + dstA01 * (1 - srcA01);
  if (outA <= 0) return;
  px[i] = Math.round((src[0] * srcA01 + px[i] * dstA01 * (1 - srcA01)) / outA);
  px[i + 1] = Math.round((src[1] * srcA01 + px[i + 1] * dstA01 * (1 - srcA01)) / outA);
  px[i + 2] = Math.round((src[2] * srcA01 + px[i + 2] * dstA01 * (1 - srcA01)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

export function bakeSvg(svg: string): DecodedImage {
  const svgTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!svgTag) throw new Error("svg bake: missing <svg>");
  const root = attrs(svgTag);
  const width = Math.round(num(root.width, "width"));
  const height = Math.round(num(root.height, "height"));
  if (width <= 0 || height <= 0) throw new Error(`svg bake: bad dimensions ${width}x${height}`);
  const viewBox = (root.viewBox ?? `0 0 ${width} ${height}`).trim().split(/\s+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) {
    throw new Error(`svg bake: invalid viewBox="${root.viewBox}"`);
  }
  const [vbX, vbY, vbW, vbH] = viewBox;
  const sx = width / vbW;
  const sy = height / vbH;

  const circles: Circle[] = [];
  const circleRe = /<circle\b[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = circleRe.exec(svg))) {
    const a = attrs(m[0]);
    const rgba = parseColor(a.fill);
    const op = parseOpacity(a.opacity) * parseOpacity(a["fill-opacity"]);
    rgba[3] = Math.round(rgba[3] * op);
    circles.push({
      cx: (num(a.cx, "cx") - vbX) * sx,
      cy: (num(a.cy, "cy") - vbY) * sy,
      r: num(a.r, "r") * Math.min(sx, sy),
      rgba,
    });
  }
  if (circles.length === 0) throw new Error("svg bake: no supported shapes");

  const rgba = new Uint8Array(width * height * 4);
  const ss = SVG_SUPERSAMPLE;
  const samples = ss * ss;
  for (const c of circles) {
    const x0 = Math.max(0, Math.floor(c.cx - c.r - 1));
    const y0 = Math.max(0, Math.floor(c.cy - c.r - 1));
    const x1 = Math.min(width, Math.ceil(c.cx + c.r + 1));
    const y1 = Math.min(height, Math.ceil(c.cy + c.r + 1));
    const rr = c.r * c.r;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let covered = 0;
        for (let yy = 0; yy < ss; yy++) {
          const py = y + (yy + 0.5) / ss;
          for (let xx = 0; xx < ss; xx++) {
            const px = x + (xx + 0.5) / ss;
            const dx = px - c.cx;
            const dy = py - c.cy;
            if (dx * dx + dy * dy <= rr) covered++;
          }
        }
        if (covered > 0) {
          sourceOver(rgba, (y * width + x) * 4, c.rgba, (c.rgba[3] / 255) * (covered / samples));
        }
      }
    }
  }

  return { width, height, rgba };
}
