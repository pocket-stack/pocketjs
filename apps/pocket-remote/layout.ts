// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/layout.ts — the screen's fixed geometry and the pure
// arithmetic behind it: where the strip and the stage sit on the 480x320
// landscape panel, how a monitor is fitted into the stage, where the ball
// snaps, where a popup opens so it stays on screen, how the control centre
// and the menu sheet are laid out, how a finger on a slider becomes a level
// and a finger on the trackpad becomes pointer motion. No Solid here so
// tests can run it bare.

import type { Direction, HostState, WinInfo, WsInfo } from "./protocol.ts";

export const SCREEN_W = 480;
export const SCREEN_H = 320;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stage: the live miniature of the desktop. Deck: keyboard over trackpad,
 *  the laptop's own C surface. */
export type Mode = "stage" | "deck";

// ---------------------------------------------------------------------------
// strip
// ---------------------------------------------------------------------------

/** The workspace strip across the top. */
export const STRIP: Rect = { x: 0, y: 0, w: SCREEN_W, h: 28 };
export const TAB_W = 28;
export const TAB_X0 = 6;
export const TAB_MAX = 10;
/** The active workspace's layout name; tapping toggles it (SUPER+L). */
export const BADGE: Rect = { x: 296, y: 4, w: 62, h: 20 };
/** The mode switch: two halves, stage and deck. */
export const MODE: Rect = { x: 366, y: 3, w: 68, h: 22 };
export const MODE_HALF_W = 34;
/** The control centre button at the strip's right end. */
export const CC_BUTTON: Rect = { x: 440, y: 2, w: 34, h: 24 };

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

/** Everything under the strip: the desktop miniature, or the deck. */
export const STAGE: Rect = { x: 0, y: STRIP.h, w: SCREEN_W, h: SCREEN_H - STRIP.h };
/** Horizontal travel on empty stage that switches workspace. */
export const SWIPE_PX = 48;
/** Tiles shorter than this drop their title line. */
export const TILE_TWO_LINES_H = 40;
/** Fixed pool of tile slots (protocol WINDOWS_MAX). */
export const TILE_SLOTS = 24;

/** Launch chips on an empty workspace: the apps a remote is reached for. */
export const LAUNCH_CHIP_W = 104;
export const LAUNCH_CHIP_H = 36;
export const LAUNCH_CHIP_GAP = 10;
export const LAUNCH_Y = STAGE.y + 124;

export function launchChipRect(i: number, count: number): Rect {
  const total = count * LAUNCH_CHIP_W + (count - 1) * LAUNCH_CHIP_GAP;
  const x0 = Math.round((SCREEN_W - total) / 2);
  return { x: x0 + i * (LAUNCH_CHIP_W + LAUNCH_CHIP_GAP), y: LAUNCH_Y, w: LAUNCH_CHIP_W, h: LAUNCH_CHIP_H };
}

export function launchChipAt(x: number, y: number, count: number): number | null {
  for (let i = 0; i < count; i += 1) if (within(x, y, launchChipRect(i, count))) return i;
  return null;
}

// ---------------------------------------------------------------------------
// the ball (the menu's handle: floats, snaps to a side edge)
// ---------------------------------------------------------------------------

export const BALL = 44;
export const BALL_MARGIN = 6;
export const BALL_Y_MIN = STRIP.h + 6;
export const BALL_Y_MAX = SCREEN_H - BALL - 6;
/** Where it starts: the right edge, low, over the corner a window's tile
 *  least often needs. */
export const BALL_HOME = { x: SCREEN_W - BALL - BALL_MARGIN, y: SCREEN_H - BALL - 16 };

/** Released anywhere, the ball goes to the nearer side edge and keeps its
 *  height, clamped under the strip. */
export function ballSnap(x: number, y: number): { x: number; y: number } {
  const left = x + BALL / 2 < SCREEN_W / 2;
  return {
    x: left ? BALL_MARGIN : SCREEN_W - BALL - BALL_MARGIN,
    y: Math.max(BALL_Y_MIN, Math.min(BALL_Y_MAX, Math.round(y))),
  };
}

export function ballHit(x: number, y: number, ball: { x: number; y: number }): boolean {
  return within(x, y, { x: ball.x - 4, y: ball.y - 4, w: BALL + 8, h: BALL + 8 });
}

// ---------------------------------------------------------------------------
// popup (the classic one: a container of rows over the point it answers)
// ---------------------------------------------------------------------------

export const POPUP_W = 176;
/** A held tile answers with three rows (stage.tsx). */
export const TILE_POPUP_ROWS = 3;
export const POPUP_ROW_H = 36;
export const POPUP_PAD = 4;
/** Distance between the anchor point and the popup's near edge. Short: the
 *  popup opens under a held finger and the first row has to be reachable
 *  without letting go. */
export const POPUP_GAP = 8;

export interface Popup extends Rect {
  /** The popup opened below its anchor rather than above it. */
  below: boolean;
}

/** Place a popup of `rows` rows at an anchor point, inside `bounds`: below
 *  the anchor when there is room, above otherwise, centred on it and pushed
 *  in from the sides. */
export function placePopup(anchorX: number, anchorY: number, rows: number, bounds: Rect = STAGE): Popup {
  const w = POPUP_W;
  const h = rows * POPUP_ROW_H + POPUP_PAD * 2;
  const below = anchorY + POPUP_GAP + h <= bounds.y + bounds.h - 6;
  const y = below ? anchorY + POPUP_GAP : anchorY - POPUP_GAP - h;
  const x = Math.max(bounds.x + 6, Math.min(bounds.x + bounds.w - 6 - w, Math.round(anchorX - w / 2)));
  return { x, y: Math.max(bounds.y + 6, y), w, h, below };
}

export function popupRowAt(p: Popup, x: number, y: number): number | null {
  if (!within(x, y, p)) return null;
  const i = Math.floor((y - p.y - POPUP_PAD) / POPUP_ROW_H);
  const rows = Math.round((p.h - POPUP_PAD * 2) / POPUP_ROW_H);
  return i >= 0 && i < rows ? i : null;
}

// ---------------------------------------------------------------------------
// control centre (hangs from the strip's right end)
// ---------------------------------------------------------------------------

export const CC: Rect = { x: SCREEN_W - 8 - 268, y: STRIP.h + 4, w: 268, h: 210 };
/** Tiles, relative to the card. */
export const CC_WIFI: Rect = { x: 10, y: 10, w: 130, h: 52 };
export const CC_SHOT: Rect = { x: 148, y: 10, w: 54, h: 52 };
export const CC_NIGHT: Rect = { x: 206, y: 10, w: 52, h: 52 };
export const CC_MEDIA: Rect = { x: 10, y: 70, w: 248, h: 48 };
export const CC_MEDIA_BTN_W = 36;
/** prev, play, next — the right end of the media row. */
export const CC_MEDIA_BTN_X = [150, 186, 222] as const;
/** Slider rows: brightness, volume. */
export const CC_ROW_Y = [126, 166] as const;
export const CC_ROW_H = 36;
export const CC_ICON_X = 10;
export const CC_ICON_W = 36;
export const CC_TRACK_X = 54;
export const CC_TRACK_W = 160;
export const CC_TRACK_H = 10;
export const CC_VALUE_X = 220;
/** Frames the card lingers after a hold-and-slide release. */
export const CC_LINGER_FRAMES = 70;

export type CcHit =
  | { kind: "wifi" }
  | { kind: "shot" }
  | { kind: "night" }
  | { kind: "media" }
  | { kind: "prev" }
  | { kind: "play" }
  | { kind: "next" }
  | { kind: "icon"; row: 0 | 1 }
  | { kind: "track"; row: 0 | 1 }
  | { kind: "card" }
  | null;

/** What is under a point on the control centre. */
export function ccHit(x: number, y: number, card: Rect = CC): CcHit {
  if (!within(x, y, card)) return null;
  const lx = x - card.x;
  const ly = y - card.y;
  const inside = (r: Rect) => lx >= r.x && lx < r.x + r.w && ly >= r.y && ly < r.y + r.h;
  if (inside(CC_WIFI)) return { kind: "wifi" };
  if (inside(CC_SHOT)) return { kind: "shot" };
  if (inside(CC_NIGHT)) return { kind: "night" };
  if (inside(CC_MEDIA)) {
    const buttons = ["prev", "play", "next"] as const;
    for (let i = 0; i < 3; i += 1) {
      if (lx >= CC_MEDIA_BTN_X[i]! && lx < CC_MEDIA_BTN_X[i]! + CC_MEDIA_BTN_W) return { kind: buttons[i]! };
    }
    return { kind: "media" };
  }
  for (const row of [0, 1] as const) {
    const top = CC_ROW_Y[row] - 3;
    if (ly < top || ly >= top + CC_ROW_H + 6) continue;
    if (lx >= CC_ICON_X && lx < CC_ICON_X + CC_ICON_W) return { kind: "icon", row };
    if (lx >= CC_TRACK_X - 8) return { kind: "track", row };
  }
  return { kind: "card" };
}

/** The slider row a sliding finger is on: brightness above the midline
 *  between the rows, volume below; null while the finger is still up among
 *  the tiles. */
export function ccRowAt(y: number, card: Rect = CC): 0 | 1 | null {
  const ly = y - card.y;
  if (ly < CC_ROW_Y[0] - 10) return null;
  const mid = (CC_ROW_Y[0] + CC_ROW_Y[1] + CC_ROW_H) / 2;
  return ly < mid ? 0 : 1;
}

/** A horizontal drag of `dx` px changes a level by this (full track = 0..1). */
export function trackDelta(dx: number): number {
  return dx / CC_TRACK_W;
}

/** Fill width for a level, in track px. */
export function trackFill(level: number): number {
  return Math.round(clamp01(level) * CC_TRACK_W);
}

// ---------------------------------------------------------------------------
// the menu sheet (Omarchy's menu, centred, one column, scrolling)
// ---------------------------------------------------------------------------

export const SHEET: Rect = { x: 68, y: 34, w: 344, h: 274 };
export const SHEET_HEAD_H = 36;
export const SHEET_PAD = 8;
export const SHEET_ROW_H = 40;
export const SHEET_RADIUS = 14;
/** The scrolling list's viewport. */
export const SHEET_LIST: Rect = {
  x: SHEET.x + SHEET_PAD,
  y: SHEET.y + SHEET_HEAD_H,
  w: SHEET.w - 2 * SHEET_PAD,
  h: SHEET.h - SHEET_HEAD_H - SHEET_PAD,
};
export const SHEET_BACK: Rect = { x: SHEET.x + 4, y: SHEET.y + 2, w: 44, h: 32 };
export const SHEET_CLOSE: Rect = { x: SHEET.x + SHEET.w - 48, y: SHEET.y + 2, w: 44, h: 32 };

/** Row `i`, in LIST space (before the scroll offset). One column: a menu
 *  reads as a list, and two columns of eleven-character labels did not. */
export function sheetRowRect(i: number): Rect {
  return { x: 0, y: i * SHEET_ROW_H, w: SHEET_LIST.w, h: SHEET_ROW_H };
}

export function sheetContentH(count: number): number {
  return count * SHEET_ROW_H;
}

export function sheetMaxScroll(count: number): number {
  return Math.max(0, sheetContentH(count) - SHEET_LIST.h);
}

/** Row index under a screen point, given the list's scroll offset. */
export function sheetRowAt(x: number, y: number, count: number, scroll: number): number | null {
  if (!within(x, y, SHEET_LIST)) return null;
  const i = Math.floor((y - SHEET_LIST.y + scroll) / SHEET_ROW_H);
  return i >= 0 && i < count ? i : null;
}

// ---------------------------------------------------------------------------
// trackpad
// ---------------------------------------------------------------------------

/** Pointer gain by finger speed (px per frame on the pad): slow strokes are
 *  precise, fast ones cross the laptop's screen in one swipe. */
export function pointerGain(speed: number): number {
  return Math.max(1.2, Math.min(4, 1.2 + speed * 0.14));
}

/** Two-finger travel to scroll distance. */
export const SCROLL_GAIN = 1.6;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function within(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// the desktop on the stage
// ---------------------------------------------------------------------------

export interface Fit {
  /** Monitor logical px -> stage px. */
  s: number;
  /** Stage-space origin of the monitor's top-left. */
  ox: number;
  oy: number;
  /** The fitted monitor rectangle on screen. */
  rect: Rect;
}

/** Fit a monitor into the stage preserving aspect, centred. */
export function fitMonitor(mon: { w: number; h: number }, stage: Rect = STAGE): Fit {
  const w = Math.max(1, mon.w);
  const h = Math.max(1, mon.h);
  const s = Math.min(stage.w / w, stage.h / h);
  const fw = Math.round(w * s);
  const fh = Math.round(h * s);
  const ox = stage.x + Math.floor((stage.w - fw) / 2);
  const oy = stage.y + Math.floor((stage.h - fh) / 2);
  return { s, ox, oy, rect: { x: ox, y: oy, w: fw, h: fh } };
}

/** One window's tile on the stage, integer px, at least 8x8. */
export function tileRect(win: WinInfo, fit: Fit): Rect {
  const x = Math.round(fit.ox + win.x * fit.s);
  const y = Math.round(fit.oy + win.y * fit.s);
  const x2 = Math.round(fit.ox + (win.x + win.w) * fit.s);
  const y2 = Math.round(fit.oy + (win.y + win.h) * fit.s);
  return { x, y, w: Math.max(8, x2 - x), h: Math.max(8, y2 - y) };
}

/** Stage px back to the monitor's logical px (a dragged floating window). */
export function stageToMonitor(x: number, y: number, fit: Fit): { x: number; y: number } {
  return { x: Math.round((x - fit.ox) / fit.s), y: Math.round((y - fit.oy) / fit.s) };
}

/** Windows shown on the stage: the active workspace's, tiled first so a
 *  floating window paints over the tiling it covers. */
export function stageWindows(state: HostState): WinInfo[] {
  const tiled = state.win.filter((w) => w.ws === state.active && !w.f);
  const floating = state.win.filter((w) => w.ws === state.active && w.f);
  return [...tiled, ...floating];
}

/** The window whose tile contains the point, topmost (last painted) first. */
export function windowAt(
  x: number,
  y: number,
  tiles: readonly { a: string; rect: Rect }[],
): string | null {
  for (let i = tiles.length - 1; i >= 0; i -= 1) {
    if (within(x, y, tiles[i]!.rect)) return tiles[i]!.a;
  }
  return null;
}

/** Direction from `from` to `to` by their centres — what `swapwindow` needs. */
export function swapDirection(from: Rect, to: Rect): Direction {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "r" : "l";
  return dy >= 0 ? "d" : "u";
}

// ---------------------------------------------------------------------------
// strip tabs
// ---------------------------------------------------------------------------

export interface Tab {
  id: number;
  /** Window count (0 for the trailing empty tab). */
  n: number;
  x: number;
}

/**
 * Workspaces on the strip: every ordinary workspace Hyprland has, the active
 * one even when empty, plus one more empty tab so there is always somewhere
 * new to go — the Omarchy bar's own rule. Capped at TAB_MAX.
 */
export function stripTabs(ws: readonly WsInfo[], active: number): Tab[] {
  const ids = new Set<number>();
  for (const w of ws) if (w.id > 0) ids.add(w.id);
  if (active > 0) ids.add(active);
  const sorted = [...ids].sort((a, b) => a - b);
  const last = sorted.length ? sorted[sorted.length - 1]! : 0;
  const lastN = ws.find((w) => w.id === last)?.n ?? 0;
  // An empty tab trails the list unless the last workspace is already empty.
  if ((last === 0 || lastN > 0) && last < TAB_MAX) sorted.push(last + 1);
  return sorted.slice(0, TAB_MAX).map((id, i) => ({
    id,
    n: ws.find((w) => w.id === id)?.n ?? 0,
    x: STRIP.x + TAB_X0 + i * TAB_W,
  }));
}

export function tabAt(x: number, tabs: readonly Tab[]): Tab | null {
  for (const tab of tabs) if (x >= tab.x && x < tab.x + TAB_W) return tab;
  return null;
}

// ---------------------------------------------------------------------------
// motion
// ---------------------------------------------------------------------------

/** Per-frame ease toward a target (the pocket-shell EASE), snapping when
 *  within half a pixel so idle frames settle to exact integers. */
export const EASE = 0.35;
export function approach(current: number, target: number): number {
  const next = current + (target - current) * EASE;
  return Math.abs(target - next) < 0.5 ? target : next;
}

/** Ease a 0..1 progress toward 1: fast start, soft landing. */
export function easeProgress(t: number): number {
  const next = t + (1 - t) * 0.28;
  return next > 0.995 ? 1 : next;
}

/** Stagger: item `i` of `count` runs its own 0..1 inside the shared progress. */
export function stagger(t: number, i: number, count: number, spread = 0.5): number {
  const start = count <= 1 ? 0 : (i / (count - 1)) * spread;
  const span = 1 - spread;
  return clamp01((t - start) / span);
}
