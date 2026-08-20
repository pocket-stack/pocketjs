// apps/desk98/wm.ts — pure window-manager math: chrome hit regions, resize
// arithmetic, movement clamps. No Solid, no framework imports — unit-tested
// directly (tests/desk98.test.ts). The compositor (app.tsx) owns the state;
// this module owns the geometry rules.
//
// Chrome anatomy (theme.ts metrics): a window is a face-gray box with a 3px
// raised frame (padding), an 18px caption (+1px hairline), an optional 18px
// menu bar, then content. Caption controls sit flush right and flush against
// each other — [min][zoom][close], each 16×14, 2px under the caption top.

import {
  BTN_H,
  BTN_W,
  FRAME,
  MENU_H,
  RESIZE_BAND,
  RESIZE_CORNER,
  TASK_H,
  TITLE_GAP,
  TITLE_H,
} from "./theme.ts";

export interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CaptionButton = "min" | "max" | "close";
export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type Region =
  | { kind: "caption" }
  | { kind: "button"; button: CaptionButton }
  | { kind: "menu"; index: number }
  | { kind: "content"; cx: number; cy: number }
  | { kind: "resize"; dir: Dir };

export interface ChromeOpts {
  /** Caption controls present, left to right (close is always last). */
  buttons: readonly CaptionButton[];
  resizable: boolean;
  maximized: boolean;
  /** Menu-bar item widths in px (empty = no menu bar). */
  menuWidths: readonly number[];
}

/** Left x of each caption button, right-aligned inside the frame, flush. */
export function captionButtonXs(w: number, buttons: readonly CaptionButton[]): number[] {
  const xs: number[] = [];
  let right = w - FRAME - 2;
  for (let i = buttons.length - 1; i >= 0; i--) {
    xs.unshift(right - BTN_W);
    right -= BTN_W;
  }
  return xs;
}

/** Content-area top inside the window (frame + caption + menu bar). */
export function contentTop(opts: Pick<ChromeOpts, "menuWidths">): number {
  return FRAME + TITLE_H + TITLE_GAP + (opts.menuWidths.length > 0 ? MENU_H : 0);
}

/** Hit-test a point in window-local coordinates against the chrome. */
export function hitRegion(geo: Geo, opts: ChromeOpts, px: number, py: number): Region | null {
  const x = px - geo.x;
  const y = py - geo.y;
  if (x < 0 || y < 0 || x >= geo.w || y >= geo.h) return null;

  // Resize bands claim the outer edge before anything else.
  if (opts.resizable && !opts.maximized) {
    const corner = RESIZE_CORNER;
    const n = y < RESIZE_BAND;
    const s = y >= geo.h - RESIZE_BAND;
    const w = x < RESIZE_BAND;
    const e = x >= geo.w - RESIZE_BAND;
    if (n || s || w || e) {
      const nearL = x < corner;
      const nearR = x >= geo.w - corner;
      const nearT = y < corner;
      const nearB = y >= geo.h - corner;
      let dir: Dir;
      if ((n && nearL) || (w && nearT)) dir = "nw";
      else if ((n && nearR) || (e && nearT)) dir = "ne";
      else if ((s && nearL) || (w && nearB)) dir = "sw";
      else if ((s && nearR) || (e && nearB)) dir = "se";
      else if (n) dir = "n";
      else if (s) dir = "s";
      else if (w) dir = "w";
      else dir = "e";
      return { kind: "resize", dir };
    }
  }

  // Caption strip.
  if (y >= FRAME && y < FRAME + TITLE_H) {
    const xs = captionButtonXs(geo.w, opts.buttons);
    const btnTop = FRAME + 2;
    if (y >= btnTop && y < btnTop + BTN_H) {
      for (let i = 0; i < xs.length; i++) {
        if (x >= xs[i] && x < xs[i] + BTN_W) {
          return { kind: "button", button: opts.buttons[i] };
        }
      }
    }
    if (x >= FRAME && x < geo.w - FRAME) return { kind: "caption" };
  }

  // Menu bar.
  const menuTop = FRAME + TITLE_H + TITLE_GAP;
  if (opts.menuWidths.length > 0 && y >= menuTop && y < menuTop + MENU_H) {
    let mx = FRAME;
    for (let i = 0; i < opts.menuWidths.length; i++) {
      if (x >= mx && x < mx + opts.menuWidths[i]) return { kind: "menu", index: i };
      mx += opts.menuWidths[i];
    }
  }

  const top = contentTop(opts);
  if (x >= FRAME && x < geo.w - FRAME && y >= top && y < geo.h - FRAME) {
    return { kind: "content", cx: x - FRAME, cy: y - top };
  }
  return { kind: "caption" }; // frame padding drags like the caption did in 98
}

/** Apply a resize drag: dir edge follows the pointer, mins hold, the
 *  anchored edge never moves. */
export function resizeGeo(
  orig: Geo,
  dir: Dir,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): Geo {
  let { x, y, w, h } = orig;
  if (dir.includes("e")) w = Math.max(minW, orig.w + dx);
  if (dir.includes("s")) h = Math.max(minH, orig.h + dy);
  if (dir.includes("w")) {
    w = Math.max(minW, orig.w - dx);
    x = orig.x + orig.w - w;
  }
  if (dir.includes("n")) {
    h = Math.max(minH, orig.h - dy);
    y = orig.y + orig.h - h;
  }
  return { x, y, w, h };
}

/** Clamp a moved window so its caption stays reachable: some strip of the
 *  title bar remains on screen and above the taskbar. */
export function clampMove(geo: Geo, vpW: number, vpH: number): Geo {
  const grip = 48; // px of caption that must stay visible
  const x = Math.min(Math.max(geo.x, grip - geo.w), vpW - grip);
  const y = Math.min(Math.max(geo.y, 0), vpH - TASK_H - TITLE_H);
  return { ...geo, x, y };
}

/** Maximized geometry: the desktop minus the taskbar. */
export function maximizedGeo(vpW: number, vpH: number): Geo {
  return { x: 0, y: 0, w: vpW, h: vpH - TASK_H };
}

/** Cascade position for the i-th opened window. */
export function cascadePos(i: number, vpW: number, vpH: number, w: number, h: number): Geo {
  const step = 24;
  const cols = Math.max(1, Math.floor((vpH - TASK_H - h - 8) / step) + 1);
  const k = i % Math.max(1, cols);
  const x = Math.min(64 + i * step, Math.max(8, vpW - w - 8));
  const y = 28 + k * step;
  return { x, y, w, h };
}

/** The resize cursor for a band direction ({t:"cursor"} intent keys). */
export function cursorForDir(dir: Dir): "ew" | "ns" | "nwse" | "nesw" {
  switch (dir) {
    case "e":
    case "w":
      return "ew";
    case "n":
    case "s":
      return "ns";
    case "nw":
    case "se":
      return "nwse";
    case "ne":
    case "sw":
      return "nesw";
  }
}
