// apps/pocket-remote/keyboard.tsx — typing into the focused window from the
// remote, the Apple TV app's one killer feature. Keys go straight to the
// laptop (wtype) as they are pressed; nothing is buffered on the device, so
// what the desktop shows is the truth. A landscape iOS layout at 40 px keys:
// ten columns across the 400 px centre column, four rows, one-shot shift,
// a symbols layer with esc and tab, and a caption naming the window the
// keys land in.

import { createSignal, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { GestureHandlers } from "./desk.tsx";
import { RAIL_W, SCREEN_W, within } from "./layout.ts";
import type { KbLayer, RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export const KB_X = RAIL_W;
export const KB_W = SCREEN_W - 2 * RAIL_W;
export const KB_TOP = 140;
export const KB_RECT = { x: KB_X, y: KB_TOP, w: KB_W, h: 320 - KB_TOP };
const CAPTION_H = 20;
const ROWS_TOP = KB_TOP + CAPTION_H + 4;
const UNIT = 40;
const KEY_H = 38;
const ROW_PITCH = 42;

export type KeyAction =
  | { ch: string }
  | { key: "Return" | "BackSpace" | "space" | "Tab" | "Escape" }
  | { layer: KbLayer }
  | { hide: true };

interface KeyDef {
  label: string;
  /** Width in 40 px units. */
  w: number;
  act: KeyAction;
  dark?: boolean;
}

const chars = (row: string): KeyDef[] => [...row].map((ch) => ({ label: ch, w: 1, act: { ch } }));

const ROWS: Record<KbLayer, KeyDef[][]> = {
  lower: [
    chars("qwertyuiop"),
    chars("asdfghjkl"),
    [
      { label: "shift", w: 1.5, act: { layer: "upper" }, dark: true },
      ...chars("zxcvbnm"),
      { label: "del", w: 1.5, act: { key: "BackSpace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: ",", w: 1, act: { ch: "," } },
      { label: "space", w: 4.5, act: { key: "space" } },
      { label: ".", w: 1, act: { ch: "." } },
      { label: "return", w: 2, act: { key: "Return" }, dark: true },
    ],
  ],
  upper: [
    chars("QWERTYUIOP"),
    chars("ASDFGHJKL"),
    [
      { label: "shift", w: 1.5, act: { layer: "lower" }, dark: true },
      ...chars("ZXCVBNM"),
      { label: "del", w: 1.5, act: { key: "BackSpace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: "!", w: 1, act: { ch: "!" } },
      { label: "space", w: 4.5, act: { key: "space" } },
      { label: "?", w: 1, act: { ch: "?" } },
      { label: "return", w: 2, act: { key: "Return" }, dark: true },
    ],
  ],
  sym: [
    chars("1234567890"),
    chars("-/:;()$&@\""),
    [
      { label: "esc", w: 1.5, act: { key: "Escape" }, dark: true },
      ...chars("#+=.,?!'"),
      { label: "del", w: 0.5, act: { key: "BackSpace" }, dark: true },
    ],
    [
      { label: "abc", w: 1.5, act: { layer: "lower" }, dark: true },
      { label: "tab", w: 1, act: { key: "Tab" }, dark: true },
      { label: "space", w: 4.5, act: { key: "space" } },
      { label: "~", w: 1, act: { ch: "~" } },
      { label: "return", w: 2, act: { key: "Return" }, dark: true },
    ],
  ],
};

interface KeyRect {
  x: number;
  y: number;
  w: number;
  h: number;
  def: KeyDef;
  row: number;
  col: number;
}

function layoutKeys(layer: KbLayer): KeyRect[] {
  const out: KeyRect[] = [];
  ROWS[layer].forEach((row, r) => {
    const total = row.reduce((sum, key) => sum + key.w, 0);
    let x = KB_X + Math.round(((KB_W / UNIT - total) * UNIT) / 2);
    row.forEach((def, c) => {
      const w = Math.round(def.w * UNIT);
      out.push({ x: x + 2, y: ROWS_TOP + r * ROW_PITCH, w: w - 4, h: KEY_H, def, row: r, col: c });
      x += w;
    });
  });
  return out;
}

const LAYOUTS: Record<KbLayer, KeyRect[]> = {
  lower: layoutKeys("lower"),
  upper: layoutKeys("upper"),
  sym: layoutKeys("sym"),
};

export function keyAt(layer: KbLayer, x: number, y: number): KeyRect | null {
  for (const key of LAYOUTS[layer]) {
    if (x >= key.x - 2 && x < key.x + key.w + 2 && y >= key.y - 2 && y < key.y + key.h + 2) return key;
  }
  return null;
}

/** What a key does, as the store sees it. Exported for tests. */
export function keyToLine(act: KeyAction): { t: "type"; text: string } | { t: "key"; k: string } | null {
  if ("ch" in act) return { t: "type", text: act.ch };
  if ("key" in act) return { t: "key", k: act.key };
  return null;
}

/** The keyboard's touch handlers; app.tsx routes contacts inside the sheet here. */
export function keyboardHandlers(store: RemoteStore): GestureHandlers {
  const [down, setDown] = createSignal<KeyRect | null>(null);
  const active = () => store.kb() && store.pad() === null;
  const press = (key: KeyRect) => {
    const act = key.def.act;
    if ("layer" in act) {
      store.setKbLayer(act.layer);
      return;
    }
    if ("hide" in act) {
      store.setKb(false);
      return;
    }
    if ("ch" in act) {
      store.typeText(act.ch);
      // One-shot shift: the upper layer drops back after a letter.
      if (store.kbLayer() === "upper") store.setKbLayer("lower");
      return;
    }
    store.typeKey(act.key);
  };
  return {
    onDown: (c) => {
      if (!active()) return;
      if (!within(c.x, c.y, KB_RECT)) return;
      const key = keyAt(store.kbLayer(), c.x, c.y);
      setDown(key);
      if (key) store.pressDown(`key:${key.row}:${key.col}`);
    },
    onTap: () => {
      if (!active()) return;
      const key = down();
      store.pressRelease();
      if (key) press(key);
      setDown(null);
    },
    onPanStart: () => {
      store.pressDown(null);
      setDown(null);
    },
    onUp: () => store.pressRelease(),
    onCancel: () => {
      store.pressRelease();
      setDown(null);
    },
  };
}

export function Keyboard(p: { store: RemoteStore }) {
  const keys = () => LAYOUTS[p.store.kbLayer()];
  const target = () => {
    const c = p.store.focusClass();
    return c ? `typing into ${c}` : "no focused window";
  };
  return (
    <View
      class="absolute left-[40] top-[140] w-[400] h-[180] bg-[#13141c] overflow-hidden"
      ref={themed("surfaceDark")}
    >
      <View class="absolute left-0 top-0 w-[400] h-[20] items-center justify-center">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {target()}
        </Text>
      </View>
      <Index each={keys()}>
        {(key) => (
          <View
            class={
              key().def.dark
                ? "absolute rounded-[6] bg-[#1a1b26] items-center justify-center"
                : "absolute rounded-[6] bg-[#414868] items-center justify-center"
            }
            style={{ insetL: key().x - KB_X, insetT: key().y - KB_TOP, width: key().w, height: key().h }}
            ref={themed(() => key().def.dark ? "surface" : "surfaceMuted")}
          >
            <Text
              class={key().def.dark ? "text-sm text-[#a9b1d6]" : "text-base text-[#c0caf5]"}
              ref={themed("text")}
            >
              {key().def.label}
            </Text>
            <View
              class={
                p.store.pressed() === `key:${key().row}:${key().col}`
                  ? "absolute left-0 top-0 w-full h-full rounded-[6] bg-[#ffffff33]"
                  : "hidden"
              }
            />
          </View>
        )}
      </Index>
      <Show when={p.store.kbLayer() === "upper"}>
        <View class="absolute left-[8] top-[6] w-[6] h-[6] rounded-full bg-[#7aa2f7]" ref={themed("accentFill")} />
      </Show>
    </View>
  );
}
