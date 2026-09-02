// apps/pocket-remote/keyboard-layout.ts — the keyboard's geometry and key
// table with no Solid in it: rows, keysym names, hold-and-slide variants,
// chip placement, and the key -> wire-line mapping. keyboard.tsx renders
// and handles; tests import this file bare (bun test cannot load the app's
// .tsx through the Solid transform).

import { type Rect, SCREEN_H, SCREEN_W } from "./layout.ts";
import type { Modifier } from "./protocol.ts";
import type { KbLayer, KeyVariant } from "./store.ts";

export const KB_RECT: Rect = { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };
export const CAPTION_H = 28;
export const ROWS_TOP = 30;
export const ROW_PITCH = 56;
export const KEY_H = 48;
/** Letter rows: ten columns of 44 px. The top row: twelve of 40. */
const UNIT = 44;
const TOP_UNIT = 40;
export const HIDE_W = 44;

export type KeyAction =
  | { ch: string }
  | { key: string }
  | { layer: KbLayer }
  | { mod: Modifier }
  | { hide: true };

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

const BOTTOM_ROW = (layer: KbLayer): KeyDef[] => [
  { label: layer === "sym" ? "abc" : "123", w: 1, act: { layer: layer === "sym" ? "lower" : "sym" }, dark: true },
  { label: "ctrl", w: 1, act: { mod: "ctrl" }, dark: true },
  { label: "alt", w: 1, act: { mod: "alt" }, dark: true },
  { label: "tab", w: 1, act: { key: "Tab" }, dark: true },
  { label: "space", w: 3, act: { key: "space" } },
  { label: "←", w: 1, act: { key: "Left" }, dark: true },
  { label: "→", w: 1, act: { key: "Right" }, dark: true },
  { label: "return", w: 1.5, act: { key: "Return" }, dark: true },
];

const ROWS: Record<KbLayer, KeyDef[][]> = {
  lower: [
    letters("qwertyuiop"),
    letters("asdfghjkl"),
    [
      { label: "shift", w: 1.5, act: { layer: "upper" }, dark: true },
      ...letters("zxcvbnm"),
      { label: "↑", w: 0.75, act: { key: "Up" }, dark: true },
      { label: "↓", w: 0.75, act: { key: "Down" }, dark: true },
    ],
    BOTTOM_ROW("lower"),
  ],
  upper: [
    chars("QWERTYUIOP"),
    chars("ASDFGHJKL"),
    [
      { label: "shift", w: 1.5, act: { layer: "lower" }, dark: true },
      ...chars("ZXCVBNM"),
      { label: "↑", w: 0.75, act: { key: "Up" }, dark: true },
      { label: "↓", w: 0.75, act: { key: "Down" }, dark: true },
    ],
    BOTTOM_ROW("upper"),
  ],
  sym: [
    chars("-/:;()$&@\""),
    chars("[]{}#%^*+="),
    [
      { label: "shift", w: 1.5, act: { layer: "lower" }, dark: true },
      ...chars("_\\|~<>!?"),
      { label: "'", w: 1, act: { ch: "'" } },
    ],
    BOTTOM_ROW("sym"),
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

export function keyAt(layer: KbLayer, x: number, y: number): KeyRect | null {
  for (const key of LAYOUTS[layer]) {
    if (x >= key.x - 2 && x < key.x + key.w + 2 && y >= key.y - 4 && y < key.y + key.h + 4) return key;
  }
  return null;
}

/** Variant chip geometry: above the key, or below it for the top row. */
export const CHIP_W = 60;
export const CHIP_H = 36;
export const CHIP_GAP = 6;
export function chipRects(key: Rect, count: number): Rect[] {
  const total = count * CHIP_W + (count - 1) * CHIP_GAP;
  let x = Math.round(key.x + key.w / 2 - total / 2);
  x = Math.max(4, Math.min(SCREEN_W - 4 - total, x));
  const y = key.y >= ROWS_TOP + ROW_PITCH ? key.y - CHIP_H - 10 : key.y + key.h + 10;
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
