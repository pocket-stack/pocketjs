// apps/pocket-remote/layout.ts — the screen's fixed geometry and the pure
// arithmetic behind it: where the rails, strip, stage and dock sit on the
// 480x320 landscape panel, how a monitor is fitted into the stage, how a
// finger on a rail becomes a level. No Solid here so tests can run it bare.

import type { Direction, HostState, WinInfo, WsInfo } from "./protocol.ts";

export const SCREEN_W = 480;
export const SCREEN_H = 320;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Left rail = display brightness, right rail = output volume. */
export const RAIL_W = 40;
export const RAIL_LEFT: Rect = { x: 0, y: 0, w: RAIL_W, h: SCREEN_H };
export const RAIL_RIGHT: Rect = { x: SCREEN_W - RAIL_W, y: 0, w: RAIL_W, h: SCREEN_H };
/** The rail's track: the part of its height a drag maps onto 0..1. */
export const RAIL_TRACK_TOP = 44;
export const RAIL_TRACK_BOTTOM = 300;
export const RAIL_TRACK_H = RAIL_TRACK_BOTTOM - RAIL_TRACK_TOP;
/** Icon cap at the top of a rail (mute / nightlight). */
export const RAIL_CAP_H = 36;

/** The workspace strip across the top of the centre column. */
export const STRIP: Rect = { x: RAIL_W, y: 0, w: SCREEN_W - 2 * RAIL_W, h: 32 };
export const TAB_W = 28;
export const TAB_MAX = 10;
/** Media transport cluster at the strip's right end. */
export const MEDIA_W = 30;
export const MEDIA_X = STRIP.x + STRIP.w - 3 * MEDIA_W - 4;
/** Layout badge sits left of the media cluster. */
export const BADGE_W = 56;
export const BADGE_X = MEDIA_X - BADGE_W - 6;

/** The stage: the live miniature of the focused monitor. */
export const STAGE: Rect = { x: RAIL_W, y: STRIP.h, w: SCREEN_W - 2 * RAIL_W, h: 228 };

/** The dock across the bottom of the centre column. */
export const DOCK: Rect = { x: RAIL_W, y: STAGE.y + STAGE.h, w: SCREEN_W - 2 * RAIL_W, h: SCREEN_H - STAGE.y - STAGE.h };
export const DOCK_SLOTS = 9;
export const DOCK_SLOT_W = 44;
export const DOCK_X0 = DOCK.x + Math.floor((DOCK.w - DOCK_SLOTS * DOCK_SLOT_W) / 2);

/** Seconds a tile must be held before it closes; the ring fills over this. */
export const CLOSE_HOLD_SECONDS = 0.6;
/** Horizontal travel on empty stage that switches workspace. */
export const SWIPE_PX = 48;
/** Tiles shorter than this drop their title line. */
export const TILE_TWO_LINES_H = 40;
/** Fixed pool of tile slots (protocol WINDOWS_MAX). */
export const TILE_SLOTS = 24;

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
    x: STRIP.x + i * TAB_W,
  }));
}

export function tabAt(x: number, tabs: readonly Tab[]): Tab | null {
  for (const tab of tabs) if (x >= tab.x && x < tab.x + TAB_W) return tab;
  return null;
}

// ---------------------------------------------------------------------------
// rails
// ---------------------------------------------------------------------------

/** A vertical drag of `dy` px (down = positive) changes the level by this. */
export function railDelta(dy: number): number {
  return -dy / RAIL_TRACK_H;
}

/** Fill height for a level, in track px. */
export function railFill(level: number): number {
  return Math.round(clamp01(level) * RAIL_TRACK_H);
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
