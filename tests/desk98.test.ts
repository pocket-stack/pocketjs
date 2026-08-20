// tests/desk98.test.ts — PocketJS 98: window-manager chrome math, the
// Minesweeper rules, Notepad line editing and the selection model (all
// pure). The sim boot smoke lives in tests/desk98-sim.test.ts (needs the
// vue-vapor bundle prebuilt).

import { describe, expect, test } from "bun:test";
import {
  captionButtonXs,
  clampMove,
  contentTop,
  cursorForDir,
  hitRegion,
  maximizedGeo,
  resizeGeo,
  type ChromeOpts,
  type Geo,
} from "../apps/desk98/wm.ts";
import {
  MINES_N,
  MINES_W,
  newMines,
  reveal,
  toggleFlag,
} from "../apps/desk98/mines.ts";
import {
  applyMove,
  backspace,
  colFromX,
  del,
  deleteSel,
  hasSel,
  insertText,
  moveCaret,
  rowSelSpan,
  selectAll,
  selectedText,
  selRange,
  wordRangeAt,
  type Doc,
} from "../apps/desk98/notepad.ts";

// ---------------------------------------------------------------------------
// wm.ts — chrome hit regions
// ---------------------------------------------------------------------------

const GEO: Geo = { x: 100, y: 50, w: 400, h: 300 };
const OPTS: ChromeOpts = {
  buttons: ["min", "max", "close"],
  resizable: true,
  maximized: false,
  menuWidths: [34, 34],
};

describe("caption buttons", () => {
  test("all three buttons sit flush against each other, flush right", () => {
    const xs = captionButtonXs(400, ["min", "max", "close"]);
    // close right edge at w - FRAME(3) - 2.
    expect(xs[2] + 16).toBe(400 - 3 - 2);
    expect(xs[1]).toBe(xs[2] - 16); // no close gap
    expect(xs[0]).toBe(xs[1] - 16);
  });

  test("close-only dialogs place the single button flush right", () => {
    const xs = captionButtonXs(300, ["close"]);
    expect(xs).toEqual([300 - 3 - 2 - 16]);
  });
});

describe("hitRegion", () => {
  test("caption bar drags, buttons claim their cells", () => {
    // Caption strip, left of the buttons.
    expect(hitRegion(GEO, OPTS, 100 + 200, 50 + 10)).toEqual({ kind: "caption" });
    const xs = captionButtonXs(GEO.w, OPTS.buttons);
    for (const [i, name] of (["min", "max", "close"] as const).entries()) {
      const r = hitRegion(GEO, OPTS, 100 + xs[i] + 8, 50 + 3 + 2 + 7);
      expect(r).toEqual({ kind: "button", button: name });
    }
  });

  test("resize bands claim edges and corners with the right directions", () => {
    expect(hitRegion(GEO, OPTS, 100 + 200, 50 + 1)).toEqual({ kind: "resize", dir: "n" });
    expect(hitRegion(GEO, OPTS, 100 + 1, 50 + 150)).toEqual({ kind: "resize", dir: "w" });
    expect(hitRegion(GEO, OPTS, 100 + 399, 50 + 299)).toEqual({ kind: "resize", dir: "se" });
    expect(hitRegion(GEO, OPTS, 100 + 1, 50 + 299)).toEqual({ kind: "resize", dir: "sw" });
    expect(hitRegion(GEO, OPTS, 100 + 399, 50 + 1)).toEqual({ kind: "resize", dir: "ne" });
  });

  test("maximized and fixed windows expose no resize bands", () => {
    const max = { ...OPTS, maximized: true };
    expect(hitRegion(GEO, max, 100 + 200, 50 + 1)).toEqual({ kind: "caption" });
    const fixed = { ...OPTS, resizable: false };
    expect(hitRegion(GEO, fixed, 100 + 399, 50 + 299)).not.toEqual({
      kind: "resize",
      dir: "se",
    });
  });

  test("menu bar items hit by accumulated widths, content below them", () => {
    const menuY = 50 + 3 + 18 + 1 + 9;
    expect(hitRegion(GEO, OPTS, 100 + 3 + 10, menuY)).toEqual({ kind: "menu", index: 0 });
    expect(hitRegion(GEO, OPTS, 100 + 3 + 34 + 10, menuY)).toEqual({ kind: "menu", index: 1 });
    const r = hitRegion(GEO, OPTS, 100 + 50, 50 + contentTop(OPTS) + 20);
    expect(r).toEqual({ kind: "content", cx: 47, cy: 20 });
  });

  test("outside the window misses", () => {
    expect(hitRegion(GEO, OPTS, 99, 60)).toBeNull();
    expect(hitRegion(GEO, OPTS, 100 + 400, 60)).toBeNull();
  });
});

describe("resizeGeo", () => {
  const orig: Geo = { x: 100, y: 50, w: 400, h: 300 };
  test("east/south follow the pointer, west/north anchor the far edge", () => {
    expect(resizeGeo(orig, "se", 40, 30, 200, 120)).toEqual({ x: 100, y: 50, w: 440, h: 330 });
    const west = resizeGeo(orig, "w", 60, 0, 200, 120);
    expect(west.w).toBe(340);
    expect(west.x + west.w).toBe(orig.x + orig.w); // right edge pinned
    const north = resizeGeo(orig, "n", 0, -20, 200, 120);
    expect(north.h).toBe(320);
    expect(north.y + north.h).toBe(orig.y + orig.h);
  });

  test("minimums hold on every edge", () => {
    const tiny = resizeGeo(orig, "se", -1000, -1000, 200, 120);
    expect(tiny.w).toBe(200);
    expect(tiny.h).toBe(120);
    const wTiny = resizeGeo(orig, "nw", 1000, 1000, 200, 120);
    expect(wTiny.w).toBe(200);
    expect(wTiny.h).toBe(120);
    expect(wTiny.x + wTiny.w).toBe(orig.x + orig.w);
    expect(wTiny.y + wTiny.h).toBe(orig.y + orig.h);
  });
});

describe("clampMove / maximizedGeo", () => {
  test("the caption always stays reachable", () => {
    const g = clampMove({ x: -1000, y: -50, w: 400, h: 300 }, 800, 600);
    expect(g.x).toBe(48 - 400);
    expect(g.y).toBe(0);
    const low = clampMove({ x: 790, y: 590, w: 400, h: 300 }, 800, 600);
    expect(low.x).toBe(800 - 48);
    expect(low.y).toBe(600 - 28 - 18);
  });

  test("maximized fills the desktop above the taskbar", () => {
    expect(maximizedGeo(800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 572 });
  });

  test("resize cursor kinds", () => {
    expect(cursorForDir("e")).toBe("ew");
    expect(cursorForDir("n")).toBe("ns");
    expect(cursorForDir("se")).toBe("nwse");
    expect(cursorForDir("sw")).toBe("nesw");
  });
});

// ---------------------------------------------------------------------------
// mines.ts
// ---------------------------------------------------------------------------

describe("minesweeper", () => {
  test("first reveal is always safe and plants exactly ten mines", () => {
    for (const seed of [1, 42, 1234, 987654]) {
      const m = reveal(newMines(seed), 40);
      expect(m.phase === "lost").toBe(false);
      expect(m.cells.filter((c) => c.mine).length).toBe(MINES_N);
      expect(m.cells[40].mine).toBe(false);
      expect(m.cells[40].state).toBe("revealed");
    }
  });

  test("zero-adjacency regions flood open", () => {
    // Find a seed/cell whose reveal floods more than one cell.
    const m = newMines(7);
    reveal(m, 0);
    if (m.cells[0].adj === 0) {
      expect(m.revealed).toBeGreaterThan(1);
    }
    // Whatever the layout, revealed count matches cells marked revealed.
    expect(m.cells.filter((c) => c.state === "revealed").length).toBe(m.revealed);
  });

  test("flags toggle and never reveal", () => {
    const m = reveal(newMines(3), 0);
    const hidden = m.cells.findIndex((c) => c.state === "hidden");
    toggleFlag(m, hidden);
    expect(m.cells[hidden].state).toBe("flag");
    expect(m.flags).toBe(1);
    reveal(m, hidden); // flagged cells refuse reveal
    expect(m.cells[hidden].state).toBe("flag");
    toggleFlag(m, hidden);
    expect(m.flags).toBe(0);
  });

  test("revealing a mine loses and exposes the field; clearing all safe cells wins", () => {
    const m = reveal(newMines(11), 22);
    const mine = m.cells.findIndex((c) => c.mine);
    reveal(m, mine);
    expect(m.phase).toBe("lost");
    expect(m.bust).toBe(mine);
    expect(m.cells.filter((c) => c.mine && c.state === "revealed").length).toBe(MINES_N);

    const w = newMines(5);
    reveal(w, 0);
    for (let i = 0; i < w.cells.length; i++) {
      if (!w.cells[i].mine) reveal(w, i);
    }
    expect(w.phase).toBe("won");
    expect(w.flags).toBe(MINES_N); // win convention: mines auto-flag
  });

  test("placement is deterministic per seed", () => {
    const a = reveal(newMines(99), 0);
    const b = reveal(newMines(99), 0);
    expect(a.cells.map((c) => c.mine)).toEqual(b.cells.map((c) => c.mine));
    expect(MINES_W).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// notepad.ts
// ---------------------------------------------------------------------------

describe("notepad editing", () => {
  const doc = { lines: ["hello", "world"], caret: { row: 0, col: 5 } };

  test("insert with newlines splits lines and lands the caret", () => {
    const d = insertText(doc, "!\nnew");
    expect(d.lines).toEqual(["hello!", "new", "world"]);
    expect(d.caret).toEqual({ row: 1, col: 3 });
  });

  test("backspace joins lines at col 0", () => {
    const d = backspace({ lines: ["ab", "cd"], caret: { row: 1, col: 0 } });
    expect(d.lines).toEqual(["abcd"]);
    expect(d.caret).toEqual({ row: 0, col: 2 });
  });

  test("delete joins the next line at the end", () => {
    const d = del({ lines: ["ab", "cd"], caret: { row: 0, col: 2 } });
    expect(d.lines).toEqual(["abcd"]);
    expect(d.caret).toEqual({ row: 0, col: 2 });
  });

  test("caret movement clamps and wraps", () => {
    expect(moveCaret({ lines: ["ab", "c"], caret: { row: 0, col: 2 } }, "Right")).toEqual({
      row: 1,
      col: 0,
    });
    expect(moveCaret({ lines: ["ab", "c"], caret: { row: 1, col: 0 } }, "Left")).toEqual({
      row: 0,
      col: 2,
    });
    expect(moveCaret({ lines: ["ab", "c"], caret: { row: 0, col: 2 } }, "Down")).toEqual({
      row: 1,
      col: 1,
    });
    expect(moveCaret({ lines: ["ab", "c"], caret: { row: 1, col: 1 } }, "End")).toEqual({
      row: 1,
      col: 1,
    });
  });

  test("colFromX picks the nearest gap by prefix midpoints", () => {
    const measure = (s: string) => s.length * 6;
    expect(colFromX("abcd", 0, measure)).toBe(0);
    expect(colFromX("abcd", 2, measure)).toBe(0); // < half of the first char
    expect(colFromX("abcd", 4, measure)).toBe(1);
    expect(colFromX("abcd", 100, measure)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// notepad.ts — selection model
// ---------------------------------------------------------------------------

describe("notepad selection", () => {
  const sel: Doc = {
    lines: ["hello world", "second line", "third"],
    caret: { row: 1, col: 4 },
    anchor: { row: 0, col: 6 },
  };

  test("selRange orders anchor/caret either way; collapsed = none", () => {
    expect(selRange(sel)).toEqual({ from: { row: 0, col: 6 }, to: { row: 1, col: 4 } });
    const flipped: Doc = { ...sel, caret: sel.anchor as { row: number; col: number }, anchor: sel.caret };
    expect(selRange(flipped)).toEqual(selRange(sel));
    expect(hasSel({ lines: ["a"], caret: { row: 0, col: 1 }, anchor: { row: 0, col: 1 } })).toBe(false);
    expect(hasSel({ lines: ["a"], caret: { row: 0, col: 1 } })).toBe(false);
  });

  test("selectedText joins the range with newlines", () => {
    expect(selectedText(sel)).toBe("world\nseco");
    const one: Doc = { lines: ["hello"], caret: { row: 0, col: 4 }, anchor: { row: 0, col: 1 } };
    expect(selectedText(one)).toBe("ell");
  });

  test("deleteSel merges the edge lines and lands the caret at the start", () => {
    const d = deleteSel(sel);
    expect(d.lines).toEqual(["hello nd line", "third"]);
    expect(d.caret).toEqual({ row: 0, col: 6 });
    expect(hasSel(d)).toBe(false);
  });

  test("typing replaces the selection; backspace/delete just remove it", () => {
    const typed = insertText(sel, "X");
    expect(typed.lines).toEqual(["hello Xnd line", "third"]);
    expect(typed.caret).toEqual({ row: 0, col: 7 });
    expect(backspace(sel).lines).toEqual(["hello nd line", "third"]);
    expect(del(sel).lines).toEqual(["hello nd line", "third"]);
  });

  test("shift extends from the caret; a plain move collapses to the edge", () => {
    const start: Doc = { lines: ["abc def"], caret: { row: 0, col: 4 } };
    const ext = applyMove(start, "Right", true);
    expect(ext.anchor).toEqual({ row: 0, col: 4 });
    expect(ext.caret).toEqual({ row: 0, col: 5 });
    const left = applyMove(sel, "Left", false);
    expect(left.caret).toEqual({ row: 0, col: 6 }); // collapse to from
    expect(hasSel(left)).toBe(false);
    const right = applyMove(sel, "Right", false);
    expect(right.caret).toEqual({ row: 1, col: 4 }); // collapse to to
  });

  test("selectAll spans the whole document", () => {
    const all = selectAll({ lines: ["ab", "cde"], caret: { row: 0, col: 0 } });
    expect(all.anchor).toEqual({ row: 0, col: 0 });
    expect(all.caret).toEqual({ row: 1, col: 3 });
    expect(selectedText(all)).toBe("ab\ncde");
  });

  test("wordRangeAt picks word, whitespace and punctuation runs", () => {
    expect(wordRangeAt("foo bar_baz!", 5)).toEqual({ from: 4, to: 11 });
    expect(wordRangeAt("foo bar", 3)).toEqual({ from: 3, to: 4 }); // the space run
    expect(wordRangeAt("a==b", 1)).toEqual({ from: 1, to: 3 }); // punct run
    expect(wordRangeAt("", 0)).toEqual({ from: 0, to: 0 });
  });

  test("rowSelSpan covers edge rows partially and middle rows fully", () => {
    const tall: Doc = {
      lines: ["aaaa", "bbbb", "cccc"],
      caret: { row: 2, col: 2 },
      anchor: { row: 0, col: 1 },
    };
    expect(rowSelSpan(tall, 0)).toEqual({ from: 1, to: 4 });
    expect(rowSelSpan(tall, 1)).toEqual({ from: 0, to: 4 });
    expect(rowSelSpan(tall, 2)).toEqual({ from: 0, to: 2 });
    expect(rowSelSpan(tall, 3)).toBeNull();
    expect(rowSelSpan({ lines: ["x"], caret: { row: 0, col: 0 } }, 0)).toBeNull();
  });
});
