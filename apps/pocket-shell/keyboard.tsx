// apps/pocket-shell/keyboard.tsx — the deck's touch keyboard, for term and
// notes. The framework Osk lays itself out against the PRIMARY viewport, so
// the 320 px auxiliary panel gets a hand-laid grid instead: 32 px columns,
// 30 px rows, hit by the deck's one gesture through `keyboardHit`. Shift is
// one-shot (the resistive panel has one contact); "123" latches the symbol
// layer until "abc".

import { createSignal, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { KbLayer, ShellStore } from "./store.ts";

export const KB_TOP = 24;
export const KB_BOTTOM = 200;
const ECHO_H = 26;
const ROWS_TOP = KB_TOP + ECHO_H + 6;
const KEY_H = 30;
const UNIT = 32;
const PRESS_FRAMES = 6;

export type KeyAction =
  | { ch: string }
  | { key: "enter" | "backspace" | "space" | "tab" }
  | { layer: KbLayer }
  | { hide: true };

interface KeyDef {
  label: string;
  /** Width in 32 px units. */
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
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: ",", w: 1, act: { ch: "," } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: ".", w: 1, act: { ch: "." } },
      { label: "enter", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
  upper: [
    chars("QWERTYUIOP"),
    chars("ASDFGHJKL"),
    [
      { label: "shift", w: 1.5, act: { layer: "lower" }, dark: true },
      ...chars("ZXCVBNM"),
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: "!", w: 1, act: { ch: "!" } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: "?", w: 1, act: { ch: "?" } },
      { label: "enter", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
  sym: [
    chars("1234567890"),
    chars("-/:;()&@\""),
    [
      { label: "#+=", w: 1.5, act: { ch: "#" }, dark: true },
      ...chars(".,?!'*="),
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "abc", w: 1.5, act: { layer: "lower" }, dark: true },
      { label: "<", w: 1, act: { ch: "<" } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: ">", w: 1, act: { ch: ">" } },
      { label: "enter", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
};

/** Left offset that centres a row's total width on the 320 px panel. */
function rowStart(row: KeyDef[]): number {
  const total = row.reduce((sum, k) => sum + k.w, 0) * UNIT;
  return Math.round((320 - total) / 2);
}

export interface KeyHit {
  act: KeyAction;
  row: number;
  index: number;
}

export function keyboardHit(x: number, y: number, layer: KbLayer): KeyHit | null {
  if (y >= KB_TOP && y < KB_TOP + ECHO_H) {
    return x >= 320 - 52 ? { act: { hide: true }, row: -1, index: 0 } : null;
  }
  const row = Math.floor((y - ROWS_TOP) / KEY_H);
  if (row < 0 || row >= 4) return null;
  const keys = ROWS[layer][row];
  let left = rowStart(keys);
  for (let index = 0; index < keys.length; index++) {
    const w = keys[index].w * UNIT;
    if (x >= left && x < left + w) return { act: keys[index].act, row, index };
    left += w;
  }
  return null;
}

export function Keyboard(props: { store: ShellStore; pressed: () => KeyHit | null }) {
  const store = props.store;
  const echo = () => {
    const id = store.focusedId();
    const state = id === null ? undefined : store.stateOf(id);
    store.rev();
    if (!state) return "";
    if (state.kind === "term") return `❯ ${state.input}`;
    if (state.kind === "notes") {
      const lines = state.text.split("\n");
      return lines[lines.length - 1];
    }
    return "";
  };
  const rows = () => ROWS[store.kbLayer()];
  return (
    <View debugName="Keyboard" class="absolute left-0 right-0" style={{ insetT: KB_TOP, height: KB_BOTTOM - KB_TOP }}>
      <View class="absolute left-[6] top-[2] h-[22] bg-[#1a1b26] border border-[#292e42]" style={{ width: 320 - 12 - 52 }}>
        <Text class="absolute left-[6] top-[4] font-mono text-xs text-[#c0caf5]">{echo()}</Text>
      </View>
      <View class="absolute top-[2] h-[22] items-center justify-center rounded-[3] bg-[#292e42]" style={{ insetL: 320 - 52, width: 46 }}>
        <Text class="text-xs text-[#a9b1d6]">hide</Text>
      </View>
      <Index each={rows()}>
        {(row, r) => (
          <Index each={row()}>
            {(key, i) => {
              const left = () => rowStart(row()) + row().slice(0, i).reduce((sum, k) => sum + k.w, 0) * UNIT;
              const hot = () => {
                const p = props.pressed();
                return p !== null && p.row === r && p.index === i;
              };
              return (
                <View
                  class={
                    hot()
                      ? "absolute items-center justify-center rounded-[3] bg-[#7aa2f7]"
                      : key().dark
                        ? "absolute items-center justify-center rounded-[3] bg-[#292e42]"
                        : "absolute items-center justify-center rounded-[3] bg-[#414868]"
                  }
                  style={{
                    insetL: left() + 2,
                    insetT: ECHO_H + 6 + r * KEY_H + 2,
                    width: key().w * UNIT - 4,
                    height: KEY_H - 4,
                  }}
                >
                  <Text class={hot() ? "text-sm text-[#1a1b26] font-bold" : "text-sm text-[#c0caf5]"}>
                    {key().label}
                  </Text>
                </View>
              );
            }}
          </Index>
        )}
      </Index>
    </View>
  );
}

/** Pressed-key highlight that lasts PRESS_FRAMES frames. */
export function createKeyPress(): { pressed: () => KeyHit | null; press: (hit: KeyHit) => void } {
  const [pressed, setPressed] = createSignal<KeyHit | null>(null);
  let left = 0;
  onFrame(() => {
    if (left > 0 && --left === 0) setPressed(null);
  });
  return {
    pressed,
    press: (hit) => {
      setPressed(hit);
      left = PRESS_FRAMES;
    },
  };
}
