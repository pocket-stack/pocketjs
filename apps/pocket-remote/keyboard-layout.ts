// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/keyboard-layout.ts — the deck's geometry and key table
// with no Solid in it: the keyboard's five rows over the trackpad (the
// laptop's C surface, upside up), keysym names, hold-and-slide variants,
// chip placement, and the key -> wire-line mapping. deck.tsx renders and
// handles; tests import this file bare (bun test cannot load the app's .tsx
// through the Solid transform).
//
// The arrows are a laptop's cluster, not two keys parked at the end of the
// letters: ← then ↑ over ↓ in one column, then →, at the bottom right where
// a hand expects them. A stacked pair shares its column, each key half the
// row's height.
//
// SUPER is a sticky modifier like ctrl and alt, so Omarchy's own bindings
// are reachable from the deck: super then space opens its menu on the
// laptop, super then 1..9 switches workspace.

import { type Rect, SCREEN_H, SCREEN_W, STRIP } from "./layout.ts";
import type { Modifier } from "./protocol.ts";

export type KbLayer = "lower" | "upper" | "sym";

/** A held key's modifier variants (ctrl+x, alt+x, F-keys). */
export interface KeyVariant {
  label: string;
  k: string;
  mods: Modifier[];
}

/** Five rows of 32 px keys on a 36 px pitch, starting under the strip. */
export const ROWS_TOP = STRIP.h + 4;
export const ROW_PITCH = 36;
export const KEY_H = 32;
export const ROW_COUNT = 5;
/** Half-height keys (the stacked arrow pair) with a gap between them. */
export const HALF_GAP = 2;
export const HALF_H = (KEY_H - HALF_GAP) / 2;
/** Letter rows: ten columns of 44 px. The top row: twelve of 40. */
const UNIT = 44;
const TOP_UNIT = 40;

export const KEYBOARD: Rect = { x: 0, y: STRIP.h, w: SCREEN_W, h: ROWS_TOP - STRIP.h + ROW_COUNT * ROW_PITCH };
/** The trackpad fills what the keyboard leaves. */
export const TRACKPAD: Rect = { x: 4, y: KEYBOARD.y + KEYBOARD.h, w: SCREEN_W - 8, h: SCREEN_H - 4 - (KEYBOARD.y + KEYBOARD.h) };

export type KeyAction =
  | { ch: string }
  | { key: string }
  | { layer: KbLayer }
  | { mod: Modifier };

export interface KeyDef {
  label: string;
  /** Width in row units. */
  w: number;
  act: KeyAction;
  dark?: boolean;
  /** Hold-and-slide variants (letters and digits). */
  variants?: KeyVariant[];
  /** Half-height, sharing a column with its partner: "top" comes first and
   *  does not advance the row, "bottom" sits under it and does. */
  stack?: "top" | "bottom";
}

/** Keysym names for the characters that need one (wtype -k). */
const KEYSYM: Record<string, string> = {
  "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", ";": "semicolon",
  "'": "apostrophe", "`": "grave", "\\": "backslash", ",": "comma", ".": "period", "/": "slash",
};

export function keysymFor(ch: string): string | null {
  if (/^[a-z0-9]$/.test(ch)) return ch;
  return KEYSYM[ch] ?? null;
}

function letterVariants(ch: string): KeyVariant[] {
  return [
    { label: `^${ch.toUpperCase()}`, k: ch, mods: ["ctrl"] },
    { label: `⌥${ch.toUpperCase()}`, k: ch, mods: ["alt"] },
  ];
}

function digitVariants(ch: string): KeyVariant[] {
  const n = ch === "0" ? 10 : Number(ch);
  return [
    { label: `F${n}`, k: `F${n}`, mods: [] },
    { label: `^${ch}`, k: ch, mods: ["ctrl"] },
  ];
}

const letters = (row: string): KeyDef[] =>
  [...row].map((ch) => ({ label: ch, w: 1, act: { ch }, variants: /^[a-z]$/.test(ch) ? letterVariants(ch) : undefined }));
const digits = (row: string): KeyDef[] => [...row].map((ch) => ({ label: ch, w: 1, act: { ch }, variants: digitVariants(ch) }));
const chars = (row: string): KeyDef[] => [...row].map((ch) => ({ label: ch, w: 1, act: { ch } }));

/** esc, the digits, backspace. Twelve columns of 40. */
const TOP_ROW: KeyDef[] = [
  { label: "esc", w: 1, act: { key: "Escape" }, dark: true },
  ...digits("1234567890"),
  { label: "⌫", w: 1, act: { key: "BackSpace" }, dark: true },
];

/** Return closes the home row, where a keyboard puts it. */
const RETURN: KeyDef = { label: "return", w: 1.75, act: { key: "Return" }, dark: true };

/** The bottom row: the layer switch, the modifiers, tab, space, and the
 *  arrow cluster. 10.25 units, the same width as the row above. */
const bottomRow = (layer: KbLayer): KeyDef[] => [
  { label: layer === "sym" ? "abc" : "123", w: 1, act: { layer: layer === "sym" ? "lower" : "sym" }, dark: true },
  { label: "ctrl", w: 1, act: { mod: "ctrl" }, dark: true },
  { label: "alt", w: 1, act: { mod: "alt" }, dark: true },
  { label: "super", w: 1, act: { mod: "super" }, dark: true },
  { label: "tab", w: 1, act: { key: "Tab" }, dark: true },
  { label: "space", w: 3, act: { key: "space" } },
  { label: "←", w: 0.75, act: { key: "Left" }, dark: true },
  { label: "↑", w: 0.75, act: { key: "Up" }, dark: true, stack: "top" },
  { label: "↓", w: 0.75, act: { key: "Down" }, dark: true, stack: "bottom" },
  { label: "→", w: 0.75, act: { key: "Right" }, dark: true },
];

const ROWS: Record<KbLayer, KeyDef[][]> = {
  lower: [
    letters("qwertyuiop"),
    [...letters("asdfghjkl"), RETURN],
    [
      { label: "shift", w: 1.25, act: { layer: "upper" }, dark: true },
      ...letters("zxcvbnm"),
      { label: ",", w: 0.75, act: { ch: "," } },
      { label: ".", w: 0.75, act: { ch: "." } },
      { label: "'", w: 1, act: { ch: "'" } },
    ],
    bottomRow("lower"),
  ],
  upper: [
    chars("QWERTYUIOP"),
    [...chars("ASDFGHJKL"), RETURN],
    [
      { label: "shift", w: 1.25, act: { layer: "lower" }, dark: true },
      ...chars("ZXCVBNM"),
      { label: "!", w: 0.75, act: { ch: "!" } },
      { label: "?", w: 0.75, act: { ch: "?" } },
      { label: '"', w: 1, act: { ch: '"' } },
    ],
    bottomRow("upper"),
  ],
  sym: [
    chars("-/:;()$&@\""),
    [...chars("[]{}#%^*+"), RETURN],
    [
      { label: "shift", w: 1.25, act: { layer: "lower" }, dark: true },
      ...chars("_\\|~<>!"),
      { label: "=", w: 0.75, act: { ch: "=" } },
      { label: "?", w: 0.75, act: { ch: "?" } },
      { label: "`", w: 1, act: { ch: "`" } },
    ],
    bottomRow("sym"),
  ],
};

export interface KeyRect extends Rect {
  def: KeyDef;
  row: number;
  col: number;
}

function layoutRow(row: KeyDef[], r: number, unit: number): KeyRect[] {
  const total = row.reduce((sum, key) => sum + (key.stack === "top" ? 0 : key.w), 0);
  let x = Math.round((SCREEN_W - total * unit) / 2);
  const y = ROWS_TOP + r * ROW_PITCH;
  const out: KeyRect[] = [];
  row.forEach((def, c) => {
    const w = Math.round(def.w * unit);
    if (def.stack === "top") {
      out.push({ x: x + 2, y, w: w - 4, h: HALF_H, def, row: r, col: c });
      return; // its partner shares the column
    }
    if (def.stack === "bottom") {
      out.push({ x: x + 2, y: y + HALF_H + HALF_GAP, w: w - 4, h: HALF_H, def, row: r, col: c });
      x += w;
      return;
    }
    out.push({ x: x + 2, y, w: w - 4, h: KEY_H, def, row: r, col: c });
    x += w;
  });
  return out;
}

function layoutKeys(layer: KbLayer): KeyRect[] {
  return [...layoutRow(TOP_ROW, 0, TOP_UNIT), ...ROWS[layer].flatMap((row, r) => layoutRow(row, r + 1, UNIT))];
}

const LAYOUTS: Record<KbLayer, KeyRect[]> = {
  lower: layoutKeys("lower"),
  upper: layoutKeys("upper"),
  sym: layoutKeys("sym"),
};

export function keyboardKeys(layer: KbLayer): readonly KeyRect[] {
  return LAYOUTS[layer];
}

/**
 * The key under a point. The gaps between keys belong to their nearer
 * neighbour so a finger never falls between two — except vertically inside
 * a stacked pair, where the gap is the boundary between up and down.
 */
export function keyAt(layer: KbLayer, x: number, y: number): KeyRect | null {
  for (const key of LAYOUTS[layer]) {
    const slackY = key.def.stack ? 0 : 2;
    if (x >= key.x - 2 && x < key.x + key.w + 2 && y >= key.y - slackY && y < key.y + key.h + slackY) return key;
  }
  return null;
}

/** Variant chip geometry: above the key, or below it for the top row. */
export const CHIP_W = 56;
export const CHIP_H = 34;
export const CHIP_GAP = 6;
export function chipRects(key: Rect, count: number): Rect[] {
  const total = count * CHIP_W + (count - 1) * CHIP_GAP;
  let x = Math.round(key.x + key.w / 2 - total / 2);
  x = Math.max(4, Math.min(SCREEN_W - 4 - total, x));
  const y = key.y >= ROWS_TOP + ROW_PITCH ? key.y - CHIP_H - 6 : key.y + key.h + 6;
  return Array.from({ length: count }, (_, i) => ({ x: x + i * (CHIP_W + CHIP_GAP), y, w: CHIP_W, h: CHIP_H }));
}

export function chipAt(key: Rect, count: number, x: number, y: number): number | null {
  const rects = chipRects(key, count);
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i]!;
    if (x >= r.x - 4 && x < r.x + r.w + 4 && y >= r.y - 10 && y < r.y + r.h + 10) return i;
  }
  return null;
}

/** What a key sends, as the store sees it. Exported for tests. */
export function keyToLine(
  act: KeyAction,
  mods: Modifier[],
): { t: "type"; text: string } | { t: "key"; k: string; mods?: Modifier[] } | null {
  if ("ch" in act) {
    if (mods.length === 0) return { t: "type", text: act.ch };
    const k = keysymFor(act.ch.toLowerCase());
    return k ? { t: "key", k, mods } : null;
  }
  if ("key" in act) return mods.length ? { t: "key", k: act.key, mods } : { t: "key", k: act.key };
  return null;
}
