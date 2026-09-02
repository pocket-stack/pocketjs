// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/keyboard-layout.ts — the deck's geometry and key table
// with no Solid in it: the keyboard's five rows, the palm-rest band under
// them (menu key, click key, trackpad, d-pad), keysym names, hold-and-slide
// variants, and the key -> wire-line mapping. deck.tsx renders and handles;
// tests import this file bare (bun test cannot load the app's .tsx through
// the Solid transform).
//
// The band under the keyboard is a laptop's C surface read literally: the
// trackpad does not run edge to edge, and what a laptop leaves as palm rest
// carries the two things a hand wants beside a pad — Omarchy's menu on the
// left with the click button under it, a d-pad cross on the right. Four
// discrete arrow keys beat the slide-a-direction compass they replace: no
// gesture to learn and nothing to aim inside.
//
// TYPING ACCURACY. Two cheap, well-worn corrections, because the visual gaps
// a keyboard wants and the target sizes a finger wants are not the same
// thing:
//   1. Hit regions TILE the keyboard. A touch goes to the key whose
//      rectangle it is nearest (zero inside), not to a rectangle it must
//      land inside, so the gaps between keys belong to their neighbours
//      instead of swallowing a press. Keys can then be drawn with generous
//      gaps — 6 px here, up from 4 — without shrinking what a finger hits.
//   2. A downward BIAS correction. On a capacitive panel a press lands below
//      where the eye aimed (the contact patch grows towards the palm), so
//      the hit test moves the touch up a few pixels before assigning it.
// Both are what the platform keyboards do, and neither costs a frame.
//
// SUPER is a sticky modifier like ctrl and alt, so Omarchy's own bindings
// are reachable from the deck: super then space opens its menu on the
// laptop, super then 1..9 switches workspace.

import { GLYPH } from "./glyphs.ts";
import { type Rect, SCREEN_H, SCREEN_W, STRIP, within } from "./layout.ts";
import type { Modifier } from "./protocol.ts";

export type KbLayer = "lower" | "upper" | "sym";

/** A held key's modifier variants (ctrl+x, alt+x, F-keys). */
export interface KeyVariant {
  label: string;
  k: string;
  mods: Modifier[];
}

/** Five rows on a 36 px pitch: 30 px of key and 6 px of gap. */
export const ROWS_TOP = STRIP.h + 4;
export const ROW_PITCH = 36;
export const KEY_H = 30;
export const ROW_COUNT = 5;
/** Horizontal inset per key: 3 px a side, so 6 px between two keys. */
const KEY_INSET = 3;
/** Letter rows: ten columns of 44 px. The top row: twelve of 40. */
const UNIT = 44;
const TOP_UNIT = 40;

export const KEYBOARD: Rect = {
  x: 0,
  y: STRIP.h,
  w: SCREEN_W,
  h: ROWS_TOP - STRIP.h + (ROW_COUNT - 1) * ROW_PITCH + KEY_H,
};

// ---------------------------------------------------------------------------
// the band under the keyboard: menu | click | trackpad | d-pad
// ---------------------------------------------------------------------------

export const BAND: Rect = {
  x: 0,
  y: KEYBOARD.y + KEYBOARD.h + 4,
  w: SCREEN_W,
  h: SCREEN_H - (KEYBOARD.y + KEYBOARD.h + 4) - 4,
};
/** Left rest: Omarchy's menu above, the click button below. */
export const MENU_KEY: Rect = { x: 4, y: BAND.y, w: 72, h: Math.round(BAND.h / 2) - 3 };
export const CLICK_KEY: Rect = { x: 4, y: MENU_KEY.y + MENU_KEY.h + 6, w: 72, h: BAND.h - MENU_KEY.h - 6 };
/** The pad itself: narrower than the panel, like a laptop's. */
export const TRACKPAD: Rect = { x: 82, y: BAND.y, w: 286, h: BAND.h };
/** Right rest: the d-pad cross. */
export const DPAD: Rect = { x: 374, y: BAND.y, w: 102, h: BAND.h };

export type Direction4 = "u" | "d" | "l" | "r";
export const DIRECTION_KEYSYM: Record<Direction4, string> = { u: "Up", d: "Down", l: "Left", r: "Right" };
export const DIRECTION_GLYPH: Record<Direction4, string> = { u: "↑", d: "↓", l: "←", r: "→" };

const DPAD_KEY_W = 34;
const DPAD_KEY_H = Math.floor((DPAD.h - 8) / 3);

/** The cross: up and down in the middle column, left and right beside it. */
export const DPAD_KEYS: Record<Direction4, Rect> = (() => {
  const cx = DPAD.x + Math.round(DPAD.w / 2);
  const cy = DPAD.y + Math.round(DPAD.h / 2);
  const midY = cy - Math.round(DPAD_KEY_H / 2);
  const left = cx - Math.round(DPAD_KEY_W / 2);
  return {
    u: { x: left, y: midY - DPAD_KEY_H - 4, w: DPAD_KEY_W, h: DPAD_KEY_H },
    d: { x: left, y: midY + DPAD_KEY_H + 4, w: DPAD_KEY_W, h: DPAD_KEY_H },
    l: { x: left - DPAD_KEY_W - 3, y: midY, w: DPAD_KEY_W, h: DPAD_KEY_H },
    r: { x: left + DPAD_KEY_W + 3, y: midY, w: DPAD_KEY_W, h: DPAD_KEY_H },
  };
})();

/** Frames a d-pad key must be held before it repeats, and the frames
 *  between repeats. Each repeat is one key press on the laptop, so the rate
 *  is a walking pace rather than a keyboard's. */
export const ARROW_HOLD_FRAMES = 20;
export const ARROW_REPEAT_FRAMES = 7;

/** Which d-pad key a point is on, with slack around the cross. */
export function dpadAt(x: number, y: number): Direction4 | null {
  for (const dir of ["u", "d", "l", "r"] as const) {
    const r = DPAD_KEYS[dir];
    if (within(x, y, { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 })) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the keys
// ---------------------------------------------------------------------------

export type KeyAction = { ch: string } | { key: string } | { layer: KbLayer } | { mod: Modifier };

export interface KeyDef {
  label: string;
  /** Width in row units. */
  w: number;
  act: KeyAction;
  dark?: boolean;
  /** Hold-and-slide variants (letters and digits). */
  variants?: KeyVariant[];
  /** Drawn as a glyph rather than as its label's text. */
  glyph?: string;
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

/** The bottom row: the layer switch, the modifiers, tab, space, and the two
 *  punctuation keys a terminal reaches for. The arrows are the d-pad now. */
const bottomRow = (layer: KbLayer): KeyDef[] => [
  { label: layer === "sym" ? "abc" : "123", w: 1, act: { layer: layer === "sym" ? "lower" : "sym" }, dark: true },
  { label: "ctrl", w: 1, act: { mod: "ctrl" }, dark: true },
  { label: "alt", w: 1, act: { mod: "alt" }, dark: true },
  { label: "super", w: 1, act: { mod: "super" }, dark: true },
  { label: "tab", w: 1, act: { key: "Tab" }, dark: true },
  { label: "space", w: 3.75, act: { key: "space" } },
  { label: "-", w: 0.75, act: { ch: "-" } },
  { label: "/", w: 0.75, act: { ch: "/" } },
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
  const total = row.reduce((sum, key) => sum + key.w, 0);
  let x = Math.round((SCREEN_W - total * unit) / 2);
  const y = ROWS_TOP + r * ROW_PITCH;
  return row.map((def, c) => {
    const w = Math.round(def.w * unit);
    const rect = { x: x + KEY_INSET, y, w: w - 2 * KEY_INSET, h: KEY_H, def, row: r, col: c };
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

// ---------------------------------------------------------------------------
// hit testing
// ---------------------------------------------------------------------------

/** How far up the hit test moves a touch before assigning it: a press on a
 *  capacitive panel lands below where the eye aimed. */
export const TOUCH_BIAS_Y = 3;
/** A row change is a worse mistake than a column change, so vertical
 *  distance counts for more when the nearest key is chosen. */
const VERTICAL_WEIGHT = 1.7;
/** How far outside a key a touch may still be claimed by it. */
const HIT_REACH = 16;

/** Distance from a point to a rectangle's edge: zero inside it. */
function edgeDistance(x: number, y: number, r: Rect): { dx: number; dy: number } {
  return {
    dx: Math.max(0, Math.abs(x - (r.x + r.w / 2)) - r.w / 2),
    dy: Math.max(0, Math.abs(y - (r.y + r.h / 2)) - r.h / 2),
  };
}

/**
 * The key a touch means. Hit regions tile the keyboard: the nearest key by
 * edge distance wins, so the gaps between keys belong to their neighbours
 * instead of swallowing the press. The touch is moved up by TOUCH_BIAS_Y
 * first (see the note at the top of this file).
 */
export function keyAt(layer: KbLayer, x: number, y: number): KeyRect | null {
  const ay = y - TOUCH_BIAS_Y;
  // The reach must not spill into the band: those controls are fixed and a
  // press on the pad is never a keystroke.
  if (ay >= BAND.y) return null;
  let best: KeyRect | null = null;
  let bestScore = Infinity;
  for (const key of LAYOUTS[layer]) {
    const { dx, dy } = edgeDistance(x, ay, key);
    if (dx > HIT_REACH || dy > HIT_REACH) continue;
    const score = dx * dx + dy * dy * VERTICAL_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}

/** What a touch on the deck means: the band's own controls first (they are
 *  fixed, and the keyboard's hit regions reach past its own edge), then a
 *  key. */
export type DeckTarget =
  | { kind: "menu" }
  | { kind: "click" }
  | { kind: "pad" }
  | { kind: "dpad"; dir: Direction4 }
  | { kind: "key"; key: KeyRect }
  | { kind: "none" };

export function deckTargetAt(layer: KbLayer, x: number, y: number): DeckTarget {
  if (y >= BAND.y - 2) {
    if (within(x, y, MENU_KEY)) return { kind: "menu" };
    if (within(x, y, CLICK_KEY)) return { kind: "click" };
    if (within(x, y, TRACKPAD)) return { kind: "pad" };
    const dir = dpadAt(x, y);
    if (dir) return { kind: "dpad", dir };
    return { kind: "none" };
  }
  const key = keyAt(layer, x, y);
  return key ? { kind: "key", key } : { kind: "none" };
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
  return null; // a layer switch and a modifier send nothing here
}
