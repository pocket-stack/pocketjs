// apps/pocket-shell/chords.ts — the modifier grammar, as one table.
//
// Omarchy binds every window action to SUPER plus one key and shows the whole
// table on SUPER+K. Pocket Shell gives the two shoulders that role:
//
//   L held         super   act on the focused window (focus, close, launch)
//   R held         shift   the same verbs, moved: swap, maximize, spawn
//   L and R held   ws      the d-pad steps workspaces and carries windows
//   neither        plain   buttons belong to the focused window's applet
//
// This table is read twice: by the input dispatcher (store.ts) to fire an
// action, and by the deck (deck.tsx) to draw the live keybinding map while a
// shoulder is down — the same entry produces the behaviour and its label, so
// the two cannot drift.
//
// Only buttons the 3DS host delivers appear here. ZL and ZR are New-3DS-only,
// reach libctru through ir:rst rather than the HID pad, and have no BTN
// constant in contracts/spec/spec.ts, so nothing is bound to them; when the
// contract gains them, stepping workspaces without a shoulder is two rows.

import { BTN } from "@pocketjs/framework/input";
import type { LayoutKind } from "./wm.ts";

export type Layer = "plain" | "super" | "shift" | "ws";

export type ActionId =
  | "focus.left"
  | "focus.right"
  | "focus.up"
  | "focus.down"
  | "swap.left"
  | "swap.right"
  | "swap.up"
  | "swap.down"
  | "ws.prev"
  | "ws.next"
  | "carry.prev"
  | "carry.next"
  | "launcher"
  | "close"
  | "fullscreen"
  | "maximize"
  | "split"
  | "swapsplit"
  | "layout"
  | "keys"
  | "another"
  | "reopen"
  | "wallpaper"
  | "bar";

export interface Chord {
  layer: Layer;
  button: number;
  action: ActionId;
}

/** The face-button order the deck draws rows in. */
export const FACE_ORDER: readonly number[] = [BTN.TRIANGLE, BTN.SQUARE, BTN.CIRCLE, BTN.CROSS];
export const DPAD = BTN.LEFT | BTN.RIGHT | BTN.UP | BTN.DOWN;

export const CHORDS: readonly Chord[] = [
  { layer: "super", button: BTN.LEFT, action: "focus.left" },
  { layer: "super", button: BTN.RIGHT, action: "focus.right" },
  { layer: "super", button: BTN.UP, action: "focus.up" },
  { layer: "super", button: BTN.DOWN, action: "focus.down" },
  { layer: "super", button: BTN.CIRCLE, action: "launcher" },
  { layer: "super", button: BTN.CROSS, action: "close" },
  { layer: "super", button: BTN.TRIANGLE, action: "fullscreen" },
  { layer: "super", button: BTN.SQUARE, action: "split" },
  { layer: "super", button: BTN.START, action: "layout" },
  { layer: "super", button: BTN.SELECT, action: "keys" },

  { layer: "shift", button: BTN.LEFT, action: "swap.left" },
  { layer: "shift", button: BTN.RIGHT, action: "swap.right" },
  { layer: "shift", button: BTN.UP, action: "swap.up" },
  { layer: "shift", button: BTN.DOWN, action: "swap.down" },
  { layer: "shift", button: BTN.CIRCLE, action: "another" },
  { layer: "shift", button: BTN.CROSS, action: "reopen" },
  { layer: "shift", button: BTN.TRIANGLE, action: "maximize" },
  { layer: "shift", button: BTN.SQUARE, action: "swapsplit" },
  { layer: "shift", button: BTN.START, action: "wallpaper" },
  { layer: "shift", button: BTN.SELECT, action: "bar" },

  { layer: "ws", button: BTN.LEFT, action: "ws.prev" },
  { layer: "ws", button: BTN.RIGHT, action: "ws.next" },
  { layer: "ws", button: BTN.UP, action: "carry.prev" },
  { layer: "ws", button: BTN.DOWN, action: "carry.next" },
];

export function layerOf(held: number): Layer {
  const l = (held & BTN.LTRIGGER) !== 0;
  const r = (held & BTN.RTRIGGER) !== 0;
  if (l && r) return "ws";
  if (l) return "super";
  if (r) return "shift";
  return "plain";
}

export function chordsOf(layer: Layer): Chord[] {
  return CHORDS.filter((chord) => chord.layer === layer);
}

export function chordFor(layer: Layer, button: number): Chord | undefined {
  return CHORDS.find((chord) => chord.layer === layer && chord.button === button);
}

export const LAYER_TITLE: Record<Layer, string> = {
  plain: "",
  super: "L  window",
  shift: "R  move",
  ws: "L+R  workspace",
};

/** What the shoulders do next, for the idle hint line. */
export const LAYER_HINT: Record<Layer, string> = {
  plain: "hold L window · R move · L+R workspace",
  super: "add R for workspaces · release to finish",
  shift: "add L for workspaces · release to finish",
  ws: "d-pad steps · release to finish",
};

/** The label a chord shows, given the workspace layout it would act on. */
export function labelFor(action: ActionId, layout: LayoutKind): string {
  switch (action) {
    case "focus.left":
    case "focus.right":
    case "focus.up":
    case "focus.down":
      return "focus window";
    case "swap.left":
    case "swap.right":
    case "swap.up":
    case "swap.down":
      return "swap window";
    case "ws.prev":
    case "ws.next":
      return "switch workspace";
    case "carry.prev":
    case "carry.next":
      return "carry window";
    case "launcher":
      return "launcher";
    case "close":
      return "close window";
    case "fullscreen":
      return "fullscreen";
    case "maximize":
      return "maximize";
    case "split":
      return layout === "dwindle" ? "toggle split" : "column width";
    case "swapsplit":
      return layout === "dwindle" ? "swap split" : "stack / unstack";
    case "layout":
      return layout === "dwindle" ? "layout: scrolling" : "layout: dwindle";
    case "keys":
      return "key sheet";
    case "another":
      return "another of this";
    case "reopen":
      return "reopen closed";
    case "wallpaper":
      return "next wallpaper";
    case "bar":
      return "toggle bar";
  }
}

/** What the d-pad does, in one line. Both the deck's map and the key sheet
 *  give it a column about 140 px wide, so it has to stay short. */
export function dpadLabel(layer: Layer): string {
  switch (layer) {
    case "super":
      return "focus window";
    case "shift":
      return "swap window";
    case "ws":
      return "workspace · carry";
    case "plain":
      return "to the app";
  }
}

/** What the circle pad does with a layer held. */
export function padLabel(layer: Layer, layout: LayoutKind): string {
  switch (layer) {
    case "super":
      return layout === "dwindle" ? "resize" : "column width";
    case "shift":
      return layout === "scrolling" ? "scroll strip" : "—";
    case "ws":
      return "—";
    case "plain":
      return "to the app";
  }
}

export const BUTTON_GLYPH: Record<number, string> = {
  [BTN.CIRCLE]: "A",
  [BTN.CROSS]: "B",
  [BTN.TRIANGLE]: "X",
  [BTN.SQUARE]: "Y",
  [BTN.START]: "START",
  [BTN.SELECT]: "SELECT",
};

export interface KeySheetRow {
  keys: string;
  what: string;
}

/** The full table, the way SUPER+K lists it: one row per binding. */
export function keySheet(layout: LayoutKind): { title: string; rows: KeySheetRow[] }[] {
  // "L+R" keeps the widest row inside the sheet's 80 px key column.
  const prefix: Record<Layer, string> = { plain: "", super: "L +", shift: "R +", ws: "L+R" };
  const groups: { title: string; rows: KeySheetRow[] }[] = [];
  for (const layer of ["super", "shift", "ws"] as const) {
    const rows: KeySheetRow[] = [];
    const list = chordsOf(layer);
    const dpad = list.filter((c) => c.button & DPAD);
    if (dpad.length > 0) {
      // The sheet's value column is ~100 px; the deck's is wider, so the ws
      // row is the one place the two wordings differ.
      const what = layer === "ws" ? "switch · carry" : dpadLabel(layer);
      rows.push({ keys: `${prefix[layer]} d-pad`, what });
    }
    const pad = padLabel(layer, layout);
    if (pad !== "—") rows.push({ keys: `${prefix[layer]} pad`, what: pad });
    for (const chord of list) {
      if (chord.button & DPAD) continue;
      rows.push({ keys: `${prefix[layer]} ${BUTTON_GLYPH[chord.button]}`, what: labelFor(chord.action, layout) });
    }
    groups.push({ title: LAYER_TITLE[layer], rows });
  }
  groups.push({
    title: "always",
    rows: [
      { keys: "SELECT", what: "keyboard" },
      { keys: "touch", what: "hold a layer" },
    ],
  });
  return groups;
}
