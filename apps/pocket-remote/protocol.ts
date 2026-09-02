// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/protocol.ts — the JSON lines the iPod and the Omarchy
// daemon exchange over the SVC WIRE (spec ops 30..32). One file, imported by
// both ends, so a field cannot drift between them. Every line is small: the
// device polls at most SVC_POLL_BUF (8192) bytes per frame and a state
// snapshot has to fit in one line, which is why titles are clipped and
// coordinates are integers.

import type { ActionId } from "./actions.ts";

/** The svc app id: what the beacon advertises and the hello names. */
export const REMOTE_APP = "pocket-remote";
export const REMOTE_PROTO = 2;

/** Title code points kept per window in a snapshot. A window's title is
 *  what tells two terminals apart, so it earns a few more than the class. */
export const TITLE_MAX = 34;
/** Windows carried per snapshot; Hyprland's `clients` beyond this are dropped
 *  by focus history (oldest first) so the line stays under the poll cap. */
export const WINDOWS_MAX = 24;

export type Layout = "dwindle" | "scrolling";
export type Direction = "l" | "r" | "u" | "d";

// ---------------------------------------------------------------------------
// host -> device
// ---------------------------------------------------------------------------

export interface WinInfo {
  /** Hyprland window address, the handle every window command names. */
  a: string;
  /** Class (initialClass when the live one is empty). */
  c: string;
  /** Title, clipped to TITLE_MAX. */
  ti: string;
  /** Workspace id. */
  ws: number;
  /** Geometry in the monitor's logical pixels, relative to the monitor. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Floating. */
  f?: 1;
  /** Fullscreen mode: 1 = maximized, 2 = fullscreen. */
  fs?: 1 | 2;
  /** Pinned. */
  p?: 1;
}

export interface WsInfo {
  id: number;
  /** Window count. */
  n: number;
}

export interface HostState {
  t: "state";
  /** The focused monitor's logical size (pixels / scale) and, for the
   *  daemon's own use, its origin in layout px. */
  mon: { w: number; h: number; x?: number; y?: number };
  /** Ordinary workspaces (ids > 0), ascending. */
  ws: WsInfo[];
  /** Active workspace id on the focused monitor. */
  active: number;
  /** Active window address, or null. */
  focus: string | null;
  /** Windows on every ordinary workspace, most recently focused first. */
  win: WinInfo[];
  /** Tiling layout of the active workspace. */
  layout: Layout;
  /** The scratchpad (special workspace) is showing. */
  special?: 1;
}

export interface HostLevels {
  t: "levels";
  /** Output volume 0..1 (may exceed 1 on boosted sinks; the device clamps). */
  vol: number;
  mute?: 1;
  /** Display brightness 0..1. */
  bri: number;
}

/** The colours the device repaints itself with — Omarchy's colors.toml keys
 *  the remote uses, as #rrggbb. */
export interface ThemeColors {
  bg: string;
  bgDark: string;
  fg: string;
  fgDim: string;
  accent: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  /** color8 — the muted border/inactive tone. */
  muted: string;
}

export interface HostTheme {
  t: "theme";
  /** Theme slug, e.g. "tokyo-night". */
  name: string;
  colors: ThemeColors;
  /** Installed theme slugs, for the picker. */
  list: string[];
}

export interface HostHello {
  t: "hello";
  proto: number;
  /** The daemon host's display name (hostname). */
  name: string;
  /** Omarchy version string, informational. */
  omarchy: string;
  /** Whether this device may issue commands yet. "pending" means the daemon
   *  put an approval dialog on the laptop screen. */
  auth: "ok" | "pending" | "denied";
}

export interface HostAuth {
  t: "auth";
  auth: "ok" | "pending" | "denied";
}

export interface HostToast {
  t: "toast";
  text: string;
}

/** What the control centre shows besides the levels: the network and
 *  whatever is playing. Sent on change. */
export interface HostCc {
  t: "cc";
  wifi: {
    /** The radio is on. */
    on: 0 | 1;
    /** Connected network, "" when none; "ethernet" links carry the device. */
    ssid: string;
    /** Signal 0..100, 0 when unknown. */
    sig: number;
  };
  media: {
    st: "playing" | "paused" | "none";
    title: string;
    artist: string;
  };
}

/** The menu's live conditions: rows hidden by a failing `when`, rows whose
 *  `checked` holds. Full sets, sent when they change. */
export interface HostMenu {
  t: "menu";
  hide: string[];
  check: string[];
}

/** One page of the machine's application list (the menu's `apps` provider,
 *  which the shell lists at open time and the device cannot know). A page
 *  with `seq` 0 starts a new list; the last page has no `more`. Paged
 *  because the whole list does not fit one poll batch. */
export interface HostApps {
  t: "apps";
  seq: number;
  more?: 1;
  /** Desktop entry id (without `.desktop`) and display name. */
  a: { i: string; n: string }[];
}

export type HostLine = HostHello | HostAuth | HostState | HostLevels | HostTheme | HostToast | HostCc | HostMenu | HostApps;

// ---------------------------------------------------------------------------
// device -> host
// ---------------------------------------------------------------------------

export interface ClientHello {
  t: "hello";
  proto: number;
  /** Device description for the approval dialog, e.g. "iPod touch". */
  device: string;
}

/** Run one whitelisted action (actions.ts). */
export interface ClientAction {
  t: "act";
  id: ActionId;
}

export interface ClientWorkspace {
  t: "ws";
  /** Workspace id, or a relative step when `rel` is set. */
  n: number;
  rel?: 1;
}

export type WindowOp =
  | { op: "focus"; a: string }
  | { op: "close"; a: string }
  | { op: "swap"; a: string; dir: Direction }
  | { op: "move"; a: string; n: number }
  /** Put a floating window at monitor-relative logical px (a drag). */
  | { op: "place"; a: string; x: number; y: number }
  /** Grow or shrink by monitor px (a corner drag). Relative, like the
   *  keyboard's own resize bindings. */
  | { op: "resize"; a: string; dx: number; dy: number }
  /** Toggle floating / fullscreen on one window. */
  | { op: "float"; a: string }
  | { op: "full"; a: string }
  /** Open another window of the same program. */
  | { op: "same"; a: string };

export type ClientWindow = { t: "win" } & WindowOp;

export interface ClientLevel {
  t: "vol" | "bri";
  /** Absolute 0..1. */
  v: number;
}

export interface ClientMute {
  t: "mute";
}

export interface ClientMedia {
  t: "media";
  op: "play" | "next" | "prev";
}

export interface ClientType {
  t: "type";
  /** Literal text, typed into the focused window. */
  text: string;
}

export type Modifier = "ctrl" | "alt" | "shift" | "super";

export interface ClientKey {
  t: "key";
  /** An xkb keysym name: Return, BackSpace, Tab, Escape, space, Left, a, 1,
   *  F5... (host/omarchy.ts keeps the allow-list). */
  k: string;
  /** Held around the key: ctrl+c is `{ k: "c", mods: ["ctrl"] }`. */
  mods?: Modifier[];
}

/** Trackpad: relative pointer motion in laptop-screen px (already
 *  accelerated on the device), at most one line per device frame. */
export interface ClientPointer {
  t: "ptr";
  dx: number;
  dy: number;
}

export interface ClientClick {
  t: "click";
  b: "l" | "r" | "m";
  /** Held around the click: ctrl-click extends a selection, and a virtual
   *  pointer cannot carry a modifier on its own. */
  mods?: Modifier[];
}

/** Two-finger scroll, in px of travel. */
export interface ClientScroll {
  t: "scroll";
  dx: number;
  dy: number;
}

/** Hold the left button down (the click key, or a long-press on the pad) and
 *  let go. `mods` is held for as long as the button is. */
export interface ClientDrag {
  t: "drag";
  on: 0 | 1;
  mods?: Modifier[];
}

export interface ClientWifi {
  t: "wifi";
  on: 0 | 1;
}

/** Run one row of Omarchy's menu by id (menu.ts / host/menu-source.ts): an
 *  action runs its command, a provider submenu opens on the desktop. */
export interface ClientMenu {
  t: "menu";
  id: string;
}

/** Launch one application by desktop entry id, as listed by `apps`. */
export interface ClientLaunch {
  t: "launch";
  app: string;
}

export type ClientLine =
  | ClientHello
  | ClientAction
  | ClientWorkspace
  | ClientWindow
  | ClientLevel
  | ClientMute
  | ClientMedia
  | ClientType
  | ClientKey
  | ClientPointer
  | ClientClick
  | ClientScroll
  | ClientDrag
  | ClientWifi
  | ClientMenu
  | ClientLaunch;

/** Parse one wire batch (newline-separated JSON) into typed lines; malformed
 *  lines are skipped rather than allowed to wedge the reader. */
export function parseLines<T>(batch: string): T[] {
  const out: T[] = [];
  for (const line of batch.split("\n")) {
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as T;
      if (value && typeof value === "object" && typeof (value as { t?: unknown }).t === "string") out.push(value);
    } catch {
      // skip
    }
  }
  return out;
}

/** Clip a title for the wire: TITLE_MAX code points, an ellipsis when cut. */
export function clipTitle(title: string, max = TITLE_MAX): string {
  const chars = Array.from(title.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max - 1).join("") + "…";
}
