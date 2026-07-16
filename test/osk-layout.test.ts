// test/osk-layout.test.ts — the system keyboard's pure geometry:
// LVGL-style variable-width rows, spatial d-pad navigation, touch mapping.
// Rendering, navigation and touch all consume these same numbers, so this
// is where "the keyboard makes sense" is provable without booting a world.

import { describe, expect, test } from "bun:test";
import {
  clampPos,
  keyAtPoint,
  layoutRows,
  navigate,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_PAD,
  OSK_ROW_H,
  type OskKeyRect,
  type OskLayerName,
} from "../src/osk-layout.ts";
import { SCREEN_W } from "../spec/spec.ts";

const INNER_W = SCREEN_W - 2 * OSK_PAD;
const LAYERS = Object.keys(OSK_LAYERS) as OskLayerName[];

const label = (k: OskKeyRect): string => k.key.label ?? k.key.ch ?? "";
const find = (rows: OskKeyRect[][], want: string): OskKeyRect => {
  for (const row of rows) for (const k of row) if ((k.key.ch ?? k.key.label) === want) return k;
  throw new Error(`no key ${JSON.stringify(want)}`);
};

describe("geometry", () => {
  test("every row of every layer spans exactly the panel width", () => {
    for (const name of LAYERS) {
      const rows = layoutRows(OSK_LAYERS[name], INNER_W);
      for (const row of rows) {
        const last = row[row.length - 1];
        expect(row[0].x).toBe(0);
        expect(last.x + last.w).toBe(INNER_W);
        for (const k of row) expect(k.w).toBeGreaterThan(10);
        for (let c = 1; c < row.length; c++) {
          expect(row[c].x).toBe(row[c - 1].x + row[c - 1].w + OSK_GAP);
        }
      }
    }
  });

  test("panel height covers four rows", () => {
    expect(OSK_H).toBe(4 * OSK_ROW_H + 3 * OSK_GAP + 2 * OSK_PAD);
  });

  test("special keys are wider than letters (the LVGL look)", () => {
    const rows = layoutRows(OSK_LAYERS.lower, INNER_W);
    const q = find(rows, "q");
    expect(rows[0][0].w).toBeGreaterThan(q.w); //     1#
    expect(rows[1][0].w).toBeGreaterThan(q.w); //     ABC
    expect(find(rows, " ").w).toBeGreaterThan(3 * q.w); // space bar
  });
});

describe("navigation", () => {
  const rows = layoutRows(OSK_LAYERS.lower, INNER_W);

  test("left/right wrap within the row", () => {
    const q = find(rows, "q");
    expect(navigate(rows, { row: 0, col: q.col }, "left")).toEqual({ row: 0, col: 0 });
    expect(navigate(rows, { row: 0, col: 0 }, "left")).toEqual({ row: 0, col: rows[0].length - 1 });
    expect(navigate(rows, { row: 0, col: rows[0].length - 1 }, "right")).toEqual({ row: 0, col: 0 });
  });

  test("up/down clamp at the panel edges", () => {
    expect(navigate(rows, { row: 0, col: 3 }, "up")).toEqual({ row: 0, col: 3 });
    expect(navigate(rows, { row: 3, col: 2 }, "down")).toEqual({ row: 3, col: 2 });
  });

  test("down picks the key under the current one, not a column index", () => {
    // 'q' sits over 'a' even though their column indices differ per row.
    const q = find(rows, "q");
    const down = navigate(rows, { row: q.row, col: q.col }, "down");
    expect(label(rows[down.row][down.col])).toBe("a");
    // The wide space bar catches most of row 3.
    const v = find(rows, "v");
    const toSpace = navigate(rows, { row: v.row, col: v.col }, "down");
    expect(rows[toSpace.row][toSpace.col].key.ch).toBe(" ");
  });

  test("up from the space bar returns to a middle letter", () => {
    const sp = find(rows, " ");
    const up = navigate(rows, { row: sp.row, col: sp.col }, "up");
    expect("zxcvbnm".includes(label(rows[up.row][up.col]))).toBe(true);
  });

  test("every key of every layer is reachable from 'q' by d-pad", () => {
    for (const name of LAYERS) {
      const r = layoutRows(OSK_LAYERS[name], INNER_W);
      const seen = new Set<string>();
      const queue = [{ row: 0, col: 1 }];
      while (queue.length) {
        const pos = queue.shift()!;
        const id = `${pos.row}:${pos.col}`;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const d of ["up", "down", "left", "right"] as const) queue.push(navigate(r, pos, d));
      }
      const total = r.reduce((n, row) => n + row.length, 0);
      expect(seen.size).toBe(total);
    }
  });

  test("clampPos survives layer switches", () => {
    const symbols = layoutRows(OSK_LAYERS.symbols, INNER_W);
    const p = clampPos(symbols, { row: 1, col: 10 }); // lower r1 has 11 keys, symbols r1 has 10
    expect(p.row).toBe(1);
    expect(p.col).toBe(symbols[1].length - 1);
  });
});

describe("touch mapping", () => {
  const rows = layoutRows(OSK_LAYERS.lower, INNER_W);

  test("the center of every key resolves to that key", () => {
    for (const row of rows) {
      for (const k of row) {
        const pos = keyAtPoint(rows, k.x + k.w / 2, k.row * (OSK_ROW_H + OSK_GAP) + OSK_ROW_H / 2);
        expect(pos).toEqual({ row: k.row, col: k.col });
      }
    }
  });

  test("a touch in the gap snaps to the nearest key; far misses are null", () => {
    const q = find(rows, "q");
    const inGap = keyAtPoint(rows, q.x - OSK_GAP / 2, OSK_ROW_H / 2);
    expect(inGap === null || inGap.row === 0).toBe(true);
    expect(keyAtPoint(rows, 40, -30)).toBeNull();
    expect(keyAtPoint(rows, 40, 4 * (OSK_ROW_H + OSK_GAP) + 20)).toBeNull();
  });
});
