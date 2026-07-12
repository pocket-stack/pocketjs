// demos/im/wrap.ts — measurement-driven word wrap + thread row layout.
//
// Two core facts force this module to exist (DESIGN.md):
//   - the text engine breaks lines only on an explicit '\n'
//     (core/src/text.rs) — an IM bubble has to wrap itself;
//   - JS has no layout read-back — a virtual list must KNOW every row's
//     height before the core lays anything out.
// Both reduce to one primitive: the measureText host op. Glyph advances are
// additive (the baked atlas has no kerning pairs), so a line's width is the
// sum of its word widths — one cached measure per word, then integer row
// math. Rows carry absolute y offsets; the thread mounts only the slice that
// intersects the viewport and the native core never sees the rest.
//
// Every constant here mirrors a class literal in thread.tsx (px-2 = 8,
// py-1 = 4, explicit lineHeight overrides), so the arithmetic in this file
// IS the rendered geometry — no drift, no guessing.

import { getOps } from "@pocketjs/framework";
import { dayLabel, fmtTime, type UiMsg } from "./data.ts";

// Build-pinned font slots (compiler/tailwind.ts fontSlotFor): regular slots
// are FONT_PX indexes, bold ones +7. Bubble bodies are text-sm (14 px →
// slot 1); meta lines and previews are text-xs (12 px → slot 0).
export const FONT_MSG = 1;
export const FONT_META = 0;

export const LINE_H = 16; // bubble body lineHeight override
const PAD_X = 8; //          bubble px-2
const PAD_Y = 4; //          bubble py-1
const META_H = 12; //        time/ticks line (lineHeight 12)
const TICK_GAP = 4; //       gap-1 between time and ticks
const LABEL_H = 14; //       group sender label (lineHeight 12 + marginB 2)
const ROW_GAP = 8;
const GROUP_GAP = 3; //      consecutive messages from the same sender
const DAY_H = 22;
const BEGIN_H = 18;
const EDGE_PAD = 6; //       breathing room at both canvas ends
export const BUBBLE_MAX_TEXT_W = 264;

// ---------------------------------------------------------------------------
// Cached measurement
// ---------------------------------------------------------------------------

const widthCache = new Map<string, number>();

export function textWidth(text: string, slot: number): number {
  if (text === "") return 0;
  const key = slot + "|" + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    w = getOps().measureText(text, slot);
    widthCache.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Word wrap
// ---------------------------------------------------------------------------

/** Split a token wider than maxW into chunks that fit (long urls, keysmash). */
function breakToken(token: string, slot: number, maxW: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkW = 0;
  for (const ch of token) {
    const w = textWidth(ch, slot);
    if (chunk !== "" && chunkW + w > maxW) {
      chunks.push(chunk);
      chunk = "";
      chunkW = 0;
    }
    chunk += ch;
    chunkW += w;
  }
  if (chunk !== "") chunks.push(chunk);
  return chunks;
}

const wrapCache = new Map<string, string[]>();

/** Greedy word wrap under maxW px; explicit '\n' always breaks. */
export function wrapText(text: string, slot: number, maxW: number): string[] {
  const key = slot + "|" + maxW + "|" + text;
  const hit = wrapCache.get(key);
  if (hit) return hit;

  const spaceW = textWidth(" ", slot);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words: string[] = [];
    for (const token of para.split(" ")) {
      if (token !== "" && textWidth(token, slot) > maxW) words.push(...breakToken(token, slot, maxW));
      else words.push(token);
    }
    let line = "";
    let lineW = 0;
    for (const word of words) {
      const w = textWidth(word, slot);
      if (line === "") {
        line = word;
        lineW = w;
      } else if (lineW + spaceW + w <= maxW) {
        line = line + " " + word;
        lineW += spaceW + w;
      } else {
        lines.push(line);
        line = word;
        lineW = w;
      }
    }
    lines.push(line); // empty paragraphs keep their blank line
  }
  wrapCache.set(key, lines);
  return lines;
}

/** Truncate to maxW with a trailing ellipsis (conversation-list previews). */
export function fitEnd(text: string, slot: number, maxW: number): string {
  if (textWidth(text, slot) <= maxW) return text;
  const budget = maxW - textWidth("…", slot);
  let acc = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const w = textWidth(text[i], slot);
    if (acc + w > budget) break;
    acc += w;
  }
  return text.slice(0, i) + "…";
}

/** Keep the TAIL of a string under maxW with a leading ellipsis (the compose
 *  field follows the caret, like every IM input does). */
export function fitTail(text: string, slot: number, maxW: number): string {
  if (textWidth(text, slot) <= maxW) return text;
  const budget = maxW - textWidth("…", slot);
  let acc = 0;
  let i = text.length;
  for (; i > 0; i--) {
    const w = textWidth(text[i - 1], slot);
    if (acc + w > budget) break;
    acc += w;
  }
  return "…" + text.slice(i);
}

// ---------------------------------------------------------------------------
// Thread rows
// ---------------------------------------------------------------------------

export type ThreadRow =
  | { kind: "chip"; key: string; y: number; h: number; label: string }
  | {
      kind: "msg";
      key: string;
      y: number;
      h: number;
      msg: UiMsg;
      /** Sender label above the bubble (group chats, first of a run). */
      label: string | null;
      bubbleW: number;
      /** Pre-wrapped body — rendered as one Text with explicit '\n's. */
      body: string;
    };

export interface ThreadLayout {
  rows: ThreadRow[];
  total: number;
}

export function buildRows(msgs: UiMsg[], opts: { group: boolean; begin: boolean }): ThreadLayout {
  const rows: ThreadRow[] = [];
  let y = EDGE_PAD;
  if (opts.begin) {
    rows.push({ kind: "chip", key: "begin", y, h: BEGIN_H, label: "· BEGINNING OF THE CONVERSATION ·" });
    y += BEGIN_H + ROW_GAP;
  }
  let prevDay: number | null = null;
  let prevFrom: string | null = null;
  for (const m of msgs) {
    if (m.day !== prevDay) {
      rows.push({ kind: "chip", key: `day-${m.id}`, y, h: DAY_H, label: dayLabel(m.day) });
      y += DAY_H + ROW_GAP;
      prevFrom = null; // a day break always restarts the sender run
      prevDay = m.day;
    } else if (rows.length > 0) {
      // Tighten the gap inside a same-sender run.
      y += (m.from === prevFrom ? GROUP_GAP : ROW_GAP) - ROW_GAP;
    }

    const lines = wrapText(m.text, FONT_MSG, BUBBLE_MAX_TEXT_W);
    let textW = 0;
    for (const line of lines) textW = Math.max(textW, textWidth(line, FONT_MSG));
    const metaW =
      textWidth(fmtTime(m.minute), FONT_META) + (m.out ? TICK_GAP + textWidth("✓✓", FONT_META) : 0);
    const label = opts.group && !m.out && m.from !== prevFrom ? m.from : null;
    const bubbleW = Math.ceil(Math.max(textW, metaW)) + PAD_X * 2;
    const bubbleH = PAD_Y * 2 + lines.length * LINE_H + META_H;
    const h = (label ? LABEL_H : 0) + bubbleH;
    rows.push({ kind: "msg", key: m.id, y, h, msg: m, label, bubbleW, body: lines.join("\n") });
    y += h + ROW_GAP;
    prevFrom = m.from;
  }
  return { rows, total: y - ROW_GAP + EDGE_PAD };
}
