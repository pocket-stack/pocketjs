// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/store.ts — the remote's live state: the link to the
// daemon, the mirrored desktop (workspaces, windows, levels, theme, network,
// what is playing, the menu's live conditions), the tile slot pool that
// animates the stage, the ball, the popups (a tile's, the control centre,
// the menu sheet), the deck's keyboard state, and the senders every touch
// target calls. Everything the screen shows reads from here; nothing here
// knows about pixels except the motion owners — the tile pool, the ball and
// the entrance progresses — which write geometry straight to node mirrors.
//
// Reactivity is coarse on purpose: a snapshot replaces one signal, tiles
// live in a fixed pool of per-slot signals so a frame in which one window
// moves re-renders one node, and idle frames write nothing.

import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import { getOps } from "@pocketjs/framework";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { createScroller, type Scroller } from "@pocketjs/framework/kinetics";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { type ActionId, actionById } from "./actions.ts";
import type { KbLayer, KeyVariant } from "./keyboard-layout.ts";
import {
  approach,
  BALL,
  BALL_HOME,
  ballSnap,
  CC_LINGER_FRAMES,
  ccRowAt,
  clamp01,
  easeProgress,
  type Fit,
  fitMonitor,
  type Mode,
  placePopup,
  type Popup,
  type Rect,
  SHEET_LIST,
  sheetMaxScroll,
  stageToMonitor,
  stageWindows,
  stripTabs,
  swapDirection,
  type Tab,
  TILE_SLOTS,
  TILE_TWO_LINES_H,
  tileRect,
  trackDelta,
  windowAt,
} from "./layout.ts";
import { MENU_ROOT, menuChildren, menuItem, menuParent } from "./menu-tree.ts";
import type { MenuItem } from "./menu.ts";
import {
  type ClientLine,
  type Direction,
  type HostCc,
  type HostLine,
  type HostState,
  type Layout,
  type Modifier,
  parseLines,
  REMOTE_APP,
  REMOTE_PROTO,
  type ThemeColors,
} from "./protocol.ts";
import { isThemeColors, setTheme as paintTheme, TOKYO_NIGHT } from "./theme.ts";

// ---------------------------------------------------------------------------
// svc channel
// ---------------------------------------------------------------------------

export interface Svc {
  /** Non-blocking transport probe, once per frame; false until connected. */
  open(): boolean;
  poll(): HostLine[];
  send(line: ClientLine): void;
}

/** Null = this host has no svc channel (hosts/sim, goldens). */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend) return null;
  const open = ops.svcOpen.bind(ops);
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    open: () => open(REMOTE_APP),
    poll() {
      const batchText = poll();
      return batchText ? parseLines<HostLine>(batchText) : [];
    },
    send(line) {
      send(JSON.stringify(line));
    },
  };
}

function deviceName(): string {
  const host = (getOps() as { __host?: string }).__host ?? "";
  if (host.startsWith("ipodtouch4")) return "iPod touch 4";
  if (host.startsWith("iphone4s")) return "iPhone 4S";
  if (host.startsWith("iphone2g")) return "iPhone";
  return "PocketJS";
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** off = no svc channel at all; search = looking for the daemon; pending =
 *  connected, waiting for the laptop to approve this device. */
export type Link = "off" | "search" | "pending" | "denied" | "up";

export interface TileView {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1, fades a tile in on open and out on close. */
  alpha: number;
}

export interface TileSlot {
  index: number;
  /** Window address, or null while the slot is free. */
  a: string | null;
  /** The tile's node, captured by ref; geometry and opacity are written to
   *  it directly by the frame loop (jump), never through Solid. */
  node: NodeMirror | null;
  /** True while the slot is showing a window (free slots paint nothing). */
  live: Accessor<boolean>;
  label: Accessor<string>;
  title: Accessor<string>;
  /** Tall enough for class + title. */
  twoLines: Accessor<boolean>;
  focused: Accessor<boolean>;
  floating: Accessor<boolean>;
  setLive(live: boolean): void;
  setLabel(label: string): void;
  setTitle(title: string): void;
  setTwoLines(two: boolean): void;
  setFocused(focused: boolean): void;
  setFloating(floating: boolean): void;
  /** Motion targets, owned by the frame loop. */
  target: Rect;
  targetAlpha: number;
  cur: TileView;
  dying: boolean;
}

/** A tiled window being dragged onto another (swap) or onto a tab (move). */
export interface Drag {
  a: string;
  x: number;
  y: number;
  /** Tile under the finger (not the dragged one). */
  over: string | null;
  /** Workspace tab under the finger. */
  overWs: number | null;
}

/** A tile's popup: float/tile, full screen, close. */
export interface TilePopup {
  a: string;
  place: Popup;
  floating: boolean;
  hot: number | null;
}

/**
 * The control centre. Opened sticky by a tap on its button (tap outside
 * closes) or by hold-and-slide (the finger that opened it adjusts, release
 * lingers then closes).
 */
export interface Cc {
  mode: "sticky" | "hold";
  /** Slider row the finger is on (hold mode) or dragging (sticky mode). */
  row: 0 | 1 | null;
  /** Finger x and level when the current row was entered — drags are relative. */
  refX: number;
  refLevel: number;
  /** Frame after which a released hold card closes. */
  until: number;
}

/** The menu sheet: which submenu is open and how it was reached. */
export interface Sheet {
  /** The open submenu's id ("root" at the top). */
  at: string;
  /** Ancestors, root first — what back returns to. */
  trail: string[];
  hot: number | null;
}

/** A held key's variant chips. */
export interface KeyFly {
  /** Screen-space rect of the held key. */
  key: Rect;
  variants: KeyVariant[];
  hot: number | null;
}

export interface Wifi {
  on: boolean;
  ssid: string;
  sig: number;
}

export interface Media {
  st: "playing" | "paused" | "none";
  title: string;
  artist: string;
}

const TOAST_FRAMES = 150;
/** Frames between level sends while a slider is being dragged. */
const LEVEL_SEND_EVERY = 3;
/** Frames after a slider release during which host echoes are ignored. */
const LEVEL_ECHO_HOLD = 30;
/** Frames between placements while a floating tile is dragged. */
const PLACE_SEND_EVERY = 3;

export type RemoteStore = ReturnType<typeof createRemoteStore>;

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export function createRemoteStore(svc: Svc | null = connectSvc()) {
  // ---- link -----------------------------------------------------------------
  const [link, setLink] = createSignal<Link>(svc ? "search" : "off");
  const [hostName, setHostName] = createSignal("");
  const [omarchy, setOmarchy] = createSignal("");
  let opened = false;

  // ---- mirrored desktop ---------------------------------------------------------
  const [state, setState] = createSignal<HostState | null>(null);
  const [vol, setVol] = createSignal(0);
  const [mute, setMute] = createSignal(false);
  const [bri, setBri] = createSignal(0);
  const [themeName, setThemeName] = createSignal("tokyo-night");
  const [themeList, setThemeList] = createSignal<string[]>([]);
  const [colors, setColors] = createSignal<ThemeColors>(TOKYO_NIGHT);
  const [wifi, setWifi] = createSignal<Wifi>({ on: false, ssid: "", sig: 0 });
  const [media, setMedia] = createSignal<Media>({ st: "none", title: "", artist: "" });
  const [menuHidden, setMenuHidden] = createSignal<ReadonlySet<string>>(new Set());
  const [menuChecked, setMenuChecked] = createSignal<ReadonlySet<string>>(new Set());

  const tabs = createMemo<Tab[]>(() => {
    const s = state();
    return s ? stripTabs(s.ws, s.active) : [];
  });
  const layout = createMemo<Layout>(() => state()?.layout ?? "dwindle");
  const focusTitle = createMemo(() => {
    const s = state();
    if (!s || !s.focus) return "";
    const win = s.win.find((w) => w.a === s.focus);
    return win ? (win.ti || win.c) : "";
  });
  const focusClass = createMemo(() => {
    const s = state();
    if (!s || !s.focus) return "";
    return s.win.find((w) => w.a === s.focus)?.c ?? "";
  });
  const fit = createMemo<Fit | null>(() => {
    const s = state();
    return s ? fitMonitor(s.mon) : null;
  });

  // ---- ui --------------------------------------------------------------------
  const [mode, setMode] = createSignal<Mode>("stage");
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  const [kbMods, setKbMods] = createSignal<Modifier[]>([]);
  const [pressed, setPressed] = createSignal<string | null>(null);
  /** 0..1 eased press depth of the pressed target: attack on down, release
   *  after up. Keys scale and brighten by it, the bubble rides on it. */
  const [pressT, setPressT] = createSignal(0);
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [popup, setPopup] = createSignal<TilePopup | null>(null);
  const [popupT, setPopupT] = createSignal(0);
  const [cc, setCc] = createSignal<Cc | null>(null);
  const [ccT, setCcT] = createSignal(0);
  const [sheet, setSheet] = createSignal<Sheet | null>(null);
  const [sheetT, setSheetT] = createSignal(0);
  /** Restarted on every route change: the list's own entrance. */
  const [sheetListT, setSheetListT] = createSignal(0);
  const [keyFly, setKeyFly] = createSignal<KeyFly | null>(null);
  const [flyT, setFlyT] = createSignal(0);
  const [toast, setToast] = createSignal("");
  const [frame, setFrame] = createSignal(0);
  let toastUntil = 0;
  let frameCount = 0;
  let pressHeld = false;

  const say = (text: string) => {
    setToast(text);
    toastUntil = frameCount + TOAST_FRAMES;
  };

  /** The open submenu's visible rows. */
  const sheetRows = createMemo<MenuItem[]>(() => {
    const s = sheet();
    return s ? menuChildren(s.at, menuHidden()) : [];
  });
  const sheetScroller: Scroller = createScroller({
    max: () => sheetMaxScroll(sheetRows().length),
    extent: () => SHEET_LIST.h,
    overscroll: 40,
  });

  // ---- the ball ----------------------------------------------------------------
  const [ball, setBall] = createSignal<{ x: number; y: number }>({ ...BALL_HOME });
  const [ballDragging, setBallDragging] = createSignal(false);
  const ballCur = { x: BALL_HOME.x, y: BALL_HOME.y };
  let ballNode: NodeMirror | null = null;
  let grab = { dx: 0, dy: 0 };
  const paintBall = () => {
    if (!ballNode) return;
    jump(ballNode, "insetL", Math.round(ballCur.x));
    jump(ballNode, "insetT", Math.round(ballCur.y));
  };
  const bindBall = (node: NodeMirror) => {
    ballNode = node;
    paintBall();
  };
  /** A held ball comes along with the finger from where it was grabbed. */
  const ballGrab = (x: number, y: number) => {
    const b = ball();
    grab = { dx: x - b.x, dy: y - b.y };
    setBallDragging(true);
  };
  const ballDragTo = (x: number, y: number) => {
    if (!ballDragging()) return;
    ballCur.x = x - grab.dx;
    ballCur.y = y - grab.dy;
    setBall({ x: ballCur.x, y: ballCur.y });
    paintBall();
  };
  /** Released: snap to the nearer edge (the frame loop eases it there). */
  const ballRelease = () => {
    if (!ballDragging()) return;
    setBallDragging(false);
    setBall(ballSnap(ballCur.x, ballCur.y));
  };

  // ---- tile pool ---------------------------------------------------------------
  const slots: TileSlot[] = [];
  for (let i = 0; i < TILE_SLOTS; i += 1) {
    const [live, setLive] = createSignal(false);
    const [label, setLabel] = createSignal("");
    const [title, setTitle] = createSignal("");
    const [twoLines, setTwoLines] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const [floating, setFloating] = createSignal(false);
    slots.push({
      index: i,
      a: null,
      node: null,
      live,
      label,
      title,
      twoLines,
      focused,
      floating,
      setLive,
      setLabel,
      setTitle,
      setTwoLines,
      setFocused,
      setFloating,
      target: { x: 0, y: 0, w: 0, h: 0 },
      targetAlpha: 0,
      cur: { x: 0, y: 0, w: 0, h: 0, alpha: 0 },
      dying: false,
    });
  }
  const slotOf = (a: string): TileSlot | undefined => slots.find((s) => s.a === a);
  const paintSlot = (slot: TileSlot) => {
    const node = slot.node;
    if (!node) return;
    const c = slot.cur;
    jump(node, "insetL", Math.round(c.x));
    jump(node, "insetT", Math.round(c.y));
    jump(node, "width", Math.max(1, Math.round(c.w)));
    jump(node, "height", Math.max(1, Math.round(c.h)));
    jump(node, "opacity", c.alpha);
  };

  /** A floating tile under the finger: its own geometry is the truth until
   *  the daemon echoes the placement, so a snapshot must not yank it back. */
  let placing: { a: string; dx: number; dy: number; sentAt: number } | null = null;

  /** Re-target the pool from a snapshot: keep slots by address, fade new
   *  windows in where they belong, fade vanished ones out in place. */
  const retarget = (s: HostState) => {
    const f = fitMonitor(s.mon);
    const shown = stageWindows(s);
    const seen = new Set<string>();
    batch(() => {
      for (const win of shown) {
        seen.add(win.a);
        const rect = tileRect(win, f);
        let slot = slotOf(win.a);
        if (!slot) {
          slot = slots.find((candidate) => candidate.a === null);
          if (!slot) continue; // pool exhausted: WINDOWS_MAX guards this
          slot.a = win.a;
          slot.cur = { ...rect, alpha: 0 };
          paintSlot(slot);
          slot.setLive(true);
        }
        slot.dying = false;
        if (!(placing && placing.a === win.a)) slot.target = rect;
        slot.targetAlpha = 1;
        slot.setLabel(win.c);
        slot.setTitle(win.ti);
        slot.setTwoLines(rect.h >= TILE_TWO_LINES_H && rect.w >= 56);
        slot.setFocused(win.a === s.focus);
        slot.setFloating(win.f === 1);
      }
      for (const slot of slots) {
        if (slot.a !== null && !seen.has(slot.a)) {
          slot.dying = true;
          slot.targetAlpha = 0;
        }
      }
    });
  };

  /** Replace the mirrored desktop and re-target the tiles in one step; the
   *  optimistic paths (a tap on the strip) go through here too, so the stage
   *  moves the instant the finger lifts, not when the daemon confirms. */
  const commit = (next: HostState) => {
    setState(next);
    retarget(next);
  };

  /** Current tile rectangles for hit testing, in paint order. */
  const tilesForHit = (): { a: string; rect: Rect }[] => {
    const s = state();
    if (!s) return [];
    const out: { a: string; rect: Rect }[] = [];
    for (const win of stageWindows(s)) {
      const slot = slotOf(win.a);
      if (slot && !slot.dying) out.push({ a: win.a, rect: slot.target });
    }
    return out;
  };
  const isFloating = (a: string): boolean => state()?.win.find((w) => w.a === a)?.f === 1;

  // ---- senders -------------------------------------------------------------------
  const send = (line: ClientLine) => {
    if (svc && link() === "up") svc.send(line);
  };
  const act = (id: ActionId) => {
    const def = actionById(id);
    if (!def) return;
    send({ t: "act", id });
    say(def.label);
  };
  const workspace = (n: number) => {
    const s = state();
    if (s && s.active !== n) commit({ ...s, active: n });
    send({ t: "ws", n });
  };
  const workspaceStep = (delta: 1 | -1) => {
    const s = state();
    if (s) {
      const ids = tabs().map((t) => t.id);
      const at = ids.indexOf(s.active);
      const next = ids[at + delta];
      if (next !== undefined) commit({ ...s, active: next });
    }
    send({ t: "ws", n: delta, rel: 1 });
  };
  const focusWindow = (a: string) => {
    const s = state();
    if (s && s.focus !== a) {
      setState({ ...s, focus: a });
      for (const slot of slots) if (slot.a) slot.setFocused(slot.a === a);
    }
    send({ t: "win", op: "focus", a });
  };
  const closeWindow = (a: string) => {
    send({ t: "win", op: "close", a });
    const slot = slotOf(a);
    if (slot) {
      slot.dying = true;
      slot.targetAlpha = 0;
    }
    say("closed");
  };
  const swapWindows = (a: string, b: string) => {
    const from = slotOf(a);
    const to = slotOf(b);
    if (!from || !to) return;
    const dir: Direction = swapDirection(from.target, to.target);
    send({ t: "win", op: "swap", a, dir });
  };
  const moveWindow = (a: string, n: number) => {
    send({ t: "win", op: "move", a, n });
    const s = state();
    if (s) commit({ ...s, win: s.win.map((w) => (w.a === a ? { ...w, ws: n } : w)) });
    say(`moved to ${n}`);
  };
  const floatWindow = (a: string) => {
    send({ t: "win", op: "float", a });
    say(isFloating(a) ? "tiled" : "floating");
  };
  const fullWindow = (a: string) => {
    send({ t: "win", op: "full", a });
    say("full screen");
  };

  /** Begin dragging a floating tile: remember where inside it the finger
   *  landed so the tile does not jump to the fingertip. */
  const placeBegin = (a: string, x: number, y: number) => {
    const slot = slotOf(a);
    if (!slot) return;
    placing = { a, dx: x - slot.cur.x, dy: y - slot.cur.y, sentAt: 0 };
  };
  /** Move it: the tile follows the finger now; the laptop hears every third
   *  frame and on release. */
  const placeTo = (x: number, y: number, final = false) => {
    if (!placing) return;
    const slot = slotOf(placing.a);
    const f = fit();
    if (!slot || !f) return;
    const nx = x - placing.dx;
    const ny = y - placing.dy;
    slot.target = { ...slot.target, x: nx, y: ny };
    slot.cur = { ...slot.cur, x: nx, y: ny };
    paintSlot(slot);
    if (final || frameCount >= placing.sentAt + PLACE_SEND_EVERY) {
      const at = stageToMonitor(nx, ny, f);
      send({ t: "win", op: "place", a: placing.a, x: at.x, y: at.y });
      placing.sentAt = frameCount;
    }
    if (final) placing = null;
  };
  const placeCancel = () => {
    placing = null;
    const s = state();
    if (s) retarget(s);
  };

  let levelSendAt = 0;
  let levelEchoHoldUntil = 0;
  let pendingLevel: { rail: "vol" | "bri"; v: number } | null = null;
  const setLevel = (rail: "vol" | "bri", v: number, final = false) => {
    const value = clamp01(v);
    if (rail === "vol") {
      setVol(value);
      if (value > 0) setMute(false);
    } else setBri(value);
    levelEchoHoldUntil = frameCount + LEVEL_ECHO_HOLD;
    if (final || frameCount >= levelSendAt) {
      send({ t: rail, v: Math.round(value * 100) / 100 });
      levelSendAt = frameCount + LEVEL_SEND_EVERY;
      pendingLevel = null;
    } else {
      pendingLevel = { rail, v: value };
    }
  };
  const toggleMute = () => {
    setMute(!mute());
    send({ t: "mute" });
  };
  const mediaOp = (op: "play" | "next" | "prev") => {
    send({ t: "media", op });
    const m = media();
    if (op === "play" && m.st !== "none") setMedia({ ...m, st: m.st === "playing" ? "paused" : "playing" });
  };
  const wifiToggle = () => {
    const w = wifi();
    setWifi({ ...w, on: !w.on, ssid: w.on ? "" : w.ssid });
    send({ t: "wifi", on: w.on ? 0 : 1 });
    say(w.on ? "Wi-Fi off" : "Wi-Fi on");
  };
  const typeText = (text: string) => send({ t: "type", text });
  const typeKey = (k: string, mods: Modifier[] = []) => send(mods.length ? { t: "key", k, mods } : { t: "key", k });

  /** Trackpad: motion and scroll accumulate and go out once per frame. */
  let ptrDx = 0;
  let ptrDy = 0;
  let scrollDx = 0;
  let scrollDy = 0;
  const pointer = (dx: number, dy: number) => {
    ptrDx += dx;
    ptrDy += dy;
  };
  const scroll = (dx: number, dy: number) => {
    scrollDx += dx;
    scrollDy += dy;
  };
  const click = (b: "l" | "r" | "m") => send({ t: "click", b });
  const dragButton = (on: boolean) => send({ t: "drag", on: on ? 1 : 0 });

  /** Run a row of Omarchy's menu on the laptop. */
  const menuRun = (id: string) => {
    const item = menuItem(id);
    if (!item) return;
    send({ t: "menu", id });
    say(item.kind === "action" ? item.label : `${item.label} — on the laptop`);
  };

  // ---- popups --------------------------------------------------------------------
  const openPopup = (a: string, x: number, y: number) => {
    setPopup({ a, place: placePopup(x, y, 3), floating: isFloating(a), hot: null });
    setPopupT(0);
  };
  const popupHover = (hot: number | null) => {
    const p = popup();
    if (p && p.hot !== hot) setPopup({ ...p, hot });
  };
  const closePopup = () => setPopup(null);
  /** Rows: float / tile, full screen, close. */
  const popupRun = (row: number) => {
    const p = popup();
    if (!p) return;
    closePopup();
    if (row === 0) floatWindow(p.a);
    else if (row === 1) fullWindow(p.a);
    else if (row === 2) closeWindow(p.a);
  };

  const openCc = (ccMode: Cc["mode"], row: 0 | 1 | null = null, refX = 0) => {
    setCc({ mode: ccMode, row, refX, refLevel: row === 0 ? bri() : row === 1 ? vol() : 0, until: 0 });
    setCcT(0);
  };
  const closeCc = () => setCc(null);
  /** A finger sliding over the card: the slider row under it is adjusted
   *  relatively from where the finger entered the row. */
  const ccFollow = (x: number, y: number) => {
    const c = cc();
    if (!c) return;
    const row = ccRowAt(y);
    if (c.row !== row) {
      setCc({ ...c, row, refX: x, refLevel: row === 0 ? bri() : row === 1 ? vol() : 0 });
      return;
    }
    if (row === null) return;
    setLevel(row === 0 ? "bri" : "vol", clamp01(c.refLevel + trackDelta(x - c.refX)));
  };
  /** Release a held card: send the final level, linger, then close. */
  const ccReleased = () => {
    const c = cc();
    if (!c) return;
    if (c.row !== null) setLevel(c.row === 0 ? "bri" : "vol", c.row === 0 ? bri() : vol(), true);
    if (c.mode === "hold") setCc({ ...c, row: null, until: frameCount + CC_LINGER_FRAMES });
    else setCc({ ...c, row: null });
  };
  /** Sticky mode: a drag begins on a track. */
  const ccGrabTrack = (row: 0 | 1, x: number) => {
    const c = cc();
    if (c) setCc({ ...c, row, refX: x, refLevel: row === 0 ? bri() : vol() });
  };

  const openSheet = () => {
    setSheet({ at: MENU_ROOT, trail: [], hot: null });
    setSheetT(0);
    setSheetListT(1);
    sheetScroller.scrollTo(0, { immediate: true });
  };
  const closeSheet = () => setSheet(null);
  const sheetGo = (at: string, trail: string[]) => {
    setSheet({ at, trail, hot: null });
    setSheetListT(0);
    sheetScroller.stop();
    sheetScroller.scrollTo(0, { immediate: true });
  };
  const sheetPush = (id: string) => {
    const s = sheet();
    if (s) sheetGo(id, [...s.trail, s.at]);
  };
  const sheetBack = () => {
    const s = sheet();
    if (!s) return;
    if (s.trail.length === 0) {
      closeSheet();
      return;
    }
    const trail = s.trail.slice(0, -1);
    sheetGo(s.trail[s.trail.length - 1] ?? menuParent(s.at), trail);
  };
  const sheetHover = (hot: number | null) => {
    const s = sheet();
    if (s && s.hot !== hot) setSheet({ ...s, hot });
  };
  /** A tapped row: a submenu opens here, anything else runs on the laptop
   *  and the sheet goes away. */
  const sheetTap = (i: number) => {
    const item = sheetRows()[i];
    if (!item) return;
    if (item.kind === "menu") {
      sheetPush(item.id);
      return;
    }
    closeSheet();
    menuRun(item.id);
  };

  const openKeyFly = (fly: KeyFly) => {
    setKeyFly(fly);
    setFlyT(0);
  };
  const closeKeyFly = () => setKeyFly(null);
  const keyHover = (hot: number | null) => {
    const f = keyFly();
    if (f && f.hot !== hot) setKeyFly({ ...f, hot });
  };
  /** Release: the chosen variant, or null for none. */
  const keyRelease = (): KeyVariant | null => {
    const f = keyFly();
    if (!f) return null;
    closeKeyFly();
    return f.hot !== null ? (f.variants[f.hot] ?? null) : null;
  };

  // ---- reducer ---------------------------------------------------------------------
  const applyLine = (line: HostLine) => {
    switch (line.t) {
      case "hello":
        setHostName(line.name);
        setOmarchy(line.omarchy);
        setLink(line.auth === "ok" ? "up" : line.auth === "pending" ? "pending" : "denied");
        break;
      case "auth":
        setLink(line.auth === "ok" ? "up" : line.auth === "pending" ? "pending" : "denied");
        break;
      case "state":
        commit(line);
        break;
      case "levels":
        if (frameCount >= levelEchoHoldUntil && cc()?.row == null) {
          setVol(clamp01(line.vol));
          setMute(line.mute === 1);
          setBri(clamp01(line.bri));
        }
        break;
      case "theme":
        if (isThemeColors(line.colors)) {
          setColors(line.colors);
          paintTheme(line.colors);
        }
        setThemeName(line.name);
        if (Array.isArray(line.list)) setThemeList(line.list.filter((v): v is string => typeof v === "string"));
        break;
      case "cc":
        applyCc(line);
        break;
      case "menu":
        setMenuHidden(new Set(Array.isArray(line.hide) ? line.hide.filter((v): v is string => typeof v === "string") : []));
        setMenuChecked(new Set(Array.isArray(line.check) ? line.check.filter((v): v is string => typeof v === "string") : []));
        break;
      case "toast":
        say(line.text);
        break;
    }
  };
  const applyCc = (line: HostCc) => {
    if (line.wifi && typeof line.wifi === "object") {
      setWifi({
        on: line.wifi.on === 1,
        ssid: typeof line.wifi.ssid === "string" ? line.wifi.ssid : "",
        sig: typeof line.wifi.sig === "number" ? line.wifi.sig : 0,
      });
    }
    if (line.media && typeof line.media === "object") {
      const st = line.media.st;
      setMedia({
        st: st === "playing" || st === "paused" ? st : "none",
        title: typeof line.media.title === "string" ? line.media.title : "",
        artist: typeof line.media.artist === "string" ? line.media.artist : "",
      });
    }
  };

  // ---- frame loop ----------------------------------------------------------------------
  onFrame(() => {
    frameCount += 1;
    let moved = false;

    if (svc) {
      const up = svc.open();
      if (up && !opened) {
        opened = true;
        svc.send({ t: "hello", proto: REMOTE_PROTO, device: deviceName() });
      } else if (!up && opened) {
        opened = false;
        setLink("search");
        setState(null);
        for (const slot of slots) {
          slot.dying = true;
          slot.targetAlpha = 0;
        }
      }
      if (up) for (const line of svc.poll()) applyLine(line);
    }

    if (pendingLevel && frameCount >= levelSendAt) {
      const { rail, v } = pendingLevel;
      pendingLevel = null;
      send({ t: rail, v: Math.round(v * 100) / 100 });
      levelSendAt = frameCount + LEVEL_SEND_EVERY;
    }
    if (ptrDx !== 0 || ptrDy !== 0) {
      send({ t: "ptr", dx: Math.round(ptrDx * 10) / 10, dy: Math.round(ptrDy * 10) / 10 });
      ptrDx = 0;
      ptrDy = 0;
    }
    if (scrollDx !== 0 || scrollDy !== 0) {
      send({ t: "scroll", dx: Math.round(scrollDx), dy: Math.round(scrollDy) });
      scrollDx = 0;
      scrollDy = 0;
    }

    for (const slot of slots) {
      if (slot.a === null) continue;
      const c = slot.cur;
      const t = slot.target;
      const next: TileView = {
        x: approach(c.x, t.x),
        y: approach(c.y, t.y),
        w: approach(c.w, t.w),
        h: approach(c.h, t.h),
        alpha: slot.targetAlpha === 0 ? Math.max(0, c.alpha - 0.12) : Math.min(1, c.alpha + 0.12),
      };
      if (next.x !== c.x || next.y !== c.y || next.w !== c.w || next.h !== c.h || next.alpha !== c.alpha) {
        slot.cur = next;
        paintSlot(slot);
        moved = true;
      }
      if (slot.dying && next.alpha <= 0) {
        slot.a = null;
        slot.dying = false;
        slot.setLive(false);
      }
    }

    if (!ballDragging()) {
      const b = ball();
      const nx = approach(ballCur.x, b.x);
      const ny = approach(ballCur.y, b.y);
      if (nx !== ballCur.x || ny !== ballCur.y) {
        ballCur.x = nx;
        ballCur.y = ny;
        paintBall();
        moved = true;
      }
    }

    if (popup() && popupT() < 1) {
      setPopupT(easeProgress(popupT()));
      moved = true;
    }
    if (keyFly() && flyT() < 1) {
      setFlyT(easeProgress(flyT()));
      moved = true;
    }
    const c = cc();
    if (c) {
      if (ccT() < 1) {
        setCcT(easeProgress(ccT()));
        moved = true;
      }
      if (c.mode === "hold" && c.row === null && c.until > 0 && frameCount >= c.until) setCc(null);
    }
    if (sheet()) {
      if (sheetT() < 1) {
        setSheetT(easeProgress(sheetT()));
        moved = true;
      }
      if (sheetListT() < 1) {
        setSheetListT(easeProgress(sheetListT()));
        moved = true;
      }
      sheetScroller.step();
    }

    // Press depth: a quick attack while held, a soft release after.
    const target = pressHeld ? 1 : 0;
    const depth = pressT();
    if (depth !== target) {
      const next = target === 1 ? Math.min(1, depth + (1 - depth) * 0.55 + 0.02) : depth * 0.72;
      if (next < 0.02 && target === 0) {
        setPressT(0);
        setPressed(null);
      } else setPressT(next);
      moved = true;
    }

    if (toast() !== "" && frameCount >= toastUntil) setToast("");
    if (moved) setFrame(frameCount);
  });

  // ---- press feedback ----------------------------------------------------------------------
  const pressDown = (id: string | null) => {
    pressHeld = id !== null;
    setPressed(id);
    if (id === null) setPressT(0);
  };
  const pressRelease = () => {
    // The depth eases back to zero and clears the target when it gets there,
    // so a tap that lands and lifts inside one frame still shows.
    pressHeld = false;
  };

  /** Ref for a tile slot's node: binds it and paints the current geometry. */
  const bindSlot = (slot: TileSlot) => (node: NodeMirror) => {
    slot.node = node;
    paintSlot(slot);
  };

  return {
    svc,
    bindSlot,
    link,
    hostName,
    omarchy,
    state,
    tabs,
    layout,
    fit,
    focusTitle,
    focusClass,
    vol,
    mute,
    bri,
    themeName,
    themeList,
    colors,
    wifi,
    media,
    menuHidden,
    menuChecked,
    slots,
    tilesForHit,
    windowAt: (x: number, y: number) => windowAt(x, y, tilesForHit()),
    isFloating,
    mode,
    setMode,
    kbLayer,
    setKbLayer,
    kbMods,
    setKbMods,
    pressed,
    pressT,
    pressDown,
    pressRelease,
    drag,
    setDrag,
    ball,
    ballDragging,
    bindBall,
    ballGrab,
    ballDragTo,
    ballRelease,
    ballSize: BALL,
    popup,
    popupT,
    openPopup,
    popupHover,
    popupRun,
    closePopup,
    cc,
    ccT,
    openCc,
    closeCc,
    ccFollow,
    ccReleased,
    ccGrabTrack,
    sheet,
    sheetT,
    sheetListT,
    sheetRows,
    sheetScroller,
    openSheet,
    closeSheet,
    sheetPush,
    sheetBack,
    sheetHover,
    sheetTap,
    keyFly,
    flyT,
    openKeyFly,
    closeKeyFly,
    keyHover,
    keyRelease,
    toast,
    say,
    frame,
    act,
    workspace,
    workspaceStep,
    focusWindow,
    closeWindow,
    swapWindows,
    moveWindow,
    floatWindow,
    fullWindow,
    placeBegin,
    placeTo,
    placeCancel,
    setLevel,
    toggleMute,
    mediaOp,
    wifiToggle,
    typeText,
    typeKey,
    pointer,
    scroll,
    click,
    dragButton,
    menuRun,
    applyLine,
    send,
  };
}
