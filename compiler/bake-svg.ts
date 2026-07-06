// compiler/bake-svg.ts — tiny offline SVG rasterizer for baked UI icons.
//
// This is deliberately scoped to the assets we want to ship in pak today:
// pow2-sized SVGs containing filled <circle> and axis-aligned <rect>
// elements, composited in document order. Edges are supersampled before
// being written as straight-alpha RGBA, so icons keep subpixel coverage on
// both the wasm rasterizer and the PSP texture path.
//
// `fill="hole"` on any shape ERASES instead of painting (alpha-subtract with
// the same antialiased coverage) — that is how mask textures are baked, e.g.
// an opaque card with a transparent circle punched out for a circular-reveal
// animation (scale the mask up and the hole grows).

import type { DecodedImage } from "./pak.ts";

export const SVG_SUPERSAMPLE = 4;

interface Circle {
  kind: "circle";
  cx: number;
  cy: number;
  r: number;
  hole: boolean;
  rgba: [number, number, number, number];
}

interface Rect {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  hole: boolean;
  rgba: [number, number, number, number];
}

type Shape = Circle | Rect;

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

/** `fill="hole"`: alpha-subtract by coverage (colors untouched). */
function erase(px: Uint8Array, i: number, cov01: number): void {
  if (cov01 <= 0) return;
  px[i + 3] = Math.round(px[i + 3] * (1 - cov01));
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

  const shapes: Shape[] = [];
  const shapeRe = /<(circle|rect)\b[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = shapeRe.exec(svg))) {
    const a = attrs(m[0]);
    const hole = a.fill === "hole";
    const rgba = hole ? ([0, 0, 0, 255] as [number, number, number, number]) : parseColor(a.fill);
    const op = parseOpacity(a.opacity) * parseOpacity(a["fill-opacity"]);
    rgba[3] = Math.round(rgba[3] * op);
    if (m[1].toLowerCase() === "circle") {
      shapes.push({
        kind: "circle",
        cx: (num(a.cx, "cx") - vbX) * sx,
        cy: (num(a.cy, "cy") - vbY) * sy,
        r: num(a.r, "r") * Math.min(sx, sy),
        hole,
        rgba,
      });
    } else {
      shapes.push({
        kind: "rect",
        x: (num(a.x ?? "0", "x") - vbX) * sx,
        y: (num(a.y ?? "0", "y") - vbY) * sy,
        w: num(a.width, "width") * sx,
        h: num(a.height, "height") * sy,
        hole,
        rgba,
      });
    }
  }
  if (shapes.length === 0) throw new Error("svg bake: no supported shapes");

  const rgba = new Uint8Array(width * height * 4);
  const ss = SVG_SUPERSAMPLE;
  const samples = ss * ss;
  for (const s of shapes) {
    const [bx0, by0, bx1, by1] =
      s.kind === "circle"
        ? [s.cx - s.r - 1, s.cy - s.r - 1, s.cx + s.r + 1, s.cy + s.r + 1]
        : [s.x - 1, s.y - 1, s.x + s.w + 1, s.y + s.h + 1];
    const x0 = Math.max(0, Math.floor(bx0));
    const y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(width, Math.ceil(bx1));
    const y1 = Math.min(height, Math.ceil(by1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let covered = 0;
        if (s.kind === "circle") {
          const rr = s.r * s.r;
          for (let yy = 0; yy < ss; yy++) {
            const py = y + (yy + 0.5) / ss;
            for (let xx = 0; xx < ss; xx++) {
              const px = x + (xx + 0.5) / ss;
              const dx = px - s.cx;
              const dy = py - s.cy;
              if (dx * dx + dy * dy <= rr) covered++;
            }
          }
        } else {
          // Axis-aligned rect: exact analytic pixel coverage.
          const ox = Math.max(0, Math.min(x + 1, s.x + s.w) - Math.max(x, s.x));
          const oy = Math.max(0, Math.min(y + 1, s.y + s.h) - Math.max(y, s.y));
          covered = ox * oy * samples;
        }
        if (covered > 0) {
          const cov01 = covered / samples;
          const i = (y * width + x) * 4;
          if (s.hole) {
            erase(rgba, i, cov01);
          } else {
            sourceOver(rgba, i, s.rgba, (s.rgba[3] / 255) * cov01);
          }
        }
      }
    }
  }

  return { width, height, rgba };
}
