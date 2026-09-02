// apps/pocket-remote/store.ts — the remote's live state: the link to the
// daemon, the mirrored desktop (workspaces, windows, levels, theme), the
// tile slot pool that animates the stage, the hold-and-slide flyouts, and
// the senders every touch target calls. Everything the screen shows reads
// from here; nothing here knows about pixels except the tile pool and the
// flyout progress, which own motion.
//
// Reactivity is coarse on purpose: a snapshot replaces one signal, tiles
// live in a fixed pool of per-slot signals so a frame in which one window
// moves re-renders one node, and idle frames write nothing.

import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import { getOps } from "@pocketjs/framework";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { type ActionId, actionById, MENU_ROUTES } from "./actions.ts";
import {
  approach,
  CARD_LINGER_FRAMES,
  CLOSE_HOLD_SECONDS,
  clamp01,
  easeProgress,
  fitMonitor,
  type Rect,
  stageWindows,
  stripTabs,
  swapDirection,
  type Tab,
  TILE_SLOTS,
  TILE_TWO_LINES_H,
  tileRect,
  windowAt,
} from "./layout.ts";
import {
  type ClientLine,
  type Direction,
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

export interface Drag {
  a: string;
  x: number;
  y: number;
  /** Tile under the finger (not the dragged one). */
  over: string | null;
  /** Workspace tab under the finger. */
  overWs: number | null;
}

export interface Closing {
  a: string;
  /** 0..1 of CLOSE_HOLD_SECONDS. */
  progress: number;
}

/**
 * The levels card: brightness and volume, the control-centre control. Opened
 * sticky by a tap on the dock (tap outside closes) or by hold-and-slide (the
 * finger that opened it adjusts, release lingers then closes).
 */
export interface Card {
  mode: "sticky" | "hold";
  /** Row the sliding finger is on (hold mode) or dragging (sticky mode). */
  row: 0 | 1 | null;
  /** Finger x and level when the current row was entered — drags are relative. */
  refX: number;
  refLevel: number;
  /** Frame after which a released hold card closes. */
  until: number;
}

/** The Menu key's cascade: routes in column one, the hot route's leaves in
 *  column two. `hot` / `leaf` are what is under the finger. */
export interface MenuFly {
  kind: "menu";
  hot: number | null;
  leaf: number | null;
  /** Route whose leaves column two shows (sticks while the finger crosses). */
  open: number | null;
}

/** A held key's modifier variants (ctrl+x, alt+x, F-keys). */
export interface KeyVariant {
  label: string;
  k: string;
  mods: Modifier[];
}

export interface KeyFly {
  kind: "keyvar";
  /** Screen-space rect of the held key. */
  key: Rect;
  variants: KeyVariant[];
  hot: number | null;
}

export type Flyout = MenuFly | KeyFly;

export type KbLayer = "lower" | "upper" | "sym";

const TOAST_FRAMES = 150;
/** Frames between level sends while a slider is being dragged. */
const LEVEL_SEND_EVERY = 3;
/** Frames after a slider release during which host echoes are ignored. */
const LEVEL_ECHO_HOLD = 30;

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

  // ---- ui --------------------------------------------------------------------
  const [pad, setPad] = createSignal<number | null>(null);
  const [kb, setKb] = createSignal(false);
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  const [kbMods, setKbMods] = createSignal<Modifier[]>([]);
  const [pressed, setPressed] = createSignal<string | null>(null);
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [closing, setClosing] = createSignal<Closing | null>(null);
  const [card, setCard] = createSignal<Card | null>(null);
  const [flyout, setFlyout] = createSignal<Flyout | null>(null);
  /** 0..1 progress of the open flyout (drives its entrance). */
  const [flyT, setFlyT] = createSignal(0);
  /** 0..1 progress of the menu's second column, restarted per route. */
  const [flyT2, setFlyT2] = createSignal(0);
  const [cardT, setCardT] = createSignal(0);
  const [toast, setToast] = createSignal("");
  const [frame, setFrame] = createSignal(0);
  let toastUntil = 0;
  let frameCount = 0;
  let pressLinger = 0;

  const say = (text: string) => {
    setToast(text);
    toastUntil = frameCount + TOAST_FRAMES;
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

  /** Re-target the pool from a snapshot: keep slots by address, fade new
   *  windows in where they belong, fade vanished ones out in place. */
  const retarget = (s: HostState) => {
    const fit = fitMonitor(s.mon);
    const shown = stageWindows(s);
    const seen = new Set<string>();
    batch(() => {
      for (const win of shown) {
        seen.add(win.a);
        const rect = tileRect(win, fit);
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
        slot.target = rect;
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
  const media = (op: "play" | "next" | "prev") => send({ t: "media", op });
  const typeText = (text: string) => send({ t: "type", text });
  const typeKey = (k: string, mods: Modifier[] = []) => send(mods.length ? { t: "key", k, mods } : { t: "key", k });
  const chooseTheme = (name: string) => {
    send({ t: "theme", name });
    say(name);
  };

  // ---- card + flyouts --------------------------------------------------------------
  const openCard = (mode: Card["mode"], row: 0 | 1 | null = null, refX = 0) => {
    setCard({ mode, row, refX, refLevel: row === 0 ? bri() : row === 1 ? vol() : 0, until: 0 });
    setCardT(0);
  };
  const closeCard = () => setCard(null);
  /** Release a held card: linger, then close on its own. */
  const cardReleased = () => {
    const c = card();
    if (!c) return;
    if (c.mode === "hold") setCard({ ...c, row: null, until: frameCount + CARD_LINGER_FRAMES });
    else setCard({ ...c, row: null });
  };

  const openFlyout = (fly: Flyout) => {
    setFlyout(fly);
    setFlyT(0);
    setFlyT2(0);
  };
  const closeFlyout = () => setFlyout(null);

  /** Menu cascade: move the finger. Column two follows the hot route and
   *  restarts its entrance when the route changes. */
  const menuHover = (hot: number | null, leaf: number | null) => {
    const f = flyout();
    if (!f || f.kind !== "menu") return;
    let open = f.open;
    if (hot !== null && hot !== f.open) {
      open = hot;
      setFlyT2(0);
    }
    if (hot !== f.hot || leaf !== f.leaf || open !== f.open) setFlyout({ kind: "menu", hot, leaf, open });
  };

  /** Menu cascade: release. A leaf runs; a route opens on the desktop. */
  const menuRelease = () => {
    const f = flyout();
    if (!f || f.kind !== "menu") return;
    closeFlyout();
    if (f.leaf !== null && f.open !== null) {
      const id = MENU_ROUTES[f.open]?.leaves[f.leaf];
      if (id) act(id);
      return;
    }
    if (f.hot !== null) {
      const route = MENU_ROUTES[f.hot];
      if (route) act(route.id);
    }
  };

  const keyHover = (hot: number | null) => {
    const f = flyout();
    if (!f || f.kind !== "keyvar" || f.hot === hot) return;
    setFlyout({ ...f, hot });
  };

  /** Key variants: release. Returns the chosen variant, or null for none. */
  const keyRelease = (): KeyVariant | null => {
    const f = flyout();
    if (!f || f.kind !== "keyvar") return null;
    closeFlyout();
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
        if (frameCount >= levelEchoHoldUntil && card()?.row == null) {
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
      case "toast":
        say(line.text);
        break;
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

    const hold = closing();
    if (hold) {
      const progress = Math.min(1, hold.progress + 1 / (60 * CLOSE_HOLD_SECONDS));
      setClosing({ a: hold.a, progress });
      if (progress >= 1) {
        closeWindow(hold.a);
        setClosing(null);
      }
      moved = true;
    }

    if (flyout()) {
      if (flyT() < 1) {
        setFlyT(easeProgress(flyT()));
        moved = true;
      }
      if (flyT2() < 1) {
        setFlyT2(easeProgress(flyT2()));
        moved = true;
      }
    }
    const c = card();
    if (c) {
      if (cardT() < 1) {
        setCardT(easeProgress(cardT()));
        moved = true;
      }
      if (c.mode === "hold" && c.row === null && c.until > 0 && frameCount >= c.until) setCard(null);
    }

    if (pressLinger > 0) {
      pressLinger -= 1;
      if (pressLinger === 0) setPressed(null);
    }
    if (toast() !== "" && frameCount >= toastUntil) setToast("");
    if (moved) setFrame(frameCount);
  });

  // ---- press feedback ----------------------------------------------------------------------
  const pressDown = (id: string | null) => {
    pressLinger = 0;
    setPressed(id);
  };
  const pressRelease = () => {
    // Linger a few frames so a tap that lands and lifts inside one frame
    // still shows.
    if (pressed() !== null) pressLinger = 5;
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
    focusTitle,
    focusClass,
    vol,
    mute,
    bri,
    themeName,
    themeList,
    colors,
    slots,
    tilesForHit,
    windowAt: (x: number, y: number) => windowAt(x, y, tilesForHit()),
    pad,
    setPad,
    kb,
    setKb,
    kbLayer,
    setKbLayer,
    kbMods,
    setKbMods,
    pressed,
    pressDown,
    pressRelease,
    drag,
    setDrag,
    closing,
    setClosing,
    card,
    setCard,
    openCard,
    closeCard,
    cardReleased,
    cardT,
    flyout,
    openFlyout,
    closeFlyout,
    flyT,
    flyT2,
    menuHover,
    menuRelease,
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
    setLevel,
    toggleMute,
    media,
    typeText,
    typeKey,
    chooseTheme,
    applyLine,
    send,
  };
}
