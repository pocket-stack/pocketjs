// apps/pocket-shell/store.ts — the shell's live state: the window manager
// wrapped in signals, the per-frame input dispatcher that turns shoulder
// chords into actions, window geometry animation, and the applet states the
// windows render. Everything the two screens show reads from here.
//
// Reactivity is coarse on purpose. `rev` bumps after every structural change
// (open, close, focus, layout) and `frame` bumps only on frames where
// something is still moving, so an idle shell re-evaluates nothing.

import { createMemo, createSignal } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework";
import { chordsOf, keySheet, layerOf, type ActionId, type Layer } from "./chords.ts";
import { CLEAR, civilFromEpoch, complete, detectOffsetMinutes, run as runShell, type CivilTime, type ShellApi } from "./shell.ts";
import { WindowManager, WORKSPACES, type Placement, type Rect } from "./wm.ts";

export type AppId = "term" | "clock" | "notes" | "keys" | "stats" | "about";
export const APPS: readonly AppId[] = ["term", "clock", "notes", "keys", "stats", "about"];
/** Short enough for the launcher's 96 px card. */
export const APP_BLURB: Record<AppId, string> = {
  term: "pocketsh",
  clock: "time and date",
  notes: "scratch pad",
  keys: "chord table",
  stats: "frames, host",
  about: "what this is",
};

export const WALLPAPERS = ["road", "lake", "swirl"] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export const isTextApp = (app: AppId | undefined): boolean => app === "term" || app === "notes";

export interface TermState {
  kind: "term";
  lines: string[];
  input: string;
  history: string[];
  /** history.length when not browsing. */
  histIdx: number;
  /** Lines scrolled up from the bottom. */
  scroll: number;
}
export interface NotesState {
  kind: "notes";
  text: string;
  scroll: number;
}
export interface ClockState {
  kind: "clock";
  hour12: boolean;
}
export interface KeysState {
  kind: "keys";
  scroll: number;
}
export interface PlainState {
  kind: "stats" | "about";
}
export type AppletState = TermState | NotesState | ClockState | KeysState | PlainState;

export interface Anim {
  cur: Rect;
  alpha: number;
}

export interface Ghost {
  rect: Rect;
  alpha: number;
}

export interface Drag {
  id: number;
  /** Finger position in stage coordinates. */
  x: number;
  y: number;
  /** A window the finger is over (swap target). */
  over: number | null;
  /** A workspace tab the finger is over (move target). */
  overWs: number | null;
}

export type KbLayer = "lower" | "upper" | "sym";

const PROMPT = "❯ ";
const MAX_LINES = 200;
const TOAST_FRAMES = 100;
const EASE = 0.35;
const SLIDE_PX = 48;
const MAX_LAUNCHER_INDEX = APPS.length - 1;
const LAUNCHER_COLS = 3;
const DEAD_ZONE = 0.25;
const RESIZE_PX = 3;
const SCROLL_PX = 6;

function initialState(app: AppId): AppletState {
  switch (app) {
    case "term":
      return {
        kind: "term",
        lines: ["pocketsh — type help, or hold L", ""],
        input: "",
        history: [],
        histIdx: 0,
        scroll: 0,
      };
    case "notes":
      return { kind: "notes", text: "", scroll: 0 };
    case "clock":
      return { kind: "clock", hour12: false };
    case "keys":
      return { kind: "keys", scroll: 0 };
    case "stats":
    case "about":
      return { kind: app };
  }
}

const lerp = (a: number, b: number): number => {
  const next = a + (b - a) * EASE;
  return Math.abs(b - next) < 0.5 ? b : next;
};

const shrink = (r: Rect, by: number): Rect => ({
  x: r.x + r.w * by * 0.5,
  y: r.y + r.h * by * 0.5,
  w: r.w * (1 - by),
  h: r.h * (1 - by),
});

export type ShellStore = ReturnType<typeof createShellStore>;

export function createShellStore() {
  const wm = new WindowManager<AppId>();
  const applets = new Map<number, AppletState>();
  const anims = new Map<number, Anim>();
  let ghosts: Ghost[] = [];

  // The RTC's epoch is trustworthy; QuickJS's breakdown of it on this device
  // is not (see civilFromEpoch). Read the zone once, then do the arithmetic.
  const detectedOffset = (() => {
    try {
      const ms = Date.now();
      return detectOffsetMinutes(ms, new Date(ms));
    } catch {
      return 0;
    }
  })();

  const [offsetMinutes, setOffsetMinutes] = createSignal(detectedOffset);
  const [rev, setRev] = createSignal(0);
  const bump = () => setRev((r) => r + 1);
  const [frame, setFrame] = createSignal(0);
  const [epochSecond, setEpochSecond] = createSignal(0);
  const [layer, setLayer] = createSignal<Layer>("plain");
  const [latchL, setLatchL] = createSignal(false);
  const [latchR, setLatchR] = createSignal(false);
  const [launcherOpen, setLauncherOpen] = createSignal(false);
  const [launcherIndex, setLauncherIndex] = createSignal(0);
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [kbOpen, setKbOpen] = createSignal(false);
  const [kbLayer, setKbLayer] = createSignal<KbLayer>("lower");
  const [wallpaper, setWallpaper] = createSignal<Wallpaper>("road");
  const [toast, setToast] = createSignal("");
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [closing, setClosing] = createSignal<{ id: number; over: boolean } | null>(null);
  const [closeAnim, setCloseAnim] = createSignal(0);
  const [fps, setFps] = createSignal(0);

  let frames = 0;
  let toastFrames = 0;
  let slide = 0;
  let prevButtons = 0;
  let lastSecond = -1;
  let fpsFrames = 0;
  let fpsStamp = 0;

  // ---- derived -----------------------------------------------------------------

  const active = createMemo(() => {
    rev();
    return wm.active;
  });
  // The active Workspace is one mutable object, so identity never changes:
  // opt out of the memo's equality check or nothing downstream re-reads it.
  const workspace = createMemo(
    () => {
      rev();
      return wm.workspace();
    },
    undefined,
    { equals: false },
  );
  const placements = createMemo<Placement[]>(() => {
    rev();
    return wm.placements();
  });
  const order = createMemo(() => {
    rev();
    return wm.order();
  });
  const focusedId = createMemo(() => {
    rev();
    return wm.workspace().focus;
  });
  const focusedApp = createMemo(() => {
    const id = focusedId();
    return id === null ? undefined : wm.windows.get(id)?.app;
  });
  const counts = createMemo(() => {
    rev();
    return wm.workspaces.map((ws) => wm.count(ws));
  });
  const layoutKind = createMemo(() => workspace().layout);
  const barVisible = createMemo(() => {
    rev();
    return wm.barVisible;
  });
  const kbVisible = createMemo(() => kbOpen() && isTextApp(focusedApp()));
  const now = createMemo<CivilTime>(() => civilFromEpoch(epochSecond() * 1000, offsetMinutes()));

  const placementOf = (id: number): Placement | undefined => placements().find((p) => p.id === id);
  const windowOf = (id: number) => wm.windows.get(id);
  const stateOf = (id: number): AppletState | undefined => applets.get(id);
  /** Animated geometry for the stage; snaps to the target when unknown. */
  const animOf = (id: number): Anim => {
    frame();
    const anim = anims.get(id);
    if (anim) return anim;
    const target = wm.placement(id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    return { cur: target, alpha: 1 };
  };
  const ghostList = (): Ghost[] => {
    frame();
    return ghosts;
  };
  const slideOffset = (): number => {
    frame();
    return slide;
  };
  const uptimeSeconds = (): number => frames / 60;
  const frameCount = (): number => {
    frame();
    return frames;
  };

  // ---- mutations -----------------------------------------------------------------

  const say = (message: string) => {
    setToast(message);
    toastFrames = TOAST_FRAMES;
  };

  const open = (app: AppId, wsId: number = wm.active): number => {
    const id = wm.open(app, wsId);
    applets.set(id, initialState(app));
    const target = wm.placement(id)?.rect;
    if (target) anims.set(id, { cur: shrink(target, 0.12), alpha: 0 });
    bump();
    return id;
  };

  const close = (id: number | null = wm.workspace().focus): boolean => {
    if (id === null) return false;
    const anim = anims.get(id);
    const win = wm.windows.get(id);
    const onStage = win?.ws === wm.active;
    if (!wm.close(id)) return false;
    if (anim && onStage) ghosts = [...ghosts, { rect: anim.cur, alpha: anim.alpha }];
    anims.delete(id);
    applets.delete(id);
    bump();
    return true;
  };

  const focusWin = (id: number) => {
    wm.focusWin(id);
    bump();
  };

  const switchWs = (id: number) => {
    if (id < 1 || id > WORKSPACES || id === wm.active) return;
    slide = (id > wm.active ? 1 : -1) * SLIDE_PX;
    wm.switchWs(id);
    snapWorkspace();
    say(`workspace ${id}`);
    bump();
  };

  /** Windows arriving on stage start from their target, offset by the slide. */
  const snapWorkspace = () => {
    for (const p of wm.placements()) {
      anims.set(p.id, { cur: { ...p.rect, x: p.rect.x + slide }, alpha: p.hidden ? 0 : 1 });
    }
  };

  const toggleLayout = () => {
    const kind = wm.toggleLayout();
    say(`layout: ${kind}`);
    bump();
  };

  const nextWallpaper = (): Wallpaper => {
    const next = WALLPAPERS[(WALLPAPERS.indexOf(wallpaper()) + 1) % WALLPAPERS.length];
    setWallpaper(next);
    return next;
  };

  const toggleKeyboard = () => {
    if (!isTextApp(focusedApp())) {
      say("the keyboard types into term or notes");
      return;
    }
    setKbOpen(!kbOpen());
  };

  const run = (action: ActionId): void => {
    switch (action) {
      case "focus.left":
      case "focus.right":
      case "focus.up":
      case "focus.down": {
        const dir = action.slice(6) as "left" | "right" | "up" | "down";
        if (!wm.focusDir(dir)) say(wm.count() === 0 ? "empty workspace — L+A launches" : `nothing ${dir}`);
        break;
      }
      case "swap.left":
      case "swap.right":
      case "swap.up":
      case "swap.down": {
        const dir = action.slice(5) as "left" | "right" | "up" | "down";
        if (!wm.swapDir(dir)) say(`nothing to swap ${dir}`);
        break;
      }
      case "ws.prev":
      case "ws.next": {
        const next = wm.active + (action === "ws.next" ? 1 : -1);
        if (next < 1 || next > WORKSPACES) say(`workspace ${wm.active} is the ${next < 1 ? "first" : "last"}`);
        else switchWs(next);
        return;
      }
      case "carry.prev":
      case "carry.next": {
        const delta = action === "carry.next" ? 1 : -1;
        const from = wm.active;
        if (wm.carryWs(delta)) {
          slide = delta * SLIDE_PX;
          snapWorkspace();
          say(`carried to workspace ${wm.active}`);
        } else {
          say(wm.workspace().focus === null ? "nothing to carry" : `workspace ${from} is the ${delta < 0 ? "first" : "last"}`);
        }
        break;
      }
      case "launcher":
        setLauncherOpen(!launcherOpen());
        setKeysOpen(false);
        return;
      case "close":
        if (!close()) say("nothing to close");
        return;
      case "fullscreen":
        if (!wm.toggleFullscreen("full")) say("nothing to fill the screen with");
        break;
      case "maximize":
        if (!wm.toggleFullscreen("max")) say("nothing to maximize");
        break;
      case "split":
        if (wm.workspace().layout === "dwindle") {
          if (!wm.toggleSplit()) say("a split needs two windows");
        } else if (!wm.cycleColumnWidth()) say("no column focused");
        break;
      case "swapsplit":
        if (wm.workspace().layout === "dwindle") {
          if (!wm.swapSplit()) say("a split needs two windows");
        } else if (!wm.consumeOrExpel()) say("nothing to stack with");
        break;
      case "layout":
        toggleLayout();
        return;
      case "keys":
        setKeysOpen(!keysOpen());
        setLauncherOpen(false);
        return;
      case "another": {
        const app = focusedApp();
        if (app) open(app);
        else say("focus a window to open another of it");
        return;
      }
      case "reopen": {
        const id = wm.reopen();
        if (id === null) say("nothing to reopen");
        else {
          applets.set(id, initialState(wm.windows.get(id)!.app));
          const target = wm.placement(id)?.rect;
          if (target) anims.set(id, { cur: shrink(target, 0.12), alpha: 0 });
        }
        break;
      }
      case "wallpaper":
        say(`wallpaper: ${nextWallpaper()}`);
        return;
      case "bar":
        wm.toggleBar();
        break;
    }
    bump();
  };

  // ---- text input ----------------------------------------------------------------

  const focusedText = (): TermState | NotesState | null => {
    const id = wm.workspace().focus;
    const state = id === null ? undefined : applets.get(id);
    return state && (state.kind === "term" || state.kind === "notes") ? state : null;
  };

  const shellApi: ShellApi = {
    apps: () => APPS,
    windows: () =>
      [...wm.windows.values()].map((w) => ({
        id: w.id,
        app: w.app,
        title: w.title,
        ws: w.ws,
        focused: wm.workspace(w.ws).focus === w.id,
      })),
    workspace: () => wm.active,
    layout: () => wm.workspace().layout,
    wallpaper: () => wallpaper(),
    uptimeSeconds,
    now: () => civilFromEpoch(Date.now(), offsetMinutes()),
    host: () => getOps().__host ?? "3ds",
    open: (app) => (APPS.includes(app as AppId) ? open(app as AppId) : null),
    close: (id) => close(id ?? wm.workspace().focus),
    focus: (id) => {
      if (!wm.windows.has(id)) return false;
      focusWin(id);
      return true;
    },
    switchWs: (id) => {
      if (!Number.isInteger(id) || id < 1 || id > WORKSPACES) return false;
      switchWs(id);
      return true;
    },
    setLayout: (kind) => {
      if (wm.workspace().layout !== kind) toggleLayout();
    },
    nextWallpaper,
    timezone: () => offsetMinutes(),
    setTimezone: (minutes) => setOffsetMinutes(minutes),
    keys: () => keySheet(wm.workspace().layout),
  };

  const termSubmit = (term: TermState) => {
    const line = term.input;
    term.lines.push(PROMPT + line);
    const out = runShell(line, shellApi);
    if (out.length === 1 && out[0] === CLEAR) term.lines = [];
    else term.lines.push(...out);
    if (term.lines.length > MAX_LINES) term.lines.splice(0, term.lines.length - MAX_LINES);
    if (line.trim()) term.history.push(line);
    term.histIdx = term.history.length;
    term.input = "";
    term.scroll = 0;
  };

  const termComplete = (term: TermState) => {
    const word = term.input.trimStart();
    if (word.includes(" ")) return;
    const matches = complete(word);
    if (matches.length === 1) term.input = matches[0] + " ";
    else if (matches.length > 1) term.lines.push(matches.join("  "));
  };

  const termHistory = (term: TermState, delta: number) => {
    const next = Math.max(0, Math.min(term.history.length, term.histIdx + delta));
    term.histIdx = next;
    term.input = next === term.history.length ? "" : term.history[next];
  };

  /** A character from the deck keyboard, into whichever text applet has focus. */
  const typeChar = (ch: string) => {
    const state = focusedText();
    if (!state) return;
    if (state.kind === "term") state.input += ch;
    else state.text += ch;
    bump();
  };

  const typeKey = (key: "enter" | "backspace" | "space" | "tab") => {
    const state = focusedText();
    if (!state) return;
    if (state.kind === "term") {
      if (key === "enter") termSubmit(state);
      else if (key === "backspace") state.input = state.input.slice(0, -1);
      else if (key === "space") state.input += " ";
      else termComplete(state);
    } else {
      if (key === "enter") state.text += "\n";
      else if (key === "backspace") state.text = state.text.slice(0, -1);
      else if (key === "space") state.text += " ";
      else state.text += "  ";
    }
    bump();
  };

  // ---- plain-layer buttons: the focused applet's ---------------------------------

  const plainInput = (pressed: number) => {
    if (launcherOpen()) {
      let index = launcherIndex();
      if (pressed & BTN.LEFT) index -= 1;
      if (pressed & BTN.RIGHT) index += 1;
      if (pressed & BTN.UP) index -= LAUNCHER_COLS;
      if (pressed & BTN.DOWN) index += LAUNCHER_COLS;
      setLauncherIndex(Math.max(0, Math.min(MAX_LAUNCHER_INDEX, index)));
      if (pressed & BTN.CIRCLE) {
        open(APPS[launcherIndex()]);
        setLauncherOpen(false);
      }
      if (pressed & BTN.CROSS) setLauncherOpen(false);
      return;
    }
    if (keysOpen()) {
      if (pressed & (BTN.CROSS | BTN.SELECT | BTN.CIRCLE)) setKeysOpen(false);
      return;
    }
    if (pressed & BTN.SELECT) {
      toggleKeyboard();
      return;
    }
    const id = wm.workspace().focus;
    const state = id === null ? undefined : applets.get(id);
    if (!state) return;
    switch (state.kind) {
      case "term":
        if (pressed & BTN.CIRCLE) termSubmit(state);
        if (pressed & BTN.CROSS) state.input = state.input.slice(0, -1);
        if (pressed & BTN.TRIANGLE) termComplete(state);
        if (pressed & BTN.SQUARE) state.input += " ";
        if (pressed & BTN.UP) termHistory(state, -1);
        if (pressed & BTN.DOWN) termHistory(state, 1);
        if (pressed & BTN.START) {
          state.lines = [];
          state.scroll = 0;
        }
        break;
      case "notes":
        if (pressed & BTN.CIRCLE) state.text += "\n";
        if (pressed & BTN.CROSS) state.text = state.text.slice(0, -1);
        if (pressed & BTN.SQUARE) state.text += " ";
        break;
      case "clock":
        if (pressed & BTN.CIRCLE) state.hour12 = !state.hour12;
        break;
      case "keys":
        if (pressed & BTN.UP) state.scroll = Math.max(0, state.scroll - 1);
        if (pressed & BTN.DOWN) state.scroll += 1;
        break;
      default:
        return;
    }
    bump();
  };

  const scrollApplet = (lines: number) => {
    const id = wm.workspace().focus;
    const state = id === null ? undefined : applets.get(id);
    if (!state) return;
    if (state.kind === "term" || state.kind === "notes" || state.kind === "keys") {
      state.scroll = Math.max(0, state.scroll + lines);
      bump();
    }
  };

  // ---- the frame -------------------------------------------------------------------

  let scrollCarry = 0;

  onFrame((buttons) => {
    frames++;

    // Wall clock, once a second.
    const nowSecond = Math.floor(Date.now() / 1000);
    if (nowSecond !== lastSecond) {
      lastSecond = nowSecond;
      setEpochSecond(nowSecond);
      const stamp = Date.now();
      if (fpsStamp > 0) setFps(Math.round((fpsFrames * 1000) / Math.max(1, stamp - fpsStamp)));
      fpsStamp = stamp;
      fpsFrames = 0;
    }
    fpsFrames++;

    const held = buttons | (latchL() ? BTN.LTRIGGER : 0) | (latchR() ? BTN.RTRIGGER : 0);
    const currentLayer = layerOf(held);
    if (currentLayer !== layer()) setLayer(currentLayer);
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;

    let consumed = false;
    if (currentLayer === "plain") {
      plainInput(pressed);
    } else {
      for (const chord of chordsOf(currentLayer)) {
        if (pressed & chord.button) {
          run(chord.action);
          consumed = true;
        }
      }
    }
    if (consumed && (latchL() || latchR())) {
      setLatchL(false);
      setLatchR(false);
    }

    // The circle pad: resize under L, pan the strip under R, scroll the applet plain.
    const ax = analogX();
    const ay = analogY();
    const px = Math.abs(ax) > DEAD_ZONE ? ax : 0;
    const py = Math.abs(ay) > DEAD_ZONE ? ay : 0;
    if (px !== 0 || py !== 0) {
      if (currentLayer === "super") {
        wm.resize(px * RESIZE_PX, py * RESIZE_PX);
        bump();
      } else if (currentLayer === "shift") {
        if (wm.workspace().layout === "scrolling" && px !== 0) {
          wm.scrollBy(px * SCROLL_PX);
          bump();
        }
      } else if (currentLayer === "plain" && py !== 0) {
        scrollCarry += -py * 0.4;
        const lines = Math.trunc(scrollCarry);
        if (lines !== 0) {
          scrollCarry -= lines;
          scrollApplet(lines);
        }
      }
    } else {
      scrollCarry = 0;
    }

    // Geometry animation for the stage.
    let moving = false;
    for (const p of wm.placements()) {
      let anim = anims.get(p.id);
      if (!anim) {
        anim = { cur: { ...p.rect }, alpha: p.hidden ? 0 : 1 };
        anims.set(p.id, anim);
      }
      const targetAlpha = p.hidden ? 0 : 1;
      const cur = anim.cur;
      const next = {
        x: lerp(cur.x, p.rect.x),
        y: lerp(cur.y, p.rect.y),
        w: lerp(cur.w, p.rect.w),
        h: lerp(cur.h, p.rect.h),
      };
      const alpha = Math.abs(targetAlpha - anim.alpha) < 0.05 ? targetAlpha : anim.alpha + (targetAlpha - anim.alpha) * EASE;
      if (next.x !== cur.x || next.y !== cur.y || next.w !== cur.w || next.h !== cur.h || alpha !== anim.alpha) {
        anim.cur = next;
        anim.alpha = alpha;
        moving = true;
      }
    }
    if (ghosts.length > 0) {
      ghosts = ghosts
        .map((g) => ({ rect: shrink(g.rect, 0.04), alpha: g.alpha - 0.1 }))
        .filter((g) => g.alpha > 0);
      moving = true;
    }
    if (slide !== 0) {
      slide *= 0.7;
      if (Math.abs(slide) < 0.5) slide = 0;
      moving = true;
    }
    if (toastFrames > 0) {
      toastFrames--;
      if (toastFrames === 0) setToast("");
    }
    const closeTarget = closing() ? 1 : 0;
    if (closeAnim() !== closeTarget) {
      const step = 1 / 6;
      setCloseAnim(closeTarget > closeAnim() ? Math.min(1, closeAnim() + step) : Math.max(0, closeAnim() - step));
    }
    if (moving) setFrame(frames);
  });

  return {
    wm,
    rev,
    frame,
    frameCount,
    epochSecond,
    now,
    fps,
    uptimeSeconds,
    layer,
    latchL,
    setLatchL,
    latchR,
    setLatchR,
    launcherOpen,
    setLauncherOpen,
    launcherIndex,
    setLauncherIndex,
    keysOpen,
    setKeysOpen,
    kbOpen,
    setKbOpen,
    kbVisible,
    kbLayer,
    setKbLayer,
    wallpaper,
    offsetMinutes,
    toast,
    say,
    drag,
    setDrag,
    closing,
    setClosing,
    closeAnim,
    active,
    workspace,
    layoutKind,
    barVisible,
    placements,
    placementOf,
    order,
    focusedId,
    focusedApp,
    counts,
    windowOf,
    stateOf,
    animOf,
    ghostList,
    slideOffset,
    open,
    close,
    focusWin,
    switchWs,
    toggleLayout,
    toggleKeyboard,
    run,
    typeChar,
    typeKey,
    bump,
  };
}
