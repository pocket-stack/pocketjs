// System on-screen-keyboard layout model (@pocketjs/framework/osk).
//
// Pure data + math, no components: the key grid is LVGL-style — rows of
// variable-width keys measured in relative units, normalized per row so
// every row spans the full panel width. Because the panel computes its own
// pixel geometry (the JS side has no layout read-back), the same numbers
// drive rendering, d-pad spatial navigation and touch hit-testing, and they
// can never disagree.
//
// Every typable glyph below is a source literal on purpose: the build's
// font bake harvests codepoints from literals across the module graph, so
// importing the OSK is what guarantees its keys can render.

/** Non-typing key behaviors. Keys with `ch` set simply insert it. */
export type OskAction =
  | "shift" // lower <-> upper
  | "layer" // letters <-> symbols
  | "backspace"
  | "enter" // commit (↵ and ✓ both)
  | "left" // caret left
  | "right" // caret right
  | "hide"; // cancel/close

export interface OskKeyDef {
  /** Literal text this key inserts (typing keys). */
  ch?: string;
  action?: OskAction;
  /** Key-cap label; defaults to `ch`. */
  label?: string;
  /** Relative width in row units (normalized per row). */
  w: number;
}

export type OskLayerName = "lower" | "upper" | "symbols";

// ---------------------------------------------------------------------------
// Panel metrics (logical pixels, 480-wide screens)
// ---------------------------------------------------------------------------

export const OSK_ROW_H = 18;
export const OSK_GAP = 4;
export const OSK_PAD = 4;
/** Docked panel height: 4 rows + 3 gaps + padding. */
export const OSK_H = 4 * OSK_ROW_H + 3 * OSK_GAP + 2 * OSK_PAD; // 92

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const chars = (s: string): OskKeyDef[] => [...s].map((ch) => ({ ch, w: 1 }));

/** Bottom row, LVGL-style: hide · caret-left · space · caret-right · OK. */
const BOTTOM: OskKeyDef[] = [
  { action: "hide", label: "▼", w: 1.5 },
  { action: "left", label: "‹", w: 1.5 },
  { ch: " ", label: "", w: 7 },
  { action: "right", label: "›", w: 1.5 },
  { action: "enter", label: "✓", w: 1.5 },
];

export const OSK_LAYERS: Record<OskLayerName, OskKeyDef[][]> = {
  lower: [
    [{ action: "layer", label: "1#", w: 1.5 }, ...chars("qwertyuiop"), { action: "backspace", label: "⌫", w: 1.5 }],
    [{ action: "shift", label: "ABC", w: 2 }, ...chars("asdfghjkl"), { action: "enter", label: "↵", w: 2 }],
    chars("_-zxcvbnm.,:"),
    BOTTOM,
  ],
  upper: [
    [{ action: "layer", label: "1#", w: 1.5 }, ...chars("QWERTYUIOP"), { action: "backspace", label: "⌫", w: 1.5 }],
    [{ action: "shift", label: "abc", w: 2 }, ...chars("ASDFGHJKL"), { action: "enter", label: "↵", w: 2 }],
    chars("_-ZXCVBNM.,:"),
    BOTTOM,
  ],
  symbols: [
    [{ action: "layer", label: "abc", w: 1.5 }, ...chars("1234567890"), { action: "backspace", label: "⌫", w: 1.5 }],
    [...chars("+-*/=%!?@"), { action: "enter", label: "↵", w: 2 }],
    chars("#()[]'\";&$,."),
    BOTTOM,
  ],
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface OskKeyRect {
  key: OskKeyDef;
  row: number;
  col: number;
  /** Pixel offset inside the row (0 = row left edge). */
  x: number;
  w: number;
}

/**
 * Normalize one layer into per-key pixel rects for an `innerW`-wide row box.
 * Cumulative rounding: key edges land on round(prefix-units share), so the
 * widths always sum exactly to `innerW` with no 1-px drift.
 */
export function layoutRows(layer: readonly OskKeyDef[][], innerW: number, gap: number = OSK_GAP): OskKeyRect[][] {
  return layer.map((row, r) => {
    const units = row.reduce((sum, k) => sum + k.w, 0);
    const keyPx = innerW - gap * (row.length - 1);
    const rects: OskKeyRect[] = [];
    let prefix = 0;
    let left = 0;
    for (let c = 0; c < row.length; c++) {
      const right = Math.round(((prefix + row[c].w) / units) * keyPx);
      rects.push({ key: row[c], row: r, col: c, x: left + c * gap, w: right - left });
      prefix += row[c].w;
      left = right;
    }
    return rects;
  });
}

export interface OskPos {
  row: number;
  col: number;
}

/** Clamp a (row, col) into a layer's shape — used across layer switches. */
export function clampPos(rows: readonly OskKeyRect[][], pos: OskPos): OskPos {
  const row = Math.max(0, Math.min(pos.row, rows.length - 1));
  const col = Math.max(0, Math.min(pos.col, rows[row].length - 1));
  return { row, col };
}

/**
 * Spatial d-pad navigation over variable-width rows: left/right wrap within
 * the row; up/down clamp at the edges and pick the key in the adjacent row
 * with the largest horizontal overlap (nearest center on ties/no overlap).
 */
export function navigate(
  rows: readonly OskKeyRect[][],
  pos: OskPos,
  direction: "up" | "down" | "left" | "right",
): OskPos {
  const { row, col } = clampPos(rows, pos);
  if (direction === "left" || direction === "right") {
    const n = rows[row].length;
    const d = direction === "right" ? 1 : -1;
    return { row, col: (col + d + n) % n };
  }
  const target = row + (direction === "down" ? 1 : -1);
  if (target < 0 || target >= rows.length) return { row, col };
  const cur = rows[row][col];
  const c0 = cur.x;
  const c1 = cur.x + cur.w;
  const center = (c0 + c1) / 2;
  let best = 0;
  let bestOverlap = -1;
  let bestDist = Infinity;
  for (let c = 0; c < rows[target].length; c++) {
    const k = rows[target][c];
    const overlap = Math.min(c1, k.x + k.w) - Math.max(c0, k.x);
    const dist = Math.abs((k.x + k.w / 2) - center);
    if (overlap > bestOverlap || (overlap === bestOverlap && dist < bestDist)) {
      best = c;
      bestOverlap = overlap;
      bestDist = dist;
    }
  }
  return { row: target, col: best };
}

/**
 * Point -> key for touch input. `x`/`y` are panel-content coordinates (the
 * caller subtracts the panel origin and OSK_PAD). Forgiving in x — a touch
 * in a gap resolves to the nearest key of the row; strict in y only across
 * the panel bounds.
 */
export function keyAtPoint(
  rows: readonly OskKeyRect[][],
  x: number,
  y: number,
  rowH: number = OSK_ROW_H,
  gap: number = OSK_GAP,
): OskPos | null {
  if (y < 0) return null;
  const row = Math.min(rows.length - 1, Math.floor(y / (rowH + gap)));
  if (y > row * (rowH + gap) + rowH + gap / 2) return null; // below the last row
  let best: OskPos | null = null;
  let bestDist = Infinity;
  for (let c = 0; c < rows[row].length; c++) {
    const k = rows[row][c];
    const dist = x < k.x ? k.x - x : x > k.x + k.w ? x - (k.x + k.w) : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = { row, col: c };
    }
  }
  return bestDist < 8 ? best : null;
}
