// vapor/compiler/styles.ts — the Pocket Vapor style DSL.
//
// Rows declare their look with the same Tailwind vocabulary the big
// framework compiles (framework/compiler/tailwind.ts owns the color table;
// this module imports it, so `text-emerald-500` means the same thing on a
// PSP View and on a NES row). The subset for cell-grid targets:
//
//   bg-<color>      paper (cell background)     bg-slate-900, bg-[#101423]
//   text-<color>    ink   (glyph color)         text-white, text-emerald-400
//   align-left|center|right                     content placement in the row
//
// Styling compiles the same way everything in Pocket Vapor compiles — to
// data. Every distinct (ink, paper) pair the app uses becomes one entry in
// the app's PAIR TABLE; the pal byte in the cell grid is the pair id on
// every target. What a pair id MEANS is the target's style contract:
//
//   gba      "rgb555" pair id = BG palette bank (ink/paper BGR555), <= 15 pairs
//   esp32    "rgb565" pair id = direct ink/paper RGB565 table index
//   gb/nes/
//   playdate "styles2" pair id -> glyph style by luminance (dark-on-light /
//            light-on-dark); collapsing distinct pairs warns, or errors in --strict
//
// The oracle (real Vue in a browser/bun) renders the same classes with the
// full-color web contract — degradation is visible by flipping targets.

import { paletteColor } from "../../framework/compiler/tailwind.ts";

export type Align = 0 | 1 | 2; // left, center, right

export interface RowStyle {
  ink: number; // 0xRRGGBB
  paper: number; // 0xRRGGBB
  align: Align;
}

export interface StyleIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
}

/** The app-wide backdrop (also the default paper). */
export const BACKDROP = 0x101423; // deep navy
export const DEFAULT_INK = 0xe6edf3; // near-white

/** abgr u32 (framework encoding) -> 0xRRGGBB. */
function abgrToRgb(abgr: number): number {
  const r = abgr & 0xff;
  const g = (abgr >> 8) & 0xff;
  const b = (abgr >> 16) & 0xff;
  return (r << 16) | (g << 8) | b;
}

function parseColor(token: string): number | null {
  const arbitrary = /^\[#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\]$/.exec(token);
  if (arbitrary) {
    let h = arbitrary[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return parseInt(h, 16);
  }
  if (token === "transparent") return BACKDROP; // cells are opaque; transparent = backdrop
  const abgr = paletteColor(token);
  return abgr === null ? null : abgrToRgb(abgr);
}

/** Parse one class string into a RowStyle (+ issues for unknown tokens). */
export function parseRowClass(cls: string): { style: RowStyle; issues: StyleIssue[] } {
  const style: RowStyle = { ink: DEFAULT_INK, paper: BACKDROP, align: 0 };
  const issues: StyleIssue[] = [];
  for (const token of cls.trim().split(/\s+/)) {
    if (!token) continue;
    if (token === "align-left") style.align = 0;
    else if (token === "align-center") style.align = 1;
    else if (token === "align-right") style.align = 2;
    else if (token.startsWith("bg-")) {
      const rgb = parseColor(token.slice(3));
      if (rgb === null) issues.push({ code: "VS102", severity: "error", message: `unknown color in "${token}"` });
      else style.paper = rgb;
    } else if (token.startsWith("text-")) {
      const rgb = parseColor(token.slice(5));
      if (rgb === null) issues.push({ code: "VS102", severity: "error", message: `unknown color in "${token}"` });
      else style.ink = rgb;
    } else {
      issues.push({
        code: "VS101",
        severity: "error",
        message: `unknown class "${token}" (cell targets support bg-*, text-*, align-*)`,
      });
    }
  }
  return { style, issues };
}

// ---------------------------------------------------------------------------
// Pair table + per-target lowering
// ---------------------------------------------------------------------------

export interface StylePair {
  ink: number;
  paper: number;
  /** first class string that produced this pair (for diagnostics) */
  from: string;
}

export interface TargetStyleCaps {
  kind: "rgb555" | "rgb565" | "styles2" | "web";
  /** Palette-backed targets: how many (ink, paper) pairs exist. */
  maxPairs?: number;
}

export const STYLE_CAPS: Record<string, TargetStyleCaps> = {
  gba: { kind: "rgb555", maxPairs: 15 },
  esp32: { kind: "rgb565", maxPairs: 256 },
  gb: { kind: "styles2" },
  nes: { kind: "styles2" },
  playdate: { kind: "styles2" },
  web: { kind: "web" },
};

function luminance(rgb: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** styles2 contract: style 0 = dark ink on light paper, 1 = light on dark. */
export function styleOfPair(pair: { ink: number; paper: number }): 0 | 1 {
  return luminance(pair.ink) < luminance(pair.paper) ? 0 : 1;
}

export function rgb555(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) >> 3;
  const g = ((rgb >> 8) & 0xff) >> 3;
  const b = (rgb & 0xff) >> 3;
  return r | (g << 5) | (b << 10);
}

/** Conventional RGB565 word: RRRRRGGGGGGBBBBB. */
export function rgb565(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) >> 3;
  const g = ((rgb >> 8) & 0xff) >> 2;
  const b = (rgb & 0xff) >> 3;
  return (r << 11) | (g << 5) | b;
}

export class StyleTable {
  pairs: StylePair[] = [];
  /** every class literal the app used -> its pair id + align (manifest) */
  byClass = new Map<string, { id: number; align: Align }>();

  constructor() {
    // pair 0 is the default look (vp_row_clear paints with it)
    this.pairs.push({ ink: DEFAULT_INK, paper: BACKDROP, from: "(default)" });
    this.byClass.set("", { id: 0, align: 0 });
  }

  intern(style: RowStyle, from: string): number {
    const hit = this.pairs.findIndex((p) => p.ink === style.ink && p.paper === style.paper);
    if (hit >= 0) return hit;
    this.pairs.push({ ink: style.ink, paper: style.paper, from });
    return this.pairs.length - 1;
  }

  /** Parse + intern one class literal; the manifest remembers the mapping. */
  resolveClass(cls: string): { id: number; align: Align; issues: StyleIssue[] } {
    const key = cls.trim().replace(/\s+/g, " ");
    const hit = this.byClass.get(key);
    if (hit) return { ...hit, issues: [] };
    const { style, issues } = parseRowClass(key);
    const id = this.intern(style, key);
    this.byClass.set(key, { id, align: style.align });
    return { id, align: style.align, issues };
  }

  /** JSON manifest for hosts/painters: class string -> {id, align}. */
  manifest(): Record<string, { id: number; align: Align }> {
    return Object.fromEntries(this.byClass);
  }

  /** Lower the table for one target; returns issues instead of throwing. */
  lower(target: string, strict = false): {
    /** pair id -> glyph style (styles2) or palette/table id (RGB — identity) */
    styleMap: number[];
    issues: StyleIssue[];
  } {
    const caps = STYLE_CAPS[target] ?? STYLE_CAPS.web;
    const issues: StyleIssue[] = [];
    if (caps.kind === "rgb555" || caps.kind === "rgb565") {
      if (caps.maxPairs !== undefined && this.pairs.length > caps.maxPairs) {
        issues.push({
          code: "VS103",
          severity: "error",
          message:
            `${target}: app uses ${this.pairs.length} (ink,paper) pairs; the target has ` +
            `${caps.maxPairs} palette banks. First over-budget class: "${this.pairs[caps.maxPairs].from}"`,
        });
      }
      return { styleMap: this.pairs.map((_, i) => i), issues };
    }
    if (caps.kind === "styles2") {
      const styleMap = this.pairs.map((p) => styleOfPair(p));
      // report collapses: distinct pairs that became indistinguishable
      const byStyle: number[][] = [[], []];
      this.pairs.forEach((_, i) => byStyle[styleMap[i]].push(i));
      for (const group of byStyle) {
        if (group.length > 1) {
          const names = group.map((i) => `"${this.pairs[i].from}"`).join(", ");
          issues.push({
            code: "VS104",
            severity: strict ? "error" : "warn",
            message:
              `${target}: ${group.length} distinct color pairs render as the same glyph style ` +
              `(2-style target): ${names}`,
          });
        }
      }
      return { styleMap, issues };
    }
    return { styleMap: this.pairs.map((_, i) => i), issues };
  }
}

/** CSS for the web/dev-host rendering of one target's view of the table. */
export function styleTableCss(table: StyleTable, target: string): string {
  const caps = STYLE_CAPS[target] ?? STYLE_CAPS.web;
  const lines: string[] = [];
  const css = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;
  table.pairs.forEach((pair, id) => {
    let ink = pair.ink;
    let paper = pair.paper;
    if (caps.kind === "rgb555") {
      // round through BGR555 so the preview shows what the GBA shows
      const q = (v: number) => {
        const c = rgb555(v);
        const r = (c & 31) << 3;
        const g = ((c >> 5) & 31) << 3;
        const b = ((c >> 10) & 31) << 3;
        return (r << 16) | (g << 8) | b;
      };
      ink = q(ink);
      paper = q(paper);
    } else if (caps.kind === "rgb565") {
      // round through RGB565 so the preview shows what the ESP32 shows
      const q = (v: number) => {
        const c = rgb565(v);
        const r = ((c >> 11) & 31) << 3;
        const g = ((c >> 5) & 63) << 2;
        const b = (c & 31) << 3;
        return (r << 16) | (g << 8) | b;
      };
      ink = q(ink);
      paper = q(paper);
    } else if (caps.kind === "styles2") {
      // Match the target's two-style display: Playdate is pure 1-bit while
      // GB keeps the familiar DMG green preview.
      const s = styleOfPair(pair);
      if (target === "playdate") {
        ink = s === 0 ? 0x000000 : 0xffffff;
        paper = s === 0 ? 0xffffff : 0x000000;
      } else {
        ink = s === 0 ? 0x0f380f : 0x9bbc0f;
        paper = s === 0 ? 0x9bbc0f : 0x0f380f;
      }
    }
    lines.push(`row[data-pal="${id}"] { color: ${css(ink)}; background: ${css(paper)}; }`);
  });
  return lines.join("\n");
}
