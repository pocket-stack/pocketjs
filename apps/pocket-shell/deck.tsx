// apps/pocket-shell/deck.tsx — the touch screen. Omarchy's SUPER key is a
// key; here it is a surface. The deck always shows the workspace strip, a
// live minimap of the top screen, and the dock, and it re-labels itself the
// moment a shoulder goes down: the minimap gives way to the chord map for
// the held layer, which is Omarchy's SUPER+K menu appearing exactly when the
// modifier that needs it is pressed. Every row of that map is also a tap
// target, and the L/R pills latch a layer for one action, so a stylus can
// complete any chord on its own.
//
// Minimap touch: tap focuses, hold arms the close bar (release on it to
// close — a resistive panel and a coin-flip × are how shells get killed),
// drag a window onto another to swap or onto a workspace tab to move it,
// drag the gap between two windows to resize the split, and in the
// scrolling layout drag the background to pan the strip.

import { createSignal, For, Index, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  BUTTON_GLYPH,
  chordFor,
  dpadLabel,
  FACE_ORDER,
  labelFor,
  LAYER_HINT,
  LAYER_TITLE,
  padLabel,
  type ActionId,
  type Layer,
} from "./chords.ts";
import { Keyboard, keyboardHit, createKeyPress } from "./keyboard.tsx";
import { APP_BLURB, APPS, isTextApp, type AppId, type ShellStore } from "./store.ts";
import { BTN } from "@pocketjs/framework/input";
import { BAR_H, WORKSPACES, type Rect } from "./wm.ts";

const STRIP_H = 24;
const PILL_W = 28;
const TABS_X = 28;
const TAB_W = 40;
const BADGE_X = 228;
const BADGE_W = 64;
const R_PILL_X = 292;

const BODY_TOP = 24;
const BODY_BOTTOM = 200;

const S = 0.6;
const MAP_X = 40;
const MAP_Y = 30;
const MAP_W = 240;
const MAP_H = 144;
const MAP_RECT: Rect = { x: MAP_X, y: MAP_Y, w: MAP_W, h: MAP_H };
const HINT_Y = 180;
const CLOSE_BAR_H = 44;
const CLOSE_BAR_Y = BODY_BOTTOM - CLOSE_BAR_H;
const CLOSE_HOLD_SECONDS = 0.4;

const DOCK_Y = 200;
const DOCK_X = 16;
const DOCK_CELL = 48;

const GUTTER_BTN_W = 32;
const GUTTER_BTN_H = 22;
interface GutterButton {
  x: number;
  y: number;
  label: string;
  act: "kbd" | "wall" | "keys" | "bar";
}
const GUTTER_BUTTONS: GutterButton[] = [
  { x: 4, y: 34, label: "kbd", act: "kbd" },
  { x: 4, y: 62, label: "wall", act: "wall" },
  { x: 284, y: 34, label: "keys", act: "keys" },
  { x: 284, y: 62, label: "bar", act: "bar" },
];

const CHORD_TITLE_Y = 30;
const CHORD_ROWS_Y = 48;
const CHORD_ROW_H = 24;
const CHORD_COL_SPLIT = 160;

const LAUNCH_X = 16;
const LAUNCH_Y = 44;
const LAUNCH_W = 96;
const LAUNCH_H = 64;
const LAUNCH_COLS = 3;

const within = (x: number, y: number, r: Rect): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const toStage = (x: number, y: number) => ({ x: (x - MAP_X) / S, y: (y - MAP_Y) / S });

type BodyMode = "launcher" | "chords" | "keyboard" | "map";

/** Dock and launcher icons: one literal tree per app. */
function AppIcon(props: { app: AppId }) {
  switch (props.app) {
    case "term":
      // The chevron is drawn as pixels, not typed and not rotated. `❯`
      // (U+276F) is not in the baked face, so a Text rendered the placeholder
      // box; and `-rotate-45` is not a utility this compiler accepts (only
      // non-negative numbers parse), which would have made the whole class
      // literal unknown and left the node unstyled.
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#24283b] border border-[#414868]">
          <View class="absolute left-[4] top-[5] w-[3] h-[3] bg-[#9ece6a]" />
          <View class="absolute left-[6] top-[7] w-[3] h-[3] bg-[#9ece6a]" />
          <View class="absolute left-[8] top-[9] w-[3] h-[3] bg-[#9ece6a]" />
          <View class="absolute left-[6] top-[11] w-[3] h-[3] bg-[#9ece6a]" />
          <View class="absolute left-[4] top-[13] w-[3] h-[3] bg-[#9ece6a]" />
          <View class="absolute left-[12] top-[14] w-[6] h-[2] bg-[#9ece6a]" />
        </View>
      );
    case "clock":
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#7aa2f7] items-center justify-center">
          <View class="w-[12] h-[12] rounded-full border border-[#1a1b26]">
            <View class="absolute left-[5] top-[2] w-[2] h-[5] bg-[#1a1b26]" />
            <View class="absolute left-[5] top-[5] w-[4] h-[2] bg-[#1a1b26]" />
          </View>
        </View>
      );
    case "notes":
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#e0af68] flex-col items-center justify-center gap-[2]">
          <View class="w-[12] h-[2] bg-[#1a1b26]" />
          <View class="w-[12] h-[2] bg-[#1a1b26]" />
          <View class="w-[8] h-[2] bg-[#1a1b26]" />
        </View>
      );
    case "keys":
      // A keyboard: two rows of caps over a spacebar. The old icon stacked
      // two flex rows in a container with no `flex-col` — the default
      // direction here is ROW, so they sat side by side and read as one line
      // of dots. Absolute placement says what it means.
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#bb9af7]">
          <View class="absolute left-[3] top-[5] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[9] top-[5] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[15] top-[5] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[3] top-[10] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[9] top-[10] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[15] top-[10] w-[4] h-[3] rounded-[1] bg-[#1a1b26]" />
          <View class="absolute left-[5] top-[15] w-[12] h-[3] rounded-[1] bg-[#1a1b26]" />
        </View>
      );
    case "stats":
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#9ece6a] flex-row items-end justify-center gap-[2] pb-[4]">
          <View class="w-[3] h-[6] bg-[#1a1b26]" />
          <View class="w-[3] h-[12] bg-[#1a1b26]" />
          <View class="w-[3] h-[9] bg-[#1a1b26]" />
        </View>
      );
    case "about":
      return (
        <View class="w-[22] h-[22] rounded-[5] bg-[#7dcfff] items-center justify-center">
          <Text class="text-sm text-[#1a1b26] font-bold">i</Text>
        </View>
      );
  }
}

/** A touch target's transient pressed look.
 *
 *  A physical button reports its own press; a painted one has to say so, and
 *  on a resistive panel with no hover there is nothing else to tell you the
 *  panel heard you. Every target here therefore darkens or inverts while the
 *  finger is on it, and holds that for a few frames after release so a quick
 *  tap is still visible. Ids are `kind:key` strings so one signal covers the
 *  strip, the gutter, the dock, the chord rows and the launcher. */
function createPressTracker(): {
  is: (id: string) => boolean;
  down: (id: string | null) => void;
  release: () => void;
} {
  const [pressed, setPressed] = createSignal<string | null>(null);
  let linger = 0;
  onFrame(() => {
    if (linger > 0 && --linger === 0) setPressed(null);
  });
  return {
    is: (id) => pressed() === id,
    down: (id) => {
      linger = 0;
      setPressed(id);
    },
    release: () => {
      if (pressed() !== null) linger = PRESS_LINGER_FRAMES;
    },
  };
}

const PRESS_LINGER_FRAMES = 5;

export function Deck(props: { store: ShellStore }) {
  const store = props.store;
  const keyPress = createKeyPress();
  const press = createPressTracker();

  const bodyMode = (): BodyMode => {
    if (store.launcherOpen()) return "launcher";
    if (store.layer() !== "plain") return "chords";
    if (store.kbVisible()) return "keyboard";
    return "map";
  };
  const lHeld = () => store.layer() === "super" || store.layer() === "ws";
  const rHeld = () => store.layer() === "shift" || store.layer() === "ws";

  // ---- touch ---------------------------------------------------------------

  let pending: { id: number } | null = null;
  let splitHandle: ReturnType<typeof store.wm.splitAt> = null;
  let columnHandle: ReturnType<typeof store.wm.columnEdgeAt> = null;
  let panning = false;

  /** Which painted target a point is on, for the pressed look. */
  const targetAt = (x: number, y: number): string | null => {
    if (y < STRIP_H) {
      if (x < PILL_W) return "pill:L";
      if (x >= R_PILL_X) return "pill:R";
      if (x >= BADGE_X && x < BADGE_X + BADGE_W) return "badge:layout";
      const tab = tabAt(x);
      return tab === null ? null : `tab:${tab}`;
    }
    if (y >= DOCK_Y) {
      const index = Math.floor((x - DOCK_X) / DOCK_CELL);
      return x >= DOCK_X && index >= 0 && index < APPS.length ? `dock:${index}` : null;
    }
    switch (bodyMode()) {
      case "launcher": {
        const col = Math.floor((x - LAUNCH_X) / LAUNCH_W);
        const row = Math.floor((y - LAUNCH_Y) / LAUNCH_H);
        if (x < LAUNCH_X || col < 0 || col >= LAUNCH_COLS || row < 0 || row > 1) return null;
        const index = row * LAUNCH_COLS + col;
        return index < APPS.length ? `launch:${index}` : null;
      }
      case "chords": {
        const row = Math.floor((y - CHORD_ROWS_Y) / CHORD_ROW_H);
        if (row < 0 || row > 3) return null;
        return chordActionAt(x, y) === null ? null : `chord:${x < CHORD_COL_SPLIT ? "l" : "r"}${row}`;
      }
      case "map": {
        for (const button of GUTTER_BUTTONS) {
          if (within(x, y, { x: button.x, y: button.y, w: GUTTER_BTN_W, h: GUTTER_BTN_H })) {
            return `gutter:${button.act}`;
          }
        }
        return null;
      }
      default:
        return null;
    }
  };

  const reset = () => {
    pending = null;
    splitHandle = null;
    columnHandle = null;
    panning = false;
    press.release();
    store.setDrag(null);
    store.setClosing(null);
  };

  const tabAt = (x: number): number | null => {
    if (x < TABS_X || x >= TABS_X + TAB_W * WORKSPACES) return null;
    return 1 + Math.floor((x - TABS_X) / TAB_W);
  };

  const runGutter = (button: GutterButton) => {
    switch (button.act) {
      case "kbd":
        store.toggleKeyboard();
        break;
      case "wall":
        store.run("wallpaper");
        break;
      case "keys":
        store.run("keys");
        break;
      case "bar":
        store.run("bar");
        break;
    }
  };

  const chordActionAt = (x: number, y: number): ActionId | null => {
    const row = Math.floor((y - CHORD_ROWS_Y) / CHORD_ROW_H);
    if (row < 0 || row > 3) return null;
    const layer = store.layer();
    let button: number | null = null;
    if (x < CHORD_COL_SPLIT) {
      if (row === 2) button = BTN.START;
      if (row === 3) button = BTN.SELECT;
    } else {
      button = FACE_ORDER[row];
    }
    if (button === null) return null;
    return chordFor(layer, button)?.action ?? null;
  };

  const tapStrip = (x: number) => {
    if (x < PILL_W) {
      store.setLatchL(!store.latchL());
      return;
    }
    if (x >= R_PILL_X) {
      store.setLatchR(!store.latchR());
      return;
    }
    if (x >= BADGE_X && x < BADGE_X + BADGE_W) {
      store.toggleLayout();
      return;
    }
    const tab = tabAt(x);
    if (tab !== null) store.switchWs(tab);
  };

  const tapDock = (x: number) => {
    const index = Math.floor((x - DOCK_X) / DOCK_CELL);
    if (x >= DOCK_X && index >= 0 && index < APPS.length) store.open(APPS[index]);
  };

  const tapBody = (x: number, y: number) => {
    switch (bodyMode()) {
      case "launcher": {
        const col = Math.floor((x - LAUNCH_X) / LAUNCH_W);
        const row = Math.floor((y - LAUNCH_Y) / LAUNCH_H);
        if (x < LAUNCH_X || col < 0 || col >= LAUNCH_COLS || row < 0 || row > 1) return;
        const index = row * LAUNCH_COLS + col;
        if (index < APPS.length) {
          store.open(APPS[index]);
          store.setLauncherOpen(false);
        }
        return;
      }
      case "chords": {
        const action = chordActionAt(x, y);
        if (action) {
          store.run(action);
          store.setLatchL(false);
          store.setLatchR(false);
        }
        return;
      }
      case "keyboard": {
        const hit = keyboardHit(x, y, store.kbLayer());
        if (!hit) return;
        keyPress.press(hit);
        if ("ch" in hit.act) {
          store.typeChar(hit.act.ch);
          if (store.kbLayer() === "upper") store.setKbLayer("lower");
        } else if ("key" in hit.act) {
          store.typeKey(hit.act.key);
        } else if ("layer" in hit.act) {
          store.setKbLayer(hit.act.layer);
        } else {
          store.setKbOpen(false);
        }
        return;
      }
      case "map": {
        for (const button of GUTTER_BUTTONS) {
          if (within(x, y, { x: button.x, y: button.y, w: GUTTER_BTN_W, h: GUTTER_BTN_H })) {
            runGutter(button);
            return;
          }
        }
        if (within(x, y, MAP_RECT)) {
          const id = store.wm.windowAt(toStage(x, y));
          if (id !== null) store.focusWin(id);
        }
      }
    }
  };

  createGesture({
    surface: "auxiliary",
    tapSlop: 6,
    panSlop: 6,
    longPressSeconds: CLOSE_HOLD_SECONDS,
    onDown: (c) => {
      pending = null;
      press.down(targetAt(c.x, c.y));
      if (bodyMode() === "map" && within(c.x, c.y, MAP_RECT)) {
        const id = store.wm.windowAt(toStage(c.x, c.y));
        if (id !== null) pending = { id };
      }
    },
    onTap: (c) => {
      pending = null;
      press.release();
      if (c.y < STRIP_H) tapStrip(c.x);
      else if (c.y >= DOCK_Y) tapDock(c.x);
      else tapBody(c.x, c.y);
    },
    onLongPress: (c) => {
      press.down(null);
      if (pending && bodyMode() === "map") {
        store.setClosing({ id: pending.id, over: false });
        store.say("");
      }
      pending = null;
      void c;
    },
    onPanStart: (c) => {
      press.down(null);
      if (store.closing() || bodyMode() !== "map") return;
      const sp = toStage(c.x, c.y);
      if (pending) {
        store.setDrag({ id: pending.id, x: sp.x, y: sp.y, over: null, overWs: null });
        pending = null;
        return;
      }
      if (!within(c.x, c.y, MAP_RECT)) return;
      splitHandle = store.wm.splitAt(sp, 8);
      if (splitHandle) return;
      columnHandle = store.wm.columnEdgeAt(sp, 8);
      if (columnHandle) return;
      panning = store.wm.workspace().layout === "scrolling";
    },
    onPanMove: (c) => {
      const closing = store.closing();
      if (closing) {
        const over = c.y >= CLOSE_BAR_Y && c.y < CLOSE_BAR_Y + CLOSE_BAR_H;
        if (over !== closing.over) store.setClosing({ id: closing.id, over });
        return;
      }
      const drag = store.drag();
      const sp = toStage(c.x, c.y);
      if (drag) {
        const overId = within(c.x, c.y, MAP_RECT) ? store.wm.windowAt(sp) : null;
        store.setDrag({
          id: drag.id,
          x: sp.x,
          y: sp.y,
          over: overId !== null && overId !== drag.id ? overId : null,
          overWs: c.y < STRIP_H ? tabAt(c.x) : null,
        });
        return;
      }
      if (splitHandle) {
        store.wm.dragSplit(splitHandle, sp);
        store.bump();
      } else if (columnHandle) {
        store.wm.dragColumnEdge(columnHandle, sp);
        store.bump();
      } else if (panning) {
        store.wm.scrollBy(-c.fdx / S);
        store.bump();
      }
    },
    onUp: (c) => {
      const closing = store.closing();
      if (closing) {
        if (c.y >= CLOSE_BAR_Y && c.y < CLOSE_BAR_Y + CLOSE_BAR_H) store.close(closing.id);
        reset();
        return;
      }
      const drag = store.drag();
      if (drag) {
        if (drag.overWs !== null && drag.overWs !== store.wm.active) {
          store.wm.moveToWs(drag.id, drag.overWs);
          store.say(`moved to workspace ${drag.overWs}`);
          store.bump();
        } else if (drag.over !== null) {
          store.wm.swap(store.wm.workspace(), drag.id, drag.over);
          store.bump();
        }
      }
      reset();
    },
    onCancel: () => reset(),
  });

  // ---- render ----------------------------------------------------------------

  const hint = () => {
    const toast = store.toast();
    if (toast) return toast;
    if (store.drag()) return "drop on a window to swap · on a tab to move";
    if (store.wm.count() === 0) return "tap the dock to open a window";
    return LAYER_HINT.plain;
  };

  const closingTitle = () => {
    const c = store.closing();
    return c ? store.windowOf(c.id)?.title ?? "" : "";
  };

  const chordLeft = () => {
    const layer = store.layer();
    const layout = store.layoutKind();
    const start = chordFor(layer, BTN.START)?.action;
    const select = chordFor(layer, BTN.SELECT)?.action;
    return [
      { badge: "dpad", label: dpadLabel(layer) },
      { badge: "pad", label: padLabel(layer, layout) },
      { badge: "START", label: start ? labelFor(start, layout) : "—" },
      { badge: "SELECT", label: select ? labelFor(select, layout) : "—" },
    ];
  };
  const chordRight = () => {
    const layer = store.layer();
    const layout = store.layoutKind();
    return FACE_ORDER.map((button) => {
      const chord = chordFor(layer, button);
      return { badge: BUTTON_GLYPH[button], label: chord ? labelFor(chord.action, layout) : "—" };
    });
  };
  const latched = () => store.latchL() || store.latchR();

  return (
    <View debugName="Deck" class="relative w-full h-full bg-[#16161e] overflow-hidden">
      {/* ---- workspace strip ---- */}
      <View debugName="Strip" class="absolute left-0 right-0 top-0 h-[24] bg-[#0e0e14]">
        <View
          class={
            lHeld()
              ? "absolute left-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#7aa2f7] items-center justify-center"
              : press.is("pill:L")
                ? "absolute left-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#3d4c63] items-center justify-center"
                : "absolute left-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#24283b] items-center justify-center"
          }
        >
          <Text class={lHeld() ? "text-xs text-[#1a1b26] font-bold" : "text-xs text-[#565f89] font-bold"}>L</Text>
        </View>
        <Index each={store.counts()}>
          {(count, i) => (
            <View
              class={
                store.drag()?.overWs === i + 1
                  ? "absolute top-0 h-[24] items-center justify-center bg-[#9ece6a33]"
                  : press.is(`tab:${i + 1}`)
                    ? "absolute top-0 h-[24] items-center justify-center bg-[#3d4c63]"
                    : store.active() === i + 1
                      ? "absolute top-0 h-[24] items-center justify-center bg-[#1a1b26]"
                      : "absolute top-0 h-[24] items-center justify-center"
              }
              style={{ insetL: TABS_X + i * TAB_W, width: TAB_W }}
            >
              <Text
                class={
                  store.active() === i + 1
                    ? "text-sm text-[#c0caf5] font-bold"
                    : count() > 0
                      ? "text-sm text-[#a9b1d6]"
                      : "text-sm text-[#414868]"
                }
              >
                {String(i + 1)}
              </Text>
              <Show when={count() > 0}>
                <View class="absolute left-0 right-0 bottom-[2] flex-row justify-center gap-[2]">
                  <Index each={Array.from({ length: Math.min(4, count()) })}>
                    {() => <View class="w-[3] h-[3] rounded-full bg-[#7aa2f7]" />}
                  </Index>
                </View>
              </Show>
              <Show when={store.active() === i + 1}>
                <View class="absolute left-0 right-0 top-0 h-[2] bg-[#7aa2f7]" />
              </Show>
            </View>
          )}
        </Index>
        <View
          class={
            press.is("badge:layout")
              ? "absolute top-[3] h-[18] rounded-[4] bg-[#3d4c63] items-center justify-center"
              : "absolute top-[3] h-[18] rounded-[4] bg-[#24283b] items-center justify-center"
          }
          style={{ insetL: BADGE_X + 2, width: BADGE_W - 4 }}
        >
          <Text class="text-xs text-[#a9b1d6]">{store.layoutKind()}</Text>
        </View>
        <View
          class={
            rHeld()
              ? "absolute right-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#7aa2f7] items-center justify-center"
              : press.is("pill:R")
                ? "absolute right-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#3d4c63] items-center justify-center"
                : "absolute right-[2] top-[3] w-[24] h-[18] rounded-[4] bg-[#24283b] items-center justify-center"
          }
        >
          <Text class={rHeld() ? "text-xs text-[#1a1b26] font-bold" : "text-xs text-[#565f89] font-bold"}>R</Text>
        </View>
      </View>

      {/* ---- body: minimap ---- */}
      <Show when={bodyMode() === "map"}>
        <View debugName="Minimap" class="absolute overflow-hidden border border-[#292e42]" style={{ insetL: MAP_X, insetT: MAP_Y, width: MAP_W, height: MAP_H }}>
          <Show when={store.wallpaper() === "road"}>
            <Image class="absolute left-0 top-0 w-[307] h-[154]" src="wall/road.png" />
          </Show>
          <Show when={store.wallpaper() === "lake"}>
            <Image class="absolute left-0 top-0 w-[307] h-[154]" src="wall/lake.png" />
          </Show>
          <Show when={store.wallpaper() === "swirl"}>
            <Image class="absolute left-0 top-0 w-[307] h-[154]" src="wall/swirl.png" />
          </Show>
          <View class="absolute inset-0 bg-[#16161e99]" />
          <Show when={store.barVisible()}>
            <View class="absolute left-0 right-0 top-0 h-[8] bg-[#1a1b26cc]" />
          </Show>
          <For each={store.order()}>
            {(id) => {
              const p = () => store.placementOf(id);
              const focused = () => store.focusedId() === id;
              const target = () => store.drag()?.over === id;
              return (
                <Show when={p() && !p()!.hidden}>
                  <View
                    class={
                      target()
                        ? "absolute border border-[#9ece6a] bg-[#9ece6a33] items-center justify-center overflow-hidden"
                        : focused()
                          ? "absolute border border-[#33ccff] bg-[#1a1b26e6] items-center justify-center overflow-hidden"
                          : "absolute border border-[#595959] bg-[#1a1b26cc] items-center justify-center overflow-hidden"
                    }
                    style={{
                      insetL: p()!.rect.x * S,
                      insetT: p()!.rect.y * S,
                      width: p()!.rect.w * S,
                      height: p()!.rect.h * S,
                    }}
                  >
                    <Show when={p()!.rect.w * S >= 34 && p()!.rect.h * S >= 14}>
                      <Text class={focused() ? "text-xs text-[#c0caf5]" : "text-xs text-[#565f89]"}>
                        {store.windowOf(id)?.title ?? ""}
                      </Text>
                    </Show>
                  </View>
                </Show>
              );
            }}
          </For>
          <Show when={store.drag()}>
            {(d) => (
              <View
                class="absolute w-[56] h-[32] border border-[#7aa2f7] bg-[#24283bdd] items-center justify-center"
                style={{ insetL: d().x * S - 28, insetT: d().y * S - 16 }}
              >
                <Text class="text-xs text-[#c0caf5]">{store.windowOf(d().id)?.title ?? ""}</Text>
              </View>
            )}
          </Show>
        </View>
        <For each={GUTTER_BUTTONS}>
          {(button) => (
            <View
              class={
                button.act === "kbd" && !isTextApp(store.focusedApp())
                  ? "absolute w-[32] h-[22] rounded-[4] bg-[#1a1b26] items-center justify-center"
                  : press.is(`gutter:${button.act}`)
                    ? "absolute w-[32] h-[22] rounded-[4] bg-[#7aa2f7] items-center justify-center"
                    : button.act === "kbd" && store.kbOpen()
                      ? "absolute w-[32] h-[22] rounded-[4] bg-[#7aa2f7] items-center justify-center"
                      : "absolute w-[32] h-[22] rounded-[4] bg-[#24283b] items-center justify-center"
              }
              style={{ insetL: button.x, insetT: button.y }}
            >
              <Text
                class={
                  button.act === "kbd" && !isTextApp(store.focusedApp())
                    ? "text-xs text-[#414868]"
                    : press.is(`gutter:${button.act}`) || (button.act === "kbd" && store.kbOpen())
                      ? "text-xs text-[#1a1b26] font-bold"
                      : "text-xs text-[#a9b1d6]"
                }
              >
                {button.label}
              </Text>
            </View>
          )}
        </For>
        <Text class="absolute left-0 right-0 text-center text-xs text-[#565f89]" style={{ insetT: HINT_Y }}>
          {hint()}
        </Text>
        <Show when={store.closeAnim() > 0}>
          <View
            debugName="CloseBar"
            class={
              store.closing()?.over
                ? "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#a33a3a]"
                : "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#5c2626]"
            }
            style={{
              insetT: CLOSE_BAR_Y,
              height: CLOSE_BAR_H,
              translateY: (1 - store.closeAnim()) * CLOSE_BAR_H,
              opacity: store.closeAnim(),
            }}
          >
            <Text class="text-sm text-[#ffdede] font-bold">×</Text>
            <Text class="text-xs text-[#ffdede]">
              {store.closing()?.over ? "release to close" : "slide here to close"}
            </Text>
            <Text class="text-xs text-[#e0a0a0]">{closingTitle()}</Text>
          </View>
        </Show>
      </Show>

      {/* ---- body: chord map ---- */}
      <Show when={bodyMode() === "chords"}>
        <View debugName="ChordMap" class="absolute left-0 right-0" style={{ insetT: BODY_TOP, height: BODY_BOTTOM - BODY_TOP }}>
          <Text class="absolute left-0 right-0 text-center text-xs text-[#7aa2f7] font-bold" style={{ insetT: CHORD_TITLE_Y - BODY_TOP }}>
            {LAYER_TITLE[store.layer() as Layer]}
          </Text>
          <Index each={chordLeft()}>
            {(row, i) => (
              <View
                class={
                  press.is(`chord:l${i}`)
                    ? "absolute left-[8] h-[24] flex-row items-center gap-[6] overflow-hidden rounded-[4] bg-[#3d4c63]"
                    : "absolute left-[8] h-[24] flex-row items-center gap-[6] overflow-hidden"
                }
                style={{ insetT: CHORD_ROWS_Y - BODY_TOP + i * CHORD_ROW_H, width: CHORD_COL_SPLIT - 12 }}
              >
                <Show when={row().badge === "dpad"}>
                  <View class="w-[18] h-[18] rounded-[3] bg-[#292e42] items-center justify-center">
                    <Text class="text-xs text-[#c0caf5] font-bold">+</Text>
                  </View>
                </Show>
                <Show when={row().badge === "pad"}>
                  <View class="w-[18] h-[18] rounded-full bg-[#292e42] items-center justify-center">
                    <View class="w-[8] h-[8] rounded-full bg-[#c0caf5]" />
                  </View>
                </Show>
                <Show when={row().badge === "START" || row().badge === "SELECT"}>
                  <View class="w-[44] h-[14] rounded-[7] bg-[#292e42] items-center justify-center">
                    <Text class="text-xs text-[#c0caf5] font-bold">{row().badge}</Text>
                  </View>
                </Show>
                <Text class={row().label === "—" ? "text-xs text-[#414868]" : "text-xs text-[#a9b1d6]"}>{row().label}</Text>
              </View>
            )}
          </Index>
          <Index each={chordRight()}>
            {(row, i) => (
              <View
                class={
                  press.is(`chord:r${i}`)
                    ? "absolute h-[24] flex-row items-center gap-[6] overflow-hidden rounded-[4] bg-[#3d4c63]"
                    : "absolute h-[24] flex-row items-center gap-[6] overflow-hidden"
                }
                style={{ insetL: CHORD_COL_SPLIT + 6, insetT: CHORD_ROWS_Y - BODY_TOP + i * CHORD_ROW_H, width: 320 - CHORD_COL_SPLIT - 12 }}
              >
                <View class="w-[18] h-[18] rounded-full bg-[#292e42] items-center justify-center">
                  <Text class="text-xs text-[#c0caf5] font-bold">{row().badge}</Text>
                </View>
                <Text class={row().label === "—" ? "text-xs text-[#414868]" : "text-xs text-[#a9b1d6]"}>{row().label}</Text>
              </View>
            )}
          </Index>
          <Text class="absolute left-0 right-0 text-center text-xs text-[#565f89]" style={{ insetT: HINT_Y - BODY_TOP }}>
            {latched() ? "tap a row, or press the button · tap L/R again to let go" : LAYER_HINT[store.layer()]}
          </Text>
        </View>
      </Show>

      {/* ---- body: launcher ---- */}
      <Show when={bodyMode() === "launcher"}>
        <View debugName="Launcher" class="absolute left-0 right-0" style={{ insetT: BODY_TOP, height: BODY_BOTTOM - BODY_TOP }}>
          <Text class="absolute left-0 right-0 top-[6] text-center text-xs text-[#7aa2f7] font-bold">launch</Text>
          <Index each={APPS}>
            {(app, i) => (
              <View
                class={
                  press.is(`launch:${i}`)
                    ? "absolute rounded-[6] bg-[#3d4c63] border border-[#7aa2f7]"
                    : store.launcherIndex() === i
                      ? "absolute rounded-[6] bg-[#292e42] border border-[#7aa2f7]"
                      : "absolute rounded-[6] bg-[#1a1b26]"
                }
                style={{
                  insetL: LAUNCH_X + (i % LAUNCH_COLS) * LAUNCH_W,
                  insetT: LAUNCH_Y - BODY_TOP + Math.floor(i / LAUNCH_COLS) * LAUNCH_H,
                  width: LAUNCH_W - 4,
                  height: LAUNCH_H - 4,
                }}
              >
                <View class="absolute left-[8] top-[8]">
                  <AppIcon app={app()} />
                </View>
                <Text class="absolute left-[36] top-[8] text-sm text-[#c0caf5] font-bold">{app()}</Text>
                <Text class="absolute left-[8] top-[36] text-xs text-[#565f89]">{APP_BLURB[app()]}</Text>
              </View>
            )}
          </Index>
          <Text class="absolute left-0 right-0 text-center text-xs text-[#565f89]" style={{ insetT: HINT_Y - BODY_TOP }}>
            d-pad picks · A opens · B or L+A closes
          </Text>
        </View>
      </Show>

      {/* ---- body: keyboard ---- */}
      <Show when={bodyMode() === "keyboard"}>
        <Keyboard store={store} pressed={keyPress.pressed} />
      </Show>

      {/* ---- dock ---- */}
      <View debugName="Dock" class="absolute left-0 right-0 bottom-0 h-[40] bg-[#0e0e14]">
        <Index each={APPS}>
          {(app, i) => {
            const running = () => {
              store.rev();
              for (const w of store.wm.windows.values()) if (w.app === app()) return true;
              return false;
            };
            return (
              <View
                class={
                  press.is(`dock:${i}`)
                    ? "absolute top-0 h-[40] bg-[#24283b]"
                    : "absolute top-0 h-[40]"
                }
                style={{ insetL: DOCK_X + i * DOCK_CELL, width: DOCK_CELL }}
              >
                <View class="absolute left-[13] top-[3]">
                  <AppIcon app={app()} />
                </View>
                <Show when={running()}>
                  <View class="absolute left-[37] top-[2] w-[5] h-[5] rounded-full bg-[#9ece6a]" />
                </Show>
                <Text class="absolute left-0 right-0 top-[26] text-center text-xs text-[#565f89]">{app()}</Text>
              </View>
            );
          }}
        </Index>
      </View>
    </View>
  );
}

export { BAR_H };
