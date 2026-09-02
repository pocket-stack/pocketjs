// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/keyboard-layout.ts — the deck's geometry and key table
// with no Solid in it: the keyboard's five compact rows over the trackpad
// (the laptop's C surface, upside up), keysym names, hold-and-slide
// variants, chip placement, and the key -> wire-line mapping. deck.tsx
// renders and handles; tests import this file bare (bun test cannot load the
// app's .tsx through the Solid transform).

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

const TOP_ROW: KeyDef[] = [
  { label: "esc", w: 1, act: { key: "Escape" }, dark: true },
  ...digits("1234567890"),
  { label: "⌫", w: 1, act: { key: "BackSpace" }, dark: true },
];

/** Row three's ends: shift, then the arrows. */
const rowThree = (middle: KeyDef[], shiftTo: KbLayer): KeyDef[] => [
  { label: "shift", w: 1.25, act: { layer: shiftTo }, dark: true },
  ...middle,
  { label: "↑", w: 0.75, act: { key: "Up" }, dark: true },
  { label: "↓", w: 0.75, act: { key: "Down" }, dark: true },
];

/** The bottom row: layer switch, ctrl, alt, tab, space, two punctuation
 *  keys (comma and period; apostrophe and backtick on the symbol layer),
 *  the horizontal arrows and return. 10.75 units. */
const bottomRow = (layer: KbLayer): KeyDef[] => [
  { label: layer === "sym" ? "abc" : "123", w: 1, act: { layer: layer === "sym" ? "lower" : "sym" }, dark: true },
  { label: "ctrl", w: 1, act: { mod: "ctrl" }, dark: true },
  { label: "alt", w: 1, act: { mod: "alt" }, dark: true },
  { label: "tab", w: 1, act: { key: "Tab" }, dark: true },
  { label: "space", w: 2.25, act: { key: "space" } },
  { label: layer === "sym" ? "'" : ",", w: 0.75, act: { ch: layer === "sym" ? "'" : "," } },
  { label: layer === "sym" ? "`" : ".", w: 0.75, act: { ch: layer === "sym" ? "`" : "." } },
  { label: "←", w: 0.75, act: { key: "Left" }, dark: true },
  { label: "→", w: 0.75, act: { key: "Right" }, dark: true },
  { label: "return", w: 1.5, act: { key: "Return" }, dark: true },
];

const ROWS: Record<KbLayer, KeyDef[][]> = {
  lower: [
    letters("qwertyuiop"),
    letters("asdfghjkl"),
    rowThree([...letters("zxcvbnm"), { label: "'", w: 1, act: { ch: "'" } }], "upper"),
    bottomRow("lower"),
  ],
  upper: [
    chars("QWERTYUIOP"),
    chars("ASDFGHJKL"),
    rowThree([...chars("ZXCVBNM"), { label: '"', w: 1, act: { ch: '"' } }], "lower"),
    bottomRow("upper"),
  ],
  sym: [
    chars("-/:;()$&@\""),
    chars("[]{}#%^*+="),
    rowThree(chars("_\\|~<>!?"), "lower"),
    bottomRow("sym"),
  ],
};

export interface KeyRect extends Rect {
  def: KeyDef;
  row: number;
  col: number;
}

function layoutRow(row: KeyDef[], r: number, unit: number): KeyRect[] {
  const total = row.reduce((sum, key) => sum + key.w, 0);
  let x = Math.round((SCREEN_W - total * unit) / 2);
  const y = ROWS_TOP + r * ROW_PITCH;
  return row.map((def, c) => {
    const w = Math.round(def.w * unit);
    const rect = { x: x + 2, y, w: w - 4, h: KEY_H, def, row: r, col: c };
    x += w;
    return rect;
  });
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

/** The key under a point, with the gaps between keys belonging to their
 *  nearer neighbour so a finger never falls between two. */
export function keyAt(layer: KbLayer, x: number, y: number): KeyRect | null {
  for (const key of LAYOUTS[layer]) {
    if (x >= key.x - 2 && x < key.x + key.w + 2 && y >= key.y - 2 && y < key.y + key.h + 2) return key;
  }
  return null;
}

/** The pressed key's preview bubble: the character, large, above the key
 *  (below it for the top row), the classic capacitive-keyboard feedback. */
export const BUBBLE_W = 44;
export const BUBBLE_H = 40;
export function bubbleRect(key: Rect): Rect {
  const x = Math.max(2, Math.min(SCREEN_W - 2 - BUBBLE_W, Math.round(key.x + key.w / 2 - BUBBLE_W / 2)));
  // Sits on the key's top edge, so the first letter row's bubble ends where
  // the strip begins; the top row's opens below it.
  const y = key.y >= ROWS_TOP + ROW_PITCH ? key.y - BUBBLE_H : key.y + key.h + 4;
  return { x, y, w: BUBBLE_W, h: BUBBLE_H };
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
