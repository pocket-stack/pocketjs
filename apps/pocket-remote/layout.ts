// apps/pocket-remote/layout.ts — the screen's fixed geometry and the pure
// arithmetic behind it: where the strip, stage and dock sit on the 480x320
// landscape panel, how a monitor is fitted into the stage, where the levels
// card and the menu flyout open, how a finger on a slider becomes a level.
// No Solid here so tests can run it bare.

import type { Direction, HostState, WinInfo, WsInfo } from "./protocol.ts";

export const SCREEN_W = 480;
export const SCREEN_H = 320;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The workspace strip across the top. */
export const STRIP: Rect = { x: 0, y: 0, w: SCREEN_W, h: 28 };
export const TAB_W = 28;
export const TAB_X0 = 6;
export const TAB_MAX = 10;
/** Media transport cluster at the strip's right end. */
export const MEDIA_W = 30;
export const MEDIA_X = SCREEN_W - 3 * MEDIA_W - 6;
/** Layout badge sits left of the media cluster. */
export const BADGE_W = 60;
export const BADGE_X = MEDIA_X - BADGE_W - 8;

/** The stage: the live miniature of the focused monitor. */
export const STAGE: Rect = { x: 0, y: STRIP.h, w: SCREEN_W, h: 240 };

/** The dock across the bottom: eleven slots of 43 px. */
export const DOCK: Rect = { x: 0, y: STAGE.y + STAGE.h, w: SCREEN_W, h: SCREEN_H - STAGE.y - STAGE.h };
export const DOCK_SLOTS = 11;
export const DOCK_SLOT_W = 43;
export const DOCK_X0 = Math.floor((SCREEN_W - DOCK_SLOTS * DOCK_SLOT_W) / 2);

/** Seconds a tile must be held before it closes; the bar fills over this. */
export const CLOSE_HOLD_SECONDS = 0.6;
/** Horizontal travel on empty stage that switches workspace. */
export const SWIPE_PX = 48;
/** Tiles shorter than this drop their title line. */
export const TILE_TWO_LINES_H = 40;
/** Fixed pool of tile slots (protocol WINDOWS_MAX). */
export const TILE_SLOTS = 24;

// ---------------------------------------------------------------------------
// levels card (brightness + volume, the control-centre control)
// ---------------------------------------------------------------------------

export const CARD: Rect = { x: 100, y: 92, w: 280, h: 132 };
/** Row tops inside the card (brightness, volume). */
export const CARD_ROW_Y = [14, 72] as const;
export const CARD_ROW_H = 44;
/** The toggle icon at the row's left (nightlight / mute). */
export const CARD_ICON_X = 12;
export const CARD_ICON_W = 36;
/** The slider track. */
export const CARD_TRACK_X = 60;
export const CARD_TRACK_W = 172;
export const CARD_TRACK_H = 12;
/** Frames the card lingers after a hold-and-slide release. */
export const CARD_LINGER_FRAMES = 70;

export type CardHit = { kind: "icon"; row: 0 | 1 } | { kind: "track"; row: 0 | 1 } | { kind: "card" } | null;

/** What is under a point on the levels card. */
export function cardHit(x: number, y: number, card: Rect = CARD): CardHit {
  if (!within(x, y, card)) return null;
  const ly = y - card.y;
  const lx = x - card.x;
  for (const row of [0, 1] as const) {
    const top = CARD_ROW_Y[row] - 4;
    if (ly < top || ly >= top + CARD_ROW_H + 8) continue;
    if (lx >= CARD_ICON_X && lx < CARD_ICON_X + CARD_ICON_W) return { kind: "icon", row };
    if (lx >= CARD_TRACK_X - 8) return { kind: "track", row };
  }
  return { kind: "card" };
}

/** Which row a finger height selects while sliding across the card. */
export function cardRowAt(y: number, card: Rect = CARD): 0 | 1 {
  const mid = card.y + (CARD_ROW_Y[0] + CARD_ROW_Y[1] + CARD_ROW_H) / 2;
  return y < mid ? 0 : 1;
}

/** A horizontal drag of `dx` px changes a level by this (full track = 0..1). */
export function trackDelta(dx: number): number {
  return dx / CARD_TRACK_W;
}

/** Fill width for a level, in track px. */
export function trackFill(level: number): number {
  return Math.round(clamp01(level) * CARD_TRACK_W);
}

// ---------------------------------------------------------------------------
// menu flyout (hold Menu, slide, release)
// ---------------------------------------------------------------------------

export const FLY_ITEM_H = 34;
export const FLY_GAP = 4;
/** Column one: routes. Bottom-anchored just above the dock. */
export const FLY_X = 8;
export const FLY_W = 120;
export const FLY_BOTTOM = DOCK.y - 6;
/** Column two: the hot route's leaves. */
export const FLY2_X = FLY_X + FLY_W + 8;
export const FLY2_W = 156;
export const FLY_MAX_ROWS = 6;

/** Top of item `i` in a bottom-anchored column of `count` items (i = 0 is
 *  nearest the dock). */
export function flyItemY(i: number): number {
  return FLY_BOTTOM - (i + 1) * FLY_ITEM_H - i * FLY_GAP;
}

/** Item index under a point in a bottom-anchored column, or null. */
export function flyItemAt(x: number, y: number, colX: number, colW: number, count: number): number | null {
  if (x < colX - 6 || x >= colX + colW + 6) return null;
  for (let i = 0; i < count; i += 1) {
    const top = flyItemY(i);
    if (y >= top - FLY_GAP / 2 && y < top + FLY_ITEM_H + FLY_GAP / 2) return i;
  }
  return null;
}

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
// stage
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
// strip
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
// dock
// ---------------------------------------------------------------------------

export function dockSlotAt(x: number): number | null {
  const i = Math.floor((x - DOCK_X0) / DOCK_SLOT_W);
  return i >= 0 && i < DOCK_SLOTS && x >= DOCK_X0 ? i : null;
}

export function dockSlotX(i: number): number {
  return DOCK_X0 + i * DOCK_SLOT_W;
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
